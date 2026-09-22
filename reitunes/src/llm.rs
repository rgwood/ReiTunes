use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

const METADATA_MODEL: &str = "openai/gpt-6-luna";
const METADATA_PROMPT: &str = r#"You extract song metadata from audio filenames.

Rules:
1. Strip the file extension and any trailing video ID in square brackets (e.g. [kSoTN8suQ1o]).
2. Use ONLY information that literally appears in the filename. Never fill in an artist or album from your own knowledge of the song: if the filename does not name the artist, return null even when you recognize the track.
3. "<Artist> - <Title>" is the most common layout. A leading track number (e.g. "01 - ") is not part of the title.
4. When the filename is marked as a full album, the release title is BOTH the song name and the album, and the other side of the dash is the artist.
5. Return null - not an empty string, not the text "null" - for anything the filename does not state.
6. For a radio or DJ set named after its performers and a date, keep the programme name and date as the title, and extract the explicitly named performers as artists. Treat "w/" and the filename-safe "w⧸" as "with".

Worked examples:
- "Night Ripper - Girl Talk (Full Album) [kSoTN8suQ1o].mp3" -> name "Night Ripper", artist "Girl Talk", album "Night Ripper"
- "01 - Pink Floyd - Another Brick in the Wall.flac" -> name "Another Brick in the Wall", artist "Pink Floyd", album null
- "Bohemian Rhapsody.mp3" -> name "Bohemian Rhapsody", artist null, album null (you know who recorded it; that does not matter)
- "track_01.wav" -> name "track_01", artist null, album null"#;

#[derive(Deserialize, Serialize, Debug)]
#[serde(deny_unknown_fields)]
pub struct SongMetadata {
    pub name: String,
    pub artist: Option<String>,
    pub album: Option<String>,
}

pub async fn extract_song_metadata(filename: &str) -> Result<SongMetadata> {
    let key = std::env::var("OPENROUTER_API_KEY")
        .ok()
        .filter(|key| !key.trim().is_empty())
        .or_else(|| option_env!("OPENROUTER_API_KEY").map(str::to_owned))
        .filter(|key| !key.trim().is_empty())
        .context("OPENROUTER_API_KEY must be set (compile-time or runtime)")?;
    extract_openrouter(filename, &key).await
}

fn openrouter_request(filename: &str) -> serde_json::Value {
    serde_json::json!({
        "model": METADATA_MODEL,
        "max_tokens": 1024,
        "reasoning": { "effort": "none" },
        "provider": { "require_parameters": true },
        "response_format": {
            "type": "json_schema",
            "json_schema": {
                "name": "song_metadata",
                "strict": true,
                "schema": {
                    "type": "object",
                    "properties": {
                        "name": { "type": "string" },
                        "artist": { "type": ["string", "null"] },
                        "album": { "type": ["string", "null"] }
                    },
                    "required": ["name", "artist", "album"],
                    "additionalProperties": false
                }
            }
        },
        "messages": [
            { "role": "system", "content": format!("{METADATA_PROMPT}\nReturn one JSON object with exactly name (string), artist (string or null), and album (string or null).") },
            { "role": "user", "content": filename }
        ]
    })
}

async fn extract_openrouter(filename: &str, key: &str) -> Result<SongMetadata> {
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(5))
        .timeout(std::time::Duration::from_secs(40))
        .build()?;
    let response = client
        .post("https://openrouter.ai/api/v1/chat/completions")
        .bearer_auth(key)
        .json(&openrouter_request(filename))
        .send()
        .await
        .context("Could not reach OpenRouter for metadata")?;
    let status = response.status();
    let raw: serde_json::Value = response
        .json()
        .await
        .context("Invalid OpenRouter metadata response")?;
    if !status.is_success() {
        anyhow::bail!(
            "OpenRouter metadata request failed ({status}): {}",
            raw["error"]["message"]
                .as_str()
                .unwrap_or("Provider unavailable")
        );
    }
    parse_openrouter_metadata(&raw)
}

fn parse_openrouter_metadata(raw: &serde_json::Value) -> Result<SongMetadata> {
    if raw
        .pointer("/choices/0/finish_reason")
        .and_then(serde_json::Value::as_str)
        != Some("stop")
    {
        anyhow::bail!("OpenRouter metadata response did not finish");
    }
    let content = raw
        .pointer("/choices/0/message/content")
        .and_then(serde_json::Value::as_str)
        .context("Missing OpenRouter metadata response")?;
    validate_metadata(serde_json::from_str(content).context("Invalid extracted song metadata")?)
}

fn validate_metadata(mut metadata: SongMetadata) -> Result<SongMetadata> {
    metadata.name = metadata.name.trim().to_owned();
    if metadata.name.is_empty() {
        anyhow::bail!("Song name cannot be empty");
    }
    metadata.artist = normalize_missing(metadata.artist);
    metadata.album = normalize_missing(metadata.album);
    Ok(metadata)
}

/// Placeholders a model might reach for instead of emitting a real JSON null.
/// The nullable response schema is the real fix; this is a backstop so a
/// stray "unknown" never lands in the library as an artist name.
const MISSING_PLACEHOLDERS: &[&str] = &[
    "null",
    "none",
    "nil",
    "n/a",
    "na",
    "unknown",
    "unknown artist",
    "unknown album",
    "untitled",
    ".",
    "-",
    "--",
    "?",
];

