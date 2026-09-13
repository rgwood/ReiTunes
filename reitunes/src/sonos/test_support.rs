use super::*;

// Use the production client with an isolated database and loopback endpoints.
pub(crate) fn connected_control(base_url: &str, db: Pool<SqliteConnectionManager>) -> SonosControl {
    let base = Url::parse(base_url).unwrap();
    let control = SonosControl::new(
        SonosConfig {
            client_id: "test-client".into(),
            client_secret: "test-secret".into(),
            redirect_uri: "https://example.test/callback".into(),
            token_encryption_key: [42; 32],
        },
        SonosEndpoints {
            authorization: base.join("authorize").unwrap(),
            token: base.join("token").unwrap(),
            control: base.join("control/api/v1/").unwrap(),
        },
        db,
    )
    .unwrap();
    control
        .save_tokens(&StoredTokenSet {
            access_token: "test-access-token".into(),
            refresh_token: "test-refresh-token".into(),
            token_type: "Bearer".into(),
            scope: None,
            expires_at_unix: u64::MAX,
        })
        .unwrap();
    control
        .remember_session("group-1", "evicted-session")
        .unwrap();
    control
}

pub(crate) fn playback_signature(control: &SonosControl, sequence: &str) -> String {
    control.event_signature(sequence, "playback", "playbackStatus", "groupId", "group-1")
}
