use axum::{
    body::Body,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use regex::Regex;
use reitunes_workspace::{Bookmark, Library, LibraryItem};
use std::hash::{DefaultHasher, Hash, Hasher};
use tracing::{debug, error, info};
use uuid::Uuid;

const SONOS_NAMESPACE: &str = "http://www.sonos.com/Services/1.1";

pub async fn smapi_soap_handler(
    State(state): State<crate::AppState>,
    headers: HeaderMap,
    body: String,
) -> Result<Response, SoapError> {
    let action = soap_action(&headers)?;
    let user_agent = headers
        .get("User-Agent")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("unknown");
    let request_id = request_value(&body, "id").unwrap_or_default();
    info!(action, user_agent, request_id, "Handling SMAPI request");
    debug!(body, "SMAPI request body");

    let response_body = match action {
        "getMetadata" => get_metadata(&state, &body).await?,
        "search" => search(&state, &body).await?,
        "getMediaURI" => get_media_uri(&state, &body).await?,
        "getMediaMetadata" => get_media_metadata(&state, &body).await?,
        "getExtendedMetadata" => get_extended_metadata(&state, &body).await?,
        "getLastUpdate" => get_last_update(&state).await,
        _ => return Err(SoapError::UnsupportedOperation(action.to_string())),
    };

    debug!(response_body, "SMAPI response body");
    Ok(Response::builder()
        .status(StatusCode::OK)
        .header("Content-Type", "text/xml; charset=utf-8")
        .body(Body::from(response_body))?)
}

async fn get_metadata(state: &crate::AppState, body: &str) -> Result<String, SoapError> {
    let id = request_value(body, "id").unwrap_or_else(|| "root".to_string());
    let index = request_number(body, "index").unwrap_or(0);
    let requested_count = request_number(body, "count").unwrap_or(100).min(500);

    let library = state.library.read().await;
    let items = browse_items(&library, &id)?;

    Ok(metadata_response(
        "getMetadata",
        index,
        requested_count,
        &items,
    ))
}

async fn search(state: &crate::AppState, body: &str) -> Result<String, SoapError> {
    let id = request_value(body, "id").unwrap_or_else(|| "all".to_string());
    let term = request_value(body, "term")
        .unwrap_or_default()
        .to_lowercase();
    let index = request_number(body, "index").unwrap_or(0);
    let requested_count = request_number(body, "count").unwrap_or(100).min(500);
    let library = state.library.read().await;
    let matching_tracks = || {
        sorted_tracks(&library)
            .into_iter()
            .filter(|track| {
                track.name.to_lowercase().contains(&term)
                    || track.artist.to_lowercase().contains(&term)
                    || track.album.to_lowercase().contains(&term)
            })
            .map(BrowseItem::from)
            .collect::<Vec<_>>()
    };
    let matching_artists = || {
        artists(&library)
            .into_iter()
            .filter(|artist| artist.to_lowercase().contains(&term))
            .map(artist_item)
            .collect::<Vec<_>>()
    };
    let matching_albums = || {
        albums(&library)
            .into_iter()
            .filter(|(artist, album)| {
                artist.to_lowercase().contains(&term) || album.to_lowercase().contains(&term)
            })
            .map(|(artist, album)| album_item(&artist, &album))
            .collect::<Vec<_>>()
    };
    let items = match id.as_str() {
        "all" | "search:all" => {
            let mut items = matching_artists();
            items.extend(matching_albums());
            items.extend(matching_tracks());
            items
        }
        "artist" | "artists" | "search:artists" => matching_artists(),
        "album" | "albums" | "search:albums" => matching_albums(),
        "track" | "tracks" | "search:tracks" => matching_tracks(),
        _ => {
            return Err(SoapError::InvalidRequest(format!(
                "unknown search category: {id}"
            )))
        }
    };

    Ok(metadata_response("search", index, requested_count, &items))
}

async fn get_media_uri(state: &crate::AppState, body: &str) -> Result<String, SoapError> {
    let id = required_request_value(body, "id")?;
    let library = state.library.read().await;
    let (track, bookmark) = resolve_media_item(&library, &id)?;
    let url = state.storage.url(&track.file_path);
    let position_information = bookmark
        .map(|bookmark| {
            format!(
                "<positionInformation><id>{}</id><index>0</index><offsetMillis>{}</offsetMillis></positionInformation>",
                escape_xml(&id),
                bookmark.position.as_millis()
            )
        })
        .unwrap_or_default();

    Ok(soap_envelope(&format!(
        "<getMediaURIResponse xmlns=\"{SONOS_NAMESPACE}\"><getMediaURIResult>{}</getMediaURIResult>{position_information}</getMediaURIResponse>",
        escape_xml(&url),
    )))
}

async fn get_media_metadata(state: &crate::AppState, body: &str) -> Result<String, SoapError> {
    let id = required_request_value(body, "id")?;
    let library = state.library.read().await;
    if let Some((item_type, title)) = collection_details(&library, &id) {
        return Ok(soap_envelope(&format!(
            "<getMediaMetadataResponse xmlns=\"{SONOS_NAMESPACE}\"><getMediaMetadataResult>{}</getMediaMetadataResult></getMediaMetadataResponse>",
            collection_inner_xml(&id, item_type, &title)
        )));
    }
    let (track, bookmark) = resolve_media_item(&library, &id)?;
    let media_xml = bookmark.map_or_else(
        || track_xml(track),
        |bookmark| bookmark_xml(&id, track, bookmark),
    );

    Ok(soap_envelope(&format!(
        "<getMediaMetadataResponse xmlns=\"{SONOS_NAMESPACE}\"><getMediaMetadataResult>{}</getMediaMetadataResult></getMediaMetadataResponse>",
        media_xml
    )))
}

async fn get_extended_metadata(state: &crate::AppState, body: &str) -> Result<String, SoapError> {
    let id = required_request_value(body, "id")?;
    let library = state.library.read().await;
    let result = if let Some((item_type, title)) = collection_details(&library, &id) {
        format!(
            "<mediaCollection>{}</mediaCollection>",
            collection_inner_xml(&id, item_type, &title)
        )
    } else {
        let (track, bookmark) = resolve_media_item(&library, &id)?;
        let media_xml = bookmark.map_or_else(
            || track_xml(track),
            |bookmark| bookmark_xml(&id, track, bookmark),
        );
        format!("<mediaMetadata>{media_xml}</mediaMetadata>")
    };

    Ok(soap_envelope(&format!(
        "<getExtendedMetadataResponse xmlns=\"{SONOS_NAMESPACE}\"><getExtendedMetadataResult>{result}</getExtendedMetadataResult></getExtendedMetadataResponse>"
    )))
}

async fn get_last_update(state: &crate::AppState) -> String {
    let library = state.library.read().await;
    let catalog = catalog_version(&library);
    soap_envelope(&format!(
        "<getLastUpdateResponse xmlns=\"{SONOS_NAMESPACE}\"><getLastUpdateResult><favorites>{catalog}</favorites><catalog>{catalog}</catalog><pollInterval>120</pollInterval></getLastUpdateResult></getLastUpdateResponse>"
    ))
}

fn metadata_response(
    action: &str,
    index: usize,
    requested_count: usize,
    items: &[BrowseItem],
) -> String {
    let total = items.len();
    let start = index.min(total);
    let end = start.saturating_add(requested_count).min(total);
    let items_xml: String = items[start..end].iter().map(BrowseItem::to_xml).collect();

    soap_envelope(&format!(
        "<{action}Response xmlns=\"{SONOS_NAMESPACE}\"><{action}Result><index>{start}</index><count>{}</count><total>{total}</total>{items_xml}</{action}Result></{action}Response>",
        end - start
    ))
}

enum BrowseItem {
    Collection {
        id: String,
        item_type: &'static str,
        title: String,
    },
    Track(LibraryItem),
    Bookmark {
        track: LibraryItem,
        bookmark_id: Uuid,
        bookmark: Bookmark,
    },
}

fn browse_items(library: &Library, id: &str) -> Result<Vec<BrowseItem>, SoapError> {
    match id {
        "" | "root" => Ok(vec![
            collection_item("tracks", "trackList", "All songs"),
            collection_item("artists", "container", "Artists"),
            collection_item("albums", "container", "Albums"),
            collection_item("favorites", "trackList", "Favourites"),
            collection_item("bookmarks", "trackList", "Bookmarks"),
        ]),
        "tracks" => Ok(sorted_tracks(library)
            .into_iter()
            .map(BrowseItem::from)
            .collect()),
        "artists" => Ok(artists(library).into_iter().map(artist_item).collect()),
        "albums" => Ok(albums(library)
            .into_iter()
            .map(|(artist, album)| album_item(&artist, &album))
            .collect()),
        "favorites" => Ok(sorted_tracks(library)
            .into_iter()
            .filter(|track| track.is_favorite)
            .map(BrowseItem::from)
            .collect()),
        "bookmarks" => Ok(bookmarks(library)),
        "search" => Ok(vec![
            collection_item("search:all", "search", "All"),
            collection_item("search:artists", "search", "Artists"),
            collection_item("search:albums", "search", "Albums"),
            collection_item("search:tracks", "search", "Songs"),
        ]),
        _ if id.starts_with("artist:") => {
            let artist = artists(library)
                .into_iter()
                .find(|artist| stable_id("artist", &[artist]) == id)
                .ok_or_else(|| SoapError::NotFound(id.to_string()))?;
            Ok(sorted_tracks(library)
                .into_iter()
                .filter(|track| track.artist == artist)
                .map(BrowseItem::from)
                .collect())
        }
        _ if id.starts_with("album:") => {
            let (artist, album) = albums(library)
                .into_iter()
                .find(|(artist, album)| stable_id("album", &[artist, album]) == id)
                .ok_or_else(|| SoapError::NotFound(id.to_string()))?;
            Ok(sorted_tracks(library)
                .into_iter()
                .filter(|track| track.artist == artist && track.album == album)
                .map(BrowseItem::from)
                .collect())
        }
        _ => Err(SoapError::NotFound(id.to_string())),
    }
}

fn collection_details(library: &Library, id: &str) -> Option<(&'static str, String)> {
    match id {
        "tracks" => Some(("trackList", "All songs".to_string())),
        "artists" => Some(("container", "Artists".to_string())),
        "albums" => Some(("container", "Albums".to_string())),
        "favorites" => Some(("trackList", "Favourites".to_string())),
        "bookmarks" => Some(("trackList", "Bookmarks".to_string())),
        "search" => Some(("container", "Search".to_string())),
        "search:all" => Some(("search", "All".to_string())),
        "search:artists" => Some(("search", "Artists".to_string())),
        "search:albums" => Some(("search", "Albums".to_string())),
        "search:tracks" => Some(("search", "Songs".to_string())),
        _ if id.starts_with("artist:") => artists(library)
            .into_iter()
            .find(|artist| stable_id("artist", &[artist]) == id)
            .map(|artist| ("artist", artist)),
        _ if id.starts_with("album:") => albums(library)
            .into_iter()
            .find(|(artist, album)| stable_id("album", &[artist, album]) == id)
            .map(|(artist, album)| ("album", album_title(&artist, &album))),
        _ => None,
    }
}

fn collection_item(id: &str, item_type: &'static str, title: &str) -> BrowseItem {
    BrowseItem::Collection {
        id: id.to_string(),
        item_type,
        title: title.to_string(),
    }
}

fn artist_item(artist: String) -> BrowseItem {
    collection_item(&stable_id("artist", &[&artist]), "artist", &artist)
}

fn album_item(artist: &str, album: &str) -> BrowseItem {
    collection_item(
        &stable_id("album", &[artist, album]),
        "album",
        &album_title(artist, album),
    )
}

fn album_title(artist: &str, album: &str) -> String {
    if artist.is_empty() {
        album.to_string()
    } else {
        format!("{album} — {artist}")
    }
}

fn artists(library: &Library) -> Vec<String> {
    let mut artists: Vec<_> = library
        .items
        .values()
        .map(|track| track.artist.clone())
        .filter(|artist| !artist.is_empty())
        .collect();
    artists.sort_by_key(|artist| artist.to_lowercase());
    artists.dedup();
    artists
}

fn albums(library: &Library) -> Vec<(String, String)> {
    let mut albums: Vec<_> = library
        .items
        .values()
        .filter(|track| !track.album.is_empty())
        .map(|track| (track.artist.clone(), track.album.clone()))
        .collect();
    albums.sort_by_key(|(artist, album)| (album.to_lowercase(), artist.to_lowercase()));
    albums.dedup();
    albums
}

fn bookmarks(library: &Library) -> Vec<BrowseItem> {
    sorted_tracks(library)
        .into_iter()
        .flat_map(|track| {
            track
                .bookmarks
                .clone()
                .into_iter()
                .map(move |(bookmark_id, bookmark)| BrowseItem::Bookmark {
                    track: track.clone(),
                    bookmark_id,
                    bookmark,
                })
        })
        .collect()
}

fn stable_id(prefix: &str, values: &[&str]) -> String {
    // FNV-1a gives Sonos compact, deterministic IDs without relying on Rust's hash seed.
    let mut hash = 0xcbf29ce484222325_u64;
    for value in values {
        for byte in value.as_bytes().iter().chain(std::iter::once(&0)) {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(0x100000001b3);
        }
    }
    format!("{prefix}:{hash:016x}")
}

impl From<LibraryItem> for BrowseItem {
    fn from(track: LibraryItem) -> Self {
        Self::Track(track)
    }
}

impl BrowseItem {
    fn to_xml(&self) -> String {
        match self {
            Self::Collection {
                id,
                item_type,
                title,
            } => format!(
                "<mediaCollection>{}</mediaCollection>",
                collection_inner_xml(id, item_type, title)
            ),
            Self::Track(track) => format!("<mediaMetadata>{}</mediaMetadata>", track_xml(track)),
            Self::Bookmark {
                track,
                bookmark_id,
                bookmark,
            } => format!(
                "<mediaMetadata>{}</mediaMetadata>",
                bookmark_xml(
                    &format!("bookmark:{}:{bookmark_id}", track.id),
                    track,
                    bookmark
                )
            ),
        }
    }
}

fn collection_inner_xml(id: &str, item_type: &str, title: &str) -> String {
    format!(
        "<id>{}</id><itemType>{}</itemType><title>{}</title><canPlay>false</canPlay><canEnumerate>true</canEnumerate>",
        escape_xml(id),
        escape_xml(item_type),
        escape_xml(title)
    )
}

fn track_xml(track: &LibraryItem) -> String {
    track_xml_with_identity(&format!("track:{}", track.id), &track.name, track, false)
}

fn bookmark_xml(id: &str, track: &LibraryItem, bookmark: &Bookmark) -> String {
    let title = format!(
        "{} {} — {}",
        bookmark.emoji,
        track.name,
        format_position(bookmark.position)
    );
    track_xml_with_identity(id, &title, track, true)
}

fn track_xml_with_identity(id: &str, title: &str, track: &LibraryItem, can_resume: bool) -> String {
    let mime_type = mime_guess::from_path(&track.file_path)
        .first_or_octet_stream()
        .to_string();
    let track_number = track
        .track_number
        .map(|number| format!("<trackNumber>{number}</trackNumber>"))
        .unwrap_or_default();
    let can_resume = can_resume
        .then_some("<canResume>true</canResume>")
        .unwrap_or_default();

    format!(
        "<id>{}</id><itemType>track</itemType><title>{}</title><mimeType>{}</mimeType><trackMetadata><artist>{}</artist><album>{}</album>{track_number}<canPlay>true</canPlay><canSkip>true</canSkip>{can_resume}</trackMetadata>",
        escape_xml(id),
        escape_xml(title),
        escape_xml(&mime_type),
        escape_xml(&track.artist),
        escape_xml(&track.album),
    )
}

fn format_position(position: std::time::Duration) -> String {
    let total_seconds = position.as_secs();
    let hours = total_seconds / 3600;
    let minutes = (total_seconds % 3600) / 60;
    let seconds = total_seconds % 60;
    if hours == 0 {
        format!("{minutes}:{seconds:02}")
    } else {
        format!("{hours}:{minutes:02}:{seconds:02}")
    }
}

fn sorted_tracks(library: &Library) -> Vec<LibraryItem> {
    let mut tracks: Vec<_> = library.items.values().cloned().collect();
    tracks.sort_by(|left, right| {
        left.artist
            .to_lowercase()
            .cmp(&right.artist.to_lowercase())
            .then_with(|| left.album.to_lowercase().cmp(&right.album.to_lowercase()))
            .then_with(|| left.track_number.cmp(&right.track_number))
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });
    tracks
}

fn catalog_version(library: &Library) -> u64 {
    let mut ids: Vec<_> = library.items.keys().collect();
    ids.sort();
    let mut hasher = DefaultHasher::new();
    for id in ids {
        let item = &library.items[id];
        id.hash(&mut hasher);
        item.name.hash(&mut hasher);
        item.artist.hash(&mut hasher);
        item.album.hash(&mut hasher);
        item.file_path.hash(&mut hasher);
        item.track_number.hash(&mut hasher);
        item.is_favorite.hash(&mut hasher);
        for (bookmark_id, bookmark) in &item.bookmarks {
            bookmark_id.hash(&mut hasher);
            bookmark.position.hash(&mut hasher);
            bookmark.emoji.hash(&mut hasher);
        }
    }
    hasher.finish()
}

fn soap_action(headers: &HeaderMap) -> Result<&str, SoapError> {
    let header = headers
        .get("SOAPAction")
        .and_then(|value| value.to_str().ok())
        .ok_or(SoapError::MissingSoapAction)?;
    Ok(header
        .trim()
        .trim_matches('"')
        .rsplit_once('#')
        .map_or(header, |(_, action)| action))
}

fn request_number(body: &str, name: &str) -> Option<usize> {
    request_value(body, name)?.parse().ok()
}

fn required_request_value(body: &str, name: &str) -> Result<String, SoapError> {
    request_value(body, name).ok_or_else(|| SoapError::InvalidRequest(format!("missing {name}")))
}

fn request_value(body: &str, name: &str) -> Option<String> {
    let pattern = format!(
        r"(?s)<(?:[A-Za-z_][A-Za-z0-9_.-]*:)?{name}(?:\s[^>]*)?>(.*?)</(?:[A-Za-z_][A-Za-z0-9_.-]*:)?{name}\s*>"
    );
    Regex::new(&pattern)
        .expect("request element regex should be valid")
        .captures(body)
        .and_then(|captures| captures.get(1))
        .map(|value| value.as_str().trim().to_string())
}

fn track_uuid(id: &str) -> Result<Uuid, SoapError> {
    id.strip_prefix("track:")
        .unwrap_or(id)
        .parse()
        .map_err(|_| SoapError::InvalidRequest(format!("invalid track id: {id}")))
}

fn resolve_media_item<'a>(
    library: &'a Library,
    id: &str,
) -> Result<(&'a LibraryItem, Option<&'a Bookmark>), SoapError> {
    if let Some(reference) = id.strip_prefix("bookmark:") {
        let (track_id, bookmark_id) = reference
            .split_once(':')
            .ok_or_else(|| SoapError::InvalidRequest(format!("invalid bookmark id: {id}")))?;
        let track_id = track_id
            .parse::<Uuid>()
            .map_err(|_| SoapError::InvalidRequest(format!("invalid bookmark id: {id}")))?;
        let bookmark_id = bookmark_id
            .parse::<Uuid>()
            .map_err(|_| SoapError::InvalidRequest(format!("invalid bookmark id: {id}")))?;
        let track = library
            .items
            .get(&track_id)
            .ok_or_else(|| SoapError::NotFound(id.to_string()))?;
        let bookmark = track
            .bookmarks
            .get(&bookmark_id)
            .ok_or_else(|| SoapError::NotFound(id.to_string()))?;
        Ok((track, Some(bookmark)))
    } else {
        let track_id = track_uuid(id)?;
        let track = library
            .items
            .get(&track_id)
            .ok_or_else(|| SoapError::NotFound(id.to_string()))?;
        Ok((track, None))
    }
}

