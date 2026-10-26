//! Loudness normalization for short MP3s, applied in place after import.
//!
//! This is the policy from `scripts/AUDIO_NORMALIZATION.md`: measure with
//! FFmpeg's EBU R128 filter, then let MP3Gain change the encoded volume in
//! 1.5 dB steps without re-encoding. MP3Gain keeps an undo record in the file,
//! so no backup copy is stored. Objects already normalized by the batch script
//! carry the same metadata and are left alone.

use std::{
    collections::HashSet,
    path::Path,
    process::Command,
    sync::{Arc, Mutex},
    time::Duration,
};

use anyhow::{bail, ensure, Context, Result};
use r2d2::Pool;
use r2d2_sqlite::SqliteConnectionManager;
use reitunes_workspace::Library;
use rusqlite::{params, OptionalExtension};
use serde::Serialize;
use sha2::{Digest, Sha256};
use tokio::sync::{mpsc, RwLock};
use tracing::{info, warn};
use uuid::Uuid;

use crate::storage::S3Storage;

pub const POLICY: &str = "mp3-r128-minus18-truepeak-minus1-v1";
const POLICY_METADATA: &str = "reitunes-normalization";
const TARGET_LUFS: f64 = -18.0;
const MAX_PEAK_DB: f64 = -1.0;
/// MP3Gain changes volume in steps of 20 * log10(2^0.25) dB.
const MP3_STEP_DB: f64 = 1.505_149_978_319_906;
const MAX_SECONDS: f64 = 900.0;
const MAX_BYTES: i64 = 128 * 1024 * 1024;
/// A 15-minute song at 320 kbps is about 36 MB. A bigger file without a known
/// duration is a long recording, so don't download it to find out.
const MAX_UNKNOWN_DURATION_BYTES: i64 = 40_000_000;
const MAX_ATTEMPTS: i64 = 3;
const SWEEP_DELAY: Duration = Duration::from_secs(120);
const SWEEP_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);

#[derive(Clone)]
pub struct Normalization {
    queue: mpsc::UnboundedSender<Uuid>,
    queued: Arc<Mutex<HashSet<Uuid>>>,
}

impl Normalization {
    /// Start the worker and the daily catch-up sweep.
    pub fn start(
        pool: Pool<SqliteConnectionManager>,
        library: Arc<RwLock<Library>>,
        storage: Arc<S3Storage>,
    ) -> Self {
        let (queue, receiver) = mpsc::unbounded_channel();
        let normalization = Self { queue, queued: Arc::default() };
        let worker = Worker { pool, library, storage, tools: Tools::from_env() };
        tokio::spawn(worker.clone().run(receiver, normalization.queued.clone()));
        let sweeper = normalization.clone();
        tokio::spawn(async move {
            tokio::time::sleep(SWEEP_DELAY).await;
            let mut interval = tokio::time::interval(SWEEP_INTERVAL);
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                interval.tick().await;
                match worker.sweep_candidates().await {
                    Ok(ids) if !ids.is_empty() => {
                        info!(count = ids.len(), "Queued songs for loudness normalization");
                        ids.into_iter().for_each(|id| sweeper.enqueue(id));
                    }
                    Ok(_) => {}
                    Err(error) => warn!(%error, "Loudness normalization sweep failed"),
                }
            }
        });
        normalization
    }

    pub fn enqueue(&self, id: Uuid) {
        if self.queued.lock().unwrap().insert(id) {
            let _ = self.queue.send(id);
        }
    }
}

#[derive(Clone)]
struct Tools {
    ffmpeg: String,
    ffprobe: String,
    mp3gain: String,
}

impl Tools {
    fn from_env() -> Self {
        let tool = |var: &str, default: &str| std::env::var(var).unwrap_or_else(|_| default.to_string());
        Self { ffmpeg: tool("FFMPEG_PATH", "ffmpeg"), ffprobe: tool("FFPROBE_PATH", "ffprobe"),
            mp3gain: tool("MP3GAIN_PATH", "mp3gain") }
    }

