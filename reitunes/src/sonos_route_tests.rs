use super::*;
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Mutex,
};

struct TestServer {
    url: String,
    task: tokio::task::JoinHandle<()>,
}

impl TestServer {
    async fn start(listener: tokio::net::TcpListener, router: Router) -> Self {
        let url = format!("http://{}/", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        Self { url, task }
    }
}

impl Drop for TestServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

#[derive(Clone)]
struct FakeSonos {
    group_missing: Arc<AtomicBool>,
    transcript: Arc<Mutex<Vec<String>>>,
    playback: Arc<Mutex<Value>>,
    sessions_created: Arc<AtomicUsize>,
    loaded_sessions: Arc<Mutex<Vec<String>>>,
    cloud_queue: Arc<Mutex<Option<(String, String)>>>,
    refreshed_window: Arc<Mutex<Option<Value>>>,
    fail_refresh: Arc<AtomicBool>,
}

impl FakeSonos {
    fn new() -> Self {
        Self {
            group_missing: Arc::new(AtomicBool::new(false)),
            transcript: Arc::new(Mutex::new(Vec::new())),
            // Another app owns the group. The old ReiTunes ID still exists in
            // our database but times out if used (the observed Spotify quirk).
            playback: Arc::new(Mutex::new(json!({
                "playbackState": "PLAYBACK_STATE_PAUSED", "positionMillis": 150_000,
            }))),
            sessions_created: Arc::new(AtomicUsize::new(0)),
            loaded_sessions: Arc::new(Mutex::new(Vec::new())),
            cloud_queue: Arc::new(Mutex::new(None)),
            refreshed_window: Arc::new(Mutex::new(None)),
            fail_refresh: Arc::new(AtomicBool::new(false)),
        }
    }

    fn router(&self) -> Router {
        Router::new()
            .route(
                "/control/api/v1/groups/group-1/playback",
                get(|State(fake): State<Self>| async move {
                    if fake.group_missing.load(Ordering::SeqCst) {
                        fake.record("playback: group missing".into());
                        return (
                            StatusCode::NOT_FOUND,
                            Json(json!({"errorCode": "ERROR_INVALID_OBJECT_ID"})),
                        )
                            .into_response();
                    }
                    fake.record("playback: reply".into());
                    Json(fake.playback.lock().unwrap().clone()).into_response()
                }),
            )
            .route(
                "/control/api/v1/groups/group-1/playbackSession",
                post(|State(fake): State<Self>| async move {
                    let number = fake.sessions_created.fetch_add(1, Ordering::SeqCst) + 1;
                    fake.record(format!("session: created fresh-{number}"));
                    Json(json!({"sessionId": format!("fresh-{number}"), "sessionCreated": true}))
                }),
            )
            .route(
                "/control/api/v1/playbackSessions/{session_id}/playbackSession/loadCloudQueue",
                post(Self::load_queue),
            )
            .route(
                "/control/api/v1/playbackSessions/{session_id}/playbackSession/refreshCloudQueue",
                post(Self::refresh_queue),
            )
            // Playback must still succeed when event subscription is down.
            .fallback(|| async { StatusCode::SERVICE_UNAVAILABLE })
            .with_state(self.clone())
    }

    fn record(&self, message: String) {
        let mut events = self.transcript.lock().unwrap();
        let sequence = events.len() + 1;
        events.push(format!("{sequence}: {message}"));
    }

