use anyhow::Result;
use r2d2::Pool;
use r2d2_sqlite::SqliteConnectionManager;
use reqwest::header::{HeaderMap, HeaderValue};
use rusqlite::{params, Connection};
use serde_rusqlite::*;
use std::collections::HashSet;
use tracing::{info, instrument};

use crate::library::{EventWithMetadata, EventRow};

/// Open a direct SQLite connection (used by sonos-player)
pub fn open_connection(db_path: &str) -> Result<Connection> {
    let conn = Connection::open(db_path)?;

    // pragma synchronous=normal dramatically improves performance at the cost of durability,
    // by not fsyncing after every transaction. There's a chance that committed transactions can be rolled back
    // if the system crashes before buffers are flushed (application crashes are fine). I think this is an acceptable tradeoff
    conn.execute_batch("PRAGMA synchronous=normal;")?;

    // WAL mode is good but dealing with multiple DB files is a bit annoying
    // TODO: reenable this when we're further out of development
    // conn.execute_batch("PRAGMA journal_mode=WAL;")?;

    // initialize tables if needed
    conn.execute_batch(include_str!("../schema.sql"))?;

    Ok(conn)
}

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

/// Load all events from the database
#[instrument(skip(conn))]
pub fn load_all_events_from_db(conn: &Connection) -> Result<Vec<EventWithMetadata>> {
    let mut stmt = conn.prepare_cached(
        "SELECT * FROM events e WHERE e.AggregateType == 'LibraryItem' ORDER BY CreatedTimeUtc",
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

/// Download events from remote server and save them to the database (sonos-player specific)
pub async fn download_and_save_events(conn: &mut Connection) -> Result<()> {
    info!("Downloading events");
    let mut headers = HeaderMap::new();
    let api_key: &str = match option_env!("REITUNES_API_KEY") {
        Some(password) => password,
        None => "apikey",
    };

    headers.insert("X-API-Key", HeaderValue::from_static(api_key));

    let client = reqwest::Client::new();
    let events: Vec<EventWithMetadata> = client
        .get("https://reitunes.reillywood.com/api/allevents")
        .headers(headers)
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;

    info!(event_count = events.len(), "Downloaded events");

    // Start a transaction
    let mut tx = conn.transaction()?;
    tx.set_drop_behavior(rusqlite::DropBehavior::Commit);

    // Get existing event IDs to avoid duplicates
    let mut stmt = tx.prepare_cached("SELECT Id FROM events")?;
    let existing_ids: HashSet<String> = stmt
        .query_map([], |row| row.get(0))?
        .filter_map(Result::ok)
        .collect();

    let mut stmt = tx.prepare_cached(
        "INSERT INTO events (Id, AggregateId, AggregateType, CreatedTimeUtc, MachineName, Serialized) 
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)"
    )?;

    // Only save events that don't already exist
    for event in events {
        if !existing_ids.contains(&event.id.to_string()) {
            stmt.execute(params![
                event.id.to_string(),
                event.aggregate_id.to_string(),
                event.aggregate_type,
                event.created_time_utc.to_string(),
                event.machine_name,
                serde_json::to_string(&event.event)?,
            ])?;
        }
    }

    info!("Saved events");
    Ok(())
}

/// Fetch all events from remote server (reitunes specific)
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