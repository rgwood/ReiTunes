use anyhow::{Context, Result};
use indexmap::IndexMap;
use jiff::{civil::DateTime, tz::TimeZone, Zoned};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, time::Duration};
use tracing::{info, instrument, warn};
use uuid::Uuid;

use crate::database::load_all_events_from_db;

/// Load library from database connection
pub fn load_library_from_db(conn: &Connection) -> Result<Library> {
    let start = std::time::Instant::now();
    let events = load_all_events_from_db(conn)?;
    let library = Library::build_from_events(events);
    info!(elapsed = ?start.elapsed(), "Loaded library from db");
    Ok(library)
}

/// Durations are serialized like "00:36:16.8991596" for historical reasons (.NET stuff)
/// basically we serialized them this way when saving to the database from .NET and now we're stuck with it
pub mod duration_serde_dotnet {
    use serde::{self, Deserialize, Deserializer, Serializer};
    use std::time::Duration;

    pub fn serialize<S>(duration: &Duration, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let seconds = duration.as_secs();
        let nanos = duration.subsec_nanos();
        serializer.serialize_str(&format!(
            "{:02}:{:02}:{:02}.{:09}",
            seconds / 3600,
            (seconds % 3600) / 60,
            seconds % 60,
            nanos
        ))
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<Duration, D::Error>
    where
        D: Deserializer<'de>,
    {
        let s = String::deserialize(deserializer)?;
        let parts: Vec<&str> = s.split(|c| c == ':' || c == '.').collect();
        if parts.len() != 4 {
            return Err(serde::de::Error::custom("Invalid duration format"));
        }

        let hours: u64 = parts[0].parse().map_err(serde::de::Error::custom)?;
        let minutes: u64 = parts[1].parse().map_err(serde::de::Error::custom)?;
        let seconds: u64 = parts[2].parse().map_err(serde::de::Error::custom)?;
        let nanos: u32 = parts[3].parse().map_err(serde::de::Error::custom)?;

        Ok(Duration::new(hours * 3600 + minutes * 60 + seconds, nanos))
    }
}

/// When sending durations to the frontend, we want to serialize them as (floating point) seconds
pub mod duration_serde_seconds {
    use serde::{self, Deserialize, Deserializer, Serializer};
    use std::time::Duration;

    pub fn serialize<S>(duration: &Duration, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let seconds =
            duration.as_secs() as f64 + f64::from(duration.subsec_nanos()) / 1_000_000_000.0;
        serializer.serialize_f64(seconds)
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<Duration, D::Error>
    where
        D: Deserializer<'de>,
    {
        let seconds = f64::deserialize(deserializer)?;
        let whole_seconds = seconds.trunc() as u64;
        let nanos = ((seconds.fract() * 1_000_000_000.0) as u32).min(999_999_999);
        Ok(Duration::new(whole_seconds, nanos))
    }
}

/// Database row structure for events
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct EventRow {
    pub id: Uuid,
    pub aggregate_id: Uuid,
    pub aggregate_type: String,
    pub created_time_utc: DateTime,
    pub machine_name: String,
    pub serialized: String,
}

/// Event with metadata wrapper
#[derive(Debug, Serialize, Deserialize)]
#[allow(dead_code)]
pub struct EventWithMetadata {
    pub id: Uuid,
    pub aggregate_id: Uuid,
    pub aggregate_type: String,
    pub created_time_utc: DateTime,
    pub machine_name: String,
    pub event: Event,
}

impl EventWithMetadata {
    pub fn new(library_item_id: Uuid, event: Event) -> Result<EventWithMetadata> {
        let created_time_utc = Zoned::now().with_time_zone(TimeZone::UTC).datetime();
        let event_with_metadata = EventWithMetadata {
            id: Uuid::new_v4(),
            aggregate_id: library_item_id,
            aggregate_type: "LibraryItem".to_string(),
            created_time_utc,
            machine_name: hostname::get()?.to_string_lossy().into(),
            event,
        };
        Ok(event_with_metadata)
    }

