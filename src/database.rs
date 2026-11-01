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
    // pragma synchronous=normal dramatically improves performance at the cost of durability,
    // by not fsyncing after every transaction. There's a chance that committed transactions can be rolled back
    // if the system crashes before buffers are flushed (application crashes are fine). I think this is an acceptable tradeoff
    // This setting is per-connection, so it has to run on every connection the pool opens.
    let manager = SqliteConnectionManager::file(db_path)
        .with_init(|conn| conn.execute_batch("PRAGMA synchronous=normal;"));
    let pool = Pool::new(manager)?;
    let conn = pool.get()?;

    // WAL lets readers and the writer work at the same time, and unlike the rollback journal
    // it can't corrupt the database on power loss with synchronous=normal. This one is stored
    // in the database file, so setting it once is enough. Committed data can be sitting in the
    // -wal file: back up with sqlite3 .backup or VACUUM INTO, not by copying the .db file.
    conn.query_row("PRAGMA journal_mode=WAL;", [], |row| row.get::<_, String>(0))?;

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_pooled_connection_gets_the_sqlite_settings() -> Result<()> {
        let path = std::env::temp_dir().join(format!("reitunes-pool-{}.db", uuid::Uuid::new_v4()));
        let pool = open_connection_pool(path.to_str().unwrap())?;

        let connections = (0..pool.max_size()).map(|_| pool.get()).collect::<Result<Vec<_>, _>>()?;
        for (index, conn) in connections.iter().enumerate() {
            assert_eq!(conn.query_row("PRAGMA synchronous", [], |row| row.get::<_, i64>(0))?, 1);
            // A connection opened before the switch only notices WAL when it first touches the file.
            conn.execute("INSERT INTO sonos_playback_sessions (GroupId, SessionId) VALUES (?1, 'x')", [index.to_string()])?;
            assert_eq!(conn.query_row("PRAGMA journal_mode", [], |row| row.get::<_, String>(0))?, "wal");
        }
        let rows: i64 = connections[0].query_row("SELECT count(*) FROM sonos_playback_sessions", [], |row| row.get(0))?;
        assert_eq!(rows as u32, pool.max_size());

        drop(connections);
        drop(pool);
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
        Ok(())
    }
}