/// Treat empty strings and the various "no value" placeholders as missing.
fn normalize_missing(value: Option<String>) -> Option<String> {
    value.map(|s| s.trim().to_owned()).filter(|s| {
        let trimmed = s.trim();
        !trimmed.is_empty()
            && !MISSING_PLACEHOLDERS
                .iter()
                .any(|p| trimmed.eq_ignore_ascii_case(p))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    use pretty_assertions::assert_eq;

    #[test]
    fn request_and_response_keep_unknown_fields_empty() {
        let request = openrouter_request("Four Tet - Pink [GhqBMU3muKw].mp3");
        assert_eq!(request["model"], "openai/gpt-6-luna");
        assert_eq!(
            request["response_format"]["json_schema"]["schema"]["properties"]["artist"]["type"],
            serde_json::json!(["string", "null"])
        );
        assert_eq!(
            request["messages"][1]["content"],
            "Four Tet - Pink [GhqBMU3muKw].mp3"
        );
        let metadata = parse_openrouter_metadata(&serde_json::json!({"choices":[{"finish_reason":"stop","message":{"content":r#"{"name":" Pink ","artist":"Four Tet","album":null}"#}}]})).unwrap();
        assert_eq!(metadata.name, "Pink");
        assert_eq!(metadata.artist.as_deref(), Some("Four Tet"));
        assert_eq!(metadata.album, None);
        let unknown = validate_metadata(SongMetadata {
            name: "Mix".into(),
            artist: Some("unknown".into()),
            album: Some("null".into()),
        })
        .unwrap();
        assert!(unknown.artist.is_none() && unknown.album.is_none());
    }

    #[test]
    fn incomplete_or_malformed_responses_are_not_imported_as_metadata() {
        for response in [
            serde_json::json!({"choices":[{"finish_reason":"length","message":{"content":r#"{"name":"Mix"}"#}}]}),
            serde_json::json!({"choices":[{"finish_reason":"stop","message":{"content":"not json"}}]}),
            serde_json::json!({"choices":[{"finish_reason":"stop","message":{"content":r#"{"name":"  ","artist":null,"album":null}"#}}]}),
        ] {
            assert!(parse_openrouter_metadata(&response).is_err());
        }
    }

    #[tokio::test]
    #[ignore = "Calls a paid model; run explicitly with API credentials"]
    async fn test_full_album() {
        let metadata =
            extract_song_metadata("Night Ripper - Girl Talk (Full Album) [kSoTN8suQ1o].mp3")
                .await
                .unwrap();
        assert_eq!(metadata.name, "Night Ripper");
        assert_eq!(metadata.artist.as_deref(), Some("Girl Talk"));
        assert_eq!(metadata.album.as_deref(), Some("Night Ripper"));
    }

    #[tokio::test]
    #[ignore = "Calls a paid model; run explicitly with API credentials"]
    async fn test_artist_song_format() {
        let metadata = extract_song_metadata("The Beatles - Hey Jude.mp3")
            .await
            .unwrap();
        assert_eq!(metadata.name, "Hey Jude");
        assert_eq!(metadata.artist.as_deref(), Some("The Beatles"));
    }

    #[tokio::test]
    #[ignore = "Calls a paid model; run explicitly with API credentials"]
    async fn test_song_only() {
        let metadata = extract_song_metadata("Bohemian Rhapsody.mp3")
            .await
            .unwrap();
        assert_eq!(metadata.name, "Bohemian Rhapsody");
        // The filename names no artist or album, so we must not invent one -- not even
        // for a song this recognizable.
        assert!(metadata.artist.is_none());
        assert!(metadata.album.is_none());
    }

    #[tokio::test]
    #[ignore = "Calls a paid model; run explicitly with API credentials"]
    async fn test_complex_filename() {
        let metadata = extract_song_metadata("01 - Pink Floyd - Another Brick in the Wall.flac")
            .await
            .unwrap();
        assert_eq!(metadata.name, "Another Brick in the Wall");
        assert_eq!(metadata.artist.as_deref(), Some("Pink Floyd"));
    }

    #[tokio::test]
    #[ignore = "Calls a paid model; run explicitly with API credentials"]
    async fn test_youtube_id_removal() {
        let metadata = extract_song_metadata("Drake - God's Plan [6ONRf7h3Mdk].mp4")
            .await
            .unwrap();
        assert_eq!(metadata.name, "God's Plan");
        assert_eq!(metadata.artist.as_deref(), Some("Drake"));
    }

    #[tokio::test]
    #[ignore = "Calls a paid model; run explicitly with API credentials"]
    async fn test_radio_set_filename() {
        let metadata =
            extract_song_metadata("Floating Points w⧸ Hikaru Utada 270726 [2368780706].mp3")
                .await
                .unwrap();
        assert!(metadata.name.contains("270726"));
        assert!(!metadata.name.contains("2368780706"));
        let artist = metadata.artist.unwrap();
        assert!(artist.contains("Floating Points") && artist.contains("Hikaru Utada"));
        assert!(metadata.album.is_none());
    }

    #[tokio::test]
    #[ignore = "Calls a paid model; run explicitly with API credentials"]
    async fn test_ambiguous_filename() {
        let metadata = extract_song_metadata("track_01.wav").await.unwrap();
        assert_eq!(metadata.name, "track_01");
        // Artist and album should be None for ambiguous filenames
        assert!(metadata.artist.is_none());
        assert!(metadata.album.is_none());
    }
}
