use std::{
    collections::HashMap,
    sync::{Arc, Mutex as StdMutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use anyhow::{bail, Context, Result};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use openssl::symm::{Cipher, Crypter, Mode};
use r2d2::Pool;
use r2d2_sqlite::SqliteConnectionManager;
use rand::{rngs::OsRng, RngCore};
use reqwest::Url;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;
use tracing::warn;

use crate::cloud_queue::PlaybackQueueParameters;

const SONOS_SCOPE: &str = "playback-control-all";
const SONOS_API_KEY_HEADER: &str = "X-Sonos-Api-Key";
const SONOS_CORRELATION_ID_HEADER: &str = "X-Sonos-Corr-Id";
const REITUNES_APP_ID: &str = "com.reillywood.reitunes";
const REITUNES_APP_CONTEXT: &str = "personal-library";
const STATE_LIFETIME: Duration = Duration::from_secs(10 * 60);
const EVENT_SUBSCRIPTION_RENEW_AFTER: Duration = Duration::from_secs(2 * 24 * 60 * 60);
const REFRESH_EARLY_BY_SECONDS: u64 = 60;
const TOKEN_AAD: &[u8] = b"reitunes-sonos-oauth-v1";

#[derive(Clone)]
struct SonosConfig {
    client_id: String,
    client_secret: String,
    redirect_uri: String,
    token_encryption_key: [u8; 32],
}

impl SonosConfig {
    fn from_env() -> Result<Option<Self>> {
        let client_id = configured_value("SONOS_CLIENT_ID", option_env!("SONOS_CLIENT_ID"));
        let client_secret =
            configured_value("SONOS_CLIENT_SECRET", option_env!("SONOS_CLIENT_SECRET"));
        let redirect_uri =
            configured_value("SONOS_REDIRECT_URI", option_env!("SONOS_REDIRECT_URI"));
        let encryption_secret = configured_value(
            "SONOS_TOKEN_ENCRYPTION_SECRET",
            option_env!("SONOS_TOKEN_ENCRYPTION_SECRET"),
        );

        if [
            &client_id,
            &client_secret,
            &redirect_uri,
            &encryption_secret,
        ]
        .iter()
        .all(|value| value.is_none())
        {
            return Ok(None);
        }

        let client_id =
            client_id.context("SONOS_CLIENT_ID is required when Sonos is configured")?;
        let client_secret =
            client_secret.context("SONOS_CLIENT_SECRET is required when Sonos is configured")?;
        let redirect_uri =
            redirect_uri.context("SONOS_REDIRECT_URI is required when Sonos is configured")?;
        let encryption_secret = encryption_secret
            .context("SONOS_TOKEN_ENCRYPTION_SECRET is required when Sonos is configured")?;

        let redirect_url = Url::parse(&redirect_uri).context("SONOS_REDIRECT_URI is not a URL")?;
        if redirect_url.scheme() != "https" && redirect_url.host_str() != Some("localhost") {
            bail!("SONOS_REDIRECT_URI must use HTTPS (except on localhost)");
        }
        if encryption_secret.len() < 32 {
            bail!("SONOS_TOKEN_ENCRYPTION_SECRET must be at least 32 characters");
        }

        let token_encryption_key = Sha256::digest(encryption_secret.as_bytes()).into();
        Ok(Some(Self {
            client_id,
            client_secret,
            redirect_uri,
            token_encryption_key,
        }))
    }
}

fn configured_value(name: &str, compile_time_value: Option<&'static str>) -> Option<String> {
    compile_time_value
        .filter(|value| !value.trim().is_empty())
        .map(ToOwned::to_owned)
        .or_else(|| std::env::var(name).ok())
        .filter(|value| !value.trim().is_empty())
}

#[derive(Clone)]
struct SonosEndpoints {
    authorization: Url,
    token: Url,
    control: Url,
}

impl Default for SonosEndpoints {
    fn default() -> Self {
        Self {
            authorization: Url::parse("https://api.sonos.com/login/v3/oauth")
                .expect("hard-coded Sonos authorization URL should be valid"),
            token: Url::parse("https://api.sonos.com/login/v3/oauth/access")
                .expect("hard-coded Sonos token URL should be valid"),
            control: Url::parse("https://api.ws.sonos.com/control/api/v1/")
                .expect("hard-coded Sonos control URL should be valid"),
        }
    }
}

#[derive(Debug, Serialize)]
pub struct SonosStatus {
    pub configured: bool,
    pub connected: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Household {
    pub id: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct HouseholdsResponse {
    #[serde(default)]
    pub households: Vec<Household>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SonosGroup {
    pub id: String,
    pub name: String,
    pub coordinator_id: String,
    #[serde(default)]
    pub player_ids: Vec<String>,
    #[serde(default)]
    pub playback_state: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SonosPlayer {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub capabilities: Vec<String>,
    #[serde(default)]
    pub websocket_url: Option<String>,
    #[serde(default)]
    pub software_version: Option<String>,
    #[serde(default)]
    pub api_version: Option<String>,
    #[serde(default)]
    pub min_api_version: Option<String>,
    #[serde(default)]
    pub is_unregistered: Option<bool>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct GroupsResponse {
    #[serde(default)]
    pub groups: Vec<SonosGroup>,
    #[serde(default)]
    pub players: Vec<SonosPlayer>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SonosPlaybackStatus {
    pub group_id: String,
    pub session_created: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SonosGroupPlayback {
    pub playback_state: String,
    #[serde(default)]
    pub position_millis: u64,
    #[serde(default)]
    pub item_id: Option<String>,
    #[serde(default)]
    pub queue_version: Option<String>,
    #[serde(default)]
    pub available_playback_actions: Option<SonosPlaybackActions>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SonosPlaybackActions {
    #[serde(default)]
    pub can_pause: Option<bool>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct SonosGroupVolume {
    pub volume: u8,
    pub muted: bool,
    pub fixed: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum SonosPlaybackError {
    #[error("Choose this Sonos group again to confirm that ReiTunes may replace its playback")]
    TakeoverRequired,
    #[error("The ReiTunes Sonos session ended; choose the group again before playing: {0}")]
    SessionEnded(#[source] anyhow::Error),
    #[error(transparent)]
    Control(#[from] anyhow::Error),
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CreateSessionRequest<'a> {
    app_id: &'a str,
    app_context: &'a str,
    custom_data: &'a str,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionStatus {
    session_id: Option<String>,
    #[serde(default)]
    session_created: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LoadCloudQueueRequest<'a> {
    queue_base_url: &'a str,
    http_authorization: &'a str,
    use_http_authorization_for_media: bool,
    item_id: &'a str,
    queue_version: &'a str,
    position_millis: u32,
    play_on_completion: bool,
}

#[derive(Debug, Serialize)]
struct SetVolumeRequest {
    volume: u8,
}

#[derive(Debug, Serialize)]
struct SetMuteRequest {
    muted: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct StoredTokenSet {
    access_token: String,
    refresh_token: String,
    token_type: String,
    scope: Option<String>,
    expires_at_unix: u64,
}

impl StoredTokenSet {
    fn should_refresh(&self) -> bool {
        self.expires_at_unix <= unix_timestamp().saturating_add(REFRESH_EARLY_BY_SECONDS)
    }
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default = "default_token_type")]
    token_type: String,
    #[serde(default)]
    scope: Option<String>,
    expires_in: u64,
}

fn default_token_type() -> String {
    "Bearer".to_string()
}

#[derive(Debug)]
struct EncryptedTokens {
    nonce: Vec<u8>,
    ciphertext: Vec<u8>,
    authentication_tag: Vec<u8>,
}

pub struct SonosControl {
    config: SonosConfig,
    endpoints: SonosEndpoints,
    client: reqwest::Client,
    db: Pool<SqliteConnectionManager>,
    pending_states: StdMutex<HashMap<String, Instant>>,
    playback_sessions: StdMutex<HashMap<String, String>>,
    event_subscriptions: StdMutex<HashMap<String, Instant>>,
    event_sequences: StdMutex<HashMap<String, u64>>,
    refresh_lock: Mutex<()>,
}

impl SonosControl {
    pub fn from_env(db: Pool<SqliteConnectionManager>) -> Result<Option<Arc<Self>>> {
        let Some(config) = SonosConfig::from_env()? else {
            return Ok(None);
        };
        Ok(Some(Arc::new(Self::new(
            config,
            SonosEndpoints::default(),
            db,
        )?)))
    }

    fn new(
        config: SonosConfig,
        endpoints: SonosEndpoints,
        db: Pool<SqliteConnectionManager>,
    ) -> Result<Self> {
        let playback_sessions = load_playback_sessions(&db)?;
        Ok(Self {
            config,
            endpoints,
            client: reqwest::Client::builder()
                .user_agent(concat!("ReiTunes/", env!("CARGO_PKG_VERSION")))
                .build()
                .expect("ReiTunes Sonos HTTP client should be valid"),
            db,
            pending_states: StdMutex::new(HashMap::new()),
            playback_sessions: StdMutex::new(playback_sessions),
            event_subscriptions: StdMutex::new(HashMap::new()),
            event_sequences: StdMutex::new(HashMap::new()),
            refresh_lock: Mutex::new(()),
        })
    }

    pub fn status(&self) -> Result<SonosStatus> {
        Ok(SonosStatus {
            configured: true,
            connected: self.load_tokens()?.is_some(),
        })
    }

    pub fn authorization_url(&self) -> Result<Url> {
        let state = random_state();
        {
            let mut pending = self
                .pending_states
                .lock()
                .map_err(|_| anyhow::anyhow!("Sonos OAuth state lock was poisoned"))?;
            pending.retain(|_, created| created.elapsed() < STATE_LIFETIME);
            pending.insert(state.clone(), Instant::now());
        }

        let mut url = self.endpoints.authorization.clone();
        url.query_pairs_mut()
            .append_pair("client_id", &self.config.client_id)
            .append_pair("response_type", "code")
            .append_pair("state", &state)
            .append_pair("scope", SONOS_SCOPE)
            .append_pair("redirect_uri", &self.config.redirect_uri);
        Ok(url)
    }

    pub async fn complete_authorization(&self, code: &str, state: &str) -> Result<()> {
        self.consume_state(state)?;

        let response = self
            .client
            .post(self.endpoints.token.clone())
            .basic_auth(&self.config.client_id, Some(&self.config.client_secret))
            .form(&[
                ("grant_type", "authorization_code"),
                ("code", code),
                ("redirect_uri", self.config.redirect_uri.as_str()),
            ])
            .send()
            .await
            .context("failed to reach Sonos OAuth token endpoint")?;

        let token = parse_token_response(response).await?;
        let refresh_token = token
            .refresh_token
            .context("Sonos did not return a refresh token")?;
        self.save_tokens(&StoredTokenSet {
            access_token: token.access_token,
            refresh_token,
            token_type: token.token_type,
            scope: token.scope,
            expires_at_unix: unix_timestamp().saturating_add(token.expires_in),
        })
    }

    pub async fn households(&self) -> Result<HouseholdsResponse> {
        self.get_control_api("households").await
    }

    pub async fn groups(&self, household_id: &str) -> Result<GroupsResponse> {
        let url = self.control_url(&["households", household_id, "groups"])?;
        self.get_url(url).await
    }

    pub async fn play_cloud_queue(
        &self,
        group_id: &str,
        queue: &PlaybackQueueParameters,
        position_millis: u32,
        allow_takeover: bool,
    ) -> std::result::Result<SonosPlaybackStatus, SonosPlaybackError> {
        let existing_session = self
            .playback_sessions
            .lock()
            .map_err(|_| anyhow::anyhow!("Sonos playback session lock was poisoned"))?
            .get(group_id)
            .cloned();

        let (session_id, session_created) = match existing_session {
            Some(session_id) => (session_id, false),
            None if !allow_takeover => return Err(SonosPlaybackError::TakeoverRequired),
            None => {
                let session = self.create_session(group_id).await?;
                let session_id = session
                    .session_id
                    .context("Sonos did not return a playback session ID")?;
                self.remember_session(group_id, &session_id)?;
                (session_id, session.session_created)
            }
        };

        if let Err(error) = self
            .load_cloud_queue(&session_id, queue, position_millis)
            .await
        {
            self.forget_session(group_id, &session_id)?;
            return Err(SonosPlaybackError::SessionEnded(error));
        }

        if let Err(error) = self.ensure_event_subscriptions(group_id).await {
            warn!(error = %error, group_id, "Sonos playback started without event subscriptions");
        }

        Ok(SonosPlaybackStatus {
            group_id: group_id.to_string(),
            session_created,
        })
    }

    pub async fn group_playback(&self, group_id: &str) -> Result<SonosGroupPlayback> {
        let url = self.control_url(&["groups", group_id, "playback"])?;
        self.get_url(url).await
    }

    pub async fn play(&self, group_id: &str) -> Result<()> {
        let url = self.control_url(&["groups", group_id, "playback", "play"])?;
        self.post_command(url).await
    }

    pub async fn pause(&self, group_id: &str) -> Result<()> {
        let url = self.control_url(&["groups", group_id, "playback", "pause"])?;
        self.post_command(url).await
    }

    pub async fn group_volume(&self, group_id: &str) -> Result<SonosGroupVolume> {
        let url = self.control_url(&["groups", group_id, "groupVolume"])?;
        self.get_url(url).await
    }

    pub async fn set_group_volume(&self, group_id: &str, volume: u8) -> Result<()> {
        let url = self.control_url(&["groups", group_id, "groupVolume"])?;
        self.post_empty(url, &SetVolumeRequest { volume }).await
    }

    pub async fn set_group_mute(&self, group_id: &str, muted: bool) -> Result<()> {
        let url = self.control_url(&["groups", group_id, "groupVolume", "mute"])?;
        self.post_empty(url, &SetMuteRequest { muted }).await
    }

    pub fn has_playback_session(&self, group_id: &str) -> Result<bool> {
        Ok(self
            .playback_sessions
            .lock()
            .map_err(|_| anyhow::anyhow!("Sonos playback session lock was poisoned"))?
            .contains_key(group_id))
    }

    pub async fn ensure_event_subscriptions(&self, group_id: &str) -> Result<()> {
        let is_fresh = self
            .event_subscriptions
            .lock()
            .map_err(|_| anyhow::anyhow!("Sonos event subscription lock was poisoned"))?
            .get(group_id)
            .is_some_and(|created| created.elapsed() < EVENT_SUBSCRIPTION_RENEW_AFTER);
        if is_fresh {
            return Ok(());
        }

        for namespace in ["playback", "groupVolume"] {
            let url = self.control_url(&["groups", group_id, namespace, "subscription"])?;
            self.post_empty(url, &serde_json::json!({})).await?;
        }
        self.event_subscriptions
            .lock()
            .map_err(|_| anyhow::anyhow!("Sonos event subscription lock was poisoned"))?
            .insert(group_id.to_string(), Instant::now());
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    pub fn accept_event(
        &self,
        sequence_id: &str,
        namespace: &str,
        event_type: &str,
        target_type: &str,
        target_value: &str,
        supplied_signature: &str,
    ) -> Result<bool> {
        let expected_signature = self.event_signature(
            sequence_id,
            namespace,
            event_type,
            target_type,
            target_value,
        );
        if expected_signature.len() != supplied_signature.len()
            || !openssl::memcmp::eq(expected_signature.as_bytes(), supplied_signature.as_bytes())
        {
            bail!("Sonos event signature did not match");
        }

        let sequence_id = sequence_id
            .parse::<u64>()
            .context("Sonos event sequence ID was not an integer")?;
        let sequence_key = format!("{namespace}\0{target_type}\0{target_value}");
        let mut sequences = self
            .event_sequences
            .lock()
            .map_err(|_| anyhow::anyhow!("Sonos event sequence lock was poisoned"))?;
        let is_new = sequences
            .get(&sequence_key)
            .is_none_or(|previous| sequence_id > *previous);
        if is_new {
            sequences.insert(sequence_key, sequence_id);
        }
        Ok(is_new)
    }

    pub fn disconnect(&self) -> Result<()> {
        let conn = self.db.get()?;
        conn.execute("DELETE FROM sonos_oauth_tokens WHERE Id = 1", [])?;
        conn.execute("DELETE FROM sonos_playback_sessions", [])?;
        self.playback_sessions
            .lock()
            .map_err(|_| anyhow::anyhow!("Sonos playback session lock was poisoned"))?
            .clear();
        self.event_subscriptions
            .lock()
            .map_err(|_| anyhow::anyhow!("Sonos event subscription lock was poisoned"))?
            .clear();
        self.event_sequences
            .lock()
            .map_err(|_| anyhow::anyhow!("Sonos event sequence lock was poisoned"))?
            .clear();
        Ok(())
    }

    fn event_signature(
        &self,
        sequence_id: &str,
        namespace: &str,
        event_type: &str,
        target_type: &str,
        target_value: &str,
    ) -> String {
        let mut digest = Sha256::new();
        for value in [
            sequence_id,
            namespace,
            event_type,
            target_type,
            target_value,
            self.config.client_id.as_str(),
            self.config.client_secret.as_str(),
        ] {
            digest.update(value.as_bytes());
        }
        URL_SAFE_NO_PAD.encode(digest.finalize())
    }

    async fn create_session(&self, group_id: &str) -> Result<SessionStatus> {
        let url = self.control_url(&["groups", group_id, "playbackSession"])?;
        self.post_json(
            url,
            &CreateSessionRequest {
                app_id: REITUNES_APP_ID,
                app_context: REITUNES_APP_CONTEXT,
                custom_data: "ReiTunes Cloud Queue",
            },
        )
        .await
    }

    async fn load_cloud_queue(
        &self,
        session_id: &str,
        queue: &PlaybackQueueParameters,
        position_millis: u32,
    ) -> Result<()> {
        let url = self.control_url(&[
            "playbackSessions",
            session_id,
            "playbackSession",
            "loadCloudQueue",
        ])?;
        self.post_empty(
            url,
            &LoadCloudQueueRequest {
                queue_base_url: &queue.queue_base_url,
                http_authorization: &queue.http_authorization,
                use_http_authorization_for_media: false,
                item_id: &queue.item_id,
                queue_version: &queue.queue_version,
                position_millis,
                play_on_completion: true,
            },
        )
        .await
    }

    fn forget_session(&self, group_id: &str, session_id: &str) -> Result<()> {
        let mut sessions = self
            .playback_sessions
            .lock()
            .map_err(|_| anyhow::anyhow!("Sonos playback session lock was poisoned"))?;
        if sessions
            .get(group_id)
            .is_some_and(|stored| stored == session_id)
        {
            let conn = self.db.get()?;
            conn.execute(
                "DELETE FROM sonos_playback_sessions
                 WHERE GroupId = ?1 AND SessionId = ?2",
                params![group_id, session_id],
            )?;
            sessions.remove(group_id);
        }
        Ok(())
    }

    fn remember_session(&self, group_id: &str, session_id: &str) -> Result<()> {
        let conn = self.db.get()?;
        conn.execute(
            "INSERT OR REPLACE INTO sonos_playback_sessions (GroupId, SessionId)
             VALUES (?1, ?2)",
            params![group_id, session_id],
        )?;
        self.playback_sessions
            .lock()
            .map_err(|_| anyhow::anyhow!("Sonos playback session lock was poisoned"))?
            .insert(group_id.to_string(), session_id.to_string());
        Ok(())
    }

    async fn get_control_api<T>(&self, path: &str) -> Result<T>
    where
        T: for<'de> Deserialize<'de>,
    {
        let url = self
            .endpoints
            .control
            .join(path)
            .context("failed to build Sonos control API URL")?;
        self.get_url(url).await
    }

    fn control_url(&self, segments: &[&str]) -> Result<Url> {
        let mut url = self.endpoints.control.clone();
        url.path_segments_mut()
            .map_err(|_| anyhow::anyhow!("invalid Sonos control API base URL"))?
            .pop_if_empty()
            .extend(segments.iter().copied());
        Ok(url)
    }

    async fn get_url<T>(&self, url: Url) -> Result<T>
    where
        T: for<'de> Deserialize<'de>,
    {
        let access_token = self.access_token().await?;
        let response = self
            .client
            .get(url)
            .bearer_auth(access_token)
            .header(SONOS_API_KEY_HEADER, &self.config.client_id)
            .header(
                SONOS_CORRELATION_ID_HEADER,
                uuid::Uuid::new_v4().to_string(),
            )
            .send()
            .await
            .context("failed to reach Sonos control API")?;
        parse_json_response(response).await
    }

    async fn post_json<B, T>(&self, url: Url, body: &B) -> Result<T>
    where
        B: Serialize + ?Sized,
        T: for<'de> Deserialize<'de>,
    {
        let response = self.post_request(url, body).await?;
        parse_json_response(response).await
    }

    async fn post_command(&self, url: Url) -> Result<()> {
        let access_token = self.access_token().await?;
        let response = self
            .client
            .post(url)
            .bearer_auth(access_token)
            .header(SONOS_API_KEY_HEADER, &self.config.client_id)
            .header(
                SONOS_CORRELATION_ID_HEADER,
                uuid::Uuid::new_v4().to_string(),
            )
            .send()
            .await
            .context("failed to reach Sonos control API")?;
        ensure_success_response(response).await
    }

    async fn post_empty<B>(&self, url: Url, body: &B) -> Result<()>
    where
        B: Serialize + ?Sized,
    {
        let response = self.post_request(url, body).await?;
        ensure_success_response(response).await
    }

    async fn post_request<B>(&self, url: Url, body: &B) -> Result<reqwest::Response>
    where
        B: Serialize + ?Sized,
    {
        let access_token = self.access_token().await?;
        self.client
            .post(url)
            .bearer_auth(access_token)
            .header(SONOS_API_KEY_HEADER, &self.config.client_id)
            .header(
                SONOS_CORRELATION_ID_HEADER,
                uuid::Uuid::new_v4().to_string(),
            )
            .json(body)
            .send()
            .await
            .context("failed to reach Sonos control API")
    }

    async fn access_token(&self) -> Result<String> {
        let token = self
            .load_tokens()?
            .context("ReiTunes is not connected to Sonos")?;
        if !token.should_refresh() {
            return Ok(token.access_token);
        }

        let _refresh_guard = self.refresh_lock.lock().await;
        let token = self
            .load_tokens()?
            .context("ReiTunes is not connected to Sonos")?;
        if !token.should_refresh() {
            return Ok(token.access_token);
        }

        let response = self
            .client
            .post(self.endpoints.token.clone())
            .basic_auth(&self.config.client_id, Some(&self.config.client_secret))
            .form(&[
                ("grant_type", "refresh_token"),
                ("refresh_token", token.refresh_token.as_str()),
            ])
            .send()
            .await
            .context("failed to refresh Sonos access token")?;
        let refreshed = parse_token_response(response).await?;
        let stored = StoredTokenSet {
            access_token: refreshed.access_token,
            refresh_token: refreshed.refresh_token.unwrap_or(token.refresh_token),
            token_type: refreshed.token_type,
            scope: refreshed.scope.or(token.scope),
            expires_at_unix: unix_timestamp().saturating_add(refreshed.expires_in),
        };
        self.save_tokens(&stored)?;
        Ok(stored.access_token)
    }

    fn consume_state(&self, state: &str) -> Result<()> {
        let created = self
            .pending_states
            .lock()
            .map_err(|_| anyhow::anyhow!("Sonos OAuth state lock was poisoned"))?
            .remove(state)
            .context("invalid or already-used Sonos OAuth state")?;
        if created.elapsed() >= STATE_LIFETIME {
            bail!("Sonos OAuth state expired; start the connection again");
        }
        Ok(())
    }

    fn save_tokens(&self, tokens: &StoredTokenSet) -> Result<()> {
        let plaintext = serde_json::to_vec(tokens)?;
        let encrypted = encrypt_tokens(&self.config.token_encryption_key, &plaintext)?;
        let conn = self.db.get()?;
        conn.execute(
            "INSERT INTO sonos_oauth_tokens (Id, Nonce, Ciphertext, AuthenticationTag)
             VALUES (1, ?1, ?2, ?3)
             ON CONFLICT(Id) DO UPDATE SET
                 Nonce = excluded.Nonce,
                 Ciphertext = excluded.Ciphertext,
                 AuthenticationTag = excluded.AuthenticationTag",
            params![
                encrypted.nonce,
                encrypted.ciphertext,
                encrypted.authentication_tag
            ],
        )?;
        Ok(())
    }

    fn load_tokens(&self) -> Result<Option<StoredTokenSet>> {
        let conn = self.db.get()?;
        let encrypted = conn
            .query_row(
                "SELECT Nonce, Ciphertext, AuthenticationTag
                 FROM sonos_oauth_tokens WHERE Id = 1",
                [],
                |row| {
                    Ok(EncryptedTokens {
                        nonce: row.get(0)?,
                        ciphertext: row.get(1)?,
                        authentication_tag: row.get(2)?,
                    })
                },
            )
            .optional()?;

        encrypted
            .map(|encrypted| {
                let plaintext = decrypt_tokens(&self.config.token_encryption_key, &encrypted)
                    .context("stored Sonos credentials could not be decrypted")?;
                serde_json::from_slice(&plaintext)
                    .context("stored Sonos credentials were not valid JSON")
            })
            .transpose()
    }
}

fn load_playback_sessions(db: &Pool<SqliteConnectionManager>) -> Result<HashMap<String, String>> {
    let conn = db.get()?;
    let mut statement = conn.prepare("SELECT GroupId, SessionId FROM sonos_playback_sessions")?;
    let sessions = statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<std::result::Result<HashMap<_, _>, _>>()
        .map_err(anyhow::Error::from)?;
    Ok(sessions)
}

async fn parse_token_response(response: reqwest::Response) -> Result<TokenResponse> {
    parse_json_response(response).await
}

async fn parse_json_response<T>(response: reqwest::Response) -> Result<T>
where
    T: for<'de> Deserialize<'de>,
{
    let status = response.status();
    let body = response
        .text()
        .await
        .context("failed to read response from Sonos")?;
    if !status.is_success() {
        bail!("Sonos returned {status}: {body}");
    }
    serde_json::from_str(&body).context("Sonos returned an unexpected response")
}

async fn ensure_success_response(response: reqwest::Response) -> Result<()> {
    let status = response.status();
    if status.is_success() {
        return Ok(());
    }
    let body = response
        .text()
        .await
        .context("failed to read response from Sonos")?;
    bail!("Sonos returned {status}: {body}")
}

fn random_state() -> String {
    let mut bytes = [0_u8; 32];
    OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn unix_timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn encrypt_tokens(key: &[u8; 32], plaintext: &[u8]) -> Result<EncryptedTokens> {
    let cipher = Cipher::aes_256_gcm();
    let mut nonce = vec![0_u8; 12];
    OsRng.fill_bytes(&mut nonce);
    let mut crypter = Crypter::new(cipher, Mode::Encrypt, key, Some(&nonce))?;
    crypter.aad_update(TOKEN_AAD)?;

    let mut ciphertext = vec![0_u8; plaintext.len() + cipher.block_size()];
    let mut count = crypter.update(plaintext, &mut ciphertext)?;
    count += crypter.finalize(&mut ciphertext[count..])?;
    ciphertext.truncate(count);

    let mut authentication_tag = vec![0_u8; 16];
    crypter.get_tag(&mut authentication_tag)?;
    Ok(EncryptedTokens {
        nonce,
        ciphertext,
        authentication_tag,
    })
}

fn decrypt_tokens(key: &[u8; 32], encrypted: &EncryptedTokens) -> Result<Vec<u8>> {
    let cipher = Cipher::aes_256_gcm();
    let mut crypter = Crypter::new(cipher, Mode::Decrypt, key, Some(&encrypted.nonce))?;
    crypter.aad_update(TOKEN_AAD)?;
    crypter.set_tag(&encrypted.authentication_tag)?;

    let mut plaintext = vec![0_u8; encrypted.ciphertext.len() + cipher.block_size()];
    let mut count = crypter.update(&encrypted.ciphertext, &mut plaintext)?;
    count += crypter.finalize(&mut plaintext[count..])?;
    plaintext.truncate(count);
    Ok(plaintext)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        extract::{Form, State},
        http::HeaderMap,
        routing::get,
        Json, Router,
    };
    use reitunes_workspace::open_connection_pool;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn test_control() -> (SonosControl, tempfile::TempDir) {
        let temp_dir = tempfile::tempdir().unwrap();
        let db_path = temp_dir.path().join("test.db");
        let db = open_connection_pool(db_path.to_str().unwrap()).unwrap();
        let config = SonosConfig {
            client_id: "test-client".to_string(),
            client_secret: "test-secret".to_string(),
            redirect_uri: "https://example.com/api/sonos/callback".to_string(),
            token_encryption_key: [42; 32],
        };
        (
            SonosControl::new(config, SonosEndpoints::default(), db).unwrap(),
            temp_dir,
        )
    }

    async fn test_control_with_server(
        router: Router,
    ) -> (SonosControl, tempfile::TempDir, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });

        let (mut control, temp_dir) = test_control();
        let base = Url::parse(&format!("http://{address}/")).unwrap();
        control.endpoints = SonosEndpoints {
            authorization: base.join("authorize").unwrap(),
            token: base.join("token").unwrap(),
            control: base.join("control/api/v1/").unwrap(),
        };
        (control, temp_dir, server)
    }

    #[test]
    fn authorization_url_uses_documented_sonos_parameters() {
        let (control, _temp_dir) = test_control();
        let url = control.authorization_url().unwrap();
        let query: HashMap<_, _> = url.query_pairs().into_owned().collect();

        assert_eq!(
            url.as_str().split('?').next().unwrap(),
            "https://api.sonos.com/login/v3/oauth"
        );
        assert_eq!(query.get("client_id").unwrap(), "test-client");
        assert_eq!(query.get("response_type").unwrap(), "code");
        assert_eq!(query.get("scope").unwrap(), SONOS_SCOPE);
        assert_eq!(
            query.get("redirect_uri").unwrap(),
            "https://example.com/api/sonos/callback"
        );
        assert_eq!(query.get("state").unwrap().len(), 64);
    }

    #[test]
    fn oauth_state_is_single_use() {
        let (control, _temp_dir) = test_control();
        let url = control.authorization_url().unwrap();
        let state = url
            .query_pairs()
            .find(|(key, _)| key == "state")
            .unwrap()
            .1
            .into_owned();

        control.consume_state(&state).unwrap();
        assert!(control.consume_state(&state).is_err());
    }

    #[test]
    fn verifies_and_deduplicates_sonos_event_signatures() {
        let (control, _temp_dir) = test_control();
        let signature = "VoWjzk5Hp7dwBwuDePsf2uy2JkIA53I_Hp7AschNHSM";

        assert!(control
            .accept_event(
                "1234",
                "playback",
                "playbackStatus",
                "groupId",
                "group-1",
                signature,
            )
            .unwrap());
        assert!(!control
            .accept_event(
                "1234",
                "playback",
                "playbackStatus",
                "groupId",
                "group-1",
                signature,
            )
            .unwrap());
        assert!(control
            .accept_event(
                "1234",
                "playback",
                "playbackStatus",
                "groupId",
                "group-2",
                signature,
            )
            .is_err());
    }

    #[test]
    fn restores_and_forgets_playback_sessions_across_restarts() {
        let (control, _temp_dir) = test_control();
        let config = control.config.clone();
        let endpoints = control.endpoints.clone();
        let db = control.db.clone();
        control.remember_session("group-1", "session-1").unwrap();
        drop(control);

        let restored = SonosControl::new(config.clone(), endpoints.clone(), db.clone()).unwrap();
        assert!(restored.has_playback_session("group-1").unwrap());
        restored.forget_session("group-1", "session-1").unwrap();
        drop(restored);

        let restarted = SonosControl::new(config, endpoints, db).unwrap();
        assert!(!restarted.has_playback_session("group-1").unwrap());
    }

    #[test]
    fn stored_tokens_are_encrypted_and_authenticated() {
        let (control, _temp_dir) = test_control();
        let token = StoredTokenSet {
            access_token: "secret-access-token".to_string(),
            refresh_token: "secret-refresh-token".to_string(),
            token_type: "Bearer".to_string(),
            scope: Some(SONOS_SCOPE.to_string()),
            expires_at_unix: 1234,
        };
        control.save_tokens(&token).unwrap();

        let conn = control.db.get().unwrap();
        let ciphertext: Vec<u8> = conn
            .query_row(
                "SELECT Ciphertext FROM sonos_oauth_tokens WHERE Id = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(!String::from_utf8_lossy(&ciphertext).contains("secret-access-token"));
        drop(conn);

        let loaded = control.load_tokens().unwrap().unwrap();
        assert_eq!(loaded.access_token, token.access_token);
        assert_eq!(loaded.refresh_token, token.refresh_token);

        let conn = control.db.get().unwrap();
        conn.execute(
            "UPDATE sonos_oauth_tokens SET Ciphertext = zeroblob(length(Ciphertext)) WHERE Id = 1",
            [],
        )
        .unwrap();
        drop(conn);
        assert!(control.load_tokens().is_err());
    }

    #[test]
    fn groups_response_accepts_the_documented_discovery_shape() {
        let response: GroupsResponse = serde_json::from_value(serde_json::json!({
            "groups": [{
                "id": "RINCON_group:1",
                "name": "Kitchen + 1",
                "coordinatorId": "RINCON_kitchen",
                "playbackState": "PLAYBACK_STATE_IDLE",
                "playerIds": ["RINCON_kitchen", "RINCON_dining"]
            }],
            "players": [{
                "id": "RINCON_kitchen",
                "name": "Kitchen",
                "capabilities": ["PLAYBACK", "CLOUD"]
            }]
        }))
        .unwrap();

        assert_eq!(response.groups[0].name, "Kitchen + 1");
        assert_eq!(response.players[0].name, "Kitchen");
    }

    #[tokio::test]
    async fn exchanges_an_authorization_code_then_discovers_households() {
        async fn token(
            headers: HeaderMap,
            Form(form): Form<HashMap<String, String>>,
        ) -> Json<serde_json::Value> {
            assert!(headers
                .get("authorization")
                .unwrap()
                .to_str()
                .unwrap()
                .starts_with("Basic "));
            assert_eq!(form.get("grant_type").unwrap(), "authorization_code");
            assert_eq!(form.get("code").unwrap(), "authorization-code");
            Json(serde_json::json!({
                "access_token": "access-token",
                "refresh_token": "refresh-token",
                "token_type": "Bearer",
                "scope": SONOS_SCOPE,
                "expires_in": 86_400
            }))
        }

        async fn households(headers: HeaderMap) -> Json<serde_json::Value> {
            assert_eq!(headers.get("authorization").unwrap(), "Bearer access-token");
            assert_eq!(headers.get(SONOS_API_KEY_HEADER).unwrap(), "test-client");
            Json(serde_json::json!({
                "households": [{ "id": "Sonos_household" }]
            }))
        }

        let router = Router::new()
            .route("/token", axum::routing::post(token))
            .route("/control/api/v1/households", get(households));
        let (control, _temp_dir, server) = test_control_with_server(router).await;
        let authorization_url = control.authorization_url().unwrap();
        let state = authorization_url
            .query_pairs()
            .find(|(key, _)| key == "state")
            .unwrap()
            .1
            .into_owned();

        control
            .complete_authorization("authorization-code", &state)
            .await
            .unwrap();
        assert!(control.status().unwrap().connected);

        let households = control.households().await.unwrap();
        assert_eq!(households.households[0].id, "Sonos_household");
        server.abort();
    }

    #[tokio::test]
    async fn reads_and_controls_group_playback_and_volume() {
        fn assert_headers(headers: &HeaderMap) {
            assert_eq!(headers.get("authorization").unwrap(), "Bearer access-token");
            assert_eq!(headers.get(SONOS_API_KEY_HEADER).unwrap(), "test-client");
            uuid::Uuid::parse_str(
                headers
                    .get(SONOS_CORRELATION_ID_HEADER)
                    .unwrap()
                    .to_str()
                    .unwrap(),
            )
            .unwrap();
        }

        async fn playback(headers: HeaderMap) -> Json<serde_json::Value> {
            assert_headers(&headers);
            Json(serde_json::json!({
                "playbackState": "PLAYBACK_STATE_PLAYING",
                "positionMillis": 42_000,
                "itemId": "queue-item-1",
                "queueVersion": "queue-version-1",
                "availablePlaybackActions": { "canPause": true }
            }))
        }

        async fn volume(headers: HeaderMap) -> Json<serde_json::Value> {
            assert_headers(&headers);
            Json(serde_json::json!({ "volume": 37, "muted": false, "fixed": false }))
        }

        async fn command(headers: HeaderMap) -> axum::http::StatusCode {
            assert_headers(&headers);
            axum::http::StatusCode::OK
        }

        async fn set_volume(
            headers: HeaderMap,
            Json(body): Json<serde_json::Value>,
        ) -> axum::http::StatusCode {
            assert_headers(&headers);
            assert_eq!(body, serde_json::json!({ "volume": 63 }));
            axum::http::StatusCode::OK
        }

        async fn set_mute(
            headers: HeaderMap,
            Json(body): Json<serde_json::Value>,
        ) -> axum::http::StatusCode {
            assert_headers(&headers);
            assert_eq!(body, serde_json::json!({ "muted": true }));
            axum::http::StatusCode::OK
        }

        let router = Router::new()
            .route("/control/api/v1/groups/group-1/playback", get(playback))
            .route(
                "/control/api/v1/groups/group-1/playback/play",
                axum::routing::post(command),
            )
            .route(
                "/control/api/v1/groups/group-1/playback/pause",
                axum::routing::post(command),
            )
            .route(
                "/control/api/v1/groups/group-1/groupVolume",
                get(volume).post(set_volume),
            )
            .route(
                "/control/api/v1/groups/group-1/groupVolume/mute",
                axum::routing::post(set_mute),
            );
        let (control, _temp_dir, server) = test_control_with_server(router).await;
        control
            .save_tokens(&StoredTokenSet {
                access_token: "access-token".to_string(),
                refresh_token: "refresh-token".to_string(),
                token_type: "Bearer".to_string(),
                scope: Some(SONOS_SCOPE.to_string()),
                expires_at_unix: u64::MAX,
            })
            .unwrap();

        let playback = control.group_playback("group-1").await.unwrap();
        assert_eq!(playback.position_millis, 42_000);
        assert_eq!(playback.item_id.as_deref(), Some("queue-item-1"));
        assert_eq!(
            playback
                .available_playback_actions
                .and_then(|actions| actions.can_pause),
            Some(true)
        );
        assert_eq!(control.group_volume("group-1").await.unwrap().volume, 37);
        control.play("group-1").await.unwrap();
        control.pause("group-1").await.unwrap();
        control.set_group_volume("group-1", 63).await.unwrap();
        control.set_group_mute("group-1", true).await.unwrap();
        server.abort();
    }

    #[tokio::test]
    async fn requires_takeover_then_reuses_the_reitunes_playback_session() {
        #[derive(Clone)]
        struct TestState {
            sessions_created: Arc<AtomicUsize>,
            queues_loaded: Arc<AtomicUsize>,
            subscriptions: Arc<AtomicUsize>,
        }

        async fn create_session(
            State(state): State<TestState>,
            headers: HeaderMap,
            Json(body): Json<serde_json::Value>,
        ) -> Json<serde_json::Value> {
            assert_eq!(headers.get("authorization").unwrap(), "Bearer access-token");
            assert_eq!(headers.get(SONOS_API_KEY_HEADER).unwrap(), "test-client");
            uuid::Uuid::parse_str(
                headers
                    .get(SONOS_CORRELATION_ID_HEADER)
                    .unwrap()
                    .to_str()
                    .unwrap(),
            )
            .unwrap();
            assert_eq!(body["appId"], REITUNES_APP_ID);
            assert_eq!(body["appContext"], REITUNES_APP_CONTEXT);
            state.sessions_created.fetch_add(1, Ordering::SeqCst);
            Json(serde_json::json!({
                "sessionId": "session-1",
                "sessionState": "SESSION_STATE_CONNECTED",
                "sessionCreated": true
            }))
        }

        async fn load_queue(
            State(state): State<TestState>,
            headers: HeaderMap,
            Json(body): Json<serde_json::Value>,
        ) -> Json<serde_json::Value> {
            assert_eq!(headers.get("authorization").unwrap(), "Bearer access-token");
            assert_eq!(headers.get(SONOS_API_KEY_HEADER).unwrap(), "test-client");
            assert_eq!(body["queueBaseUrl"], "https://reitunes.example/queue/v2.3");
            assert_eq!(body["httpAuthorization"], "Bearer cloud-queue-secret");
            assert_eq!(body["useHttpAuthorizationForMedia"], false);
            assert_eq!(body["itemId"], "queue-item-1");
            assert_eq!(body["queueVersion"], "queue-version-1");
            assert_eq!(body["positionMillis"], 42_000);
            assert_eq!(body["playOnCompletion"], true);
            state.queues_loaded.fetch_add(1, Ordering::SeqCst);
            Json(serde_json::json!({ "success": true }))
        }

        async fn subscribe(
            State(state): State<TestState>,
            headers: HeaderMap,
            Json(body): Json<serde_json::Value>,
        ) -> Json<serde_json::Value> {
            assert_eq!(headers.get("authorization").unwrap(), "Bearer access-token");
            assert_eq!(headers.get(SONOS_API_KEY_HEADER).unwrap(), "test-client");
            assert_eq!(body, serde_json::json!({}));
            state.subscriptions.fetch_add(1, Ordering::SeqCst);
            Json(serde_json::json!({}))
        }

        let sessions_created = Arc::new(AtomicUsize::new(0));
        let queues_loaded = Arc::new(AtomicUsize::new(0));
        let subscriptions = Arc::new(AtomicUsize::new(0));
        let router = Router::new()
            .route(
                "/control/api/v1/groups/group-1/playbackSession",
                axum::routing::post(create_session),
            )
            .route(
                "/control/api/v1/playbackSessions/session-1/playbackSession/loadCloudQueue",
                axum::routing::post(load_queue),
            )
            .route(
                "/control/api/v1/groups/group-1/playback/subscription",
                axum::routing::post(subscribe),
            )
            .route(
                "/control/api/v1/groups/group-1/groupVolume/subscription",
                axum::routing::post(subscribe),
            )
            .fallback(|request: axum::extract::Request| async move {
                (
                    axum::http::StatusCode::NOT_FOUND,
                    request.uri().path().to_string(),
                )
            })
            .with_state(TestState {
                sessions_created: sessions_created.clone(),
                queues_loaded: queues_loaded.clone(),
                subscriptions: subscriptions.clone(),
            });
        let (control, _temp_dir, server) = test_control_with_server(router).await;
        control
            .save_tokens(&StoredTokenSet {
                access_token: "access-token".to_string(),
                refresh_token: "refresh-token".to_string(),
                token_type: "Bearer".to_string(),
                scope: Some(SONOS_SCOPE.to_string()),
                expires_at_unix: u64::MAX,
            })
            .unwrap();
        let queue = PlaybackQueueParameters {
            queue_base_url: "https://reitunes.example/queue/v2.3".to_string(),
            http_authorization: "Bearer cloud-queue-secret".to_string(),
            item_id: "queue-item-1".to_string(),
            queue_version: "queue-version-1".to_string(),
        };

        assert!(matches!(
            control
                .play_cloud_queue("group-1", &queue, 42_000, false)
                .await,
            Err(SonosPlaybackError::TakeoverRequired)
        ));
        assert_eq!(sessions_created.load(Ordering::SeqCst), 0);

        let first = control
            .play_cloud_queue("group-1", &queue, 42_000, true)
            .await
            .unwrap();
        assert!(first.session_created);
        let second = control
            .play_cloud_queue("group-1", &queue, 42_000, false)
            .await
            .unwrap();
        assert!(!second.session_created);
        assert_eq!(sessions_created.load(Ordering::SeqCst), 1);
        assert_eq!(queues_loaded.load(Ordering::SeqCst), 2);
        assert_eq!(subscriptions.load(Ordering::SeqCst), 2);
        server.abort();
    }

    #[tokio::test]
    async fn does_not_recreate_an_evicted_session_without_user_approval() {
        async fn create_session() -> Json<serde_json::Value> {
            Json(serde_json::json!({
                "sessionId": "evicted-session",
                "sessionState": "SESSION_STATE_CONNECTED",
                "sessionCreated": true
            }))
        }

        async fn reject_queue() -> (axum::http::StatusCode, Json<serde_json::Value>) {
            (
                axum::http::StatusCode::NOT_FOUND,
                Json(serde_json::json!({
                    "errorCode": "ERROR_INVALID_OBJECT_ID",
                    "reason": "The playback session ended"
                })),
            )
        }

        let router = Router::new()
            .route(
                "/control/api/v1/groups/group-1/playbackSession",
                axum::routing::post(create_session),
            )
            .route(
                "/control/api/v1/playbackSessions/evicted-session/playbackSession/loadCloudQueue",
                axum::routing::post(reject_queue),
            );
        let (control, _temp_dir, server) = test_control_with_server(router).await;
        control
            .save_tokens(&StoredTokenSet {
                access_token: "access-token".to_string(),
                refresh_token: "refresh-token".to_string(),
                token_type: "Bearer".to_string(),
                scope: Some(SONOS_SCOPE.to_string()),
                expires_at_unix: u64::MAX,
            })
            .unwrap();
        let queue = PlaybackQueueParameters {
            queue_base_url: "https://reitunes.example/queue/v2.3".to_string(),
            http_authorization: "Bearer cloud-queue-secret".to_string(),
            item_id: "queue-item-1".to_string(),
            queue_version: "queue-version-1".to_string(),
        };

        assert!(matches!(
            control.play_cloud_queue("group-1", &queue, 0, true).await,
            Err(SonosPlaybackError::SessionEnded(_))
        ));
        assert!(matches!(
            control.play_cloud_queue("group-1", &queue, 0, false).await,
            Err(SonosPlaybackError::TakeoverRequired)
        ));
        server.abort();
    }

    #[tokio::test]
    async fn refreshes_an_expired_token_without_losing_the_refresh_token() {
        #[derive(Clone)]
        struct TestState {
            refreshes: Arc<AtomicUsize>,
        }

        async fn token(
            State(state): State<TestState>,
            Form(form): Form<HashMap<String, String>>,
        ) -> Json<serde_json::Value> {
            assert_eq!(form.get("grant_type").unwrap(), "refresh_token");
            assert_eq!(form.get("refresh_token").unwrap(), "original-refresh-token");
            state.refreshes.fetch_add(1, Ordering::SeqCst);
            Json(serde_json::json!({
                "access_token": "refreshed-access-token",
                "token_type": "Bearer",
                "expires_in": 86_400
            }))
        }

        async fn households(headers: HeaderMap) -> Json<serde_json::Value> {
            assert_eq!(
                headers.get("authorization").unwrap(),
                "Bearer refreshed-access-token"
            );
            assert_eq!(headers.get(SONOS_API_KEY_HEADER).unwrap(), "test-client");
            Json(serde_json::json!({ "households": [] }))
        }

        let refreshes = Arc::new(AtomicUsize::new(0));
        let router = Router::new()
            .route("/token", axum::routing::post(token))
            .route("/control/api/v1/households", get(households))
            .with_state(TestState {
                refreshes: refreshes.clone(),
            });
        let (control, _temp_dir, server) = test_control_with_server(router).await;
        control
            .save_tokens(&StoredTokenSet {
                access_token: "expired-access-token".to_string(),
                refresh_token: "original-refresh-token".to_string(),
                token_type: "Bearer".to_string(),
                scope: Some(SONOS_SCOPE.to_string()),
                expires_at_unix: 0,
            })
            .unwrap();

        control.households().await.unwrap();
        assert_eq!(refreshes.load(Ordering::SeqCst), 1);
        let stored = control.load_tokens().unwrap().unwrap();
        assert_eq!(stored.access_token, "refreshed-access-token");
        assert_eq!(stored.refresh_token, "original-refresh-token");
        server.abort();
    }
}
