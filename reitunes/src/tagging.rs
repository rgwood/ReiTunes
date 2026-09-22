use anyhow::{bail, Context, Result};
use axum::{
    extract::{Path, State},
    http::StatusCode,
    routing::{get, post, put},
    Json, Router,
};
use reitunes_workspace::{Library, LibraryItem};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::{Notify, RwLock};
use uuid::Uuid;

mod evidence;
type Pool = r2d2::Pool<r2d2_sqlite::SqliteConnectionManager>;
type ApiError = (StatusCode, String);
#[cfg(test)]
use tagging_engine::{Prediction, CONTRACT};
use tagging_engine::{Tag, MAX_BATCH_ITEMS, MODEL};
#[derive(Clone)]
struct PreparedItem {
    id: Uuid,
    hash: String,
    metadata: Metadata,
    evidence: Value,
}

#[derive(Clone, Serialize)]
struct Metadata {
    name: String,
    artist: String,
    album: String,
    file_path: String,
}
impl From<&LibraryItem> for Metadata {
    fn from(item: &LibraryItem) -> Self {
        Self {
            name: item.name.clone(),
            artist: item.artist.clone(),
            album: item.album.clone(),
            file_path: item.file_path.clone(),
        }
    }
}
impl Metadata {
    fn hash(&self) -> String {
        format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(self).expect("metadata serializes"))
        )
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Label {
    tag: String,
    verdict: String,
    reason: String,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ItemTags {
    status: String,
    #[serde(default)]
    tags: Vec<Tag>,
    #[serde(default)]
    labels: HashMap<String, Label>,
    error: Option<String>,
    model: Option<String>,
    provider: Option<String>,
    updated_at: Option<i64>,
    uncertainty: Option<String>,
    cost_usd: Option<f64>,
    metadata_hash: String,
    run_id: Option<String>,
    phase: Option<String>,
}
#[derive(Serialize)]
struct Snapshot {
    enabled: bool,
    items: HashMap<String, ItemTags>,
}

struct Inner {
    pool: Pool,
    library: Arc<RwLock<Library>>,
    client: reqwest::Client,
    key: Option<String>,
    endpoint: String,
    engine_mode: tagging_engine::Mode,
    wake: Notify,
    started: AtomicBool,
}
#[derive(Clone)]
pub struct Tagging(Arc<Inner>);
fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}
fn internal(error: anyhow::Error) -> ApiError {
    tracing::warn!(error = %error, "Tagging operation failed");
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        "Could not save or load tags".into(),
    )
}

