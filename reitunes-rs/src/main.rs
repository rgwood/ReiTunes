use std::{collections::HashMap, sync::Arc, time::Duration};
use serde::{Deserialize, Serialize};

use anyhow::{Context, Result};
use axum::{
    extract::{Form, State}, http::StatusCode, response::{Html, Response, IntoResponse}, routing::{get, post}, Router
};
use serde_rusqlite::*;
use time::PrimitiveDateTime;
use tokio::sync::RwLock;

#[tokio::main]
async fn main() -> Result<()> {
    let library = load_library_from_db("test-library.db")?;
    let shared_state = Arc::new(RwLock::new(library));

    let app = Router::new()
        .route("/", get(index_handler))
        .route("/search", post(search_handler))
        .with_state(shared_state);

    println!("Server running on http://localhost:3000");
    axum::Server::bind(&"0.0.0.0:3000".parse().unwrap())
        .serve(app.into_make_service())
        .await
        .unwrap();

    Ok(())
}

fn load_library_from_db(db_path: &str) -> Result<Library> {
    let conn = rusqlite::Connection::open(db_path)?;
    let mut stmt = conn.prepare_cached("SELECT * FROM events e WHERE e.AggregateType == 'LibraryItem' ORDER BY CreatedTimeUtc")?;

    let start = std::time::Instant::now();

    let rows = from_rows::<EventRow>(stmt.query([])?);

    let mut events = Vec::new();
    for row in rows {
        let row = row?;
        let event = EventWithMetadata::from_row(row)?;
        events.push(event);
    }

    let ms_to_load_events = start.elapsed().as_millis();
    println!("Loaded {} events in {}ms", events.len(), ms_to_load_events);

    let start = std::time::Instant::now();
    let library = Library::build_from_events(events);
    println!("Library built with {} items in {}ms", library.items.len(), start.elapsed().as_millis());

    Ok(library)
}

async fn index_handler(State(library): State<Arc<RwLock<Library>>>) -> Html<String> {
    let library = library.read().await;
    let mut items: Vec<_> = library.items.values().collect();
    items.sort_by(|a, b| b.play_count.cmp(&a.play_count));

    let mut html = String::from(
        r###"
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>ReiTunes Library</title>
            <script src="https://unpkg.com/htmx.org@1.9.4"></script>
            <style>
                @import url('https://fonts.googleapis.com/css2?family=VT323&display=swap');
                body {
                    background-color: #000;
                    color: #0f0;
                    font-family: 'VT323', monospace;
                    margin: 0;
                    padding: 20px;
                    overflow-x: hidden;
                    overflow-y: auto;
                    box-sizing: border-box;
                }
                * {
                    box-sizing: inherit;
                }
                body::before {
                    content: "";
                    position: fixed;
                    top: 0;
                    left: 0;
                    width: 100%;
                    height: 100%;
                    opacity: 0.1;
                    z-index: -1;
                    background: 
                        linear-gradient(#0f0 1px, transparent 1px),
                        linear-gradient(90deg, #0f0 1px, transparent 1px);
                    background-size: 20px 20px;
                }
                #now-playing {
                    text-align: center;
                    font-size: 28px;
                    color: #0f0;
                    margin-bottom: 20px;
                    text-shadow: 0 0 10px #0f0;
                }
                #search {
                    width: calc(100%);
                    padding: 10px;
                    background-color: #000;
                    color: #0f0;
                    border: 1px solid #0f0;
                    font-family: 'VT323', monospace;
                    font-size: 18px;
                }
                #search::placeholder {
                    color: #030;
                }
                table {
                    width: 100%;
                    border-collapse: separate;
                    border-spacing: 0 5px;
                    table-layout: fixed;
                }
                th, td {
                    padding: 10px;
                    text-align: left;
                    border: none;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                }
                th {
                    background-color: #030;
                    color: #0f0;
                }
                th:nth-child(1), td:nth-child(1) { width: 30%; }
                th:nth-child(2), td:nth-child(2) { width: 25%; }
                th:nth-child(3), td:nth-child(3) { width: 25%; }
                th:nth-child(4), td:nth-child(4) { width: 20%; }
                tr {
                    background-color: #010;
                }
                tr:hover {
                    background-color: #020;
                    box-shadow: 0 0 10px #0f0;
                    cursor: pointer;
                }
                #player {
                    width: 100%;
                    margin-bottom: 20px;
                    background-color: #000;
                    border: 1px solid #0f0;
                }
            </style>
        </head>
        <body>
            <div id="now-playing"><span id="current-song">No song selected</span></div>
            <audio id="player" controls></audio>
            <input type="text" id="search" name="query" placeholder="SEARCH..." hx-post="/search"
                hx-trigger="input changed delay:50ms" hx-target="#library-table tbody" autocomplete="off">
            <div class="htmx-indicator">Searching...</div>
            <table id="library-table">
                <thead>
                    <tr>
                        <th>Name</th>
                        <th>Artist</th>
                        <th>Album</th>
                        <th>Play Count</th>
                    </tr>
                </thead>
                <tbody>
        "###
    );

    for item in items {
        html.push_str(&format!(
            r#"
            <tr data-url="{}">
                <td>{}</td>
                <td>{}</td>
                <td>{}</td>
                <td>{}</td>
            </tr>
            "#,
            item.url(), item.name, item.artist, item.album, item.play_count
        ));
    }

    html.push_str(
        r#"
                </tbody>
            </table>
            <script>
                const player = document.getElementById('player');
                const table = document.getElementById('library-table');
                const searchInput = document.getElementById('search');
                const currentSong = document.getElementById('current-song');

                table.addEventListener('click', (e) => {
                    const row = e.target.closest('tr');
                    if (row && row.dataset.url) {
                        player.src = row.dataset.url;
                        player.play();
                        const name = row.cells[0].textContent;
                        const artist = row.cells[1].textContent;
                        currentSong.textContent = `${name} - ${artist}`;
                    }
                });

                document.addEventListener('keydown', (e) => {
                    if (e.ctrlKey && e.key === 'f') {
                        e.preventDefault();
                        searchInput.focus();
                    }
                });
            </script>
        </body>
        </html>
        "#
    );

    Html(html)
}

