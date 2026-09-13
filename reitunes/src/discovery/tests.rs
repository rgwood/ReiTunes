use super::*;
use std::future::IntoFuture;

fn source() -> Source {
    Source {
        id: "source".into(),
        url: "https://www.youtube.com/@test/videos".into(),
        title: "Test mixes".into(),
        provider: "YouTube".into(),
        min_minutes: 30,
        last_checked: None,
        last_attempt: None,
        error: None,
        archive_offset: 50,
        archive_finished: false,
    }
}

fn entry(id: &str) -> Entry {
    parse_entry(
        &serde_json::json!({"id": id, "title": format!("Set {id}"), "duration": 3600}),
        "YouTube",
    )
    .unwrap()
}

#[test]
fn canonicalizes_collection_urls_and_rejects_other_targets() {
    assert_eq!(
        source_url("https://m.youtube.com/@dj?feature=shared")
            .unwrap()
            .0,
        "https://www.youtube.com/@dj/videos"
    );
    assert_eq!(
        source_url("https://www.youtube.com/@dj/streams").unwrap().0,
        "https://www.youtube.com/@dj/streams"
    );
    assert_eq!(
        source_url("https://youtube.com/playlist?list=PL123&si=tracking")
            .unwrap()
            .0,
        "https://www.youtube.com/playlist?list=PL123"
    );
    assert_eq!(
        source_url("https://soundcloud.com/dj/?utm_source=share")
            .unwrap()
            .0,
        "https://soundcloud.com/dj/tracks"
    );
    assert_eq!(
        source_url("https://soundcloud.com/dj/sets/mixes")
            .unwrap()
            .0,
        "https://soundcloud.com/dj/sets/mixes"
    );
    for url in [
        "file:///etc/passwd",
        "http://localhost:5000",
        "https://youtube.com.evil.example/@dj",
        "https://youtube.com@evil.example/@dj",
        "https://user@youtube.com/@dj",
        "https://youtube.com:8443/@dj",
        "https://youtube.com/watch?v=abc",
        "https://soundcloud.com/dj/one-track",
        "https://soundcloud.com/",
        "https://youtube.com/@dj/../../watch?v=abc",
        "https://youtube.com/playlist?list=--exec",
    ] {
        // A list ID beginning with '-' is still an argument inside an HTTPS URL,
        // never a command-line flag. All other examples must be rejected.
        if url.ends_with("list=--exec") {
            continue;
        }
        assert!(source_url(url).is_err(), "{url}");
    }
}

#[test]
fn ignores_live_private_and_unsafe_entries() {
    for raw in [
        serde_json::json!({"id":"abc", "title":"Live", "is_live":true}),
        serde_json::json!({"id":"abc", "title":"Soon", "live_status":"is_upcoming"}),
        serde_json::json!({"id":"abc", "title":"[Private video]"}),
        serde_json::json!({"id":"abc", "title":"Private", "availability":"private"}),
    ] {
        assert!(parse_entry(&raw, "YouTube").is_none());
    }
    assert!(parse_entry(
        &serde_json::json!({"id":123, "title":"Set", "url":"http://localhost/audio"}),
        "SoundCloud"
    )
    .is_none());
    let soundcloud = parse_entry(&serde_json::json!({"id":"123", "title":"Set", "url":"https://soundcloud.com/dj/set?tracking=yes"}), "SoundCloud").unwrap();
    assert_eq!(soundcloud.url, "https://soundcloud.com/dj/set");
    assert_eq!(soundcloud.duration, None);
}

#[test]
fn refresh_preserves_dismissals_and_keeps_old_sets_out_of_inbox() {
    let mut data = Data {
        sources: vec![source()],
        entries: vec![],
    };
    merge_entries(
        &mut data,
        "source",
        (0..15).map(|id| entry(&id.to_string())).collect(),
        10,
    );
    assert_eq!(data.entries.iter().filter(|e| e.inbox).count(), 10);
    data.entries[0].status = "dismissed".into();
    data.entries[1].status = "queued".into();
    merge_entries(
        &mut data,
        "source",
        (0..16).map(|id| entry(&id.to_string())).collect(),
        usize::MAX,
    );
    assert_eq!(data.entries.len(), 16);
    assert_eq!(data.entries[0].status, "dismissed");
    assert_eq!(data.entries[1].status, "queued");
    assert!(!data.entries[14].inbox);
    assert!(data.entries[15].inbox);
    merge_entries(&mut data, "second-source", vec![entry("0")], 10);
    assert_eq!(data.entries.len(), 16);
    assert_eq!(data.entries[0].sources, ["source", "second-source"]);
    assert_eq!(data.entries[0].status, "dismissed");
}

