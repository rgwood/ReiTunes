use std::{
    collections::HashMap,
    io::{self, Read, Seek, SeekFrom},
    sync::{LazyLock, Mutex},
    time::{Duration, Instant},
};

use anyhow::{ensure, Context, Result};
use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use lofty::{
    config::ParseOptions,
    file::{AudioFile, FileType},
    probe::Probe,
    properties::FileProperties,
};
use reqwest::{blocking::Client, header};
use serde::Serialize;
use tokio::sync::Semaphore;
use uuid::Uuid;

use crate::{AppError, AppState};

const BLOCK_SIZE: u64 = 64 * 1024;
const MAX_BLOCKS: usize = 64; // At most 4 MiB, even for a multi-hour set.
static PROBES: Semaphore = Semaphore::const_new(2);
static CACHE: LazyLock<Mutex<HashMap<String, (Instant, FileInfo)>>> = LazyLock::new(Mutex::default);

#[derive(Clone, Default, Serialize)]
pub struct FileInfo {
    file_path: String,
    size_bytes: u64,
    format: Option<String>,
    codec: Option<String>,
    bitrate_kbps: Option<u32>,
    duration_seconds: Option<f64>,
    sample_rate_hz: Option<u32>,
    channels: Option<u8>,
    bit_depth: Option<u8>,
    error: Option<String>,
}

pub async fn get(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Response, AppError> {
    let path = {
        let library = state.library.read().await;
        let Some(item) = library.items.get(&id) else {
            return Ok(StatusCode::NOT_FOUND.into_response());
        };
        item.file_path.clone()
    };
    let url = state.storage.url(&path);
    let cached = CACHE
        .lock()
        .unwrap()
        .get(&url)
        .filter(|(time, _)| time.elapsed() < Duration::from_secs(3600))
        .map(|(_, value)| value.clone());
    let mut info = if let Some(info) = cached {
        info
    } else {
        let Ok(permit) = PROBES.try_acquire() else {
            return Ok(StatusCode::SERVICE_UNAVAILABLE.into_response());
        };
        let source = url.clone();
        let info = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            inspect(&source)
        })
        .await??;
        if info.error.is_none() {
            let mut cache = CACHE.lock().unwrap();
            if cache.len() >= 256 {
                cache.clear();
            }
            cache.insert(url, (Instant::now(), info.clone()));
        }
        info
    };
    // A replacement while probing must not attach the old file's information.
    if !state
        .library
        .read()
        .await
        .items
        .get(&id)
        .is_some_and(|item| item.file_path == path)
    {
        return Ok(StatusCode::CONFLICT.into_response());
    }
    info.file_path = path.clone();
    if let Some(seconds) = info.duration_seconds {
        crate::durations::persist(&state, id, &path, seconds, true).await?;
    }
    Ok(Json(info).into_response())
}

fn inspect(url: &str) -> Result<FileInfo> {
    let mut reader = RemoteFile::open(url)?;
    let mut info = FileInfo {
        size_bytes: reader.size,
        ..Default::default()
    };
    match properties(&mut reader) {
        Ok((format, codec, properties)) => {
            info.format = Some(format);
            info.codec = codec;
            info.bitrate_kbps = properties.audio_bitrate().filter(|value| *value > 0);
            info.duration_seconds = Some(properties.duration().as_secs_f64())
                .filter(|value| crate::durations::valid(*value));
            info.sample_rate_hz = properties.sample_rate().filter(|value| *value > 0);
            info.channels = properties.channels().filter(|value| *value > 0);
            info.bit_depth = properties.bit_depth().filter(|value| *value > 0);
        }
        Err(error) => {
            tracing::warn!(%error, "Could not inspect audio properties");
            info.error = Some("Could not read the audio properties. The file may be unsupported or temporarily unavailable.".into());
        }
    }
    Ok(info)
}