impl Tagging {
    pub fn new(pool: Pool, library: Arc<RwLock<Library>>) -> Result<Self> {
        let conn = pool.get()?;
        // Research has no model charge. Resume it after restart, but never resend
        // a request with a recorded in-flight member (including completed-but-unpublished calls).
        conn.execute("UPDATE tagging_items SET Status='queued' WHERE Status='running' AND NOT EXISTS (SELECT 1 FROM tagging_run_items m WHERE m.ItemId=tagging_items.ItemId AND m.MetadataHash=tagging_items.MetadataHash AND m.Status='running') AND NOT EXISTS (SELECT 1 FROM tagging_runs r WHERE r.ItemId=tagging_items.ItemId AND r.MetadataHash=tagging_items.MetadataHash AND r.FinishedAt IS NULL)", [])?;
        conn.execute(
            "UPDATE tagging_items SET Status='failed' WHERE Status='running'",
            [],
        )?;
        conn.execute("UPDATE tagging_runs SET FinishedAt=?1, Error='Interrupted; billing may have occurred. Explicit retry required.' WHERE FinishedAt IS NULL", [now()])?;
        conn.execute("UPDATE tagging_run_items SET Status='failed', Error='Interrupted; explicit retry required' WHERE Status='running'", [])?;
        drop(conn);
        let key = std::env::var("OPENROUTER_API_KEY")
            .ok()
            .or_else(|| option_env!("OPENROUTER_API_KEY").map(str::to_string))
            .filter(|s| !s.trim().is_empty());
        Ok(Self(Arc::new(Inner {
            pool,
            library,
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(240))
                .build()?,
            key,
            engine_mode: tagging_engine::Mode::Agent,
            endpoint: "https://openrouter.ai/api/v1/chat/completions".into(),
            wake: Notify::new(),
            started: AtomicBool::new(false),
        })))
    }

    pub fn start_worker(&self) {
        if self.0.key.is_none() || self.0.started.swap(true, Ordering::SeqCst) {
            return;
        }
        let sweep = self.clone();
        tokio::spawn(async move {
            loop {
                match sweep.enqueue_missing().await {
                    Ok(queued) if queued > 0 => tracing::info!(
                        queued,
                        "Automatically queued missing or changed library tags"
                    ),
                    Ok(_) => {}
                    Err(error) => {
                        tracing::warn!(%error, "Could not sweep library for missing tags")
                    }
                }
                // Avoid synchronized hourly bursts. Import/edit hooks still enqueue immediately.
                tokio::time::sleep(Duration::from_secs(55 * 60 + rand::random::<u64>() % 601))
                    .await;
            }
        });
        let this = self.clone();
        tokio::spawn(async move {
            loop {
                loop {
                    // Give a burst of imports/queue requests time to coalesce.
                    tokio::time::sleep(Duration::from_millis(750)).await;
                    let jobs = match this.next_batch() {
                        Ok(jobs) if jobs.is_empty() => break,
                        Ok(jobs) => jobs,
                        Err(error) => {
                            tracing::warn!(error = %error, "Could not read tagging queue");
                            break;
                        }
                    };
                    if let Err(error) = this.classify_jobs(&jobs).await {
                        tracing::warn!(error = %error, "Tagging batch failed");
                        for (id, hash) in jobs {
                            if let Err(save_error) = this.fail(id, &hash, &error.to_string()) {
                                tracing::warn!(error = %save_error, "Could not persist tagging failure");
                            }
                        }
                    }
                }
                tokio::select! { _ = this.0.wake.notified() => {}, _ = tokio::time::sleep(Duration::from_secs(10)) => {} }
            }
        });
    }

    pub async fn enqueue_changed(&self, id: Uuid) -> Result<()> {
        if self.0.key.is_some() {
            self.enqueue(id, false).await?;
        }
        Ok(())
    }

    async fn enqueue_missing(&self) -> Result<usize> {
        if self.0.key.is_none() {
            return Ok(0);
        }
        let candidates = {
            let library = self.0.library.read().await;
            let conn = self.0.pool.get()?;
            let mut statement = conn.prepare("SELECT ItemId, MetadataHash FROM tagging_items")?;
            let prior = statement
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })?
                .collect::<rusqlite::Result<HashMap<_, _>>>()?;
            let mut statement = conn.prepare("SELECT ItemId FROM tagging_labels WHERE json_extract(Serialized, '$.verdict')='accepted'")?;
            let manually_tagged = statement
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<HashSet<_>>>()?;
            let mut items: Vec<_> = library
                .items
                .values()
                .filter(|item| {
                    let id = item.id.to_string();
                    match prior.get(&id) {
                        // A completed abstention or unchanged failure is still a completed attempt.
                        // Never turn the sweep into recurring paid retries or undo human removals.
                        Some(hash) => *hash != Metadata::from(*item).hash(),
                        None => !manually_tagged.contains(&id),
                    }
                })
                .collect();
            items.sort_by(|a, b| {
                b.created_time_utc
                    .cmp(&a.created_time_utc)
                    .then(a.id.cmp(&b.id))
            });
            items.into_iter().map(|item| item.id).collect::<Vec<_>>()
        };
        let mut queued = 0;
        for id in candidates {
            // Recheck current metadata and queue state under enqueue's transaction. An import,
            // edit or manual queue request may have arrived while the sweep was running.
            match self.enqueue(id, false).await {
                Ok(true) => queued += 1,
                Ok(false) => {}
                Err(error) => {
                    tracing::warn!(%id, %error, "Could not automatically queue track tags")
                }
            }
        }
        Ok(queued)
    }

    async fn enqueue(&self, id: Uuid, force: bool) -> Result<bool> {
        let library = self.0.library.read().await;
        let item = library.items.get(&id).context("Item no longer exists")?;
        let hash = Metadata::from(item).hash();
        let mut conn = self.0.pool.get()?;
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let prior: Option<(String, String)> = tx
            .query_row(
                "SELECT MetadataHash, Status FROM tagging_items WHERE ItemId=?1",
                [id.to_string()],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        if let Some((old_hash, status)) = prior {
            if old_hash == hash && (matches!(status.as_str(), "queued" | "running") || !force) {
                return Ok(false);
            }
        }
        let data = ItemTags {
            status: "queued".into(),
            metadata_hash: hash.clone(),
            updated_at: Some(now()),
            ..Default::default()
        };
        tx.execute("INSERT INTO tagging_items (ItemId,MetadataHash,Status,Serialized,UpdatedAt) VALUES (?1,?2,'queued',?3,?4) ON CONFLICT(ItemId) DO UPDATE SET MetadataHash=excluded.MetadataHash,Status='queued',Serialized=excluded.Serialized,UpdatedAt=excluded.UpdatedAt", params![id.to_string(), hash, serde_json::to_string(&data)?, now()])?;
        tx.commit()?;
        self.0.wake.notify_one();
        Ok(true)
    }

    fn next_batch(&self) -> Result<Vec<(Uuid, String)>> {
        let mut conn = self.0.pool.get()?;
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let jobs: Vec<(String, String)> = {
            let mut statement = tx.prepare("SELECT ItemId,MetadataHash FROM tagging_items WHERE Status='queued' ORDER BY UpdatedAt,ItemId LIMIT ?1")?;
            let rows = statement
                .query_map([MAX_BATCH_ITEMS], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<rusqlite::Result<_>>()?;
            rows
        };
        let jobs: Vec<_> = jobs
            .into_iter()
            .map(|(id, hash)| Ok((Uuid::parse_str(&id)?, hash)))
            .collect::<Result<_>>()?;
        for (id, _) in &jobs {
            tx.execute(
                "UPDATE tagging_items SET Status='running' WHERE ItemId=?1 AND Status='queued'",
                [id.to_string()],
            )?;
        }
        tx.commit()?;
        Ok(jobs)
    }

    fn fail(&self, id: Uuid, hash: &str, error: &str) -> Result<()> {
        let data = ItemTags {
            status: "failed".into(),
            error: Some(error.chars().take(500).collect()),
            metadata_hash: hash.into(),
            updated_at: Some(now()),
            ..Default::default()
        };
        self.0.pool.get()?.execute("UPDATE tagging_items SET Status='failed',Serialized=?3,UpdatedAt=?4 WHERE ItemId=?1 AND MetadataHash=?2 AND Status='running'", params![id.to_string(), hash, serde_json::to_string(&data)?, now()])?;
        Ok(())
    }

    fn set_phase(&self, id: Uuid, hash: &str, phase: &str) -> Result<()> {
        let mut conn = self.0.pool.get()?;
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let serialized: Option<String> = tx.query_row("SELECT Serialized FROM tagging_items WHERE ItemId=?1 AND MetadataHash=?2 AND Status='running'", params![id.to_string(), hash], |r| r.get(0)).optional()?;
        if let Some(serialized) = serialized {
            let mut data: ItemTags = serde_json::from_str(&serialized)?;
            data.phase = Some(phase.into());
            tx.execute("UPDATE tagging_items SET Serialized=?3 WHERE ItemId=?1 AND MetadataHash=?2 AND Status='running'", params![id.to_string(),hash,serde_json::to_string(&data)?])?;
        }
        tx.commit()?;
        Ok(())
    }

    async fn classify_jobs(&self, jobs: &[(Uuid, String)]) -> Result<()> {
        let mut prepared = Vec::new();
        for (id, hash) in jobs {
            let metadata = {
                let library = self.0.library.read().await;
                library
                    .items
                    .get(id)
                    .map(Metadata::from)
                    .filter(|m| m.hash() == *hash)
            };
            let Some(metadata) = metadata else {
                self.fail(*id, hash, "Metadata changed before evidence collection")?;
                continue;
            };
            self.set_phase(*id, hash, "researching")?;
            match evidence::collect(
                &self.0.pool,
                &self.0.client,
                &metadata.name,
                &metadata.artist,
                &metadata.album,
            )
            .await
            {
                Ok(evidence) => {
                    self.set_phase(*id, hash, "prepared")?;
                    prepared.push(PreparedItem {
                        id: *id,
                        hash: hash.clone(),
                        metadata,
                        evidence,
                    });
                }
                Err(error) => self.fail(*id, hash, &error.to_string())?,
            }
        }
        self.classify_prepared(prepared).await
    }

    async fn classify_prepared(&self, prepared: Vec<PreparedItem>) -> Result<()> {
        // Split on the evaluated request byte budget, never silently truncate evidence.
        let mut batches: Vec<Vec<PreparedItem>> = Vec::new();
        let mut batch = Vec::new();
        for item in prepared {
            batch.push(item);
            if build_request(&batch).is_err() {
                let item = batch.pop().unwrap();
                if !batch.is_empty() {
                    batches.push(std::mem::take(&mut batch));
                }
                match build_request(std::slice::from_ref(&item)) {
                    Ok(_) => batch.push(item),
                    Err(error) => self.fail(item.id, &item.hash, &error.to_string())?,
                }
            }
        }
        if !batch.is_empty() {
            batches.push(batch);
        }
        for batch in batches {
            if let Err(error) = self.classify_batch(&batch).await {
                for item in &batch {
                    self.fail(item.id, &item.hash, &error.to_string())?;
                }
                tracing::warn!(error = %error, items = batch.len(), "Tagging request failed; explicit retry required");
            }
        }
        Ok(())
    }

    async fn classify_batch(&self, prepared: &[PreparedItem]) -> Result<()> {
        // Evidence collection can take a while. Exclude changed/deleted items before paying.
        let mut items = Vec::new();
        {
            let library = self.0.library.read().await;
            for item in prepared {
                if library
                    .items
                    .get(&item.id)
                    .is_some_and(|current| Metadata::from(current).hash() == item.hash)
                {
                    items.push(item.clone());
                } else {
                    self.fail(
                        item.id,
                        &item.hash,
                        "Metadata changed during evidence collection",
                    )?;
                }
            }
        }
        if items.is_empty() {
            return Ok(());
        }
        // A session has several HTTP requests. Store its manifest here; exact
        // requests (including tools) are journaled by the engine before sending.
        let request = json!({"engine":tagging_engine::VERSION,"revision":tagging_engine::REVISION,
            "config":tagging_engine::Config {mode:self.0.engine_mode,..Default::default()}});
        // Save before sending. A timeout/crash never triggers an automatic paid retry.
        let run = Uuid::new_v4().to_string();
        {
            let mut conn = self.0.pool.get()?;
            let tx = conn.transaction()?;
            let first = &items[0];
            let evidence: Vec<_> = items.iter().map(|item| &item.evidence).collect();
            tx.execute("INSERT INTO tagging_runs (Id,ItemId,MetadataHash,StartedAt,Request,Evidence) VALUES (?1,?2,?3,?4,?5,?6)", params![run,first.id.to_string(),first.hash,now(),serde_json::to_string(&request)?,serde_json::to_string(&evidence)?])?;
            for (index, item) in items.iter().enumerate() {
                tx.execute("INSERT INTO tagging_run_items (RunId,RequestItemId,ItemId,MetadataHash,Status) VALUES (?1,?2,?3,?4,'running')", params![run,format!("t{:02}", index+1),item.id.to_string(),item.hash])?;
            }
            tx.commit()?;
        }
        for item in &items {
            self.set_phase(item.id, &item.hash, "classifying")?;
        }
        let inputs = engine_inputs(&items);
        let mut model = tagging_engine::HttpModel {
            client: self.0.client.clone(),
            endpoint: self.0.endpoint.clone(),
            key: self
                .0
                .key
                .clone()
                .context("OPENROUTER_API_KEY is not configured")?,
        };
        let mut mb = tagging_engine::evidence::Cache::new(&self.0.pool, &self.0.client)?;
        let mut sequence = 0;
        let config = tagging_engine::Config {
            mode: self.0.engine_mode,
            ..Default::default()
        };
        let outcome = tagging_engine::run(&inputs, config, &mut model, &mut mb, |event| {
            self.0.pool.get()?.execute(
                "INSERT INTO tagging_agent_events (RunId,Sequence,CreatedAt,Serialized) VALUES (?1,?2,?3,?4)",
                params![run, sequence, now(), serde_json::to_string(&event)?],
            )?;
            sequence += 1;
            Ok(())
        }).await;
        let report = match outcome {
            Ok(report) => report,
            Err(error) => {
                self.finish_run(&run, None, Some(&error.to_string()), None)?;
                return Err(error);
            }
        };
        let cost = if report.missing_cost_records == 0 {
            Some(report.reported_cost_usd)
        } else {
            None
        };
        self.finish_run(
            &run,
            Some(&serde_json::to_value(&report)?),
            report.error.as_deref(),
            cost,
        )?;
        if let Some(error) = report.error {
            bail!("{error}");
        }
        let predictions = report
            .predictions
            .context("Agent returned no predictions")?;
        for (item, prediction) in items.iter().zip(predictions) {
            let item_tags = ItemTags {
                status: "ready".into(),
                tags: prediction.tags,
                uncertainty: Some(prediction.uncertainty),
                model: Some(MODEL.into()),
                provider: Some("z-ai".into()),
                updated_at: Some(now()),
                // A batch's cost cannot honestly be attributed to an individual track.
                cost_usd: if items.len() == 1 { cost } else { None },
                metadata_hash: item.hash.clone(),
                run_id: Some(run.clone()),
                ..Default::default()
            };
            let published = self.publish(item.id, &item.hash, &item_tags).await?;
            self.0.pool.get()?.execute(
                "UPDATE tagging_run_items SET Status=?3,Error=?4 WHERE RunId=?1 AND ItemId=?2",
                params![
                    run,
                    item.id.to_string(),
                    if published { "ready" } else { "discarded" },
                    if published {
                        None
                    } else {
                        Some("Metadata changed or item deleted")
                    }
                ],
            )?;
            if !published {
                self.fail(
                    item.id,
                    &item.hash,
                    "Result discarded: metadata changed or item deleted",
                )?;
            }
        }
        Ok(())
    }

    fn finish_run(
        &self,
        run: &str,
        raw: Option<&Value>,
        error: Option<&str>,
        cost: Option<f64>,
    ) -> Result<()> {
        self.0.pool.get()?.execute("UPDATE tagging_runs SET FinishedAt=?2, Response=COALESCE(?3,Response), Error=?4, CostUsd=?5 WHERE Id=?1", params![run,now(),raw.map(serde_json::to_string).transpose()?,error,cost])?;
        if let Some(error) = error {
            self.0.pool.get()?.execute("UPDATE tagging_run_items SET Status='failed',Error=?2 WHERE RunId=?1 AND Status='running'", params![run,error])?;
        }
        Ok(())
    }

    async fn publish(&self, id: Uuid, hash: &str, tags: &ItemTags) -> Result<bool> {
        let library = self.0.library.read().await;
        if library
            .items
            .get(&id)
            .is_none_or(|item| Metadata::from(item).hash() != hash)
        {
            return Ok(false);
        }
        Ok(self.0.pool.get()?.execute("UPDATE tagging_items SET Status='ready',Serialized=?3,UpdatedAt=?4 WHERE ItemId=?1 AND MetadataHash=?2 AND Status='running'", params![id.to_string(),hash,serde_json::to_string(tags)?,now()])? == 1)
    }

    async fn snapshot(&self) -> Result<Snapshot> {
        let library = self.0.library.read().await;
        let conn = self.0.pool.get()?;
        let mut items = HashMap::new();
        let mut statement =
            conn.prepare("SELECT ItemId, MetadataHash, Status, Serialized FROM tagging_items")?;
        for row in statement.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
            ))
        })? {
            let (id, hash, status, serialized) = row?;
            let Some(item) = Uuid::parse_str(&id)
                .ok()
                .and_then(|uuid| library.items.get(&uuid))
            else {
                continue;
            };
            let mut data: ItemTags = serde_json::from_str(&serialized)?;
            data.status = status;
            if Metadata::from(item).hash() != hash {
                data.status = "stale".into();
                data.tags.clear();
            }
            if data.status == "failed" && data.error.is_none() {
                data.error =
                    Some("Interrupted; explicit retry required. Billing may have occurred.".into());
            }
            items.insert(id, data);
        }
        let mut statement = conn.prepare("SELECT ItemId,Serialized FROM tagging_labels")?;
        for row in
            statement.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
        {
            let (id, serialized) = row?;
            let Some(item) = Uuid::parse_str(&id)
                .ok()
                .and_then(|uuid| library.items.get(&uuid))
            else {
                continue;
            };
            let label: Label = serde_json::from_str(&serialized)?;
            items
                .entry(id)
                .or_insert_with(|| ItemTags {
                    status: "stale".into(),
                    metadata_hash: Metadata::from(item).hash(),
                    ..Default::default()
                })
                .labels
                .insert(label.tag.clone(), label);
        }
        Ok(Snapshot {
            enabled: self.0.key.is_some(),
            items,
        })
    }

    async fn save_label(&self, id: Uuid, mut label: Label) -> Result<()> {
        let library = self.0.library.read().await;
        if !library.items.contains_key(&id) {
            bail!("Item no longer exists");
        }
        label.tag = normalize_tag(&label.tag)?;
        if !matches!(
            label.verdict.as_str(),
            "accepted" | "rejected" | "uncertain"
        ) || label.reason.len() > 2000
        {
            bail!("Invalid label or reason longer than 2000 bytes");
        }
        self.0.pool.get()?.execute("INSERT INTO tagging_labels (ItemId,Tag,Serialized) VALUES (?1,?2,?3) ON CONFLICT(ItemId,Tag) DO UPDATE SET Serialized=excluded.Serialized", params![id.to_string(),label.tag,serde_json::to_string(&label)?])?;
        Ok(())
    }
}

