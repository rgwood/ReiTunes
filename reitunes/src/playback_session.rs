//! One household playback session. Browser preferences stay in the browser; the
//! destination and queue survive closing every controller or restarting ReiTunes.
use std::{
    collections::HashSet,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

use anyhow::{bail, Context, Result};
use axum::{
    extract::{Json as JsonExtractor, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use r2d2::Pool;
use r2d2_sqlite::SqliteConnectionManager;
use rusqlite::{params, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{AppState, FrontendUpdate};

const MAX_ITEMS: usize = 20_000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum PlaybackTarget {
    Browser {
        owner_id: Option<String>,
    },
    Sonos {
        household_id: String,
        group_id: String,
        group_name: String,
        player_names: Vec<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlaybackRange {
    start: f64,
    end: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    bookmark_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    after_end: Option<AfterEnd>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
enum AfterEnd {
    Pause,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QueueEntry {
    id: String,
    item_id: Uuid,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
enum RepeatMode {
    Off,
    One,
    All,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionQueue {
    manual_queue: Vec<QueueEntry>,
    // Distinguishes fresh runs of the same source so controller Undo stays safe.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    context_id: Option<String>,
    context_item_ids: Vec<Uuid>,
    context_index: i64,
    context_name: String,
    shuffle_enabled: bool,
    shuffled_ids: Vec<Uuid>,
    repeat_mode: RepeatMode,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlaybackSessionState {
    pub target: PlaybackTarget,
    pub current_item_id: Option<Uuid>,
    pub position: f64,
    playback_range: Option<PlaybackRange>,
    queue: SessionQueue,
}

impl PlaybackSessionState {
    fn upcoming_item_ids(&self) -> Vec<Uuid> {
        let queue = &self.queue;
        let mut ids: Vec<_> = queue
            .manual_queue
            .iter()
            .map(|entry| entry.item_id)
            .collect();
        let mut ordered = if queue.shuffle_enabled {
            queue.shuffled_ids.clone()
        } else {
            queue.context_item_ids.clone()
        };
        if queue.shuffle_enabled {
            let present: HashSet<_> = ordered.iter().copied().collect();
            ordered.extend(
                queue
                    .context_item_ids
                    .iter()
                    .filter(|id| !present.contains(id)),
            );
        }
        if queue.context_index < 0 {
            // A replacement source has not started yet. The current song can
            // still belong to the old source or the manually added queue.
            ids.extend_from_slice(&ordered);
        } else {
            let current = queue.context_item_ids.get(queue.context_index as usize);
            if let Some(index) = ordered.iter().position(|id| Some(id) == current) {
                ids.extend_from_slice(&ordered[index + 1..]);
                if queue.repeat_mode == RepeatMode::All {
                    // Close the cycle with a fresh occurrence of the current
                    // context song. This also keeps one-song playlists going.
                    ids.extend_from_slice(&ordered[..=index]);
                }
            }
        }
        ids.truncate(499);
        ids
    }

    fn validate(&self) -> Result<()> {
        fn short(value: &str, maximum: usize) -> Result<()> {
            if value.is_empty() || value.len() > maximum {
                bail!("A session identifier or label has an invalid length");
            }
            Ok(())
        }
        if !self.position.is_finite() || !(0.0..=31_536_000.0).contains(&self.position) {
            bail!("Playback position must be a non-negative number of seconds");
        }
        match &self.target {
            PlaybackTarget::Browser { owner_id } => {
                if let Some(id) = owner_id {
                    short(id, 200)?;
                }
            }
            PlaybackTarget::Sonos {
                household_id,
                group_id,
                group_name,
                player_names,
            } => {
                short(household_id, 500)?;
                short(group_id, 500)?;
                short(group_name, 500)?;
                if player_names.len() > 100 {
                    bail!("Too many Sonos players");
                }
                for name in player_names {
                    short(name, 500)?;
                }
            }
        }
        if let Some(range) = &self.playback_range {
            if !range.start.is_finite()
                || range.start < 0.0
                || range
                    .end
                    .is_some_and(|end| !end.is_finite() || end <= range.start)
            {
                bail!("Playback range must have a non-negative start and a later end");
            }
        }
        let queue = &self.queue;
        if queue.manual_queue.len() > MAX_ITEMS
            || queue.context_item_ids.len() > MAX_ITEMS
            || queue.shuffled_ids.len() > MAX_ITEMS
        {
            bail!("The playback queue is too large");
        }
        if queue.context_index < -1 || queue.context_index >= queue.context_item_ids.len() as i64 {
            bail!("The queue context index is out of bounds");
        }
        if queue.context_name.len() > 1000 {
            bail!("The queue context name is too long");
        }
        if let Some(id) = &queue.context_id {
            short(id, 200)?;
        }
        let mut entries = HashSet::new();
        for entry in &queue.manual_queue {
            short(&entry.id, 200)?;
            if !entries.insert(&entry.id) {
                bail!("Queue entry IDs must be unique, even for repeated songs");
            }
        }
        let context: HashSet<_> = queue.context_item_ids.iter().collect();
        let shuffled: HashSet<_> = queue.shuffled_ids.iter().collect();
        if shuffled.len() != queue.shuffled_ids.len() || !shuffled.is_subset(&context) {
            bail!("Shuffle order must contain distinct songs from the context");
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackSessionSnapshot {
    pub revision: u64,
    pub state: Option<PlaybackSessionState>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub queue_sync_pending: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub queue_sync_error: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateRequest {
    operation_id: String,
    expected_revision: u64,
    state: PlaybackSessionState,
}

pub enum UpdateResult {
    Updated(PlaybackSessionSnapshot),
    Duplicate(PlaybackSessionSnapshot),
    Conflict(PlaybackSessionSnapshot),
}

pub struct PlaybackSessionStore {
    db: Pool<SqliteConnectionManager>,
    // Also gates cloud queue replacement against a session revision. No network
    // requests run while held; SQLite's immediate transaction protects CAS itself.
    gate: Mutex<()>,
    pub sonos_commands: tokio::sync::Mutex<()>,
    sync_wakeup: tokio::sync::Notify,
}

impl PlaybackSessionStore {
    #[cfg(test)]
    pub fn in_memory() -> Self {
        Self::new(
            Pool::builder()
                .max_size(1)
                .build(SqliteConnectionManager::memory())
                .unwrap(),
        )
        .unwrap()
    }

    pub fn new(db: Pool<SqliteConnectionManager>) -> Result<Self> {
        db.get()?.execute_batch(
            "CREATE TABLE IF NOT EXISTS playback_session (
            singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
            revision INTEGER NOT NULL, state_json TEXT,
            sonos_item_id TEXT, sonos_pending_until INTEGER NOT NULL DEFAULT 0,
            queue_sync_pending INTEGER NOT NULL DEFAULT 0, queue_sync_error TEXT
        );
        INSERT OR IGNORE INTO playback_session (singleton, revision) VALUES (1, 0);
        CREATE TABLE IF NOT EXISTS playback_session_operations (
            operation_id TEXT PRIMARY KEY, request_fingerprint TEXT NOT NULL,
            revision INTEGER NOT NULL
        );",
        )?;
        // Keep development databases written by earlier iterations usable too.
        for (name, definition) in [
            ("queue_sync_pending", "INTEGER NOT NULL DEFAULT 0"),
            ("queue_sync_error", "TEXT"),
        ] {
            let conn = db.get()?;
            let exists: bool = conn.query_row("SELECT EXISTS (SELECT 1 FROM pragma_table_info('playback_session') WHERE name = ?1)", [name], |row| row.get(0))?;
            if !exists {
                conn.execute(
                    &format!("ALTER TABLE playback_session ADD COLUMN {name} {definition}"),
                    [],
                )?;
            }
        }
        Ok(Self {
            db,
            gate: Mutex::new(()),
            sonos_commands: tokio::sync::Mutex::new(()),
            sync_wakeup: tokio::sync::Notify::new(),
        })
    }

    pub fn snapshot(&self) -> Result<PlaybackSessionSnapshot> {
        let conn = self.db.get()?;
        read_snapshot(&conn)
    }

    pub fn update(&self, request: &UpdateRequest) -> Result<UpdateResult> {
        request.state.validate()?;
        if request.operation_id.is_empty() || request.operation_id.len() > 200 {
            bail!("A short operation ID is required");
        }
        let _gate = self
            .gate
            .lock()
            .map_err(|_| anyhow::anyhow!("Playback session lock was poisoned"))?;
        let mut conn = self.db.get()?;
        let transaction = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let snapshot = read_snapshot(&transaction)?;
        let request_fingerprint = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&(
                request.expected_revision,
                &request.state
            ))?)
        );
        let previous: Option<String> = transaction.query_row(
            "SELECT request_fingerprint FROM playback_session_operations WHERE operation_id = ?1",
            [&request.operation_id], |row| row.get(0),
        ).optional()?;
        if let Some(previous) = previous {
            if previous != request_fingerprint {
                bail!("This operation ID was already used for a different update");
            }
            return Ok(UpdateResult::Duplicate(snapshot));
        }
        if snapshot.revision != request.expected_revision {
            return Ok(UpdateResult::Conflict(snapshot));
        }
        let revision = snapshot.revision + 1;
        let reset_observation = snapshot.state.as_ref().is_none_or(|state| {
            state.target != request.state.target
                || state.current_item_id != request.state.current_item_id
        });
        let queue_changed = matches!(request.state.target, PlaybackTarget::Sonos { .. })
            && !reset_observation
            && snapshot
                .state
                .as_ref()
                .is_some_and(|state| state.queue != request.state.queue);
        transaction.execute(
            "UPDATE playback_session SET revision = ?1, state_json = ?2,
             sonos_item_id = CASE WHEN ?3 THEN NULL ELSE sonos_item_id END,
             sonos_pending_until = CASE WHEN ?3 THEN ?4 ELSE sonos_pending_until END,
             queue_sync_pending = CASE WHEN ?3 THEN 0 WHEN ?5 THEN 1 ELSE queue_sync_pending END,
             queue_sync_error = CASE WHEN ?3 OR ?5 THEN NULL ELSE queue_sync_error END WHERE singleton = 1",
            params![revision, serde_json::to_string(&request.state)?, reset_observation, unix_seconds() + 60, queue_changed],
        )?;
        transaction.execute(
            "INSERT INTO playback_session_operations VALUES (?1, ?2, ?3)",
            params![request.operation_id, request_fingerprint, revision],
        )?;
        // Old retries still fail CAS after expiry; this bounds persistent receipts.
        transaction.execute(
            "DELETE FROM playback_session_operations WHERE revision < ?1",
            [revision.saturating_sub(10_000)],
        )?;
        let updated = read_snapshot(&transaction)?;
        transaction.commit()?;
        if updated.queue_sync_pending {
            self.sync_wakeup.notify_one();
        }
        Ok(UpdateResult::Updated(updated))
    }

    pub fn with_revision<T>(
        &self,
        expected: Option<u64>,
        operation: impl FnOnce() -> Result<T, crate::cloud_queue::CloudQueueError>,
    ) -> Result<T, crate::cloud_queue::CloudQueueError> {
        let _gate = self
            .gate
            .lock()
            .map_err(|_| anyhow::anyhow!("Playback session lock was poisoned"))?;
        if let Some(expected) = expected {
            if self.snapshot()?.revision != expected {
                return Err(crate::cloud_queue::CloudQueueError::SharedSessionConflict(
                    "The shared queue changed in another controller. Refresh before editing."
                        .into(),
                ));
            }
        }
        operation()
    }

    pub fn confirm_sonos_load(
        &self,
        group_id: &str,
        expected_revision: Option<u64>,
        source_id: Uuid,
        queue_item_id: &str,
    ) -> Result<()> {
        let _gate = self
            .gate
            .lock()
            .map_err(|_| anyhow::anyhow!("Playback session lock was poisoned"))?;
        let mut conn = self.db.get()?;
        let transaction = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let snapshot = read_snapshot(&transaction)?;
        if expected_revision.is_some_and(|expected| expected != snapshot.revision) {
            return Ok(());
        }
        let Some(state) = snapshot.state else {
            return Ok(());
        };
        if state.current_item_id != Some(source_id)
            || !matches!(state.target, PlaybackTarget::Sonos { group_id: id, .. } if id == group_id)
        {
            return Ok(());
        }
        // A new cloud queue uses new occurrence IDs, even when restarting the
        // same song. Establish its baseline rather than treating it as a stale
        // observation from an old queue.
        let repeat = state.queue.repeat_mode == RepeatMode::All && !state.queue.context_item_ids.is_empty();
        transaction.execute("UPDATE playback_session SET sonos_item_id = ?1, sonos_pending_until = 0, queue_sync_pending = ?2, queue_sync_error = NULL WHERE singleton = 1", params![queue_item_id, repeat])?;
        transaction.commit()?;
        if repeat { self.sync_wakeup.notify_one(); }
        Ok(())
    }

    fn with_sonos_projection<T>(
        &self,
        revision: u64,
        item_id: &str,
        operation: impl FnOnce() -> Result<T, crate::cloud_queue::CloudQueueError>,
    ) -> Result<T, crate::cloud_queue::CloudQueueError> {
        self.with_revision(Some(revision), || {
            let current_item: Option<String> = self.db.get().map_err(anyhow::Error::from)?.query_row(
                "SELECT sonos_item_id FROM playback_session WHERE singleton = 1",
                [],
                |row| row.get(0),
            ).map_err(anyhow::Error::from)?;
            // Reconciliation can reject a delayed status without changing the
            // revision. Check the occurrence too: equal source IDs are not
            // enough when the same song appears twice in the queue.
            if current_item.as_deref() != Some(item_id) {
                tracing::warn!(
                    shared_revision = revision,
                    observed_item_id = %item_id.chars().take(64).collect::<String>(),
                    current_item_id = %current_item.as_deref().unwrap_or("").chars().take(64).collect::<String>(),
                    "Deferring queue projection for an outdated Sonos playhead"
                );
                return Err(crate::cloud_queue::CloudQueueError::Conflict(
                    "Waiting for the current Sonos playhead before updating the queue.".into(),
                ));
            }
            operation()
        })
    }

    fn finish_queue_sync(
        &self,
        revision: u64,
        error: Option<&str>,
    ) -> Result<Option<PlaybackSessionSnapshot>> {
        let _gate = self
            .gate
            .lock()
            .map_err(|_| anyhow::anyhow!("Playback session lock was poisoned"))?;
        let mut conn = self.db.get()?;
        let transaction = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current = read_snapshot(&transaction)?;
        if current.revision != revision
            || !current.queue_sync_pending
            || current.queue_sync_error.as_deref() == error && error.is_some()
        {
            return Ok(None);
        }
        transaction.execute("UPDATE playback_session SET queue_sync_pending = ?1, queue_sync_error = ?2 WHERE singleton = 1", params![error.is_some(), error])?;
        let updated = read_snapshot(&transaction)?;
        transaction.commit()?;
        Ok(Some(updated))
    }

    /// Sonos owns its playhead even with every browser closed. Its stable queue
    /// item IDs distinguish two consecutive occurrences of the same song.
    pub fn observe_sonos(
        &self,
        group_id: &str,
        position: f64,
        history: &[(String, Uuid)],
    ) -> Result<Option<PlaybackSessionSnapshot>> {
        let Some((item_id, source_id)) = history.last() else {
            return Ok(None);
        };
        let _gate = self
            .gate
            .lock()
            .map_err(|_| anyhow::anyhow!("Playback session lock was poisoned"))?;
        let mut conn = self.db.get()?;
        let transaction = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut snapshot = read_snapshot(&transaction)?;
        let Some(state) = &mut snapshot.state else {
            return Ok(None);
        };
        if !matches!(&state.target, PlaybackTarget::Sonos { group_id: id, .. } if id == group_id) {
            return Ok(None);
        }
        let (last_item, pending_until): (Option<String>, u64) = transaction.query_row(
            "SELECT sonos_item_id, sonos_pending_until FROM playback_session WHERE singleton = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        // A committed selection precedes the network request that loads it. Old
        // status events must not undo that selection while Sonos is loading.
        if pending_until > unix_seconds() && state.current_item_id != Some(*source_id) {
            return Ok(None);
        }
        let previous = last_item
            .as_ref()
            .and_then(|id| history.iter().position(|(item, _)| item == id));
        // A delayed poll can arrive after a newer event. The previous playhead
        // must occur in this history; explicit track selections reset it above.
        if last_item.is_some() && previous.is_none() {
            return Ok(None);
        }
        let advanced = previous.is_some_and(|index| index + 1 < history.len())
            || state.current_item_id != Some(*source_id);
        if advanced {
            let consumed = previous
                .map(|index| &history[index + 1..])
                .unwrap_or(&history[history.len() - 1..]);
            for (_, source) in consumed {
                if state
                    .queue
                    .manual_queue
                    .first()
                    .is_some_and(|entry| entry.item_id == *source)
                {
                    state.queue.manual_queue.remove(0);
                } else if let Some(index) = state
                    .queue
                    .context_item_ids
                    .iter()
                    .position(|id| id == source)
                {
                    state.queue.context_index = index as i64;
                }
            }
            state.current_item_id = Some(*source_id);
            state.playback_range = None;
            snapshot.revision += 1;
        }
        state.position = position;
        if advanced && state.queue.repeat_mode == RepeatMode::All && !state.queue.context_item_ids.is_empty() {
            snapshot.queue_sync_pending = true;
            snapshot.queue_sync_error = None;
        }
        transaction.execute("UPDATE playback_session SET revision = ?1, state_json = ?2, sonos_item_id = ?3, sonos_pending_until = 0, queue_sync_pending = ?4, queue_sync_error = ?5 WHERE singleton = 1",
            params![snapshot.revision, serde_json::to_string(state)?, item_id, snapshot.queue_sync_pending, snapshot.queue_sync_error])?;
        transaction.commit()?;
        if advanced && snapshot.queue_sync_pending {
            self.sync_wakeup.notify_one();
        }
        Ok(advanced.then_some(snapshot))
    }
}

fn unix_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn read_snapshot(conn: &rusqlite::Connection) -> Result<PlaybackSessionSnapshot> {
    let (revision, json, queue_sync_pending, queue_sync_error): (u64, Option<String>, bool, Option<String>) = conn.query_row(
        "SELECT revision, state_json, queue_sync_pending, queue_sync_error FROM playback_session WHERE singleton = 1",
        [],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    )?;
    Ok(PlaybackSessionSnapshot {
        revision,
        state: json
            .map(|json| serde_json::from_str(&json))
            .transpose()
            .context("Invalid stored playback session")?,
        queue_sync_pending,
        queue_sync_error,
    })
}

pub async fn get(State(app): State<AppState>) -> Response {
    match app.playback_session.snapshot() {
        Ok(snapshot) => Json(snapshot).into_response(),
        Err(error) => failure(StatusCode::INTERNAL_SERVER_ERROR, error),
    }
}

pub async fn retry_queue_sync(State(app): State<AppState>) -> StatusCode {
    app.playback_session.sync_wakeup.notify_one();
    StatusCode::ACCEPTED
}

/// Project durable queue edits even after the editing browser has closed. This
/// only refreshes an existing ReiTunes queue; it never loads, plays or takes over.
pub fn start_queue_sync(app: AppState) {
    tokio::spawn(async move {
        let mut retry_seconds = 2;
        loop {
            let result =
                tokio::time::timeout(std::time::Duration::from_secs(45), sync_queue_once(&app))
                    .await;
            if result.is_err() {
                if let Ok(current) = app.playback_session.snapshot() {
                    if let Ok(Some(snapshot)) = app.playback_session.finish_queue_sync(
                        current.revision,
                        Some(
                            "Sonos did not confirm the queue update in time. ReiTunes will retry.",
                        ),
                    ) {
                        let _ = app
                            .update_tx
                            .send(FrontendUpdate::PlaybackSession { snapshot });
                    }
                }
            }
            let wait_seconds = match result {
                Ok(Ok(true)) => {
                    retry_seconds = 2;
                    0
                }
                Ok(Ok(false)) => {
                    retry_seconds = 2;
                    15
                }
                result => {
                    tracing::warn!(?result, "Shared Sonos queue sync will retry");
                    let seconds = retry_seconds;
                    retry_seconds = (retry_seconds * 2).min(30);
                    seconds
                }
            };
            if wait_seconds > 0 {
                tokio::select! {
                    _ = app.playback_session.sync_wakeup.notified() => {},
                    _ = tokio::time::sleep(std::time::Duration::from_secs(wait_seconds)) => {},
                }
            }
        }
    });
}

pub(crate) async fn sync_queue_once(app: &AppState) -> Result<bool> {
    let snapshot = app.playback_session.snapshot()?;
    if !snapshot.queue_sync_pending {
        if let Some(state) = &snapshot.state {
            if let PlaybackTarget::Sonos { group_id, .. } = &state.target {
                if state.queue.repeat_mode == RepeatMode::All {
                    // Events normally wake the projector. Poll as a fallback
                    // and renew subscriptions with every browser closed. Reads
                    // don't hold the command lock or delay a user's Next press.
                    let _ = crate::sonos_group_playback_handler(State(app.clone()), axum::extract::Path(group_id.clone()))
                        .await.map_err(|(_, body)| anyhow::anyhow!(body.0.error))?;
                }
            }
        }
    }
    let _command = app.playback_session.sonos_commands.lock().await;
    let snapshot = app.playback_session.snapshot()?;
    if !snapshot.queue_sync_pending {
        return Ok(false);
    }
    let Some(state) = snapshot.state else {
        return Ok(false);
    };
    let PlaybackTarget::Sonos { group_id, .. } = &state.target else {
        return Ok(false);
    };
    let result: crate::SonosApiResult<()> =
        async {
            let control = crate::active_sonos_control(app, group_id)
                .await
                .map_err(crate::sonos_playback_failure)?;
            let playback = control
                .group_playback(group_id)
                .await
                .map_err(crate::sonos_failure)?;
            let response = crate::sonos_group_playback_response(app, &control, group_id, playback)?;
            crate::reconcile_sonos_session(app, group_id, &response)?;
            let (Some(item_id), Some(queue_version)) =
                (&response.playback.item_id, &response.playback.queue_version)
            else {
                return Err(crate::sonos_playback_failure(
                    crate::sonos::SonosPlaybackError::TakeoverRequired,
                ));
            };
            let ids = state.upcoming_item_ids();
            let tracks = crate::cloud_queue_tracks(app, &ids).await?;
            let replacement = app
            .playback_session
            .with_sonos_projection(snapshot.revision, item_id, || {
                let stored_version = app
                    .cloud_queues
                    .stored_version_for_item(queue_version, item_id)?;
                if app
                    .cloud_queues
                    .upcoming_matches(queue_version, item_id, &ids)?
                    && stored_version.len() <= 64
                {
                    return Ok(());
                }
                // Session CAS and the command mutex protect this server-owned
                // projection. Sonos's status is an observation, not the version
                // of the stored queue we are replacing. This also repairs old
                // persisted 76-character versions that Sonos truncated to 64.
                tracing::info!(
                    shared_revision = snapshot.revision,
                    queue_item_id = %item_id.chars().take(64).collect::<String>(),
                    observed_queue_version = %queue_version.chars().take(96).collect::<String>(),
                    stored_queue_version = %stored_version.chars().take(96).collect::<String>(),
                    observed_version_length = queue_version.len(),
                    stored_version_length = stored_version.len(),
                    upcoming_count = ids.len(),
                    "Projecting shared playback queue"
                );
                app.cloud_queues
                    .replace_upcoming(&stored_version, item_id, tracks)
            });
            replacement.map_err(crate::cloud_queue_failure)?;
            // Retrying refresh is safe, including when a prior refresh reply was
            // lost. Matching stored contents above avoids needing an old version.
            control
                .refresh_cloud_queue(group_id)
                .await
                .map_err(crate::sonos_failure)?;
            if let Err(error) = control.ensure_event_subscriptions(group_id).await {
                tracing::warn!(%error, group_id, "Could not renew Sonos event subscriptions");
            }
            Ok(())
        }
        .await;
    let error = result.as_ref().err().map(|(_, body)| body.0.error.as_str());
    if let Some(snapshot) = app
        .playback_session
        .finish_queue_sync(snapshot.revision, error)?
    {
        let _ = app
            .update_tx
            .send(FrontendUpdate::PlaybackSession { snapshot });
    }
    result.map_err(|(_, body)| anyhow::anyhow!(body.0.error))?;
    Ok(true)
}

pub async fn update(
    State(app): State<AppState>,
    JsonExtractor(request): JsonExtractor<UpdateRequest>,
) -> Response {
    match app.playback_session.update(&request) {
        Ok(UpdateResult::Updated(snapshot)) => {
            let _ = app.update_tx.send(FrontendUpdate::PlaybackSession {
                snapshot: snapshot.clone(),
            });
            Json(snapshot).into_response()
        }
        Ok(UpdateResult::Duplicate(snapshot)) => Json(snapshot).into_response(),
        Ok(UpdateResult::Conflict(snapshot)) => {
            (StatusCode::CONFLICT, Json(snapshot)).into_response()
        }
        Err(error) => failure(StatusCode::BAD_REQUEST, error),
    }
}

fn failure(status: StatusCode, error: anyhow::Error) -> Response {
    tracing::warn!(%error, "Playback session request failed");
    (
        status,
        Json(serde_json::json!({"error": error.to_string()})),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state() -> PlaybackSessionState {
        PlaybackSessionState {
            target: PlaybackTarget::Browser { owner_id: None },
            current_item_id: Some(Uuid::from_u128(1)),
            position: 12.5,
            playback_range: None,
            queue: SessionQueue {
                manual_queue: vec![
                    QueueEntry {
                        id: "first".into(),
                        item_id: Uuid::from_u128(2),
                    },
                    QueueEntry {
                        id: "second".into(),
                        item_id: Uuid::from_u128(2),
                    },
                ],
                context_id: None,
                context_item_ids: vec![Uuid::from_u128(1), Uuid::from_u128(3)],
                context_index: 0,
                context_name: "Housewarming".into(),
                shuffle_enabled: false,
                shuffled_ids: vec![],
                repeat_mode: RepeatMode::Off,
            },
        }
    }

    fn request(id: &str, revision: u64) -> UpdateRequest {
        UpdateRequest {
            operation_id: id.into(),
            expected_revision: revision,
            state: state(),
        }
    }

    #[test]
    fn initializes_once_and_deduplicates_without_overwriting_newer_state() {
        let store = PlaybackSessionStore::in_memory();
        assert_eq!(
            store.snapshot().unwrap(),
            PlaybackSessionSnapshot {
                revision: 0,
                state: None,
                queue_sync_pending: false,
                queue_sync_error: None,
            }
        );
        assert!(matches!(
            store.update(&request("one", 0)).unwrap(),
            UpdateResult::Updated(_)
        ));
        assert!(matches!(
            store.update(&request("other-controller", 0)).unwrap(),
            UpdateResult::Conflict(_)
        ));
        let mut next = request("two", 1);
        next.state.queue.manual_queue.remove(0);
        store.update(&next).unwrap();
        let UpdateResult::Duplicate(snapshot) = store.update(&request("one", 0)).unwrap() else {
            panic!("Expected duplicate");
        };
        assert_eq!(snapshot.revision, 2);
        assert_eq!(snapshot.state.unwrap().queue.manual_queue[0].id, "second");
        let mut reused = request("one", 0);
        reused.state.position = 30.0;
        assert!(store.update(&reused).is_err());
    }

    #[test]
    fn concurrent_initializers_cannot_both_win() {
        let store = std::sync::Arc::new(PlaybackSessionStore::in_memory());
        let threads: Vec<_> = (0..2)
            .map(|index| {
                let store = store.clone();
                std::thread::spawn(move || {
                    matches!(
                        store.update(&request(&index.to_string(), 0)).unwrap(),
                        UpdateResult::Updated(_)
                    )
                })
            })
            .collect();
        assert_eq!(
            threads
                .into_iter()
                .filter_map(|thread| thread.join().unwrap().then_some(()))
                .count(),
            1
        );
        assert_eq!(store.snapshot().unwrap().revision, 1);
    }

    #[test]
    fn state_and_retry_receipts_survive_restart() {
        let directory = tempfile::tempdir().unwrap();
        let db = reitunes_workspace::open_connection_pool(
            directory.path().join("test.db").to_str().unwrap(),
        )
        .unwrap();
        let store = PlaybackSessionStore::new(db.clone()).unwrap();
        store.update(&request("one", 0)).unwrap();
        drop(store);
        let restored = PlaybackSessionStore::new(db).unwrap();
        assert_eq!(restored.snapshot().unwrap().state, Some(state()));
        assert!(matches!(
            restored.update(&request("one", 0)).unwrap(),
            UpdateResult::Duplicate(_)
        ));
    }

    #[test]
    fn validates_unique_occurrences_and_bounded_indices() {
        let store = PlaybackSessionStore::in_memory();
        let mut update = request("one", 0);
        update.state.queue.manual_queue[1].id = "first".into();
        assert!(store.update(&update).is_err());
        update = request("two", 0);
        update.state.queue.context_index = 10;
        assert!(store.update(&update).is_err());
        assert_eq!(store.snapshot().unwrap().revision, 0);
    }

    #[test]
    fn context_identity_is_optional_for_existing_sessions_and_bounded() {
        let original = state();
        let json = serde_json::to_value(&original).unwrap();
        assert!(json["queue"].get("contextId").is_none());
        assert_eq!(
            serde_json::from_value::<PlaybackSessionState>(json).unwrap(),
            original
        );
        let mut identified = original;
        identified.queue.context_id = Some(Uuid::new_v4().to_string());
        identified.validate().unwrap();
        assert_eq!(
            serde_json::from_value::<PlaybackSessionState>(
                serde_json::to_value(&identified).unwrap()
            )
            .unwrap(),
            identified
        );
        for invalid in [String::new(), "x".repeat(201)] {
            identified.queue.context_id = Some(invalid);
            assert!(identified.validate().is_err());
        }
    }

    #[test]
    fn an_unstarted_source_follows_manual_occurrences_in_order_without_repeat_duplication() {
        let mut replacement = state();
        replacement.queue.context_index = -1;
        replacement.queue.context_item_ids = vec![Uuid::from_u128(2), Uuid::from_u128(3)];
        for repeat_mode in [RepeatMode::Off, RepeatMode::One, RepeatMode::All] {
            replacement.queue.repeat_mode = repeat_mode;
            assert_eq!(
                replacement.upcoming_item_ids(),
                vec![2, 2, 2, 3]
                    .into_iter()
                    .map(Uuid::from_u128)
                    .collect::<Vec<_>>()
            );
        }
        replacement.queue.shuffle_enabled = true;
        replacement.queue.shuffled_ids = vec![Uuid::from_u128(3)];
        assert_eq!(
            replacement.upcoming_item_ids(),
            vec![2, 2, 3, 2]
                .into_iter()
                .map(Uuid::from_u128)
                .collect::<Vec<_>>()
        );
        replacement.queue.context_index = 1;
        assert_eq!(
            replacement.upcoming_item_ids(),
            vec![2, 2, 2, 3]
                .into_iter()
                .map(Uuid::from_u128)
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn replacement_source_waits_for_manual_duplicates_and_remembers_removals_after_restart() {
        let directory = tempfile::tempdir().unwrap();
        let db = reitunes_workspace::open_connection_pool(
            directory.path().join("test.db").to_str().unwrap(),
        )
        .unwrap();
        let store = PlaybackSessionStore::new(db.clone()).unwrap();
        let mut initial = request("initial", 0);
        initial.state.target = PlaybackTarget::Sonos {
            household_id: "home".into(),
            group_id: "room".into(),
            group_name: "Living room".into(),
            player_names: vec![],
        };
        store.update(&initial).unwrap();
        let mut history = vec![("playing".into(), Uuid::from_u128(1))];
        store.observe_sonos("room", 42.0, &history).unwrap();

        let mut replacement = initial;
        replacement.operation_id = "replace-source".into();
        replacement.expected_revision = 1;
        replacement.state.position = 42.0;
        replacement.state.queue.context_id = Some("replacement-source".into());
        replacement.state.queue.context_name = "Favourites".into();
        replacement.state.queue.context_index = -1;
        replacement.state.queue.context_item_ids = vec![Uuid::from_u128(2), Uuid::from_u128(4)];
        replacement.state.queue.repeat_mode = RepeatMode::All;
        store.update(&replacement).unwrap();
        let snapshot = store.snapshot().unwrap();
        assert!(snapshot.queue_sync_pending);
        let saved = snapshot.state.unwrap();
        assert_eq!(saved.current_item_id, Some(Uuid::from_u128(1)));
        assert_eq!(saved.position, 42.0);
        assert_eq!(
            saved.queue.manual_queue,
            replacement.state.queue.manual_queue
        );

        // Each duplicate is consumed by occurrence before the same song in the
        // automatic source starts. A repeated status does not consume again.
        for (occurrence, remaining) in [("manual-first", 1), ("manual-second", 0)] {
            history.push((occurrence.into(), Uuid::from_u128(2)));
            let snapshot = store.observe_sonos("room", 0.0, &history).unwrap().unwrap();
            let saved = snapshot.state.unwrap();
            assert_eq!(saved.queue.manual_queue.len(), remaining);
            assert_eq!(saved.queue.context_index, -1);
            assert!(store
                .observe_sonos("room", 1.0, &history)
                .unwrap()
                .is_none());
        }
        history.push(("source-first".into(), Uuid::from_u128(2)));
        let snapshot = store.observe_sonos("room", 0.0, &history).unwrap().unwrap();
        let mut removal = UpdateRequest {
            operation_id: "remove-future-track".into(),
            expected_revision: snapshot.revision,
            state: snapshot.state.unwrap(),
        };
        assert_eq!(removal.state.queue.context_index, 0);
        removal.state.queue.context_item_ids.pop();
        store.update(&removal).unwrap();
        drop(store);
        let restored = PlaybackSessionStore::new(db)
            .unwrap()
            .snapshot()
            .unwrap()
            .state
            .unwrap();
        assert_eq!(
            restored.queue.context_id.as_deref(),
            Some("replacement-source")
        );
        assert_eq!(restored.upcoming_item_ids(), vec![Uuid::from_u128(2)]);
    }

    #[test]
    fn stale_session_revision_never_runs_a_queue_mutation() {
        let store = PlaybackSessionStore::in_memory();
        store.update(&request("one", 0)).unwrap();
        let result = store.with_revision(
            Some(0),
            || -> Result<(), crate::cloud_queue::CloudQueueError> {
                panic!("Stale write must not run");
            },
        );
        assert!(matches!(
            result,
            Err(crate::cloud_queue::CloudQueueError::SharedSessionConflict(
                _
            ))
        ));
    }

    #[test]
    fn observes_duplicate_songs_once_and_keeps_advancement_after_restart() {
        let directory = tempfile::tempdir().unwrap();
        let db = reitunes_workspace::open_connection_pool(
            directory.path().join("test.db").to_str().unwrap(),
        )
        .unwrap();
        let store = PlaybackSessionStore::new(db.clone()).unwrap();
        let mut initial = request("one", 0);
        initial.state.target = PlaybackTarget::Sonos {
            household_id: "home".into(),
            group_id: "room".into(),
            group_name: "Living room".into(),
            player_names: vec![],
        };
        store.update(&initial).unwrap();
        let first = ("playing".into(), Uuid::from_u128(1));
        let duplicate1 = ("queued-first".into(), Uuid::from_u128(2));
        let duplicate2 = ("queued-second".into(), Uuid::from_u128(2));
        // Confirm the selected track before it advances.
        assert!(store
            .observe_sonos("room", 13.0, &[first.clone()])
            .unwrap()
            .is_none());
        let snapshot = store
            .observe_sonos("room", 0.0, &[first.clone(), duplicate1.clone()])
            .unwrap()
            .unwrap();
        assert_eq!(snapshot.state.unwrap().queue.manual_queue[0].id, "second");
        assert!(store
            .observe_sonos("room", 4.0, &[first.clone(), duplicate1.clone()])
            .unwrap()
            .is_none());
        // A stale status response cannot roll back the current track.
        assert!(store
            .observe_sonos("room", 200.0, &[first.clone()])
            .unwrap()
            .is_none());
        drop(store);
        let restored = PlaybackSessionStore::new(db).unwrap();
        let snapshot = restored
            .observe_sonos("room", 0.0, &[first, duplicate1, duplicate2])
            .unwrap()
            .unwrap();
        assert_eq!(snapshot.revision, 3);
        assert!(snapshot.state.unwrap().queue.manual_queue.is_empty());
    }

    #[test]
    fn old_sonos_observations_cannot_cancel_a_committed_track_selection() {
        let store = PlaybackSessionStore::in_memory();
        let mut initial = request("initial", 0);
        initial.state.target = PlaybackTarget::Sonos {
            household_id: "home".into(),
            group_id: "room".into(),
            group_name: "Living room".into(),
            player_names: vec![],
        };
        store.update(&initial).unwrap();
        store
            .observe_sonos("room", 10.0, &[("old".into(), Uuid::from_u128(1))])
            .unwrap();
        initial.operation_id = "select-new".into();
        initial.expected_revision = 1;
        initial.state.current_item_id = Some(Uuid::from_u128(3));
        initial.state.queue.context_index = 1;
        store.update(&initial).unwrap();
        assert!(store
            .observe_sonos("room", 11.0, &[("old".into(), Uuid::from_u128(1))])
            .unwrap()
            .is_none());
        assert_eq!(store.snapshot().unwrap().revision, 2);
        assert_eq!(
            store.snapshot().unwrap().state.unwrap().current_item_id,
            Some(Uuid::from_u128(3))
        );
        store
            .observe_sonos("room", 0.0, &[("new".into(), Uuid::from_u128(3))])
            .unwrap();
        assert!(store
            .observe_sonos("room", 12.0, &[("old".into(), Uuid::from_u128(1))])
            .unwrap()
            .is_none());
        assert_eq!(
            store.snapshot().unwrap().state.unwrap().current_item_id,
            Some(Uuid::from_u128(3))
        );
    }

    #[test]
    fn loading_the_same_song_again_resets_the_cloud_queue_occurrence_baseline() {
        let store = PlaybackSessionStore::in_memory();
        let mut initial = request("initial", 0);
        initial.state.target = PlaybackTarget::Sonos {
            household_id: "home".into(),
            group_id: "room".into(),
            group_name: "Living room".into(),
            player_names: vec![],
        };
        store.update(&initial).unwrap();
        store
            .observe_sonos(
                "room",
                10.0,
                &[("old-queue-current".into(), Uuid::from_u128(1))],
            )
            .unwrap();
        store
            .confirm_sonos_load("room", Some(1), Uuid::from_u128(1), "new-queue-current")
            .unwrap();
        let snapshot = store
            .observe_sonos(
                "room",
                0.0,
                &[
                    ("new-queue-current".into(), Uuid::from_u128(1)),
                    ("new-queue-next".into(), Uuid::from_u128(2)),
                ],
            )
            .unwrap()
            .unwrap();
        assert_eq!(snapshot.state.unwrap().queue.manual_queue.len(), 1);
    }

    #[test]
    fn stale_worker_cannot_clear_a_newer_queue_edit() {
        let store = PlaybackSessionStore::in_memory();
        let mut update = request("initial", 0);
        update.state.target = PlaybackTarget::Sonos {
            household_id: "home".into(),
            group_id: "room".into(),
            group_name: "Living room".into(),
            player_names: vec![],
        };
        store.update(&update).unwrap();
        update.operation_id = "edit".into();
        update.expected_revision = 1;
        update.state.queue.manual_queue.pop();
        store.update(&update).unwrap();
        assert!(store.snapshot().unwrap().queue_sync_pending);
        update.operation_id = "newer-edit".into();
        update.expected_revision = 2;
        update.state.queue.manual_queue.clear();
        store.update(&update).unwrap();
        assert!(store.finish_queue_sync(2, None).unwrap().is_none());
        assert!(store.snapshot().unwrap().queue_sync_pending);
        assert!(store.finish_queue_sync(3, None).unwrap().is_some());
        assert!(!store.snapshot().unwrap().queue_sync_pending);
    }
}
