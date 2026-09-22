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
    sync::{atomic::{AtomicUsize, Ordering}, Arc},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::{Mutex, RwLock, Semaphore};

type Pool = r2d2::Pool<r2d2_sqlite::SqliteConnectionManager>;
type ApiError = (StatusCode, String);
mod nts;

const PAGE_SIZE: usize = 50;

fn default_importable() -> bool { true }
const REFRESH_SECONDS: i64 = 3 * 60 * 60;
const METADATA_RECHECK_SECONDS: i64 = 7 * 24 * 60 * 60;
// The downloader accepts two metadata processes. Share that budget between
// explicit source scans and background artwork/description lookups.
static METADATA_REQUESTS: Semaphore = Semaphore::const_new(2);

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
    download_job_id: Option<i64>,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    saved: bool,
    #[serde(default)]
    description: String,
    #[serde(default)]
    artwork_url: Option<String>,
    #[serde(default)]
    metadata_checked_at: Option<i64>,
    #[serde(default)]
    metadata_attempted_at: Option<i64>,
    #[serde(default)]
    import_completed: bool,
    #[serde(default)]
    genres: Vec<String>,
    #[serde(default)]
    download_url: Option<String>,
    #[serde(default = "default_importable")]
    can_import: bool,
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
    downloads: crate::downloads::Downloads,
    data: Mutex<Data>,
    previews: Mutex<HashMap<String, Preview>>,
    import_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    import_poll_cursor: AtomicUsize,
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
        "nts.live" | "www.nts.live" => nts::canonical_episode_url(input).ok()?,
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
    if reqwest::Url::parse(input.trim()).ok().and_then(|url| url.host_str().map(str::to_owned))
        .is_some_and(|host| matches!(host.as_str(), "nts.live" | "www.nts.live")) {
        return Ok((nts::canonical_show_url(input)?, "NTS".into()));
    }
    let url =
        reqwest::Url::parse(input.trim()).context("Enter a complete YouTube, SoundCloud or NTS URL.")?;
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

// Artwork is rendered by the browser. Only accept HTTPS images from the
// providers' image CDNs, never arbitrary URLs supplied by a source.
fn artwork_url(input: &str) -> Option<String> {
    let url = reqwest::Url::parse(input).ok()?;
    let host = url.host_str()?;
    (url.scheme() == "https" && url.username().is_empty() && url.password().is_none()
        && url.port().is_none()
        && ["ytimg.com", "ggpht.com", "sndcdn.com", "ntslive.co.uk"].iter()
            .any(|domain| host == *domain || host.ends_with(&format!(".{domain}"))))
        .then(|| url.to_string())
}

fn youtube_artwork(url: &str) -> Option<String> {
    let url = reqwest::Url::parse(url).ok()?;
    if !matches!(url.host_str(), Some("youtube.com" | "www.youtube.com")) { return None; }
    let id = url.query_pairs().find(|(key, _)| key == "v")?.1.into_owned();
    (id.len() == 11 && id.chars().all(|c| c.is_ascii_alphanumeric() || "_-".contains(c)))
        .then(|| format!("https://i.ytimg.com/vi/{id}/hqdefault.jpg"))
}

fn thumbnail(value: &Value) -> Option<String> {
    value["thumbnails"].as_array().into_iter().flatten()
        .filter_map(|image| {
            let url = artwork_url(image["url"].as_str()?)?;
            let width = image["width"].as_u64().unwrap_or(400);
            Some((width.abs_diff(400), url))
        })
        .min_by_key(|(distance, _)| *distance)
        .map(|(_, url)| url)
        .or_else(|| value["thumbnail"].as_str().and_then(artwork_url))
}

