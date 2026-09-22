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
        /// Model request profile; production GLM settings remain unchanged by default.
        #[arg(long, value_enum, default_value_t = ModelProfile::Glm)]
        model_profile: ModelProfile,
        /// Evaluate only the agent used by production, skipping the fixed baseline.
        #[arg(long)]
        agent_only: bool,
    },
    Replay {
        #[arg(long)]
        dir: PathBuf,
    },
    /// Recheck recorded responses with the current parser, without any live calls.
    Recheck {
        #[arg(long)]
        dir: PathBuf,
        /// New output file; original reports and traces are never changed.
        #[arg(long)]
        out: PathBuf,
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
    divergence: Option<String>,
}
impl Model for ReplayModel {
    async fn complete(&mut self, request: Value) -> Result<Value> {
        let error = match self.pairs.front() {
            None => Some("Unexpected extra model call; no saved response is available"),
            Some((expected, _)) if *expected != request => {
                Some("Replay request diverged from saved production-engine request")
            }
            _ => None,
        };
        if let Some(error) = error {
            self.divergence = Some(error.into());
            bail!("{error}");
        }
        Ok(self.pairs.pop_front().unwrap().1)
    }
}
struct ReplayMb {
    calls: VecDeque<Value>,
    divergence: Option<String>,
}
impl MusicBrainz for ReplayMb {
    async fn get(&mut self, kind: &str, id: Option<&str>, query: Option<&str>) -> Result<Value> {
        let error = match self.calls.front() {
            None => Some("Unexpected extra MusicBrainz call"),
            Some(call)
                if call["kind"] != kind
                    || call["id"] != json!(id)
                    || call["query"] != json!(query) =>
            {
                Some("MusicBrainz replay query diverged")
            }
            _ => None,
        };
        if let Some(error) = error {
            self.divergence = Some(error.into());
            bail!("{error}");
        }
        let call = self.calls.pop_front().unwrap();
        if let Some(error) = call["error"].as_str() {
            bail!("{error}");
        }
        Ok(call["result"].clone())
    }
}

