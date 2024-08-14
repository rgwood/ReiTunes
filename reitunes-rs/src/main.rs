use anyhow::Result;
use askama::Template;
use axum::{
    extract::{Json as JsonExtractor, State},
    http::StatusCode,
    response::{Html, IntoResponse, Json, Response},
    routing::{get, post},
    Router,
};
use clap::{Parser, Subcommand};
use r2d2::Pool;
use r2d2_sqlite::SqliteConnectionManager;
use reitunes_rs::*;
use serde::Deserialize;
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

const DB_PATH: &str = "test-library.db";

static DB: LazyLock<Pool<SqliteConnectionManager>> =
    LazyLock::new(|| open_connection_pool(DB_PATH).expect("Failed to create connection pool"));

#[derive(Parser)]
#[command(author, version, about, long_about = None)]
struct Cli {
    #[command(subcommand)]
    command: Option<Commands>,
}

#[derive(Subcommand)]
enum Commands {
    /// Install this executable as a (user) systemd service
    Install,
}

#[tokio::main]
async fn main() -> Result<()> {
    // Initialize tracing
    tracing_subscriber::fmt::init();

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
            let shared_state = Arc::new(RwLock::new(library));

            let app = Router::new()
                .route("/", get(index_handler))
                .route("/allevents", get(all_events_handler))
                .route("/ui/update", post(update_handler))
                .with_state(shared_state);

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
    info!("Received update request: {:?}", request);

    let event = create_update_event(&request.field, &request.value)?;
    let event_with_metadata = EventWithMetadata::new(request.id, event)?;

    // TODO: save the event to the database

    // Apply the event to the library
    let mut library = library.write().await;
    library.apply(event_with_metadata);

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
