use std::{collections::HashSet, sync::Arc, time::Duration};

use anyhow::Result;
use r2d2::Pool;
use r2d2_sqlite::SqliteConnectionManager;
use reitunes_workspace::{load_all_events_from_db, Event, EventWithMetadata, Library};
use rusqlite::params;
use tokio::sync::RwLock;
use tracing::{info, warn};
use uuid::Uuid;

use crate::storage::{valid_file_path, S3Storage};

#[derive(Debug, PartialEq, Eq)]
struct DeletedFile {
    event_id: Uuid,
    file_path: String,
}

/// Recover the file path at deletion time, including older deletion events
/// which did not carry a path themselves. Keep files shared by surviving songs.
fn deleted_files(events: &[EventWithMetadata]) -> Vec<DeletedFile> {
    let mut library = Library::new();
    let mut deleted = Vec::new();
    for event in events {
        if matches!(event.event, Event::LibraryItemDeletedEvent) {
            if let Some(item) = library.items.get(&event.aggregate_id) {
                deleted.push(DeletedFile {
                    event_id: event.id,
                    file_path: item.file_path.clone(),
                });
            }
        }
        library.apply(event);
    }
    let active: HashSet<_> = library
        .items
        .values()
        .map(|item| item.file_path.as_str())
        .collect();
    deleted.retain(|file| !active.contains(file.file_path.as_str()));
    deleted
}

pub fn start(
    pool: Pool<SqliteConnectionManager>,
    library: Arc<RwLock<Library>>,
    storage: Arc<S3Storage>,
) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(30));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            if let Err(error) = cleanup_once(&pool, &library, &storage).await {
                warn!(?error, "Deleted audio cleanup failed; will retry");
            }
        }
    });
}

