use std::{collections::HashMap, sync::Arc, time::Duration};

use anyhow::{Context, Result};
use axum::{
    extract::{Form, State}, http::StatusCode, response::{Html, Response, IntoResponse}, routing::{get, post}, Json, Router
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
        .route("/search", post(search_handler))
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
                body {
                    background: #000000 url('https://web.archive.org/web/20090830064557im_/http://www.geocities.com/Area51/Corridor/5177/stars.gif');
                    color: #00ff00;
                    font-family: 'Comic Sans MS', cursive;
                }
                h1 {
                    text-align: center;
                    font-size: 36px;
                    color: #ff00ff;
                    text-shadow: 2px 2px #ffff00;
                }
                table {
                    width: 100%;
                    border-collapse: collapse;
                }
                th, td {
                    border: 2px solid #00ffff;
                    padding: 8px;
                    text-align: left;
                }
                th {
                    background-color: #000080;
                    color: #ffffff;
                }
                tr:nth-child(even) {
                    background-color: #000033;
                }
                tr:hover {
                    background-color: #003300;
                    cursor: pointer;
                }
                #player {
                    width: 100%;
                    margin-bottom: 20px;
                }
                .blink {
                    animation: blinker 1s linear infinite;
                }
                @keyframes blinker {
                    50% { opacity: 0; }
                }
            </style>
        </head>
        <body>
            <h1><span class="blink">🎵</span> ReiTunes Library <span class="blink">🎵</span></h1>
            <audio id="player" controls></audio>
            <form hx-post="/search" hx-trigger="input changed delay:500ms" hx-target="#library-table tbody">
                <input type="text" id="search" name="query" placeholder="Search...">
            </form>
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

                table.addEventListener('click', (e) => {
                    const row = e.target.closest('tr');
                    if (row && row.dataset.url) {
                        player.src = row.dataset.url;
                        player.play();
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
            let filtered_items: Vec<_> = library.items.values()
                .filter(|item| {
                    item.name.to_lowercase().contains(&search_term.to_lowercase()) ||
                    item.artist.to_lowercase().contains(&search_term.to_lowercase()) ||
                    item.album.to_lowercase().contains(&search_term.to_lowercase())
                })
                .collect();

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
