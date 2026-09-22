use serde::Deserialize;

#[derive(Debug, PartialEq, Eq)]
pub struct SourceMetadata {
    pub name: String,
    pub artist: Option<String>,
    pub album: Option<String>,
}

const MEDIA_EXTENSIONS: &[&str] = &[
    "mp3", "mp4", "m4a", "m4b", "aac", "flac", "wav", "wave", "ogg", "oga", "opus", "wma", "aif",
    "aiff", "alac", "mka", "webm",
];

fn filename_stem(filename: &str) -> &str {
    let basename = filename
        .trim()
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or_default()
        .trim();
    basename
        .rsplit_once('.')
        .filter(|(_, extension)| {
            MEDIA_EXTENSIONS
                .iter()
                .any(|known| extension.eq_ignore_ascii_case(known))
        })
        .map_or(basename, |(stem, _)| stem)
        .trim()
}

fn youtube_id(value: &str) -> bool {
    value.len() == 11
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_-".contains(&byte))
}

fn soundcloud_id(value: &str) -> bool {
    // Short bracketed numbers are often years or track numbers, not download IDs.
    (6..=20).contains(&value.len()) && value.bytes().all(|byte| byte.is_ascii_digit())
}

fn filename_media_id(filename: &str) -> Option<(&str, &str)> {
    let stem = filename_stem(filename);
    let (title, id) = stem.strip_suffix(']')?.rsplit_once('[')?;
    // yt-dlp separates its ID from the title with a space. Keep ordinary bracketed
    // title suffixes, and do not turn a file named only after its ID into no title.
    if title.trim().is_empty() || !title.ends_with(char::is_whitespace) {
        return None;
    }
    (youtube_id(id) || soundcloud_id(id)).then_some((title.trim_end(), id))
}

/// Keep imports readable even when metadata inference is unavailable.
pub fn clean_filename_title(filename: &str) -> String {
    let title =
        filename_media_id(filename).map_or_else(|| filename_stem(filename), |(title, _)| title);
    if title.is_empty() {
        "Untitled recording".into()
    } else {
        title.to_owned()
    }
}

#[derive(Deserialize)]
struct CachedDiscovery {
    entries: Vec<CachedEntry>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CachedEntry {
    #[serde(default)]
    title: String,
    #[serde(default)]
    url: String,
    #[serde(default)]
    download_url: Option<String>,
    #[serde(default)]
    media_id: String,
}

fn filename_matches_entry(entry: &CachedEntry, id: &str) -> bool {
    if entry.media_id != id {
        return false;
    }
    let Ok(url) = reqwest::Url::parse(&entry.url) else {
        return false;
    };
    match url.host_str() {
        Some(
            "youtube.com" | "www.youtube.com" | "m.youtube.com" | "music.youtube.com" | "youtu.be",
        ) => youtube_id(id),
        Some("soundcloud.com" | "www.soundcloud.com") => soundcloud_id(id),
        _ => false,
    }
}

fn unambiguous_title<'a>(entries: impl Iterator<Item = &'a CachedEntry>) -> Option<SourceMetadata> {
    let mut titles = entries
        .map(|entry| entry.title.trim())
        .filter(|title| !title.is_empty());
    let name = titles.next()?;
    if titles.any(|other| other != name) {
        return None;
    }
    Some(SourceMetadata {
        name: name.to_owned(),
        // A radio station or upload channel is not necessarily the performer.
        artist: None,
        album: None,
    })
}