fn publication_date(value: &Value) -> Option<String> {
    for field in ["upload_date", "release_date"] {
        if let Some(date) = value[field].as_str().filter(|date| date.len() == 8 && date.bytes().all(|c| c.is_ascii_digit())) {
            if format!("{}-{}-{}", &date[..4], &date[4..6], &date[6..]).parse::<jiff::civil::Date>().is_ok() {
                return Some(date.into());
            }
        }
    }
    value["timestamp"].as_i64().or_else(|| value["release_timestamp"].as_i64())
        .and_then(|timestamp| jiff::Timestamp::from_second(timestamp).ok())
        .map(|timestamp| timestamp.to_zoned(jiff::tz::TimeZone::UTC).strftime("%Y%m%d").to_string())
}

fn parse_entry(value: &Value, provider: &str) -> Option<Entry> {
    let entry = parse_candidate(value, provider)?;
    // API references are temporary lookup targets, never listening/import links.
    (!entry.title.is_empty() && !entry.url.starts_with("https://api-v2.soundcloud.com/")).then_some(entry)
}

// Flat SoundCloud playlists supply identities and public links without titles.
// These candidates must be hydrated before they can become visible entries.
fn parse_candidate(value: &Value, provider: &str) -> Option<Entry> {
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
    let title = text_field(value, "title").unwrap_or_default();
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
        // Flat playlists only include permalinks for their first few tracks.
        // Accept the extractor's exact numeric reference for metadata hydration.
        let api_track = !media_id.is_empty() && media_id.len() <= 20
            && media_id.bytes().all(|c| c.is_ascii_digit())
            && raw == format!("https://api-v2.soundcloud.com/tracks/{media_id}");
        if !matches!(url.scheme(), "http" | "https")
            || !(api_track || matches!(
                url.host_str(),
                Some("soundcloud.com" | "www.soundcloud.com")
            ))
            || !url.username().is_empty()
            || url.password().is_some()
            || url.port().is_some()
        {
            return None;
        }
        url.set_scheme("https").ok()?;
        if !api_track { url.set_host(Some("soundcloud.com")).ok()?; }
        url.set_query(None);
        url.set_fragment(None);
        url.to_string().trim_end_matches('/').to_string()
    };
    let artwork_url = thumbnail(value).or_else(|| youtube_artwork(&url));
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
        published: publication_date(value),
        sources: vec![],
        inbox: false,
        status: "new".into(),
        discovered_at: now(),
        library_item_id: None,
        download_job_id: None,
        error: None,
        saved: false,
        description: text_field(value, "description").unwrap_or_default().chars().take(2000).collect(),
        artwork_url,
        metadata_checked_at: None,
        metadata_attempted_at: None,
        import_completed: false,
        genres: Vec::new(),
        download_url: None,
        can_import: true,
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
    let _permit = METADATA_REQUESTS.acquire().await.context("Metadata lookups are unavailable.")?;
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

async fn list_nts(endpoint: &str, source: &Source, start: usize, known: &[Entry]) -> Result<Listing> {
    let mut listing = nts::list(source, start).await?;
    let slots = Arc::new(Semaphore::new(2));
    let mut details = tokio::task::JoinSet::new();
    for (index, entry) in listing.entries.iter_mut().enumerate() {
        if let Some(cached) = known.iter().find(|cached| cached.id == entry.id) {
            entry.duration = cached.duration;
            entry.media_id.clone_from(&cached.media_id);
        }
        // Show durations for the first inboxful even with no duration filter.
        // Strict filters need metadata for all candidates. Cache it on refresh.
        if entry.duration.is_none() && (source.min_minutes > 0 || index < 10) {
            if let Some(url) = entry.download_url.clone() {
                let slots = slots.clone();
                let endpoint = endpoint.to_owned();
                details.spawn(async move {
                    let _permit = slots.acquire().await.ok()?;
                    let value = extract(&endpoint, &url, 1, false).await.ok()?;
                    Some((index, value))
                });
            }
        }
    }
    while let Some(result) = details.join_next().await {
        if let Ok(Some((index, value))) = result {
            let entry = &mut listing.entries[index];
            entry.duration = value.get("duration").and_then(Value::as_f64).filter(|value| value.is_finite() && *value > 0.0);
            if let Some(id) = value.get("id").and_then(Value::as_str) { entry.media_id = id.into(); }
        }
    }
    listing.entries.retain(|entry| source.min_minutes == 0 || entry.duration.is_some_and(|duration| duration >= f64::from(source.min_minutes) * 60.0));
    Ok(listing)
}