    fn missing(&self) -> Vec<&str> {
        [(&self.ffmpeg, "-version"), (&self.ffprobe, "-version"), (&self.mp3gain, "-v")].into_iter()
            .filter(|(tool, flag)| Command::new(tool).arg(flag).output().is_err())
            .map(|(tool, _)| tool.as_str()).collect()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
struct Loudness {
    lufs: f64,
    peak_db: f64,
}

#[derive(Debug, Serialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
enum Outcome {
    Normalized { before: Loudness, after: Loudness, gain_db: f64, original_sha256: String },
    Unchanged { loudness: Loudness },
    AlreadyNormalized,
    Silent,
    Skipped { reason: String },
    Failed { error: String },
}

impl Outcome {
    fn name(&self) -> &'static str {
        match self {
            Self::Normalized { .. } => "normalized",
            Self::Unchanged { .. } => "unchanged",
            Self::AlreadyNormalized => "already_normalized",
            Self::Silent => "silent",
            Self::Skipped { .. } => "skipped",
            Self::Failed { .. } => "failed",
        }
    }
}

/// What to do with a downloaded file, decided without touching storage.
enum Plan {
    Adjust { before: Loudness, after: Loudness, steps: i32, data: Vec<u8> },
    Done(Outcome),
}

#[derive(Clone)]
struct Worker {
    pool: Pool<SqliteConnectionManager>,
    library: Arc<RwLock<Library>>,
    storage: Arc<S3Storage>,
    tools: Tools,
}

impl Worker {
    async fn run(self, mut receiver: mpsc::UnboundedReceiver<Uuid>, queued: Arc<Mutex<HashSet<Uuid>>>) {
        // One song at a time: the server is small and this is never urgent.
        while let Some(id) = receiver.recv().await {
            queued.lock().unwrap().remove(&id);
            if let Err(error) = self.process(id).await {
                warn!(%id, %error, "Loudness normalization failed");
            }
        }
    }

    async fn sweep_candidates(&self) -> Result<Vec<Uuid>> {
        let missing = self.tools.missing();
        if !missing.is_empty() {
            warn!(?missing, "Skipping loudness normalization; tools are not installed");
            return Ok(Vec::new());
        }
        let candidates: Vec<(Uuid, String)> = self.library.read().await.items.values()
            .filter(|item| candidate(&item.file_path, item.duration_seconds))
            .map(|item| (item.id, item.file_path.clone())).collect();
        let mut due = Vec::new();
        for (id, path) in candidates {
            if self.due(&path)? {
                due.push(id);
            }
        }
        Ok(due)
    }

    fn due(&self, path: &str) -> Result<bool> {
        let row: Option<(String, String, i64)> = self.pool.get()?.query_row(
            "SELECT Policy, Outcome, Attempts FROM loudness_normalization WHERE StorageScope = ?1 AND FilePath = ?2",
            params![self.storage.scope(), path], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).optional()?;
        Ok(match row {
            None => true,
            Some((policy, outcome, attempts)) => policy != POLICY || (outcome == "failed" && attempts < MAX_ATTEMPTS),
        })
    }

    async fn process(&self, id: Uuid) -> Result<()> {
        let Some((path, seconds)) = self.library.read().await.items.get(&id)
            .map(|item| (item.file_path.clone(), item.duration_seconds)) else { return Ok(()) };
        if !candidate(&path, seconds) || !self.due(&path)? {
            return Ok(());
        }
        let missing = self.tools.missing();
        if !missing.is_empty() {
            warn!(%id, ?missing, "Not normalizing new song; tools are not installed");
            return Ok(());
        }
        let outcome = self.normalize(&path, seconds).await
            .unwrap_or_else(|error| Outcome::Failed { error: format!("{error:#}") });
        match &outcome {
            Outcome::Normalized { gain_db, .. } => info!(%id, gain_db, "Normalized song loudness"),
            Outcome::Failed { error } => warn!(%id, error, "Could not normalize song loudness"),
            other => info!(%id, outcome = other.name(), "Checked song loudness"),
        }
        self.record(id, &path, &outcome)
    }

