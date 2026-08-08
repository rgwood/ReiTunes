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
use axum::extract::Query;
use axum_extra::extract::Multipart;
use axum_macros::debug_handler;
use clap::{Parser, Subcommand};
use reitunes_workspace::*;
use serde::{Deserialize, Serialize};
use vite_rs_axum_0_8::ViteServe;

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
use crate::storage::S3Storage;

mod llm;
mod metadata;
mod smapi;
mod sonos;
mod cloud_queue;
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

#[cfg(debug_assertions)]
const API_KEY: &str = match option_env!("REITUNES_API_KEY") {
    Some(api_key) => api_key,
    None => "development-only-api-key",
};

#[cfg(not(debug_assertions))]
const API_KEY: &str = env!(
    "REITUNES_API_KEY",
    "REITUNES_API_KEY must be set when building a release binary"
);

static PASSWORD_HASH: LazyLock<String> = LazyLock::new(|| hash_with_rotating_salt(PASSWORD));

const SESSION_COOKIE_NAME: &str = "reitunes_session";

/// URL of the downloader service that fetches audio/video from arbitrary URLs.
/// Resolved at compile time via `option_env!` (baked in via `just publish`),
/// then falling back to a runtime env var (for dev), then a hardcoded default.
fn downloader_url() -> String {
    option_env!("DOWNLOADER_URL")
        .map(String::from)
        .or_else(|| std::env::var("DOWNLOADER_URL").ok())
        .unwrap_or_else(|| "http://potato-pi:3000/download".to_string())
}

static DB: LazyLock<r2d2::Pool<r2d2_sqlite::SqliteConnectionManager>> =
    LazyLock::new(|| open_connection_pool(DB_PATH).expect("Failed to create connection pool"));

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
#[serde(tag = "type", rename_all_fields = "camelCase")]
enum FrontendUpdate {
    #[serde(rename = "update")]
    Update { item: Box<LibraryItemResponse> },
    #[serde(rename = "delete")]
    Delete { id: Uuid },
    #[serde(rename = "sonos")]
    Sonos {
        namespace: String,
        event_type: String,
        target_id: String,
        payload: serde_json::Value,
    },
}

#[derive(Clone)]
struct AppState {
    library: Arc<RwLock<Library>>,
    playlists: Arc<RwLock<PlaylistStore>>,
    // used to broadcast updates to all connected clients
    update_tx: broadcast::Sender<FrontendUpdate>,
    storage: Arc<S3Storage>,
    sonos: Option<Arc<sonos::SonosControl>>,
    cloud_queues: Arc<cloud_queue::CloudQueueStore>,
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
            let playlists = load_playlists_from_db(&conn)?;
            // important to drop after using to return the connection to the pool
            // leaving this connection open slows writes down ~100x (from 0.2 ms to 20 ms)
            drop(conn);

            // Initialize S3 storage backend
            // Try compile-time env vars first (baked in via `just publish`),
            // then fall back to runtime env vars (for dev).
            let s3_endpoint = option_env!("S3_ENDPOINT")
                .map(String::from)
                .or_else(|| std::env::var("S3_ENDPOINT").ok())
                .expect("S3_ENDPOINT must be set (compile-time or runtime)");
            let s3_bucket = option_env!("S3_BUCKET")
                .map(String::from)
                .or_else(|| std::env::var("S3_BUCKET").ok())
                .expect("S3_BUCKET must be set (compile-time or runtime)");
            let s3_access_key = option_env!("S3_ACCESS_KEY")
                .map(String::from)
                .or_else(|| std::env::var("S3_ACCESS_KEY").ok())
                .expect("S3_ACCESS_KEY must be set (compile-time or runtime)");
            let s3_secret_key = option_env!("S3_SECRET_KEY")
                .map(String::from)
                .or_else(|| std::env::var("S3_SECRET_KEY").ok())
                .expect("S3_SECRET_KEY must be set (compile-time or runtime)");
            let s3_prefix = option_env!("S3_PREFIX")
                .map(String::from)
                .or_else(|| std::env::var("S3_PREFIX").ok());

            info!(
                "Using S3 storage: {} / {} (prefix: {:?})",
                s3_endpoint, s3_bucket, s3_prefix
            );
            let storage = S3Storage::new(
                &s3_endpoint,
                &s3_bucket,
                s3_prefix.as_deref(),
                &s3_access_key,
                &s3_secret_key,
            )
            .await
            .expect("Failed to initialize S3 storage");

