//! Read-only MusicBrainz evidence, shared by every tagging job through SQLite.
use anyhow::{anyhow, bail, Context, Result};
use r2d2_sqlite::SqliteConnectionManager;
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

type Pool = r2d2::Pool<SqliteConnectionManager>;
const API: &str = "https://musicbrainz.org/ws/2";
const USER_AGENT: &str = "ReiTunes/0.1 (https://github.com/rgwood/reitunes)";
const MAX_REQUESTS: usize = 15;

fn now() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64()
}

fn normalize(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

fn quoted(value: &str) -> String {
    let mut result = String::from("\"");
    for ch in normalize(value).chars() {
        if "+-!(){}[]^\"~*?:\\/|&".contains(ch) {
            result.push('\\');
        }
        result.push(ch);
    }
    result.push('"');
    result
}

fn list<'a>(value: &'a Value, key: &str) -> &'a [Value] {
    value[key].as_array().map(Vec::as_slice).unwrap_or_default()
}

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap_or_default()
}

fn score(value: &Value) -> u64 {
    value["score"]
        .as_u64()
        .or_else(|| value["score"].as_str()?.parse().ok())
        .unwrap_or(0)
}

fn artist_names(recording: &Value) -> Vec<&str> {
    list(recording, "artist-credit")
        .iter()
        .filter_map(|credit| {
            credit["artist"]["name"]
                .as_str()
                .or_else(|| credit["name"].as_str())
        })
        .collect()
}

fn select_recording<'a>(
    candidates: &'a [Value],
    title: &str,
    artist: &str,
    album: &str,
) -> Option<&'a Value> {
    let exact: Vec<_> = candidates
        .iter()
        .filter(|candidate| {
            normalize(text(candidate, "title")) == normalize(title)
                && artist_names(candidate)
                    .iter()
                    .any(|name| normalize(name) == normalize(artist))
                && score(candidate) >= 95
        })
        .collect();
    if exact.len() == 1 {
        return exact.first().copied();
    }
    if !album.is_empty() {
        let matches: Vec<_> = exact
            .into_iter()
            .filter(|candidate| {
                list(candidate, "releases")
                    .iter()
                    .any(|release| normalize(text(release, "title")) == normalize(album))
            })
            .collect();
        if matches.len() == 1 {
            return matches.first().copied();
        }
    }
    None
}

fn source(kind: &str, id: &str) -> Result<String> {
    uuid::Uuid::parse_str(id).context("Invalid MusicBrainz entity ID")?;
    Ok(format!("https://musicbrainz.org/{kind}/{id}"))
}

fn tags(data: &Value) -> Vec<&str> {
    let mut tags: Vec<_> = list(data, "tags").iter().collect();
    tags.sort_by_key(|tag| std::cmp::Reverse(tag["count"].as_i64().unwrap_or(0)));
    tags.into_iter()
        .filter_map(|tag| tag["name"].as_str())
        .take(8)
        .collect()
}

fn retry_after(value: &str, current_time: f64) -> f64 {
    value
        .parse::<f64>()
        .ok()
        .filter(|seconds| seconds.is_finite() && *seconds >= 0.0)
        .or_else(|| {
            jiff::civil::DateTime::strptime("%a, %d %b %Y %H:%M:%S GMT", value)
                .ok()?
                .to_zoned(jiff::tz::TimeZone::UTC)
                .ok()
                .map(|date| (date.timestamp().as_second() as f64 - current_time).max(0.0))
        })
        .unwrap_or(0.0)
}

struct Cache<'a> {
    pool: &'a Pool,
    client: &'a reqwest::Client,
    requests: usize,
    hits: usize,
    deferred: bool,
}

impl<'a> Cache<'a> {
    fn new(pool: &'a Pool, client: &'a reqwest::Client) -> Result<Self> {
        pool.get()?.execute_batch(
            "CREATE TABLE IF NOT EXISTS TaggingMusicBrainzCache (
                Key TEXT PRIMARY KEY, FetchedAt REAL NOT NULL, Payload TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS TaggingMusicBrainzRateLimit (
                Id INTEGER PRIMARY KEY CHECK(Id = 1), NextRequest REAL NOT NULL
             );",
        )?;
        Ok(Self {
            pool,
            client,
            requests: 0,
            hits: 0,
            deferred: false,
        })
    }