    async fn normalize(&self, path: &str, seconds: Option<f64>) -> Result<Outcome> {
        let object = self.storage.head(path).await?;
        if object.metadata.contains_key(POLICY_METADATA) {
            return Ok(Outcome::AlreadyNormalized);
        }
        if object.size > MAX_BYTES || (seconds.is_none() && object.size > MAX_UNKNOWN_DURATION_BYTES) {
            return Ok(Outcome::Skipped { reason: format!("{} bytes is too large for a short song", object.size) });
        }
        let original = self.storage.download(path, &object.etag, MAX_BYTES).await?;
        let original_sha256 = sha256(&original);
        let tools = self.tools.clone();
        let (before, after, steps, data) = match tokio::task::spawn_blocking(move || prepare(&tools, &original)).await?? {
            Plan::Adjust { before, after, steps, data } => (before, after, steps, data),
            Plan::Done(outcome) => return Ok(outcome),
        };
        let adjusted_sha256 = sha256(&data);
        let mut metadata = object.metadata.clone();
        metadata.insert(POLICY_METADATA.into(), POLICY.into());
        metadata.insert("reitunes-original-sha256".into(), original_sha256.clone());
        let content_type = object.content_type.as_deref().unwrap_or("audio/mpeg");
        // The ETag condition stops this from overwriting a file that was
        // replaced or deleted while it was being measured.
        self.storage.replace(path, &object.etag, data, content_type, metadata).await?;
        let replaced = self.storage.head(path).await?;
        ensure!(sha256(&self.storage.download(path, &replaced.etag, MAX_BYTES).await?) == adjusted_sha256,
            "Uploaded audio does not match the adjusted file");
        Ok(Outcome::Normalized { before, after, gain_db: steps as f64 * MP3_STEP_DB, original_sha256 })
    }