    pub fn from_row(row: EventRow) -> Result<Self> {
        let event = serde_json::from_str(&row.serialized).context("Failed to deserialize event")?;

        Ok(EventWithMetadata {
            id: row.id,
            aggregate_id: row.aggregate_id,
            aggregate_type: row.aggregate_type,
            created_time_utc: row.created_time_utc,
            machine_name: row.machine_name,
            event,
        })
    }
}

/// In-memory library containing all library items
#[derive(Clone, Default)]
pub struct Library {
    pub items: HashMap<Uuid, LibraryItem>,
}

impl Library {
    pub fn new() -> Self {
        Library {
            items: HashMap::new(),
        }
    }

    /// Get a random bookmark from the library (sonos-player specific)
    pub fn random_bookmark(&self) -> Option<(Uuid, Uuid)> {
        let all_bookmarks: Vec<(Uuid, Uuid)> = self
            .items
            .iter()
            .flat_map(|(item_id, item)| {
                item.bookmarks
                    .iter()
                    .map(move |(bookmark_id, _)| (*item_id, *bookmark_id))
            })
            .collect();

        if all_bookmarks.is_empty() {
            return None;
        }

        let random_index = rand::random::<usize>() % all_bookmarks.len();
        Some(all_bookmarks[random_index])
    }

    /// Build library from a list of events
    #[instrument(skip(events))]
    pub fn build_from_events(events: Vec<EventWithMetadata>) -> Self {
        let mut library = Library::new();
        for event in events {
            library.apply(&event);
        }
        library
    }

    /// Apply an event to update the library state
    pub fn apply(&mut self, event: &EventWithMetadata) {
        match &event.event {
            Event::LibraryItemCreatedEvent { name, file_path, artist, album } => {
                let item = LibraryItem {
                    id: event.aggregate_id,
                    name: name.clone(),
                    created_time_utc: event.created_time_utc,
                    file_path: file_path.clone(),
                    artist: artist.clone().unwrap_or_default(),
                    album: album.clone().unwrap_or_default(),
                    play_count: 0,
                    bookmarks: IndexMap::new(),
                };
                self.items.insert(item.id, item);
            }
            Event::LibraryItemPlayedEvent => {
                // Update play count or last played time if needed
                if let Some(item) = self.items.get_mut(&event.aggregate_id) {
                    item.play_count += 1;
                }
            }
            Event::LibraryItemDeletedEvent => {
                self.items.remove(&event.aggregate_id);
            }
            Event::LibraryItemNameChangedEvent { new_name } => {
                if let Some(item) = self.items.get_mut(&event.aggregate_id) {
                    item.name = new_name.clone();
                }
            }
            Event::LibraryItemFilePathChangedEvent { new_file_path } => {
                if let Some(item) = self.items.get_mut(&event.aggregate_id) {
                    item.file_path = new_file_path.clone();
                }
            }
            Event::LibraryItemArtistChangedEvent { new_artist } => {
                if let Some(item) = self.items.get_mut(&event.aggregate_id) {
                    item.artist = new_artist.clone();
                }
            }
            Event::LibraryItemAlbumChangedEvent { new_album } => {
                if let Some(item) = self.items.get_mut(&event.aggregate_id) {
                    item.album = new_album.clone();
                }
            }
            Event::LibraryItemBookmarkAddedEvent {
                bookmark_id,
                position,
            } => {
                if let Some(item) = self.items.get_mut(&event.aggregate_id) {
                    let music_emoji = vec![
                        "🎵", "🎶", "🎼", "🎧", "🎤", "🎹", "🎷", "🎺", "🎸", "🥁", "🪕", "🎻",
                    ];

                    // Hash the library item id and the bookmark id to get a consistent emoji
                    let hash = event.aggregate_id.as_u128() ^ bookmark_id.as_u128();
                    let emoji_index = (hash % music_emoji.len() as u128) as usize;

                    item.bookmarks.insert(
                        *bookmark_id,
                        Bookmark {
                            position: *position,
                            emoji: music_emoji[emoji_index].to_string(),
                        },
                    );
                    item.bookmarks
                        .sort_by(|_, v1, _, v2| Ord::cmp(&v1.position, &v2.position));
                } else {
                    warn!(
                        "Attempted to add bookmark to non-existent item: {}",
                        event.aggregate_id
                    );
                }
            }
            Event::LibraryItemBookmarkDeletedEvent { bookmark_id } => {
                if let Some(item) = self.items.get_mut(&event.aggregate_id) {
                    item.bookmarks.shift_remove(bookmark_id);
                }
            }
            Event::LibraryItemBookmarkSetEmojiEvent { bookmark_id, emoji } => {
                if let Some(item) = self.items.get_mut(&event.aggregate_id) {
                    if let Some(bookmark) = item.bookmarks.get_mut(bookmark_id) {
                        bookmark.emoji = emoji.clone();
                    }
                }
            }
        }
    }
}

/// Library event types
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "$type", rename_all_fields = "PascalCase")]
pub enum Event {
    LibraryItemPlayedEvent,
    LibraryItemCreatedEvent {
        name: String,
        artist: Option<String>,
        album: Option<String>,
        file_path: String,
    },
    LibraryItemDeletedEvent,
    LibraryItemNameChangedEvent {
        new_name: String,
    },
    LibraryItemFilePathChangedEvent {
        new_file_path: String,
    },
    LibraryItemArtistChangedEvent {
        new_artist: String,
    },
    LibraryItemAlbumChangedEvent {
        new_album: String,
    },
    LibraryItemBookmarkAddedEvent {
        bookmark_id: Uuid,
        #[serde(with = "duration_serde_dotnet")]
        position: Duration,
    },
    LibraryItemBookmarkDeletedEvent {
        bookmark_id: Uuid,
    },
    LibraryItemBookmarkSetEmojiEvent {
        bookmark_id: Uuid,
        emoji: String,
    },
}

