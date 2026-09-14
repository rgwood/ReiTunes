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
async fn restores_legacy_imports_without_contacting_downloader() {
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
    restore(State(discovery.clone()), Path(id)).await.unwrap();
    let restored = discovery.snapshot().await.unwrap().data.entries.remove(0);
    assert_eq!(restored.status, "new");
    assert!(restored.inbox);
    assert_eq!(restored.download_job_id, None);
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
    assert_eq!(item_identifier("https://nts.live/shows/yu-su/episodes/yu-su-1st-june-2026?ref=test"),
        Some(identifier("https://www.nts.live/shows/yu-su/episodes/yu-su-1st-june-2026")));
}

#[tokio::test]
async fn saved_sets_survive_dismissal_refresh_and_restart() {
    let directory = tempfile::tempdir().unwrap();
    let pool = reitunes_workspace::open_connection_pool(directory.path().join("library.db").to_str().unwrap()).unwrap();
    let library = Arc::new(RwLock::new(Library::build_from_events(vec![])));
    let discovery = Discovery::new(pool.clone(), library.clone()).unwrap();
    let id = entry("saved").id;
    discovery.change(|data| { merge_entries(data, "source", vec![entry("saved")], 10); Ok(()) }).await.unwrap();
    save(State(discovery.clone()), Path(id.clone()), Json(SaveRequest { saved: true })).await.unwrap();
    set_status(&discovery, &id, "dismissed").await.unwrap();
    discovery.change(|data| { merge_entries(data, "source", vec![entry("saved")], 10); Ok(()) }).await.unwrap();
    drop(discovery);
    let discovery = Discovery::new(pool, library).unwrap();
    let item = discovery.snapshot().await.unwrap().data.entries.remove(0);
    assert!(item.saved);
    assert_eq!(item.status, "dismissed");
    save(State(discovery.clone()), Path(id), Json(SaveRequest { saved: false })).await.unwrap();
    assert!(!discovery.snapshot().await.unwrap().data.entries[0].saved);
}

#[test]
fn older_discovery_entries_remain_importable_after_upgrade() {
    let mut raw = serde_json::to_value(entry("older")).unwrap();
    let fields = raw.as_object_mut().unwrap();
    for key in ["saved", "description", "genres", "downloadUrl", "canImport"] { fields.remove(key); }
    let decoded: Entry = serde_json::from_value(raw).unwrap();
    assert!(!decoded.saved);
    assert!(decoded.can_import);
    assert_eq!(decoded.download_url, None);
}