async fn list(endpoint: &str, source: &Source, start: usize, known: &[Entry]) -> Result<Listing> {
    if source.provider == "NTS" {
        return tokio::time::timeout(Duration::from_secs(180), list_nts(endpoint, source, start, known))
            .await.context("Reading this NTS show took too long. Try again later.")?;
    }
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
            let Some(mut entry) = parse_candidate(value, &source.provider) else {
                continue;
            };
            if let Some(cached) = known.iter().find(|cached| cached.id == entry.id
                || (source.provider == "SoundCloud" && cached.media_id == entry.media_id
                    && cached.url.starts_with("https://soundcloud.com/"))) {
                entry.id.clone_from(&cached.id);
                entry.url.clone_from(&cached.url);
                if entry.title.is_empty() { entry.title.clone_from(&cached.title); }
                if entry.description.is_empty() { entry.description.clone_from(&cached.description); }
                entry.duration = entry.duration.or(cached.duration);
                if entry.uploader.is_empty() {
                    entry.uploader.clone_from(&cached.uploader);
                }
                entry.published = entry.published.or_else(|| cached.published.clone());
                entry.artwork_url = entry.artwork_url.or_else(|| cached.artwork_url.clone());
                entry.metadata_checked_at = cached.metadata_checked_at;
                entry.metadata_attempted_at = cached.metadata_attempted_at;
            }
            if entry.url.starts_with("https://api-v2.soundcloud.com/") || entry.title.is_empty()
                || (entry.duration.is_none() && source.min_minutes > 0) {
                let provider = source.provider.clone();
                let endpoint = endpoint.to_string();
                let slots = detail_slots.clone();
                details.spawn(async move {
                    let _permit = slots.acquire().await.ok()?;
                    let detail = extract(&endpoint, &entry.url, 1, false).await.ok()?;
                    parse_entry(&detail, &provider).map(|mut entry| {
                        entry.metadata_checked_at = Some(now());
                        (index, entry)
                    })
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
            downloads: crate::downloads::Downloads::new(&crate::downloader_url()).map_err(|(_, message)| anyhow::anyhow!(message))?,
            data: Mutex::new(data),
            previews: Mutex::new(HashMap::new()),
            import_locks: Mutex::new(HashMap::new()),
            import_poll_cursor: AtomicUsize::new(0),
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
            // Old snapshots predate artwork. YouTube needs no lookup at all.
            entry.artwork_url = entry.artwork_url.take().or_else(|| youtube_artwork(&entry.url));
            // The existing downloader uses yt-dlp's default title [id].ext name.
            // Do not infer successful downloads just from a queue acknowledgement.
            let suffix = format!("[{}].", entry.media_id);
            let download_identity = entry.download_url.as_deref().and_then(item_identifier);
            entry.library_item_id = imports
                .get(&entry.id)
                .or_else(|| download_identity.as_ref().and_then(|id| imports.get(id)))
                .filter(|id| library.items.keys().any(|key| key.to_string() == **id))
                .cloned()
                .or_else(|| {
                    library
                        .items
                        .values()
                        .find(|item| item.file_path.contains(&suffix))
                        .map(|item| item.id.to_string())
                });
            entry.import_completed |= entry.library_item_id.is_some();
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

    // Neither worker status nor enrichment is needed to render a snapshot.
    // Reconcile in the background so a slow provider cannot hold up Discover.
    async fn reconcile_imports(self: &Arc<Self>) -> Result<(), ApiError> {
        let mut pending: Vec<_> = self.data.lock().await.entries.iter()
            .filter(|entry| entry.status == "queued" && !entry.import_completed)
            .filter_map(|entry| entry.download_job_id.map(|job| (entry.id.clone(), job)))
            .collect();
        if pending.len() > 20 {
            let offset = self.import_poll_cursor.fetch_add(20, Ordering::Relaxed) % pending.len();
            pending.rotate_left(offset);
            pending.truncate(20);
        }
        let slots = Arc::new(Semaphore::new(2));
        let mut requests = tokio::task::JoinSet::new();
        for (id, job_id) in pending {
            let discovery = self.clone();
            let slots = slots.clone();
            requests.spawn(async move {
                let _permit = slots.acquire().await.ok()?;
                match discovery.downloads.get(job_id).await {
                    Ok(job) if matches!(job.stage.as_str(), "completed" | "failed") =>
                        Some((id, job_id, job.stage == "completed", job.error)),
                    Err((StatusCode::NOT_FOUND, message)) => Some((id, job_id, false, Some(message))),
                    _ => None,
                }
            });
        }
        let mut updates = Vec::new();
        while let Some(result) = requests.join_next().await {
            if let Ok(Some(update)) = result { updates.push(update); }
        }
        if updates.is_empty() { return Ok(()); }
        self.change(|data| {
            for (id, job_id, completed, error) in updates {
                if let Some(entry) = data.entries.iter_mut().find(|entry| entry.id == id
                    && entry.download_job_id == Some(job_id) && entry.status == "queued") {
                    entry.import_completed = completed;
                    if !completed {
                        entry.status = "import_failed".into();
                        entry.error = error;
                    }
                }
            }
            Ok(())
        }).await
    }

    async fn enrich_entries(&self) -> Result<(), ApiError> {
        let checked_at = now();
        let mut candidates: Vec<_> = self.data.lock().await.entries.iter()
            .filter(|entry| entry.saved || (entry.status != "dismissed" && !entry.sources.is_empty()))
            .filter(|entry| entry.metadata_checked_at.is_none_or(|checked| checked_at - checked >= METADATA_RECHECK_SECONDS))
            .filter(|entry| entry.metadata_attempted_at.is_none_or(|attempt| checked_at - attempt >= 15 * 60))
            .filter(|entry| entry.artwork_url.is_none() || entry.published.is_none() || entry.description.is_empty())
            .cloned().collect();
        candidates.sort_by_key(|entry| (!entry.saved && !entry.inbox,
            entry.artwork_url.is_some() || youtube_artwork(&entry.url).is_some(), !entry.saved));
        let slots = Arc::new(Semaphore::new(1));
        let mut requests = tokio::task::JoinSet::new();
        for entry in candidates.into_iter().take(6) {
            let endpoint = self.metadata_endpoint.clone();
            let slots = slots.clone();
            let scanner = self.scanner.clone();
            requests.spawn(async move {
                let _permit = slots.acquire().await.ok()?;
                // Give an explicit refresh/follow priority over the remaining
                // backfill batch. An already running lookup is time bounded.
                if scanner.available_permits() == 0 { return None; }
                let metadata = tokio::time::timeout(Duration::from_secs(30), async {
                    if nts::canonical_episode_url(&entry.url).is_ok() {
                        nts::metadata(&entry.url, &entry.uploader).await.ok()
                    } else {
                        let provider = if entry.url.starts_with("https://www.youtube.com/watch?") { "YouTube" } else { "SoundCloud" };
                        extract(&endpoint, &entry.url, 1, false).await.ok()
                            .and_then(|value| parse_entry(&value, provider))
                    }
                }).await.ok().flatten();
                Some((entry.id, metadata))
            });
        }
        let mut updates = Vec::new();
        while let Some(result) = requests.join_next().await {
            if let Ok(Some(update)) = result { updates.push(update); }
        }
        if updates.is_empty() { return Ok(()); }
        self.change(|data| {
            for (id, metadata) in updates {
                if let Some(entry) = data.entries.iter_mut().find(|entry| entry.id == id) {
                    // Also remember empty metadata, so sources with no description
                    // don't launch another lookup on every polling cycle.
                    entry.metadata_attempted_at = Some(checked_at);
                    if let Some(metadata) = metadata {
                        entry.metadata_checked_at = Some(checked_at);
                        entry.artwork_url = metadata.artwork_url.or_else(|| entry.artwork_url.clone());
                        entry.published = metadata.published.or_else(|| entry.published.clone());
                        entry.duration = metadata.duration.or(entry.duration);
                        if !metadata.description.is_empty() { entry.description = metadata.description; }
                        if !metadata.uploader.is_empty() { entry.uploader = metadata.uploader; }
                    }
                }
            }
            Ok(())
        }).await
    }

    pub fn start_refresh_loop(self: &Arc<Self>) {
        let discovery = self.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(15));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                interval.tick().await;
                if let Err(error) = discovery.reconcile_imports().await {
                    tracing::warn!(?error, "Discovery import reconciliation failed");
                }
            }
        });
        let discovery = self.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(60));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                interval.tick().await;
                if discovery.scanner.available_permits() == 0 { continue; }
                if let Err(error) = discovery.enrich_entries().await {
                    tracing::warn!(?error, "Discovery metadata enrichment failed");
                }
            }
        });
        let discovery = self.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(60));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                interval.tick().await;
                let ids: Vec<_> = discovery
                    .data
                    .lock()
                    .await
                    .sources
                    .iter()
                    .filter(|s| s.last_attempt.is_none_or(|t| now() - t >= REFRESH_SECONDS))
                    .map(|s| s.id.clone())
                    .collect();
                if ids.is_empty() { continue; }
                let Ok(_permit) = discovery.scanner.clone().try_acquire_owned() else {
                    continue;
                };
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
            // Preserve saves, dismissals, queue state and inbox membership.
            existing.title = entry.title;
            existing.duration = entry.duration.or(existing.duration);
            existing.media_id = entry.media_id;
            existing.published = entry.published.or_else(|| existing.published.clone());
            existing.artwork_url = entry.artwork_url.or_else(|| existing.artwork_url.clone());
            existing.metadata_checked_at = entry.metadata_checked_at.or(existing.metadata_checked_at);
            existing.metadata_attempted_at = entry.metadata_attempted_at.or(existing.metadata_attempted_at);
            if !entry.uploader.is_empty() { existing.uploader = entry.uploader; }
            if !entry.description.is_empty() { existing.description = entry.description; }
            existing.genres = entry.genres;
            existing.download_url = entry.download_url;
            existing.can_import = entry.can_import;
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
        .route("/discovery/entries/{id}/save", post(save))
        .route("/discovery/entries/{id}/details", get(entry_details))
        .route("/discovery/entries/{id}/restore", post(restore))
        .route("/discovery/entries/{id}/import", post(import))
        .with_state(discovery)
}