async fn recheck(dir: &Path) -> Result<Value> {
    let inputs: Vec<Input> = serde_json::from_slice(&fs::read(dir.join("inputs.json"))?)?;
    let previous: Report = serde_json::from_slice(&fs::read(dir.join("report.json"))?)?;
    let events = read_lines(&dir.join("trace.jsonl"))?;
    let requests: Vec<_> = events.iter().filter(|e| e["event"] == "request").collect();
    let responses: Vec<_> = events.iter().filter(|e| e["event"] == "response").collect();
    if responses.len() > requests.len()
        || requests
            .iter()
            .zip(&responses)
            .any(|(request, response)| request["round"] != response["round"])
    {
        bail!("Recorded request/response rounds do not pair correctly");
    }
    let mut model = ReplayModel {
        pairs: requests
            .iter()
            .zip(&responses)
            .map(|(request, response)| (request["request"].clone(), response["response"].clone()))
            .collect(),
        divergence: None,
    };
    let mut mb = ReplayMb {
        calls: read_lines(&dir.join("musicbrainz.jsonl"))?,
        divergence: None,
    };
    let mut report = run(
        &inputs,
        previous.config.clone(),
        &mut model,
        &mut mb,
        |_| Ok(()),
    )
    .await?;
    let divergence: Vec<_> = [model.divergence, mb.divergence]
        .into_iter()
        .flatten()
        .collect();
    if !divergence.is_empty() {
        // A changed future prompt or query requires a live experiment. Do not let
        // a caught tool error make an unsupported counterfactual look accepted.
        report.predictions = None;
        report.error = Some(format!(
            "Offline recheck diverged: {}",
            divergence.join("; ")
        ));
    }
    Ok(json!({
        "original_directory":dir,
        "recheck_revision":REVISION,
        "report":report,
        "diverged":!divergence.is_empty(),
        "divergence_errors":divergence,
        "unused_model_responses":model.pairs.len(),
        "unused_musicbrainz_calls":mb.calls.len(),
        "saved_requests_without_responses":requests.len()-responses.len(),
        "original_accepted":previous.predictions.is_some(),
        "original_reported_cost_usd":previous.reported_cost_usd,
        "original_missing_cost_records":previous.missing_cost_records,
        "original_elapsed_seconds":previous.elapsed_seconds,
        "note":"Offline counterfactual using exact recorded requests and responses. Report cost covers only consumed saved responses; the original reported cost includes all actual calls. Missing costs stay unknown. Report elapsed_seconds measures offline replay, not model latency."
    }))
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
    json!({"accepted":report.predictions.is_some(),"model_profile":report.config.model_profile,"expected_artists":cases.iter().filter(|c|c["expected_artist"].is_string()).count(),"retrieved_expected_artists":retrieved,
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
        Command::Recheck { dir, out } => {
            let result = recheck(&dir).await?;
            if let Some(parent) = out.parent() {
                fs::create_dir_all(parent)?;
            }
            let mut file = OpenOptions::new().create_new(true).write(true).open(&out)?;
            file.write_all(&serde_json::to_vec_pretty(&result)?)?;
            file.sync_all()?;
            println!(
                "{}",
                serde_json::to_string(&json!({
                    "output":out,"accepted":result["report"]["predictions"].is_array(),
                    "diverged":result["diverged"],"unused_model_responses":result["unused_model_responses"]
                }))?
            );
        }
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
                divergence: None,
            };
            let mut mb = ReplayMb {
                calls: read_lines(&dir.join("musicbrainz.jsonl"))?,
                divergence: None,
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
            model_profile,
            agent_only,
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
                &json!({"revision":REVISION,"version":VERSION,"contract":*CONTRACT,"prompt":include_str!("../../agent-prompt.txt"),"repeats":repeats,"cache":cache,"model_profile":model_profile,"agent_only":agent_only,"note":"Fixed and agent use identical Rust collector evidence. Cache is shared and later rounds are warm. Tag usefulness is a predeclared narrow rubric, not human listening accuracy."}),
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
                let modes = if agent_only {
                    vec![Mode::Agent]
                } else {
                    vec![Mode::Fixed, Mode::Agent]
                };
                for mode in modes {
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
                            model_profile: Some(model_profile),
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

#[cfg(test)]
mod tests {
    use super::*;

    fn saved_run(directory: &Path, request_drift: bool) {
        let inputs = vec![Input {
            id: "t01".into(),
            name: "Live set".into(),
            artist: "".into(),
            album: "".into(),
            musicbrainz: json!({}),
        }];
        let research = Research::new(&inputs).unwrap();
        let mut request = research.initial_request().unwrap();
        request.as_object_mut().unwrap().remove("response_format");
        request["tools"] = research.tools();
        request["tool_choice"] = json!("auto");
        if request_drift {
            request["model"] = json!("different-model");
        }
        let content = json!({"items":[{
            "id":"t01","tags":[{"tag":"live","basis":"metadata","confidence":0.8,"evidence":"Title says live"}],
            "uncertainty":"Recording identity unknown","research":{"artist":null,"recording":null}
        }]}).to_string();
        let response = json!({"choices":[{"finish_reason":"stop","message":{"content":content}}],"usage":{"cost":0.001}});
        let original = Report {
            version: VERSION.into(),
            config: Config::default(),
            predictions: None,
            error: Some("Original run was interrupted".into()),
            model_calls: 3,
            tool_calls: 0,
            recoveries: 2,
            reported_cost_usd: 0.003,
            missing_cost_records: 1,
            elapsed_seconds: 80.0,
            research: json!([]),
        };
        save(directory.join("inputs.json"), &inputs).unwrap();
        save(directory.join("report.json"), &original).unwrap();
        let events = [
            json!({"event":"request","round":0,"request":request}),
            json!({"event":"response","round":0,"response":response}),
            json!({"event":"request","round":1,"request":{"later":"unused recovery prompt"}}),
            json!({"event":"response","round":1,"response":response}),
            json!({"event":"request","round":2,"request":{"later":"no saved response"}}),
        ];
        fs::write(
            directory.join("trace.jsonl"),
            events
                .iter()
                .map(Value::to_string)
                .collect::<Vec<_>>()
                .join("\n"),
        )
        .unwrap();
        fs::write(directory.join("musicbrainz.jsonl"), "").unwrap();
    }

    #[tokio::test]
    async fn recheck_accepts_earlier_response_without_erasing_original_cost_or_missing_response() {
        let directory = tempfile::tempdir().unwrap();
        saved_run(directory.path(), false);
        let before = fs::read(directory.path().join("trace.jsonl")).unwrap();
        let result = recheck(directory.path()).await.unwrap();
        assert_eq!(result["diverged"], false);
        assert!(result["report"]["predictions"].is_array());
        assert_eq!(result["report"]["model_calls"], 1);
        assert_eq!(result["unused_model_responses"], 1);
        assert_eq!(result["saved_requests_without_responses"], 1);
        assert_eq!(result["report"]["reported_cost_usd"], 0.001);
        assert_eq!(result["original_reported_cost_usd"], 0.003);
        assert_eq!(result["original_missing_cost_records"], 1);
        assert_eq!(
            fs::read(directory.path().join("trace.jsonl")).unwrap(),
            before
        );
    }

    #[tokio::test]
    async fn recheck_does_not_apply_saved_response_to_a_different_request() {
        let directory = tempfile::tempdir().unwrap();
        saved_run(directory.path(), true);
        let result = recheck(directory.path()).await.unwrap();
        assert_eq!(result["diverged"], true);
        assert!(result["report"]["predictions"].is_null());
        assert_eq!(result["unused_model_responses"], 2);
        assert!(result["divergence_errors"][0]
            .as_str()
            .unwrap()
            .contains("request diverged"));
    }
}
