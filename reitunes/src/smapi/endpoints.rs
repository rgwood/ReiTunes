use crate::smapi::metadata::*;
use crate::smapi::soap::{create_soap_response, SoapError};
use crate::smapi::types::*;
use reitunes_workspace::{Library, LibraryItem};
use serde_xml_rs::from_str;
use tracing::{debug, info};

pub async fn handle_get_metadata(
    state: crate::AppState,
    body: String,
) -> Result<String, SoapError> {
    info!("=== HANDLING getMetadata ===");
    debug!("Request body: {}", body);

    let request: GetMetadataRequest = extract_soap_body(&body)?;
    info!("Parsed request: {:?}", request);
    info!("Requested ID: '{}'", request.id);
    info!("Requested index: {:?}", request.index);
    info!("Requested count: {:?}", request.count);

    let library = state.library.read().await;
    info!("Library loaded, total items: {}", library.items.len());
    
    let id_parts = extract_id_components(&request.id);
    info!("ID parts after parsing: {:?}", id_parts);

    let response = match id_parts.as_slice() {
        ["root"] => {
            info!("Processing root category request");
            let collections = create_root_categories();
            info!("Created {} root categories", collections.len());
            GetMetadataResponse {
                index: 0,
                count: collections.len() as u32,
                total: collections.len() as u32,
                media_collection: Some(collections),
                media_metadata: None,
            }
        }
        ["artists"] => {
            info!("Processing artists list request");
            let artists = get_unique_artists(&library);
            info!("Found {} unique artists", artists.len());
            let collections: Vec<MediaCollection> = artists
                .into_iter()
                .map(|artist| create_collection(&format!("artist:{}", artist), &artist, false))
                .collect();
            info!("Created {} artist collections", collections.len());
            GetMetadataResponse {
                index: 0,
                count: collections.len() as u32,
                total: collections.len() as u32,
                media_collection: Some(collections),
                media_metadata: None,
            }
        }
        ["artist", artist_name] => {
            let albums = get_albums_by_artist(&library, artist_name);
            let collections: Vec<MediaCollection> = albums
                .into_iter()
                .map(|album| {
                    create_collection(
                        &format!("artist:{}:album:{}", artist_name, album),
                        &album,
                        true,
                    )
                })
                .collect();
            GetMetadataResponse {
                index: 0,
                count: collections.len() as u32,
                total: collections.len() as u32,
                media_collection: Some(collections),
                media_metadata: None,
            }
        }
        ["artist", artist_name, "album", album_name] => {
            let tracks = get_tracks_by_artist_album(&library, artist_name, album_name);
            let metadata: Vec<MediaMetadata> = tracks
                .into_iter()
                .map(|track| library_item_to_media_metadata(&track))
                .collect();
            GetMetadataResponse {
                index: 0,
                count: metadata.len() as u32,
                total: metadata.len() as u32,
                media_collection: None,
                media_metadata: Some(metadata),
            }
        }
        ["albums"] => {
            let albums = get_unique_albums(&library);
            let collections: Vec<MediaCollection> = albums
                .into_iter()
                .map(|album| create_collection(&format!("album:{}", album), &album, true))
                .collect();
            GetMetadataResponse {
                index: 0,
                count: collections.len() as u32,
                total: collections.len() as u32,
                media_collection: Some(collections),
                media_metadata: None,
            }
        }
        ["album", album_name] => {
            let tracks = get_tracks_by_album(&library, album_name);
            let metadata: Vec<MediaMetadata> = tracks
                .into_iter()
                .map(|track| library_item_to_media_metadata(&track))
                .collect();
            GetMetadataResponse {
                index: 0,
                count: metadata.len() as u32,
                total: metadata.len() as u32,
                media_collection: None,
                media_metadata: Some(metadata),
            }
        }
        ["recent"] => {
            let tracks = get_recent_tracks(&library, 50);
            let metadata: Vec<MediaMetadata> = tracks
                .into_iter()
                .map(|track| library_item_to_media_metadata(&track))
                .collect();
            GetMetadataResponse {
                index: 0,
                count: metadata.len() as u32,
                total: metadata.len() as u32,
                media_collection: None,
                media_metadata: Some(metadata),
            }
        }
        ["popular"] => {
            let tracks = get_popular_tracks(&library, 50);
            let metadata: Vec<MediaMetadata> = tracks
                .into_iter()
                .map(|track| library_item_to_media_metadata(&track))
                .collect();
            GetMetadataResponse {
                index: 0,
                count: metadata.len() as u32,
                total: metadata.len() as u32,
                media_collection: None,
                media_metadata: Some(metadata),
            }
        }
        _ => {
            tracing::error!("Unknown metadata ID pattern: {:?} (from '{}')", id_parts, request.id);
            return Err(SoapError::Internal(format!(
                "Unknown metadata ID: {}",
                request.id
            )));
        }
    };

    info!("GetMetadata response: index={}, count={}, total={}, collections={}, metadata={}", 
          response.index, response.count, response.total,
          response.media_collection.as_ref().map(|c| c.len()).unwrap_or(0),
          response.media_metadata.as_ref().map(|m| m.len()).unwrap_or(0));

    let soap_response = create_soap_response("getMetadataResponse", response)?;
    info!("getMetadata completed successfully");
    Ok(soap_response)
}

