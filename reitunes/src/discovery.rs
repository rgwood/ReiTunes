use anyhow::{bail, Context, Result};
use axum::{
    extract::{Path, State},
    http::StatusCode,
    routing::{get, post},
    Json, Router,
};
use reitunes_workspace::Library;
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::{Mutex, RwLock, Semaphore};

type Pool = r2d2::Pool<r2d2_sqlite::SqliteConnectionManager>;
type ApiError = (StatusCode, String);
const PAGE_SIZE: usize = 50;
const REFRESH_SECONDS: i64 = 3 * 60 * 60;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    id: String,
    url: String,
    title: String,
    provider: String,
    min_minutes: u32,
    last_checked: Option<i64>,
    last_attempt: Option<i64>,
    error: Option<String>,
    archive_offset: usize,
    archive_finished: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    id: String,
    media_id: String,
    url: String,
    title: String,
    uploader: String,
    duration: Option<f64>,
    published: Option<String>,
    sources: Vec<String>,
    inbox: bool,
    status: String,
    discovered_at: i64,
    #[serde(default)]
    library_item_id: Option<String>,
    #[serde(default)]
    error: Option<String>,
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Data {
    sources: Vec<Source>,
    entries: Vec<Entry>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Snapshot {
    #[serde(flatten)]
    data: Data,
    refreshing: bool,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct FollowRequest {
    url: String,
    min_minutes: u32,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Preview {
    source: Source,
    entries: Vec<Entry>,
    #[serde(skip)]
    created_at: i64,
}

struct Listing {
    title: String,
    entries: Vec<Entry>,
    count: usize,
}

pub struct Discovery {
    pool: Pool,
    metadata_endpoint: String,
    data: Mutex<Data>,
    previews: Mutex<HashMap<String, Preview>>,
    // Only one scan at a time, including manual refresh and preview requests.
    scanner: Arc<Semaphore>,
    library: Arc<RwLock<Library>>,
}

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

fn identifier(url: &str) -> String {
    format!("{:x}", Sha256::digest(url.as_bytes()))
}

pub fn item_identifier(input: &str) -> Option<String> {
    let mut url = reqwest::Url::parse(input).ok()?;
    if !matches!(url.scheme(), "http" | "https") {
        return None;
    }
    let canonical = match url.host_str()? {
        "youtube.com" | "www.youtube.com" | "m.youtube.com" | "music.youtube.com" => {
            let id = url
                .query_pairs()
                .find(|(key, _)| key == "v")?
                .1
                .into_owned();
            format!("https://www.youtube.com/watch?v={id}")
        }
        "youtu.be" => format!(
            "https://www.youtube.com/watch?v={}",
            url.path().trim_matches('/')
        ),
        "soundcloud.com" | "www.soundcloud.com" => {
            url.set_scheme("https").ok()?;
            url.set_host(Some("soundcloud.com")).ok()?;
            url.set_query(None);
            url.set_fragment(None);
            url.to_string().trim_end_matches('/').to_string()
        }
        _ => return None,
    };
    Some(identifier(&canonical))
}

fn bad_request(error: impl std::fmt::Display) -> ApiError {
    (StatusCode::BAD_REQUEST, error.to_string())
}

fn internal(error: impl std::fmt::Display) -> ApiError {
    tracing::warn!(%error, "Discovery operation failed");
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        "Could not save discovery changes. Please retry.".into(),
    )
}

/// Only accept supported collection URLs. Never pass arbitrary URLs or options
/// to the metadata process, and strip tracking parameters for deduplication.
fn source_url(input: &str) -> Result<(String, String)> {
    let url =
        reqwest::Url::parse(input.trim()).context("Enter a complete YouTube or SoundCloud URL.")?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
    {
        bail!("Use a public YouTube or SoundCloud URL.");
    }
    let segments: Vec<_> = url.path().trim_matches('/').split('/').collect();
    let valid_part = |s: &str| {
        !s.is_empty()
            && s.chars()
                .all(|c| c.is_ascii_alphanumeric() || "-_.@".contains(c))
    };
    match url.host_str().unwrap_or_default() {
        "youtube.com" | "www.youtube.com" | "m.youtube.com" | "music.youtube.com" => {
            if url.path() == "/playlist" {
                let list = url.query_pairs().find(|(k, _)| k == "list").map(|(_, v)| v.into_owned())
                    .filter(|v| valid_part(v)).context("This playlist URL is missing its list ID.")?;
                return Ok((format!("https://www.youtube.com/playlist?list={list}"), "YouTube".into()));
            }
            let channel_len = if segments.first().is_some_and(|s| s.starts_with('@') && s.len() > 1) { 1 }
                else if segments.len() >= 2 && matches!(segments[0], "channel" | "c" | "user") { 2 }
                else { bail!("Follow a YouTube channel or playlist, rather than an individual video.") };
            if !segments.iter().all(|s| valid_part(s)) || segments.len() > channel_len + 1
                || (segments.len() > channel_len && !matches!(segments[channel_len], "videos" | "streams")) {
                bail!("Use the channel's Videos or Live tab, or a playlist URL.");
            }
            let tab = segments.get(channel_len).copied().unwrap_or("videos");
            Ok((format!("https://www.youtube.com/{}/{tab}", segments[..channel_len].join("/")), "YouTube".into()))
        }
        "soundcloud.com" | "www.soundcloud.com" => {
            if !segments.iter().all(|s| valid_part(s)) || matches!(segments[0], "discover" | "search" | "charts" | "you") {
                bail!("Use a SoundCloud profile or playlist URL.");
            }
            let path = match segments.as_slice() {
                [profile] => format!("{profile}/tracks"),
                [profile, "tracks"] => format!("{profile}/tracks"),
                [profile, "sets", playlist] => format!("{profile}/sets/{playlist}"),
                _ => bail!("Follow a SoundCloud profile or a specific playlist, rather than an individual track."),
            };
            Ok((format!("https://soundcloud.com/{path}"), "SoundCloud".into()))
        }
        _ => bail!("Discovery currently supports YouTube channels/playlists and SoundCloud profiles/playlists."),
    }
}

fn text_field(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)?
        .as_str()
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

fn parse_entry(value: &Value, provider: &str) -> Option<Entry> {
    if matches!(
        value.get("live_status").and_then(Value::as_str),
        Some("is_live" | "is_upcoming" | "post_live")
    ) || value.get("is_live").and_then(Value::as_bool) == Some(true)
        || matches!(
            value.get("availability").and_then(Value::as_str),
            Some("private" | "premium_only" | "subscriber_only")
        )
    {
        return None;
    }
    let media_id = value.get("id").and_then(|id| {
        id.as_str()
            .map(str::to_owned)
            .or_else(|| id.as_u64().map(|id| id.to_string()))
    })?;
    let title = text_field(value, "title")?;
    if matches!(title.as_str(), "[Deleted video]" | "[Private video]") {
        return None;
    }
    let url = if provider == "YouTube" {
        if !media_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "_-".contains(c))
        {
            return None;
        }
        format!("https://www.youtube.com/watch?v={media_id}")
    } else {
        let raw = text_field(value, "webpage_url").or_else(|| text_field(value, "url"))?;
        let mut url = reqwest::Url::parse(&raw).ok()?;
        if !matches!(url.scheme(), "http" | "https")
            || !matches!(
                url.host_str(),
                Some("soundcloud.com" | "www.soundcloud.com")
            )
            || !url.username().is_empty()
            || url.password().is_some()
            || url.port().is_some()
        {
            return None;
        }
        url.set_scheme("https").ok()?;
        url.set_host(Some("soundcloud.com")).ok()?;
        url.set_query(None);
        url.set_fragment(None);
        url.to_string().trim_end_matches('/').to_string()
    };
    Some(Entry {
        id: identifier(&url),
        media_id,
        url,
        title,
        uploader: text_field(value, "uploader")
            .or_else(|| text_field(value, "channel"))
            .unwrap_or_default(),
        duration: value
            .get("duration")
            .and_then(Value::as_f64)
            .filter(|n| n.is_finite() && *n >= 0.0),
        published: text_field(value, "upload_date"),
        sources: vec![],
        inbox: false,
        status: "new".into(),
        discovered_at: now(),
        library_item_id: None,
        error: None,
    })
}

fn metadata_endpoint() -> Result<String> {
    Ok(option_env!("DISCOVERY_METADATA_URL")
        .map(str::to_owned)
        .or_else(|| std::env::var("DISCOVERY_METADATA_URL").ok())
        .map(Ok)
        .unwrap_or_else(|| {
            reqwest::Url::parse(&crate::downloader_url())?
                .join("metadata")
                .map(String::from)
        })?)
}

async fn extract(endpoint: &str, url: &str, start: usize, flat: bool) -> Result<Value> {
    let response = reqwest::Client::new()
        .post(endpoint)
        .json(&serde_json::json!({ "url": url, "start": start, "flat": flat }))
        .timeout(Duration::from_secs(95))
        .send()
        .await
        .context("Could not reach the downloader for source metadata. Try again later.")?;
    if response.status() == StatusCode::NOT_FOUND {
        bail!("The downloader needs its discovery update: the /metadata endpoint is not available yet.");
    }
    let status = response.status();
    if !status.is_success() {
        let message = response.text().await.unwrap_or_default();
        bail!(
            "Could not read this source ({status}): {}",
            message.chars().take(700).collect::<String>()
        );
    }
    response
        .json()
        .await
        .context("The downloader returned invalid metadata.")
}

async fn list(endpoint: &str, source: &Source, start: usize, known: &[Entry]) -> Result<Listing> {
    tokio::time::timeout(Duration::from_secs(180), async {
        let raw = extract(endpoint, &source.url, start, true).await?;
        let values = raw
            .get("entries")
            .and_then(Value::as_array)
            .context("This URL did not return a collection of sets.")?;
        let mut entries = Vec::new();
        let mut details = tokio::task::JoinSet::new();
        let detail_slots = Arc::new(Semaphore::new(2));
        for (index, value) in values.iter().take(PAGE_SIZE).enumerate() {
            let Some(mut entry) = parse_entry(value, &source.provider) else {
                continue;
            };
            if let Some(cached) = known.iter().find(|cached| cached.id == entry.id) {
                entry.duration = entry.duration.or(cached.duration);
                if entry.uploader.is_empty() {
                    entry.uploader.clone_from(&cached.uploader);
                }
                entry.published = entry.published.or_else(|| cached.published.clone());
            }
            if entry.duration.is_none() && source.min_minutes > 0 {
                let provider = source.provider.clone();
                let endpoint = endpoint.to_string();
                let slots = detail_slots.clone();
                details.spawn(async move {
                    let _permit = slots.acquire().await.ok()?;
                    let detail = extract(&endpoint, &entry.url, 1, false).await.ok()?;
                    parse_entry(&detail, &provider).map(|entry| (index, entry))
                });
            } else {
                entries.push((index, entry));
            }
        }
        while let Some(result) = details.join_next().await {
            if let Ok(Some(entry)) = result {
                entries.push(entry);
            }
        }
        entries.sort_by_key(|(index, _)| *index);
        let entries = entries
            .into_iter()
            .map(|(_, entry)| entry)
            .filter(|entry| {
                source.min_minutes == 0
                    || entry
                        .duration
                        .is_some_and(|d| d >= f64::from(source.min_minutes) * 60.0)
            })
            .collect();
        Ok(Listing {
            title: text_field(&raw, "title").unwrap_or_else(|| source.url.clone()),
            entries,
            count: values.len(),
        })
    })
    .await
    .context("Reading this source timed out. Try again later.")?
}

impl Discovery {
    pub fn new(pool: Pool, library: Arc<RwLock<Library>>) -> Result<Arc<Self>> {
        let data = pool
            .get()?
            .query_row(
                "SELECT Serialized FROM discovery_state WHERE Id=1",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .map(|json| serde_json::from_str(&json))
            .transpose()?
            .unwrap_or_default();
        Ok(Arc::new(Self {
            pool,
            metadata_endpoint: metadata_endpoint()?,
            data: Mutex::new(data),
            previews: Mutex::new(HashMap::new()),
            scanner: Arc::new(Semaphore::new(1)),
            library,
        }))
    }

    async fn change<T>(
        &self,
        update: impl FnOnce(&mut Data) -> Result<T, ApiError>,
    ) -> Result<T, ApiError> {
        let mut data = self.data.lock().await;
        let mut next = data.clone();
        let result = update(&mut next)?;
        let json = serde_json::to_string(&next).map_err(internal)?;
        self.pool.get().map_err(internal)?.execute("INSERT INTO discovery_state(Id, Serialized) VALUES(1, ?1) ON CONFLICT(Id) DO UPDATE SET Serialized=excluded.Serialized", [json]).map_err(internal)?;
        *data = next;
        Ok(result)
    }

    async fn snapshot(&self) -> Result<Snapshot, ApiError> {
        let mut data = self.data.lock().await.clone();
        let imports: HashMap<String, String> = self
            .pool
            .get()
            .map_err(internal)?
            .prepare("SELECT SourceId, LibraryItemId FROM discovery_imports")
            .map_err(internal)?
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(internal)?
            .collect::<rusqlite::Result<_>>()
            .map_err(internal)?;
        let library = self.library.read().await;
        for entry in &mut data.entries {
            // The existing downloader uses yt-dlp's default title [id].ext name.
            // Do not infer successful downloads just from a queue acknowledgement.
            let suffix = format!("[{}].", entry.media_id);
            entry.library_item_id = imports
                .get(&entry.id)
                .filter(|id| library.items.keys().any(|key| key.to_string() == **id))
                .cloned()
                .or_else(|| {
                    library
                        .items
                        .values()
                        .find(|item| item.file_path.contains(&suffix))
                        .map(|item| item.id.to_string())
                });
        }
        Ok(Snapshot {
            data,
            refreshing: self.scanner.available_permits() == 0,
        })
    }

    async fn scan(&self, id: &str, archive: bool) -> Result<(), ApiError> {
        let source = self
            .data
            .lock()
            .await
            .sources
            .iter()
            .find(|source| source.id == id)
            .cloned()
            .ok_or_else(|| {
                (
                    StatusCode::NOT_FOUND,
                    "This source is no longer followed.".into(),
                )
            })?;
        let start = if archive {
            source.archive_offset + 1
        } else {
            1
        };
        let known = self.data.lock().await.entries.clone();
        let result = list(&self.metadata_endpoint, &source, start, &known).await;
        self.change(|data| {
            let Some(index) = data.sources.iter().position(|source| source.id == id) else {
                return Ok(());
            };
            data.sources[index].last_attempt = Some(now());
            match result {
                Ok(listing) => {
                    data.sources[index].title = listing.title;
                    data.sources[index].last_checked = Some(now());
                    data.sources[index].error = None;
                    if archive {
                        data.sources[index].archive_offset += listing.count;
                        data.sources[index].archive_finished = listing.count < PAGE_SIZE;
                    }
                    merge_entries(
                        data,
                        id,
                        listing.entries,
                        if archive { 0 } else { usize::MAX },
                    );
                }
                Err(error) => data.sources[index].error = Some(error.to_string()),
            }
            Ok(())
        })
        .await
    }

    pub fn start_refresh_loop(self: &Arc<Self>) {
        let discovery = self.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(60));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                interval.tick().await;
                let Ok(_permit) = discovery.scanner.clone().try_acquire_owned() else {
                    continue;
                };
                let ids: Vec<_> = discovery
                    .data
                    .lock()
                    .await
                    .sources
                    .iter()
                    .filter(|s| s.last_attempt.is_none_or(|t| now() - t >= REFRESH_SECONDS))
                    .map(|s| s.id.clone())
                    .collect();
                for id in ids {
                    if let Err(error) = discovery.scan(&id, false).await {
                        tracing::warn!(?error, "Discovery refresh failed");
                    }
                }
            }
        });
    }
}