async fn snapshot(State(discovery): State<Arc<Discovery>>) -> Result<Json<Snapshot>, ApiError> {
    discovery.snapshot().await.map(Json)
}

#[derive(Deserialize)]
struct SaveRequest { saved: bool }

async fn save(
    State(discovery): State<Arc<Discovery>>,
    Path(id): Path<String>,
    Json(request): Json<SaveRequest>,
) -> Result<StatusCode, ApiError> {
    discovery.change(|data| {
        let entry = data.entries.iter_mut().find(|entry| entry.id == id)
            .ok_or_else(|| (StatusCode::NOT_FOUND, "Set not found.".into()))?;
        entry.saved = request.saved;
        Ok(())
    }).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn entry_details(
    State(discovery): State<Arc<Discovery>>,
    Path(id): Path<String>,
) -> Result<Json<nts::EpisodeDetails>, ApiError> {
    let url = discovery.data.lock().await.entries.iter().find(|entry| entry.id == id)
        .map(|entry| entry.url.clone())
        .ok_or_else(|| (StatusCode::NOT_FOUND, "Set not found.".into()))?;
    nts::details(&url).await.map(Json).map_err(|error| (StatusCode::BAD_GATEWAY, error.to_string()))
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
                entry.download_job_id = None;
                entry.import_completed = false;
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
    let _guard = lock_import(&discovery, &id).await;
    ensure_recoverable(&discovery, &id).await?;
    set_status(&discovery, &id, "new").await?;
    Ok(StatusCode::NO_CONTENT)
}

// Serialize recovery and submission for the same set, including older entries
// without a job ID. Different sets can still be submitted independently.
async fn lock_import(discovery: &Discovery, id: &str) -> tokio::sync::OwnedMutexGuard<()> {
    let lock = discovery.import_locks.lock().await.entry(id.to_owned()).or_default().clone();
    lock.lock_owned().await
}

async fn ensure_recoverable(discovery: &Discovery, id: &str) -> Result<(), ApiError> {
    let entry = discovery.snapshot().await?.data.entries.into_iter()
        .find(|entry| entry.id == id)
        .ok_or_else(|| (StatusCode::NOT_FOUND, "Set not found.".into()))?;
    if entry.library_item_id.is_some() {
        return Err((StatusCode::CONFLICT, "This set is already in your library.".into()));
    }
    if entry.import_completed {
        return Err((StatusCode::CONFLICT, "This download has completed. Check your library before importing again.".into()));
    }
    if let Some(job_id) = entry.download_job_id {
        match discovery.downloads.get(job_id).await {
            Ok(job) if job.stage == "failed" => {},
            Err((StatusCode::NOT_FOUND, _)) => {},
            Err(error) => return Err(error),
            Ok(job) => return Err((StatusCode::CONFLICT, if job.stage == "completed" {
                "This download has completed. Check your library before importing again."
            } else {
                "This download is still active. Wait for it to finish before retrying or returning it to the inbox."
            }.into())),
        }
    }
    Ok(())
}

async fn import(
    State(discovery): State<Arc<Discovery>>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    // Finish recording the result even if the browser leaves or disconnects.
    tokio::spawn(async move {
        let _guard = lock_import(&discovery, &id).await;
        import_locked(discovery, id).await
    }).await.map_err(internal)?
}

async fn import_locked(discovery: Arc<Discovery>, id: String) -> Result<StatusCode, ApiError> {
    ensure_recoverable(&discovery, &id).await?;
    let url = discovery
        .change(|data| {
            let entry = data
                .entries
                .iter_mut()
                .find(|e| e.id == id)
                .ok_or_else(|| (StatusCode::NOT_FOUND, "Set not found.".into()))?;
            if !entry.can_import {
                return Err(bad_request("This episode has no supported downloadable audio. You can listen on NTS or save it for later."));
            }
            // Record submission before dispatch; the per-entry lock prevents
            // another request from restoring or resending it in the meantime.
            entry.status = "queued".into();
            entry.download_job_id = None;
            entry.import_completed = false;
            entry.error = None;
            Ok(entry.download_url.clone().unwrap_or_else(|| entry.url.clone()))
        })
        .await?;
    let result = discovery.downloads.queue(&crate::DownloadRequest {
            url,
            dl_type: "Audio".into(),
        })
        .await;
    discovery.change(|data| {
        if let Some(entry) = data.entries.iter_mut().find(|e| e.id == id) {
            match &result {
                Ok(job) => entry.download_job_id = Some(job.id),
                Err((_, message)) => {
                    entry.status = "import_failed".into();
                    entry.error = Some(message.clone());
                }
            }
        }
        Ok(())
    }).await?;
    result.map(|_| StatusCode::ACCEPTED)
}

#[cfg(test)]
mod tests;