/// Library item representation
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LibraryItem {
    pub id: Uuid,
    pub name: String,
    pub created_time_utc: DateTime,
    pub file_path: String,
    pub artist: String,
    pub album: String,
    pub play_count: u32,
    pub bookmarks: IndexMap<Uuid, Bookmark>,
}

const STORAGE_URL: &str = "https://reitunes.blob.core.windows.net/music/";

impl LibraryItem {
    pub fn url(&self) -> String {
        format!("{}{}", STORAGE_URL, self.file_path)
    }
}

/// Bookmark within a library item
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Bookmark {
    #[serde(with = "duration_serde_seconds")]
    pub position: std::time::Duration,
    pub emoji: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::save_event_to_db;
    use rusqlite::Connection;

    #[test]
    fn test_load_library_from_db() {
        // Use in-memory database for testing
        let conn = Connection::open(":memory:").unwrap();
        conn.execute_batch(include_str!("../schema.sql")).unwrap();

        let library = load_library_from_db(&conn).unwrap();

        // Empty database should result in empty library
        assert!(
            library.items.is_empty(),
            "Library should be empty for new database"
        );
    }

    #[test]
    fn test_save_and_load_events() -> Result<()> {
        // Open a connection to the temporary database
        let conn = Connection::open(":memory:")?;
        conn.execute_batch(include_str!("../schema.sql"))?;

        // Create a new library item event
        let item_id = Uuid::new_v4();
        let create_event = EventWithMetadata::new(
            item_id,
            Event::LibraryItemCreatedEvent {
                name: "Test Item".to_string(),
                file_path: "test/path.mp3".to_string(),
                artist: None,
                album: None,
            },
        )?;

        // Save the event to the database
        save_event_to_db(&conn, &create_event)?;

        // Load the library from the database
        let loaded_library = load_library_from_db(&conn)?;

        // Check if the item exists in the loaded library
        assert!(loaded_library.items.contains_key(&item_id));

        // Apply the same event to an in-memory library
        let mut in_memory_library = Library::new();
        assert_ne!(in_memory_library.items, loaded_library.items);
        in_memory_library.apply(&create_event);

        // Compare the in-memory library with the loaded library
        assert_eq!(in_memory_library.items, loaded_library.items);

        // Add a bookmark event
        let bookmark_id = Uuid::new_v4();
        let bookmark_event = EventWithMetadata::new(
            item_id,
            Event::LibraryItemBookmarkAddedEvent {
                bookmark_id,
                position: Duration::from_secs(60),
            },
        )?;

        // Save the bookmark event to the database
        save_event_to_db(&conn, &bookmark_event)?;

        // Apply the bookmark event to the in-memory library
        in_memory_library.apply(&bookmark_event);

        // Reload the library from the database
        let reloaded_library = load_library_from_db(&conn)?;

        // Compare the in-memory library with the reloaded library
        assert_eq!(in_memory_library.items, reloaded_library.items);

        Ok(())
    }
}