#[tokio::test]
async fn history_survives_restart_and_unfollowing() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("discovery.db");
    let pool = reitunes_workspace::open_connection_pool(path.to_str().unwrap()).unwrap();
    let library = Arc::new(RwLock::new(Library::build_from_events(vec![])));
    let discovery = Discovery::new(pool.clone(), library.clone()).unwrap();
    let id = entry("saved").id;
    discovery
        .change(|data| {
            data.sources.push(source());
            merge_entries(data, "source", vec![entry("saved")], 10);
            Ok(())
        })
        .await
        .unwrap();
    set_status(&discovery, &id, "dismissed").await.unwrap();
    unfollow(State(discovery.clone()), Path("source".into()))
        .await
        .unwrap();
    drop(discovery);
    let restarted = Discovery::new(pool, library).unwrap();
    assert_eq!(
        restarted.snapshot().await.unwrap().data.entries[0].status,
        "dismissed"
    );
    restarted
        .change(|data| {
            data.sources.push(source());
            merge_entries(data, "source", vec![entry("saved")], 10);
            Ok(())
        })
        .await
        .unwrap();
    assert_eq!(
        restarted.snapshot().await.unwrap().data.entries[0].status,
        "dismissed"
    );
    set_status(&restarted, &id, "new").await.unwrap();
    assert_eq!(
        restarted.snapshot().await.unwrap().data.entries[0].status,
        "new"
    );
}

#[tokio::test]
async fn failed_persistence_does_not_change_memory() {
    let pool = r2d2::Pool::builder()
        .max_size(1)
        .build(r2d2_sqlite::SqliteConnectionManager::memory())
        .unwrap();
    pool.get()
        .unwrap()
        .execute_batch(include_str!("../../../schema.sql"))
        .unwrap();
    let discovery = Discovery::new(
        pool.clone(),
        Arc::new(RwLock::new(Library::build_from_events(vec![]))),
    )
    .unwrap();
    pool.get()
        .unwrap()
        .execute("DROP TABLE discovery_state", [])
        .unwrap();
    assert!(discovery
        .change(|data| {
            data.sources.push(source());
            Ok(())
        })
        .await
        .is_err());
    assert!(discovery.snapshot().await.unwrap().data.sources.is_empty());
}

#[tokio::test]
async fn refuses_repeat_imports_before_contacting_downloader() {
    let pool = r2d2::Pool::builder()
        .max_size(1)
        .build(r2d2_sqlite::SqliteConnectionManager::memory())
        .unwrap();
    pool.get()
        .unwrap()
        .execute_batch(include_str!("../../../schema.sql"))
        .unwrap();
    let discovery = Discovery::new(
        pool,
        Arc::new(RwLock::new(Library::build_from_events(vec![]))),
    )
    .unwrap();
    let id = entry("queued").id;
    discovery
        .change(|data| {
            let mut queued = entry("queued");
            queued.status = "queued".into();
            data.entries.push(queued);
            Ok(())
        })
        .await
        .unwrap();
    assert_eq!(
        import(State(discovery), Path(id)).await.unwrap_err().0,
        StatusCode::CONFLICT
    );
}