    async fn load_queue(
        State(fake): State<Self>,
        Path(session): Path<String>,
        Json(body): Json<Value>,
    ) -> StatusCode {
        fake.loaded_sessions.lock().unwrap().push(session.clone());
        fake.record(format!(
            "queue: load session={session}, item={}, position={}",
            body["itemId"], body["positionMillis"]
        ));
        if session == "evicted-session" {
            return StatusCode::GATEWAY_TIMEOUT;
        }
        let base = body["queueBaseUrl"].as_str().unwrap();
        let authorization = body["httpAuthorization"].as_str().unwrap();
        *fake.cloud_queue.lock().unwrap() = Some((base.to_string(), authorization.to_string()));
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(2))
            .build()
            .unwrap();
        let unauthorized = client.get(format!("{base}/context")).send().await.unwrap();
        assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);
        let context: Value = client
            .get(format!("{base}/context"))
            .header("Authorization", authorization)
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json()
            .await
            .unwrap();
        let window: Value = client
            .get(format!("{base}/itemWindow"))
            .header("Authorization", authorization)
            .query(&[
                ("itemId", body["itemId"].as_str().unwrap()),
                ("reason", "load"),
            ])
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(context["queueVersion"], body["queueVersion"]);
        assert_eq!(window["queueVersion"], body["queueVersion"]);
        assert_eq!(window["items"][0]["id"], body["itemId"]);
        assert_eq!(window["items"][0]["track"]["name"], "Test track");
        assert_eq!(window["items"][0]["track"]["contentType"], "audio/mpeg");
        fake.record("queue: authenticated callback round trip succeeded".into());
        *fake.playback.lock().unwrap() = json!({
            "playbackState": if body["playOnCompletion"] == false { "PLAYBACK_STATE_PAUSED" } else { "PLAYBACK_STATE_PLAYING" },
            "positionMillis": body["positionMillis"],
            "queueVersion": body["queueVersion"], "itemId": body["itemId"],
        });
        StatusCode::NO_CONTENT
    }

    async fn refresh_queue(State(fake): State<Self>) -> StatusCode {
        fake.record("queue: refresh".into());
        if fake.fail_refresh.load(Ordering::SeqCst) { return StatusCode::SERVICE_UNAVAILABLE; }
        let (base, authorization) = fake.cloud_queue.lock().unwrap().clone().unwrap();
        let item_id = fake.playback.lock().unwrap()["itemId"].as_str().unwrap().to_string();
        let window: Value = reqwest::Client::new().get(format!("{base}/itemWindow"))
            .header("Authorization", authorization).query(&[("itemId", item_id.as_str()), ("upcomingWindowSize", "100")])
            .send().await.unwrap().error_for_status().unwrap().json().await.unwrap();
        fake.playback.lock().unwrap()["queueVersion"] = window["queueVersion"].clone();
        *fake.refreshed_window.lock().unwrap() = Some(window);
        StatusCode::NO_CONTENT
    }
}

struct Harness {
    _database: tempfile::TempDir,
    _sonos_server: TestServer,
    server: TestServer,
    fake: FakeSonos,
    state: AppState,
    client: reqwest::Client,
    track_id: Uuid,
}

impl Drop for Harness {
    fn drop(&mut self) {
        if std::thread::panicking() {
            eprintln!(
                "Sonos route transcript:\n{}",
                self.fake.transcript.lock().unwrap().join("\n")
            );
        }
    }
}