            let app_state = AppState {
                library: Arc::new(RwLock::new(library)),
                playlists: Arc::new(RwLock::new(playlists)),
                update_tx: broadcast::channel(100).0,
                storage: Arc::new(storage),
                sonos: sonos::SonosControl::from_env(DB.clone())?,
                cloud_queues: Arc::new(cloud_queue::CloudQueueStore::from_env(DB.clone())?),
            };

            if app_state.sonos.is_some() {
                info!("Sonos Direct Control is configured");
            } else {
                info!("Sonos Direct Control is not configured");
            }

            let api_router = Router::new()
                .route("/add", post(add_item_handler))
                .route("/allevents", get(all_events_handler))
                .route_layer(middleware::from_fn(api_key_auth));

            let smapi_router =
                Router::new().route("/v1/soap", post(smapi::smapi_soap_handler));

            let cloud_queue_router = Router::new()
                .route("/{queue_id}/v2.3/context", get(cloud_queue_context_handler))
                .route("/{queue_id}/v2.3/version", get(cloud_queue_version_handler))
                .route(
                    "/{queue_id}/v2.3/itemWindow",
                    get(cloud_queue_item_window_handler),
                )
                .route(
                    "/{queue_id}/v2.3/timePlayed",
                    post(cloud_queue_time_played_handler),
                );

            // Private API routes require the same session as the React frontend.
            let protected_api_router = Router::new()
                .route("/items", get(items_handler))
                .route("/upload", post(upload_handler))
                // Allow uploads up to 500MB
                .layer(DefaultBodyLimit::max(500 * 1024 * 1024))
                .route("/download", post(download_handler))
                .route("/log", post(frontend_log_handler))
                .route("/playlists", get(list_playlists_handler).post(create_playlist_handler))
                .route("/playlists/{id}", axum::routing::put(rename_playlist_handler).delete(delete_playlist_handler))
                .route("/playlists/{id}/items", post(add_playlist_item_handler))
                .route("/playlists/{playlist_id}/items/{item_id}", axum::routing::delete(remove_playlist_item_handler))
                .route("/sonos/status", get(sonos_status_handler))
                .route("/sonos/authorize", get(sonos_authorize_handler))
                .route("/sonos/callback", get(sonos_callback_handler))
                .route("/sonos/households", get(sonos_households_handler))
                .route("/sonos/cloud-queues", post(prepare_cloud_queue_handler))
                .route("/sonos/play", post(sonos_play_handler))
                .route(
                    "/sonos/groups/{group_id}/playback",
                    get(sonos_group_playback_handler),
                )
                .route(
                    "/sonos/groups/{group_id}/playback/play",
                    post(sonos_group_play_handler),
                )
                .route(
                    "/sonos/groups/{group_id}/playback/pause",
                    post(sonos_group_pause_handler),
                )
                .route(
                    "/sonos/groups/{group_id}/volume",
                    get(sonos_group_volume_handler).post(sonos_set_group_volume_handler),
                )
                .route(
                    "/sonos/groups/{group_id}/mute",
                    post(sonos_set_group_mute_handler),
                )
                .route(
                    "/sonos/households/{household_id}/groups",
                    get(sonos_groups_handler),
                )
                .route(
                    "/sonos/connection",
                    axum::routing::delete(sonos_disconnect_handler),
                )
                .route_layer(middleware::from_fn(api_session_auth));

            // Build vite service for frontend
            let vite = ViteServe::new(Assets::boxed());

