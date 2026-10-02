//! Last.fm account linking and durable, occurrence-based scrobbling.
//! https://www.last.fm/api/scrobbling
use std::{
    collections::BTreeMap,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use crate::{AppState, LibraryItem};
use anyhow::{bail, Context, Result};
use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::{IntoResponse, Redirect, Response},
    Json,
};
use openssl::{
    hash::{hash, MessageDigest},
    symm::{decrypt_aead, encrypt_aead, Cipher},
};
use r2d2::Pool;
use r2d2_sqlite::SqliteConnectionManager;
use rand::{rngs::OsRng, RngCore};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

type Db = Pool<SqliteConnectionManager>;

#[derive(Clone, Serialize, Deserialize)]
struct Credentials {
    api_key: String,
    secret: String,
    session: Option<String>,
    username: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct Sealed {
    nonce: Vec<u8>,
    ciphertext: Vec<u8>,
    tag: Vec<u8>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    configured: bool,
    pub connected: bool,
    username: Option<String>,
    enabled: bool,
    pub pending: u64,
    submitted: u64,
    last_error: Option<String>,
}

pub struct LastFm {
    db: Db,
    key: [u8; 32],
    client: reqwest::Client,
    endpoint: String,
    gate: tokio::sync::Mutex<()>,
    wake: tokio::sync::Notify,
}

#[derive(Clone, Serialize, Deserialize)]
struct Track {
    artist: String,
    title: String,
    album: String,
    duration: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrowserReport {
    listen_id: Uuid,
    segment_id: Uuid,
    item_id: Uuid,
    owner_id: String,
    started_at: u64,
    listened_seconds: f64,
    duration: f64,
}

#[derive(Deserialize)]
pub struct SonosReports {
    #[serde(default)]
    pub items: Vec<SonosReport>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SonosReport {
    pub id: String,
    report_id: Option<Uuid>,
    duration_played_millis: u64,
    time_since_playback_millis: u64,
    #[serde(rename = "type", default)]
    kind: String,
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

impl LastFm {
    #[cfg(test)]
    pub fn connect_for_test(&self) {
        self.save_credentials(&Credentials {
            api_key: "testkey".into(),
            secret: "testsecret".into(),
            session: Some("testsession".into()),
            username: Some("quobobo".into()),
        })
        .unwrap();
    }
    #[cfg(test)]
    pub fn in_memory() -> Self {
        Self::new(
            Pool::builder()
                .max_size(1)
                .build(SqliteConnectionManager::memory())
                .unwrap(),
        )
        .unwrap()
    }
    pub fn new(db: Db) -> Result<Self> {
        db.get()?.execute_batch("CREATE TABLE IF NOT EXISTS lastfm_config (
            id INTEGER PRIMARY KEY CHECK(id=1), credentials TEXT, enabled INTEGER NOT NULL DEFAULT 1,
            auth_state TEXT, auth_expires INTEGER, last_error TEXT);
            INSERT OR IGNORE INTO lastfm_config(id) VALUES(1);
            CREATE TABLE IF NOT EXISTS lastfm_listens (
                id TEXT PRIMARY KEY, item_id TEXT NOT NULL, started_at INTEGER NOT NULL,
                track TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'listening',
                now_playing INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
                next_attempt INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE IF NOT EXISTS lastfm_segments (
                id TEXT PRIMARY KEY, listen_id TEXT NOT NULL, seconds REAL NOT NULL);
            CREATE TABLE IF NOT EXISTS lastfm_sonos_links (item_id TEXT PRIMARY KEY, listen_id TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS lastfm_sonos_reports (report_id TEXT PRIMARY KEY, item_id TEXT NOT NULL, listen_id TEXT NOT NULL);")?;
        db.get()?.execute_batch("CREATE TABLE IF NOT EXISTS lastfm_browser_owners(listen_id TEXT NOT NULL, owner_id TEXT NOT NULL, PRIMARY KEY(listen_id,owner_id));")?;
        // Domain separation keeps these credentials separate from other secrets.
        let key = Sha256::digest(format!("reitunes-lastfm:{}", crate::API_KEY)).into();
        Ok(Self {
            db,
            key,
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(15))
                .build()?,
            endpoint: "https://ws.audioscrobbler.com/2.0/".into(),
            gate: tokio::sync::Mutex::new(()),
            wake: tokio::sync::Notify::new(),
        })
    }

    fn credentials(&self) -> Result<Option<Credentials>> {
        let stored: Option<String> = self.db.get()?.query_row(
            "SELECT credentials FROM lastfm_config WHERE id=1",
            [],
            |row| row.get(0),
        )?;
        stored
            .map(|value| {
                let sealed: Sealed = serde_json::from_str(&value)?;
                let bytes = decrypt_aead(
                    Cipher::aes_256_gcm(),
                    &self.key,
                    Some(&sealed.nonce),
                    b"lastfm",
                    &sealed.ciphertext,
                    &sealed.tag,
                )
                .context("Could not decrypt Last.fm credentials")?;
                Ok(serde_json::from_slice(&bytes)?)
            })
            .transpose()
    }

    fn save_credentials(&self, credentials: &Credentials) -> Result<()> {
        let mut nonce = vec![0; 12];
        OsRng.fill_bytes(&mut nonce);
        let mut tag = vec![0; 16];
        let ciphertext = encrypt_aead(
            Cipher::aes_256_gcm(),
            &self.key,
            Some(&nonce),
            b"lastfm",
            &serde_json::to_vec(credentials)?,
            &mut tag,
        )?;
        self.db.get()?.execute(
            "UPDATE lastfm_config SET credentials=?1, last_error=NULL WHERE id=1",
            [serde_json::to_string(&Sealed {
                nonce,
                ciphertext,
                tag,
            })?],
        )?;
        Ok(())
    }

    pub fn status(&self) -> Result<Status> {
        let credentials = self.credentials()?;
        let conn = self.db.get()?;
        let (enabled, last_error) = conn.query_row(
            "SELECT enabled,last_error FROM lastfm_config WHERE id=1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        Ok(Status {
            configured: credentials.is_some(),
            connected: credentials.as_ref().is_some_and(|c| c.session.is_some()),
            username: credentials.and_then(|c| c.username),
            enabled,
            last_error,
            pending: conn.query_row(
                "SELECT count(*) FROM lastfm_listens WHERE state='queued'",
                [],
                |row| row.get(0),
            )?,
            submitted: conn.query_row(
                "SELECT count(*) FROM lastfm_listens WHERE state='sent'",
                [],
                |row| row.get(0),
            )?,
        })
    }

    fn active(&self) -> Result<bool> {
        let status = self.status()?;
        Ok(status.connected && status.enabled)
    }

    async fn complete_authorization(&self, request: Callback) -> Result<()> {
        let (state, expires): (Option<String>, Option<u64>) = self.db.get()?.query_row(
            "SELECT auth_state,auth_expires FROM lastfm_config WHERE id=1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        if state.as_deref() != Some(&request.state) || expires.is_none_or(|expires| expires < now())
        {
            bail!("Last.fm authorization expired; connect again from Settings");
        }
        self.db
            .get()?
            .execute("UPDATE lastfm_config SET auth_state=NULL WHERE id=1", [])?;
        let mut credentials = self.credentials()?.context("Last.fm is not configured")?;
        let value = self
            .call(
                &credentials,
                "auth.getSession",
                BTreeMap::from([("token".into(), request.token)]),
            )
            .await
            .map_err(|error| anyhow::anyhow!(error.message))?;
        let username = value["session"]["name"]
            .as_str()
            .context("Last.fm did not return an account name")?;
        if !username.eq_ignore_ascii_case("quobobo") {
            bail!("Please authorize the quobobo account; Last.fm returned a different account");
        }
        credentials.username = Some(username.into());
        credentials.session = Some(
            value["session"]["key"]
                .as_str()
                .filter(|key| !key.is_empty())
                .context("Last.fm did not return a session key")?
                .into(),
        );
        self.save_credentials(&credentials)?;
        self.db
            .get()?
            .execute("UPDATE lastfm_config SET enabled=1 WHERE id=1", [])?;
        self.wake.notify_one();
        Ok(())
    }

    pub fn bind_sonos(&self, occurrence: &str, listen: Option<Uuid>) -> Result<Uuid> {
        let conn = self.db.get()?;
        let existing: Option<String> = conn
            .query_row(
                "SELECT listen_id FROM lastfm_sonos_links WHERE item_id=?1",
                [occurrence],
                |r| r.get(0),
            )
            .optional()?;
        let id = listen
            .or(existing.map(|id| Uuid::parse_str(&id)).transpose()?)
            .unwrap_or_else(Uuid::new_v4);
        conn.execute(
            "INSERT INTO lastfm_sonos_links(item_id,listen_id) VALUES(?1,?2)
            ON CONFLICT(item_id) DO UPDATE SET listen_id=excluded.listen_id",
            params![occurrence, id.to_string()],
        )?;
        Ok(id)
    }

    pub fn record_sonos(&self, item: &LibraryItem, report: &SonosReport) -> Result<()> {
        if !matches!(report.kind.as_str(), "update" | "final" | "") || !self.active()? {
            return Ok(());
        }
        let report_key = report
            .report_id
            .map(|id| id.to_string())
            .unwrap_or_else(|| report.id.clone());
        let mut conn = self.db.get()?;
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let existing: Option<String> = tx
            .query_row(
                "SELECT listen_id FROM lastfm_sonos_reports WHERE report_id=?1",
                [&report_key],
                |r| r.get(0),
            )
            .optional()?;
        let listen = if let Some(existing) = existing {
            Uuid::parse_str(&existing)?
        } else {
            let link: Option<String> = tx
                .query_row(
                    "SELECT listen_id FROM lastfm_sonos_links WHERE item_id=?1",
                    [&report.id],
                    |r| r.get(0),
                )
                .optional()?;
            let claimed = if let Some(link) = &link {
                tx.query_row(
                    "SELECT EXISTS(SELECT 1 FROM lastfm_sonos_reports WHERE listen_id=?1)",
                    [link],
                    |r| r.get::<_, bool>(0),
                )?
            } else {
                false
            };
            let id = if claimed {
                Uuid::new_v4()
            } else {
                link.map(|id| Uuid::parse_str(&id))
                    .transpose()?
                    .unwrap_or_else(Uuid::new_v4)
            };
            tx.execute(
                "INSERT INTO lastfm_sonos_reports(report_id,item_id,listen_id) VALUES(?1,?2,?3)",
                params![report_key, report.id, id.to_string()],
            )?;
            tx.execute(
                "INSERT INTO lastfm_sonos_links(item_id,listen_id) VALUES(?1,?2)
                ON CONFLICT(item_id) DO UPDATE SET listen_id=excluded.listen_id",
                params![report.id, id.to_string()],
            )?;
            id
        };
        tx.commit()?;
        drop(conn);
        self.record(
            item,
            listen,
            &format!("sonos:{report_key}"),
            now().saturating_sub(report.time_since_playback_millis / 1000),
            report.duration_played_millis as f64 / 1000.0,
            item.duration_seconds.unwrap_or(0.0),
        )
    }

    fn record(
        &self,
        item: &LibraryItem,
        listen: Uuid,
        segment: &str,
        started_at: u64,
        seconds: f64,
        duration: f64,
    ) -> Result<()> {
        if !self.active()? {
            return Ok(());
        }
        if item.artist.trim().is_empty()
            || item.name.trim().is_empty()
            || !duration.is_finite()
            || duration <= 30.0
        {
            return Ok(());
        }
        if !seconds.is_finite()
            || seconds < 0.0
            || seconds > 7.0 * 86400.0
            || started_at > now() + 60
            || started_at < now().saturating_sub(14 * 86400)
        {
            bail!("Invalid listening-time report");
        }
        let track = Track {
            artist: item.artist.trim().into(),
            title: item.name.trim().into(),
            album: item.album.trim().into(),
            duration,
        };
        let mut conn = self.db.get()?;
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        tx.execute(
            "INSERT OR IGNORE INTO lastfm_listens(id,item_id,started_at,track) VALUES(?1,?2,?3,?4)",
            params![
                listen.to_string(),
                item.id.to_string(),
                started_at,
                serde_json::to_string(&track)?
            ],
        )?;
        let stored_item: String = tx.query_row(
            "SELECT item_id FROM lastfm_listens WHERE id=?1",
            [listen.to_string()],
            |r| r.get(0),
        )?;
        if stored_item != item.id.to_string() {
            bail!("Listening ID belongs to another song");
        }
        tx.execute("INSERT INTO lastfm_segments(id,listen_id,seconds) VALUES(?1,?2,?3)
            ON CONFLICT(id) DO UPDATE SET seconds=max(seconds,excluded.seconds) WHERE listen_id=excluded.listen_id", params![segment,listen.to_string(),seconds])?;
        tx.execute(
            "UPDATE lastfm_listens SET state='queued' WHERE id=?1 AND state='listening'
            AND (SELECT coalesce(sum(seconds),0) FROM lastfm_segments WHERE listen_id=?1)>=?2",
            params![listen.to_string(), (duration / 2.0).min(240.0)],
        )?;
        tx.commit()?;
        self.wake.notify_one();
        Ok(())
    }

    async fn call(
        &self,
        credentials: &Credentials,
        method: &str,
        mut fields: BTreeMap<String, String>,
    ) -> std::result::Result<Value, ApiError> {
        fields.insert("method".into(), method.into());
        fields.insert("api_key".into(), credentials.api_key.clone());
        if method != "auth.getSession" {
            if let Some(session) = &credentials.session {
                fields.insert("sk".into(), session.clone());
            }
        }
        let mut signature = String::new();
        for (key, value) in &fields {
            signature.push_str(key);
            signature.push_str(value);
        }
        signature.push_str(&credentials.secret);
        let digest = hash(MessageDigest::md5(), signature.as_bytes())
            .map_err(|_| ApiError::temporary("Could not sign Last.fm request"))?;
        fields.insert(
            "api_sig".into(),
            digest.iter().map(|byte| format!("{byte:02x}")).collect(),
        );
        fields.insert("format".into(), "json".into());
        let response = self
            .client
            .post(&self.endpoint)
            .form(&fields)
            .send()
            .await
            .map_err(|_| {
                ApiError::temporary("Could not reach Last.fm; queued scrobbles will retry")
            })?;
        let status = response.status();
        let value: Value = response
            .json()
            .await
            .map_err(|_| ApiError::temporary("Last.fm returned an unreadable response"))?;
        if let Some(code) = value["error"].as_u64() {
            return Err(ApiError {
                retry: matches!(code, 11 | 16 | 29),
                revoked: code == 9,
                message: format!(
                    "Last.fm error {code}: {}",
                    match code {
                        9 => "reconnect your account",
                        4 | 10 | 13 | 26 => "check the API key and secret",
                        14 | 15 => "authorization expired; try connecting again",
                        11 | 16 | 29 => "service unavailable; queued scrobbles will retry",
                        _ => "request rejected",
                    }
                ),
            });
        }
        if !status.is_success() {
            return Err(ApiError {
                retry: status.is_server_error() || status.as_u16() == 429,
                revoked: false,
                message: format!("Last.fm HTTP {}", status.as_u16()),
            });
        }
        if method == "track.scrobble" && value["scrobbles"]["@attr"]["accepted"].is_null() {
            return Err(ApiError::temporary(
                "Last.fm did not confirm the scrobble; queued scrobbles will retry",
            ));
        }
        Ok(value)
    }

    async fn send_once(&self) -> Result<bool> {
        let _gate = self.gate.lock().await;
        let Some(mut credentials) = self.credentials()? else {
            return Ok(false);
        };
        if credentials.session.is_none() || !self.status()?.enabled {
            return Ok(false);
        }
        let candidate: Option<(String, u64, String, String, bool, u32, u64)> = self.db.get()?.query_row(
            "SELECT id,started_at,track,state,now_playing,attempts,next_attempt FROM lastfm_listens
             WHERE state='queued' OR (state='listening' AND now_playing=0) ORDER BY started_at,id LIMIT 1", [],
            |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?))).optional()?;
        let Some((id, timestamp, serialized, state, now_playing, attempts, next_attempt)) =
            candidate
        else {
            return Ok(false);
        };
        if next_attempt > now() {
            return Ok(false);
        }
        let track: Track = serde_json::from_str(&serialized)?;
        let mut fields = BTreeMap::from([
            ("artist".into(), track.artist),
            ("track".into(), track.title),
            ("duration".into(), (track.duration as u64).to_string()),
        ]);
        if !track.album.is_empty() {
            fields.insert("album".into(), track.album);
        }
        if !now_playing {
            // Now Playing is deliberately not retried or sent for cached history.
            self.db
                .get()?
                .execute("UPDATE lastfm_listens SET now_playing=1 WHERE id=?1", [&id])?;
            if timestamp + 90 >= now() {
                if let Err(error) = self
                    .call(&credentials, "track.updateNowPlaying", fields.clone())
                    .await
                {
                    tracing::warn!(error=%error.message,"Last.fm Now Playing failed");
                    if error.revoked {
                        credentials.session = None;
                        self.save_credentials(&credentials)?;
                        self.db.get()?.execute(
                            "UPDATE lastfm_config SET last_error=?1 WHERE id=1",
                            [error.message],
                        )?;
                        return Ok(false);
                    }
                }
            }
        }
        if state != "queued" {
            return Ok(true);
        }
        fields.insert("timestamp".into(), timestamp.to_string());
        match self.call(&credentials, "track.scrobble", fields).await {
            Ok(value) => {
                let accepted = value["scrobbles"]["@attr"]["accepted"]
                    .as_str()
                    .and_then(|v| v.parse::<u64>().ok())
                    .or_else(|| value["scrobbles"]["@attr"]["accepted"].as_u64());
                if accepted.is_none() {
                    bail!("Last.fm response did not confirm a scrobble");
                }
                self.db.get()?.execute(
                    "UPDATE lastfm_listens SET state=?1 WHERE id=?2",
                    params![
                        if accepted == Some(1) {
                            "sent"
                        } else {
                            "ignored"
                        },
                        id
                    ],
                )?;
                self.db.get()?.execute(
                    "UPDATE lastfm_config SET last_error=?1 WHERE id=1",
                    params![if accepted == Some(1) {
                        None
                    } else {
                        Some("Last.fm ignored a scrobble (metadata or timestamp filter)")
                    }],
                )?;
            }
            Err(error) => {
                if error.revoked {
                    credentials.session = None;
                    self.save_credentials(&credentials)?;
                }
                self.db.get()?.execute("UPDATE lastfm_listens SET state=?1, attempts=attempts+1,next_attempt=?2 WHERE id=?3",
                    params![if error.retry || error.revoked {"queued"} else {"failed"},now()+30 * 2u64.pow(attempts.min(7)),id])?;
                self.db.get()?.execute(
                    "UPDATE lastfm_config SET last_error=?1 WHERE id=1",
                    [&error.message],
                )?;
                tracing::warn!(error=%error.message,listen_id=%id,"Last.fm scrobble failed");
                return Ok(false);
            }
        }
        Ok(true)
    }

    pub fn start(self: &Arc<Self>) {
        let service = self.clone();
        tokio::spawn(async move {
            loop {
                match service.send_once().await {
                    Ok(true) => continue,
                    Ok(false) => {}
                    Err(error) => tracing::warn!(%error,"Last.fm worker failed"),
                }
                tokio::select! { _=service.wake.notified()=>{}, _=tokio::time::sleep(Duration::from_secs(30))=>{} }
            }
        });
    }
}

struct ApiError {
    retry: bool,
    revoked: bool,
    message: String,
}
impl ApiError {
    fn temporary(message: &str) -> Self {
        Self {
            retry: true,
            revoked: false,
            message: message.into(),
        }
    }
}

fn failure(error: anyhow::Error) -> Response {
    tracing::warn!(%error,"Last.fm request failed");
    (
        StatusCode::BAD_REQUEST,
        Json(json!({"error":error.to_string()})),
    )
        .into_response()
}

pub async fn status(State(app): State<AppState>) -> Response {
    match app.lastfm.status() {
        Ok(status) => Json(status).into_response(),
        Err(error) => failure(error),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Setup {
    api_key: String,
    secret: String,
}

pub async fn setup(State(app): State<AppState>, Json(request): Json<Setup>) -> Response {
    let _gate = app.lastfm.gate.lock().await;
    let result = (|| -> Result<()> {
        for value in [&request.api_key, &request.secret] {
            if value.len() != 32 || !value.bytes().all(|c| c.is_ascii_hexdigit()) {
                bail!("API key and secret must each be 32 hexadecimal characters");
            }
        }
        if app.lastfm.status()?.connected {
            bail!("Disconnect Last.fm before replacing the application credentials");
        }
        app.lastfm.save_credentials(&Credentials {
            api_key: request.api_key,
            secret: request.secret,
            session: None,
            username: None,
        })?;
        app.lastfm
            .db
            .get()?
            .execute("UPDATE lastfm_config SET auth_state=NULL WHERE id=1", [])?;
        Ok(())
    })();
    match result {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => failure(error),
    }
}

fn callback_url() -> Result<reqwest::Url> {
    let host = option_env!("REITUNES_HOSTNAME")
        .map(String::from)
        .or_else(|| std::env::var("REITUNES_HOSTNAME").ok())
        .unwrap_or_else(|| "reitunes.reillywood.com".into());
    let scheme = option_env!("URL_SCHEME").unwrap_or("https");
    Ok(reqwest::Url::parse(&format!(
        "{scheme}://{host}/api/lastfm/callback"
    ))?)
}

pub async fn authorize(State(app): State<AppState>) -> Response {
    let _gate = app.lastfm.gate.lock().await;
    let result = (|| -> Result<String> {
        let credentials = app
            .lastfm
            .credentials()?
            .context("Add your Last.fm API key and secret first")?;
        let state = Uuid::new_v4().to_string();
        let mut callback = callback_url()?;
        callback.query_pairs_mut().append_pair("state", &state);
        app.lastfm.db.get()?.execute(
            "UPDATE lastfm_config SET auth_state=?1,auth_expires=?2 WHERE id=1",
            params![state, now() + 3600],
        )?;
        let mut url = reqwest::Url::parse("https://www.last.fm/api/auth/")?;
        url.query_pairs_mut()
            .append_pair("api_key", &credentials.api_key)
            .append_pair("cb", callback.as_str());
        Ok(url.to_string())
    })();
    match result {
        Ok(url) => Json(json!({"url":url})).into_response(),
        Err(error) => failure(error),
    }
}

#[derive(Deserialize)]
pub struct Callback {
    state: String,
    token: String,
}

pub async fn callback(State(app): State<AppState>, Query(request): Query<Callback>) -> Response {
    let _gate = app.lastfm.gate.lock().await;
    let result = app.lastfm.complete_authorization(request).await;
    match result {
        Ok(()) => Redirect::to("/?lastfm=connected").into_response(),
        Err(error) => {
            if let Ok(conn) = app.lastfm.db.get() {
                let _ = conn.execute(
                    "UPDATE lastfm_config SET last_error=?1 WHERE id=1",
                    [error.to_string()],
                );
            }
            Redirect::to("/?lastfm=error").into_response()
        }
    }
}

#[derive(Deserialize)]
pub struct Enabled {
    enabled: bool,
}
pub async fn enabled(State(app): State<AppState>, Json(request): Json<Enabled>) -> Response {
    let _gate = app.lastfm.gate.lock().await;
    match app
        .lastfm
        .db
        .get()
        .map_err(anyhow::Error::from)
        .and_then(|conn| {
            conn.execute(
                "UPDATE lastfm_config SET enabled=?1 WHERE id=1",
                [request.enabled],
            )
            .map_err(Into::into)
        }) {
        Ok(_) => {
            app.lastfm.wake.notify_one();
            StatusCode::NO_CONTENT.into_response()
        }
        Err(error) => failure(error.into()),
    }
}

pub async fn disconnect(State(app): State<AppState>) -> Response {
    let _gate = app.lastfm.gate.lock().await;
    let result = (|| -> Result<()> {
        if let Some(mut credentials) = app.lastfm.credentials()? {
            credentials.session = None;
            credentials.username = None;
            app.lastfm.save_credentials(&credentials)?;
        }
        // Discard local pending history on an explicit disconnect. Reconnecting
        // cannot accidentally send listens collected before disconnecting.
        app.lastfm.db.get()?.execute_batch(
            "UPDATE lastfm_config SET enabled=0,auth_state=NULL,last_error=NULL WHERE id=1;
            UPDATE lastfm_listens SET state='discarded' WHERE state IN ('queued','listening');",
        )?;
        Ok(())
    })();
    match result {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => failure(error),
    }
}

pub async fn browser_report(
    State(app): State<AppState>,
    Json(report): Json<BrowserReport>,
) -> Response {
    let result=async {
        let snapshot=app.playback_session.snapshot()?;
        let owns_audio=snapshot.state.is_some_and(|state|matches!(state.target,crate::playback_session::PlaybackTarget::Browser{owner_id:Some(owner)} if owner==report.owner_id));
        let known:bool=app.lastfm.db.get()?.query_row("SELECT EXISTS(SELECT 1 FROM lastfm_browser_owners WHERE listen_id=?1 AND owner_id=?2)",params![report.listen_id.to_string(),report.owner_id],|r|r.get(0))?;
        if !owns_audio && !known { bail!("Only the browser playing audio can report listening time"); }
        if owns_audio {
            app.lastfm.db.get()?.execute("INSERT OR IGNORE INTO lastfm_browser_owners(listen_id,owner_id) VALUES(?1,?2)",params![report.listen_id.to_string(),report.owner_id])?;
        }
        let library=app.library.read().await;
        let item=library.items.get(&report.item_id).context("Song is no longer in the library")?;
        app.lastfm.record(item,report.listen_id,&format!("browser:{}",report.segment_id),report.started_at,report.listened_seconds,item.duration_seconds.unwrap_or(report.duration))
    }.await;
    match result {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => failure(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Event, EventWithMetadata, Library};
    use axum::{routing::post, Form, Router};
    use std::sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    };

    fn track() -> LibraryItem {
        let id = Uuid::new_v4();
        let mut library = Library::new();
        library.apply(
            &EventWithMetadata::new(
                id,
                Event::LibraryItemCreatedEvent {
                    name: "Wanderlust".into(),
                    artist: Some("Björk".into()),
                    album: None,
                    file_path: "must-not-be-sent.mp3".into(),
                    track_number: None,
                },
            )
            .unwrap(),
        );
        let mut track = library.items[&id].clone();
        track.duration_seconds = Some(200.0);
        track
    }

    fn connect(service: &LastFm) {
        service
            .save_credentials(&Credentials {
                api_key: "testkey".into(),
                secret: "testsecret".into(),
                session: Some("testsession".into()),
                username: Some("quobobo".into()),
            })
            .unwrap();
    }

    struct Fake {
        requests: Arc<Mutex<Vec<BTreeMap<String, String>>>>,
        error: Arc<AtomicU64>,
        task: tokio::task::JoinHandle<()>,
    }
    impl Drop for Fake {
        fn drop(&mut self) {
            self.task.abort();
        }
    }
    async fn fake(service: &mut LastFm) -> Fake {
        let requests = Arc::new(Mutex::new(Vec::new()));
        let error = Arc::new(AtomicU64::new(0));
        let route=Router::new().route("/",post({
            let requests=requests.clone(); let error=error.clone();
            move |Form(form):Form<BTreeMap<String,String>>| {
                let requests=requests.clone(); let error=error.clone();
                async move {
                    assert!(!form.contains_key("secret"));
                    assert!(!serde_json::to_string(&form).unwrap().contains("must-not-be-sent"));
                    requests.lock().unwrap().push(form.clone());
                    let code=error.load(Ordering::SeqCst);
                    if form["method"]=="auth.getSession" {
                        assert!(!form.contains_key("sk"));
                        Json(json!({"session":{"name":if code==99 { "someone-else" } else { "quobobo" },"key":"new-session"}}))
                    }
                    else if code==98 { Json(json!({"scrobbles":{"@attr":{"accepted":"0","ignored":"1"}}})) }
                    else if code>0 { Json(json!({"error":code,"message":"ignored untrusted error message"})) }
                    else if form["method"]=="track.updateNowPlaying" {
                        assert_eq!(form["api_sig"],"c98f8a8bc7303776a82a6eb6ce28d845");
                        Json(json!({"nowplaying":{}}))
                    } else { Json(json!({"scrobbles":{"@attr":{"accepted":"1","ignored":"0"}}})) }
                }
            }
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        service.endpoint = format!("http://{}/", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            axum::serve(listener, route).await.unwrap();
        });
        Fake {
            requests,
            error,
            task,
        }
    }

    #[tokio::test]
    async fn scrobbles_threshold_once_and_persists_encrypted_credentials_and_deduplication() {
        let dir = tempfile::tempdir().unwrap();
        let db = crate::open_connection_pool(dir.path().join("test.db").to_str().unwrap()).unwrap();
        let mut service = LastFm::new(db.clone()).unwrap();
        connect(&service);
        let fake = fake(&mut service).await;
        let track = track();
        let listen = Uuid::new_v4();
        service
            .record(&track, listen, "browser:one", now(), 99.0, 200.0)
            .unwrap();
        assert_eq!(service.status().unwrap().pending, 0);
        assert!(service.send_once().await.unwrap());
        assert_eq!(fake.requests.lock().unwrap().len(), 1);
        service
            .record(&track, listen, "browser:one", now(), 100.0, 200.0)
            .unwrap();
        assert!(service.send_once().await.unwrap());
        service
            .record(&track, listen, "browser:one", now(), 150.0, 200.0)
            .unwrap();
        assert!(!service.send_once().await.unwrap());
        assert_eq!(fake.requests.lock().unwrap().len(), 2);
        assert_eq!(service.status().unwrap().submitted, 1);
        let sealed: String = db
            .get()
            .unwrap()
            .query_row("SELECT credentials FROM lastfm_config", [], |r| r.get(0))
            .unwrap();
        for secret in ["testkey", "testsecret", "testsession"] {
            assert!(!sealed.contains(secret));
        }
        drop(service);
        let restarted = LastFm::new(db).unwrap();
        assert_eq!(restarted.status().unwrap().submitted, 1);
        assert!(restarted.status().unwrap().connected);
        restarted
            .record(&track, listen, "browser:one", now(), 180.0, 200.0)
            .unwrap();
        assert_eq!(restarted.status().unwrap().pending, 0);
    }

    #[tokio::test]
    async fn handoff_combines_browser_and_sonos_time_and_distinguishes_replays() {
        let mut service = LastFm::in_memory();
        connect(&service);
        let fake = fake(&mut service).await;
        let track = track();
        let listen = Uuid::new_v4();
        service
            .record(&track, listen, "browser:one", now(), 60.0, 200.0)
            .unwrap();
        service.bind_sonos("occurrence", Some(listen)).unwrap();
        let mut report = SonosReport {
            id: "occurrence".into(),
            report_id: Some(Uuid::new_v4()),
            duration_played_millis: 39_000,
            time_since_playback_millis: 40_000,
            kind: "update".into(),
        };
        service.record_sonos(&track, &report).unwrap();
        assert_eq!(service.status().unwrap().pending, 0);
        service.record_sonos(&track, &report).unwrap();
        assert_eq!(service.status().unwrap().pending, 0);
        report.duration_played_millis = 40_000;
        service.record_sonos(&track, &report).unwrap();
        assert_eq!(service.status().unwrap().pending, 1);
        assert!(service.send_once().await.unwrap());
        report.kind = "final".into();
        report.duration_played_millis = 50_000;
        service.record_sonos(&track, &report).unwrap();
        assert_eq!(service.status().unwrap().pending, 0);
        // Going back to the same Sonos queue item is a new logical playback.
        report.report_id = Some(Uuid::new_v4());
        report.duration_played_millis = 100_000;
        service.record_sonos(&track, &report).unwrap();
        assert_eq!(service.status().unwrap().pending, 1);
        assert!(service.send_once().await.unwrap());
        assert_eq!(service.status().unwrap().submitted, 2);
        assert_eq!(
            fake.requests
                .lock()
                .unwrap()
                .iter()
                .filter(|r| r["method"] == "track.scrobble")
                .count(),
            2
        );
    }

    #[tokio::test]
    async fn retries_service_errors_but_requires_reconnection_for_revoked_sessions() {
        let mut service = LastFm::in_memory();
        connect(&service);
        let fake = fake(&mut service).await;
        let track = track();
        let id = Uuid::new_v4();
        service
            .record(&track, id, "one", now() - 120, 100.0, 200.0)
            .unwrap();
        fake.error.store(16, Ordering::SeqCst);
        assert!(!service.send_once().await.unwrap());
        assert_eq!(service.status().unwrap().pending, 1);
        assert!(!service.send_once().await.unwrap());
        assert_eq!(fake.requests.lock().unwrap().len(), 1);
        service
            .db
            .get()
            .unwrap()
            .execute("UPDATE lastfm_listens SET next_attempt=0", [])
            .unwrap();
        fake.error.store(9, Ordering::SeqCst);
        assert!(!service.send_once().await.unwrap());
        assert!(!service.status().unwrap().connected);
        assert_eq!(service.status().unwrap().pending, 1);
        fake.error.store(0, Ordering::SeqCst);
        connect(&service);
        service
            .db
            .get()
            .unwrap()
            .execute("UPDATE lastfm_listens SET next_attempt=0", [])
            .unwrap();
        assert!(service.send_once().await.unwrap());
        assert_eq!(service.status().unwrap().submitted, 1);
        assert!(fake
            .requests
            .lock()
            .unwrap()
            .iter()
            .all(|r| r["method"] == "track.scrobble"));
    }

    #[test]
    fn excludes_short_tracks_missing_metadata_and_disabled_listening() {
        let service = LastFm::in_memory();
        connect(&service);
        let mut track = track();
        service
            .record(&track, Uuid::new_v4(), "one", now(), 30.0, 30.0)
            .unwrap();
        track.artist.clear();
        service
            .record(&track, Uuid::new_v4(), "two", now(), 200.0, 200.0)
            .unwrap();
        track.artist = "Björk".into();
        service
            .db
            .get()
            .unwrap()
            .execute("UPDATE lastfm_config SET enabled=0", [])
            .unwrap();
        service
            .record(&track, Uuid::new_v4(), "three", now(), 200.0, 200.0)
            .unwrap();
        assert_eq!(service.status().unwrap().pending, 0);
    }

    #[tokio::test]
    async fn authorization_requires_unexpired_single_use_state_and_the_expected_account() {
        let mut service = LastFm::in_memory();
        service
            .save_credentials(&Credentials {
                api_key: "testkey".into(),
                secret: "testsecret".into(),
                session: None,
                username: None,
            })
            .unwrap();
        let fake = fake(&mut service).await;
        let prepare = |expires| {
            service
                .db
                .get()
                .unwrap()
                .execute(
                    "UPDATE lastfm_config SET auth_state='expected',auth_expires=?1",
                    [expires],
                )
                .unwrap();
        };
        let callback = |state: &str| Callback {
            state: state.into(),
            token: "temporary-token".into(),
        };
        prepare(now() + 60);
        assert!(service
            .complete_authorization(callback("wrong"))
            .await
            .is_err());
        assert!(fake.requests.lock().unwrap().is_empty());
        prepare(now() - 1);
        assert!(service
            .complete_authorization(callback("expected"))
            .await
            .is_err());
        assert!(fake.requests.lock().unwrap().is_empty());
        prepare(now() + 60);
        fake.error.store(99, Ordering::SeqCst);
        assert!(service
            .complete_authorization(callback("expected"))
            .await
            .is_err());
        assert!(!service.status().unwrap().connected);
        assert!(service
            .complete_authorization(callback("expected"))
            .await
            .is_err());
        assert_eq!(fake.requests.lock().unwrap().len(), 1);
        prepare(now() + 60);
        fake.error.store(0, Ordering::SeqCst);
        service
            .complete_authorization(callback("expected"))
            .await
            .unwrap();
        assert!(service.status().unwrap().connected);
        assert_eq!(
            service.credentials().unwrap().unwrap().session.as_deref(),
            Some("new-session")
        );
        assert!(service
            .complete_authorization(callback("expected"))
            .await
            .is_err());
    }

    #[tokio::test]
    async fn long_songs_use_four_minutes_and_rejected_scrobbles_do_not_retry() {
        let mut service = LastFm::in_memory();
        connect(&service);
        let fake = fake(&mut service).await;
        let track = track();
        let id = Uuid::new_v4();
        service
            .record(&track, id, "long", now() - 300, 239.0, 1200.0)
            .unwrap();
        assert_eq!(service.status().unwrap().pending, 0);
        service
            .record(&track, id, "long", now() - 300, 240.0, 1200.0)
            .unwrap();
        assert_eq!(service.status().unwrap().pending, 1);
        fake.error.store(98, Ordering::SeqCst);
        assert!(service.send_once().await.unwrap());
        assert_eq!(service.status().unwrap().submitted, 0);
        assert_eq!(service.status().unwrap().pending, 0);
        assert!(!service.send_once().await.unwrap());
        fake.error.store(13, Ordering::SeqCst);
        service
            .record(&track, Uuid::new_v4(), "bad", now() - 300, 100.0, 200.0)
            .unwrap();
        assert!(!service.send_once().await.unwrap());
        assert_eq!(service.status().unwrap().pending, 0);
        assert!(!service.send_once().await.unwrap());
        assert!(!service
            .status()
            .unwrap()
            .last_error
            .unwrap()
            .contains("untrusted"));
    }
}