    fn record(&self, id: Uuid, path: &str, outcome: &Outcome) -> Result<()> {
        let failed = matches!(outcome, Outcome::Failed { .. });
        self.pool.get()?.execute(
            "INSERT INTO loudness_normalization (StorageScope, FilePath, ItemId, Policy, Outcome, Details, Attempts)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1)
             ON CONFLICT (StorageScope, FilePath) DO UPDATE SET ItemId = excluded.ItemId,
                Outcome = excluded.Outcome, Details = excluded.Details, UpdatedAt = CURRENT_TIMESTAMP,
                Attempts = CASE WHEN ?7 AND Policy = excluded.Policy THEN Attempts + 1 ELSE 1 END,
                Policy = excluded.Policy",
            params![self.storage.scope(), path, id.to_string(), POLICY, outcome.name(),
                serde_json::to_string(outcome)?, failed],
        )?;
        Ok(())
    }
}

/// Short MP3s only. Unknown durations are checked once the file is downloaded.
fn candidate(path: &str, seconds: Option<f64>) -> bool {
    path.to_lowercase().ends_with(".mp3") && seconds.is_none_or(|seconds| seconds > 0.0 && seconds < MAX_SECONDS)
}

/// The batch script's rule: aim for the target, but keep true peaks below the limit.
fn gain_steps(loudness: Loudness) -> i32 {
    // Leave 0.1 dB for the scanner's rounded peak report. MP3 gain is quantized.
    let to_target = ((TARGET_LUFS - loudness.lufs) / MP3_STEP_DB).round_ties_even();
    let to_peak = ((MAX_PEAK_DB - 0.1 - loudness.peak_db) / MP3_STEP_DB).floor();
    to_target.min(to_peak) as i32
}

fn prepare(tools: &Tools, original: &[u8]) -> Result<Plan> {
    let directory = tempfile::tempdir()?;
    let original_path = directory.path().join("original.mp3");
    std::fs::write(&original_path, original)?;
    let details = probe(tools, &original_path)?;
    let seconds = details.seconds;
    if !(seconds > 0.0 && seconds < MAX_SECONDS) {
        return Ok(Plan::Done(Outcome::Skipped { reason: format!("{seconds:.0} seconds is not a short song") }));
    }
    let Some(before) = measure(tools, &original_path)? else { return Ok(Plan::Done(Outcome::Silent)) };
    let steps = gain_steps(before);
    if steps == 0 {
        return Ok(Plan::Done(Outcome::Unchanged { loudness: before }));
    }
    // MP3Gain's undo record normally goes in an APE tag. Some older tag layouts
    // don't undo cleanly that way, so fall back to storing it in ID3.
    let mut last_error = None;
    for tag_options in [&[][..], &["-s", "i"][..]] {
        match adjust(tools, directory.path(), &original_path, &details, before, steps, tag_options) {
            Ok((after, data)) => return Ok(Plan::Adjust { before, after, steps, data }),
            Err(error) => last_error = Some(error),
        }
    }
    Err(last_error.unwrap())
}

fn adjust(
    tools: &Tools,
    directory: &Path,
    original: &Path,
    details: &Probe,
    before: Loudness,
    steps: i32,
    tag_options: &[&str],
) -> Result<(Loudness, Vec<u8>)> {
    let adjusted = directory.join("adjusted.mp3");
    std::fs::copy(original, &adjusted)?;
    // Old ReplayGain and undo tags must not describe a different baseline.
    let mp3gain = |args: &[&str], file: &Path| {
        let mut command = Command::new(&tools.mp3gain);
        command.arg("-q").args(tag_options).args(args).arg(file);
        run(command)
    };
    mp3gain(&["-s", "d"], &adjusted)?;
    mp3gain(&["-g", &steps.to_string()], &adjusted)?;
    let after = measure(tools, &adjusted)?.context("Adjusted audio is silent")?;
    ensure!(after.peak_db <= MAX_PEAK_DB, "Adjusted peak of {:.1} dB is too high", after.peak_db);
    ensure!((after.lufs - before.lufs - steps as f64 * MP3_STEP_DB).abs() <= 0.2,
        "Adjusted loudness differs from the planned change");
    let adjusted_details = probe(tools, &adjusted)?;
    ensure!(adjusted_details.stream == details.stream, "Audio properties changed");
    ensure!(adjusted_details.tags == details.tags, "Descriptive tags changed");
    let undo = directory.join("undo-check.mp3");
    std::fs::copy(&adjusted, &undo)?;
    mp3gain(&["-u"], &undo)?;
    ensure!(audio_hash(tools, original)? == audio_hash(tools, &undo)?,
        "Undo did not restore identical decoded audio");
    Ok((after, std::fs::read(&adjusted)?))
}

#[derive(Debug, PartialEq)]
struct Probe {
    seconds: f64,
    /// Codec, sample rate, channels and the exact packet count.
    stream: (String, String, i64, String),
    /// Title, artist, album, track and date.
    tags: Vec<Option<String>>,
}

fn probe(tools: &Tools, path: &Path) -> Result<Probe> {
    let mut command = Command::new(&tools.ffprobe);
    command.args(["-v", "error", "-select_streams", "a", "-count_packets", "-show_streams", "-show_format",
        "-of", "json"]).arg(path);
    let json: serde_json::Value = serde_json::from_str(&run(command)?.0)?;
    let streams = json["streams"].as_array().context("ffprobe returned no streams")?;
    ensure!(streams.len() == 1 && streams[0]["codec_name"] == "mp3", "Expected one MP3 audio stream");
    let stream = &streams[0];
    let text = |value: &serde_json::Value| value.as_str().unwrap_or_default().to_string();
    let format = &json["format"];
    Ok(Probe {
        seconds: text(&format["duration"]).parse().unwrap_or(0.0),
        stream: (text(&stream["codec_name"]), text(&stream["sample_rate"]),
            stream["channels"].as_i64().unwrap_or_default(), text(&stream["nb_read_packets"])),
        tags: ["title", "artist", "album", "track", "date"].iter()
            .map(|tag| format["tags"][tag].as_str().map(str::to_string)).collect(),
    })
}

/// Integrated loudness and true peak, or `None` for a silent recording.
fn measure(tools: &Tools, path: &Path) -> Result<Option<Loudness>> {
    let mut command = Command::new(&tools.ffmpeg);
    command.args(["-hide_banner", "-nostdin", "-nostats", "-xerror", "-i"]).arg(path)
        .args(["-map", "0:a:0", "-af", "ebur128=peak=true:framelog=verbose", "-f", "null", "-"]);
    parse_loudness(&run(command)?.1)
}

fn parse_loudness(output: &str) -> Result<Option<Loudness>> {
    let summary = output.rsplit_once("Summary:").context("FFmpeg printed no loudness summary")?.1;
    let value = |label: &str| -> Result<f64> {
        let line = summary.lines().map(str::trim).find(|line| line.starts_with(&format!("{label}:")))
            .with_context(|| format!("FFmpeg printed no {label} value"))?;
        Ok(line[label.len() + 1..].split_whitespace().next().unwrap_or_default().parse()?)
    };
    let peak_db = value("Peak")?;
    if peak_db == f64::NEG_INFINITY {
        return Ok(None);
    }
    let lufs = value("I")?;
    ensure!(lufs.is_finite() && peak_db.is_finite(), "Loudness measurement is not finite");
    Ok(Some(Loudness { lufs, peak_db }))
}

/// Hash the decoded samples. MP3Gain's undo can change the bits of silent
/// padding frames even when the audio itself is identical.
fn audio_hash(tools: &Tools, path: &Path) -> Result<String> {
    let mut command = Command::new(&tools.ffmpeg);
    command.args(["-v", "error", "-xerror", "-i"]).arg(path)
        .args(["-map", "0:a:0", "-c:a", "pcm_f32le", "-f", "hash", "-hash", "sha256", "-"]);
    Ok(run(command)?.0.trim().to_string())
}

/// Run a tool at low priority and return its stdout and stderr.
fn run(command: Command) -> Result<(String, String)> {
    let mut niced = Command::new("nice");
    niced.arg("-n10").arg(command.get_program()).args(command.get_args());
    let output = niced.output().with_context(|| format!("Could not run {:?}", command.get_program()))?;
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    if !output.status.success() {
        bail!("{:?} failed: {}", command.get_program(), stderr.lines().last().unwrap_or_default());
    }
    Ok((String::from_utf8_lossy(&output.stdout).into_owned(), stderr))
}

fn sha256(data: &[u8]) -> String {
    Sha256::digest(data).iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::Bytes,
        extract::State,
        http::{HeaderMap, Method, StatusCode},
        response::{IntoResponse, Response},
        Router,
    };
    use reitunes_workspace::{open_connection_pool, Event, EventWithMetadata};
    use std::{collections::HashMap, future::IntoFuture};

