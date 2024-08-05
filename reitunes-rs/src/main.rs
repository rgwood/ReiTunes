use std::{cell::{LazyCell, OnceCell}, sync::LazyLock, vec, collections::HashMap};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_rusqlite::*;
// TODO: consider using jiff as a time library
use time::{OffsetDateTime, PrimitiveDateTime};

fn main() -> Result<()> {
    let conn = rusqlite::Connection::open("test-library.db")?;
    let mut stmt = conn.prepare_cached("SELECT * FROM events ORDER BY CreatedTimeUtc")?;

    let rows = from_rows::<EventRow>(stmt.query([])?);

    let mut events = Vec::new();
    for row in rows {
        let row = row?;
        let event = EventWithMetadata::from_row(row)?;
        events.push(event);
    }

    let library = Library::build_from_events(events);
    println!("Library built with {} items", library.items.len());

    Ok(())
}

// Id                                  │AggregateId                         │AggregateType│CreatedTimeUtc             │MachineName│Serialized
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct EventRow {
    id: uuid::Uuid,
    aggregate_id: uuid::Uuid,
    aggregate_type: String,
    created_time_utc: PrimitiveDateTime,
    machine_name: String,
    serialized: String,
}

#[derive(Debug)]
pub struct EventWithMetadata {
    id: uuid::Uuid,
    aggregate_id: uuid::Uuid,
    aggregate_type: String,
    created_time_utc: PrimitiveDateTime,
    machine_name: String,
    event: Event,
}

impl EventWithMetadata {
    pub fn from_row(row: EventRow) -> Result<Self> {
        let event = serde_json::from_str(&row.serialized)
            .context("Failed to deserialize event")?;

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

pub struct Library {
    pub items: HashMap<uuid::Uuid, LibraryItem>,
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
                };
                self.items.insert(item.id, item);
            }
            Event::LibraryItemPlayedEvent => {
                // Update play count or last played time if needed
            }
            // TODO: Handle other event types
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "$type")]
pub enum Event {
    LibraryItemPlayedEvent,
    #[serde(rename_all = "PascalCase")]
    LibraryItemCreatedEvent {
        name: String,
        file_path: String,
    },
    LibraryItemDeletedEvent,
    #[serde(rename_all = "PascalCase")]
    LibraryItemNameChangedEvent {
        new_name: String,
    },
    #[serde(rename_all = "PascalCase")]
    LibraryItemFilePathChangedEvent {
        new_file_path: String,
    },
    #[serde(rename_all = "PascalCase")]
    LibraryItemArtistChangedEvent {
        new_artist: String,
    },
    #[serde(rename_all = "PascalCase")]
    LibraryItemAlbumChangedEvent {
        new_album: String,
    },
    #[serde(rename_all = "PascalCase")]
    LibraryItemBookmarkAddedEvent {
        bookmark_id: uuid::Uuid,
        position: std::time::Duration,
    },
    #[serde(rename_all = "PascalCase")]
    LibraryItemBookmarkDeletedEvent {
        bookmark_id: uuid::Uuid,
    },
    #[serde(rename_all = "PascalCase")]
    LibraryItemBookmarkSetEmojiEvent {
        bookmark_id: uuid::Uuid,
        emoji: String,
    },
}

impl Default for Event {
    fn default() -> Self {
        Event::LibraryItemPlayedEvent
    }
}

#[derive(Debug, Clone)]
pub struct LibraryItem {
    pub id: uuid::Uuid,
    pub name: String,
    pub file_path: String,
}

// {"$type":"LibraryItemPlayedEvent","Id":"ba6f6676-9c39-4262-b69a-1433b3b43255","AggregateId":"559146d5-4901-4e09-abd9-e732a23f8429","CreatedTimeUtc":"2020-08-15T22:52:09.8397077Z","LocalId":1,"MachineName":"SURFACESPUD"}
