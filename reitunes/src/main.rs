use anyhow::{bail, Context, Result};
use askama::Template;
use axum::extract::ws::Utf8Bytes;
use axum::http::HeaderMap;
use axum::{
    body::Body,
    extract::{ConnectInfo, DefaultBodyLimit, Form, Json as JsonExtractor, Path, State, WebSocketUpgrade},
    http::{Request, StatusCode},
    middleware::{self, Next},
    response::{Html, IntoResponse, Json, Redirect, Response},
    routing::{get, post},
    Router,
};
use axum_extra::extract::Multipart;
use axum_macros::debug_handler;
use clap::{Parser, Subcommand};
use reitunes_workspace::*;
use serde::{Deserialize, Serialize};
use vite_rs_axum_0_8::ViteServe;
use std::path::PathBuf;
use std::sync::{Arc, LazyLock};
use std::time::Duration;
use std::{fmt, net::SocketAddr};
use tokio::sync::broadcast;
use tokio::sync::RwLock;
use tower_cookies::{Cookie, CookieManagerLayer, Cookies};
use tracing::{info, instrument, warn};
use uuid::Uuid;

use crate::llm::SongMetadata;
use crate::metadata::extract_metadata;
use crate::storage::{LocalStorage, S3Storage, StorageType};

mod llm;
mod metadata;
mod storage;
mod systemd;

#[derive(vite_rs::Embed)]
#[root = "../reitunes-web"]
struct Assets;

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

    /// Disable authentication (for local development)
    #[arg(long)]
    no_auth: bool,
}

// Global flag for auth bypass
static NO_AUTH: std::sync::OnceLock<bool> = std::sync::OnceLock::new();