fn soap_envelope(content: &str) -> String {
    format!(
        "<?xml version=\"1.0\" encoding=\"utf-8\"?><soap:Envelope xmlns:soap=\"http://schemas.xmlsoap.org/soap/envelope/\"><soap:Body>{content}</soap:Body></soap:Envelope>"
    )
}

fn escape_xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

#[derive(Debug, thiserror::Error)]
pub enum SoapError {
    #[error("missing SOAPAction header")]
    MissingSoapAction,
    #[error("unsupported operation: {0}")]
    UnsupportedOperation(String),
    #[error("invalid request: {0}")]
    InvalidRequest(String),
    #[error("item not found: {0}")]
    NotFound(String),
    #[error("HTTP response error: {0}")]
    Http(#[from] axum::http::Error),
}

impl IntoResponse for SoapError {
    fn into_response(self) -> Response {
        error!(error = %self, "SMAPI request failed");
        let fault_code = match self {
            Self::MissingSoapAction | Self::UnsupportedOperation(_) | Self::InvalidRequest(_) => {
                "Client"
            }
            Self::NotFound(_) | Self::Http(_) => "Server",
        };
        let body = soap_envelope(&format!(
            "<soap:Fault><faultcode>{fault_code}</faultcode><faultstring>{}</faultstring></soap:Fault>",
            escape_xml(&self.to_string())
        ));
        Response::builder()
            .status(StatusCode::INTERNAL_SERVER_ERROR)
            .header("Content-Type", "text/xml; charset=utf-8")
            .body(Body::from(body))
            .expect("static SOAP fault response should be valid")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use reitunes_workspace::{Event, EventWithMetadata, PlaylistStore};
    use std::sync::Arc;
    use tokio::sync::{broadcast, RwLock};

    #[test]
    fn extracts_default_and_prefixed_namespace_values() {
        let default_namespace =
            r#"<getMetadata xmlns="http://www.sonos.com/Services/1.1"><id>root</id></getMetadata>"#;
        let prefixed_namespace = r#"<ns:getMetadata><ns:id>tracks</ns:id></ns:getMetadata>"#;

        assert_eq!(
            request_value(default_namespace, "id").as_deref(),
            Some("root")
        );
        assert_eq!(
            request_value(prefixed_namespace, "id").as_deref(),
            Some("tracks")
        );
    }

    #[test]
    fn root_response_has_sonos_namespace_and_pagination() {
        let items = vec![
            BrowseItem::Collection {
                id: "one".to_string(),
                item_type: "container",
                title: "One & only".to_string(),
            },
            BrowseItem::Collection {
                id: "two".to_string(),
                item_type: "container",
                title: "Two".to_string(),
            },
        ];

        let response = metadata_response("getMetadata", 1, 1, &items);

        assert!(response.contains(&format!(
            "<getMetadataResponse xmlns=\"{SONOS_NAMESPACE}\">"
        )));
        assert!(response.contains("<index>1</index><count>1</count><total>2</total>"));
        assert!(response.contains("<title>Two</title>"));
        assert!(!response.contains("One &amp; only"));
    }

    #[test]
    fn xml_values_are_escaped() {
        assert_eq!(
            escape_xml("AC/DC & <friends> \"live\""),
            "AC/DC &amp; &lt;friends&gt; &quot;live&quot;"
        );
    }

    #[tokio::test]
    async fn metadata_and_media_uri_use_the_current_library_and_storage() {
        let track_id = Uuid::new_v4();
        let bookmark_id = Uuid::new_v4();
        let events = vec![
            EventWithMetadata::new(
                track_id,
                Event::LibraryItemCreatedEvent {
                    name: "One & Only".to_string(),
                    artist: Some("A <B".to_string()),
                    album: Some("Album".to_string()),
                    track_number: Some(1),
                    file_path: "one and only.mp3".to_string(),
                },
            )
            .unwrap(),
            EventWithMetadata::new(track_id, Event::LibraryItemFavoritedEvent).unwrap(),
            EventWithMetadata::new(
                track_id,
                Event::LibraryItemBookmarkAddedEvent {
                    bookmark_id,
                    position: std::time::Duration::from_secs(754),
                },
            )
            .unwrap(),
        ];
        let storage = crate::storage::S3Storage::new(
            "https://s3.example.com",
            "reitunes",
            Some("music"),
            "test-key",
            "test-secret",
        )
        .await
        .unwrap();
        let state = crate::AppState {
            library: Arc::new(RwLock::new(Library::build_from_events(events))),
            playlists: Arc::new(RwLock::new(PlaylistStore::new())),
            update_tx: broadcast::channel(1).0,
            storage: Arc::new(storage),
        };

        let metadata = get_metadata(
            &state,
            r#"<ns:getMetadata><ns:id>tracks</ns:id><ns:index>0</ns:index><ns:count>10</ns:count></ns:getMetadata>"#,
        )
        .await
        .unwrap();
        assert!(metadata.contains("<count>1</count><total>1</total>"));
        assert!(metadata.contains("<title>One &amp; Only</title>"));
        assert!(metadata.contains("<artist>A &lt;B</artist>"));
        assert!(metadata.contains(&format!("<id>track:{track_id}</id>")));

        let root = get_metadata(
            &state,
            "<getMetadata><id>root</id><index>0</index><count>10</count></getMetadata>",
        )
        .await
        .unwrap();
        assert!(root.contains("<id>tracks</id>"));
        assert!(root.contains("<id>artists</id>"));
        assert!(root.contains("<id>albums</id>"));
        assert!(root.contains("<id>favorites</id>"));
        assert!(root.contains("<id>bookmarks</id>"));

        let favorites = get_metadata(
            &state,
            "<getMetadata><id>favorites</id><index>0</index><count>10</count></getMetadata>",
        )
        .await
        .unwrap();
        assert!(favorites.contains("<count>1</count><total>1</total>"));
        assert!(favorites.contains(&format!("<id>track:{track_id}</id>")));

        let bookmark_item_id = format!("bookmark:{track_id}:{bookmark_id}");
        let bookmarks = get_metadata(
            &state,
            "<getMetadata><id>bookmarks</id><index>0</index><count>10</count></getMetadata>",
        )
        .await
        .unwrap();
        assert!(bookmarks.contains("<count>1</count><total>1</total>"));
        assert!(bookmarks.contains(&format!("<id>{bookmark_item_id}</id>")));
        assert!(bookmarks.contains("One &amp; Only — 12:34"));
        assert!(bookmarks.contains("<canResume>true</canResume>"));

        let artist_id = stable_id("artist", &["A <B"]);
        let artist_tracks = get_metadata(
            &state,
            &format!(
                "<getMetadata><id>{artist_id}</id><index>0</index><count>10</count></getMetadata>"
            ),
        )
        .await
        .unwrap();
        assert!(artist_tracks.contains("<title>One &amp; Only</title>"));

        let results = search(
            &state,
            "<search><id>all</id><term>only</term><index>0</index><count>10</count></search>",
        )
        .await
        .unwrap();
        assert!(results.contains("<searchResponse"));
        assert!(results.contains("<title>One &amp; Only</title>"));
        assert!(!results.contains("bookmark:"));

        let media_uri = get_media_uri(
            &state,
            &format!("<getMediaURI><id>track:{track_id}</id></getMediaURI>"),
        )
        .await
        .unwrap();
        assert!(media_uri.contains(
            "<getMediaURIResult>https://reitunes.s3.example.com/music/one%20and%20only.mp3</getMediaURIResult>"
        ));

        let bookmark_uri = get_media_uri(
            &state,
            &format!("<getMediaURI><id>{bookmark_item_id}</id></getMediaURI>"),
        )
        .await
        .unwrap();
        assert!(bookmark_uri.contains("<offsetMillis>754000</offsetMillis>"));
        assert!(bookmark_uri.contains(&format!("<positionInformation><id>{bookmark_item_id}</id>")));

        let bookmark_metadata = get_media_metadata(
            &state,
            &format!("<getMediaMetadata><id>{bookmark_item_id}</id></getMediaMetadata>"),
        )
        .await
        .unwrap();
        assert!(bookmark_metadata.contains("One &amp; Only — 12:34"));
        assert!(bookmark_metadata.contains("<canResume>true</canResume>"));

        let collection_metadata = get_media_metadata(
            &state,
            "<getMediaMetadata><id>tracks</id></getMediaMetadata>",
        )
        .await
        .unwrap();
        assert!(collection_metadata.contains("<itemType>trackList</itemType>"));

        let extended_metadata = get_extended_metadata(
            &state,
            &format!("<getExtendedMetadata><id>track:{track_id}</id></getExtendedMetadata>"),
        )
        .await
        .unwrap();
        assert!(extended_metadata.contains("<getExtendedMetadataResult><mediaMetadata>"));
        assert!(extended_metadata.contains("<title>One &amp; Only</title>"));
    }
}
