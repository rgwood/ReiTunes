//! Revision counters for data the frontend caches, plus a broadcast when any of it changes.
//!
//! The frontend fetches tags, discovery and playlists once, then refetches only when the
//! WebSocket says that resource changed. Revisions also serve as ETags, so a refetch of
//! unchanged data is answered with a 304 without touching the database.
//!
//! Tags change a few items at a time, and their snapshot is big, so tag messages carry the
//! changed items themselves and clients patch their copy instead of refetching.
//!
//! Ordering rule: advance the revision *after* a change is visible to readers, and read
//! it *before* building a response. A response may then carry an older revision than its
//! contents (costing one redundant refetch or patch) but never a newer one, which would
//! hide a change behind a 304.

use std::{
    future::Future,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use axum::{
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::Serialize;
use tokio::sync::broadcast;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Resource {
    Tags,
    Discovery,
    Playlists,
}

/// A resource's revision. `boot` tells revisions from different server runs apart.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct Revision {
    pub boot: u64,
    pub number: u64,
}

/// Sent to WebSocket clients as `{"type":"changed","resource":"playlists"}`, meaning
/// "refetch". With `items`, it's a patch: each item's new state as of `revision`
/// (`null` = gone), and clients apply it instead of refetching.
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename = "changed")]
pub struct Changed {
    pub resource: Resource,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revision: Option<Revision>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub items: Option<serde_json::Value>,
}

pub struct ChangeFeed {
    /// Distinguishes this process's revisions from a previous run's, so an ETag cached
    /// before a restart can't match.
    boot: u64,
    revisions: [AtomicU64; 3],
    tx: broadcast::Sender<Changed>,
}

impl Default for ChangeFeed {
    fn default() -> Self {
        let boot = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        Self {
            boot,
            revisions: Default::default(),
            tx: broadcast::channel(256).0,
        }
    }
}

impl ChangeFeed {
    /// Tells clients to refetch `resource`. Call after the change is visible to readers
    /// (committed; still holding the write lock is fine).
    pub fn bump(&self, resource: Resource) {
        self.advance(resource);
        let _ = self.tx.send(Changed { resource, revision: None, items: None });
    }

    /// Starts a new revision without telling anyone, for callers that send a patch.
    pub fn advance(&self, resource: Resource) -> Revision {
        let number = self.revisions[resource as usize].fetch_add(1, Ordering::SeqCst) + 1;
        Revision { boot: self.boot, number }
    }

    pub fn revision(&self, resource: Resource) -> Revision {
        let number = self.revisions[resource as usize].load(Ordering::SeqCst);
        Revision { boot: self.boot, number }
    }

