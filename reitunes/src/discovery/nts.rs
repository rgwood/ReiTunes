//! NTS archive metadata comes from the same unauthenticated API as its website.
//! This API is undocumented, so keep parsing defensive and failures recoverable.
//! We only offer imports for public SoundCloud recordings advertised by NTS.
use super::{identifier, now, Entry, Listing, Source, PAGE_SIZE};
use anyhow::{bail, Context, Result};
use reqwest::{Client, Url};
use serde::Serialize;
use serde_json::Value;
use std::{sync::LazyLock, time::Duration};

const API: &str = "https://www.nts.live/api/v2";
// NTS silently turns larger requested page sizes into 12, rather than 50.
const NTS_PAGE_SIZE: usize = 12;
const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
static CLIENT: LazyLock<Client> = LazyLock::new(|| {
    Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("NTS metadata HTTP client")
});

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct EpisodeDetails {
    pub description: String,
    pub genres: Vec<String>,
    pub tracks: Vec<Track>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Track {
    pub artist: String,
    pub title: String,
}

fn valid_slug(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 200
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
}

fn nts_path(input: &str) -> Result<Vec<String>> {
    let url = Url::parse(input.trim()).context("Enter a complete NTS show URL.")?;
    if !matches!(url.scheme(), "http" | "https")
        || !matches!(url.host_str(), Some("nts.live" | "www.nts.live"))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
    {
        bail!("Use a public NTS show URL, such as https://www.nts.live/shows/yu-su.");
    }
    let parts: Vec<_> = url.path().trim_matches('/').split('/').collect();
    if !matches!(parts.as_slice(), ["shows", show] if valid_slug(show))
        && !matches!(parts.as_slice(), ["shows", show, "episodes", episode] if valid_slug(show) && valid_slug(episode))
    {
        bail!("Follow an NTS show page, such as https://www.nts.live/shows/yu-su.");
    }
    Ok(parts.into_iter().map(str::to_owned).collect())
}

pub(super) fn canonical_show_url(input: &str) -> Result<String> {
    let parts = nts_path(input)?;
    // Pasting an episode follows its show, which is usually what you intended.
    Ok(format!("https://www.nts.live/shows/{}", parts[1]))
}

pub(super) fn canonical_episode_url(input: &str) -> Result<String> {
    let parts = nts_path(input)?;
    if parts.len() != 4 {
        bail!("This NTS URL is not an archived episode.");
    }
    Ok(format!("https://www.nts.live/{}", parts.join("/")))
}

fn soundcloud_url(input: &str) -> Option<String> {
    let mut url = Url::parse(input).ok()?;
    let parts: Vec<_> = url.path().trim_matches('/').split('/').collect();
    if !matches!(url.scheme(), "http" | "https")
        || !matches!(
            url.host_str(),
            Some("soundcloud.com" | "www.soundcloud.com")
        )
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || !matches!(parts.as_slice(), [user, track] if valid_slug(user) && valid_slug(track) && *track != "tracks" && *track != "sets")
    {
        return None;
    }
    url.set_scheme("https").ok()?;
    url.set_host(Some("soundcloud.com")).ok()?;
    url.set_query(None);
    url.set_fragment(None);
    Some(url.to_string().trim_end_matches('/').to_owned())
}

fn text(value: &Value, field: &str, limit: usize) -> String {
    value[field]
        .as_str()
        .unwrap_or_default()
        .trim()
        .chars()
        .take(limit)
        .collect()
}

fn genres(value: &Value) -> Vec<String> {
    value["genres"]
        .as_array()
        .into_iter()
        .flatten()
        .take(12)
        .map(|genre| text(genre, "value", 80))
        .filter(|genre| !genre.is_empty())
        .collect()
}

fn parse_episode(value: &Value, show: &str, show_title: &str) -> Option<Entry> {
    let episode = value["episode_alias"].as_str()?;
    if !valid_slug(episode)
        || value["show_alias"].as_str() != Some(show)
        || value["status"].as_str() != Some("published")
    {
        return None;
    }
    let title = text(value, "name", 300);
    if title.is_empty() {
        return None;
    }
    let url = format!("https://www.nts.live/shows/{show}/episodes/{episode}");
    let download_url = value["audio_sources"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|audio| audio["source"].as_str() == Some("soundcloud"))
        .filter_map(|audio| soundcloud_url(audio["url"].as_str()?))
        .next();
    let published = value["broadcast"].as_str().and_then(|date| {
        let date = date.get(..10)?;
        let bytes = date.as_bytes();
        (bytes[4] == b'-'
            && bytes[7] == b'-'
            && bytes
                .iter()
                .enumerate()
                .all(|(i, c)| matches!(i, 4 | 7) || c.is_ascii_digit()))
        .then(|| date.replace('-', ""))
    });
    Some(Entry {
        id: identifier(&url),
        media_id: episode.to_owned(),
        url,
        title,
        uploader: show_title.to_owned(),
        // NTS does not supply a duration. The parent enriches this through the
        // worker when a duration filter is set; inventing an hour would hide sets.
        duration: None,
        published,
        sources: vec![],
        inbox: false,
        status: "new".into(),
        discovered_at: now(),
        library_item_id: None,
        download_job_id: None,
        error: None,
        saved: false,
        description: text(value, "description", 2000),
        genres: genres(value),
        can_import: download_url.is_some(),
        download_url,
    })
}

async fn fetch(path: &str) -> Result<Value> {
    // Only callers that construct paths from validated slugs reach this helper.
    // Never follow API-provided links or redirects to other hosts.
    let mut response = CLIENT
        .get(format!("{API}{path}"))
        .send()
        .await
        .context("Could not reach NTS. Try refreshing this source later.")?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        bail!("NTS could not find this show or episode. Check its NTS page.");
    }
    if !response.status().is_success() {
        bail!(
            "NTS is temporarily unavailable ({}). Try again later.",
            response.status()
        );
    }
    if response
        .content_length()
        .is_some_and(|size| size > MAX_RESPONSE_BYTES as u64)
    {
        bail!("NTS returned more metadata than expected.");
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .context("NTS metadata stopped loading. Try again later.")?
    {
        if body.len() + chunk.len() > MAX_RESPONSE_BYTES {
            bail!("NTS returned more metadata than expected.");
        }
        body.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&body).context("NTS returned unexpected metadata. Try again later.")
}

pub(super) async fn list(source: &Source, start: usize) -> Result<Listing> {
    tokio::time::timeout(Duration::from_secs(60), async {
        let url = canonical_show_url(&source.url)?;
        let show = url.rsplit('/').next().context("Missing NTS show")?;
        if start == 0 || start > 100_000 {
            bail!("NTS archive offset is out of range.");
        }
        let show_data = fetch(&format!("/shows/{show}")).await?;
        let title = text(&show_data, "name", 300);
        if title.is_empty() {
            bail!("NTS returned an unnamed show. Try again later.");
        }
        let mut entries = Vec::new();
        let mut count = 0;
        while count < PAGE_SIZE {
            let requested = NTS_PAGE_SIZE.min(PAGE_SIZE - count);
            let offset = start - 1 + count;
            let page = fetch(&format!(
                "/shows/{show}/episodes?limit={requested}&offset={offset}"
            ))
            .await?;
            let values = page["results"]
                .as_array()
                .context("NTS did not return an episode list.")?;
            // Do not silently skip an entire page if NTS changes pagination.
            if values.len() > requested {
                bail!("NTS returned unexpected archive pagination. Try again later.");
            }
            for value in values {
                if let Some(entry) = parse_episode(value, show, &title) {
                    if !entries
                        .iter()
                        .any(|previous: &Entry| previous.id == entry.id)
                    {
                        entries.push(entry);
                    }
                }
            }
            count += values.len();
            if values.len() < requested {
                break;
            }
        }
        Ok(Listing {
            title,
            entries,
            count,
        })
    })
    .await
    .context("Reading NTS took too long. Try again later.")?
}

fn parse_details(value: &Value) -> EpisodeDetails {
    let tracks = value["embeds"]["tracklist"]["results"]
        .as_array()
        .into_iter()
        .flatten()
        .take(250)
        .map(|track| Track {
            artist: text(track, "artist", 200),
            title: text(track, "title", 300),
        })
        .filter(|track| !track.artist.is_empty() || !track.title.is_empty())
        .collect();
    EpisodeDetails {
        description: text(value, "description", 2000),
        genres: genres(value),
        tracks,
    }
}

pub(super) async fn details(episode_url: &str) -> Result<EpisodeDetails> {
    let url = canonical_episode_url(episode_url)?;
    let path = url
        .strip_prefix("https://www.nts.live")
        .context("Invalid NTS episode")?;
    let value = fetch(path).await?;
    Ok(parse_details(&value))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn episode() -> Value {
        json!({
            "status": "published", "name": "Guest selects", "show_alias": "a-show",
            "episode_alias": "a-show-1st-july-2026", "broadcast": "2026-07-01T12:00:00+00:00",
            "description": "A trip through house and jazz.",
            "genres": [{"value":"Deep House"},{"value":"Jazz"}],
            "audio_sources":[{"source":"soundcloud","url":"https://soundcloud.com/host/recording?utm_source=nts"}]
        })
    }

    #[test]
    fn canonicalizes_shows_and_episode_pastes() {
        for input in [
            "http://nts.live/shows/a-show/?utm_source=test#tracklist",
            "https://www.nts.live/shows/a-show/episodes/an-episode",
        ] {
            assert_eq!(
                canonical_show_url(input).unwrap(),
                "https://www.nts.live/shows/a-show"
            );
        }
        assert_eq!(
            canonical_episode_url("https://nts.live/shows/a-show/episodes/one?ref=share").unwrap(),
            "https://www.nts.live/shows/a-show/episodes/one"
        );
        assert!(canonical_episode_url("https://nts.live/shows/a-show").is_err());
    }

    #[test]
    fn rejects_foreign_hosts_credentials_ports_and_non_archive_paths() {
        for url in [
            "file:///shows/a-show",
            "https://localhost/shows/a-show",
            "https://nts.live.evil.test/shows/a-show",
            "https://user@nts.live/shows/a-show",
            "https://nts.live:8000/shows/a-show",
            "https://nts.live/api/v2/shows/a-show",
            "https://nts.live/shows/a%2fshow",
            "https://nts.live/shows/a-show/episodes/x/more",
        ] {
            assert!(canonical_show_url(url).is_err(), "{url}");
        }
    }

    #[test]
    fn preserves_nts_identity_and_original_recording_for_imports() {
        let entry = parse_episode(&episode(), "a-show", "A show").unwrap();
        assert_eq!(
            entry.url,
            "https://www.nts.live/shows/a-show/episodes/a-show-1st-july-2026"
        );
        assert_eq!(
            entry.download_url.as_deref(),
            Some("https://soundcloud.com/host/recording")
        );
        assert_eq!(entry.id, identifier(&entry.url));
        assert_eq!(entry.published.as_deref(), Some("20260701"));
        assert_eq!(entry.genres, ["Deep House", "Jazz"]);
        assert!(entry.can_import);
        assert_eq!(entry.duration, None);
    }

    #[test]
    fn unavailable_recordings_stay_browsable_without_an_import_button() {
        for audio_url in [
            "https://mixcloud.com/NTSRadio/episode",
            "https://127.0.0.1/audio",
            "https://soundcloud.com.evil.test/host/track",
            "https://user@soundcloud.com/host/track",
            "https://soundcloud.com/host/sets/playlist",
            "https://soundcloud.com/host/tracks",
        ] {
            let mut value = episode();
            value["audio_sources"] = json!([{"source":"soundcloud", "url":audio_url}]);
            let entry = parse_episode(&value, "a-show", "A show").unwrap();
            assert!(!entry.can_import, "{audio_url}");
            assert!(entry.download_url.is_none());
        }
        let mut value = episode();
        value["audio_sources"] = json!([]);
        assert!(
            !parse_episode(&value, "a-show", "A show")
                .unwrap()
                .can_import
        );
    }

    #[test]
    fn rejects_unpublished_and_malformed_episodes() {
        for (field, value) in [
            ("status", "draft"),
            ("show_alias", "another-show"),
            ("episode_alias", "../private"),
            ("name", ""),
        ] {
            let mut data = episode();
            data[field] = json!(value);
            assert!(parse_episode(&data, "a-show", "A show").is_none());
        }
    }

    #[test]
    fn exposes_public_tracklists_without_relying_on_subscriber_timestamps() {
        let mut value = episode();
        value["embeds"] = json!({"tracklist":{"results":[
            {"artist":" Artist ","title":" Track ","offset":null,"duration_estimate":null},
            {"artist":"Unknown artist","title":"Unreleased"},
            {"artist":"","title":""}
        ]}});
        let details = parse_details(&value);
        assert_eq!(details.tracks.len(), 2);
        assert_eq!(details.tracks[0].artist, "Artist");
        assert_eq!(details.tracks[0].title, "Track");
        assert!(!serde_json::to_string(&details).unwrap().contains("offset"));
        assert!(parse_details(&episode()).tracks.is_empty());
    }

    #[tokio::test]
    #[ignore = "Reads public NTS metadata over the network; never downloads audio"]
    async fn real_archive_paginates_past_nts_twelve_episode_limit() {
        let source = Source {
            id: "nts-smoke-test".into(),
            url: "https://www.nts.live/shows/yu-su".into(),
            title: "Yu Su".into(),
            provider: "NTS".into(),
            min_minutes: 0,
            last_checked: None,
            last_attempt: None,
            error: None,
            archive_offset: 0,
            archive_finished: false,
        };
        let first = list(&source, 1).await.unwrap();
        assert_eq!(first.count, PAGE_SIZE);
        assert_eq!(first.entries.len(), PAGE_SIZE);
        assert_eq!(first.title, "Yu Su");
        assert!(first.entries.iter().any(|entry| entry.can_import));
        let second = list(&source, PAGE_SIZE + 1).await.unwrap();
        assert!(second.count > 0);
        assert!(second
            .entries
            .iter()
            .all(|entry| !first.entries.iter().any(|previous| previous.id == entry.id)));
        let episode = details(&first.entries[0].url).await.unwrap();
        assert!(!episode.tracks.is_empty());
    }
}