fn merge_entries(data: &mut Data, source_id: &str, entries: Vec<Entry>, inbox_limit: usize) {
    for (index, mut entry) in entries.into_iter().enumerate() {
        if let Some(existing) = data
            .entries
            .iter_mut()
            .find(|existing| existing.id == entry.id)
        {
            if !existing.sources.iter().any(|id| id == source_id) {
                existing.sources.push(source_id.into());
            }
            // Preserve dismissals, queue state and archive membership across refreshes.
            existing.title = entry.title;
            existing.duration = entry.duration.or(existing.duration);
        } else {
            entry.sources.push(source_id.into());
            entry.inbox = index < inbox_limit;
            data.entries.push(entry);
        }
    }
}

pub fn router(discovery: Arc<Discovery>) -> Router<crate::AppState> {
    Router::new()
        .route("/discovery", get(snapshot))
        .route("/discovery/preview", post(preview))
        .route("/discovery/sources", post(follow))
        .route("/discovery/sources/{id}", axum::routing::delete(unfollow))
        .route("/discovery/sources/{id}/archive", post(archive))
        .route("/discovery/refresh", post(refresh))
        .route("/discovery/entries/{id}/dismiss", post(dismiss))
        .route("/discovery/entries/{id}/restore", post(restore))
        .route("/discovery/entries/{id}/import", post(import))
        .with_state(discovery)
}