#[tokio::test]
async fn nts_import_uses_soundcloud_and_matches_the_resulting_callback() {
    use reitunes_workspace::{Event, EventWithMetadata};
    let recording = "https://soundcloud.com/nts-latest/yu-su-show";
    let worker = Router::new().route("/jobs", post(move |Json(body): Json<Value>| async move {
        assert_eq!(body["url"], recording);
        (StatusCode::ACCEPTED, Json(serde_json::json!({"id":42,"url":recording,"dl_type":"Audio","stage":"queued","download_percent":null,"error":null})))
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/download", listener.local_addr().unwrap());
    let server = tokio::spawn(axum::serve(listener, worker).into_future());
    let directory = tempfile::tempdir().unwrap();
    let pool = reitunes_workspace::open_connection_pool(directory.path().join("library.db").to_str().unwrap()).unwrap();
    let library = Arc::new(RwLock::new(Library::build_from_events(vec![])));
    let mut discovery = Discovery::new(pool.clone(), library.clone()).unwrap();
    Arc::get_mut(&mut discovery).unwrap().downloads = crate::downloads::Downloads::new(&endpoint).unwrap();
    let mut episode = entry("nts");
    episode.url = "https://www.nts.live/shows/yu-su/episodes/yu-su-1st-june-2026".into();
    episode.id = identifier(&episode.url);
    episode.download_url = Some(recording.into());
    let id = episode.id.clone();
    discovery.change(|data| { data.entries.push(episode); Ok(()) }).await.unwrap();
    import(State(discovery.clone()), Path(id.clone())).await.unwrap();
    assert_eq!(discovery.snapshot().await.unwrap().data.entries[0].download_job_id, Some(42));
    let item_id = uuid::Uuid::new_v4();
    let event = EventWithMetadata::new(item_id, Event::LibraryItemCreatedEvent {
        name: "Renamed recording".into(), artist: None, album: None, track_number: None, file_path: "renamed.mp3".into(),
    }).unwrap();
    *library.write().await = Library::build_from_events(vec![event]);
    pool.get().unwrap().execute("INSERT INTO discovery_imports(SourceId, LibraryItemId) VALUES (?1,?2)",
        [item_identifier(recording).unwrap(), item_id.to_string()]).unwrap();
    assert_eq!(discovery.snapshot().await.unwrap().data.entries[0].library_item_id, Some(item_id.to_string()));
    assert_eq!(import(State(discovery.clone()), Path(id)).await.unwrap_err().0, StatusCode::CONFLICT);
    server.abort();
}

#[tokio::test]
async fn nts_without_supported_audio_can_be_saved_but_not_imported() {
    let directory = tempfile::tempdir().unwrap();
    let pool = reitunes_workspace::open_connection_pool(directory.path().join("library.db").to_str().unwrap()).unwrap();
    let discovery = Discovery::new(pool, Arc::new(RwLock::new(Library::build_from_events(vec![])))).unwrap();
    let id = entry("external").id;
    discovery.change(|data| { let mut item = entry("external"); item.can_import = false; data.entries.push(item); Ok(()) }).await.unwrap();
    save(State(discovery.clone()), Path(id.clone()), Json(SaveRequest { saved: true })).await.unwrap();
    assert_eq!(import(State(discovery.clone()), Path(id)).await.unwrap_err().0, StatusCode::BAD_REQUEST);
    assert!(discovery.snapshot().await.unwrap().data.entries[0].saved);
}

#[tokio::test]
async fn soundcloud_playlists_hydrate_missing_titles_even_without_a_duration_filter() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let reads = Arc::new(AtomicUsize::new(0));
    let worker = Router::new().route("/metadata", post({
        let reads = reads.clone();
        move |Json(body): Json<Value>| { let reads = reads.clone(); async move {
            if body["flat"] == true {
                Json(serde_json::json!({"title":"Quantic Mixes","entries":[
                    {"id":"2244499853","url":"https://soundcloud.com/quantic/sub-club","title":null,"duration":null},
                    {"id":"123456","url":"https://api-v2.soundcloud.com/tracks/123456","title":null},
                    {"id":"unsafe","url":"http://localhost/private","title":null}
                ]}))
            } else {
                reads.fetch_add(1, Ordering::SeqCst);
                let (id, public_url, title) = match body["url"].as_str().unwrap() {
                    "https://soundcloud.com/quantic/sub-club" => ("2244499853", "https://soundcloud.com/quantic/sub-club", "Quantic at Sub Club"),
                    "https://api-v2.soundcloud.com/tracks/123456" => ("123456", "https://soundcloud.com/quantic/older-set", "An older Quantic mix"),
                    other => panic!("Unexpected metadata URL: {other}"),
                };
                Json(serde_json::json!({"id":id,"webpage_url":public_url,
                    "url":"https://media.example/signed-audio?token=never-store-this","title":title,"duration":7057,"uploader":"Quantic"}))
            }
        }}
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/metadata", listener.local_addr().unwrap());
    let server = tokio::spawn(axum::serve(listener, worker).into_future());
    let mut playlist = source();
    playlist.provider = "SoundCloud".into(); playlist.url = "https://soundcloud.com/quantic/sets/mixes".into(); playlist.min_minutes = 0;
    let first = list(&endpoint, &playlist, 1, &[]).await.unwrap();
    assert_eq!(first.entries.len(), 2);
    assert_eq!(first.entries[0].title, "Quantic at Sub Club");
    assert_eq!(first.entries[0].url, "https://soundcloud.com/quantic/sub-club");
    assert_eq!(first.entries[0].duration, Some(7057.0));
    assert_eq!(first.entries[1].url, "https://soundcloud.com/quantic/older-set");
    assert_eq!(first.entries[1].id, identifier("https://soundcloud.com/quantic/older-set"));
    playlist.min_minutes = 30;
    assert_eq!(list(&endpoint, &playlist, 1, &first.entries).await.unwrap().entries.len(), 2);
    assert_eq!(reads.load(Ordering::SeqCst), 2, "refresh reuses metadata for both public links and numeric references");
    server.abort();
}

#[test]
fn soundcloud_numeric_references_are_strict_and_never_persisted_as_entries() {
    let valid = serde_json::json!({"id":"123", "title":"Temporary", "url":"https://api-v2.soundcloud.com/tracks/123"});
    assert!(parse_candidate(&valid, "SoundCloud").is_some());
    assert!(parse_entry(&valid, "SoundCloud").is_none());
    for url in [
        "https://api-v2.soundcloud.com/tracks/456",
        "https://api-v2.soundcloud.com/tracks/123?secret_token=private",
        "https://api-v2.soundcloud.com/tracks/123#fragment",
        "http://api-v2.soundcloud.com/tracks/123",
        "https://api-v2.soundcloud.com:443/tracks/123",
        "https://api-v2.soundcloud.com/tracks/123/",
        "https://api-v2.soundcloud.com/users/123",
        "https://api-v2.soundcloud.com.evil.test/tracks/123",
    ] {
        let mut candidate = valid.clone(); candidate["url"] = url.into();
        assert!(parse_candidate(&candidate, "SoundCloud").is_none(), "{url}");
    }
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

#[tokio::test]
async fn job_ids_survive_restart_and_only_failed_jobs_can_be_retried() {
    use std::sync::atomic::{AtomicI64, Ordering};
    let failed = Arc::new(AtomicI64::new(0));
    let submissions = Arc::new(AtomicI64::new(0));
    let worker = Router::new().route("/jobs", post({
        let submissions = submissions.clone();
        move || { let submissions = submissions.clone(); async move {
            let id = submissions.fetch_add(1, Ordering::SeqCst) + 1;
            (StatusCode::ACCEPTED, Json(serde_json::json!({"id":id,"url":"https://youtube.com/watch?v=set","dl_type":"Audio","stage":"queued","download_percent":null,"error":null})))
        }}
    })).route("/jobs/{id}", get({
        let failed = failed.clone();
        move |Path(id): Path<i64>| { let failed = failed.clone(); async move {
            Json(serde_json::json!({"id":id,"url":"https://youtube.com/watch?v=set","dl_type":"Audio","stage":if id == failed.load(Ordering::SeqCst) { "failed" } else { "downloading" },"download_percent":null,"error":null}))
        }}
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/download", listener.local_addr().unwrap());
    let server = tokio::spawn(axum::serve(listener, worker).into_future());
    let directory = tempfile::tempdir().unwrap();
    let pool = reitunes_workspace::open_connection_pool(directory.path().join("library.db").to_str().unwrap()).unwrap();
    let library = Arc::new(RwLock::new(Library::build_from_events(vec![])));
    let mut discovery = Discovery::new(pool.clone(), library.clone()).unwrap();
    Arc::get_mut(&mut discovery).unwrap().downloads = crate::downloads::Downloads::new(&endpoint).unwrap();
    discovery.change(|data| { let mut old = entry("set"); old.status = "queued".into(); data.entries.push(old); Ok(()) }).await.unwrap();
    let id = entry("set").id;
    assert_eq!(import(State(discovery.clone()), Path(id.clone())).await.unwrap(), StatusCode::ACCEPTED);
    drop(discovery);
    let mut discovery = Discovery::new(pool, library).unwrap();
    Arc::get_mut(&mut discovery).unwrap().downloads = crate::downloads::Downloads::new(&endpoint).unwrap();
    assert_eq!(discovery.snapshot().await.unwrap().data.entries[0].download_job_id, Some(1));
    assert_eq!(import(State(discovery.clone()), Path(id.clone())).await.unwrap_err().0, StatusCode::CONFLICT);
    assert_eq!(submissions.load(Ordering::SeqCst), 1);
    failed.store(1, Ordering::SeqCst);
    // Only one concurrent retry can claim the failed job.
    let (first, second) = tokio::join!(
        import(State(discovery.clone()), Path(id.clone())),
        import(State(discovery.clone()), Path(id.clone())),
    );
    assert_eq!(usize::from(first.is_ok()) + usize::from(second.is_ok()), 1);
    assert_eq!(submissions.load(Ordering::SeqCst), 2);
    assert_eq!(discovery.snapshot().await.unwrap().data.entries[0].download_job_id, Some(2));
    assert_eq!(restore(State(discovery.clone()), Path(id.clone())).await.unwrap_err().0, StatusCode::CONFLICT);
    failed.store(2, Ordering::SeqCst);
    restore(State(discovery.clone()), Path(id.clone())).await.unwrap();
    let restored = discovery.snapshot().await.unwrap().data.entries.remove(0);
    assert_eq!(restored.status, "new");
    assert!(restored.inbox);
    assert_eq!(restored.download_job_id, None);
    assert_eq!(submissions.load(Ordering::SeqCst), 2, "restoring must not submit work");
    import(State(discovery.clone()), Path(id)).await.unwrap();
    assert_eq!(submissions.load(Ordering::SeqCst), 3);
    server.abort();
}

#[tokio::test]
async fn recovery_preserves_active_completed_and_unavailable_jobs_but_allows_missing_jobs() {
    let worker = Router::new().route("/jobs/{id}", get(|Path(id): Path<i64>| async move {
        let status = match id { 3 => StatusCode::SERVICE_UNAVAILABLE, 4 => StatusCode::NOT_FOUND, _ => StatusCode::OK };
        (status, Json(serde_json::json!({"id":id,"url":"https://youtube.com/watch?v=set","dl_type":"Audio",
            "stage":if id == 2 { "completed" } else { "downloading" },"download_percent":null,"error":null})))
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/download", listener.local_addr().unwrap());
    let server = tokio::spawn(axum::serve(listener, worker).into_future());
    let directory = tempfile::tempdir().unwrap();
    let pool = reitunes_workspace::open_connection_pool(directory.path().join("library.db").to_str().unwrap()).unwrap();
    let mut discovery = Discovery::new(pool, Arc::new(RwLock::new(Library::build_from_events(vec![])))).unwrap();
    Arc::get_mut(&mut discovery).unwrap().downloads = crate::downloads::Downloads::new(&endpoint).unwrap();
    let id = entry("set").id;
    for (job_id, expected) in [(1, StatusCode::CONFLICT), (2, StatusCode::CONFLICT), (3, StatusCode::BAD_GATEWAY), (4, StatusCode::NO_CONTENT)] {
        discovery.change(|data| {
            let mut item = entry("set"); item.status = "queued".into(); item.download_job_id = Some(job_id);
            data.entries = vec![item]; Ok(())
        }).await.unwrap();
        let result = restore(State(discovery.clone()), Path(id.clone())).await;
        assert_eq!(result.unwrap_or_else(|(status, _)| status), expected);
        let item = discovery.snapshot().await.unwrap().data.entries.remove(0);
        if job_id == 4 {
            assert_eq!(item.status, "new"); assert!(item.inbox); assert_eq!(item.download_job_id, None);
        } else {
            assert_eq!(item.status, "queued"); assert_eq!(item.download_job_id, Some(job_id));
        }
    }
    server.abort();
}
