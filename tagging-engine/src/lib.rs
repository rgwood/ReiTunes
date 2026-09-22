//! One tagging implementation for the production queue, replay tests and live evals.
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{future::Future, time::Instant};

pub mod baseline;
pub mod evidence;
mod research;
pub use research::Research;
pub const MODEL: &str = "z-ai/glm-5.3-flash";
pub const VERSION: &str = "musicbrainz-agent-v1";
pub const REVISION: &str = env!("TAGGING_BUILD_REVISION");
pub const MAX_BATCH_ITEMS: usize = 20;
pub static CONTRACT: std::sync::LazyLock<Value> = std::sync::LazyLock::new(|| {
    serde_json::from_str(include_str!("../../reitunes/tagging-request.json")).unwrap()
});

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Input {
    pub id: String,
    pub name: String,
    pub artist: String,
    pub album: String,
    #[serde(default)]
    pub musicbrainz: Value,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Tag {
    pub tag: String,
    pub basis: String,
    pub confidence: f64,
    pub evidence: String,
    #[serde(alias = "source_urls")]
    pub source_urls: Vec<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Prediction {
    pub id: String,
    pub tags: Vec<Tag>,
    pub uncertainty: String,
    #[serde(default)]
    pub research: Value,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    Agent,
    Fixed,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Config {
    pub mode: Mode,
    pub max_model_calls: usize,
    pub max_tool_calls: usize,
    pub max_recoveries: usize,
    pub max_request_bytes: usize,
}
impl Default for Config {
    fn default() -> Self {
        Self {
            mode: Mode::Agent,
            max_model_calls: 6,
            max_tool_calls: 16,
            max_recoveries: 2,
            max_request_bytes: 160_000,
        }
    }
}

pub trait Model {
    fn complete(&mut self, request: Value) -> impl Future<Output = Result<Value>> + Send;
}
pub trait MusicBrainz {
    fn get(
        &mut self,
        kind: &str,
        id: Option<&str>,
        query: Option<&str>,
    ) -> impl Future<Output = Result<Value>> + Send;
}
impl MusicBrainz for evidence::Cache<'_> {
    async fn get(&mut self, kind: &str, id: Option<&str>, query: Option<&str>) -> Result<Value> {
        evidence::Cache::get(self, kind, id, query).await
    }
}
pub struct HttpModel {
    pub client: reqwest::Client,
    pub endpoint: String,
    pub key: String,
}
impl Model for HttpModel {
    async fn complete(&mut self, request: Value) -> Result<Value> {
        let mut response = self
            .client
            .post(&self.endpoint)
            .bearer_auth(&self.key)
            .json(&request)
            .timeout(std::time::Duration::from_secs(180))
            .send()
            .await
            .context("Model transport failed; billing may have occurred")?;
        let status = response.status();
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await? {
            if bytes.len() + chunk.len() > 1_000_000 {
                bail!("Model response exceeded size limit");
            }
            bytes.extend_from_slice(&chunk);
        }
        let mut raw: Value =
            serde_json::from_slice(&bytes).context("Invalid model HTTP response JSON")?;
        // Keep provider errors in the trace, but never retry a transport/HTTP failure.
        if !status.is_success() {
            raw["http_error"] = json!(status.as_u16());
        }
        Ok(raw)
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Report {
    pub version: String,
    pub config: Config,
    pub predictions: Option<Vec<Prediction>>,
    pub error: Option<String>,
    pub model_calls: usize,
    pub tool_calls: usize,
    pub recoveries: usize,
    pub reported_cost_usd: f64,
    pub missing_cost_records: usize,
    pub elapsed_seconds: f64,
    pub research: Value,
}

/// The recorder must durably save request events before the call is sent. It must
/// never record credentials. Production uses SQLite; evals use append-only JSONL.
pub async fn run<M: Model, B: MusicBrainz>(
    items: &[Input],
    config: Config,
    model: &mut M,
    mb: &mut B,
    mut record: impl FnMut(Value) -> Result<()> + Send,
) -> Result<Report> {
    let started = Instant::now();
    let mut report = Report {
        version: VERSION.into(),
        config: config.clone(),
        predictions: None,
        error: None,
        model_calls: 0,
        tool_calls: 0,
        recoveries: 0,
        reported_cost_usd: 0.0,
        missing_cost_records: 0,
        elapsed_seconds: 0.0,
        research: Value::Null,
    };
    let mut research = Research::new(items)?;
    record(
        json!({"event":"start","version":VERSION,"revision":REVISION,"config":config,"items":items}),
    )?;
    let result: Result<Vec<Prediction>> = async {
        if items.is_empty() || items.len() > MAX_BATCH_ITEMS { bail!("Batch must contain 1–20 items"); }
        if config.max_model_calls == 0 || config.max_model_calls > 8 || config.max_tool_calls > 32 || config.max_recoveries > 2 || config.max_request_bytes > 200_000 {
            bail!("Invalid engine budgets");
        }
        for (index, item) in items.iter().enumerate() {
            if item.id != format!("t{:02}", index + 1) { bail!("Item IDs must be issued by the server in order"); }
        }
        let initial = match config.mode {
            Mode::Fixed => baseline::build_request(items)?,
            Mode::Agent => research.initial_request()?,
        };
        let mut messages = initial["messages"].as_array().context("Missing messages")?.clone();
        let mut force_final = false;
        let mut tool_results = std::collections::HashMap::<String,Value>::new();
        for round in 0..config.max_model_calls {
            let mut request = initial.clone();
            let allow_tools = config.mode == Mode::Agent && !force_final && round + 1 < config.max_model_calls && report.tool_calls < config.max_tool_calls;
            if allow_tools {
                request["tools"] = research.tools();
                request["tool_choice"] = json!("auto");
                // JSON mode applies to final answers; this turn may be a tool call.
                request.as_object_mut().unwrap().remove("response_format");
            } else if config.mode == Mode::Agent {
                request["response_format"] = json!({"type":"json_object"});
            }
            request["messages"] = json!(messages);
            if serde_json::to_vec(&request)?.len() > config.max_request_bytes { bail!("Agent request budget exceeded"); }
            record(json!({"event":"request","round":round,"request":request}))?;
            report.model_calls += 1;
            let began = Instant::now();
            let raw = match model.complete(request).await {
                Ok(raw) => raw,
                Err(error) => {
                    report.missing_cost_records += 1;
                    record(json!({"event":"transport_error","round":round,"error":error.to_string(),"seconds":began.elapsed().as_secs_f64()}))?;
                    return Err(error);
                }
            };
            let cost = raw.pointer("/usage/cost").and_then(Value::as_f64).filter(|n| n.is_finite() && *n >= 0.0);
            if let Some(cost) = cost { report.reported_cost_usd += cost; } else { report.missing_cost_records += 1; }
            record(json!({"event":"response","round":round,"response":raw,"cost_usd":cost,"seconds":began.elapsed().as_secs_f64()}))?;
            if raw.get("http_error").is_some() || raw.get("error").is_some() { bail!("Model HTTP/provider error; explicit retry required"); }
            let message = &raw["choices"][0]["message"];
            let calls = message["tool_calls"].as_array().filter(|calls| !calls.is_empty());
            if let Some(calls) = calls {
                if !allow_tools { bail!("Model called tools after budget exhausted"); }
                if calls.len() > 32 { bail!("Too many tool calls in one response"); }
                let mut assistant = message.clone();
                assistant["role"] = json!("assistant");
                assistant.as_object_mut().context("Invalid assistant message")?.retain(|k, _| ["role", "content", "tool_calls", "reasoning", "reasoning_details"].contains(&k.as_str()));
                messages.push(assistant);
                let mut new_calls = 0;
                for call in calls {
                    let began = Instant::now();
                    let arguments: Value = serde_json::from_str(call["function"]["arguments"].as_str().unwrap_or_default()).unwrap_or(Value::Null);
                    let key = serde_json::to_string(&json!({"name":call["function"]["name"],"arguments":arguments}))?;
                    let repeated = tool_results.contains_key(&key);
                    let result = if report.tool_calls >= config.max_tool_calls {
                        json!({"error":"Tool budget exhausted; finalize using available evidence"})
                    } else {
                        report.tool_calls += 1; // Invalid attempts consume budget too.
                        if let Some(previous) = tool_results.get(&key) {
                            let mut previous = previous.clone();
                            previous["repeat_warning"] = json!("This identical call was already attempted. Do not repeat it; revise your query or finalize.");
                            previous
                        } else {
                            new_calls += 1;
                            let result = match research.execute(call, mb).await {
                                Ok(value) => value,
                                Err(error) => json!({"error":error.to_string(),"warning":"A failed lookup is not evidence of absence. Do not repeat this failed call; use other cached evidence or finalize."}),
                            };
                            tool_results.insert(key,result.clone());
                            result
                        }
                    };
                    record(json!({"event":"tool","round":round,"call":call,"result":result,"repeated":repeated,"seconds":began.elapsed().as_secs_f64()}))?;
                    messages.push(json!({"role":"tool","tool_call_id":call["id"],"content":serde_json::to_string(&result)?}));
                }
                if new_calls == 0 { force_final = true; }
                continue;
            }
            let parsed = match config.mode {
                Mode::Fixed => baseline::parse_predictions(&raw, items),
                Mode::Agent => research.parse(&raw),
            };
            match parsed {
                Ok(predictions) => return Ok(predictions),
                Err(error) => {
                    record(json!({"event":"validation_error","round":round,"error":error.to_string()}))?;
                    if report.recoveries >= config.max_recoveries || round + 1 == config.max_model_calls { return Err(error); }
                    report.recoveries += 1;
                    force_final = true;
                    // Send the exact rejected answer and specific validation feedback.
                    messages.push(json!({"role":"assistant","content":message["content"]}));
                    messages.push(json!({"role":"user","content":format!("Invalid output: {error}. Return one JSON object for ALL supplied items and nothing else. Use the schema exactly, no extra fields. Use only allowed evidence handles. Remove unsupported identities/citations and abstain where necessary. No tools remain.")}));
                }
            }
        }
        bail!("No valid final answer within model budget")
    }.await;
    match result {
        Ok(predictions) => report.predictions = Some(predictions),
        Err(error) => report.error = Some(error.to_string()),
    }
    report.elapsed_seconds = started.elapsed().as_secs_f64();
    report.research = research.audit();
    record(json!({"event":"outcome","report":report}))?;
    Ok(report)
}
