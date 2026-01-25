use anyhow::{bail, Result};
use askama::Template;
use axum::extract::ws::Utf8Bytes;
use axum::http::HeaderMap;
use axum::{
    body::Body,
    extract::{ConnectInfo, DefaultBodyLimit, Form, Json as JsonExtractor, Path, State, WebSocketUpgrade},
    http::{header, Request, StatusCode, Uri},
    middleware::{self, Next},
    response::{Html, IntoResponse, Json, Redirect, Response},
    routing::{get, post},
    Router,
};
use axum_extra::extract::Multipart;
use axum_macros::debug_handler;
use clap::{Parser, Subcommand};
use reitunes_workspace::*;
use rust_embed::RustEmbed;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{Arc, LazyLock};
use std::time::Duration;
use std::{fmt, net::SocketAddr};
use tokio::sync::broadcast;
use tokio::sync::RwLock;
use tower_cookies::{Cookie, CookieManagerLayer, Cookies};
use tower_livereload::LiveReloadLayer;
use tracing::{info, instrument, warn};
use uuid::Uuid;

use crate::llm::SongMetadata;
use crate::metadata::extract_metadata;
use crate::storage::{LocalStorage, StorageBackend};

mod llm;
mod metadata;
mod storage;
mod systemd;

const DB_PATH: &str = "reitunes-library.db";
const PASSWORD: &str = match option_env!("REITUNES_PASSWORD") {
    Some(password) => password,
    None => "password",
};

const API_KEY: &str = match option_env!("REITUNES_API_KEY") {
    Some(password) => password,
    None => "apikey",
};

static PASSWORD_HASH: LazyLock<String> = LazyLock::new(|| hash_with_rotating_salt(PASSWORD));

const SESSION_COOKIE_NAME: &str = "reitunes_session";

static DB: LazyLock<r2d2::Pool<r2d2_sqlite::SqliteConnectionManager>> =
    LazyLock::new(|| open_connection_pool(DB_PATH).expect("Failed to create connection pool"));