pub async fn handle_search(state: crate::AppState, body: String) -> Result<String, SoapError> {
    info!("Handling search request");

    let request: SearchRequest = extract_soap_body(&body)?;
    debug!("Search term: {}", request.term);

    let library = state.library.read().await;
    let tracks = search_tracks(&library, &request.term);

    let metadata: Vec<MediaMetadata> = tracks
        .into_iter()
        .map(|track| library_item_to_media_metadata(&track))
        .collect();

    let response = GetMetadataResponse {
        index: 0,
        count: metadata.len() as u32,
        total: metadata.len() as u32,
        media_collection: None,
        media_metadata: Some(metadata),
    };

    create_soap_response("searchResponse", response)
}

pub async fn handle_get_media_uri(
    state: crate::AppState,
    body: String,
) -> Result<String, SoapError> {
    info!("=== HANDLING getMediaURI ===");

    let request: GetMediaURIRequest = extract_soap_body(&body)?;
    info!("Media URI requested for ID: '{}'", request.id);

    let library = state.library.read().await;

    // Strip "track:" prefix if present
    let clean_id = if request.id.starts_with("track:") {
        &request.id[6..]
    } else {
        &request.id
    };

    if let Ok(track_id) = clean_id.parse::<uuid::Uuid>() {
        if let Some(track) = library.items.get(&track_id) {
            let stream_url = get_audio_stream_url(track);
            info!("Generated stream URL: '{}'", stream_url);
            let response = GetMediaURIResponse {
                result: stream_url,
            };
            return create_soap_response("getMediaURIResponse", response);
        }
    }

    Err(SoapError::Internal(format!(
        "Track not found: {}",
        request.id
    )))
}