    fn cooldown(&self, seconds: f64) -> Result<()> {
        self.pool.get()?.execute(
            "INSERT INTO TaggingMusicBrainzRateLimit VALUES (1, ?1)
             ON CONFLICT(Id) DO UPDATE SET NextRequest = MAX(NextRequest, excluded.NextRequest)",
            [now() + seconds],
        )?;
        Ok(())
    }

    // Reserve request starts atomically so another worker/process also observes the spacing.
    async fn reserve(&mut self) -> Result<()> {
        if self.deferred || self.requests >= MAX_REQUESTS {
            self.deferred = true;
            bail!("MusicBrainz lookup deferred; cached evidence remains available");
        }
        loop {
            let delay = {
                let mut connection = self.pool.get()?;
                let transaction = connection
                    .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
                let due: f64 = transaction
                    .query_row(
                        "SELECT NextRequest FROM TaggingMusicBrainzRateLimit WHERE Id = 1",
                        [],
                        |row| row.get(0),
                    )
                    .optional()?
                    .unwrap_or(0.0);
                let current = now();
                if due <= current {
                    transaction.execute(
                        "INSERT OR REPLACE INTO TaggingMusicBrainzRateLimit VALUES (1, ?1)",
                        [current + 3.0],
                    )?;
                    transaction.commit()?;
                    0.0
                } else {
                    transaction.commit()?;
                    due - current
                }
            };
            if delay == 0.0 {
                break;
            }
            if delay > 60.0 {
                self.deferred = true;
                bail!("MusicBrainz lookup deferred until its persisted cooldown expires");
            }
            tokio::time::sleep(Duration::from_secs_f64(delay)).await;
        }
        self.requests += 1;
        Ok(())
    }