/// Music directory for local file storage
fn music_dir() -> PathBuf {
    std::env::var("MUSIC_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("./music"))
}

#[derive(Parser)]
#[command(author, version, about, long_about = None, styles = clap_v3_style())]
struct Cli {
    #[command(subcommand)]
    command: Option<Commands>,

    /// Enable live reload for development
    #[arg(long)]
    live_reload: bool,
}

#[derive(Subcommand)]
enum Commands {
    /// Install this executable as a (user) systemd service
    Install,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type")]
enum LibraryUpdate {
    #[serde(rename = "update")]
    Update { item: LibraryItem },
    #[serde(rename = "delete")]
    Delete { id: Uuid },
}

#[derive(Clone)]
struct AppState {
    library: Arc<RwLock<Library>>,
    playlists: Arc<RwLock<PlaylistStore>>,
    // used to broadcast updates to all connected clients
    update_tx: broadcast::Sender<LibraryUpdate>,
}

#[tokio::main]
async fn main() -> Result<()> {
    init_tracing();

    info!("Starting reitunes v{}", env!("CARGO_PKG_VERSION"));

    let cli = Cli::parse();

    match cli.command {
        Some(Commands::Install) => {
            systemd::install()?;
            println!("Systemd service installed successfully.");
        }
        None => {
            // Start the web server
            let conn = DB.get()?;
            let library = load_library_from_db(&conn)?;
            // important to drop after using to return the connection to the pool
            // leaving this connection open slows writes down ~100x (from 0.2 ms to 20 ms)
            drop(conn);
            // let shared_state = Arc::new(RwLock::new(library));

            let app_state = AppState {
                library: Arc::new(RwLock::new(library)),
                playlists: Arc::new(RwLock::new(PlaylistStore::new())),
                update_tx: broadcast::channel(100).0,
            };

            let api_router = Router::new()
                .route("/add", post(add_item_handler))
                .route("/allevents", get(all_events_handler))
                .route_layer(middleware::from_fn(api_key_auth));

            // API routes that require regular auth (for React frontend)
            let items_router = Router::new()
                .route("/items", get(items_handler))
                .route("/upload", post(upload_handler))
                // Allow uploads up to 500MB
                .layer(DefaultBodyLimit::max(500 * 1024 * 1024))
                .route("/log", post(frontend_log_handler))
                .route("/playlists", get(list_playlists_handler).post(create_playlist_handler))
                .route("/playlists/{id}", axum::routing::put(rename_playlist_handler).delete(delete_playlist_handler))
                .route("/playlists/{id}/items", post(add_playlist_item_handler))
                .route("/playlists/{playlist_id}/items/{item_id}", axum::routing::delete(remove_playlist_item_handler));

            // Serve local music files
            let music_service = tower_http::services::ServeDir::new(music_dir());

            let mut app = Router::new()
                .route("/", get(index_handler))
                .route("/login", get(login_handler).post(login_post_handler))
                .route("/ui/update", post(update_handler))
                .route("/ui/play", post(play_handler))
                .route("/ui/delete", post(delete_handler))
                .route("/ui/{id}/bookmarks", post(add_bookmark_handler))
                .route("/ui/{id}/favorite", post(favorite_handler))
                .route("/ui/{id}/unfavorite", post(unfavorite_handler))
                .route("/updates", get(updates_handler))
                .route("/{*file}", get(static_handler))
                .route_layer(middleware::from_fn(auth))
                .layer(CookieManagerLayer::new())
                .nest("/api", api_router)
                .nest("/api", items_router)
                // Music files don't require auth (served after route_layer)
                .nest_service("/music", music_service)
                .with_state(app_state);

            if cli.live_reload {
                app = app.layer(LiveReloadLayer::new());
                info!("Live reload enabled");
            }

            let listener = tokio::net::TcpListener::bind("127.0.0.1:5000")
                .await
                .unwrap();
            info!("Server running on http://localhost:5000");
            // this is needed to make SocketAddr available to handlers
            let make_service = app.into_make_service_with_connect_info::<SocketAddr>();
            axum::serve(listener, make_service).await.unwrap();
        }
    }

    Ok(())
}

async fn updates_handler(
    ws: WebSocketUpgrade,
    State(app_state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
) -> impl IntoResponse {
    info!(addr = ?addr, "WebSocket upgrade request");
    ws.on_upgrade(move |socket| handle_websocket(socket, app_state.update_tx, addr))
}

async fn handle_websocket(
    mut socket: axum::extract::ws::WebSocket,
    tx: broadcast::Sender<LibraryUpdate>,
    addr: SocketAddr,
) {
    info!(addr = ?addr, "WebSocket connected");
    let mut rx = tx.subscribe();
    while let Ok(update) = rx.recv().await {
        let msg = serde_json::to_string(&update).unwrap();
        if socket
            .send(axum::extract::ws::Message::Text(Utf8Bytes::from(msg)))
            .await
            .is_err()
        {
            break;
        }
    }
}

#[derive(Template)]
#[template(path = "index.html")]
struct IndexTemplate {
    items: Vec<LibraryItem>,
}

#[instrument(skip(app_state))]
async fn index_handler(State(app_state): State<AppState>) -> Result<impl IntoResponse, AppError> {
    let library = app_state.library.read().await;
    let mut items: Vec<_> = library.items.values().cloned().collect();
    items.sort_by(|a, b| b.play_count.cmp(&a.play_count));

    let rendered = IndexTemplate { items }.render()?;
    Ok(Html(rendered))
}

async fn all_events_handler() -> Result<impl IntoResponse, AppError> {
    let conn = DB.get()?;
    let events = load_all_events_from_db(&conn)?;
    Ok(Json(events))
}

/// Receive log messages from frontend
#[derive(Debug, Deserialize)]
struct FrontendLogRequest {
    level: String,
    message: String,
    #[serde(default)]
    args: Vec<serde_json::Value>,
}

async fn frontend_log_handler(
    JsonExtractor(req): JsonExtractor<FrontendLogRequest>,
) -> StatusCode {
    let args_str = if req.args.is_empty() {
        String::new()
    } else {
        format!(" {:?}", req.args)
    };

    match req.level.as_str() {
        "error" => tracing::error!(target: "frontend", "{}{}", req.message, args_str),
        "warn" => tracing::warn!(target: "frontend", "{}{}", req.message, args_str),
        "info" => tracing::info!(target: "frontend", "{}{}", req.message, args_str),
        "debug" => tracing::debug!(target: "frontend", "{}{}", req.message, args_str),
        _ => tracing::info!(target: "frontend", "[{}] {}{}", req.level, req.message, args_str),
    }
    StatusCode::OK
}

/// Get all library items as JSON (for React frontend)
#[instrument(skip(app_state))]
async fn items_handler(State(app_state): State<AppState>) -> Result<impl IntoResponse, AppError> {
    let library = app_state.library.read().await;
    let items: Vec<_> = library.items.values().cloned().collect();
    Ok(Json(items))
}

/// Mark a library item as favorite
#[instrument(skip(app_state))]
async fn favorite_handler(
    State(app_state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<impl IntoResponse, AppError> {
    let event = Event::LibraryItemFavoritedEvent;
    let event_with_metadata = EventWithMetadata::new(id, event)?;
    save_and_broadcast_event(event_with_metadata, app_state).await?;
    Ok(StatusCode::OK)
}

/// Remove favorite from a library item
#[instrument(skip(app_state))]
async fn unfavorite_handler(
    State(app_state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<impl IntoResponse, AppError> {
    let event = Event::LibraryItemUnfavoritedEvent;
    let event_with_metadata = EventWithMetadata::new(id, event)?;
    save_and_broadcast_event(event_with_metadata, app_state).await?;
    Ok(StatusCode::OK)
}

/// Upload response with extracted metadata
#[derive(Debug, Serialize)]
struct UploadResponse {
    id: Uuid,
    name: String,
    artist: Option<String>,
    album: Option<String>,
    file_path: String,
}

/// Handle file upload with ID3 metadata extraction
#[debug_handler]
async fn upload_handler(
    State(app_state): State<AppState>,
    mut multipart: Multipart,
) -> Result<impl IntoResponse, AppError> {
    // Process uploaded file
    while let Some(field) = multipart.next_field().await? {
        let filename = field.file_name().unwrap_or("unknown").to_string();
        let data = field.bytes().await?;

        info!(filename = %filename, size = data.len(), "Received file upload");

        // Write to temp file for ID3 extraction
        let temp_dir = tempfile::tempdir()?;
        let temp_path = temp_dir.path().join(&filename);
        tokio::fs::write(&temp_path, &data).await?;

        // Extract ID3 metadata
        let metadata = match extract_metadata(&temp_path) {
            Ok(m) => m,
            Err(e) => {
                warn!(error = ?e, "Failed to extract ID3 metadata, falling back to LLM");
                crate::metadata::AudioMetadata::default()
            }
        };

        // Get name from ID3 title, or fallback to LLM, or filename
        let (name, artist, album) = if metadata.has_info() {
            (
                metadata.title.unwrap_or_else(|| filename.clone()),
                metadata.artist,
                metadata.album,
            )
        } else {
            // Fallback to LLM for files without ID3 tags
            match llm::extract_song_metadata(&filename).await {
                Ok(llm_meta) => (llm_meta.name, llm_meta.artist, llm_meta.album),
                Err(e) => {
                    warn!(error = ?e, "LLM extraction failed, using filename");
                    (filename.clone(), None, None)
                }
            }
        };

        // Store the file
        let storage = LocalStorage::new(music_dir(), "/music".to_string());
        let file_path = storage.upload(&filename, &data).await?;

        // Create the library item
        let item_id = Uuid::new_v4();
        let event = Event::LibraryItemCreatedEvent {
            name: name.clone(),
            artist: artist.clone(),
            album: album.clone(),
            file_path: file_path.clone(),
        };
        let event_with_metadata = EventWithMetadata::new(item_id, event)?;

        // Save and broadcast
        let conn = DB.get()?;
        save_event_to_db(&conn, &event_with_metadata)?;

        let mut library = app_state.library.write().await;
        library.apply(&event_with_metadata);

        if let Some(updated_item) = library.items.get(&item_id).cloned() {
            let _ = app_state
                .update_tx
                .send(LibraryUpdate::Update { item: updated_item });
        }

        return Ok(Json(UploadResponse {
            id: item_id,
            name,
            artist,
            album,
            file_path,
        }));
    }

    Err(AppError(anyhow::anyhow!("No file uploaded")))
}

// ============================================================================
// Playlist Handlers
// ============================================================================

/// List all playlists
async fn list_playlists_handler(
    State(app_state): State<AppState>,
) -> Result<impl IntoResponse, AppError> {
    let playlists = app_state.playlists.read().await;
    let active: Vec<_> = playlists.active_playlists().into_iter().cloned().collect();
    Ok(Json(active))
}

#[derive(Debug, Deserialize)]
struct CreatePlaylistRequest {
    name: String,
}

/// Create a new playlist
async fn create_playlist_handler(
    State(app_state): State<AppState>,
    JsonExtractor(request): JsonExtractor<CreatePlaylistRequest>,
) -> Result<impl IntoResponse, AppError> {
    let playlist_id = Uuid::new_v4();
    let event = PlaylistEvent::PlaylistCreatedEvent {
        name: request.name.clone(),
    };
    let event_with_metadata = PlaylistEventWithMetadata::new(playlist_id, event)?;

    // Save to database
    // Note: We're using the same events table with aggregate_type = "Playlist"
    let serialized = serde_json::to_string(&event_with_metadata.event)?;
    let conn = DB.get()?;
    conn.execute(
        "INSERT INTO events (Id, AggregateId, AggregateType, CreatedTimeUtc, MachineName, Serialized) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        rusqlite::params![
            event_with_metadata.id.to_string(),
            event_with_metadata.aggregate_id.to_string(),
            event_with_metadata.aggregate_type,
            event_with_metadata.created_time_utc.to_string(),
            event_with_metadata.machine_name,
            serialized,
        ],
    )?;

    // Apply to in-memory store
    let mut playlists = app_state.playlists.write().await;
    let playlist = Playlist::new(playlist_id, request.name, event_with_metadata.created_time_utc);
    playlists.playlists.insert(playlist_id, playlist.clone());

    Ok((StatusCode::CREATED, Json(playlist)))
}

#[derive(Debug, Deserialize)]
struct RenamePlaylistRequest {
    name: String,
}

/// Rename a playlist
async fn rename_playlist_handler(
    State(app_state): State<AppState>,
    Path(id): Path<Uuid>,
    JsonExtractor(request): JsonExtractor<RenamePlaylistRequest>,
) -> Result<impl IntoResponse, AppError> {
    let event = PlaylistEvent::PlaylistRenamedEvent {
        new_name: request.name,
    };
    let event_with_metadata = PlaylistEventWithMetadata::new(id, event.clone())?;

    // Save to database
    let serialized = serde_json::to_string(&event_with_metadata.event)?;
    let conn = DB.get()?;
    conn.execute(
        "INSERT INTO events (Id, AggregateId, AggregateType, CreatedTimeUtc, MachineName, Serialized) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        rusqlite::params![
            event_with_metadata.id.to_string(),
            event_with_metadata.aggregate_id.to_string(),
            event_with_metadata.aggregate_type,
            event_with_metadata.created_time_utc.to_string(),
            event_with_metadata.machine_name,
            serialized,
        ],
    )?;

    // Apply to in-memory store
    let mut playlists = app_state.playlists.write().await;
    if let Some(playlist) = playlists.playlists.get_mut(&id) {
        playlist.apply(&event);
    }

    Ok(StatusCode::OK)
}

/// Delete a playlist
async fn delete_playlist_handler(
    State(app_state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<impl IntoResponse, AppError> {
    let event = PlaylistEvent::PlaylistDeletedEvent;
    let event_with_metadata = PlaylistEventWithMetadata::new(id, event.clone())?;

    // Save to database
    let serialized = serde_json::to_string(&event_with_metadata.event)?;
    let conn = DB.get()?;
    conn.execute(
        "INSERT INTO events (Id, AggregateId, AggregateType, CreatedTimeUtc, MachineName, Serialized) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        rusqlite::params![
            event_with_metadata.id.to_string(),
            event_with_metadata.aggregate_id.to_string(),
            event_with_metadata.aggregate_type,
            event_with_metadata.created_time_utc.to_string(),
            event_with_metadata.machine_name,
            serialized,
        ],
    )?;

    // Apply to in-memory store
    let mut playlists = app_state.playlists.write().await;
    if let Some(playlist) = playlists.playlists.get_mut(&id) {
        playlist.apply(&event);
    }

    Ok(StatusCode::OK)
}

#[derive(Debug, Deserialize)]
struct AddPlaylistItemRequest {
    library_item_id: Uuid,
    position: Option<u32>,
}

/// Add item to a playlist
async fn add_playlist_item_handler(
    State(app_state): State<AppState>,
    Path(id): Path<Uuid>,
    JsonExtractor(request): JsonExtractor<AddPlaylistItemRequest>,
) -> Result<impl IntoResponse, AppError> {
    // Get current position if not specified
    let position = {
        let playlists = app_state.playlists.read().await;
        request.position.unwrap_or_else(|| {
            playlists
                .playlists
                .get(&id)
                .map(|p| p.items.len() as u32)
                .unwrap_or(0)
        })
    };

    let event = PlaylistEvent::PlaylistItemAddedEvent {
        library_item_id: request.library_item_id,
        position,
    };
    let event_with_metadata = PlaylistEventWithMetadata::new(id, event.clone())?;

    // Save to database
    let serialized = serde_json::to_string(&event_with_metadata.event)?;
    let conn = DB.get()?;
    conn.execute(
        "INSERT INTO events (Id, AggregateId, AggregateType, CreatedTimeUtc, MachineName, Serialized) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        rusqlite::params![
            event_with_metadata.id.to_string(),
            event_with_metadata.aggregate_id.to_string(),
            event_with_metadata.aggregate_type,
            event_with_metadata.created_time_utc.to_string(),
            event_with_metadata.machine_name,
            serialized,
        ],
    )?;

    // Apply to in-memory store
    let mut playlists = app_state.playlists.write().await;
    if let Some(playlist) = playlists.playlists.get_mut(&id) {
        playlist.apply(&event);
    }

    Ok(StatusCode::CREATED)
}

/// Remove item from a playlist
async fn remove_playlist_item_handler(
    State(app_state): State<AppState>,
    Path((playlist_id, item_id)): Path<(Uuid, Uuid)>,
) -> Result<impl IntoResponse, AppError> {
    let event = PlaylistEvent::PlaylistItemRemovedEvent {
        library_item_id: item_id,
    };
    let event_with_metadata = PlaylistEventWithMetadata::new(playlist_id, event.clone())?;

    // Save to database
    let serialized = serde_json::to_string(&event_with_metadata.event)?;
    let conn = DB.get()?;
    conn.execute(
        "INSERT INTO events (Id, AggregateId, AggregateType, CreatedTimeUtc, MachineName, Serialized) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        rusqlite::params![
            event_with_metadata.id.to_string(),
            event_with_metadata.aggregate_id.to_string(),
            event_with_metadata.aggregate_type,
            event_with_metadata.created_time_utc.to_string(),
            event_with_metadata.machine_name,
            serialized,
        ],
    )?;

    // Apply to in-memory store
    let mut playlists = app_state.playlists.write().await;
    if let Some(playlist) = playlists.playlists.get_mut(&playlist_id) {
        playlist.apply(&event);
    }

    Ok(StatusCode::OK)
}

#[allow(dead_code)]
mod filters {
    pub fn if_empty(s: &str, default: &str) -> ::askama::Result<String> {
        let ret = if s.is_empty() { default } else { s };
        Ok(ret.to_string())
    }

    pub fn or(s: &Option<String>, default: &str) -> ::askama::Result<String> {
        let ret = s.clone().unwrap_or(default.to_string());
        Ok(ret)
    }

    pub fn or_err(num: &Option<i64>) -> ::askama::Result<i64> {
        if let Some(num) = num {
            Ok(*num)
        } else {
            Err(::askama::Error::Custom("Missing value".into()))
        }
    }
}
#[derive(Debug, Deserialize)]
struct UpdateRequest {
    id: uuid::Uuid,
    field: String,
    value: String,
}

async fn update_handler(
    State(app_state): State<AppState>,
    JsonExtractor(request): JsonExtractor<UpdateRequest>,
) -> Result<impl IntoResponse, AppError> {
    let event = create_update_event(&request.field, &request.value)?;
    let event_with_metadata = EventWithMetadata::new(request.id, event)?;

    save_and_broadcast_event(event_with_metadata, app_state).await?;

    Ok(StatusCode::OK)
}

async fn save_and_broadcast_event(event: EventWithMetadata, app_state: AppState) -> Result<()> {
    // Save the event to the database
    let conn = DB.get()?;
    save_event_to_db(&conn, &event)?;

    // Apply the event to the library
    let mut library = app_state.library.write().await;
    library.apply(&event);

    match &event.event {
        Event::LibraryItemDeletedEvent => {
            info!(id = ?event.id, "Broadcasting item deletion");
            let _ = app_state.update_tx.send(LibraryUpdate::Delete {
                id: event.aggregate_id,
            });
        }
        _ => {
            if let Some(updated_item) = library.items.get(&event.aggregate_id).cloned() {
                info!(id = ?event.id, "Broadcasting updated item, event type: {:?}", event.event);
                let _ = app_state
                    .update_tx
                    .send(LibraryUpdate::Update { item: updated_item });
            }
        }
    }
    Ok(())
}

#[derive(Debug, Deserialize, Serialize)]
struct AddItemRequest {
    file_path: String,
}

#[debug_handler]
async fn add_item_handler(
    State(app_state): State<AppState>,
    JsonExtractor(request): JsonExtractor<AddItemRequest>,
) -> Result<impl IntoResponse, AppError> {
    info!(file_path = &request.file_path, "Adding new item");
    let item_id = Uuid::new_v4();

    let metadata = match llm::extract_song_metadata(&request.file_path).await {
        Ok(metadata) => metadata,
        Err(e) => {
            warn!(
                file_path = &request.file_path,
                "Failed to extract song metadata: {:?}", e
            );
            SongMetadata {
                name: request.file_path.clone(),
                artist: None,
                album: None,
            }
        }
    };

    let event = Event::LibraryItemCreatedEvent {
        name: metadata.name,
        artist: metadata.artist,
        album: metadata.album,
        file_path: request.file_path,
    };
    let event_with_metadata = EventWithMetadata::new(item_id, event)?;

    // Save the event to the database
    let conn = DB.get()?;
    save_event_to_db(&conn, &event_with_metadata)?;

    // Apply the event to the library
    let mut library = app_state.library.write().await;
    library.apply(&event_with_metadata);

    if let Some(updated_item) = library.items.get(&item_id).cloned() {
        // Broadcast the new item to all connected clients
        let _ = app_state
            .update_tx
            .send(LibraryUpdate::Update { item: updated_item });
    }

    Ok(StatusCode::CREATED)
}

#[derive(Debug, Deserialize)]
struct PlayRequest {
    id: uuid::Uuid,
}

async fn play_handler(
    State(app_state): State<AppState>,
    JsonExtractor(request): JsonExtractor<PlayRequest>,
) -> Result<impl IntoResponse, AppError> {
    let event = Event::LibraryItemPlayedEvent;
    let event_with_metadata = EventWithMetadata::new(request.id, event)?;

    // Save the event to the database
    let conn = DB.get()?;
    save_event_to_db(&conn, &event_with_metadata)?;

    // Apply the event to the library
    let mut library = app_state.library.write().await;
    library.apply(&event_with_metadata);

    if let Some(updated_item) = library.items.get(&request.id).cloned() {
        // Broadcast the updated item to all connected clients
        let _ = app_state
            .update_tx
            .send(LibraryUpdate::Update { item: updated_item });
    } else {
        warn!(id=?request.id, "Received play event for unknown item");
    }

    Ok(StatusCode::OK)
}

#[derive(Debug, Deserialize)]
struct DeleteRequest {
    id: uuid::Uuid,
}

async fn delete_handler(
    State(app_state): State<AppState>,
    JsonExtractor(request): JsonExtractor<DeleteRequest>,
) -> Result<impl IntoResponse, AppError> {
    let event = Event::LibraryItemDeletedEvent;
    let event_with_metadata = EventWithMetadata::new(request.id, event)?;

    save_and_broadcast_event(event_with_metadata, app_state).await?;

    Ok(StatusCode::OK)
}

#[derive(Debug, Deserialize)]
struct AddBookmarkRequest {
    position: f64,
}

#[instrument(skip(app_state))]
async fn add_bookmark_handler(
    State(app_state): State<AppState>,
    axum::extract::Path(id): axum::extract::Path<Uuid>,
    JsonExtractor(request): JsonExtractor<AddBookmarkRequest>,
) -> Result<impl IntoResponse, AppError> {
    let event = Event::LibraryItemBookmarkAddedEvent {
        bookmark_id: Uuid::new_v4(),
        position: Duration::from_secs_f64(request.position),
    };
    let event_with_metadata = EventWithMetadata::new(id, event)?;

    save_and_broadcast_event(event_with_metadata, app_state).await?;

    Ok(StatusCode::CREATED)
}

fn create_update_event(field: &str, value: &str) -> Result<Event> {
    match field {
        "name" => Ok(Event::LibraryItemNameChangedEvent {
            new_name: value.to_string(),
        }),
        "file_path" => Ok(Event::LibraryItemFilePathChangedEvent {
            new_file_path: value.to_string(),
        }),
        "artist" => Ok(Event::LibraryItemArtistChangedEvent {
            new_artist: value.to_string(),
        }),
        "album" => Ok(Event::LibraryItemAlbumChangedEvent {
            new_album: value.to_string(),
        }),
        _ => bail!("Invalid field: {}", field),
    }
}

async fn static_handler(uri: Uri) -> impl IntoResponse {
    let path = uri.path().trim_start_matches('/').to_string();
    StaticFile(path)
}

#[derive(RustEmbed)]
#[folder = "embed/"]
struct Asset;

pub struct StaticFile<T>(pub T);

impl<T> IntoResponse for StaticFile<T>
where
    T: Into<String>,
{
    fn into_response(self) -> Response<Body> {
        let path = self.0.into();

        match Asset::get(path.as_str()) {
            Some(content) => {
                let body = Body::from(content.data);
                let mime = mime_guess::from_path(path).first_or_octet_stream();
                Response::builder()
                    .header(header::CONTENT_TYPE, mime.as_ref())
                    .header(header::CACHE_CONTROL, "public, max-age=31536000") // 1 year
                    .body(body)
                    .unwrap()
            }
            None => Response::builder()
                .status(StatusCode::NOT_FOUND)
                .body(Body::from("404"))
                .unwrap(),
        }
    }
}

#[derive(Template)]
#[template(path = "login.html")]
struct LoginTemplate;

async fn login_handler() -> impl IntoResponse {
    let rendered = LoginTemplate.render().unwrap();
    Html(rendered)
}

// Check that the user has a valid session cookie... which is just the hashed password
// Pretty weak authentication but this is a music library for one, not a bank
async fn auth(cookies: Cookies, req: Request<Body>, next: Next) -> Result<Response, StatusCode> {
    if req.uri().path() == "/login" {
        return Ok(next.run(req).await);
    }

    if let Some(cookie) = cookies.get(SESSION_COOKIE_NAME) {
        if cookie.value() == *PASSWORD_HASH {
            return Ok(next.run(req).await);
        }
    }

    Ok(Redirect::to("/login").into_response())
}

async fn api_key_auth(
    headers: HeaderMap,
    req: Request<Body>,
    next: Next,
) -> Result<Response, StatusCode> {
    if let Some(api_key) = headers.get("X-API-Key") {
        if api_key == API_KEY {
            return Ok(next.run(req).await);
        }
    }
    Err(StatusCode::UNAUTHORIZED)
}

#[debug_handler]
async fn login_post_handler(
    cookies: Cookies,
    Form(params): Form<std::collections::HashMap<String, String>>,
) -> impl IntoResponse {
    if let Some(password) = params.get("password") {
        if password == PASSWORD {
            let mut cookie = Cookie::new(SESSION_COOKIE_NAME, PASSWORD_HASH.as_str());
            cookie.set_http_only(true);
            cookie.set_path("/");
            let one_year = tower_cookies::cookie::time::Duration::seconds(60 * 60 * 24 * 365);
            cookie.set_max_age(Some(one_year));
            cookies.add(cookie);
            return Redirect::to("/").into_response();
        }
    }
    Redirect::to("/login").into_response()
}

struct AppError(anyhow::Error);

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Something went wrong: {}", self.0),
        )
            .into_response()
    }
}

impl<E> From<E> for AppError
where
    E: Into<anyhow::Error>,
{
    fn from(err: E) -> Self {
        Self(err.into())
    }
}

impl fmt::Debug for AppError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Debug::fmt(&self.0, f)
    }
}