async fn snapshot(State(discovery): State<Arc<Discovery>>) -> Result<Json<Snapshot>, ApiError> {
    discovery.snapshot().await.map(Json)
}

async fn preview(
    State(discovery): State<Arc<Discovery>>,
    Json(request): Json<FollowRequest>,
) -> Result<Json<Preview>, ApiError> {
    let (url, provider) = source_url(&request.url).map_err(bad_request)?;
    if request.min_minutes > 1440 {
        return Err(bad_request(
            "Minimum duration must be between 0 and 1440 minutes.",
        ));
    }
    let id = identifier(&url);
    if discovery
        .data
        .lock()
        .await
        .sources
        .iter()
        .any(|s| s.id == id)
    {
        return Err((
            StatusCode::CONFLICT,
            "You already follow this source.".into(),
        ));
    }
    let _permit = discovery.scanner.clone().try_acquire_owned().map_err(|_| {
        (
            StatusCode::CONFLICT,
            "A source is being checked. Try again shortly.".into(),
        )
    })?;
    let mut source = Source {
        id: id.clone(),
        url,
        title: String::new(),
        provider,
        min_minutes: request.min_minutes,
        last_checked: None,
        last_attempt: None,
        error: None,
        archive_offset: 0,
        archive_finished: false,
    };
    let known = discovery.data.lock().await.entries.clone();
    let listing = list(&discovery.metadata_endpoint, &source, 1, &known)
        .await
        .map_err(|error| (StatusCode::BAD_GATEWAY, error.to_string()))?;
    source.title = listing.title;
    source.archive_offset = listing.count;
    source.archive_finished = listing.count < PAGE_SIZE;
    let result = Preview {
        source,
        entries: listing.entries,
        created_at: now(),
    };
    let mut previews = discovery.previews.lock().await;
    previews.retain(|_, p| now() - p.created_at < 600);
    previews.insert(id, result.clone());
    Ok(Json(result))
}