impl Harness {
    async fn new() -> Self {
        let database = tempfile::tempdir().unwrap();
        let db = open_connection_pool(database.path().join("test.db").to_str().unwrap()).unwrap();
        let fake = FakeSonos::new();
        let sonos_server = TestServer::start(
            tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap(),
            fake.router(),
        )
        .await;
        let control = sonos::test_support::connected_control(&sonos_server.url, db.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/", listener.local_addr().unwrap());
        let track_id = Uuid::new_v4();
        let mut library = Library::new();
        library.apply(
            &EventWithMetadata::new(
                track_id,
                Event::LibraryItemCreatedEvent {
                    name: "Test track".into(),
                    file_path: "test.mp3".into(),
                    artist: None,
                    album: None,
                    track_number: None,
                },
            )
            .unwrap(),
        );
        let state = AppState {
            library: Arc::new(RwLock::new(library)),
            playlists: Arc::new(RwLock::new(PlaylistStore::new())),
            update_tx: broadcast::channel(16).0,
            storage: Arc::new(
                S3Storage::new("https://storage.example.test", "test", None, "test", "test")
                    .await
                    .unwrap(),
            ),
            sonos: Some(Arc::new(control)),
            cloud_queues: Arc::new(cloud_queue::CloudQueueStore::with_base_url(&base)),
            playback_session: Arc::new(playback_session::PlaybackSessionStore::new(db).unwrap()),
            tagging: None,
        };
        let router = Router::new()
            .route("/api/playback-session", get(playback_session::get).post(playback_session::update))
            .route("/api/sonos/play", post(sonos_play_handler))
            .route_layer(middleware::from_fn(api_session_auth))
            .route("/api/sonos/events", post(sonos_event_handler))
            .route(
                "/sonos/cloud-queue/{queue_id}/v2.3/context",
                get(cloud_queue_context_handler),
            )
            .route(
                "/sonos/cloud-queue/{queue_id}/v2.3/itemWindow",
                get(cloud_queue_item_window_handler),
            )
            .layer(CookieManagerLayer::new())
            .with_state(state.clone());
        let server = TestServer::start(listener, router).await;
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        Self {
            _database: database,
            _sonos_server: sonos_server,
            server,
            fake,
            state,
            client,
            track_id,
        }
    }

    async fn play(&self, allow_takeover: bool) -> reqwest::Response {
        self.client.post(format!("{}api/sonos/play", self.server.url))
            .header("Cookie", format!("{SESSION_COOKIE_NAME}={}", *PASSWORD_HASH))
            .json(&json!({"groupId": "group-1", "itemIds": [self.track_id], "startItemId": self.track_id,
                "positionMillis": 42_000, "allowTakeover": allow_takeover}))
            .send().await.unwrap()
    }

    async fn event(&self, sequence: &str, valid: bool) -> reqwest::Response {
        self.fake.record(format!(
            "event: sequence={sequence}, valid_signature={valid}"
        ));
        let signature =
            sonos::test_support::playback_signature(self.state.sonos.as_ref().unwrap(), sequence);
        let payload = self.fake.playback.lock().unwrap().clone();
        self.client
            .post(format!("{}api/sonos/events", self.server.url))
            .header("X-Sonos-Event-Seq-Id", sequence)
            .header("X-Sonos-Namespace", "playback")
            .header("X-Sonos-Type", "playbackStatus")
            .header("X-Sonos-Target-Type", "groupId")
            .header("X-Sonos-Target-Value", "group-1")
            .header(
                "X-Sonos-Event-Signature",
                if valid { &signature } else { "invalid" },
            )
            .json(&payload)
            .send()
            .await
            .unwrap()
    }
}

#[tokio::test]
async fn sonos_handoff_loads_a_paused_track_at_the_requested_position() {
    let harness = Harness::new().await;
    let response = harness.client.post(format!("{}api/sonos/play", harness.server.url))
        .header("Cookie", format!("{SESSION_COOKIE_NAME}={}", *PASSWORD_HASH))
        .json(&json!({
            "groupId": "group-1", "itemIds": [harness.track_id], "startItemId": harness.track_id,
            "positionMillis": 73_456, "allowTakeover": true, "playOnCompletion": false,
        }))
        .send().await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let playback = harness.fake.playback.lock().unwrap();
    assert_eq!(playback["playbackState"], "PLAYBACK_STATE_PAUSED");
    assert_eq!(playback["positionMillis"], 73_456);
    assert_eq!(harness.fake.loaded_sessions.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn sonos_missing_group_offers_reselection_without_loading_or_replacing_a_session() {
    let harness = Harness::new().await;
    harness.fake.group_missing.store(true, Ordering::SeqCst);
    let response = harness.play(true).await;
    assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
    let body: Value = response.json().await.unwrap();
    assert!(body["error"]
        .as_str()
        .unwrap()
        .contains("choose a current group"));
    assert!(!body["error"]
        .as_str()
        .unwrap()
        .contains("ERROR_INVALID_OBJECT_ID"));
    assert_eq!(harness.fake.sessions_created.load(Ordering::SeqCst), 0);
    assert!(harness.fake.loaded_sessions.lock().unwrap().is_empty());
    // The group can become available again without reconnecting the account.
    harness.fake.group_missing.store(false, Ordering::SeqCst);
    assert_eq!(harness.play(false).await.status(), StatusCode::CONFLICT);
    assert_eq!(harness.play(true).await.status(), StatusCode::OK);
}

#[tokio::test]
async fn sonos_route_requires_takeover_and_serves_the_authenticated_queue_to_a_fresh_session() {
    let harness = Harness::new().await;
    assert_eq!(harness.play(false).await.status(), StatusCode::CONFLICT);
    assert_eq!(harness.fake.sessions_created.load(Ordering::SeqCst), 0);
    assert!(harness.fake.loaded_sessions.lock().unwrap().is_empty());
    // Confirmation runs through the real handler and real queue callbacks.
    // The fake's failed subscriptions do not make successful playback fail.
    assert_eq!(harness.play(true).await.status(), StatusCode::OK);
    assert_eq!(harness.fake.sessions_created.load(Ordering::SeqCst), 1);
    assert_eq!(
        *harness.fake.loaded_sessions.lock().unwrap(),
        vec!["fresh-1"]
    );
    assert_eq!(harness.play(false).await.status(), StatusCode::OK);
    assert_eq!(harness.fake.sessions_created.load(Ordering::SeqCst), 1);
    assert_eq!(
        *harness.fake.loaded_sessions.lock().unwrap(),
        vec!["fresh-1", "fresh-1"]
    );
}

#[tokio::test]
async fn sonos_event_route_forwards_only_new_authenticated_observations() {
    let harness = Harness::new().await;
    assert_eq!(harness.play(true).await.status(), StatusCode::OK);
    let mut events = harness.state.update_tx.subscribe();
    assert_eq!(
        harness.event("10", false).await.status(),
        StatusCode::UNAUTHORIZED
    );
    assert!(matches!(
        events.try_recv(),
        Err(broadcast::error::TryRecvError::Empty)
    ));
    assert_eq!(harness.event("10", true).await.status(), StatusCode::OK);
    let FrontendUpdate::Sonos { payload, .. } = events.try_recv().unwrap() else {
        panic!("Expected Sonos event")
    };
    assert_eq!(payload["sourceItemId"], harness.track_id.to_string());
    assert_eq!(payload["reitunesSessionActive"], true);
    for sequence in ["10", "9"] {
        assert_eq!(harness.event(sequence, true).await.status(), StatusCode::OK);
        assert!(matches!(
            events.try_recv(),
            Err(broadcast::error::TryRecvError::Empty)
        ));
    }
    assert_eq!(harness.event("11", true).await.status(), StatusCode::OK);
    assert!(events.try_recv().is_ok());
}

#[tokio::test]
async fn shared_session_routes_authenticate_broadcast_and_reject_stale_playback() {
    let harness = Harness::new().await;
    let endpoint = format!("{}api/playback-session", harness.server.url);
    assert_eq!(harness.client.get(&endpoint).send().await.unwrap().status(), StatusCode::UNAUTHORIZED);
    let cookie = format!("{SESSION_COOKIE_NAME}={}", *PASSWORD_HASH);
    let initial: Value = harness.client.get(&endpoint).header("Cookie", &cookie).send().await.unwrap().json().await.unwrap();
    assert_eq!(initial, json!({"revision": 0, "state": null}));
    let state = json!({
        "target": {"kind": "browser", "ownerId": null},
        "currentItemId": harness.track_id, "position": 5.5, "playbackRange": null,
        "queue": {"manualQueue": [
            {"id": "first", "itemId": harness.track_id}, {"id": "second", "itemId": harness.track_id}
        ], "contextItemIds": [harness.track_id], "contextIndex": 0, "contextName": "Library",
            "shuffleEnabled": false, "shuffledIds": [], "repeatMode": "off"}
    });
    let request = json!({"operationId": "initialize", "expectedRevision": 0, "state": state});
    let mut events = harness.state.update_tx.subscribe();
    let response = harness.client.post(&endpoint).header("Cookie", &cookie).json(&request).send().await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let snapshot: Value = response.json().await.unwrap();
    assert_eq!(snapshot["revision"], 1);
    assert_eq!(snapshot["state"], state);
    let event = serde_json::to_value(events.try_recv().unwrap()).unwrap();
    assert_eq!(event, json!({"type": "playbackSession", "snapshot": snapshot}));
    let mut stale = request.clone();
    stale["operationId"] = json!("other-controller");
    let response = harness.client.post(&endpoint).header("Cookie", &cookie).json(&stale).send().await.unwrap();
    assert_eq!(response.status(), StatusCode::CONFLICT);
    assert_eq!(response.json::<Value>().await.unwrap(), snapshot);
    let duplicate = harness.client.post(&endpoint).header("Cookie", &cookie).json(&request).send().await.unwrap();
    assert_eq!(duplicate.status(), StatusCode::OK);
    assert_eq!(duplicate.json::<Value>().await.unwrap(), snapshot);
    assert!(events.try_recv().is_err());
    let stale_play = harness.client.post(format!("{}api/sonos/play", harness.server.url))
        .header("Cookie", &cookie)
        .json(&json!({"groupId":"group-1", "itemIds":[harness.track_id], "startItemId":harness.track_id,
            "expectedSessionRevision":0, "allowTakeover":true})).send().await.unwrap();
    assert_eq!(stale_play.status(), StatusCode::CONFLICT);
    assert!(harness.fake.loaded_sessions.lock().unwrap().is_empty());
}

#[tokio::test]
async fn durable_queue_edits_refresh_without_a_controller_and_retry_after_restart() {
    let mut harness = Harness::new().await;
    let cookie = format!("{SESSION_COOKIE_NAME}={}", *PASSWORD_HASH);
    let response = harness.client.post(format!("{}api/sonos/play", harness.server.url))
        .header("Cookie", &cookie).json(&json!({"groupId":"group-1", "itemIds":[harness.track_id],
            "startItemId":harness.track_id, "positionMillis":42000, "allowTakeover":true, "playOnCompletion":false}))
        .send().await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let mut state = json!({
        "target":{"kind":"sonos", "householdId":"home", "groupId":"group-1", "groupName":"Living room", "playerNames":[]},
        "currentItemId":harness.track_id, "position":42, "playbackRange":null,
        "queue":{"manualQueue":[], "contextItemIds":[harness.track_id], "contextIndex":0,
            "contextName":"Library", "shuffleEnabled":false, "shuffledIds":[], "repeatMode":"off"}
    });
    let initial: playback_session::UpdateRequest = serde_json::from_value(json!({"operationId":"initial", "expectedRevision":0,"state":state})).unwrap();
    harness.state.playback_session.update(&initial).unwrap();
    state["queue"]["manualQueue"] = json!([
        {"id":"first", "itemId":harness.track_id}, {"id":"second", "itemId":harness.track_id}
    ]);
    let edit: playback_session::UpdateRequest = serde_json::from_value(json!({"operationId":"edit", "expectedRevision":1,"state":state})).unwrap();
    harness.state.playback_session.update(&edit).unwrap();
    assert!(harness.state.playback_session.snapshot().unwrap().queue_sync_pending);
    // There is no browser projection request: the durable worker does the work.
    assert!(playback_session::sync_queue_once(&harness.state).await.unwrap());
    assert!(!harness.state.playback_session.snapshot().unwrap().queue_sync_pending);
    let window = harness.fake.refreshed_window.lock().unwrap().clone().unwrap();
    assert_eq!(window["items"].as_array().unwrap().len(), 3);
    assert_ne!(window["items"][1]["id"], window["items"][2]["id"]);
    assert_eq!(harness.fake.loaded_sessions.lock().unwrap().len(), 1);
    assert_eq!(harness.fake.playback.lock().unwrap()["playbackState"], "PLAYBACK_STATE_PAUSED");
    assert_eq!(harness.fake.playback.lock().unwrap()["positionMillis"], 42000);

    state["queue"]["manualQueue"].as_array_mut().unwrap().push(json!({"id":"third", "itemId":harness.track_id}));
    let edit: playback_session::UpdateRequest = serde_json::from_value(json!({"operationId":"edit-again", "expectedRevision":2,"state":state})).unwrap();
    harness.state.playback_session.update(&edit).unwrap();
    harness.fake.fail_refresh.store(true, Ordering::SeqCst);
    assert!(playback_session::sync_queue_once(&harness.state).await.is_err());
    let snapshot = harness.state.playback_session.snapshot().unwrap();
    assert!(snapshot.queue_sync_pending);
    assert!(snapshot.queue_sync_error.is_some());
    let db = open_connection_pool(harness._database.path().join("test.db").to_str().unwrap()).unwrap();
    harness.state.playback_session = Arc::new(playback_session::PlaybackSessionStore::new(db).unwrap());
    assert!(harness.state.playback_session.snapshot().unwrap().queue_sync_pending);
    harness.fake.fail_refresh.store(false, Ordering::SeqCst);
    assert!(playback_session::sync_queue_once(&harness.state).await.unwrap());
    let snapshot = harness.state.playback_session.snapshot().unwrap();
    assert!(!snapshot.queue_sync_pending);
    assert!(snapshot.queue_sync_error.is_none());
    assert_eq!(harness.fake.refreshed_window.lock().unwrap().as_ref().unwrap()["items"].as_array().unwrap().len(), 4);
    assert_eq!(harness.fake.loaded_sessions.lock().unwrap().len(), 1);
    assert_eq!(harness.fake.playback.lock().unwrap()["playbackState"], "PLAYBACK_STATE_PAUSED");
}
