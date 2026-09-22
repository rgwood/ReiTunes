//! Live and replay evaluations call tagging_engine::run, never a second loop.
use anyhow::{bail, Context, Result};
use clap::{Parser, Subcommand};
use serde_json::{json, Value};
use std::{
    collections::VecDeque,
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Instant,
};
use tagging_engine::*;

#[derive(Parser)]
struct Args {
    #[command(subcommand)]
    command: Command,
}
#[derive(Subcommand)]
enum Command {
    Live {
        #[arg(long)]
        key_file: PathBuf,
        #[arg(long)]
        out: PathBuf,
        /// Dedicated eval cache; never a production library database.
        #[arg(long)]
        cache: PathBuf,
        #[arg(long, default_value_t = 2)]
        repeats: usize,
        /// Optional JSON cases file using the checked-in case schema and batch field.
        #[arg(long)]
        cases: Option<PathBuf>,
    },
    Replay {
        #[arg(long)]
        dir: PathBuf,
    },
    Score {
        #[arg(long)]
        dir: PathBuf,
    },
}
fn save(path: impl AsRef<Path>, value: &impl serde::Serialize) -> Result<()> {
    fs::write(path, serde_json::to_vec_pretty(value)?)?;
    Ok(())
}
fn append(file: &Arc<Mutex<File>>, value: Value) -> Result<()> {
    let mut file = file.lock().unwrap();
    writeln!(file, "{}", serde_json::to_string(&value)?)?;
    file.flush()?;
    file.sync_data()?;
    Ok(())
}
fn read_lines(path: &Path) -> Result<VecDeque<Value>> {
    fs::read_to_string(path)?
        .lines()
        .map(|line| serde_json::from_str(line).map_err(Into::into))
        .collect()
}
struct RecordedMb<'a> {
    cache: evidence::Cache<'a>,
    file: Arc<Mutex<File>>,
}
impl MusicBrainz for RecordedMb<'_> {
    async fn get(&mut self, kind: &str, id: Option<&str>, query: Option<&str>) -> Result<Value> {
        let result = self.cache.get(kind, id, query).await;
        append(
            &self.file,
            json!({"kind":kind,"id":id,"query":query,"result":result.as_ref().ok(),"error":result.as_ref().err().map(ToString::to_string)}),
        )?;
        result
    }
}
struct ReplayModel {
    pairs: VecDeque<(Value, Value)>,
}
impl Model for ReplayModel {
    async fn complete(&mut self, request: Value) -> Result<Value> {
        let (expected, response) = self
            .pairs
            .pop_front()
            .context("Unexpected extra model call")?;
        if expected != request {
            bail!("Replay request diverged from saved production-engine request");
        }
        Ok(response)
    }
}
struct ReplayMb {
    calls: VecDeque<Value>,
}
impl MusicBrainz for ReplayMb {
    async fn get(&mut self, kind: &str, id: Option<&str>, query: Option<&str>) -> Result<Value> {
        let call = self
            .calls
            .pop_front()
            .context("Unexpected extra MusicBrainz call")?;
        if call["kind"] != kind || call["id"] != json!(id) || call["query"] != json!(query) {
            bail!("MusicBrainz replay query diverged");
        }
        if let Some(error) = call["error"].as_str() {
            bail!("{error}");
        }
        Ok(call["result"].clone())
    }
}
fn score(cases: &[Value], inputs: &[Input], report: &Report) -> Value {
    let mut retrieved = 0;
    let mut identities = 0;
    let mut unsupported = 0;
    let mut traps = 0;
    let mut useful = 0;
    let mut negative_abstentions = 0;
    let mut citations = 0;
    let mut invalid_citations = 0;
    for (index, (case, input)) in cases.iter().zip(inputs).enumerate() {
        let expected = case["expected_artist"].as_str();
        if let Some(expected) = expected {
            if report.research.as_array().unwrap().iter().any(|s| {
                s["mbid"] == expected
                    && s["attached"].as_array().unwrap().contains(&json!(input.id))
            }) {
                retrieved += 1;
            }
        }
        let Some(prediction) = report.predictions.as_ref().and_then(|p| p.get(index)) else {
            continue;
        };
        // Fixed mode has no identity-output field. Its selected artist candidate is
        // reported separately, not misrepresented as a final identity assertion.
        let identity = prediction.research["artist_mbid"].as_str();
        if expected.is_some() && identity == expected {
            identities += 1;
        }
        if identity.is_some() && identity != expected {
            unsupported += 1;
        }
        if case["no_recording"] == true && prediction.research["recording_mbid"].is_string() {
            traps += 1;
        }
        if expected.is_none() && prediction.tags.is_empty() && identity.is_none() {
            negative_abstentions += 1;
        }
        if prediction.tags.iter().any(|tag| {
            case["useful_tags"]
                .as_array()
                .unwrap()
                .contains(&json!(tag.tag))
        }) {
            useful += 1;
        }
        citations += prediction
            .tags
            .iter()
            .map(|tag| tag.source_urls.len())
            .sum::<usize>();
        for url in prediction.tags.iter().flat_map(|tag| &tag.source_urls) {
            let valid = if report.config.mode == Mode::Fixed {
                input.musicbrainz["sources"]
                    .as_array()
                    .is_some_and(|sources| sources.contains(&json!(url)))
            } else {
                report.research.as_array().unwrap().iter().any(|s| {
                    url == &format!(
                        "https://musicbrainz.org/{}/{}",
                        s["kind"].as_str().unwrap(),
                        s["mbid"].as_str().unwrap()
                    ) && s["attached"].as_array().unwrap().contains(&json!(input.id))
                        && s["eligible"].as_array().unwrap().contains(&json!(input.id))
                })
            };
            if !valid {
                invalid_citations += 1;
            }
        }
    }
    json!({"accepted":report.predictions.is_some(),"expected_artists":cases.iter().filter(|c|c["expected_artist"].is_string()).count(),"retrieved_expected_artists":retrieved,
        "correct_final_artist_candidates":if report.config.mode==Mode::Agent {json!(identities)} else {Value::Null},
        "unsupported_final_artist_claims":unsupported,"recording_claims_on_version_or_identity_traps":traps,
        "items_with_rubric_useful_tags":useful,"negative_full_abstentions":negative_abstentions,
        "accepted_citations":citations,"invalid_accepted_citations":invalid_citations,
        "latency_seconds":report.elapsed_seconds,"model_calls":report.model_calls,"tool_calls":report.tool_calls,"recoveries":report.recoveries,
        "reported_cost_usd":report.reported_cost_usd,"missing_cost_records":report.missing_cost_records,"error":report.error})
}

