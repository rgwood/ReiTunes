use crate::smapi::types::*;
use reitunes_workspace::LibraryItem;

pub fn library_item_to_media_metadata(item: &LibraryItem) -> MediaMetadata {
    let mime_type = match item.file_path.split('.').last() {
        Some("mp3") => "audio/mpeg",
        Some("flac") => "audio/flac",
        Some("m4a") => "audio/mp4",
        Some("wav") => "audio/wav",
        _ => "audio/mpeg",
    };

    MediaMetadata {
        id: item.id.to_string(),
        title: item.name.clone(),
        mime_type: mime_type.to_string(),
        item_type: "track".to_string(),
        track_metadata: Some(TrackMetadata {
            artist: item.artist.clone(),
            album: item.album.clone(),
            duration: None,     // Will be added in Phase 4
            track_number: None, // Will be added in Phase 4
        }),
    }
}

pub fn create_collection(id: &str, title: &str, can_play: bool) -> MediaCollection {
    MediaCollection {
        id: id.to_string(),
        title: title.to_string(),
        item_type: if can_play {
            "album".to_string()
        } else {
            "container".to_string()
        },
        can_play,
        can_enumerate: true,
        can_cache: true,
    }
}

pub fn get_audio_stream_url(item: &LibraryItem) -> String {
    format!(
        "https://reitunes.blob.core.windows.net/music/{}",
        item.file_path
    )
}

pub fn create_root_categories() -> Vec<MediaCollection> {
    vec![
        create_collection("artists", "Artists", false),
        create_collection("albums", "Albums", false),
        create_collection("recent", "Recent Tracks", false),
        create_collection("popular", "Most Played", false),
        create_collection("bookmarks", "Bookmarks", false),
    ]
}

pub fn extract_id_components(id: &str) -> Vec<&str> {
    if id.is_empty() || id == "root" {
        vec!["root"]
    } else {
        id.split(':').collect()
    }
}
