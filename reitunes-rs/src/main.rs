use std::time::SystemTime;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_rusqlite::*;
use time::{OffsetDateTime, PrimitiveDateTime};

fn main() -> Result<()> {

    let conn = rusqlite::Connection::open("test-library.db")?;
    let mut stmt = conn.prepare_cached("SELECT * FROM events LIMIT 1")?;

    let event = from_rows::<EventRow>(stmt.query([])?)
        .next()
        .context(format!("Event not found"))??;

    println!("{:?}", event);

    Ok(())
}
// Id                                  │AggregateId                         │AggregateType│CreatedTimeUtc             │MachineName│Serialized
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct EventRow {
    id: uuid::Uuid,
    aggregate_id: uuid::Uuid,
    aggregate_type: String,
    created_time_utc: PrimitiveDateTime,
    machine_name: String,
    serialized: String,
}

// {"$type":"LibraryItemPlayedEvent","Id":"ba6f6676-9c39-4262-b69a-1433b3b43255","AggregateId":"559146d5-4901-4e09-abd9-e732a23f8429","CreatedTimeUtc":"2020-08-15T22:52:09.8397077Z","LocalId":1,"MachineName":"SURFACESPUD"}

// pub struct LibraryItemPlayedEvent {
//     id: Uuid,
//     aggregate_id: Uuid,
//     created_time_utc: DateTime<Utc>,
//     local_id: i32,
//     machine_name: String,
// }