#[derive(Debug, Deserialize)]
struct SearchQuery {
    query: Option<String>,
}

async fn search_handler(
    State(library): State<Arc<RwLock<Library>>>,
    Form(query): Form<SearchQuery>,
) -> Response {
    println!("Received search query: {:?}", query);

    match query.query.as_deref() {
        Some(search_term) => {
            let library = library.read().await;
            let mut filtered_items: Vec<_> = library.items.values()
                .filter(|item| {
                    item.name.to_lowercase().contains(&search_term.to_lowercase()) ||
                    item.artist.to_lowercase().contains(&search_term.to_lowercase()) ||
                    item.album.to_lowercase().contains(&search_term.to_lowercase())
                })
                .collect();

            // Sort filtered items by play count in descending order
            filtered_items.sort_by(|a, b| b.play_count.cmp(&a.play_count));

            let mut html = String::new();
            for item in filtered_items {
                html.push_str(&format!(
                    r#"
                    <tr data-url="{}">
                        <td>{}</td>
                        <td>{}</td>
                        <td>{}</td>
                        <td>{}</td>
                    </tr>
                    "#,
                    item.url(), item.name, item.artist, item.album, item.play_count
                ));
            }

            Html(html).into_response()
        },
        None => {
            println!("Error: No search query provided");
            (StatusCode::BAD_REQUEST, "No search query provided").into_response()
        }
    }
}

// Durations are serialized like "00:36:16.8991596" for historical reasons (.NET stuff)
mod duration_serde {
    use serde::{self, Deserialize, Deserializer, Serializer};
    use std::time::Duration;

    pub fn serialize<S>(duration: &Duration, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let seconds = duration.as_secs();
        let nanos = duration.subsec_nanos();
        serializer.serialize_str(&format!("{:02}:{:02}:{:02}.{:09}", seconds / 3600, (seconds % 3600) / 60, seconds % 60, nanos))
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
#[allow(dead_code)]
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
        #[serde(with = "duration_serde")]
        position: Duration,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_load_library_from_db() {
        let library = load_library_from_db("test-library.db").unwrap();
        
        assert_eq!(library.items.len(), 271, "Library should contain 271 items");

        // Check for a specific known item
        let known_item_id = uuid::Uuid::parse_str("559146d5-4901-4e09-abd9-e732a23f8429").unwrap();
        assert!(library.items.contains_key(&known_item_id), "Library should contain a known item");

        // Check that play counts are being incremented
        if let Some(item) = library.items.get(&known_item_id) {
            assert!(item.play_count > 0, "Known item should have been played at least once");
        }
    }
}