    fn loudness(lufs: f64, peak_db: f64) -> Loudness {
        Loudness { lufs, peak_db }
    }

    #[test]
    fn peak_protection_and_known_trial_gains() {
        // The same cases as scripts/test_normalize_mp3s.py.
        assert_eq!(gain_steps(loudness(-20.2, -8.1)), 1);
        assert_eq!(gain_steps(loudness(-17.3, -0.2)), -1);
        assert_eq!(gain_steps(loudness(-9.1, 0.0)), -6);
        assert!(gain_steps(loudness(-40.0, -1.0)) <= 0);
    }

    #[test]
    fn only_short_mp3s_are_candidates() {
        assert!(candidate("song.mp3", Some(200.0)));
        assert!(candidate("SONG.MP3", None));
        for (path, seconds) in [("song.m4a", Some(200.0)), ("set.mp3", Some(900.0)), ("set.mp3", Some(7200.0)),
            ("broken.mp3", Some(0.0))] {
            assert!(!candidate(path, seconds), "{path} {seconds:?}");
        }
    }

    #[test]
    fn parses_the_loudness_summary_and_recognizes_silence() {
        let summary = "noise\n[Parsed_ebur128_0 @ 0x1] Summary:\n\n  Integrated loudness:\n    I:         -20.2 LUFS\n    Threshold: -30.3 LUFS\n\n  True peak:\n    Peak:       -8.1 dBFS\n";
        assert_eq!(parse_loudness(summary).unwrap(), Some(loudness(-20.2, -8.1)));
        let silent = "Summary:\n    I:         -70.0 LUFS\n    Peak:       -inf dBFS\n";
        assert_eq!(parse_loudness(silent).unwrap(), None);
        assert!(parse_loudness("no summary here").is_err());
    }

    #[derive(Clone, Default)]
    struct FakeObject(Arc<Mutex<FakeState>>);