async fn follow(
    State(discovery): State<Arc<Discovery>>,
    Json(request): Json<FollowRequest>,
) -> Result<StatusCode, ApiError> {
    let (url, _) = source_url(&request.url).map_err(bad_request)?;
    let id = identifier(&url);
    let preview = discovery
        .previews
        .lock()
        .await
        .get(&id)
        .cloned()
        .filter(|p| p.source.min_minutes == request.min_minutes && now() - p.created_at < 600)
        .ok_or_else(|| bad_request("Preview this source again before following it."))?;
    discovery
        .change(|data| {
            if data.sources.iter().any(|s| s.id == id) {
                return Err((
                    StatusCode::CONFLICT,
                    "You already follow this source.".into(),
                ));
            }
            let mut source = preview.source;
            source.last_checked = Some(now());
            source.last_attempt = Some(now());
            data.sources.push(source);
            merge_entries(data, &id, preview.entries, 10);
            Ok(())
        })
        .await?;
    Ok(StatusCode::CREATED)
}

async fn unfollow(
    State(discovery): State<Arc<Discovery>>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    discovery
        .change(|data| {
            data.sources.retain(|s| s.id != id);
            for entry in &mut data.entries {
                entry.sources.retain(|source| source != &id);
            }
            // Keep entry identities so following the same source again preserves history.
            Ok(())
        })
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn refresh(State(discovery): State<Arc<Discovery>>) -> Result<StatusCode, ApiError> {
    let permit = discovery
        .scanner
        .clone()
        .try_acquire_owned()
        .map_err(|_| (StatusCode::CONFLICT, "A refresh is already running.".into()))?;
    tokio::spawn(async move {
        let _permit = permit;
        let ids: Vec<_> = discovery
            .data
            .lock()
            .await
            .sources
            .iter()
            .map(|s| s.id.clone())
            .collect();
        for id in ids {
            if let Err(error) = discovery.scan(&id, false).await {
                tracing::warn!(?error, "Discovery refresh failed");
            }
        }
    });
    Ok(StatusCode::ACCEPTED)
}

async fn archive(
    State(discovery): State<Arc<Discovery>>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    let permit = discovery.scanner.clone().try_acquire_owned().map_err(|_| {
        (
            StatusCode::CONFLICT,
            "A source is being checked. Try again shortly.".into(),
        )
    })?;
    if !discovery
        .data
        .lock()
        .await
        .sources
        .iter()
        .any(|s| s.id == id)
    {
        return Err((StatusCode::NOT_FOUND, "Source not found.".into()));
    }
    tokio::spawn(async move {
        let _permit = permit;
        if let Err(error) = discovery.scan(&id, true).await {
            tracing::warn!(?error, "Discovery archive failed");
        }
    });
    Ok(StatusCode::ACCEPTED)
}

async fn set_status(discovery: &Discovery, id: &str, status: &str) -> Result<(), ApiError> {
    discovery
        .change(|data| {
            let entry = data
                .entries
                .iter_mut()
                .find(|e| e.id == id)
                .ok_or_else(|| (StatusCode::NOT_FOUND, "Set not found.".into()))?;
            if entry.status == "queued" && status == "dismissed" {
                return Err(bad_request(
                    "This set has already been sent to the downloader.",
                ));
            }
            entry.status = status.into();
            entry.error = None;
            if status == "new" {
                entry.inbox = true;
            }
            Ok(())
        })
        .await
}

async fn dismiss(
    State(discovery): State<Arc<Discovery>>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    set_status(&discovery, &id, "dismissed").await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn restore(
    State(discovery): State<Arc<Discovery>>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    set_status(&discovery, &id, "new").await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn import(
    State(discovery): State<Arc<Discovery>>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    if discovery
        .snapshot()
        .await?
        .data
        .entries
        .iter()
        .any(|e| e.id == id && e.library_item_id.is_some())
    {
        return Err((
            StatusCode::CONFLICT,
            "This set is already in your library.".into(),
        ));
    }
    let url = discovery
        .change(|data| {
            let entry = data
                .entries
                .iter_mut()
                .find(|e| e.id == id)
                .ok_or_else(|| (StatusCode::NOT_FOUND, "Set not found.".into()))?;
            if entry.status == "queued" {
                return Err((
                    StatusCode::CONFLICT,
                    "This set has already been sent to the downloader.".into(),
                ));
            }
            // Persist before dispatch to prevent concurrent clicks/restarts from submitting twice.
            entry.status = "queued".into();
            entry.error = None;
            Ok(entry.url.clone())
        })
        .await?;
    // Finish recording the result even if the browser leaves or disconnects.
    let task = tokio::spawn(async move {
        let result = crate::queue_download(crate::DownloadRequest {
            url,
            dl_type: "Audio".into(),
        })
        .await;
        if let Err((_, message)) = &result {
            discovery
                .change(|data| {
                    if let Some(entry) = data.entries.iter_mut().find(|e| e.id == id) {
                        entry.status = "import_failed".into();
                        entry.error = Some(message.clone());
                    }
                    Ok(())
                })
                .await?;
        }
        result.map(|_| StatusCode::ACCEPTED)
    });
    task.await.map_err(internal)?
}

#[cfg(test)]
mod tests;
