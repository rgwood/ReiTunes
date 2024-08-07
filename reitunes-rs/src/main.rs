use anyhow::Result;
use axum::{
    extract::{Form, State},
    http::StatusCode,
    response::{Html, IntoResponse, Response, Json},
    routing::{get, post},
    Router,
};
use askama::Template;
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

#[derive(Template)]
#[template(path = "index.html")]
struct IndexTemplate{
    items: Vec<LibraryItem>,
}

async fn index_handler(State(library): State<Arc<RwLock<Library>>>) -> impl IntoResponse {
    let library = library.read().await;
    let mut items: Vec<_> = library.items.values().cloned().collect();
    items.sort_by(|a, b| b.play_count.cmp(&a.play_count));

    // TODO: sort out error handling
    let rendered = IndexTemplate { items: items }.render().unwrap();

    Html(rendered)
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
                    item.name.to_lowercase().contains(&search_term.to_lowercase())
                        || item.artist.to_lowercase().contains(&search_term.to_lowercase())
                        || item.album.to_lowercase().contains(&search_term.to_lowercase())
                })
                .collect();

            // Sort filtered items by play count in descending order
            filtered_items.sort_by(|a, b| b.play_count.cmp(&a.play_count));

            let html = filtered_items
                .iter()
                .map(|item| {
                    LibraryItemTemplate { item }.render().unwrap_or_else(|_| String::new())
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

async fn all_events_handler() -> Result<Json<Vec<EventWithMetadata>>, StatusCode> {
    match load_all_events_from_db("test-library.db") {
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