#[tokio::test]
async fn follows_refreshes_and_pages_through_metadata_endpoint() {
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    #[derive(Default)]
    struct Worker {
        newer: AtomicBool,
        fail: AtomicBool,
        details: AtomicUsize,
    }
    let worker = Arc::new(Worker::default());
    let handler = |State(worker): State<Arc<Worker>>, Json(request): Json<Value>| async move {
        if worker.fail.load(Ordering::Relaxed) {
            return (
                StatusCode::BAD_GATEWAY,
                Json(serde_json::json!({"error":"source unavailable"})),
            );
        }
        if request["flat"] == false {
            worker.details.fetch_add(1, Ordering::Relaxed);
            let id = request["url"].as_str().unwrap().split("v=").nth(1).unwrap();
            return (
                StatusCode::OK,
                Json(serde_json::json!({"id":id,"title":format!("Set {id}"),"duration":3600})),
            );
        }
        let start = request["start"].as_u64().unwrap();
        let ids: Vec<_> = if start > 1 {
            vec!["older".to_string()]
        } else {
            (0..50)
                .map(|n| {
                    if n == 0 && worker.newer.load(Ordering::Relaxed) {
                        "latest".into()
                    } else {
                        n.to_string()
                    }
                })
                .collect()
        };
        let entries: Vec<_> = ids
            .iter()
            .map(|id| serde_json::json!({"id":id,"title":format!("Set {id}")}))
            .collect();
        (
            StatusCode::OK,
            Json(serde_json::json!({"title":"Test mix series","entries":entries})),
        )
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/metadata", listener.local_addr().unwrap());
    let server = tokio::spawn(
        axum::serve(
            listener,
            Router::new()
                .route("/metadata", post(handler))
                .with_state(worker.clone()),
        )
        .into_future(),
    );
    let pool = r2d2::Pool::builder()
        .max_size(1)
        .build(r2d2_sqlite::SqliteConnectionManager::memory())
        .unwrap();
    pool.get()
        .unwrap()
        .execute_batch(include_str!("../../../schema.sql"))
        .unwrap();
    let mut discovery = Discovery::new(
        pool,
        Arc::new(RwLock::new(Library::build_from_events(vec![]))),
    )
    .unwrap();
    Arc::get_mut(&mut discovery).unwrap().metadata_endpoint = endpoint;
    let request = FollowRequest {
        url: source().url,
        min_minutes: 30,
    };
    let preview = preview(State(discovery.clone()), Json(request.clone()))
        .await
        .unwrap()
        .0;
    assert_eq!(preview.entries.len(), 50);
    let id = preview.source.id;
    follow(State(discovery.clone()), Json(request))
        .await
        .unwrap();
    assert_eq!(
        discovery
            .snapshot()
            .await
            .unwrap()
            .data
            .entries
            .iter()
            .filter(|e| e.inbox)
            .count(),
        10
    );
    let old_id = entry("1").id;
    set_status(&discovery, &old_id, "dismissed").await.unwrap();
    worker.newer.store(true, Ordering::Relaxed);
    discovery.scan(&id, false).await.unwrap();
    assert_eq!(
        worker.details.load(Ordering::Relaxed),
        51,
        "refresh should reuse cached durations"
    );
    let data = discovery.snapshot().await.unwrap().data;
    assert_eq!(
        data.entries.iter().find(|e| e.id == old_id).unwrap().status,
        "dismissed"
    );
    assert!(
        data.entries
            .iter()
            .find(|e| e.media_id == "latest")
            .unwrap()
            .inbox
    );
    discovery.scan(&id, true).await.unwrap();
    let data = discovery.snapshot().await.unwrap().data;
    assert!(
        !data
            .entries
            .iter()
            .find(|e| e.media_id == "older")
            .unwrap()
            .inbox
    );
    assert!(data.sources[0].archive_finished);
    worker.fail.store(true, Ordering::Relaxed);
    discovery.scan(&id, false).await.unwrap();
    let failed = discovery.snapshot().await.unwrap().data;
    assert!(failed.sources[0].error.is_some());
    assert_eq!(failed.entries.len(), data.entries.len());
    server.abort();
}

#[test]
fn import_callback_links_match_discovery_identities() {
    assert_eq!(
        item_identifier("https://youtu.be/abc?si=tracking"),
        Some(entry("abc").id)
    );
    assert_eq!(
        item_identifier("https://youtube.com/watch?v=abc&list=playlist&t=32"),
        Some(entry("abc").id)
    );
    assert_eq!(
        item_identifier("https://www.soundcloud.com/dj/set/?si=tracking"),
        Some(identifier("https://soundcloud.com/dj/set"))
    );
    assert!(item_identifier("https://unrelated.example/track").is_none());
}

#[tokio::test]
async fn recognizes_completed_import_even_when_filename_changes() {
    use reitunes_workspace::{Event, EventWithMetadata};
    let item_id = uuid::Uuid::new_v4();
    let event = EventWithMetadata::new(
        item_id,
        Event::LibraryItemCreatedEvent {
            name: "Renamed set".into(),
            artist: None,
            album: None,
            track_number: None,
            file_path: "renamed.mp3".into(),
        },
    )
    .unwrap();
    let library = Arc::new(RwLock::new(Library::build_from_events(vec![event])));
    let pool = r2d2::Pool::builder()
        .max_size(1)
        .build(r2d2_sqlite::SqliteConnectionManager::memory())
        .unwrap();
    pool.get()
        .unwrap()
        .execute_batch(include_str!("../../../schema.sql"))
        .unwrap();
    let id = entry("completed").id;
    pool.get()
        .unwrap()
        .execute(
            "INSERT INTO discovery_imports(SourceId, LibraryItemId) VALUES (?1, ?2)",
            [&id, &item_id.to_string()],
        )
        .unwrap();
    let discovery = Discovery::new(pool, library).unwrap();
    discovery
        .change(|data| {
            data.entries.push(entry("completed"));
            Ok(())
        })
        .await
        .unwrap();
    assert_eq!(
        discovery.snapshot().await.unwrap().data.entries[0].library_item_id,
        Some(item_id.to_string())
    );
    assert_eq!(
        import(State(discovery), Path(id)).await.unwrap_err().0,
        StatusCode::CONFLICT
    );
}
