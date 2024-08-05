use std::{cell::{LazyCell, OnceCell}, sync::LazyLock, vec};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_rusqlite::*;
// TODO: consider using jiff as a time library
use time::{OffsetDateTime, PrimitiveDateTime};

fn main() -> Result<()> {

    let mut library: Vec<LibraryItem> = vec![];

    let conn = rusqlite::Connection::open("test-library.db")?;
    let mut stmt = conn.prepare_cached("SELECT * FROM events ORDER BY CreatedTimeUtc LIMIT 2")?;

    let rows = from_rows::<EventRow>(stmt.query([])?);

    for row in rows {
        let row = row?;
        println!("{:?}", row.serialized);
        let event = EventWithMetadata::from_row(row)?;
        println!("{:?}", event);
    }

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


pub fn apply(event: EventWithMetadata, library: &mut Vec<LibraryItem>) {
    match event.event {
        Event::LibraryItemCreatedEvent { name, file_path } => {
            library.push(LibraryItem {
                id: uuid::Uuid::new_v4(),
                name,
                file_path,
            });
        }
        _ => {}
    }
}

pub struct EventWithRow {
    event: Event,
    row: EventRow,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(tag = "$type")]
pub enum Event {
    #[default]
    LibraryItemPlayedEvent,
    #[serde(rename_all = "PascalCase")]
    LibraryItemCreatedEvent{
        name: String,
        file_path: String,
    },
    // TODO: Add more events
}

pub struct LibraryItem {
    pub id: uuid::Uuid,
    pub name: String,
    pub file_path: String,
}



// {"$type":"LibraryItemPlayedEvent","Id":"ba6f6676-9c39-4262-b69a-1433b3b43255","AggregateId":"559146d5-4901-4e09-abd9-e732a23f8429","CreatedTimeUtc":"2020-08-15T22:52:09.8397077Z","LocalId":1,"MachineName":"SURFACESPUD"}