fn engine_inputs(items: &[PreparedItem]) -> Vec<tagging_engine::Input> {
    items
        .iter()
        .enumerate()
        .map(|(index, item)| tagging_engine::Input {
            id: format!("t{:02}", index + 1),
            name: item.metadata.name.clone(),
            artist: item.metadata.artist.clone(),
            album: item.metadata.album.clone(),
            musicbrainz: item.evidence.clone(),
        })
        .collect()
}
use tagging_engine::baseline::normalize_tag;
fn build_request(items: &[PreparedItem]) -> Result<Value> {
    tagging_engine::baseline::build_request(&engine_inputs(items))
}
#[cfg(test)]
fn parse_predictions(raw: &Value, items: &[PreparedItem]) -> Result<Vec<Prediction>> {
    tagging_engine::baseline::parse_predictions(raw, &engine_inputs(items))
}

pub fn router<S: Clone + Send + Sync + 'static>(tagging: Tagging) -> Router<S> {
    Router::new()
        .route("/tags", get(snapshot))
        .route("/tags/queue", post(queue))
        .route("/tags/items/{id}/classify", post(classify))
        .route("/tags/items/{id}/labels", put(save_label))
        .route(
            "/tags/items/{id}/labels/{tag}",
            axum::routing::delete(delete_label),
        )
        .with_state(tagging)
}
async fn snapshot(State(tagging): State<Tagging>) -> Result<Json<Snapshot>, ApiError> {
    tagging.snapshot().await.map(Json).map_err(internal)
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct QueueRequest {
    item_ids: Vec<Uuid>,
}

async fn queue(
    State(tagging): State<Tagging>,
    request: Option<Json<QueueRequest>>,
) -> Result<Json<Value>, ApiError> {
    if tagging.0.key.is_none() {
        return Err((
            StatusCode::SERVICE_UNAVAILABLE,
            "OPENROUTER_API_KEY is not configured".into(),
        ));
    }
    let ids = {
        let library = tagging.0.library.read().await;
        if let Some(Json(request)) = request {
            if request.item_ids.len() > 20
                || request
                    .item_ids
                    .iter()
                    .any(|id| !library.items.contains_key(id))
            {
                return Err((
                    StatusCode::BAD_REQUEST,
                    "Choose at most 20 existing tracks".into(),
                ));
            }
            request.item_ids
        } else {
            let mut items: Vec<_> = library.items.values().collect();
            items.sort_by(|a, b| {
                b.created_time_utc
                    .cmp(&a.created_time_utc)
                    .then(a.id.cmp(&b.id))
            });
            items.into_iter().map(|item| item.id).collect()
        }
    };
    let mut queued = Vec::new();
    for id in ids {
        if tagging.enqueue(id, false).await.map_err(internal)? {
            queued.push(id);
        }
        if queued.len() == 20 {
            break;
        }
    }
    Ok(Json(json!({"queued":queued.len(),"itemIds":queued})))
}
async fn classify(
    State(tagging): State<Tagging>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    if tagging.0.key.is_none() {
        return Err((
            StatusCode::SERVICE_UNAVAILABLE,
            "OPENROUTER_API_KEY is not configured".into(),
        ));
    }
    if !tagging.0.library.read().await.items.contains_key(&id) {
        return Err((StatusCode::NOT_FOUND, "Item not found".into()));
    }
    Ok(Json(
        json!({"queued":tagging.enqueue(id,true).await.map_err(internal)?}),
    ))
}
async fn save_label(
    State(tagging): State<Tagging>,
    Path(id): Path<Uuid>,
    Json(label): Json<Label>,
) -> Result<StatusCode, ApiError> {
    if !tagging.0.library.read().await.items.contains_key(&id) {
        return Err((StatusCode::NOT_FOUND, "Item not found".into()));
    }
    normalize_tag(&label.tag).map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;
    if label.reason.len() > 2000
        || !matches!(
            label.verdict.as_str(),
            "accepted" | "rejected" | "uncertain"
        )
    {
        return Err((
            StatusCode::BAD_REQUEST,
            "Invalid verdict or reason exceeds 2000 bytes".into(),
        ));
    }
    tagging.save_label(id, label).await.map_err(internal)?;
    Ok(StatusCode::NO_CONTENT)
}
async fn delete_label(
    State(tagging): State<Tagging>,
    Path((id, tag)): Path<(Uuid, String)>,
) -> Result<StatusCode, ApiError> {
    let tag = normalize_tag(&tag).map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;
    tagging
        .0
        .pool
        .get()
        .map_err(|e| internal(e.into()))?
        .execute(
            "DELETE FROM tagging_labels WHERE ItemId=?1 AND Tag=?2",
            params![id.to_string(), tag],
        )
        .map_err(|e| internal(e.into()))?;
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn evaluated_request_and_response_replay_through_production_contract() {
        let fixture: Value =
            serde_json::from_str(include_str!("../test-fixtures/tagging-evaluated.json")).unwrap();
        let expected = &fixture["request"];
        let input: Vec<Value> =
            serde_json::from_str(expected["messages"][1]["content"].as_str().unwrap()).unwrap();
        let items: Vec<_> = input
            .iter()
            .map(|value| {
                let metadata = Metadata {
                    name: value["name"].as_str().unwrap().into(),
                    artist: value["artist"].as_str().unwrap().into(),
                    album: value["album"].as_str().unwrap().into(),
                    file_path: "private/file.mp3".into(),
                };
                PreparedItem {
                    id: Uuid::new_v4(),
                    hash: metadata.hash(),
                    metadata,
                    evidence: value["musicbrainz"].clone(),
                }
            })
            .collect();
        assert_eq!(
            MAX_BATCH_ITEMS,
            CONTRACT["max_batch_items"].as_u64().unwrap() as usize
        );
        let mut actual = build_request(&items).unwrap();
        // JSON key order/whitespace in the input are immaterial; the system prompt
        // and every inference setting must match the saved evaluated request exactly.
        assert_eq!(
            serde_json::from_str::<Value>(actual["messages"][1]["content"].as_str().unwrap())
                .unwrap(),
            json!(input)
        );
        actual["messages"][1]["content"] = expected["messages"][1]["content"].clone();
        assert_eq!(&actual, expected);
        assert_eq!(
            parse_predictions(&fixture["response"], &items)
                .unwrap()
                .len(),
            20
        );
        let mut raw = fixture["response"].clone();
        let content = raw["choices"][0]["message"]["content"].as_str().unwrap();
        let mut parsed: Value = serde_json::Deserializer::from_str(content)
            .into_iter::<Value>()
            .next()
            .unwrap()
            .unwrap();
        parsed["items"].as_array_mut().unwrap().reverse();
        raw["choices"][0]["message"]["content"] = json!(parsed.to_string());
        assert_eq!(parse_predictions(&raw, &items).unwrap()[0].id, "t01");
        parsed["items"][0]["id"] = json!("invented");
        raw["choices"][0]["message"]["content"] = json!(parsed.to_string());
        assert!(parse_predictions(&raw, &items).is_err());
        parsed["items"][0]["id"] = parsed["items"][1]["id"].clone();
        raw["choices"][0]["message"]["content"] = json!(parsed.to_string());
        assert!(parse_predictions(&raw, &items).is_err());
        parsed["items"].as_array_mut().unwrap().pop();
        raw["choices"][0]["message"]["content"] = json!(parsed.to_string());
        assert!(parse_predictions(&raw, &items).is_err());
    }

    async fn prepared_jobs(tagging: &Tagging) -> Vec<PreparedItem> {
        tagging
            .next_batch()
            .unwrap()
            .into_iter()
            .map(|(id, hash)| {
                let library = tagging.0.library.try_read().unwrap();
                PreparedItem {
                    id,
                    hash,
                    metadata: Metadata::from(&library.items[&id]),
                    evidence: json!({"sources":[]}),
                }
            })
            .collect()
    }

    #[test]
    fn singleton_pilot_responses_replay_without_rebilling() {
        let fixtures: Vec<Value> =
            serde_json::from_str(include_str!("../test-fixtures/tagging-singletons.json")).unwrap();
        assert_eq!(fixtures.len(), 3);
        for fixture in fixtures {
            let input: Vec<Value> = serde_json::from_str(
                fixture["request"]["messages"][1]["content"]
                    .as_str()
                    .unwrap(),
            )
            .unwrap();
            let value = &input[0];
            let metadata = Metadata {
                name: value["name"].as_str().unwrap().into(),
                artist: value["artist"].as_str().unwrap().into(),
                album: value["album"].as_str().unwrap().into(),
                file_path: "private/file.mp3".into(),
            };
            let items = [PreparedItem {
                id: Uuid::new_v4(),
                hash: metadata.hash(),
                metadata,
                evidence: value["musicbrainz"].clone(),
            }];
            assert_eq!(build_request(&items).unwrap(), fixture["request"]);
            assert_eq!(
                parse_predictions(&fixture["response"], &items)
                    .unwrap()
                    .len(),
                1
            );
        }
    }

    #[tokio::test]
    async fn request_budget_splits_batches_and_does_not_send_an_oversized_item() {
        let (_directory, mut tagging, id) = fixture();
        let template = tagging.0.library.read().await.items[&id].clone();
        for _ in 0..3 {
            let mut item = template.clone();
            item.id = Uuid::new_v4();
            tagging.0.library.write().await.items.insert(item.id, item);
        }
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        Arc::get_mut(&mut tagging.0).unwrap().endpoint =
            format!("http://{}", listener.local_addr().unwrap());
        Arc::get_mut(&mut tagging.0).unwrap().key = Some("local-test-key".into());
        Arc::get_mut(&mut tagging.0).unwrap().engine_mode = tagging_engine::Mode::Fixed;
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let captured = calls.clone();
        let server = tokio::spawn(async move {
            axum::serve(listener, Router::new().route("/", post(move |Json(request): Json<Value>| {
                captured.fetch_add(1, Ordering::SeqCst);
                async move {
                    let input: Vec<Value> = serde_json::from_str(request["messages"][1]["content"].as_str().unwrap()).unwrap();
                    assert_eq!(input.len(), 1);
                    Json(json!({"choices":[{"finish_reason":"stop","message":{"content":json!({"items":[{"id":"t01","tags":[],"uncertainty":"Unknown"}]}).to_string()}}]}))
                }
            }))).await.unwrap();
        });
        let ids: Vec<_> = tagging
            .0
            .library
            .read()
            .await
            .items
            .keys()
            .copied()
            .collect();
        for id in ids {
            tagging.enqueue(id, false).await.unwrap();
        }
        let mut jobs = prepared_jobs(&tagging).await;
        for (index, job) in jobs.iter_mut().enumerate() {
            job.evidence["description"] = json!("x".repeat(if index == 3 { 60000 } else { 30000 }));
        }
        tagging.classify_prepared(jobs).await.unwrap();
        server.abort();
        assert_eq!(calls.load(Ordering::SeqCst), 3);
        let snapshot = tagging.snapshot().await.unwrap();
        assert_eq!(
            snapshot
                .items
                .values()
                .filter(|item| item.status == "ready")
                .count(),
            3
        );
        assert_eq!(
            snapshot
                .items
                .values()
                .filter(|item| item.status == "failed")
                .count(),
            1
        );
    }

    #[tokio::test]
    async fn one_http_call_serves_twenty_jobs_maps_reordered_ids_and_preserves_edits() {
        let (_directory, mut tagging, id) = fixture();
        let template = tagging.0.library.read().await.items[&id].clone();
        for index in 1..=20 {
            let mut item = template.clone();
            item.id = Uuid::new_v4();
            item.name = format!("Song {index}");
            tagging.0.library.write().await.items.insert(item.id, item);
        }
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        Arc::get_mut(&mut tagging.0).unwrap().endpoint =
            format!("http://{}", listener.local_addr().unwrap());
        Arc::get_mut(&mut tagging.0).unwrap().key = Some("local-test-key".into());
        Arc::get_mut(&mut tagging.0).unwrap().engine_mode = tagging_engine::Mode::Fixed;
        let ids: Vec<_> = tagging
            .0
            .library
            .read()
            .await
            .items
            .keys()
            .copied()
            .collect();
        for id in ids {
            tagging.enqueue(id, false).await.unwrap();
        }
        let jobs = prepared_jobs(&tagging).await;
        assert_eq!(jobs.len(), 20);
        let edited = jobs[0].id;
        let deleted = jobs[1].id;
        tagging
            .save_label(
                edited,
                Label {
                    tag: "folk".into(),
                    verdict: "rejected".into(),
                    reason: "Wrong recording".into(),
                },
            )
            .await
            .unwrap();
        let calls = Arc::new(std::sync::Mutex::new(Vec::<Value>::new()));
        let captured = calls.clone();
        let during_call = tagging.clone();
        let server = tokio::spawn(async move {
            axum::serve(listener, Router::new().route("/", post(move |Json(request): Json<Value>| {
                let captured = captured.clone(); let tagging = during_call.clone();
                async move {
                    captured.lock().unwrap().push(request.clone());
                    let metadata: Vec<Value> = serde_json::from_str(request["messages"][1]["content"].as_str().unwrap()).unwrap();
                    tagging.0.library.write().await.items.get_mut(&edited).unwrap().name = "Edited while running".into();
                    tagging.enqueue(edited, false).await.unwrap();
                    tagging.0.library.write().await.items.remove(&deleted);
                    let predictions: Vec<_> = metadata.iter().rev().map(|item| json!({"id":item["id"],"tags":[],"uncertainty":item["name"]})).collect();
                    Json(json!({"choices":[{"finish_reason":"stop","message":{"content":json!({"items":predictions}).to_string()}}],"usage":{"cost":0.003}}))
                }
            }))).await.unwrap();
        });
        tagging.classify_prepared(jobs.clone()).await.unwrap();
        server.abort();
        assert_eq!(calls.lock().unwrap().len(), 1);
        let snapshot = tagging.snapshot().await.unwrap();
        assert_eq!(snapshot.items[&edited.to_string()].status, "queued");
        assert_eq!(
            snapshot.items[&edited.to_string()].labels["folk"].reason,
            "Wrong recording"
        );
        assert!(!snapshot.items.contains_key(&deleted.to_string()));
        for job in &jobs[2..] {
            let result = &snapshot.items[&job.id.to_string()];
            assert_eq!(result.status, "ready");
            assert_eq!(
                result.uncertainty.as_deref(),
                Some(job.metadata.name.as_str())
            );
            assert!(result.cost_usd.is_none());
            assert!(result.run_id.is_some());
        }
        let conn = tagging.0.pool.get().unwrap();
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM tagging_runs", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            conn.query_row("SELECT SUM(CostUsd) FROM tagging_runs", [], |r| r
                .get::<_, f64>(0))
                .unwrap(),
            0.003
        );
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM tagging_run_items WHERE Status='discarded'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            2
        );
        assert_eq!(tagging.next_batch().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn malformed_batch_exhausts_recovery_then_fails_members() {
        let (_directory, mut tagging, id) = fixture();
        let mut second = tagging.0.library.read().await.items[&id].clone();
        second.id = Uuid::new_v4();
        let second_id = second.id;
        tagging
            .0
            .library
            .write()
            .await
            .items
            .insert(second_id, second);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        Arc::get_mut(&mut tagging.0).unwrap().endpoint =
            format!("http://{}", listener.local_addr().unwrap());
        Arc::get_mut(&mut tagging.0).unwrap().key = Some("local-test-key".into());
        Arc::get_mut(&mut tagging.0).unwrap().engine_mode = tagging_engine::Mode::Fixed;
        let server = tokio::spawn(async move {
            axum::serve(listener, Router::new().route("/", post(|| async {
                Json(json!({"choices":[{"finish_reason":"length","message":{"content":"{\"items\":["}}],"usage":{"cost":0.001}}))
            }))).await.unwrap();
        });
        tagging.enqueue(id, false).await.unwrap();
        tagging.enqueue(second_id, false).await.unwrap();
        let jobs = prepared_jobs(&tagging).await;
        tagging.classify_prepared(jobs).await.unwrap();
        server.abort();
        for item in tagging.snapshot().await.unwrap().items.values() {
            assert_eq!(item.status, "failed");
        }
        assert!(tagging.next_batch().unwrap().is_empty());
        assert!(!tagging.enqueue(id, false).await.unwrap());
        let conn = tagging.0.pool.get().unwrap();
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM tagging_run_items WHERE Status='failed'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            2
        );
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM tagging_runs WHERE Error IS NOT NULL AND CostUsd=0.003",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
    }

    #[tokio::test]
    async fn invalid_completion_recovers_once_but_http_errors_do_not_retry() {
        for http_error in [false, true] {
            let (_directory, mut tagging, id) = fixture();
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            Arc::get_mut(&mut tagging.0).unwrap().endpoint =
                format!("http://{}", listener.local_addr().unwrap());
            Arc::get_mut(&mut tagging.0).unwrap().key = Some("local-test-key".into());
            Arc::get_mut(&mut tagging.0).unwrap().engine_mode = tagging_engine::Mode::Fixed;
            let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let captured = calls.clone();
            let server = tokio::spawn(async move {
                axum::serve(listener, Router::new().route("/", post(move || {
                    let attempt = captured.fetch_add(1, Ordering::SeqCst);
                    async move {
                        if http_error {
                            return (StatusCode::SERVICE_UNAVAILABLE, Json(json!({"error":"unavailable"})));
                        }
                        let content = if attempt == 0 {
                            // Mirrors the production response with an extra note and
                            // a second answer. Neither should be silently salvaged.
                            r#"{"items":[{"id":"t01","tags":[],"uncertainty":"Unknown","note":"Extra"}]} Correction: {"items":[]}"#.to_string()
                        } else {
                            json!({"items":[{"id":"t01","tags":[],"uncertainty":"Unknown"}]}).to_string()
                        };
                        (StatusCode::OK, Json(json!({"choices":[{"finish_reason":"stop","message":{"content":content}}],"usage":{"cost":0.001}})))
                    }
                }))).await.unwrap();
            });
            tagging
                .save_label(
                    id,
                    Label {
                        tag: "folk".into(),
                        verdict: "rejected".into(),
                        reason: "Wrong recording".into(),
                    },
                )
                .await
                .unwrap();
            tagging.enqueue(id, false).await.unwrap();
            tagging
                .classify_prepared(prepared_jobs(&tagging).await)
                .await
                .unwrap();
            server.abort();
            assert_eq!(calls.load(Ordering::SeqCst), if http_error { 1 } else { 2 });
            let snapshot = tagging.snapshot().await.unwrap();
            let item = &snapshot.items[&id.to_string()];
            assert_eq!(item.status, if http_error { "failed" } else { "ready" });
            assert_eq!(item.labels["folk"].reason, "Wrong recording");
            let conn = tagging.0.pool.get().unwrap();
            assert_eq!(
                conn.query_row(
                    "SELECT COUNT(*) FROM tagging_runs WHERE Error IS NOT NULL",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
                if http_error { 1 } else { 0 }
            );
            assert_eq!(
                conn.query_row(
                    "SELECT COALESCE(SUM(CostUsd),0) FROM tagging_runs",
                    [],
                    |r| r.get::<_, f64>(0)
                )
                .unwrap(),
                if http_error { 0.0 } else { 0.002 }
            );
        }
    }

    #[tokio::test]
    async fn production_adapter_uses_tools_and_persists_each_request_before_sending() {
        let (_directory, mut tagging, id) = fixture();
        assert_eq!(tagging.0.engine_mode, tagging_engine::Mode::Agent);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        Arc::get_mut(&mut tagging.0).unwrap().endpoint =
            format!("http://{}", listener.local_addr().unwrap());
        Arc::get_mut(&mut tagging.0).unwrap().key = Some("local-test-key".into());
        let artist = "0a326e5b-9332-4490-a37c-aa3692201401";
        tagging_engine::evidence::Cache::new(&tagging.0.pool, &tagging.0.client).unwrap();
        tagging.0.pool.get().unwrap().execute("INSERT INTO TaggingMusicBrainzCache VALUES (?1,0,?2)",params!["search:artist:artist:\"robbie basho\"",json!({"artists":[{"id":artist,"name":"Robbie Basho","tags":[{"name":"folk"}]}]}).to_string()]).unwrap();
        let pool = tagging.0.pool.clone();
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let captured = calls.clone();
        let server = tokio::spawn(async move {
            axum::serve(listener,Router::new().route("/",post(move |Json(request):Json<Value>| {
                let attempt=captured.fetch_add(1,Ordering::SeqCst);
                let pool=pool.clone();
                async move {
                    let requests:i64=pool.get().unwrap().query_row("SELECT count(*) FROM tagging_agent_events WHERE json_extract(Serialized,'$.event')='request'",[],|r|r.get(0)).unwrap();
                    assert_eq!(requests,attempt as i64+1);
                    assert!(request["tools"].is_array());
                    if attempt==0 {
                        Json(json!({"choices":[{"finish_reason":"tool_calls","message":{"role":"assistant","tool_calls":[{"id":"call1","type":"function","function":{"name":"search_artists","arguments":json!({"item_ids":["t01"],"name":"Robbie Basho"}).to_string()}}]}}],"usage":{"cost":0.001}}))
                    } else {
                        assert!(!request.to_string().contains(artist));
                        Json(json!({"choices":[{"finish_reason":"stop","message":{"content":json!({"items":[{"id":"t01","tags":[{"tag":"folk","basis":"database","confidence":0.8,"evidence":"Artist tag, not verified recording","sources":["s1"]}],"uncertainty":"Unverified","research":{"artist":"s1","recording":null}}]}).to_string()}}],"usage":{"cost":0.002}}))
                    }
                }
            }))).await.unwrap();
        });
        tagging
            .save_label(
                id,
                Label {
                    tag: "folk".into(),
                    verdict: "rejected".into(),
                    reason: "Keep my correction".into(),
                },
            )
            .await
            .unwrap();
        tagging.enqueue(id, false).await.unwrap();
        tagging
            .classify_prepared(prepared_jobs(&tagging).await)
            .await
            .unwrap();
        server.abort();
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        let snapshot = tagging.snapshot().await.unwrap();
        assert_eq!(snapshot.items[&id.to_string()].status, "ready");
        assert_eq!(
            snapshot.items[&id.to_string()].labels["folk"].reason,
            "Keep my correction"
        );
        assert_eq!(
            snapshot.items[&id.to_string()].tags[0].source_urls,
            vec![format!("https://musicbrainz.org/artist/{artist}")]
        );
        let conn = tagging.0.pool.get().unwrap();
        assert_eq!(
            conn.query_row("SELECT sum(CostUsd) FROM tagging_runs", [], |r| r
                .get::<_, f64>(0))
                .unwrap(),
            0.003
        );
        assert_eq!(conn.query_row("SELECT count(*) FROM tagging_agent_events WHERE json_extract(Serialized,'$.event')='tool'",[],|r|r.get::<_,i64>(0)).unwrap(),1);
    }

    fn parse_test_prediction(raw: &Value, evidence: &Value) -> Result<Prediction> {
        let metadata = Metadata {
            name: "Song".into(),
            artist: "Artist".into(),
            album: "".into(),
            file_path: "".into(),
        };
        let item = PreparedItem {
            id: Uuid::new_v4(),
            hash: metadata.hash(),
            metadata,
            evidence: evidence.clone(),
        };
        Ok(parse_predictions(raw, &[item])?.remove(0))
    }

    fn fixture() -> (tempfile::TempDir, Tagging, Uuid) {
        let directory = tempfile::tempdir().unwrap();
        let pool = reitunes_workspace::open_connection_pool(
            directory.path().join("tags.db").to_str().unwrap(),
        )
        .unwrap();
        let id = Uuid::new_v4();
        let mut library = Library::new();
        library.items.insert(
            id,
            LibraryItem {
                id,
                name: "Death Song".into(),
                artist: "Robbie Basho".into(),
                album: "Visions of the Country".into(),
                file_path: "private/file.mp3".into(),
                created_time_utc: "2026-09-17T00:00:00".parse().unwrap(),
                track_number: None,
                play_count: 0,
                bookmarks: Default::default(),
                is_favorite: false,
            },
        );
        let mut tagging = Tagging::new(pool, Arc::new(RwLock::new(library))).unwrap();
        Arc::get_mut(&mut tagging.0).unwrap().key = None;
        (directory, tagging, id)
    }

    #[tokio::test]
    async fn automatic_sweep_catches_the_whole_library_and_missed_changes_without_rebilling() {
        let (_directory, mut tagging, first) = fixture();
        Arc::get_mut(&mut tagging.0).unwrap().key = Some("local-test-key".into());
        Arc::get_mut(&mut tagging.0).unwrap().engine_mode = tagging_engine::Mode::Fixed;
        let original = tagging.0.library.read().await.items[&first].clone();
        let mut ids = vec![first];
        for _ in 0..24 {
            let mut item = original.clone();
            item.id = Uuid::new_v4();
            ids.push(item.id);
            tagging.0.library.write().await.items.insert(item.id, item);
        }
        assert_eq!(tagging.enqueue_missing().await.unwrap(), 25);
        assert_eq!(tagging.enqueue_missing().await.unwrap(), 0);
        let jobs = tagging.next_batch().unwrap();
        assert_eq!(jobs.len(), 20);
        for (id, hash) in jobs {
            // Empty output is an intentional abstention, not an invitation to bill again.
            tagging
                .publish(
                    id,
                    &hash,
                    &ItemTags {
                        status: "ready".into(),
                        metadata_hash: hash.clone(),
                        ..Default::default()
                    },
                )
                .await
                .unwrap();
        }
        for (id, hash) in tagging.next_batch().unwrap() {
            tagging
                .fail(id, &hash, "Interrupted; billing may have occurred")
                .unwrap();
        }
        assert_eq!(tagging.enqueue_missing().await.unwrap(), 0);
        {
            let mut library = tagging.0.library.write().await;
            library.items.get_mut(&first).unwrap().name = "Corrected title".into();
            // Listening and favorites are not classification metadata changes.
            library.items.get_mut(&ids[1]).unwrap().play_count += 1;
            library.items.get_mut(&ids[2]).unwrap().is_favorite = true;
            let mut imported = original;
            imported.id = Uuid::new_v4();
            library.items.insert(imported.id, imported);
        }
        assert_eq!(tagging.enqueue_missing().await.unwrap(), 2);
        assert_eq!(tagging.enqueue_missing().await.unwrap(), 0);
        assert_eq!(tagging.next_batch().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn automatic_sweep_respects_manual_tags_and_import_edit_hooks_preserve_reasons() {
        let (_directory, mut tagging, id) = fixture();
        assert_eq!(tagging.enqueue_missing().await.unwrap(), 0); // No API key.
        tagging
            .save_label(
                id,
                Label {
                    tag: "folk".into(),
                    verdict: "accepted".into(),
                    reason: "My own tag".into(),
                },
            )
            .await
            .unwrap();
        Arc::get_mut(&mut tagging.0).unwrap().key = Some("local-test-key".into());
        Arc::get_mut(&mut tagging.0).unwrap().engine_mode = tagging_engine::Mode::Fixed;
        assert_eq!(tagging.enqueue_missing().await.unwrap(), 0); // Already tagged manually.
        tagging.enqueue_changed(id).await.unwrap();
        assert_eq!(tagging.next_batch().unwrap().len(), 1);
        tagging
            .0
            .library
            .write()
            .await
            .items
            .get_mut(&id)
            .unwrap()
            .artist = "Corrected artist".into();
        assert_eq!(tagging.enqueue_missing().await.unwrap(), 1);
        assert_eq!(
            tagging.snapshot().await.unwrap().items[&id.to_string()].labels["folk"].reason,
            "My own tag"
        );
        tagging.enqueue_changed(id).await.unwrap();
        assert_eq!(tagging.next_batch().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn queue_deduplicates_and_restart_keeps_labels_but_never_retries_interrupted_calls() {
        let (_directory, tagging, id) = fixture();
        tagging
            .save_label(
                id,
                Label {
                    tag: "Acoustic Folk".into(),
                    verdict: "accepted".into(),
                    reason: "I listened; guitar throughout.".into(),
                },
            )
            .await
            .unwrap();
        assert!(tagging.enqueue(id, false).await.unwrap());
        assert!(!tagging.enqueue(id, true).await.unwrap());
        let (_, hash) = tagging.next_batch().unwrap().remove(0);
        assert!(!tagging.enqueue(id, true).await.unwrap());
        tagging.0.pool.get().unwrap().execute("INSERT INTO tagging_runs (Id,ItemId,MetadataHash,StartedAt,Request,Evidence) VALUES ('interrupted',?1,?2,?3,'{}','{}')", params![id.to_string(),hash,now()]).unwrap();
        let restarted = Tagging::new(tagging.0.pool.clone(), tagging.0.library.clone()).unwrap();
        assert!(restarted.next_batch().unwrap().is_empty());
        let snapshot = restarted.snapshot().await.unwrap();
        assert_eq!(snapshot.items[&id.to_string()].status, "failed");
        assert_eq!(
            snapshot.items[&id.to_string()].labels["acoustic-folk"].reason,
            "I listened; guitar throughout."
        );
        assert!(!restarted.enqueue(id, false).await.unwrap());
        assert!(restarted.enqueue(id, true).await.unwrap());
        assert_eq!(restarted.next_batch().unwrap().remove(0).1, hash);
    }

    #[tokio::test]
    async fn queue_reports_exact_members_and_research_progress_resumes_without_rebilling() {
        let (_directory, mut tagging, id) = fixture();
        Arc::get_mut(&mut tagging.0).unwrap().key = Some("local-test-key".into());
        Arc::get_mut(&mut tagging.0).unwrap().engine_mode = tagging_engine::Mode::Fixed;
        let mut second = tagging.0.library.read().await.items[&id].clone();
        second.id = Uuid::new_v4();
        let second_id = second.id;
        tagging
            .0
            .library
            .write()
            .await
            .items
            .insert(second_id, second);
        let Json(result) = queue(
            State(tagging.clone()),
            Some(Json(QueueRequest {
                item_ids: vec![second_id],
            })),
        )
        .await
        .unwrap();
        assert_eq!(result, json!({"queued":1,"itemIds":[second_id]}));
        assert!(!tagging
            .snapshot()
            .await
            .unwrap()
            .items
            .contains_key(&id.to_string()));
        let Json(result) = queue(
            State(tagging.clone()),
            Some(Json(QueueRequest {
                item_ids: vec![second_id],
            })),
        )
        .await
        .unwrap();
        assert_eq!(result, json!({"queued":0,"itemIds":[]}));
        let (_, hash) = tagging.next_batch().unwrap().remove(0);
        tagging.set_phase(second_id, &hash, "researching").unwrap();
        assert_eq!(
            tagging.snapshot().await.unwrap().items[&second_id.to_string()]
                .phase
                .as_deref(),
            Some("researching")
        );
        let restarted = Tagging::new(tagging.0.pool.clone(), tagging.0.library.clone()).unwrap();
        assert_eq!(
            restarted.snapshot().await.unwrap().items[&second_id.to_string()].status,
            "queued"
        );
        assert_eq!(restarted.next_batch().unwrap().len(), 1);
        let error = queue(
            State(tagging),
            Some(Json(QueueRequest {
                item_ids: vec![id; 21],
            })),
        )
        .await
        .unwrap_err();
        assert_eq!(error.0, StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn metadata_change_discards_old_result_and_failure_does_not_replace_human_labels() {
        let (_directory, tagging, id) = fixture();
        tagging
            .save_label(
                id,
                Label {
                    tag: "folk".into(),
                    verdict: "rejected".into(),
                    reason: "Wrong recording.".into(),
                },
            )
            .await
            .unwrap();
        tagging.enqueue(id, false).await.unwrap();
        let (_, old_hash) = tagging.next_batch().unwrap().remove(0);
        tagging
            .0
            .library
            .write()
            .await
            .items
            .get_mut(&id)
            .unwrap()
            .name = "Another title".into();
        assert!(!tagging
            .publish(id, &old_hash, &ItemTags::default())
            .await
            .unwrap());
        assert_eq!(
            tagging.snapshot().await.unwrap().items[&id.to_string()].status,
            "stale"
        );
        assert!(tagging.enqueue(id, false).await.unwrap());
        tagging.fail(id, &old_hash, "old request failed").unwrap();
        let snapshot = tagging.snapshot().await.unwrap();
        assert_eq!(snapshot.items[&id.to_string()].status, "queued");
        let (_, hash) = tagging.next_batch().unwrap().remove(0);
        tagging.fail(id, &hash, "provider unavailable").unwrap();
        let snapshot = tagging.snapshot().await.unwrap();
        assert_eq!(snapshot.items[&id.to_string()].status, "failed");
        assert_eq!(
            snapshot.items[&id.to_string()].labels["folk"].reason,
            "Wrong recording."
        );
        tagging.0.library.write().await.items.remove(&id);
        assert!(tagging.snapshot().await.unwrap().items.is_empty());
    }

    #[test]
    fn request_pins_official_glm_and_never_sends_private_file_paths_or_search_tools() {
        let metadata = Metadata {
            name: "Song".into(),
            artist: "Artist".into(),
            album: "".into(),
            file_path: "secret/file.mp3".into(),
        };
        let request = build_request(&[PreparedItem {
            id: Uuid::new_v4(),
            hash: metadata.hash(),
            metadata,
            evidence: json!({"sources":[]}),
        }])
        .unwrap();
        assert_eq!(request["provider"]["only"], json!(["z-ai"]));
        assert_eq!(request["provider"]["allow_fallbacks"], false);
        assert_eq!(request["reasoning"]["effort"], "high");
        assert!(request.get("tools").is_none());
        assert!(!request.to_string().contains("secret/file"));
    }

    #[test]
    fn prediction_validates_provenance_and_accepts_only_known_delimiter_suffixes() {
        assert_eq!(normalize_tag("club/dancefloor").unwrap(), "club/dancefloor");
        let evidence = json!({"sources":["https://musicbrainz.org/artist/known"]});
        let prediction = json!({"id":"t01","tags":[{"tag":"Acoustic Folk","basis":"database","confidence":0.8,"evidence":"Artist community tags include folk.","sourceUrls":["https://musicbrainz.org/artist/known"]}],"uncertainty":"Recording identity is unverified."});
        let response = |content: String| json!({"choices":[{"finish_reason":"stop","message":{"content":content}}]});
        for suffix in ["", "``", "```", "````", "``````"] {
            assert_eq!(
                parse_test_prediction(
                    &response(format!("{{\"items\":[{prediction}]}}{suffix}")),
                    &evidence
                )
                .unwrap()
                .tags[0]
                    .tag,
                "acoustic-folk"
            );
        }
        for suffix in [" extra prose", "```` Correction", " {\"items\":[]}"] {
            assert!(parse_test_prediction(
                &response(format!("{{\"items\":[{prediction}]}}{suffix}")),
                &evidence
            )
            .is_err());
        }
        assert!(parse_test_prediction(
            &response(json!({"items":[prediction.clone()]}).to_string()),
            &json!({"sources":[]})
        )
        .is_err());
        let mut duplicate = prediction.clone();
        duplicate["tags"]
            .as_array_mut()
            .unwrap()
            .push(prediction["tags"][0].clone());
        assert!(parse_test_prediction(
            &response(json!({"items":[duplicate]}).to_string()),
            &evidence
        )
        .is_err());
        let mut invalid = prediction;
        invalid["tags"][0]["basis"] = json!("audio");
        assert!(parse_test_prediction(
            &response(json!({"items":[invalid]}).to_string()),
            &evidence
        )
        .is_err());
    }

    #[tokio::test]
    async fn labels_api_persists_reasons_validates_input_and_works_without_model_key() {
        let (_directory, tagging, id) = fixture();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(listener, router::<()>(tagging)).await.unwrap();
        });
        struct AbortOnDrop(tokio::task::JoinHandle<()>);
        impl Drop for AbortOnDrop {
            fn drop(&mut self) {
                self.0.abort();
            }
        }
        let _server = AbortOnDrop(server);
        let client = reqwest::Client::new();
        let url = format!("http://{address}/tags");
        assert_eq!(
            client
                .post(format!("{url}/queue"))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
        let labels_url = format!("{url}/items/{id}/labels");
        let label = json!({"tag":"R&B","verdict":"accepted","reason":"The vocals fit this genre."});
        assert_eq!(
            client
                .put(&labels_url)
                .json(&label)
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::NO_CONTENT
        );
        let snapshot: Value = client.get(&url).send().await.unwrap().json().await.unwrap();
        assert_eq!(snapshot["enabled"], false);
        assert_eq!(
            snapshot["items"][id.to_string()]["labels"]["r&b"]["reason"],
            "The vocals fit this genre."
        );
        let bad = json!({"tag":"r&b","verdict":"unknown","reason":""});
        assert_eq!(
            client
                .put(&labels_url)
                .json(&bad)
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::BAD_REQUEST
        );
        let missing = format!("{url}/items/{}/labels", Uuid::new_v4());
        assert_eq!(
            client
                .put(missing)
                .json(&label)
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            client
                .delete(format!("{labels_url}/r%26b"))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::NO_CONTENT
        );
        let snapshot: Value = client.get(url).send().await.unwrap().json().await.unwrap();
        assert!(snapshot["items"].as_object().unwrap().is_empty());
    }
}