    #[derive(Default)]
    struct FakeState {
        data: Vec<u8>,
        metadata: HashMap<String, String>,
        downloads: usize,
        puts: usize,
        /// Simulates someone else replacing the file just before our upload.
        replace_before_put: bool,
    }

    impl FakeState {
        fn etag(&self) -> String {
            format!("\"{}\"", &sha256(&self.data)[..32])
        }
    }

    /// Undo the SDK's aws-chunked framing, if it used it.
    fn decode_body(headers: &HeaderMap, body: &[u8]) -> Vec<u8> {
        let chunked = headers.get("content-encoding").is_some_and(|value| value.to_str().unwrap().contains("aws-chunked"));
        if !chunked {
            return body.to_vec();
        }
        let mut data = Vec::new();
        let mut rest = body;
        loop {
            let line_end = rest.windows(2).position(|pair| pair == b"\r\n").unwrap();
            let size_text = std::str::from_utf8(&rest[..line_end]).unwrap();
            let size = usize::from_str_radix(size_text.split(';').next().unwrap(), 16).unwrap();
            if size == 0 {
                return data;
            }
            rest = &rest[line_end + 2..];
            data.extend_from_slice(&rest[..size]);
            rest = &rest[size + 2..];
        }
    }

    async fn handle(State(fake): State<FakeObject>, method: Method, headers: HeaderMap, body: Bytes) -> Response {
        let mut state = fake.0.lock().unwrap();
        let if_match = headers.get("if-match").map(|value| value.to_str().unwrap().to_string());
        let mut response_headers = HeaderMap::new();
        response_headers.insert("etag", state.etag().parse().unwrap());
        response_headers.insert("content-type", "audio/mpeg".parse().unwrap());
        for (key, value) in &state.metadata {
            response_headers.insert(axum::http::HeaderName::from_bytes(format!("x-amz-meta-{key}").as_bytes()).unwrap(),
                value.parse().unwrap());
        }
        match method {
            Method::HEAD => {
                response_headers.insert("content-length", state.data.len().into());
                (StatusCode::OK, response_headers).into_response()
            }
            Method::GET if if_match.as_deref() == Some(&state.etag()) => {
                state.downloads += 1;
                (StatusCode::OK, response_headers, state.data.clone()).into_response()
            }
            Method::PUT => {
                if state.replace_before_put {
                    state.data = b"someone else's file".to_vec();
                }
                if if_match.as_deref() != Some(&state.etag()) {
                    return StatusCode::PRECONDITION_FAILED.into_response();
                }
                state.data = decode_body(&headers, &body);
                state.metadata = headers.iter()
                    .filter_map(|(key, value)| key.as_str().strip_prefix("x-amz-meta-")
                        .map(|key| (key.to_string(), value.to_str().unwrap().to_string())))
                    .collect();
                state.puts += 1;
                let etag = state.etag();
                (StatusCode::OK, [("etag", etag)]).into_response()
            }
            _ => StatusCode::PRECONDITION_FAILED.into_response(),
        }
    }

    /// Tools from the environment (`MP3GAIN_PATH` etc.), or `None` to skip.
    fn installed_tools() -> Option<Tools> {
        let tools = Tools::from_env();
        let missing = tools.missing();
        if missing.is_empty() {
            Some(tools)
        } else {
            eprintln!("Skipping: {missing:?} not installed (set MP3GAIN_PATH etc. to run this test)");
            None
        }
    }

    /// A quiet five-second tone, well below the target loudness.
    fn quiet_mp3(tools: &Tools) -> Vec<u8> {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("quiet.mp3");
        let mut command = Command::new(&tools.ffmpeg);
        command.args(["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=5", "-af", "volume=-35dB",
            "-c:a", "libmp3lame", "-b:a", "192k", "-metadata", "title=Quiet", "-metadata", "artist=Tester"]).arg(&path);
        run(command).unwrap();
        std::fs::read(path).unwrap()
    }