fn properties(reader: &mut (impl Read + Seek)) -> Result<(String, Option<String>, FileProperties)> {
    let kind = Probe::new(&mut *reader)
        .guess_file_type()?
        .file_type()
        .context("Unknown audio format")?;
    reader.rewind()?;
    let options = ParseOptions::new().read_tags(false).read_cover_art(false);
    match kind {
        FileType::Mpeg => {
            let file = lofty::mpeg::MpegFile::read_from(reader, options)?;
            let codec = match file.properties().layer() {
                lofty::mpeg::Layer::Layer1 => "MP1 (MPEG Layer I)",
                lofty::mpeg::Layer::Layer2 => "MP2 (MPEG Layer II)",
                lofty::mpeg::Layer::Layer3 => "MP3 (MPEG Layer III)",
            };
            Ok((
                "MPEG audio".into(),
                Some(codec.into()),
                file.properties().clone().into(),
            ))
        }
        FileType::Mp4 => {
            let file = lofty::mp4::Mp4File::read_from(reader, options)?;
            let codec = match file.properties().codec() {
                lofty::mp4::Mp4Codec::Unknown => None,
                codec => Some(format!("{codec:?}")),
            };
            Ok(("MP4 / M4A".into(), codec, file.properties().clone().into()))
        }
        _ => {
            let file = Probe::with_file_type(reader, kind)
                .options(options)
                .read()?;
            let (format, codec) = match kind {
                FileType::Flac => ("FLAC", Some("FLAC")),
                FileType::Aac => ("ADTS", Some("AAC")),
                FileType::Opus => ("Ogg", Some("Opus")),
                FileType::Vorbis => ("Ogg", Some("Vorbis")),
                FileType::Speex => ("Ogg", Some("Speex")),
                FileType::Wav => ("WAV", None),
                FileType::Aiff => ("AIFF", None),
                FileType::Ape => ("Monkey’s Audio", Some("APE")),
                FileType::WavPack => ("WavPack", Some("WavPack")),
                FileType::Mpc => ("Musepack", Some("Musepack")),
                _ => ("Unknown", None),
            };
            Ok((
                format.into(),
                codec.map(String::from),
                file.properties().clone(),
            ))
        }
    }
}

// Seek over object storage without copying an entire recording. The parser sees
// the real file length; only requested blocks are fetched and cached in memory.
struct RemoteFile {
    client: Client,
    url: String,
    etag: Option<String>,
    size: u64,
    position: u64,
    blocks: HashMap<u64, Vec<u8>>,
    started: Instant,
}

impl RemoteFile {
    fn open(url: &str) -> Result<Self> {
        let client = Client::builder()
            .timeout(Duration::from_secs(10))
            .redirect(reqwest::redirect::Policy::none())
            .build()?;
        let response = client
            .head(url)
            .header(header::ACCEPT_ENCODING, "identity")
            .send()?
            .error_for_status()?;
        let size = response
            .headers()
            .get(header::CONTENT_LENGTH)
            .context("Missing file size")?
            .to_str()?
            .parse()?;
        let etag = response
            .headers()
            .get(header::ETAG)
            .and_then(|value| value.to_str().ok())
            .map(String::from);
        Ok(Self {
            client,
            url: url.into(),
            etag,
            size,
            position: 0,
            blocks: HashMap::new(),
            started: Instant::now(),
        })
    }

    fn block(&mut self, start: u64) -> Result<&[u8]> {
        if !self.blocks.contains_key(&start) {
            ensure!(
                self.blocks.len() < MAX_BLOCKS && self.started.elapsed() < Duration::from_secs(20),
                "Audio header read limit reached"
            );
            let end = (start + BLOCK_SIZE).min(self.size) - 1;
            let mut request = self
                .client
                .get(&self.url)
                .header(header::ACCEPT_ENCODING, "identity")
                .header(header::RANGE, format!("bytes={start}-{end}"));
            if let Some(etag) = &self.etag {
                request = request.header(header::IF_MATCH, etag);
            }
            let response = request.send()?.error_for_status()?;
            ensure!(
                response.status() == reqwest::StatusCode::PARTIAL_CONTENT,
                "Storage did not honor the byte range"
            );
            let expected = format!("bytes {start}-{end}/{}", self.size);
            ensure!(
                response
                    .headers()
                    .get(header::CONTENT_RANGE)
                    .and_then(|value| value.to_str().ok())
                    == Some(expected.as_str()),
                "Storage returned an unexpected byte range"
            );
            let mut bytes = Vec::new();
            response.take(BLOCK_SIZE + 1).read_to_end(&mut bytes)?;
            ensure!(
                bytes.len() as u64 == end - start + 1,
                "Incomplete audio header block"
            );
            self.blocks.insert(start, bytes);
        }
        Ok(&self.blocks[&start])
    }
}