    /// Sends changed items' new state, as of `revision` from [`ChangeFeed::advance`].
    pub fn patch(&self, resource: Resource, revision: Revision, items: serde_json::Value) {
        let _ = self.tx.send(Changed { resource, revision: Some(revision), items: Some(items) });
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Changed> {
        self.tx.subscribe()
    }

    /// `library_revision` is for responses partly derived from the library (tags go stale
    /// when metadata changes; discovery links entries to imported songs).
    pub fn etag(&self, resource: Resource, library_revision: Option<u64>) -> String {
        self.etag_at(self.revision(resource), resource, library_revision)
    }

    /// For responses that also include `revision` in their body, so both agree.
    pub fn etag_at(&self, revision: Revision, resource: Resource, library_revision: Option<u64>) -> String {
        let revision = revision.number;
        let resource = match resource {
            Resource::Tags => "tags",
            Resource::Discovery => "discovery",
            Resource::Playlists => "playlists",
        };
        match library_revision {
            Some(library) => format!("\"{resource}.{:x}.{revision}.{library}\"", self.boot),
            None => format!("\"{resource}.{:x}.{revision}\"", self.boot),
        }
    }
}

/// Answers 304 when the client already has `etag`; otherwise builds and sends the body.
pub async fn versioned<T, E>(
    headers: &HeaderMap,
    etag: String,
    build: impl Future<Output = Result<T, E>>,
) -> Result<Response, E>
where
    T: Serialize,
{
    let mut response = if if_none_match(headers, &etag) {
        StatusCode::NOT_MODIFIED.into_response()
    } else {
        Json(build.await?).into_response()
    };
    let headers = response.headers_mut();
    // Store, but revalidate on every use, so the browser sends If-None-Match for us.
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    if let Ok(value) = HeaderValue::from_str(&etag) {
        headers.insert(header::ETAG, value);
    }
    Ok(response)
}

fn if_none_match(headers: &HeaderMap, etag: &str) -> bool {
    let Some(value) = headers.get(header::IF_NONE_MATCH).and_then(|v| v.to_str().ok()) else {
        return false;
    };
    let ours = etag.trim_matches('"');
    value.split(',').any(|candidate| {
        let candidate = candidate.trim().trim_start_matches("W/").trim_matches('"');
        // A compressing proxy (Caddy's `encode`) may suffix the ETag it forwards.
        candidate == ours
            || ["-zstd", "-gzip", "-br"]
                .iter()
                .any(|suffix| candidate.strip_suffix(suffix) == Some(ours))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn with_inm(value: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(header::IF_NONE_MATCH, HeaderValue::from_str(value).unwrap());
        headers
    }

    #[test]
    fn bump_changes_etag_and_notifies() {
        let feed = ChangeFeed::default();
        let mut rx = feed.subscribe();
        let tags = feed.etag(Resource::Tags, Some(3));
        let playlists = feed.etag(Resource::Playlists, None);
        feed.bump(Resource::Tags);
        assert_ne!(tags, feed.etag(Resource::Tags, Some(3)));
        assert_eq!(playlists, feed.etag(Resource::Playlists, None));
        assert_eq!(rx.try_recv().unwrap().resource, Resource::Tags);
    }

    #[test]
    fn patches_carry_their_revision_and_items() {
        let feed = ChangeFeed::default();
        let mut rx = feed.subscribe();
        let first = feed.advance(Resource::Tags);
        let second = feed.advance(Resource::Tags);
        assert!(second.number > first.number);
        assert_eq!(feed.revision(Resource::Tags), second);
        feed.patch(Resource::Tags, second, serde_json::json!({ "a": null }));
        let message = serde_json::to_value(rx.try_recv().unwrap()).unwrap();
        assert_eq!(message["type"], "changed");
        assert_eq!(message["revision"]["number"], second.number);
        assert_eq!(message["items"], serde_json::json!({ "a": null }));
    }

    #[test]
    fn library_revision_is_part_of_etag() {
        let feed = ChangeFeed::default();
        assert_ne!(feed.etag(Resource::Tags, Some(1)), feed.etag(Resource::Tags, Some(2)));
    }

    #[test]
    fn if_none_match_accepts_weak_and_proxy_suffixed_tags() {
        let etag = "\"tags.abc.1.2\"";
        assert!(if_none_match(&with_inm(etag), etag));
        assert!(if_none_match(&with_inm("W/\"tags.abc.1.2\""), etag));
        assert!(if_none_match(&with_inm("\"tags.abc.1.2-zstd\""), etag));
        assert!(if_none_match(&with_inm("\"x\", \"tags.abc.1.2\""), etag));
        assert!(!if_none_match(&with_inm("\"tags.abc.1.3\""), etag));
        assert!(!if_none_match(&with_inm("\"tags.abc.1.2-other\""), etag));
        assert!(!if_none_match(&HeaderMap::new(), etag));
    }

    #[tokio::test]
    async fn versioned_skips_building_when_unchanged() {
        let etag = "\"playlists.abc.7\"".to_string();
        let response = versioned(&with_inm(&etag), etag.clone(), async {
            panic!("should not build an unchanged response");
            #[allow(unreachable_code)]
            Ok::<_, ()>(())
        })
        .await
        .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_MODIFIED);
        assert_eq!(response.headers()[header::ETAG], etag.as_str());

        let response = versioned(&HeaderMap::new(), etag.clone(), async { Ok::<_, ()>(vec![1]) })
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-cache");
    }
}