pub async fn handle_get_extended_metadata(
    state: crate::AppState,
    body: String,
) -> Result<String, SoapError> {
    info!("Handling getExtendedMetadata request");

    let request: GetExtendedMetadataRequest = extract_soap_body(&body)?;
    debug!("Extended metadata for ID: {}", request.id);

    let library = state.library.read().await;

    // Strip "track:" prefix if present before checking for UUID
    let clean_id = if request.id.starts_with("track:") {
        &request.id[6..]
    } else {
        &request.id
    };

    if let Ok(track_id) = clean_id.parse::<uuid::Uuid>() {
        if let Some(track) = library.items.get(&track_id) {
            let metadata = library_item_to_media_metadata(track);
            let response = GetExtendedMetadataResponse {
                media_metadata: Some(metadata),
                media_collection: None,
            };
            return create_soap_response("getExtendedMetadataResponse", response);
        }
    }

    // Handle root categories and prefixed collections
    match request.id.as_str() {
        "albums" => {
            let collection = create_collection("albums", "Albums", false);
            let response = GetExtendedMetadataResponse {
                media_metadata: None,
                media_collection: Some(collection),
            };
            return create_soap_response("getExtendedMetadataResponse", response);
        }
        "artists" => {
            let collection = create_collection("artists", "Artists", false);
            let response = GetExtendedMetadataResponse {
                media_metadata: None,
                media_collection: Some(collection),
            };
            return create_soap_response("getExtendedMetadataResponse", response);
        }
        "recent" => {
            let collection = create_collection("recent", "Recent Tracks", false);
            let response = GetExtendedMetadataResponse {
                media_metadata: None,
                media_collection: Some(collection),
            };
            return create_soap_response("getExtendedMetadataResponse", response);
        }
        "popular" => {
            let collection = create_collection("popular", "Most Played", false);
            let response = GetExtendedMetadataResponse {
                media_metadata: None,
                media_collection: Some(collection),
            };
            return create_soap_response("getExtendedMetadataResponse", response);
        }
        "bookmarks" => {
            let collection = create_collection("bookmarks", "Bookmarks", false);
            let response = GetExtendedMetadataResponse {
                media_metadata: None,
                media_collection: Some(collection),
            };
            return create_soap_response("getExtendedMetadataResponse", response);
        }
        _ => {
            // If it's not a root category, it might be a prefixed collection ID
            let id_parts = extract_id_components(&request.id);
            match id_parts.as_slice() {
                [prefix, name] if *prefix == "artist" => {
                    let collection = create_collection(&request.id, name, false);
                    let response = GetExtendedMetadataResponse {
                        media_metadata: None,
                        media_collection: Some(collection),
                    };
                    return create_soap_response("getExtendedMetadataResponse", response);
                }
                [prefix, name] if *prefix == "album" => {
                    let collection = create_collection(&request.id, name, true);
                    let response = GetExtendedMetadataResponse {
                        media_metadata: None,
                        media_collection: Some(collection),
                    };
                    return create_soap_response("getExtendedMetadataResponse", response);
                }
                _ => {}
            }
        }
    }

    Err(SoapError::Internal(format!(
        "Item not found for extended metadata: {}",
        request.id
    )))
}

fn extract_soap_body<T: serde::de::DeserializeOwned>(body: &str) -> Result<T, SoapError> {
    use regex::Regex;
    use std::sync::LazyLock;
    
    info!("Parsing SOAP body with regex, length: {}", body.len());
    debug!("Full SOAP body: {}", body);
    
    // Check if this is a getMetadata request
    if body.contains("getMetadata") && !body.contains("getExtendedMetadata") {
        // Use regex to extract values - much cleaner than manual parsing
        static ID_REGEX: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"<id[^>]*>([^<]*)</id>").unwrap());
        static INDEX_REGEX: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"<index[^>]*>([^<]*)</index>").unwrap());
        static COUNT_REGEX: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"<count[^>]*>([^<]*)</count>").unwrap());
        
        let id = ID_REGEX.captures(body)
            .and_then(|cap| cap.get(1))
            .map(|m| m.as_str().to_string())
            .unwrap_or_default();
            
        let index = INDEX_REGEX.captures(body)
            .and_then(|cap| cap.get(1))
            .and_then(|m| m.as_str().parse().ok())
            .unwrap_or(0);
            
        let count = COUNT_REGEX.captures(body)
            .and_then(|cap| cap.get(1))
            .and_then(|m| m.as_str().parse().ok())
            .unwrap_or(100);
        
        info!("Extracted via regex: id='{}', index={}, count={}", id, index, count);
        
        // Create clean XML for serde
        let clean_xml = format!(
            "<getMetadata><id>{}</id><index>{}</index><count>{}</count></getMetadata>",
            id, index, count
        );
        
        return from_str(&clean_xml).map_err(SoapError::from);
    }
    
    // Check if this is a getExtendedMetadata request
    if body.contains("getExtendedMetadata") {
        static ID_REGEX: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"<id[^>]*>([^<]*)</id>").unwrap());
        
        let id = ID_REGEX.captures(body)
            .and_then(|cap| cap.get(1))
            .map(|m| m.as_str().to_string())
            .unwrap_or_default();
        
        info!("Extracted getExtendedMetadata id via regex: '{}'", id);
        
        // Create clean XML for serde
        let clean_xml = format!("<getExtendedMetadata><id>{}</id></getExtendedMetadata>", id);
        
        return from_str(&clean_xml).map_err(SoapError::from);
    }
    
    // Check if this is a getMediaURI request
    if body.contains("getMediaURI") {
        static ID_REGEX: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"<id[^>]*>([^<]*)</id>").unwrap());
        
        let id = ID_REGEX.captures(body)
            .and_then(|cap| cap.get(1))
            .map(|m| m.as_str().to_string())
            .unwrap_or_default();
        
        info!("Extracted getMediaURI id via regex: '{}'", id);
        
        // Create clean XML for serde
        let clean_xml = format!("<getMediaURI><id>{}</id></getMediaURI>", id);
        
        return from_str(&clean_xml).map_err(SoapError::from);
    }
    
    // For other methods, fall back to the original approach but with better error handling
    let body_start = body.find("<soap:Body>")
        .or_else(|| body.find("<soapenv:Body>"))
        .or_else(|| body.find("<s:Body>"))
        .or_else(|| body.find("<env:Body>"))
        .ok_or_else(|| {
            tracing::error!("No SOAP Body found. Body preview: {}", 
                &body.chars().take(200).collect::<String>());
            SoapError::Internal("No SOAP Body found".to_string())
        })?;
        
    let body_end = body.find("</soap:Body>")
        .or_else(|| body.find("</soapenv:Body>"))
        .or_else(|| body.find("</s:Body>"))
        .or_else(|| body.find("</env:Body>"))
        .ok_or_else(|| SoapError::Internal("No SOAP Body end found".to_string()))?;

    let body_content = &body[body_start..body_end];
    
    // Extract the method content
    let method_start = body_content.find('<').unwrap_or(0);
    let method_end = body_content.find('>').unwrap_or(body_content.len());
    let method_content = &body_content[method_end + 1..];
    
    from_str(method_content).map_err(SoapError::from)
}

