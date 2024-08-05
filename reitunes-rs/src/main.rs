use std::{collections::HashMap, sync::Arc, time::Duration};

use anyhow::{Context, Result};
use axum::{
    extract::State,
    response::Html,
    routing::get,
    Router,
};
use serde::{Deserialize, Serialize};
use serde_rusqlite::*;
use time::PrimitiveDateTime;
use tokio::sync::RwLock;

#[tokio::main]
async fn main() -> Result<()> {
    let conn = rusqlite::Connection::open("test-library.db")?;
    let mut stmt = conn.prepare_cached("SELECT * FROM events ORDER BY CreatedTimeUtc")?;

    let mut start = std::time::Instant::now();

    let rows = from_rows::<EventRow>(stmt.query([])?);

    let mut events = Vec::new();
    for row in rows {
        let row = row?;
        let event = EventWithMetadata::from_row(row)?;
        events.push(event);
    }

    let ms_to_load_events = start.elapsed().as_millis();
    println!("Loaded {} events in {}ms", events.len(), ms_to_load_events);

    start = std::time::Instant::now();
    let library = Library::build_from_events(events);
    println!("Library built with {} items in {}ms", library.items.len(), start.elapsed().as_millis());

    let shared_state = Arc::new(RwLock::new(library));

    let app = Router::new()
        .route("/", get(index_handler))
        .with_state(shared_state);

    println!("Server running on http://localhost:3000");
    axum::Server::bind(&"0.0.0.0:3000".parse().unwrap())
        .serve(app.into_make_service())
        .await
        .unwrap();

    Ok(())
}

async fn index_handler(State(library): State<Arc<RwLock<Library>>>) -> Html<String> {
    let library = library.read().await;
    let mut html = String::from(
        r#"
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>ReiTunes Library</title>
            <style>
                body { font-family: Arial, sans-serif; margin: 0; padding: 20px; }
                table { width: 100%; border-collapse: collapse; }
                th, td { text-align: left; padding: 8px; border-bottom: 1px solid #ddd; }
                th { background-color: #f2f2f2; }
                audio { width: 250px; }
            </style>
        </head>
        <body>
            <h1>ReiTunes Library</h1>
            <table>
                <tr>
                    <th>Name</th>
                    <th>Artist</th>
                    <th>Album</th>
                    <th>Play Count</th>
                    <th>Play</th>
                </tr>
        "#
    );

    for item in library.items.values() {
        html.push_str(&format!(
            r#"
            <tr>
                <td>{}</td>
                <td>{}</td>
                <td>{}</td>
                <td>{}</td>
                <td><audio controls src="{}"></audio></td>
            </tr>
            "#,
            item.name, item.artist, item.album, item.play_count, item.url()
        ));
    }

    html.push_str(
        r#"
            </table>
        </body>
        </html>
        "#
    );

    Html(html)
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

#[derive(Clone, Default)]
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
                    artist: String::new(),
                    album: String::new(),
                    play_count: 0,
                    bookmarks: HashMap::new(),
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
            Event::LibraryItemBookmarkAddedEvent { bookmark_id, position } => {
                if let Some(item) = self.items.get_mut(&event.aggregate_id) {
                    // TODO fix this, parse duration
                    //  invalid type: string "00:36:16.8991596", expected struct Duration
                    let position: Duration = Duration::from_secs(1);
                    item.bookmarks.insert(bookmark_id, Bookmark { position, emoji: String::new() });
                }
            }
            Event::LibraryItemBookmarkDeletedEvent { bookmark_id } => {
                if let Some(item) = self.items.get_mut(&event.aggregate_id) {
                    item.bookmarks.remove(&bookmark_id);
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
        // TODO: make this a time type
        // error:  invalid type: string "00:36:16.8991596", expected struct Duration
        position: String,
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
    pub artist: String,
    pub album: String,
    pub play_count: u32,
    pub bookmarks: HashMap<uuid::Uuid, Bookmark>,
}

const STORAGE_URL: &str = "https://reitunes.blob.core.windows.net/music/";

impl LibraryItem {
    pub fn url(&self) -> String {
        format!("{}{}",STORAGE_URL, self.file_path)
    }
}

#[derive(Debug, Clone)]
pub struct Bookmark {
    pub position: std::time::Duration,
    pub emoji: String,
}

// {"$type":"LibraryItemPlayedEvent","Id":"ba6f6676-9c39-4262-b69a-1433b3b43255","AggregateId":"559146d5-4901-4e09-abd9-e732a23f8429","CreatedTimeUtc":"2020-08-15T22:52:09.8397077Z","LocalId":1,"MachineName":"SURFACESPUD"}
