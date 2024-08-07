use anyhow::Result;
use askama::Template;
use axum::{
    extract::{Form, Json as JsonExtractor, State},
    http::StatusCode,
    response::{Html, IntoResponse, Json, Response},
    routing::{get, post},
    Router,
};
use clap::{Parser, Subcommand};
use reitunes_rs::*;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::info;

mod systemd;

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
            let conn = Connection::open("test-library.db")?;
            let library = load_library_from_db(&conn)?;
            let shared_state = Arc::new(RwLock::new((library, conn)));

            let app = Router::new()
                .route("/", get(index_handler))
                .route("/allevents", get(all_events_handler))
                // HTMX UI endpoints
                .route("/ui/search", post(search_handler))
                .route("/ui/update", post(update_handler))
                .with_state(shared_state);

            let listener = tokio::net::TcpListener::bind("127.0.0.1:3000")
                .await
                .unwrap();
            info!("Server running on http://localhost:3000");
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

async fn index_handler(State(library): State<Arc<RwLock<Library>>>) -> impl IntoResponse {
    let library = library.read().await;
    let mut items: Vec<_> = library.items.values().cloned().collect();
    items.sort_by(|a, b| b.play_count.cmp(&a.play_count));

    let rendered = IndexTemplate { items }.render();

    match rendered {
        Ok(rendered) => Html(rendered).into_response(),
        Err(err) => {
            tracing::error!("Failed to render index template: {:?}", err);
            (StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error").into_response()
        }
    }
}

#[derive(Debug, Deserialize)]
struct SearchQuery {
    query: Option<String>,
}

#[derive(Template)]
#[template(path = "library_item.html")]
struct LibraryItemTemplate<'a> {
    item: &'a LibraryItem,
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

            let html = filtered_items
                .iter()
                .map(|item| {
                    LibraryItemTemplate { item }
                        .render()
                        .unwrap_or_else(|_| String::new())
                })
                .collect::<Vec<_>>()
                .join("\n");

            Html(html).into_response()
        }
        None => {
            tracing::error!("No search query provided");
            (StatusCode::BAD_REQUEST, "No search query provided").into_response()
        }
    }
}

async fn all_events_handler(
    State(state): State<Arc<RwLock<(Library, Connection)>>>,
) -> Result<Json<Vec<EventWithMetadata>>, StatusCode> {
    let state = state.read().await;
    match load_all_events_from_db(&state.1) {
        Ok(events) => Ok(Json(events)),
        Err(e) => {
            tracing::error!("Failed to load events: {:?}", e);
            Err(StatusCode::INTERNAL_SERVER_ERROR)
        }
    }
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

#[derive(Debug, Serialize)]
struct UpdateResponse {
    success: bool,
}

async fn update_handler(
    State(library): State<Arc<RwLock<Library>>>,
    JsonExtractor(request): JsonExtractor<UpdateRequest>,
) -> impl IntoResponse {
    info!("Received update request: {:?}", request);
    let mut library = library.write().await;
    let success = library.update_item(&request.id, &request.field, &request.value);

    Json(UpdateResponse { success })
}