#[tokio::main]
async fn main() -> Result<()> {
    match Args::parse().command {
        Command::Score { dir } => {
            let cases: Vec<Value> = serde_json::from_slice(&fs::read(dir.join("cases.json"))?)?;
            let mut directories: Vec<_> =
                fs::read_dir(&dir)?.collect::<std::io::Result<Vec<_>>>()?;
            directories.sort_by_key(|entry| entry.file_name());
            let mut scores = Vec::new();
            for directory in directories {
                let path = directory.path();
                if !path.join("report.json").exists() {
                    continue;
                }
                let name = directory.file_name().to_string_lossy().to_string();
                let batch: u64 = name
                    .split('-')
                    .nth(1)
                    .context("Invalid batch directory")?
                    .parse()?;
                let selected: Vec<_> = cases
                    .iter()
                    .filter(|c| c["batch"] == batch)
                    .cloned()
                    .collect();
                let inputs: Vec<Input> =
                    serde_json::from_slice(&fs::read(path.join("inputs.json"))?)?;
                let report: Report = serde_json::from_slice(&fs::read(path.join("report.json"))?)?;
                let mut result = score(&selected, &inputs, &report);
                result["run"] = json!(name);
                result["batch"] = json!(batch);
                result["mode"] = json!(report.config.mode);
                scores.push(result);
            }
            save(dir.join("rescored.json"), &scores)?;
            println!("{}", serde_json::to_string_pretty(&scores)?);
        }
        Command::Replay { dir } => {
            let inputs: Vec<Input> = serde_json::from_slice(&fs::read(dir.join("inputs.json"))?)?;
            let previous: Report = serde_json::from_slice(&fs::read(dir.join("report.json"))?)?;
            let events = read_lines(&dir.join("trace.jsonl"))?;
            let requests: Vec<_> = events
                .iter()
                .filter(|e| e["event"] == "request")
                .map(|e| e["request"].clone())
                .collect();
            let responses: Vec<_> = events
                .iter()
                .filter(|e| e["event"] == "response")
                .map(|e| e["response"].clone())
                .collect();
            if requests.len() != responses.len() {
                bail!("Cannot replay a transport-interrupted run as a completed response");
            }
            let mut model = ReplayModel {
                pairs: requests.into_iter().zip(responses).collect(),
            };
            let mut mb = ReplayMb {
                calls: read_lines(&dir.join("musicbrainz.jsonl"))?,
            };
            let replay = run(
                &inputs,
                previous.config.clone(),
                &mut model,
                &mut mb,
                |_| Ok(()),
            )
            .await?;
            if serde_json::to_value(&replay.predictions)?
                != serde_json::to_value(&previous.predictions)?
                || replay.error != previous.error
                || !model.pairs.is_empty()
                || !mb.calls.is_empty()
            {
                bail!("Replay outcome diverged");
            }
            println!(
                "Exact requests, tool queries, validation and outcomes replayed successfully: {}",
                dir.display()
            );
        }
        Command::Live {
            key_file,
            out,
            cache,
            repeats,
            cases: cases_file,
        } => {
            if !(1..=3).contains(&repeats) {
                bail!("repeats must be 1–3");
            }
            if out.exists() {
                bail!("Output directory must not exist");
            }
            if cache
                .file_name()
                .is_some_and(|n| n.to_string_lossy().contains("library"))
            {
                bail!("Use a dedicated eval cache, never a library database");
            }
            if let Some(parent) = cache.parent() {
                fs::create_dir_all(parent)?;
            }
            let pool = r2d2::Pool::new(r2d2_sqlite::SqliteConnectionManager::file(&cache))?;
            let protected:i64=pool.get()?.query_row("SELECT count(*) FROM sqlite_master WHERE name IN ('events','tagging_items','tagging_labels')",[],|r|r.get(0))?;
            if protected > 0 {
                bail!("Refusing to use a production/library database as eval cache");
            }
            fs::create_dir_all(&out)?;
            let case_text = match cases_file {
                Some(path) => fs::read_to_string(path)?,
                None => include_str!("../../eval-cases.json").into(),
            };
            let cases: Vec<Value> = serde_json::from_str(&case_text)?;
            if cases.is_empty()
                || cases.len() > 100
                || cases.iter().any(|c| {
                    c["batch"].as_u64().is_none()
                        || ["name", "artist", "album"]
                            .iter()
                            .any(|k| !c[*k].is_string())
                        || !c["useful_tags"].is_array()
                })
            {
                bail!("Invalid eval cases");
            }
            save(out.join("cases.json"), &cases)?;
            save(
                out.join("manifest.json"),
                &json!({"revision":REVISION,"version":VERSION,"contract":*CONTRACT,"prompt":include_str!("../../agent-prompt.txt"),"repeats":repeats,"cache":cache,"note":"Fixed and agent use identical Rust collector evidence. Cache is shared and later rounds are warm. Tag usefulness is a predeclared narrow rubric, not human listening accuracy."}),
            )?;
            // Retain exact source text as well as the revision, including dirty eval builds.
            for (name, content) in [
                ("engine.rs", include_str!("../lib.rs")),
                ("research.rs", include_str!("../research.rs")),
                ("evidence.rs", include_str!("../evidence.rs")),
                ("baseline.rs", include_str!("../baseline.rs")),
                ("runner.rs", include_str!("tagging-eval.rs")),
            ] {
                fs::write(out.join(name), content)?;
            }
            let client = reqwest::Client::new();
            let mut model = HttpModel {
                client: client.clone(),
                endpoint: "https://openrouter.ai/api/v1/chat/completions".into(),
                key: fs::read_to_string(key_file)?.trim().into(),
            };
            let mut scores = Vec::new();
            let batches: std::collections::BTreeSet<_> =
                cases.iter().map(|c| c["batch"].as_u64().unwrap()).collect();
            for batch in batches {
                let selected: Vec<_> = cases
                    .iter()
                    .filter(|c| c["batch"] == batch)
                    .cloned()
                    .collect();
                if selected.len() > MAX_BATCH_ITEMS {
                    bail!("Eval batch exceeds production batch limit");
                }
                let mut inputs = Vec::new();
                let began = Instant::now();
                for (index, case) in selected.iter().enumerate() {
                    let name = case["name"].as_str().unwrap();
                    let artist = case["artist"].as_str().unwrap();
                    let album = case["album"].as_str().unwrap();
                    let musicbrainz =
                        evidence::collect(&pool, &client, name, artist, album).await?;
                    inputs.push(Input {
                        id: format!("t{:02}", index + 1),
                        name: name.into(),
                        artist: artist.into(),
                        album: album.into(),
                        musicbrainz,
                    });
                }
                let collector_seconds = began.elapsed().as_secs_f64();
                save(out.join(format!("batch-{batch}-evidence.json")), &inputs)?;
                for mode in [Mode::Fixed, Mode::Agent] {
                    for repeat in 1..=repeats {
                        let dir = out.join(format!("batch-{batch}-{mode:?}-{repeat}"));
                        fs::create_dir(&dir)?;
                        save(dir.join("inputs.json"), &inputs)?;
                        let trace = Arc::new(Mutex::new(
                            OpenOptions::new()
                                .create_new(true)
                                .write(true)
                                .open(dir.join("trace.jsonl"))?,
                        ));
                        let file = Arc::new(Mutex::new(
                            OpenOptions::new()
                                .create_new(true)
                                .write(true)
                                .open(dir.join("musicbrainz.jsonl"))?,
                        ));
                        let mut mb = RecordedMb {
                            cache: evidence::Cache::new(&pool, &client)?,
                            file,
                        };
                        let config = Config {
                            mode,
                            ..Default::default()
                        };
                        let report = run(&inputs, config, &mut model, &mut mb, |event| {
                            append(&trace, event)
                        })
                        .await?;
                        save(dir.join("report.json"), &report)?;
                        let mut result = score(&selected, &inputs, &report);
                        result["batch"] = json!(batch);
                        result["mode"] = json!(mode);
                        result["repeat"] = json!(repeat);
                        result["collector_seconds"] = json!(collector_seconds);
                        result["musicbrainz_requests"] = json!(mb.cache.requests);
                        result["musicbrainz_cache_hits"] = json!(mb.cache.hits);
                        println!("{}", serde_json::to_string(&result)?);
                        scores.push(result);
                        save(out.join("scores.json"), &scores)?;
                    }
                }
            }
            let snapshot = out.join("musicbrainz-cache.sqlite");
            pool.get()?.execute(
                "VACUUM INTO ?1",
                [snapshot.to_str().context("Invalid snapshot path")?],
            )?;
        }
    }
    Ok(())
}