            let app = Router::new()
                .route("/login", get(login_handler).post(login_post_handler))
                .route("/ui/update", post(update_handler))
                .route("/ui/play", post(play_handler))
                .route("/ui/delete", post(delete_handler))
                .route("/ui/{id}/bookmarks", post(add_bookmark_handler))
                .route(
                    "/ui/{item_id}/bookmarks/{bookmark_id}",
                    axum::routing::put(update_bookmark_handler)
                        .delete(delete_bookmark_handler),
                )
                .route("/ui/{id}/favorite", post(favorite_handler))
                .route("/ui/{id}/unfavorite", post(unfavorite_handler))
                .route("/updates", get(updates_handler))
                // Frontend requires auth (must be above route_layer)
                .route_service("/", vite.clone())
                .route_service("/{*path}", vite)
                .route_layer(middleware::from_fn(auth))
                // Service and API-key routes stay outside session auth.
                .route("/api/sonos/events", post(sonos_event_handler))
                .nest("/api", api_router)
                .nest("/smapi", smapi_router)
                .nest("/sonos/cloud-queue", cloud_queue_router)
                .nest("/api", protected_api_router)
                // Cookie extraction is used by both frontend and API auth middleware.
                .layer(CookieManagerLayer::new())
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
    tx: broadcast::Sender<FrontendUpdate>,
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
    fn from_item(item: &LibraryItem, storage: &S3Storage) -> Self {
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

// ============================================================================
// Sonos Direct Control
// ============================================================================

#[derive(Debug, Serialize)]
struct SonosApiError {
    error: String,
}

type SonosApiResult<T> = Result<T, (StatusCode, Json<SonosApiError>)>;

fn sonos_unavailable() -> (StatusCode, Json<SonosApiError>) {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        Json(SonosApiError {
            error: "Sonos Direct Control is not configured".to_string(),
        }),
    )
}

fn sonos_failure(error: anyhow::Error) -> (StatusCode, Json<SonosApiError>) {
    warn!(error = %error, "Sonos Direct Control request failed");
    (
        StatusCode::BAD_GATEWAY,
        Json(SonosApiError {
            error: error.to_string(),
        }),
    )
}

fn sonos_playback_failure(
    error: sonos::SonosPlaybackError,
) -> (StatusCode, Json<SonosApiError>) {
    let status = match error {
        sonos::SonosPlaybackError::TakeoverRequired
        | sonos::SonosPlaybackError::SessionEnded(_) => StatusCode::CONFLICT,
        sonos::SonosPlaybackError::Control(_) => StatusCode::BAD_GATEWAY,
    };
    warn!(error = %error, "Sonos playback request failed");
    (status, Json(SonosApiError { error: error.to_string() }))
}

fn cloud_queue_failure(
    error: cloud_queue::CloudQueueError,
) -> (StatusCode, Json<SonosApiError>) {
    let status = match &error {
        cloud_queue::CloudQueueError::NotConfigured => StatusCode::SERVICE_UNAVAILABLE,
        cloud_queue::CloudQueueError::NotFound => StatusCode::NOT_FOUND,
        cloud_queue::CloudQueueError::Unauthorized => StatusCode::UNAUTHORIZED,
        cloud_queue::CloudQueueError::InvalidRequest(_) => StatusCode::BAD_REQUEST,
        cloud_queue::CloudQueueError::Internal(_) => StatusCode::INTERNAL_SERVER_ERROR,
    };
    if status.is_server_error() {
        warn!(error = %error, "Sonos Cloud Queue request failed");
    }
    (status, Json(SonosApiError { error: error.to_string() }))
}

async fn sonos_status_handler(
    State(app_state): State<AppState>,
) -> SonosApiResult<Json<sonos::SonosStatus>> {
    match app_state.sonos {
        Some(control) => control.status().map(Json).map_err(sonos_failure),
        None => Ok(Json(sonos::SonosStatus {
            configured: false,
            connected: false,
        })),
    }
}

async fn sonos_authorize_handler(State(app_state): State<AppState>) -> SonosApiResult<Redirect> {
    let control = app_state.sonos.ok_or_else(sonos_unavailable)?;
    let url = control.authorization_url().map_err(sonos_failure)?;
    Ok(Redirect::to(url.as_str()))
}

#[derive(Debug, Deserialize)]
struct SonosCallbackQuery {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
    error_description: Option<String>,
}

async fn sonos_callback_handler(
    State(app_state): State<AppState>,
    Query(query): Query<SonosCallbackQuery>,
) -> SonosApiResult<Redirect> {
    let control = app_state.sonos.ok_or_else(sonos_unavailable)?;
    if let Some(error) = query.error {
        let description = query.error_description.unwrap_or_default();
        return Err(sonos_failure(anyhow::anyhow!(
            "Sonos authorization was denied: {error} {description}"
        )));
    }

    let code = query
        .code
        .context("Sonos callback did not contain a code")
        .map_err(sonos_failure)?;
    let state = query
        .state
        .context("Sonos callback did not contain state")
        .map_err(sonos_failure)?;
    control
        .complete_authorization(&code, &state)
        .await
        .map_err(sonos_failure)?;
    // Keep the OAuth completion marker out of the HTTP request. The embedded
    // Vite service treats query-string URLs as asset paths in production.
    Ok(Redirect::to("/#sonos=connected"))
}

fn sonos_event_rejection(reason: &str) -> (StatusCode, Json<SonosApiError>) {
    warn!(reason, "Rejected Sonos event callback");
    (
        StatusCode::UNAUTHORIZED,
        Json(SonosApiError {
            error: "Sonos event authentication failed".to_string(),
        }),
    )
}

fn sonos_event_header<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|value| value.to_str().ok())
}