    async fn get(
        &mut self,
        kind: &str,
        entity_id: Option<&str>,
        query: Option<&str>,
    ) -> Result<Value> {
        let key = match entity_id {
            Some(id) => {
                source(kind, id)?;
                format!("entity:{kind}:{id}")
            }
            None => format!("search:{kind}:{}", query.unwrap_or_default()),
        };
        let cached: Option<String> = self
            .pool
            .get()?
            .query_row(
                "SELECT Payload FROM TaggingMusicBrainzCache WHERE Key = ?1",
                [&key],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(payload) = cached {
            self.hits += 1;
            return Ok(serde_json::from_str(&payload)?);
        }
        let url = entity_id
            .map(|id| format!("{API}/{kind}/{id}"))
            .unwrap_or_else(|| format!("{API}/{kind}"));
        let mut parameters = vec![("fmt", "json")];
        if entity_id.is_some() {
            parameters.push((
                "inc",
                match kind {
                    "artist" => "aliases+tags",
                    "recording" => "artist-credits+releases+tags+artist-rels+work-rels",
                    "release" => "artist-credits+release-groups+labels",
                    _ => bail!("Unsupported MusicBrainz entity type"),
                },
            ));
        } else {
            parameters.extend([("query", query.unwrap_or_default()), ("limit", "5")]);
        }
        for attempt in 0..3 {
            self.reserve().await?;
            let mut response = self
                .client
                .get(&url)
                .query(&parameters)
                .header(reqwest::header::USER_AGENT, USER_AGENT)
                .timeout(Duration::from_secs(25))
                .send()
                .await?;
            let status = response.status();
            if status.as_u16() == 429 || status.as_u16() == 503 {
                let delay = retry_after(
                    response
                        .headers()
                        .get(reqwest::header::RETRY_AFTER)
                        .and_then(|header| header.to_str().ok())
                        .unwrap_or_default(),
                    now(),
                )
                .max(10.0 * 2.0_f64.powi(attempt));
                self.deferred = attempt == 2 || delay > 60.0;
                self.cooldown(if self.deferred {
                    delay.max(60.0)
                } else {
                    delay
                })?;
                tracing::warn!(%status, attempt = attempt + 1, delay, deferred = self.deferred, "MusicBrainz temporarily unavailable");
                if self.deferred {
                    bail!("MusicBrainz HTTP {status}; remaining uncached lookups deferred");
                }
                continue;
            }
            response.error_for_status_ref()?;
            let mut body = Vec::new();
            while let Some(chunk) = response.chunk().await? {
                if body.len() + chunk.len() > 2 * 1024 * 1024 {
                    bail!("MusicBrainz response exceeded size limit");
                }
                body.extend_from_slice(&chunk);
            }
            let data: Value = serde_json::from_slice(&body)?;
            if !data.is_object() || data.get("error").is_some() {
                bail!("MusicBrainz returned an invalid response");
            }
            if let Some(id) = entity_id {
                if text(&data, "id") != id {
                    bail!("MusicBrainz response entity ID did not match request");
                }
            } else if !data[format!("{kind}s")].is_array() {
                bail!("MusicBrainz search response had no results array");
            }
            self.pool.get()?.execute(
                "INSERT OR REPLACE INTO TaggingMusicBrainzCache VALUES (?1, ?2, ?3)",
                params![key, now(), serde_json::to_string(&data)?],
            )?;
            return Ok(data);
        }
        Err(anyhow!("MusicBrainz retry limit reached"))
    }
}

fn note_error(result: &mut Value, cache: &Cache<'_>, error: anyhow::Error) {
    let reason = if cache.deferred {
        "lookup-deferred"
    } else {
        "lookup-error"
    };
    let reasons = result["research_reasons"].as_array_mut().unwrap();
    if !reasons.contains(&json!(reason)) {
        reasons.push(json!(reason));
    }
    result["errors"]
        .as_array_mut()
        .unwrap()
        .push(json!({"kind": reason, "message": error.to_string()}));
}

/// Cached structured evidence; a metadata match is never proof of the local recording's version.
pub async fn collect(
    pool: &Pool,
    client: &reqwest::Client,
    name: &str,
    artist: &str,
    album: &str,
) -> Result<Value> {
    let mut cache = Cache::new(pool, client)?;
    let mut result = json!({"source": "MusicBrainz", "recording_status": "unresolved", "sources": [],
        "research_reasons": [], "errors": [], "identity_caveat":
        "Metadata matches are candidates, not fingerprint-verified local recordings. Do not infer the local recording's live/remix/version status from a candidate alone. Artist tags describe the artist, not necessarily this track. Missing vocal credits do not establish instrumental status."});
    let title = normalize(name);
    let is_mix = [
        "dj set",
        "guest mix",
        "essential mix",
        "vinyl set",
        "house mix",
    ]
    .iter()
    .any(|phrase| title.contains(phrase));
    let mut artist_id = None;
    if is_mix {
        result["recording_status"] = json!("dj-mix-not-resolved");
        result["research_reasons"]
            .as_array_mut()
            .unwrap()
            .push(json!("dj-mix-tracklist"));
    } else if !artist.trim().is_empty()
        && !name.trim().is_empty()
        && name.chars().count() < 140
        && !name.chars().any(char::is_control)
    {
        let query = format!("recording:{} AND artist:{}", quoted(name), quoted(artist));
        match cache.get("recording", None, Some(&query)).await {
            Ok(search) => {
                let candidates = list(&search, "recordings");
                if let Some(candidate) = select_recording(candidates, name, artist, album) {
                    match cache
                        .get("recording", Some(text(candidate, "id")), None)
                        .await
                    {
                        Ok(recording) => {
                            let url = source("recording", text(&recording, "id"))?;
                            result["recording_status"] = json!("exact-metadata-candidate");
                            let relationships: Vec<_> = list(&recording, "relations").iter().take(12).map(|relation| json!({
                                "type": relation["type"], "attributes": relation["attributes"],
                                "name": relation["artist"]["name"].as_str().or_else(|| relation["work"]["title"].as_str())
                            })).collect();
                            result["recording"] = json!({"mbid": recording["id"], "title": recording["title"], "disambiguation": recording["disambiguation"],
                                "length_ms": recording["length"], "first_release_date": recording["first-release-date"],
                                "artist_credits": artist_names(&recording), "community_tags": tags(&recording),
                                "relationships": relationships, "source_url": url});
                            result["sources"].as_array_mut().unwrap().push(json!(url));
                            let credits: Vec<_> = list(&recording, "artist-credit")
                                .iter()
                                .filter(|credit| {
                                    normalize(text(&credit["artist"], "name")) == normalize(artist)
                                })
                                .collect();
                            if credits.len() == 1 {
                                artist_id = credits[0]["artist"]["id"].as_str().map(str::to_owned);
                            }
                            let releases: Vec<_> = list(&recording, "releases")
                                .iter()
                                .filter(|release| {
                                    !album.is_empty()
                                        && normalize(text(release, "title")) == normalize(album)
                                })
                                .collect();
                            if releases.len() == 1 {
                                match cache
                                    .get("release", Some(text(releases[0], "id")), None)
                                    .await
                                {
                                    Ok(release) => {
                                        let url = source("release", text(&release, "id"))?;
                                        let group = &release["release-group"];
                                        result["release_candidate"] = json!({"mbid": release["id"], "title": release["title"], "date": release["date"],
                                            "release_group": {"id": group["id"], "title": group["title"], "primary-type": group["primary-type"],
                                                "secondary-types": group["secondary-types"], "first-release-date": group["first-release-date"]}, "source_url": url});
                                        result["sources"].as_array_mut().unwrap().push(json!(url));
                                    }
                                    Err(error) => note_error(&mut result, &cache, error),
                                }
                            } else if !releases.is_empty() {
                                result["release_status"] = json!("multiple-editions-unresolved");
                            }
                        }
                        Err(error) => {
                            result["recording_status"] = json!(if cache.deferred {
                                "deferred"
                            } else {
                                "lookup-error"
                            });
                            note_error(&mut result, &cache, error);
                        }
                    }
                } else {
                    result["research_reasons"]
                        .as_array_mut()
                        .unwrap()
                        .push(json!(if candidates.is_empty() {
                            "unknown-recording"
                        } else {
                            "ambiguous-recording"
                        }));
                }
            }
            Err(error) => {
                result["recording_status"] = json!(if cache.deferred {
                    "deferred"
                } else {
                    "lookup-error"
                });
                note_error(&mut result, &cache, error);
            }
        }
    } else {
        result["research_reasons"]
            .as_array_mut()
            .unwrap()
            .push(json!("insufficient-metadata"));
    }

    // Artist lookups are independent: a failed/ambiguous recording can still have useful cached artist evidence.
    if !artist.trim().is_empty() && artist_id.is_none() {
        let query = format!("artist:{}", quoted(artist));
        match cache.get("artist", None, Some(&query)).await {
            Ok(search) => {
                let exact: Vec<_> = list(&search, "artists")
                    .iter()
                    .filter(|candidate| {
                        normalize(text(candidate, "name")) == normalize(artist)
                            && score(candidate) >= 95
                    })
                    .collect();
                if exact.len() == 1 {
                    artist_id = exact[0]["id"].as_str().map(str::to_owned);
                } else {
                    result["artist_status"] = json!("ambiguous-or-unknown");
                }
            }
            Err(error) => note_error(&mut result, &cache, error),
        }
    }
    if let Some(id) = artist_id {
        match cache.get("artist", Some(&id), None).await {
            Ok(data) => {
                let url = source("artist", &id)?;
                result["artist"] = json!({"mbid": id, "name": data["name"], "disambiguation": data["disambiguation"],
                    "type": data["type"], "aliases": list(&data, "aliases").iter().filter_map(|alias| alias["name"].as_str()).take(8).collect::<Vec<_>>(),
                    "community_tags": tags(&data), "source_url": url});
                result["artist_status"] = json!("name-matched-candidate");
                result["sources"].as_array_mut().unwrap().push(json!(url));
            }
            Err(error) => note_error(&mut result, &cache, error),
        }
    }
    if !list(&result["recording"], "relationships")
        .iter()
        .any(|relation| text(relation, "type") == "vocal")
    {
        result["research_reasons"]
            .as_array_mut()
            .unwrap()
            .push(json!("vocal-status-unconfirmed"));
    }
    result["statistics"] = json!({"network_requests": cache.requests, "cache_hits": cache.hits, "paid_search_requests": 0});
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_ambiguous_recordings_and_uses_album_only_when_unique() {
        let candidates = vec![
            json!({"title": "Song", "score": 100, "artist-credit": [{"artist": {"name": "Artist"}}], "releases": [{"title": "Album"}]}),
            json!({"title": "Song", "score": "100", "artist-credit": [{"artist": {"name": "Artist"}}], "releases": [{"title": "Live"}]}),
        ];
        assert!(select_recording(&candidates, "Song", "Artist", "").is_none());
        assert_eq!(
            select_recording(&candidates, " song ", "ARTIST", "Album"),
            Some(&candidates[0])
        );
        assert!(select_recording(&candidates, "Song (Live)", "Artist", "Album").is_none());
        assert!(select_recording(&candidates, "Song", "Other artist", "Album").is_none());
    }

    #[test]
    fn query_metadata_cannot_inject_lucene_operators() {
        assert_eq!(quoted(" A/B: C+ \"D\" "), "\"a\\/b\\: c\\+ \\\"d\\\"\"");
    }

    #[test]
    fn respects_both_retry_after_formats() {
        assert_eq!(retry_after("120", 0.0), 120.0);
        assert_eq!(
            retry_after("Wed, 21 Oct 2015 07:28:00 GMT", 1445412420.0),
            60.0
        );
        assert_eq!(retry_after("invalid", 0.0), 0.0);
        assert_eq!(retry_after("NaN", 0.0), 0.0);
    }

    #[tokio::test]
    async fn persisted_cache_is_available_during_cooldown_and_keeps_partial_evidence() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("cache.sqlite");
        let artist_id = "01234567-89ab-cdef-0123-456789abcdef";
        let client = reqwest::Client::new();
        {
            let pool = Pool::new(SqliteConnectionManager::file(&path)).unwrap();
            let cache = Cache::new(&pool, &client).unwrap();
            for (key, value) in [
                (
                    "search:artist:artist:\"artist\"".to_owned(),
                    json!({"artists": [{"id": artist_id, "name": "Artist", "score": 100}]}),
                ),
                (
                    format!("entity:artist:{artist_id}"),
                    json!({"id": artist_id, "name": "Artist", "tags": [{"name": "jazz", "count": 4}]}),
                ),
            ] {
                pool.get()
                    .unwrap()
                    .execute(
                        "INSERT INTO TaggingMusicBrainzCache VALUES (?1, ?2, ?3)",
                        params![key, now(), value.to_string()],
                    )
                    .unwrap();
            }
            cache.cooldown(3600.0).unwrap();
        }
        let pool = Pool::new(SqliteConnectionManager::file(&path)).unwrap();
        let result = collect(&pool, &client, "Unknown song", "Artist", "")
            .await
            .unwrap();
        assert_eq!(result["recording_status"], "deferred");
        assert_eq!(result["artist"]["community_tags"][0], "jazz");
        assert_eq!(result["statistics"]["network_requests"], 0);
        assert_eq!(result["statistics"]["cache_hits"], 2);
        assert!(list(&result, "research_reasons").contains(&json!("vocal-status-unconfirmed")));
        let count: i64 = pool
            .get()
            .unwrap()
            .query_row("SELECT count(*) FROM TaggingMusicBrainzCache", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(
            count, 2,
            "deferred lookup must not be cached as an empty result"
        );
    }
}
