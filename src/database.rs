use anyhow::Result;
use r2d2::Pool;
use r2d2_sqlite::SqliteConnectionManager;
use rusqlite::{params, Connection};
use serde_rusqlite::*;
use tracing::{info, instrument};

use crate::library::{EventRow, EventWithMetadata};
use crate::playlist::PlaylistEventWithMetadata;

/// Open a connection pool (used by reitunes web server)
pub fn open_connection_pool(db_path: &str) -> Result<Pool<SqliteConnectionManager>> {
    let manager = SqliteConnectionManager::file(db_path);
    let pool = Pool::new(manager)?;
    let conn = pool.get()?;

    // pragma synchronous=normal dramatically improves performance at the cost of durability,
    // by not fsyncing after every transaction. There's a chance that committed transactions can be rolled back
    // if the system crashes before buffers are flushed (application crashes are fine). I think this is an acceptable tradeoff
    conn.execute_batch("PRAGMA synchronous=normal;")?;

    // WAL mode is good but dealing with multiple DB files is a bit annoying
    // TODO: reenable this when we're further out of development
    // conn.execute_batch("PRAGMA journal_mode=WAL;")?;

    // initialize tables if needed
    conn.execute_batch(include_str!("../schema.sql"))?;

    Ok(pool)
}

/// Save an event to the database
pub fn save_event_to_db(conn: &Connection, event: &EventWithMetadata) -> Result<()> {
    let mut stmt = conn.prepare_cached(
        "INSERT INTO events (Id, AggregateId, AggregateType, CreatedTimeUtc, MachineName, Serialized) 
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    )?;

    stmt.execute(params![
        event.id.to_string(),
        event.aggregate_id.to_string(),
        event.aggregate_type,
        event.created_time_utc.to_string(),
        event.machine_name,
        serde_json::to_string(&event.event)?,
    ])?;

    Ok(())
}

/// Save a playlist event to the database.
pub fn save_playlist_event_to_db(
    conn: &Connection,
    event: &PlaylistEventWithMetadata,
) -> Result<()> {
    let mut stmt = conn.prepare_cached(
        "INSERT INTO events (Id, AggregateId, AggregateType, CreatedTimeUtc, MachineName, Serialized)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    )?;

    stmt.execute(params![
        event.id.to_string(),
        event.aggregate_id.to_string(),
        event.aggregate_type,
        event.created_time_utc.to_string(),
        event.machine_name,
        serde_json::to_string(&event.event)?,
    ])?;

    Ok(())
}

/// Load all events from the database
#[instrument(skip(conn))]
pub fn load_all_events_from_db(conn: &Connection) -> Result<Vec<EventWithMetadata>> {
    let mut stmt = conn.prepare_cached(
        "SELECT * FROM events e WHERE e.AggregateType == 'LibraryItem' ORDER BY CreatedTimeUtc, rowid",
    )?;

    // do the easy thing and load each row into a struct
    // can get some performance wins by only getting the columns we care about, but
    // this thing runs in sub-10ms with 3000 rows so it's not a big deal.
    let rows = from_rows::<EventRow>(stmt.query([])?);

    let mut events = Vec::new();
    for row in rows {
        let row = row?;
        let event = EventWithMetadata::from_row(row)?;
        events.push(event);
    }

    info!(event_count = events.len(), "Loaded all events from db");

    Ok(events)
}

/// Load all playlist events from the database.
#[instrument(skip(conn))]
pub fn load_all_playlist_events_from_db(
    conn: &Connection,
) -> Result<Vec<PlaylistEventWithMetadata>> {
    let mut stmt = conn.prepare_cached(
        "SELECT * FROM events e WHERE e.AggregateType == 'Playlist' ORDER BY CreatedTimeUtc, rowid",
    )?;

    let rows = from_rows::<EventRow>(stmt.query([])?);
    let mut events = Vec::new();
    for row in rows {
        events.push(PlaylistEventWithMetadata::from_row(row?)?);
    }

    info!(
        event_count = events.len(),
        "Loaded all playlist events from db"
    );
    Ok(events)
}