async fn sonos_event_handler(
    State(app_state): State<AppState>,
    headers: HeaderMap,
    JsonExtractor(payload): JsonExtractor<serde_json::Value>,
) -> SonosApiResult<StatusCode> {
    let control = app_state.sonos.clone().ok_or_else(sonos_unavailable)?;
    let sequence_id = sonos_event_header(&headers, "X-Sonos-Event-Seq-Id")
        .ok_or_else(|| sonos_event_rejection("missing event sequence ID"))?;
    let namespace = sonos_event_header(&headers, "X-Sonos-Namespace")
        .ok_or_else(|| sonos_event_rejection("missing namespace"))?;
    let event_type = sonos_event_header(&headers, "X-Sonos-Type")
        .ok_or_else(|| sonos_event_rejection("missing event type"))?;
    let target_type = sonos_event_header(&headers, "X-Sonos-Target-Type")
        .ok_or_else(|| sonos_event_rejection("missing target type"))?;
    let target_id = sonos_event_header(&headers, "X-Sonos-Target-Value")
        .ok_or_else(|| sonos_event_rejection("missing target value"))?;
    let signature = sonos_event_header(&headers, "X-Sonos-Event-Signature")
        .ok_or_else(|| sonos_event_rejection("missing event signature"))?;

    let is_new = control
        .accept_event(
            sequence_id,
            namespace,
            event_type,
            target_type,
            target_id,
            signature,
        )
        .map_err(|error| sonos_event_rejection(&error.to_string()))?;
    if !is_new {
        return Ok(StatusCode::OK);
    }
    info!(namespace, event_type, target_id, sequence_id, "Accepted Sonos event callback");

    let frontend_payload = if namespace == "playback" && event_type == "playbackStatus" {
        let playback: sonos::SonosGroupPlayback = serde_json::from_value(payload)
            .map_err(|error| sonos_event_rejection(&error.to_string()))?;
        let response =
            sonos_group_playback_response(&app_state, &control, target_id, playback)?;
        serde_json::to_value(response).map_err(|error| sonos_failure(error.into()))?
    } else if namespace == "groupVolume" && event_type == "groupVolume" {
        let volume: sonos::SonosGroupVolume = serde_json::from_value(payload)
            .map_err(|error| sonos_event_rejection(&error.to_string()))?;
        serde_json::to_value(volume).map_err(|error| sonos_failure(error.into()))?
    } else {
        payload
    };

    let _ = app_state.update_tx.send(FrontendUpdate::Sonos {
        namespace: namespace.to_string(),
        event_type: event_type.to_string(),
        target_id: target_id.to_string(),
        payload: frontend_payload,
    });
    Ok(StatusCode::OK)
}

async fn sonos_households_handler(
    State(app_state): State<AppState>,
) -> SonosApiResult<Json<sonos::HouseholdsResponse>> {
    let control = app_state.sonos.ok_or_else(sonos_unavailable)?;
    control.households().await.map(Json).map_err(sonos_failure)
}

async fn sonos_groups_handler(
    State(app_state): State<AppState>,
    Path(household_id): Path<String>,
) -> SonosApiResult<Json<sonos::GroupsResponse>> {
    let control = app_state.sonos.ok_or_else(sonos_unavailable)?;
    control
        .groups(&household_id)
        .await
        .map(Json)
        .map_err(sonos_failure)
}