async fn cleanup_once(
    pool: &Pool<SqliteConnectionManager>,
    library: &RwLock<Library>,
    storage: &S3Storage,
) -> Result<usize> {
    let pending = {
        let conn = pool.get()?;
        let events = load_all_events_from_db(&conn)?;
        let mut statement =
            conn.prepare("SELECT DeletionEventId FROM storage_deletions WHERE StorageScope = ?1")?;
        let completed: HashSet<String> = statement
            .query_map([storage.scope()], |row| row.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        deleted_files(&events)
            .into_iter()
            .filter(|file| !completed.contains(&file.event_id.to_string()))
            .collect::<Vec<_>>()
    };
    let mut count = 0;
    for file in pending {
        if !valid_file_path(&file.file_path) {
            warn!(event_id = %file.event_id, "Skipping deleted song with a non-storage path");
            continue;
        }
        // All library writers acquire this lock before saving their events.
        // Check again immediately before deletion and prevent a concurrent
        // metadata change from introducing a new reference during the request.
        let current = library.read().await;
        if current
            .items
            .values()
            .any(|item| item.file_path == file.file_path)
        {
            continue;
        }
        match tokio::time::timeout(Duration::from_secs(10), storage.delete(&file.file_path)).await {
            Ok(Ok(())) => {
                pool.get()?.execute(
                    "INSERT OR IGNORE INTO storage_deletions (StorageScope, DeletionEventId, FilePath) VALUES (?1, ?2, ?3)",
                    params![storage.scope(), file.event_id.to_string(), file.file_path],
                )?;
                count += 1;
                info!(event_id = %file.event_id, "Deleted audio object; cleanup complete");
            }
            result => {
                warn!(event_id = %file.event_id, ?result, "Audio object deletion failed; will retry")
            }
        }
        drop(current);
    }
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        extract::{OriginalUri, State},
        http::{Method, StatusCode},
        response::IntoResponse,
        Router,
    };
    use reitunes_workspace::{open_connection_pool, save_event_to_db};
    use std::{
        future::IntoFuture,
        sync::{
            atomic::{AtomicBool, Ordering},
            Mutex,
        },
    };

    fn created(id: Uuid, path: &str) -> EventWithMetadata {
        EventWithMetadata::new(
            id,
            Event::LibraryItemCreatedEvent {
                name: "Test recording".into(),
                artist: None,
                album: None,
                track_number: None,
                file_path: path.into(),
            },
        )
        .unwrap()
    }

    fn deleted(id: Uuid) -> EventWithMetadata {
        EventWithMetadata::new(id, Event::LibraryItemDeletedEvent).unwrap()
    }

    #[test]
    fn history_uses_path_at_deletion_and_keeps_shared_or_restored_files() {
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();
        let mut events = vec![
            created(a, "old.mp3"),
            EventWithMetadata::new(
                a,
                Event::LibraryItemFilePathChangedEvent {
                    new_file_path: "shared.mp3".into(),
                },
            )
            .unwrap(),
            created(b, "shared.mp3"),
            deleted(a),
            deleted(Uuid::new_v4()),
        ];
        assert!(deleted_files(&events).is_empty());
        events.push(deleted(b));
        let files = deleted_files(&events);
        assert_eq!(files.len(), 2);
        assert!(files.iter().all(|file| file.file_path == "shared.mp3"));
        events.push(created(a, "shared.mp3"));
        assert!(deleted_files(&events).is_empty());
    }

    #[derive(Clone, Default)]
    struct FakeStorage {
        fail: Arc<AtomicBool>,
        versioned: Arc<AtomicBool>,
        requests: Arc<Mutex<Vec<String>>>,
    }

    async fn handle_storage(
        State(fake): State<FakeStorage>,
        method: Method,
        OriginalUri(uri): OriginalUri,
    ) -> axum::response::Response {
        if method == Method::GET
            && uri
                .query()
                .is_some_and(|query| query.contains("versioning"))
        {
            let status = if fake.versioned.load(Ordering::SeqCst) {
                "<Status>Enabled</Status>"
            } else {
                ""
            };
            return (StatusCode::OK, [("content-type", "application/xml")],
                format!("<VersioningConfiguration xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\">{status}</VersioningConfiguration>")).into_response();
        }
        if method == Method::DELETE {
            fake.requests.lock().unwrap().push(uri.path().to_string());
            // A 403 is not automatically retried by the SDK. The next cleanup
            // pass must recover after credentials/permissions are repaired.
            return if fake.fail.load(Ordering::SeqCst) {
                StatusCode::FORBIDDEN
            } else {
                StatusCode::NO_CONTENT
            }
            .into_response();
        }
        StatusCode::BAD_REQUEST.into_response()
    }

    #[tokio::test]
    async fn cleanup_retries_failures_survives_restart_and_protects_current_references() {
        let fake = FakeStorage::default();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(
            axum::serve(
                listener,
                Router::new()
                    .fallback(handle_storage)
                    .with_state(fake.clone()),
            )
            .into_future(),
        );
        let storage = S3Storage::new(&endpoint, "test", Some("prod"), "test", "test")
            .await
            .unwrap();
        let directory = tempfile::tempdir().unwrap();
        let db_path = directory.path().join("library.db");
        let pool = open_connection_pool(db_path.to_str().unwrap()).unwrap();
        let id = Uuid::new_v4();
        let events = vec![created(id, "old #.mp3"), deleted(id)];
        for event in &events {
            save_event_to_db(&pool.get().unwrap(), event).unwrap();
        }
        let library = RwLock::new(Library::new());
        // A reference added since the history snapshot must block deletion too.
        let active_id = Uuid::new_v4();
        library
            .write()
            .await
            .apply(&created(active_id, "old #.mp3"));
        assert_eq!(cleanup_once(&pool, &library, &storage).await.unwrap(), 0);
        assert!(fake.requests.lock().unwrap().is_empty());
        library.write().await.apply(&deleted(active_id));

        fake.fail.store(true, Ordering::SeqCst);
        assert_eq!(cleanup_once(&pool, &library, &storage).await.unwrap(), 0);
        let receipts = || {
            pool.get()
                .unwrap()
                .query_row("SELECT COUNT(*) FROM storage_deletions", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap()
        };
        assert_eq!(receipts(), 0);
        fake.fail.store(false, Ordering::SeqCst);
        assert_eq!(cleanup_once(&pool, &library, &storage).await.unwrap(), 1);
        assert_eq!(receipts(), 1);
        assert_eq!(
            *fake.requests.lock().unwrap(),
            vec!["/test/prod/old%20%23.mp3"; 2]
        );
        // Opening a fresh pool simulates restart: successful deletes are not repeated.
        let reopened = open_connection_pool(db_path.to_str().unwrap()).unwrap();
        assert_eq!(
            cleanup_once(&reopened, &library, &storage).await.unwrap(),
            0
        );
        assert_eq!(fake.requests.lock().unwrap().len(), 2);

        // Missing S3 objects return 204 too, so a retry after a crash between
        // DeleteObject and the receipt is safe and completes the queue entry.
        pool.get()
            .unwrap()
            .execute("DELETE FROM storage_deletions", [])
            .unwrap();
        assert_eq!(cleanup_once(&pool, &library, &storage).await.unwrap(), 1);
        fake.versioned.store(true, Ordering::SeqCst);
        assert!(storage.delete("another.mp3").await.is_err());
        for path in [
            "",
            "/other.mp3",
            "../other.mp3",
            "folder/../other.mp3",
            "https://other/file",
            "C:\\music.mp3",
        ] {
            assert!(storage.delete(path).await.is_err());
        }
        assert_eq!(fake.requests.lock().unwrap().len(), 3);
        server.abort();
    }
}
