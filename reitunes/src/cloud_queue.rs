use std::{
    collections::HashMap,
    sync::RwLock,
    time::{Duration, Instant},
};

use anyhow::{bail, Context, Result};
use openssl::memcmp;
use rand::{rngs::OsRng, RngCore};
use reqwest::Url;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

const QUEUE_LIFETIME: Duration = Duration::from_secs(7 * 24 * 60 * 60);
const MAX_QUEUES: usize = 20;
const MAX_WINDOW_ITEMS_EACH_SIDE: usize = 100;

#[derive(Debug, Clone)]
pub struct QueueTrack {
    pub source_id: Uuid,
    pub queue_item_id: Uuid,
    pub name: String,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub track_number: Option<u32>,
    pub media_url: String,
    pub content_type: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedQueue {
    pub queue_id: Uuid,
    pub queue_base_url: String,
    pub start_item_id: String,
    pub queue_version: String,
    pub item_count: usize,
}

#[derive(Debug, Clone)]
// These values stay server-side and are passed directly to loadCloudQueue.
pub struct PlaybackQueueParameters {
    pub queue_base_url: String,
    pub http_authorization: String,
    pub item_id: String,
    pub queue_version: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueVersion {
    context_version: String,
    queue_version: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueContext {
    context_version: String,
    queue_version: String,
    container: QueueContainer,
    playback_policies: PlaybackPolicies,
}

#[derive(Debug, Clone, Serialize)]
struct QueueContainer {
    #[serde(rename = "type")]
    container_type: &'static str,
    name: &'static str,
    id: MusicObjectId,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PlaybackPolicies {
    can_skip: bool,
    limited_skips: bool,
    can_skip_to_item: bool,
    can_skip_back: bool,
    can_seek: bool,
    can_repeat: bool,
    can_repeat_one: bool,
    can_crossfade: bool,
    can_shuffle: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemWindow {
    includes_beginning_of_queue: bool,
    includes_end_of_queue: bool,
    context_version: String,
    queue_version: String,
    items: Vec<QueueItem>,
    window_playhead: WindowPlayhead,
}

#[derive(Debug, Clone, Serialize)]
struct QueueItem {
    #[serde(skip_serializing)]
    source_id: Uuid,
    id: String,
    track: TrackMetadata,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TrackMetadata {
    #[serde(rename = "type")]
    track_type: &'static str,
    name: String,
    media_url: String,
    content_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    artist: Option<NamedMetadata>,
    #[serde(skip_serializing_if = "Option::is_none")]
    album: Option<NamedMetadata>,
    #[serde(skip_serializing_if = "Option::is_none")]
    track_number: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
struct NamedMetadata {
    name: String,
}

#[derive(Debug, Clone, Serialize)]
struct MusicObjectId {
    #[serde(rename = "objectId")]
    object_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WindowPlayhead {
    item_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemWindowQuery {
    #[serde(default, rename = "reason")]
    pub _reason: String,
    #[serde(default)]
    pub item_id: String,
    #[serde(default)]
    pub previous_window_size: usize,
    #[serde(default)]
    pub upcoming_window_size: usize,
    #[serde(default, rename = "queueVersion")]
    pub _queue_version: String,
    #[serde(default, rename = "isExplicit")]
    pub _is_explicit: Option<bool>,
}

#[derive(Debug, thiserror::Error)]
pub enum CloudQueueError {
    #[error("Cloud Queue is not configured; set REITUNES_HOSTNAME and URL_SCHEME")]
    NotConfigured,
    #[error("Cloud Queue not found or expired")]
    NotFound,
    #[error("Cloud Queue authorization is missing or invalid")]
    Unauthorized,
    #[error("{0}")]
    InvalidRequest(String),
    #[error(transparent)]
    Internal(#[from] anyhow::Error),
}

#[derive(Debug, Clone)]
struct QueueSnapshot {
    id: Uuid,
    #[allow(dead_code)]
    queue_base_url: String,
    authorization: String,
    context_version: String,
    queue_version: String,
    start_item_id: String,
    created_at: Instant,
    items: Vec<QueueItem>,
}

pub struct CloudQueueStore {
    public_base_url: Option<Url>,
    queues: RwLock<HashMap<Uuid, QueueSnapshot>>,
}

impl CloudQueueStore {
    pub fn from_env() -> Result<Self> {
        let scheme = configured_value("URL_SCHEME", option_env!("URL_SCHEME"));
        let hostname = configured_value("REITUNES_HOSTNAME", option_env!("REITUNES_HOSTNAME"));
        let public_base_url = match (scheme, hostname) {
            (None, None) => None,
            (Some(scheme), Some(hostname)) => {
                let url = Url::parse(&format!("{scheme}://{hostname}/"))
                    .context("URL_SCHEME and REITUNES_HOSTNAME do not form a valid URL")?;
                if url.scheme() != "https" && url.host_str() != Some("localhost") {
                    bail!("Sonos Cloud Queue requires HTTPS (except on localhost)");
                }
                Some(url)
            }
            _ => {
                bail!("URL_SCHEME and REITUNES_HOSTNAME must either both be set or both be absent")
            }
        };

        Ok(Self {
            public_base_url,
            queues: RwLock::new(HashMap::new()),
        })
    }

    #[cfg(test)]
    pub(crate) fn with_base_url(public_base_url: &str) -> Self {
        Self {
            public_base_url: Some(Url::parse(public_base_url).unwrap()),
            queues: RwLock::new(HashMap::new()),
        }
    }

    pub fn prepare(
        &self,
        tracks: Vec<QueueTrack>,
        start_item_id: Option<Uuid>,
    ) -> Result<PreparedQueue, CloudQueueError> {
        if tracks.is_empty() {
            return Err(CloudQueueError::InvalidRequest(
                "A Sonos queue needs at least one track".to_string(),
            ));
        }

        let public_base_url = self
            .public_base_url
            .as_ref()
            .ok_or(CloudQueueError::NotConfigured)?;
        let starting_track = match start_item_id {
            Some(start_item_id) => tracks
                .iter()
                .find(|track| track.source_id == start_item_id)
                .ok_or_else(|| {
                    CloudQueueError::InvalidRequest(
                        "The starting track is not in the queue".to_string(),
                    )
                })?,
            None => &tracks[0],
        };
        let start_queue_item_id = starting_track.queue_item_id.to_string();

        let queue_id = Uuid::new_v4();
        let context_version = format!("CV:{queue_id}:1");
        let queue_version = format!("QV:{queue_id}:1");
        let queue_base_url = public_base_url
            .join(&format!("sonos/cloud-queue/{queue_id}/v2.3"))
            .context("failed to build Cloud Queue base URL")?
            .to_string();
        let authorization = format!("Bearer {}", random_secret());
        let items = tracks.into_iter().map(QueueItem::from).collect::<Vec<_>>();
        let item_count = items.len();
        let snapshot = QueueSnapshot {
            id: queue_id,
            queue_base_url: queue_base_url.clone(),
            authorization,
            context_version,
            queue_version: queue_version.clone(),
            start_item_id: start_queue_item_id.clone(),
            created_at: Instant::now(),
            items,
        };

        let mut queues = self.queues.write().map_err(|_| {
            CloudQueueError::Internal(anyhow::anyhow!("Cloud Queue lock was poisoned"))
        })?;
        queues.retain(|_, queue| queue.created_at.elapsed() < QUEUE_LIFETIME);
        if queues.len() >= MAX_QUEUES {
            if let Some(oldest) = queues
                .values()
                .min_by_key(|queue| queue.created_at)
                .map(|queue| queue.id)
            {
                queues.remove(&oldest);
            }
        }
        queues.insert(queue_id, snapshot);

        Ok(PreparedQueue {
            queue_id,
            queue_base_url,
            start_item_id: start_queue_item_id,
            queue_version,
            item_count,
        })
    }

    pub fn playback_parameters(
        &self,
        queue_id: Uuid,
    ) -> Result<PlaybackQueueParameters, CloudQueueError> {
        let snapshot = self.snapshot(queue_id)?;
        Ok(PlaybackQueueParameters {
            queue_base_url: snapshot.queue_base_url,
            http_authorization: snapshot.authorization,
            item_id: snapshot.start_item_id,
            queue_version: snapshot.queue_version,
        })
    }

    pub fn source_item_id(
        &self,
        queue_version: Option<&str>,
        queue_item_id: Option<&str>,
    ) -> Result<Option<Uuid>, CloudQueueError> {
        let (Some(queue_version), Some(queue_item_id)) = (queue_version, queue_item_id) else {
            return Ok(None);
        };
        let queues = self.queues.read().map_err(|_| {
            CloudQueueError::Internal(anyhow::anyhow!("Cloud Queue lock was poisoned"))
        })?;
        Ok(queues
            .values()
            .find(|queue| queue.queue_version == queue_version)
            .and_then(|queue| queue.items.iter().find(|item| item.id == queue_item_id))
            .map(|item| item.source_id))
    }

    pub fn version(
        &self,
        queue_id: Uuid,
        authorization: Option<&str>,
    ) -> Result<QueueVersion, CloudQueueError> {
        let snapshot = self.authorized_snapshot(queue_id, authorization)?;
        Ok(QueueVersion {
            context_version: snapshot.context_version,
            queue_version: snapshot.queue_version,
        })
    }

    pub fn accept_report(
        &self,
        queue_id: Uuid,
        authorization: Option<&str>,
    ) -> Result<(), CloudQueueError> {
        self.authorized_snapshot(queue_id, authorization)?;
        Ok(())
    }

    pub fn context(
        &self,
        queue_id: Uuid,
        authorization: Option<&str>,
    ) -> Result<QueueContext, CloudQueueError> {
        let snapshot = self.authorized_snapshot(queue_id, authorization)?;
        Ok(QueueContext {
            context_version: snapshot.context_version,
            queue_version: snapshot.queue_version,
            container: QueueContainer {
                container_type: "playlist",
                name: "ReiTunes queue",
                id: MusicObjectId {
                    object_id: format!("cloudqueue:{}", snapshot.id),
                },
            },
            playback_policies: PlaybackPolicies {
                can_skip: true,
                limited_skips: false,
                can_skip_to_item: true,
                can_skip_back: true,
                can_seek: true,
                can_repeat: true,
                can_repeat_one: true,
                can_crossfade: true,
                can_shuffle: false,
            },
        })
    }

    pub fn item_window(
        &self,
        queue_id: Uuid,
        authorization: Option<&str>,
        query: &ItemWindowQuery,
    ) -> Result<ItemWindow, CloudQueueError> {
        let snapshot = self.authorized_snapshot(queue_id, authorization)?;
        let center_item_id = if query.item_id.is_empty() {
            &snapshot.start_item_id
        } else {
            &query.item_id
        };
        let center = snapshot
            .items
            .iter()
            .position(|item| item.id == *center_item_id)
            .ok_or(CloudQueueError::NotFound)?;
        let previous = query.previous_window_size.min(MAX_WINDOW_ITEMS_EACH_SIDE);
        let upcoming = query.upcoming_window_size.min(MAX_WINDOW_ITEMS_EACH_SIDE);
        let start = center.saturating_sub(previous);
        let end = (center.saturating_add(upcoming).saturating_add(1)).min(snapshot.items.len());

        Ok(ItemWindow {
            includes_beginning_of_queue: start == 0,
            includes_end_of_queue: end == snapshot.items.len(),
            context_version: snapshot.context_version,
            queue_version: snapshot.queue_version,
            items: snapshot.items[start..end].to_vec(),
            window_playhead: WindowPlayhead {
                item_id: center_item_id.clone(),
            },
        })
    }

    fn authorized_snapshot(
        &self,
        queue_id: Uuid,
        authorization: Option<&str>,
    ) -> Result<QueueSnapshot, CloudQueueError> {
        let snapshot = self.snapshot(queue_id)?;
        let supplied = authorization.ok_or(CloudQueueError::Unauthorized)?;
        if supplied.len() != snapshot.authorization.len()
            || !memcmp::eq(supplied.as_bytes(), snapshot.authorization.as_bytes())
        {
            return Err(CloudQueueError::Unauthorized);
        }
        Ok(snapshot)
    }

    fn snapshot(&self, queue_id: Uuid) -> Result<QueueSnapshot, CloudQueueError> {
        let queues = self.queues.read().map_err(|_| {
            CloudQueueError::Internal(anyhow::anyhow!("Cloud Queue lock was poisoned"))
        })?;
        let snapshot = queues
            .get(&queue_id)
            .filter(|queue| queue.created_at.elapsed() < QUEUE_LIFETIME)
            .cloned()
            .ok_or(CloudQueueError::NotFound)?;
        Ok(snapshot)
    }
}

impl From<QueueTrack> for QueueItem {
    fn from(track: QueueTrack) -> Self {
        Self {
            source_id: track.source_id,
            id: track.queue_item_id.to_string(),
            track: TrackMetadata {
                track_type: "track",
                name: track.name,
                media_url: track.media_url,
                content_type: track.content_type,
                artist: track.artist.map(|name| NamedMetadata { name }),
                album: track.album.map(|name| NamedMetadata { name }),
                track_number: track.track_number,
            },
        }
    }
}

fn configured_value(name: &str, compile_time_value: Option<&'static str>) -> Option<String> {
    compile_time_value
        .filter(|value| !value.trim().is_empty())
        .map(ToOwned::to_owned)
        .or_else(|| std::env::var(name).ok())
        .filter(|value| !value.trim().is_empty())
}

fn random_secret() -> String {
    let mut bytes = [0_u8; 32];
    OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn track(number: u128) -> QueueTrack {
        QueueTrack {
            source_id: Uuid::from_u128(number),
            queue_item_id: Uuid::from_u128(number + 100),
            name: format!("Track {number}"),
            artist: Some("Artist".to_string()),
            album: Some("Album".to_string()),
            track_number: Some(number as u32),
            media_url: format!("https://media.example.com/{number}.mp3"),
            content_type: "audio/mpeg".to_string(),
        }
    }

    #[test]
    fn creates_a_versioned_authenticated_queue() {
        let store = CloudQueueStore::with_base_url("https://reitunes.example.com/");
        let prepared = store
            .prepare(vec![track(1), track(2)], Some(Uuid::from_u128(2)))
            .unwrap();
        let playback = store.playback_parameters(prepared.queue_id).unwrap();

        assert!(playback.queue_base_url.ends_with("/v2.3"));
        assert_eq!(playback.item_id, Uuid::from_u128(102).to_string());
        assert!(playback.http_authorization.starts_with("Bearer "));
        assert_eq!(prepared.item_count, 2);
        assert_eq!(
            store
                .source_item_id(Some(&prepared.queue_version), Some(&playback.item_id))
                .unwrap(),
            Some(Uuid::from_u128(2))
        );
    }

    #[test]
    fn rejects_missing_or_incorrect_authorization() {
        let store = CloudQueueStore::with_base_url("https://reitunes.example.com/");
        let prepared = store.prepare(vec![track(1)], None).unwrap();

        assert!(matches!(
            store.context(prepared.queue_id, None),
            Err(CloudQueueError::Unauthorized)
        ));
        assert!(matches!(
            store.context(prepared.queue_id, Some("Bearer nope")),
            Err(CloudQueueError::Unauthorized)
        ));

        let playback = store.playback_parameters(prepared.queue_id).unwrap();
        store
            .accept_report(prepared.queue_id, Some(&playback.http_authorization))
            .unwrap();
    }

    #[test]
    fn returns_a_window_centered_on_the_requested_item() {
        let store = CloudQueueStore::with_base_url("https://reitunes.example.com/");
        let prepared = store
            .prepare(vec![track(1), track(2), track(3), track(4)], None)
            .unwrap();
        let playback = store.playback_parameters(prepared.queue_id).unwrap();
        let window = store
            .item_window(
                prepared.queue_id,
                Some(&playback.http_authorization),
                &ItemWindowQuery {
                    _reason: "refresh".to_string(),
                    item_id: Uuid::from_u128(103).to_string(),
                    previous_window_size: 1,
                    upcoming_window_size: 1,
                    _queue_version: prepared.queue_version,
                    _is_explicit: None,
                },
            )
            .unwrap();
        let json = serde_json::to_value(window).unwrap();

        assert_eq!(json["includesBeginningOfQueue"], false);
        assert_eq!(json["includesEndOfQueue"], true);
        assert_eq!(json["items"].as_array().unwrap().len(), 3);
        assert_eq!(
            json["items"][0]["track"]["mediaUrl"],
            "https://media.example.com/2.mp3"
        );
        assert_eq!(
            json["windowPlayhead"]["itemId"],
            Uuid::from_u128(103).to_string()
        );
    }

    #[test]
    fn serializes_the_required_context_and_version_fields() {
        let store = CloudQueueStore::with_base_url("https://reitunes.example.com/");
        let prepared = store.prepare(vec![track(1)], None).unwrap();
        let playback = store.playback_parameters(prepared.queue_id).unwrap();
        let authorization = Some(playback.http_authorization.as_str());

        let context =
            serde_json::to_value(store.context(prepared.queue_id, authorization).unwrap()).unwrap();
        let version =
            serde_json::to_value(store.version(prepared.queue_id, authorization).unwrap()).unwrap();

        assert_eq!(context["container"]["name"], "ReiTunes queue");
        assert_eq!(context["playbackPolicies"]["canSeek"], true);
        assert_eq!(version["queueVersion"], prepared.queue_version);
    }
}