    async fn harness(tools: Tools, data: Vec<u8>) -> (Worker, FakeObject, Uuid, tempfile::TempDir) {
        let fake = FakeObject::default();
        fake.0.lock().unwrap().data = data;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(axum::serve(listener, Router::new().fallback(handle).with_state(fake.clone())).into_future());
        let storage = S3Storage::new(&endpoint, "test", Some("prod"), "test", "test").await.unwrap();
        let directory = tempfile::tempdir().unwrap();
        let pool = open_connection_pool(directory.path().join("library.db").to_str().unwrap()).unwrap();
        let id = Uuid::new_v4();
        let mut library = Library::new();
        library.apply(&EventWithMetadata::new(id, Event::LibraryItemCreatedEvent {
            name: "Quiet".into(), artist: None, album: None, track_number: None, file_path: "quiet.mp3".into(),
        }).unwrap());
        let worker = Worker { pool, library: Arc::new(RwLock::new(library)), storage: Arc::new(storage), tools };
        (worker, fake, id, directory)
    }

    fn row(worker: &Worker) -> (String, i64, serde_json::Value) {
        worker.pool.get().unwrap().query_row(
            "SELECT Outcome, Attempts, Details FROM loudness_normalization WHERE FilePath = 'quiet.mp3'", [],
            |row| Ok((row.get(0)?, row.get(1)?, serde_json::from_str(&row.get::<_, String>(2)?).unwrap())),
        ).unwrap()
    }

    #[tokio::test]
    async fn normalizes_in_place_once_and_keeps_the_audio_undoable() {
        let Some(tools) = installed_tools() else { return };
        let original = quiet_mp3(&tools);
        let (worker, fake, id, _directory) = harness(tools.clone(), original.clone()).await;
        worker.process(id).await.unwrap();

        let (outcome, attempts, details) = row(&worker);
        assert_eq!((outcome.as_str(), attempts), ("normalized", 1), "{details}");
        assert!(details["gain_db"].as_f64().unwrap() > 0.0);
        let state = fake.0.lock().unwrap();
        assert_eq!(state.puts, 1);
        assert_eq!(state.metadata.get(POLICY_METADATA).map(String::as_str), Some(POLICY));
        assert_eq!(state.metadata.get("reitunes-original-sha256"), Some(&sha256(&original)));
        // MP3Gain's undo record restores the original samples.
        let directory = tempfile::tempdir().unwrap();
        let (before, after) = (directory.path().join("before.mp3"), directory.path().join("after.mp3"));
        std::fs::write(&before, &original).unwrap();
        std::fs::write(&after, &state.data).unwrap();
        drop(state);
        let mut undo = Command::new(&tools.mp3gain);
        undo.args(["-q", "-u"]).arg(&after);
        run(undo).unwrap();
        assert_eq!(audio_hash(&tools, &before).unwrap(), audio_hash(&tools, &after).unwrap());

        // Already done: neither the queue nor the sweep touches it again.
        worker.process(id).await.unwrap();
        assert_eq!(fake.0.lock().unwrap().puts, 1);
        assert!(worker.sweep_candidates().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_file_replaced_mid_way_is_not_overwritten_and_is_retried() {
        let Some(tools) = installed_tools() else { return };
        let (worker, fake, id, _directory) = harness(tools.clone(), quiet_mp3(&tools)).await;
        fake.0.lock().unwrap().replace_before_put = true;
        worker.process(id).await.unwrap();
        assert_eq!(row(&worker).0, "failed");
        assert_eq!(fake.0.lock().unwrap().data, b"someone else's file");
        // Failures are retried by the sweep, up to a limit.
        assert_eq!(worker.sweep_candidates().await.unwrap(), vec![id]);
        for _ in 0..MAX_ATTEMPTS {
            worker.record(id, "quiet.mp3", &Outcome::Failed { error: "again".into() }).unwrap();
        }
        assert!(worker.sweep_candidates().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn batch_normalized_objects_are_recorded_without_downloading() {
        let Some(tools) = installed_tools() else { return };
        let (worker, fake, id, _directory) = harness(tools, b"not even audio".to_vec()).await;
        fake.0.lock().unwrap().metadata.insert(POLICY_METADATA.into(), POLICY.into());
        worker.process(id).await.unwrap();
        assert_eq!(row(&worker).0, "already_normalized");
        let state = fake.0.lock().unwrap();
        assert_eq!((state.downloads, state.puts), (0, 0));
    }
}