/// Resolve the source's own title without network access or guessing an artist.
pub fn cached_source_metadata(
    serialized: &str,
    source_url: Option<&str>,
    filename: &str,
) -> Option<SourceMetadata> {
    let state: CachedDiscovery = serde_json::from_str(serialized).ok()?;
    if let Some(identity) = source_url.and_then(crate::discovery::item_identifier) {
        // Prefer the entry explicitly requested by the callback. NTS imports use
        // their underlying SoundCloud URL, so also recognize the download URL.
        if let Some(metadata) = unambiguous_title(state.entries.iter().filter(|entry| {
            crate::discovery::item_identifier(&entry.url).as_ref() == Some(&identity)
        })) {
            return Some(metadata);
        }
        if let Some(metadata) = unambiguous_title(state.entries.iter().filter(|entry| {
            entry
                .download_url
                .as_deref()
                .and_then(crate::discovery::item_identifier)
                .as_ref()
                == Some(&identity)
        })) {
            return Some(metadata);
        }
    }
    let (_, id) = filename_media_id(filename)?;
    unambiguous_title(
        state
            .entries
            .iter()
            .filter(|entry| filename_matches_entry(entry, id)),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn cleans_download_names_and_both_path_styles_without_guessing_artists() {
        for (input, expected) in [
            (
                "/downloads/Joie De Vivre - Tycho [6ONRf7h3Mdk].mp3",
                "Joie De Vivre - Tycho",
            ),
            (r"C:\Music\Björk – Jóga [1234567890].MP3", "Björk – Jóga"),
            ("  Blue Train.flac  ", "Blue Train"),
            ("One.mp3.mp3", "One.mp3"),
            (
                "01 - Pink Floyd - Another Brick in the Wall.wav",
                "01 - Pink Floyd - Another Brick in the Wall",
            ),
            ("Mix [6ONRf7h3Mdk].webm", "Mix"),
            ("/", "Untitled recording"),
        ] {
            assert_eq!(clean_filename_title(input), expected, "{input}");
        }
    }

    #[test]
    fn preserves_meaningful_suffixes_and_unknown_extensions() {
        for (input, expected) in [
            ("Mix [2025].mp3", "Mix [2025]"),
            ("Mix [Live at NTS].mp3", "Mix [Live at NTS]"),
            ("Mix [Remastered].mp3", "Mix [Remastered]"),
            ("Mix (Full Album).mp3", "Mix (Full Album)"),
            ("Mix [id].mp3", "Mix [id]"),
            ("[6ONRf7h3Mdk].mp3", "[6ONRf7h3Mdk]"),
            ("Mix[6ONRf7h3Mdk].mp3", "Mix[6ONRf7h3Mdk]"),
            ("Set.2025", "Set.2025"),
        ] {
            assert_eq!(clean_filename_title(input), expected, "{input}");
        }
    }

    #[test]
    fn uses_canonical_source_url_without_treating_uploader_as_artist() {
        let state = json!({"entries": [{
            "url": "https://www.youtube.com/watch?v=6ONRf7h3Mdk",
            "mediaId": "6ONRf7h3Mdk", "title": "  An evening mix  ",
            "uploader": "Book Club Radio"
        }]})
        .to_string();
        let metadata = cached_source_metadata(
            &state,
            Some("https://youtu.be/6ONRf7h3Mdk?t=60"),
            "random.mp3",
        )
        .unwrap();
        assert_eq!(
            metadata,
            SourceMetadata {
                name: "An evening mix".into(),
                artist: None,
                album: None
            }
        );
    }

    #[test]
    fn resolves_nts_imports_by_their_soundcloud_download_url() {
        let state = json!({"entries": [{
            "url": "https://www.nts.live/shows/yu-su/episodes/yu-su-1st-september-2026",
            "downloadUrl": "https://soundcloud.com/nts-latest/yu-su-september",
            "mediaId": "yu-su-1st-september-2026", "title": "Yu Su", "uploader": "NTS"
        }]})
        .to_string();
        let metadata = cached_source_metadata(
            &state,
            Some("http://www.soundcloud.com/nts-latest/yu-su-september/?utm_source=share"),
            "opaque.mp3",
        )
        .unwrap();
        assert_eq!(metadata.name, "Yu Su");
        assert!(metadata.artist.is_none());
    }

    #[test]
    fn resolves_legacy_callbacks_by_download_id_only_for_the_right_provider() {
        let state = json!({"entries": [
            {"url": "https://www.youtube.com/watch?v=6ONRf7h3Mdk", "mediaId": "6ONRf7h3Mdk", "title": "Video title"},
            {"url": "https://soundcloud.com/radio/mix", "mediaId": "1234567890", "title": "Audio title"},
            {"url": "https://www.nts.live/shows/radio/episodes/abcdefghijk", "mediaId": "abcdefghijk", "title": "Unrelated show"}
        ]}).to_string();
        assert_eq!(
            cached_source_metadata(&state, None, "truncated [6ONRf7h3Mdk].mp3")
                .unwrap()
                .name,
            "Video title"
        );
        assert_eq!(
            cached_source_metadata(&state, None, "truncated [1234567890].mp3")
                .unwrap()
                .name,
            "Audio title"
        );
        assert!(cached_source_metadata(&state, None, "Mix [abcdefghijk].mp3").is_none());
        assert!(cached_source_metadata(&state, None, "Video title.mp3").is_none());
    }

    #[test]
    fn does_not_pick_arbitrarily_between_conflicting_cached_titles() {
        let state = json!({"entries": [
            {"url": "https://soundcloud.com/radio/mix", "mediaId": "1234567890", "title": "First"},
            {"url": "https://soundcloud.com/radio/mix", "mediaId": "1234567890", "title": "Second"}
        ]})
        .to_string();
        assert!(cached_source_metadata(
            &state,
            Some("https://soundcloud.com/radio/mix"),
            "Mix [1234567890].mp3"
        )
        .is_none());
    }

    #[test]
    fn ignores_unusable_cached_state() {
        for state in [
            "not json",
            "{}",
            r#"{"entries": []}"#,
            r#"{"entries": [{"title": null}]}"#,
            r#"{"entries": [{"title": "  ", "mediaId": "6ONRf7h3Mdk", "url": "https://www.youtube.com/watch?v=6ONRf7h3Mdk"}]}"#,
        ] {
            assert!(cached_source_metadata(
                state,
                Some("https://youtu.be/6ONRf7h3Mdk"),
                "Mix [6ONRf7h3Mdk].mp3"
            )
            .is_none());
        }
    }
}
