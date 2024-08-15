use anyhow::{Context, Result};
use indexmap::IndexMap;
use jiff::{civil::DateTime, tz::TimeZone, Zoned};
use r2d2::Pool;
use r2d2_sqlite::SqliteConnectionManager;
use reqwest;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_rusqlite::*;
use std::{collections::HashMap, time::Duration};
use tracing::{info, instrument};
use uuid::Uuid;

pub fn open_connection_pool(db_path: &str) -> Result<Pool<SqliteConnectionManager>> {
    let manager = SqliteConnectionManager::file(db_path);
    let pool = Pool::new(manager)?;
    let conn = pool.get()?;

    // pragma synchronous=normal dramatically improves performance at the cost of durability,
    // by not fsyncing after every transaction. There's a chance that committed transactions can be rolled back
    // if the system crashes before buffers are flushed (application crashes are fine). I think this is an acceptable tradeoff
    // TODO: reenable this when we're further out of development
    // c.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=normal;")?;

    // initialize tables if needed
    conn.execute_batch(include_str!("../schema.sql"))?;

    Ok(pool)
}

#[instrument]
pub async fn fetch_all_events() -> Result<Vec<EventWithMetadata>> {
    let client = reqwest::Client::new();
    let response = client
        .get("https://spudnik.reillywood.com/reitunes/allevents")
        .send()
        .await?;

    let events: Vec<EventWithMetadata> = response.json().await?;
    Ok(events)
}

#[instrument]
pub fn save_event_to_db(conn: &Connection, event: &EventWithMetadata) -> Result<()> {
    let mut stmt = conn.prepare_cached(
        "INSERT INTO events (Id, AggregateId, AggregateType, CreatedTimeUtc, MachineName, Serialized) 
         VALUES (:id, :aggregate_id, :aggregate_type, :created_time_utc, :machine_name, :serialized)"
    )?;

    let serialized = serde_json::to_string(&event.event)?;
    let params = to_params_named(event)?
        .with("serialized", &serialized)?;

    stmt.execute_named(&params)?;
    Ok(())
}

#[instrument]
pub fn load_all_events_from_db(conn: &Connection) -> Result<Vec<EventWithMetadata>> {
    let mut stmt = conn.prepare_cached(
        "SELECT * FROM events e WHERE e.AggregateType == 'LibraryItem' ORDER BY CreatedTimeUtc",
    )?;

    let start = std::time::Instant::now();

    let rows = from_rows::<EventRow>(stmt.query([])?);

    let mut events = Vec::new();
    for row in rows {
        let row = row?;
        let event = EventWithMetadata::from_row(row)?;
        events.push(event);
    }

    // takes about 10ms on 13th gen i7, 3000 events
    info!(
        ms_elapsed = start.elapsed().as_millis(),
        event_count = events.len(),
        "Loaded all events from db"
    );

    Ok(events)
}

#[instrument]
pub fn load_library_from_db(conn: &Connection) -> Result<Library> {
    let events = load_all_events_from_db(conn)?;

    let start = std::time::Instant::now();
    let library = Library::build_from_events(events);
    // takes about 0.3ms on 13th gen i7, 3000 events
    info!(
        ms_elapsed = start.elapsed().as_millis(),
        "Built library from events"
    );

    Ok(library)
}

// Durations are serialized like "00:36:16.8991596" for historical reasons (.NET stuff)
// basically we serialized them this way when saving to the database from .NET and now we're stuck with it
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

// When sending durations to the frontend, we want to serialize them as (floating point) seconds
pub mod duration_serde_seconds {
    use serde::{self, Deserialize, Deserializer, Serializer};
    use std::time::Duration;