fn get_unique_artists(library: &Library) -> Vec<String> {
    let mut artists: Vec<String> = library
        .items
        .values()
        .map(|item| item.artist.clone())
        .filter(|artist| !artist.trim().is_empty())
        .collect::<std::collections::HashSet<_>>()
        .into_iter()
        .collect();
    artists.sort();
    artists
}

fn get_unique_albums(library: &Library) -> Vec<String> {
    let mut albums: Vec<String> = library
        .items
        .values()
        .map(|item| item.album.clone())
        .filter(|album| !album.trim().is_empty())
        .collect::<std::collections::HashSet<_>>()
        .into_iter()
        .collect();
    albums.sort();
    albums
}

fn get_albums_by_artist(library: &Library, artist: &str) -> Vec<String> {
    let mut albums: Vec<String> = library
        .items
        .values()
        .filter(|item| item.artist == artist)
        .map(|item| item.album.clone())
        .collect::<std::collections::HashSet<_>>()
        .into_iter()
        .collect();
    albums.sort();
    albums
}

fn get_tracks_by_artist_album(library: &Library, artist: &str, album: &str) -> Vec<LibraryItem> {
    let mut tracks: Vec<LibraryItem> = library
        .items
        .values()
        .filter(|item| item.artist == artist && item.album == album)
        .cloned()
        .collect();
    tracks.sort_by(|a, b| a.name.cmp(&b.name));
    tracks
}

fn get_tracks_by_album(library: &Library, album: &str) -> Vec<LibraryItem> {
    let mut tracks: Vec<LibraryItem> = library
        .items
        .values()
        .filter(|item| item.album == album)
        .cloned()
        .collect();
    tracks.sort_by(|a, b| a.name.cmp(&b.name));
    tracks
}

fn get_recent_tracks(library: &Library, limit: usize) -> Vec<LibraryItem> {
    let mut tracks: Vec<LibraryItem> = library.items.values().cloned().collect();
    tracks.sort_by(|a, b| b.created_time_utc.cmp(&a.created_time_utc));
    tracks.truncate(limit);
    tracks
}

fn get_popular_tracks(library: &Library, limit: usize) -> Vec<LibraryItem> {
    let mut tracks: Vec<LibraryItem> = library.items.values().cloned().collect();
    tracks.sort_by(|a, b| b.play_count.cmp(&a.play_count));
    tracks.truncate(limit);
    tracks
}

fn search_tracks(library: &Library, term: &str) -> Vec<LibraryItem> {
    let term_lower = term.to_lowercase();
    library
        .items
        .values()
        .filter(|item| {
            item.name.to_lowercase().contains(&term_lower)
                || item.artist.to_lowercase().contains(&term_lower)
                || item.album.to_lowercase().contains(&term_lower)
        })
        .cloned()
        .collect()
}

