use anyhow::Result;
use axum::{
    extract::{Form, State},
    http::StatusCode,
    response::{Html, IntoResponse, Response, Json},
    routing::{get, post},
    Router,
};
use reitunes_rs::*;
use serde::Deserialize;
use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::info;

#[tokio::main]
async fn main() -> Result<()> {
    // Initialize tracing
    tracing_subscriber::fmt::init();
    let library = load_library_from_db("test-library.db")?;
    let shared_state = Arc::new(RwLock::new(library));

    let app = Router::new()
        .route("/", get(index_handler))
        .route("/allevents", get(all_events_handler))
        // HTMX UI endpoints
        .route("/ui/search", post(search_handler))
        .with_state(shared_state);

    let listener = tokio::net::TcpListener::bind("127.0.0.1:3000")
        .await
        .unwrap();
    info!("Server running on http://localhost:3000");
    axum::serve(listener, app).await.unwrap();

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
                th:nth-child(2), td:nth-child(2) { width: 20%; }
                th:nth-child(3), td:nth-child(3) { width: 20%; }
                th:nth-child(4), td:nth-child(4) { width: 15%; }
                th:nth-child(5), td:nth-child(5) { width: 15%; }
                .bookmark-emoji {
                    cursor: pointer;
                    margin-right: 5px;
                }
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
            <input type="text" id="search" name="query" placeholder="SEARCH..." hx-post="/ui/search"
                hx-trigger="input changed delay:50ms" hx-target="#library-table tbody" autocomplete="off">
            <div class="htmx-indicator">Searching...</div>
            <table id="library-table">
                <thead>
                    <tr>
                        <th>Name</th>
                        <th>Artist</th>
                        <th>Album</th>
                        <th>Play Count</th>
                        <th>Bookmarks</th>
                    </tr>
                </thead>
                <tbody>
        "###,
    );

    for item in items {
        let bookmarks_html = item.bookmarks.iter().map(|(_, bookmark)| {
            format!(
                r#"<span class="bookmark-emoji" data-position="{}">{}</span>"#,
                bookmark.position.as_secs(),
                bookmark.emoji.chars().next().unwrap_or('🔖')
            )
        }).collect::<Vec<_>>().join("");

        html.push_str(&format!(
            r#"
            <tr data-url="{}">
                <td>{}</td>
                <td>{}</td>
                <td>{}</td>
                <td>{}</td>
                <td>{}</td>
            </tr>
            "#,
            item.url(),
            item.name,
            item.artist,
            item.album,
            item.play_count,
            bookmarks_html
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
                        if (e.target.classList.contains('bookmark-emoji')) {
                            const position = parseFloat(e.target.dataset.position);
                            if (player.src !== row.dataset.url) {
                                player.src = row.dataset.url;
                                player.addEventListener('loadedmetadata', () => {
                                    player.currentTime = position;
                                    player.play();
                                }, { once: true });
                            } else {
                                player.currentTime = position;
                                player.play();
                            }
                        } else {
                            player.src = row.dataset.url;
                            player.play();
                        }
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

                // Function to format time as mm:ss
                function formatTime(seconds) {
                    const minutes = Math.floor(seconds / 60);
                    const remainingSeconds = Math.floor(seconds % 60);
                    return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
                }

                // Update current time display
                player.addEventListener('timeupdate', () => {
                    const currentTime = formatTime(player.currentTime);
                    const duration = formatTime(player.duration);
                    currentSong.textContent = `${currentSong.textContent.split(' - ')[0]} - ${currentTime} / ${duration}`;
                });
            </script>
        </body>
        </html>
        "#,
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
    info!("Received search query: {:?}", query);

    match query.query.as_deref() {
        Some(search_term) => {
            let library = library.read().await;
            let mut filtered_items: Vec<_> = library
                .items
                .values()
                .filter(|item| {
                    item.name
                        .to_lowercase()
                        .contains(&search_term.to_lowercase())
                        || item
                            .artist
                            .to_lowercase()
                            .contains(&search_term.to_lowercase())
                        || item
                            .album
                            .to_lowercase()
                            .contains(&search_term.to_lowercase())
                })
                .collect();

            // Sort filtered items by play count in descending order
            filtered_items.sort_by(|a, b| b.play_count.cmp(&a.play_count));

            let mut html = String::new();
            for item in filtered_items {
                let bookmarks_html = item.bookmarks.iter().map(|(_, bookmark)| {
                    format!(
                        r#"<span class="bookmark-emoji" data-position="{}">{}</span>"#,
                        bookmark.position.as_secs(),
                        bookmark.emoji.chars().next().unwrap_or('🔖')
                    )
                }).collect::<Vec<_>>().join("");

                html.push_str(&format!(
                    r#"
                    <tr data-url="{}">
                        <td>{}</td>
                        <td>{}</td>
                        <td>{}</td>
                        <td>{}</td>
                        <td>{}</td>
                    </tr>
                    "#,
                    item.url(),
                    item.name,
                    item.artist,
                    item.album,
                    item.play_count,
                    bookmarks_html
                ));
            }

            Html(html).into_response()
        }
        None => {
            tracing::error!("No search query provided");
            (StatusCode::BAD_REQUEST, "No search query provided").into_response()
        }
    }
}

async fn all_events_handler() -> Result<Json<Vec<EventWithMetadata>>, StatusCode> {
    match load_all_events_from_db("test-library.db") {
        Ok(events) => Ok(Json(events)),
        Err(e) => {
            tracing::error!("Failed to load events: {:?}", e);
            Err(StatusCode::INTERNAL_SERVER_ERROR)
        }
    }
}