    pub fn serialize<S>(duration: &Duration, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let seconds = duration.as_secs() as f64 + f64::from(duration.subsec_nanos()) / 1_000_000_000.0;
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

// Id                                  │AggregateId                         │AggregateType│CreatedTimeUtc             │MachineName│Serialized
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct EventRow {
    id: Uuid,
    aggregate_id: Uuid,
    aggregate_type: String,
    created_time_utc: DateTime, // if starting this over again I'd probably use Zoned instead of DateTime
    machine_name: String,
    serialized: String,
}

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
        info!("Creating event, time: {:?}", created_time_utc);
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

    pub fn build_from_events(events: Vec<EventWithMetadata>) -> Self {
        let mut library = Library::new();
        for event in events {
            library.apply(event);
        }
        library
    }

    pub fn apply(&mut self, event: EventWithMetadata) {
        match event.event {
            Event::LibraryItemCreatedEvent { name, file_path } => {
                let item = LibraryItem {
                    id: event.aggregate_id,
                    name,
                    file_path,
                    artist: String::new(),
                    album: String::new(),
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
                    item.name = new_name;
                }
            }
            Event::LibraryItemFilePathChangedEvent { new_file_path } => {
                if let Some(item) = self.items.get_mut(&event.aggregate_id) {
                    item.file_path = new_file_path;
                }
            }
            Event::LibraryItemArtistChangedEvent { new_artist } => {
                if let Some(item) = self.items.get_mut(&event.aggregate_id) {
                    item.artist = new_artist;
                }
            }
            Event::LibraryItemAlbumChangedEvent { new_album } => {
                if let Some(item) = self.items.get_mut(&event.aggregate_id) {
                    item.album = new_album;
                }
            }
            Event::LibraryItemBookmarkAddedEvent {
                bookmark_id,
                position,
            } => {
                if let Some(item) = self.items.get_mut(&event.aggregate_id) {
                    item.bookmarks.insert(
                        bookmark_id,
                        Bookmark {
                            position,
                            emoji: String::new(),
                        },
                    );
                    item.bookmarks
                        .sort_by(|_, v1, _, v2| Ord::cmp(&v1.position, &v2.position));
                }
            }
            Event::LibraryItemBookmarkDeletedEvent { bookmark_id } => {
                if let Some(item) = self.items.get_mut(&event.aggregate_id) {
                    item.bookmarks.shift_remove(&bookmark_id);
                }
            }
            Event::LibraryItemBookmarkSetEmojiEvent { bookmark_id, emoji } => {
                if let Some(item) = self.items.get_mut(&event.aggregate_id) {
                    if let Some(bookmark) = item.bookmarks.get_mut(&bookmark_id) {
                        bookmark.emoji = emoji;
                    }
                }
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "$type", rename_all_fields = "PascalCase")]
pub enum Event {
    LibraryItemPlayedEvent,
    LibraryItemCreatedEvent {
        name: String,
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
        position: Duration, // in theory we could use jiff::Span but just getting seconds out of it is a bit difficult!
    },
    LibraryItemBookmarkDeletedEvent {
        bookmark_id: Uuid,
    },
    LibraryItemBookmarkSetEmojiEvent {
        bookmark_id: Uuid,
        emoji: String,
    },
}

#[derive(Debug, Clone, Serialize)]
pub struct LibraryItem {
    pub id: Uuid,
    pub name: String,
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

#[derive(Debug, Clone, Serialize)]
pub struct Bookmark {
    #[serde(with = "duration_serde_seconds")]
    pub position: std::time::Duration,
    pub emoji: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_load_library_from_db() {
        let pool = open_connection_pool("test-library.db").unwrap();
        let conn = pool.get().unwrap();
        let library = load_library_from_db(&conn).unwrap();

        assert_eq!(library.items.len(), 271, "Library should contain 271 items");

        // Check for a specific known item
        let known_item_id = Uuid::parse_str("559146d5-4901-4e09-abd9-e732a23f8429").unwrap();
        assert!(
            library.items.contains_key(&known_item_id),
            "Library should contain a known item"
        );

        // Check that play counts are being incremented
        if let Some(item) = library.items.get(&known_item_id) {
            assert!(
                item.play_count > 0,
                "Known item should have been played at least once"
            );
        }
    }
}