impl Read for RemoteFile {
    fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
        if output.is_empty() || self.position >= self.size {
            return Ok(0);
        }
        let start = self.position / BLOCK_SIZE * BLOCK_SIZE;
        let offset = (self.position - start) as usize;
        let block = self.block(start).map_err(io::Error::other)?;
        let count = output.len().min(block.len() - offset);
        output[..count].copy_from_slice(&block[offset..offset + count]);
        self.position += count as u64;
        Ok(count)
    }
}

impl Seek for RemoteFile {
    fn seek(&mut self, from: SeekFrom) -> io::Result<u64> {
        let position = match from {
            SeekFrom::Start(value) => i128::from(value),
            SeekFrom::Current(value) => i128::from(self.position) + i128::from(value),
            SeekFrom::End(value) => i128::from(self.size) + i128::from(value),
        };
        self.position = u64::try_from(position)
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "Invalid audio seek"))?;
        Ok(self.position)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::Body,
        http::{HeaderMap, Response as HttpResponse},
        routing::get,
        Router,
    };
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };

    fn wav() -> Vec<u8> {
        let mut data = Vec::from(&b"RIFF"[..]);
        let sample_bytes = 44100_u32 * 2 * 2;
        data.extend((36 + sample_bytes).to_le_bytes());
        data.extend(b"WAVEfmt ");
        data.extend(16_u32.to_le_bytes());
        data.extend(1_u16.to_le_bytes()); // PCM
        data.extend(2_u16.to_le_bytes());
        data.extend(44100_u32.to_le_bytes());
        data.extend(sample_bytes.to_le_bytes());
        data.extend(4_u16.to_le_bytes());
        data.extend(16_u16.to_le_bytes());
        data.extend(b"data");
        data.extend(sample_bytes.to_le_bytes());
        data.resize(data.len() + sample_bytes as usize, 0);
        data
    }

    async fn server(
        data: Vec<u8>,
        honor_range: bool,
    ) -> (String, Arc<AtomicUsize>, tokio::task::JoinHandle<()>) {
        let data = Arc::new(data);
        let requests = Arc::new(AtomicUsize::new(0));
        let count = requests.clone();
        let head_data = data.clone();
        let app = Router::new().route(
            "/audio",
            get(move |headers: HeaderMap| {
                let data = data.clone();
                let count = count.clone();
                async move {
                    count.fetch_add(1, Ordering::SeqCst);
                    assert_eq!(headers[header::IF_MATCH], "\"original\"");
                    let range = headers[header::RANGE]
                        .to_str()
                        .unwrap()
                        .strip_prefix("bytes=")
                        .unwrap();
                    let (start, end) = range.split_once('-').unwrap();
                    let (start, end): (usize, usize) =
                        (start.parse().unwrap(), end.parse().unwrap());
                    HttpResponse::builder()
                        .status(if honor_range { 206 } else { 200 })
                        .header(
                            header::CONTENT_RANGE,
                            format!("bytes {start}-{end}/{}", data.len()),
                        )
                        .body(Body::from(data[start..=end].to_vec()))
                        .unwrap()
                }
            })
            .head(move || {
                let data = head_data.clone();
                async move {
                    HttpResponse::builder()
                        .header(header::CONTENT_LENGTH, data.len())
                        .header(header::ETAG, "\"original\"")
                        .body(Body::empty())
                        .unwrap()
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/audio", listener.local_addr().unwrap());
        let task = tokio::spawn(async {
            axum::serve(listener, app).await.unwrap();
        });
        (url, requests, task)
    }

    #[tokio::test]
    async fn reads_audio_properties_over_ranges_without_downloading_the_whole_file() {
        let data = wav();
        let size = data.len();
        let (url, requests, task) = server(data, true).await;
        let result = tokio::task::spawn_blocking(move || inspect(&url))
            .await
            .unwrap()
            .unwrap();
        task.abort();
        assert!(result.error.is_none(), "{:?}", result.error);
        assert_eq!(result.size_bytes, size as u64);
        assert_eq!(result.format.as_deref(), Some("WAV"));
        assert_eq!(result.sample_rate_hz, Some(44100));
        assert_eq!(result.channels, Some(2));
        assert_eq!(result.bit_depth, Some(16));
        assert_eq!(result.duration_seconds, Some(1.0));
        assert!(requests.load(Ordering::SeqCst) <= 2);
    }

    #[tokio::test]
    async fn seek_reads_real_offsets_and_reuses_blocks() {
        let data: Vec<u8> = (0..200_000).map(|i| (i % 251) as u8).collect();
        let (url, requests, task) = server(data.clone(), true).await;
        tokio::task::spawn_blocking(move || {
            let mut file = RemoteFile::open(&url).unwrap();
            file.seek(SeekFrom::Start(BLOCK_SIZE - 2)).unwrap();
            let mut bytes = [0; 4];
            file.read_exact(&mut bytes).unwrap();
            assert_eq!(
                &bytes,
                &data[BLOCK_SIZE as usize - 2..BLOCK_SIZE as usize + 2]
            );
            file.rewind().unwrap();
            file.read_exact(&mut bytes).unwrap();
            assert_eq!(&bytes, &data[..4]);
            file.seek(SeekFrom::End(-4)).unwrap();
            file.read_exact(&mut bytes).unwrap();
            assert_eq!(&bytes, &data[data.len() - 4..]);
            assert!(file.seek(SeekFrom::Start(0)).is_ok());
            assert!(file.seek(SeekFrom::Current(-1)).is_err());
            assert_eq!(file.seek(SeekFrom::Current(0)).unwrap(), 0);
        })
        .await
        .unwrap();
        task.abort();
        assert_eq!(requests.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn refuses_full_downloads_and_keeps_size_when_properties_fail() {
        let (url, _, task) = server(wav(), false).await;
        let result = tokio::task::spawn_blocking(move || inspect(&url))
            .await
            .unwrap()
            .unwrap();
        task.abort();
        assert!(result.error.is_some());
        assert!(result.size_bytes > 0);
        assert!(result.duration_seconds.is_none());
    }

    #[tokio::test]
    async fn excessive_reads_stop_at_the_budget() {
        let (url, requests, task) =
            server(vec![0; (MAX_BLOCKS + 1) * BLOCK_SIZE as usize], true).await;
        tokio::task::spawn_blocking(move || {
            let mut file = RemoteFile::open(&url).unwrap();
            let mut byte = [0];
            for block in 0..MAX_BLOCKS {
                file.seek(SeekFrom::Start(block as u64 * BLOCK_SIZE))
                    .unwrap();
                file.read_exact(&mut byte).unwrap();
            }
            file.seek(SeekFrom::Start(MAX_BLOCKS as u64 * BLOCK_SIZE))
                .unwrap();
            assert!(file.read_exact(&mut byte).is_err());
        })
        .await
        .unwrap();
        task.abort();
        assert_eq!(requests.load(Ordering::SeqCst), MAX_BLOCKS);
    }

    #[test]
    #[ignore = "requires FILE_INFO_TEST_URL pointing to a real cloud audio object"]
    fn inspect_cloud_recording() {
        let result = inspect(&std::env::var("FILE_INFO_TEST_URL").unwrap()).unwrap();
        assert!(result.error.is_none(), "{:?}", result.error);
        assert!(result.duration_seconds.is_some());
        assert!(result.bitrate_kbps.is_some());
        println!("{}", serde_json::to_string_pretty(&result).unwrap());
    }
}
