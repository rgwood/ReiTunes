use anyhow::Result;
use askama::Template;
use axum::{
    body::Body, extract::{Json as JsonExtractor, State}, http::{header, StatusCode, Uri}, response::{Html, IntoResponse, Json, Response}, routing::{get, post}, Router
};
use clap::{builder::Styles, Parser, Subcommand};
use r2d2::Pool;
use r2d2_sqlite::SqliteConnectionManager;
use reitunes_rs::*;
use rust_embed::RustEmbed;
use serde::Deserialize;
use serde_json::json;
use tower_livereload::LiveReloadLayer;
use std::fmt;
use std::sync::{Arc, LazyLock};
use tokio::sync::RwLock;
use tracing::info;

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

#[tokio::main]
async fn main() -> Result<()> {
    // Initialize tracing
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
            let shared_state = Arc::new(RwLock::new(library));

            let mut app = Router::new()
                .route("/", get(index_handler))
                .route("/allevents", get(all_events_handler))
                .route("/ui/update", post(update_handler))
                .route("/ui/play", post(play_handler))
                .route("/*file", get(static_handler))
                .with_state(shared_state);

            if cli.live_reload {
                app = app.layer(LiveReloadLayer::new());
                info!("Live reload enabled");
            }

            let listener = tokio::net::TcpListener::bind("127.0.0.1:5000")
                .await
                .unwrap();
            info!("Server running on http://localhost:5000");
            axum::serve(listener, app).await.unwrap();
        }
    }

    Ok(())
}

#[derive(Template)]
#[template(path = "index.html")]
struct IndexTemplate {
    items: Vec<LibraryItem>,
}

async fn index_handler(
    State(library): State<Arc<RwLock<Library>>>,
) -> Result<impl IntoResponse, AppError> {
    let library = library.read().await;
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
    State(library): State<Arc<RwLock<Library>>>,
    JsonExtractor(request): JsonExtractor<UpdateRequest>,
) -> Result<impl IntoResponse, AppError> {
    let event = create_update_event(&request.field, &request.value)?;
    let event_with_metadata = EventWithMetadata::new(request.id, event)?;

    // Save the event to the database
    let conn = DB.get()?;
    save_event_to_db(&conn, &event_with_metadata)?;

    // Apply the event to the library
    let mut library = library.write().await;
    library.apply(&event_with_metadata);

    let updated_item = library.items.get(&request.id).cloned();
    // TODO: send the update item to all clients over a websocket

    Ok(StatusCode::OK)
}

#[derive(Debug, Deserialize)]
struct PlayRequest {
    id: uuid::Uuid,
}

async fn play_handler(
    State(library): State<Arc<RwLock<Library>>>,
    JsonExtractor(request): JsonExtractor<PlayRequest>,
) -> Result<impl IntoResponse, AppError> {
    let event = Event::LibraryItemPlayedEvent;
    let event_with_metadata = EventWithMetadata::new(request.id, event)?;

    // Save the event to the database
    let conn = DB.get()?;
    save_event_to_db(&conn, &event_with_metadata)?;

    // Apply the event to the library
    let mut library = library.write().await;
    library.apply(&event_with_metadata);

    // Get the updated play count
    let new_play_count = library.items.get(&request.id)
        .map(|item| item.play_count)
        .unwrap_or(0);

    Ok(Json(json!({ "new_play_count": new_play_count })))
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
