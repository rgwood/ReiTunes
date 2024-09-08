use anyhow::Result;
use askama::Template;
use axum::{
    body::Body,
    extract::{ConnectInfo, Form, Json as JsonExtractor, State, WebSocketUpgrade},
    http::{header, Request, StatusCode, Uri},
    middleware::{self, Next},
    response::{Html, IntoResponse, Json, Redirect, Response},
    routing::{get, post},
    Router,
};
use axum_macros::debug_handler;
use clap::{builder::Styles, Parser, Subcommand};
use r2d2::Pool;
use r2d2_sqlite::SqliteConnectionManager;
use reitunes_rs::*;
use rust_embed::RustEmbed;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::{Arc, LazyLock};
use std::{fmt, net::SocketAddr};
use tokio::sync::broadcast;
use tokio::sync::RwLock;
use tower_cookies::{Cookie, CookieManagerLayer, Cookies};
use tower_livereload::LiveReloadLayer;
use tracing::{info, warn};
use uuid::Uuid;

mod systemd;

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

const DB_PATH: &str = "reitunes-library.db";
const PASSWORD: &str = match option_env!("REITUNES_PASSWORD") {
    Some(password) => password,
    None => "password",
};

const API_KEY: &str = match option_env!("REITUNES_API_KEY") {
    Some(password) => password,
    None => "apikey",
};

/// Hash the password with a salt that changes every quarter. Forces users to re-login every quarter.
/// The nice thing about personal projects is that I don't have to gaf about best practices 😎
static PASSWORD_HASH: LazyLock<String> = LazyLock::new(|| {
    let now = jiff::Zoned::now();
    let quarter = match now.month() / 4 {
        0 => "Q1",
        1 => "Q2",
        2 => "Q3",
        3 => "Q4",
        _ => "Error",
    };

    // e.g. 2024-Q1
    let year_quarter_salt = format!("{}-{}", now.year(), quarter);

    let mut hasher = Sha256::new();
    hasher.update(PASSWORD);
    hasher.update(year_quarter_salt);
    let result = hasher.finalize();
    format!("{:x}", result)
});

const SESSION_COOKIE_NAME: &str = "reitunes_session";

static DB: LazyLock<Pool<SqliteConnectionManager>> =
    LazyLock::new(|| open_connection_pool(DB_PATH).expect("Failed to create connection pool"));

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

#[derive(Clone)]
struct AppState {
    library: Arc<RwLock<Library>>,
    // used to broadcast updates to all connected clients
    update_tx: broadcast::Sender<LibraryItem>,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_span_events(tracing_subscriber::fmt::format::FmtSpan::CLOSE)
        .init();

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
                update_tx: broadcast::channel(100).0,
            };

            let mut app = Router::new()
                .route("/", get(index_handler))
                .route("/login", get(login_handler).post(login_post_handler))
                .route("/allevents", get(all_events_handler))
                .route("/ui/update", post(update_handler))
                .route("/ui/play", post(play_handler))
                // TODO: figure out how to make this work with auth. Server-server calls won't have cookies
                .route("/api/add", post(add_item_handler))
                .route("/updates", get(updates_handler))
                .route("/*file", get(static_handler))
                .route_layer(middleware::from_fn(auth))
                .layer(CookieManagerLayer::new())
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
    tx: broadcast::Sender<LibraryItem>,
    addr: SocketAddr,
) {
    info!(addr = ?addr, "WebSocket connected");
    let mut rx = tx.subscribe();
    while let Ok(item) = rx.recv().await {
        let msg = serde_json::to_string(&item).unwrap();
        if socket
            .send(axum::extract::ws::Message::Text(msg))
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

    // Save the event to the database
    let conn = DB.get()?;
    save_event_to_db(&conn, &event_with_metadata)?;

    // Apply the event to the library
    let mut library = app_state.library.write().await;
    library.apply(&event_with_metadata);

    if let Some(updated_item) = library.items.get(&request.id).cloned() {
        // Broadcast the updated item to all connected clients
        let _ = app_state.update_tx.send(updated_item);
    }

    Ok(StatusCode::OK)
}

#[derive(Debug, Deserialize, Serialize)]
struct AddItemRequest {
    name: String,
    file_path: String,
}

#[debug_handler]
async fn add_item_handler(
    State(app_state): State<AppState>,
    JsonExtractor(request): JsonExtractor<AddItemRequest>,
) -> Result<impl IntoResponse, AppError> {
    info!(
        name = &request.name,
        file_path = &request.file_path,
        "Adding new item"
    );
    let item_id = Uuid::new_v4();
    let event = Event::LibraryItemCreatedEvent {
        name: request.name,
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
        let _ = app_state.update_tx.send(updated_item);
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
        let _ = app_state.update_tx.send(updated_item);
    } else {
        warn!(id=?request.id, "Received play event for unknown item");
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
        _ => Err(anyhow::anyhow!("Invalid field: {}", field)),
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

// IMO the v3 style was nice and it's dumb that clap removed colour in v4
pub fn clap_v3_style() -> Styles {
    use clap::builder::styling::AnsiColor;
    Styles::styled()
        .header(AnsiColor::Yellow.on_default())
        .usage(AnsiColor::Green.on_default())
        .literal(AnsiColor::Green.on_default())
        .placeholder(AnsiColor::Green.on_default())
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
            cookies.add(cookie);
            return Redirect::to("/").into_response();
        }
    }
    Redirect::to("/login").into_response()
}