#[derive(Subcommand)]
enum Commands {
    /// Install this executable as a (user) systemd service
    Install,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type")]
enum LibraryUpdate {
    #[serde(rename = "update")]
    Update { item: Box<LibraryItemResponse> },
    #[serde(rename = "delete")]
    Delete { id: Uuid },
}

#[derive(Clone)]
struct AppState {
    library: Arc<RwLock<Library>>,
    playlists: Arc<RwLock<PlaylistStore>>,
    // used to broadcast updates to all connected clients
    update_tx: broadcast::Sender<LibraryUpdate>,
    // Storage backend (S3 or local)
    storage: Arc<StorageType>,
}

#[tokio::main]
async fn main() -> Result<()> {
    init_tracing();

    info!("Starting reitunes v{}", env!("CARGO_PKG_VERSION"));

    // Start Vite dev server in debug mode (provides HMR for frontend)
    #[cfg(debug_assertions)]
    let _guard = Assets::start_dev_server(true);

    let cli = Cli::parse();

    // Set global no-auth flag
    NO_AUTH.set(cli.no_auth).expect("NO_AUTH already set");
    if cli.no_auth {
        info!("Authentication disabled (--no-auth flag)");
    }

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

            // Initialize storage backend based on environment variables
            let storage: StorageType = match (
                std::env::var("S3_ENDPOINT"),
                std::env::var("S3_BUCKET"),
                std::env::var("S3_ACCESS_KEY"),
                std::env::var("S3_SECRET_KEY"),
            ) {
                (Ok(endpoint), Ok(bucket), Ok(access_key), Ok(secret_key)) => {
                    let prefix = std::env::var("S3_PREFIX").ok();
                    info!(
                        "Using S3 storage: {} / {} (prefix: {:?})",
                        endpoint, bucket, prefix
                    );
                    StorageType::S3(
                        S3Storage::new(
                            &endpoint,
                            &bucket,
                            prefix.as_deref(),
                            &access_key,
                            &secret_key,
                        )
                        .await
                        .expect("Failed to initialize S3 storage"),
                    )
                }
                _ => {
                    info!("Using local storage at {:?}", music_dir());
                    StorageType::Local(LocalStorage::new(music_dir(), "/music".to_string()))
                }
            };

            let app_state = AppState {
                library: Arc::new(RwLock::new(library)),
                playlists: Arc::new(RwLock::new(PlaylistStore::new())),
                update_tx: broadcast::channel(100).0,
                storage: Arc::new(storage),
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

            // Build vite service for frontend
            let vite = ViteServe::new(Assets::boxed());

            let app = Router::new()
                // API routes (these take priority)
                .route("/login", get(login_handler).post(login_post_handler))
                .route("/ui/update", post(update_handler))
                .route("/ui/play", post(play_handler))
                .route("/ui/delete", post(delete_handler))
                .route("/ui/{id}/bookmarks", post(add_bookmark_handler))
                .route("/ui/{id}/favorite", post(favorite_handler))
                .route("/ui/{id}/unfavorite", post(unfavorite_handler))
                .route("/ui/{id}/reload-tags", post(reload_tags_handler))
                .route("/updates", get(updates_handler))
                .route_layer(middleware::from_fn(auth))
                .layer(CookieManagerLayer::new())
                .nest("/api", api_router)
                .nest("/api", items_router)
                // Music files don't require auth (served after route_layer)
                .nest_service("/music", music_service)
                // Frontend served via vite-rs (dev server in debug, embedded in release)
                .route_service("/", vite.clone())
                .route_service("/{*path}", vite)
                .with_state(app_state);

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

/// Library item response with computed URL
#[derive(Debug, Clone, Serialize)]
struct LibraryItemResponse {
    id: Uuid,
    name: String,
    created_time_utc: jiff::civil::DateTime,
    file_path: String,
    artist: String,
    album: String,
    track_number: Option<u32>,
    play_count: u32,
    bookmarks: indexmap::IndexMap<Uuid, reitunes_workspace::Bookmark>,
    is_favorite: bool,
    url: String,
}

impl LibraryItemResponse {
    fn from_item(item: &LibraryItem, storage: &StorageType) -> Self {
        Self {
            id: item.id,
            name: item.name.clone(),
            created_time_utc: item.created_time_utc,
            file_path: item.file_path.clone(),
            artist: item.artist.clone(),
            album: item.album.clone(),
            track_number: item.track_number,
            play_count: item.play_count,
            bookmarks: item.bookmarks.clone(),
            is_favorite: item.is_favorite,
            url: storage.url(&item.file_path),
        }
    }
}

/// Get all library items as JSON (for React frontend)
#[instrument(skip(app_state))]
async fn items_handler(State(app_state): State<AppState>) -> Result<impl IntoResponse, AppError> {
    let library = app_state.library.read().await;
    let items: Vec<_> = library
        .items
        .values()
        .map(|item| LibraryItemResponse::from_item(item, &app_state.storage))
        .collect();
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
    if let Some(field) = multipart.next_field().await? {
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
        let (name, artist, album, track_number) = if metadata.has_info() {
            (
                metadata.title.unwrap_or_else(|| filename.clone()),
                metadata.artist,
                metadata.album,
                metadata.track_number,
            )
        } else {
            // Fallback to LLM for files without ID3 tags
            match llm::extract_song_metadata(&filename).await {
                Ok(llm_meta) => (llm_meta.name, llm_meta.artist, llm_meta.album, None),
                Err(e) => {
                    warn!(error = ?e, "LLM extraction failed, using filename");
                    (filename.clone(), None, None, None)
                }
            }
        };

        // Store the file
        let file_path = app_state.storage.upload(&filename, &data).await?;

        // Create the library item
        let item_id = Uuid::new_v4();
        let event = Event::LibraryItemCreatedEvent {
            name: name.clone(),
            artist: artist.clone(),
            album: album.clone(),
            track_number,
            file_path: file_path.clone(),
        };
        let event_with_metadata = EventWithMetadata::new(item_id, event)?;

        // Save and broadcast
        let conn = DB.get()?;
        save_event_to_db(&conn, &event_with_metadata)?;

        let mut library = app_state.library.write().await;
        library.apply(&event_with_metadata);

        if let Some(updated_item) = library.items.get(&item_id) {
            let response = LibraryItemResponse::from_item(updated_item, &app_state.storage);
            let _ = app_state
                .update_tx
                .send(LibraryUpdate::Update { item: Box::new(response) });
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
            if let Some(updated_item) = library.items.get(&event.aggregate_id) {
                info!(id = ?event.id, "Broadcasting updated item, event type: {:?}", event.event);
                let response = LibraryItemResponse::from_item(updated_item, &app_state.storage);
                let _ = app_state
                    .update_tx
                    .send(LibraryUpdate::Update { item: Box::new(response) });
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
        track_number: None, // LLM extraction doesn't provide track number
        file_path: request.file_path,
    };
    let event_with_metadata = EventWithMetadata::new(item_id, event)?;

    // Save the event to the database
    let conn = DB.get()?;
    save_event_to_db(&conn, &event_with_metadata)?;

    // Apply the event to the library
    let mut library = app_state.library.write().await;
    library.apply(&event_with_metadata);

    if let Some(updated_item) = library.items.get(&item_id) {
        // Broadcast the new item to all connected clients
        let response = LibraryItemResponse::from_item(updated_item, &app_state.storage);
        let _ = app_state
            .update_tx
            .send(LibraryUpdate::Update { item: Box::new(response) });
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

    if let Some(updated_item) = library.items.get(&request.id) {
        // Broadcast the updated item to all connected clients
        let response = LibraryItemResponse::from_item(updated_item, &app_state.storage);
        let _ = app_state
            .update_tx
            .send(LibraryUpdate::Update { item: Box::new(response) });
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

/// Reload ID3 tags for a library item from its file
#[instrument(skip(app_state))]
async fn reload_tags_handler(
    State(app_state): State<AppState>,
    axum::extract::Path(id): axum::extract::Path<Uuid>,
) -> Result<impl IntoResponse, AppError> {
    // Get the library item
    let library = app_state.library.read().await;
    let item = library
        .items
        .get(&id)
        .ok_or_else(|| anyhow::anyhow!("Item not found"))?;

    // Construct full file path
    let file_path = music_dir().join(&item.file_path);
    info!(file_path = ?file_path, "Reloading ID3 tags");

    // Extract metadata
    let metadata = crate::metadata::extract_metadata(&file_path)?;

    // Drop the read lock before acquiring write lock
    drop(library);

    // Apply updates for each field that has a value
    let conn = DB.get()?;

    if let Some(title) = metadata.title {
        let event = Event::LibraryItemNameChangedEvent { new_name: title };
        let event_with_metadata = EventWithMetadata::new(id, event)?;
        save_event_to_db(&conn, &event_with_metadata)?;
        app_state.library.write().await.apply(&event_with_metadata);
    }

    if let Some(artist) = metadata.artist {
        let event = Event::LibraryItemArtistChangedEvent { new_artist: artist };
        let event_with_metadata = EventWithMetadata::new(id, event)?;
        save_event_to_db(&conn, &event_with_metadata)?;
        app_state.library.write().await.apply(&event_with_metadata);
    }

    if let Some(album) = metadata.album {
        let event = Event::LibraryItemAlbumChangedEvent { new_album: album };
        let event_with_metadata = EventWithMetadata::new(id, event)?;
        save_event_to_db(&conn, &event_with_metadata)?;
        app_state.library.write().await.apply(&event_with_metadata);
    }

    // Always update track number (even if None, to clear stale data)
    let event = Event::LibraryItemTrackNumberChangedEvent {
        new_track_number: metadata.track_number,
    };
    let event_with_metadata = EventWithMetadata::new(id, event)?;
    save_event_to_db(&conn, &event_with_metadata)?;
    app_state.library.write().await.apply(&event_with_metadata);

    // Broadcast the updated item
    let library = app_state.library.read().await;
    if let Some(updated_item) = library.items.get(&id) {
        let response = LibraryItemResponse::from_item(updated_item, &app_state.storage);
        let _ = app_state
            .update_tx
            .send(LibraryUpdate::Update { item: Box::new(response) });
    }

    Ok(StatusCode::OK)
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
        "track_number" => {
            let new_track_number = if value.is_empty() {
                None
            } else {
                Some(value.parse::<u32>().context("Invalid track number")?)
            };
            Ok(Event::LibraryItemTrackNumberChangedEvent { new_track_number })
        }
        _ => bail!("Invalid field: {}", field),
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
    // Bypass auth if --no-auth flag was set
    if *NO_AUTH.get().unwrap_or(&false) {
        return Ok(next.run(req).await);
    }

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