async fn sonos_disconnect_handler(State(app_state): State<AppState>) -> SonosApiResult<StatusCode> {
    let control = app_state.sonos.ok_or_else(sonos_unavailable)?;
    control.disconnect().map_err(sonos_failure)?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PrepareCloudQueueRequest {
    item_ids: Vec<Uuid>,
    start_item_id: Option<Uuid>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SonosPlayRequest {
    group_id: String,
    item_ids: Vec<Uuid>,
    start_item_id: Uuid,
    #[serde(default)]
    position_millis: u32,
    #[serde(default)]
    allow_takeover: bool,
}

async fn sonos_play_handler(
    State(app_state): State<AppState>,
    JsonExtractor(request): JsonExtractor<SonosPlayRequest>,
) -> SonosApiResult<Json<sonos::SonosPlaybackStatus>> {
    if request.group_id.trim().is_empty() {
        return Err(cloud_queue_failure(
            cloud_queue::CloudQueueError::InvalidRequest(
                "A Sonos speaker group is required".to_string(),
            ),
        ));
    }

    let control = app_state.sonos.clone().ok_or_else(sonos_unavailable)?;
    let prepared = prepare_cloud_queue(
        &app_state,
        &PrepareCloudQueueRequest {
            item_ids: request.item_ids,
            start_item_id: Some(request.start_item_id),
        },
    )
    .await?;
    let playback = app_state
        .cloud_queues
        .playback_parameters(prepared.queue_id)
        .map_err(cloud_queue_failure)?;
    let status = control
        .play_cloud_queue(
            &request.group_id,
            &playback,
            request.position_millis,
            request.allow_takeover,
        )
        .await
        .map_err(sonos_playback_failure)?;
    Ok(Json(status))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SonosGroupPlaybackResponse {
    #[serde(flatten)]
    playback: sonos::SonosGroupPlayback,
    source_item_id: Option<Uuid>,
    reitunes_session_active: bool,
}

async fn sonos_group_playback_handler(
    State(app_state): State<AppState>,
    Path(group_id): Path<String>,
) -> SonosApiResult<Json<SonosGroupPlaybackResponse>> {
    let control = app_state.sonos.clone().ok_or_else(sonos_unavailable)?;
    let playback = control
        .group_playback(&group_id)
        .await
        .map_err(sonos_failure)?;
    let response = sonos_group_playback_response(&app_state, &control, &group_id, playback)?;
    if response.reitunes_session_active {
        if let Err(error) = control.ensure_event_subscriptions(&group_id).await {
            warn!(error = %error, group_id, "Could not renew Sonos event subscriptions");
        }
    }
    Ok(Json(response))
}

fn sonos_group_playback_response(
    app_state: &AppState,
    control: &sonos::SonosControl,
    group_id: &str,
    playback: sonos::SonosGroupPlayback,
) -> SonosApiResult<SonosGroupPlaybackResponse> {
    let source_item_id = app_state
        .cloud_queues
        .source_item_id(
            playback.queue_version.as_deref(),
            playback.item_id.as_deref(),
        )
        .map_err(cloud_queue_failure)?;
    let reitunes_session_active = source_item_id.is_some()
        && control
            .has_playback_session(group_id)
            .map_err(sonos_failure)?;
    Ok(SonosGroupPlaybackResponse {
        playback,
        source_item_id,
        reitunes_session_active,
    })
}

async fn active_sonos_control(
    app_state: &AppState,
    group_id: &str,
) -> Result<Arc<sonos::SonosControl>, sonos::SonosPlaybackError> {
    let control = app_state.sonos.clone().ok_or_else(|| {
        sonos::SonosPlaybackError::Control(anyhow::anyhow!(
            "Sonos Direct Control is not configured"
        ))
    })?;
    if !control.has_playback_session(group_id)? {
        return Err(sonos::SonosPlaybackError::TakeoverRequired);
    }
    let playback = control.group_playback(group_id).await?;
    let source_item_id = app_state
        .cloud_queues
        .source_item_id(
            playback.queue_version.as_deref(),
            playback.item_id.as_deref(),
        )
        .map_err(|error| sonos::SonosPlaybackError::Control(error.into()))?;
    if source_item_id.is_none() {
        return Err(sonos::SonosPlaybackError::TakeoverRequired);
    }
    Ok(control)
}

async fn sonos_group_play_handler(
    State(app_state): State<AppState>,
    Path(group_id): Path<String>,
) -> SonosApiResult<StatusCode> {
    let control = active_sonos_control(&app_state, &group_id)
        .await
        .map_err(sonos_playback_failure)?;
    control
        .play(&group_id)
        .await
        .map_err(sonos_failure)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn sonos_group_pause_handler(
    State(app_state): State<AppState>,
    Path(group_id): Path<String>,
) -> SonosApiResult<StatusCode> {
    let control = active_sonos_control(&app_state, &group_id)
        .await
        .map_err(sonos_playback_failure)?;
    control
        .pause(&group_id)
        .await
        .map_err(sonos_failure)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn sonos_group_volume_handler(
    State(app_state): State<AppState>,
    Path(group_id): Path<String>,
) -> SonosApiResult<Json<sonos::SonosGroupVolume>> {
    let control = app_state.sonos.ok_or_else(sonos_unavailable)?;
    control
        .group_volume(&group_id)
        .await
        .map(Json)
        .map_err(sonos_failure)
}

#[derive(Debug, Deserialize)]
struct SonosSetVolumeRequest {
    volume: u8,
}

async fn sonos_set_group_volume_handler(
    State(app_state): State<AppState>,
    Path(group_id): Path<String>,
    JsonExtractor(request): JsonExtractor<SonosSetVolumeRequest>,
) -> SonosApiResult<StatusCode> {
    if request.volume > 100 {
        return Err(cloud_queue_failure(
            cloud_queue::CloudQueueError::InvalidRequest(
                "Sonos volume must be between 0 and 100".to_string(),
            ),
        ));
    }
    let control = app_state.sonos.ok_or_else(sonos_unavailable)?;
    control
        .set_group_volume(&group_id, request.volume)
        .await
        .map_err(sonos_failure)?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Deserialize)]
struct SonosSetMuteRequest {
    muted: bool,
}

async fn sonos_set_group_mute_handler(
    State(app_state): State<AppState>,
    Path(group_id): Path<String>,
    JsonExtractor(request): JsonExtractor<SonosSetMuteRequest>,
) -> SonosApiResult<StatusCode> {
    let control = app_state.sonos.ok_or_else(sonos_unavailable)?;
    control
        .set_group_mute(&group_id, request.muted)
        .await
        .map_err(sonos_failure)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn prepare_cloud_queue_handler(
    State(app_state): State<AppState>,
    JsonExtractor(request): JsonExtractor<PrepareCloudQueueRequest>,
) -> SonosApiResult<(StatusCode, Json<cloud_queue::PreparedQueue>)> {
    let prepared = prepare_cloud_queue(&app_state, &request).await?;
    Ok((StatusCode::CREATED, Json(prepared)))
}

async fn prepare_cloud_queue(
    app_state: &AppState,
    request: &PrepareCloudQueueRequest,
) -> SonosApiResult<cloud_queue::PreparedQueue> {
    if request.item_ids.len() > 500 {
        return Err(cloud_queue_failure(
            cloud_queue::CloudQueueError::InvalidRequest(
                "A Sonos queue cannot contain more than 500 tracks".to_string(),
            ),
        ));
    }

    let library = app_state.library.read().await;
    let mut tracks = Vec::with_capacity(request.item_ids.len());
    for item_id in &request.item_ids {
        let item = library.items.get(item_id).ok_or_else(|| {
            cloud_queue_failure(cloud_queue::CloudQueueError::InvalidRequest(format!(
                "Library item {item_id} was not found"
            )))
        })?;
        tracks.push(cloud_queue::QueueTrack {
            source_id: *item_id,
            queue_item_id: Uuid::new_v4(),
            name: item.name.clone(),
            artist: non_empty_string(&item.artist),
            album: non_empty_string(&item.album),
            track_number: item.track_number,
            media_url: app_state.storage.url(&item.file_path),
            content_type: mime_guess::from_path(&item.file_path)
                .first_or_octet_stream()
                .essence_str()
                .to_string(),
        });
    }
    drop(library);

    let prepared = app_state
        .cloud_queues
        .prepare(tracks, request.start_item_id)
        .map_err(cloud_queue_failure)?;
    Ok(prepared)
}

async fn cloud_queue_context_handler(
    State(app_state): State<AppState>,
    Path(queue_id): Path<Uuid>,
    headers: HeaderMap,
) -> SonosApiResult<Json<cloud_queue::QueueContext>> {
    app_state
        .cloud_queues
        .context(queue_id, authorization_header(&headers))
        .map(Json)
        .map_err(cloud_queue_failure)
}

async fn cloud_queue_version_handler(
    State(app_state): State<AppState>,
    Path(queue_id): Path<Uuid>,
    headers: HeaderMap,
) -> SonosApiResult<Json<cloud_queue::QueueVersion>> {
    app_state
        .cloud_queues
        .version(queue_id, authorization_header(&headers))
        .map(Json)
        .map_err(cloud_queue_failure)
}

async fn cloud_queue_item_window_handler(
    State(app_state): State<AppState>,
    Path(queue_id): Path<Uuid>,
    headers: HeaderMap,
    Query(query): Query<cloud_queue::ItemWindowQuery>,
) -> SonosApiResult<Json<cloud_queue::ItemWindow>> {
    app_state
        .cloud_queues
        .item_window(queue_id, authorization_header(&headers), &query)
        .map(Json)
        .map_err(cloud_queue_failure)
}

async fn cloud_queue_time_played_handler(
    State(app_state): State<AppState>,
    Path(queue_id): Path<Uuid>,
    headers: HeaderMap,
    JsonExtractor(_report): JsonExtractor<serde_json::Value>,
) -> SonosApiResult<StatusCode> {
    app_state
        .cloud_queues
        .accept_report(queue_id, authorization_header(&headers))
        .map_err(cloud_queue_failure)?;
    Ok(StatusCode::NO_CONTENT)
}

fn authorization_header(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
}

fn non_empty_string(value: &str) -> Option<String> {
    (!value.trim().is_empty()).then(|| value.to_string())
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
                .send(FrontendUpdate::Update { item: Box::new(response) });
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

/// Request body for `/api/download`
#[derive(Debug, Deserialize, Serialize)]
struct DownloadRequest {
    url: String,
    dl_type: String,
}

/// Forward a request to the downloader service running on `potato-pi`, which
/// queues the download and pushes the finished track into ReiTunes itself.
#[debug_handler]
async fn download_handler(
    JsonExtractor(req): JsonExtractor<DownloadRequest>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    if req.url.trim().is_empty() {
        return Err((StatusCode::BAD_REQUEST, "URL must not be empty".to_string()));
    }
    if !(req.url.starts_with("http://") || req.url.starts_with("https://")) {
        return Err((
            StatusCode::BAD_REQUEST,
            "URL must start with http:// or https://".to_string(),
        ));
    }

    let client = reqwest::Client::new();
    let response = client
        .post(downloader_url())
        .json(&req)
        .send()
        .await
        .map_err(|e| {
            warn!(error = %e, "Failed to reach downloader service");
            (
                StatusCode::BAD_GATEWAY,
                format!("Failed to reach downloader service: {e}"),
            )
        })?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();

    if !status.is_success() {
        warn!(status = %status, body = %body, "Downloader service returned an error");
        return Err((
            StatusCode::BAD_GATEWAY,
            format!("Downloader service error ({status}): {body}"),
        ));
    }

    Ok(body)
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

    let conn = DB.get()?;
    save_playlist_event_to_db(&conn, &event_with_metadata)?;

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

    let conn = DB.get()?;
    save_playlist_event_to_db(&conn, &event_with_metadata)?;

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

    let conn = DB.get()?;
    save_playlist_event_to_db(&conn, &event_with_metadata)?;

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

    let conn = DB.get()?;
    save_playlist_event_to_db(&conn, &event_with_metadata)?;

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

    let conn = DB.get()?;
    save_playlist_event_to_db(&conn, &event_with_metadata)?;

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
            let _ = app_state.update_tx.send(FrontendUpdate::Delete {
                id: event.aggregate_id,
            });
        }
        _ => {
            if let Some(updated_item) = library.items.get(&event.aggregate_id) {
                info!(id = ?event.id, "Broadcasting updated item, event type: {:?}", event.event);
                let response = LibraryItemResponse::from_item(updated_item, &app_state.storage);
                let _ = app_state
                    .update_tx
                    .send(FrontendUpdate::Update { item: Box::new(response) });
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
            .send(FrontendUpdate::Update { item: Box::new(response) });
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
            .send(FrontendUpdate::Update { item: Box::new(response) });
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
    #[serde(default)]
    label: Option<String>,
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
        label: clean_bookmark_label(request.label),
    };
    let event_with_metadata = EventWithMetadata::new(id, event)?;

    save_and_broadcast_event(event_with_metadata, app_state).await?;

    Ok(StatusCode::CREATED)
}

#[derive(Debug, Deserialize)]
struct UpdateBookmarkRequest {
    label: Option<String>,
    emoji: String,
}

#[instrument(skip(app_state))]
async fn update_bookmark_handler(
    State(app_state): State<AppState>,
    Path((item_id, bookmark_id)): Path<(Uuid, Uuid)>,
    JsonExtractor(request): JsonExtractor<UpdateBookmarkRequest>,
) -> Result<impl IntoResponse, AppError> {
    let existing_emoji = {
        let library = app_state.library.read().await;
        library
            .items
            .get(&item_id)
            .and_then(|item| item.bookmarks.get(&bookmark_id))
            .map(|bookmark| bookmark.emoji.clone())
    };
    let Some(existing_emoji) = existing_emoji else {
        return Ok(StatusCode::NOT_FOUND);
    };

    let label_event = Event::LibraryItemBookmarkLabelChangedEvent {
        bookmark_id,
        label: clean_bookmark_label(request.label),
    };
    save_and_broadcast_event(
        EventWithMetadata::new(item_id, label_event)?,
        app_state.clone(),
    )
    .await?;

    let emoji = request.emoji.trim();
    if !emoji.is_empty() && emoji != existing_emoji {
        let emoji_event = Event::LibraryItemBookmarkSetEmojiEvent {
            bookmark_id,
            emoji: emoji.to_string(),
        };
        save_and_broadcast_event(EventWithMetadata::new(item_id, emoji_event)?, app_state).await?;
    }

    Ok(StatusCode::OK)
}

#[instrument(skip(app_state))]
async fn delete_bookmark_handler(
    State(app_state): State<AppState>,
    Path((item_id, bookmark_id)): Path<(Uuid, Uuid)>,
) -> Result<impl IntoResponse, AppError> {
    let bookmark_exists = {
        let library = app_state.library.read().await;
        library
            .items
            .get(&item_id)
            .is_some_and(|item| item.bookmarks.contains_key(&bookmark_id))
    };
    if !bookmark_exists {
        return Ok(StatusCode::NOT_FOUND);
    }

    let event = Event::LibraryItemBookmarkDeletedEvent { bookmark_id };
    save_and_broadcast_event(EventWithMetadata::new(item_id, event)?, app_state).await?;

    Ok(StatusCode::NO_CONTENT)
}

fn clean_bookmark_label(label: Option<String>) -> Option<String> {
    label
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
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

async fn api_session_auth(
    cookies: Cookies,
    req: Request<Body>,
    next: Next,
) -> Result<Response, StatusCode> {
    if *NO_AUTH.get().unwrap_or(&false) {
        return Ok(next.run(req).await);
    }

    if cookies
        .get(SESSION_COOKIE_NAME)
        .is_some_and(|cookie| cookie.value() == *PASSWORD_HASH)
    {
        return Ok(next.run(req).await);
    }

    Err(StatusCode::UNAUTHORIZED)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deserializes_sonos_play_request_from_frontend_json() {
        let item_id = Uuid::new_v4();
        let request: SonosPlayRequest = serde_json::from_value(serde_json::json!({
            "groupId": "group-1",
            "itemIds": [item_id],
            "startItemId": item_id,
            "positionMillis": 42_000,
            "allowTakeover": true
        }))
        .unwrap();

        assert_eq!(request.group_id, "group-1");
        assert_eq!(request.item_ids, vec![item_id]);
        assert_eq!(request.start_item_id, item_id);
        assert_eq!(request.position_millis, 42_000);
        assert!(request.allow_takeover);
    }

    #[test]
    fn serializes_sonos_events_for_the_browser() {
        let update = FrontendUpdate::Sonos {
            namespace: "playback".to_string(),
            event_type: "playbackStatus".to_string(),
            target_id: "group-1".to_string(),
            payload: serde_json::json!({ "positionMillis": 42_000 }),
        };

        assert_eq!(
            serde_json::to_value(update).unwrap(),
            serde_json::json!({
                "type": "sonos",
                "namespace": "playback",
                "eventType": "playbackStatus",
                "targetId": "group-1",
                "payload": { "positionMillis": 42_000 }
            })
        );
    }
}
