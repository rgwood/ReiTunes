use anyhow::{Context, Result};
use rig::providers::openai;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

const GPT_LUNA: &str = "gpt-5.6-luna";

#[derive(Deserialize, Serialize, JsonSchema, Debug)]
pub struct SongMetadata {
    #[schemars(description = "The song title, taken from the filename.")]
    pub name: String,
    // OpenAI's strict structured outputs require every property to appear in `required`.
    // Adding `required` alone makes schemars emit `"type": "string"`, which forbids null
    // on a field the prompt asks it to null out -- the model then can't comply and
    // improvises placeholders like "." or ">>null<<". The `extend` restores nullability,
    // so these are required AND nullable, which is what strict mode actually wants.
    #[schemars(
        required,
        extend("type" = ["string", "null"]),
        description = "The artist, ONLY if the filename literally names one, otherwise null. Never infer the artist from your own knowledge of the song."
    )]
    pub artist: Option<String>,
    #[schemars(
        required,
        extend("type" = ["string", "null"]),
        description = "The album, ONLY if the filename literally names one, otherwise null. Never infer the album from your own knowledge of the song."
    )]
    pub album: Option<String>,
}

pub async fn extract_song_metadata(filename: &str) -> Result<SongMetadata> {
    // Compile-time key first (baked in via `just publish`), then runtime env var (for dev).
    let api_key = option_env!("OPENAI_API_KEY")
        .map(String::from)
        .or_else(|| std::env::var("OPENAI_API_KEY").ok())
        .context("OPENAI_API_KEY must be set (compile-time or runtime)")?;
    let client: openai::Client =
        openai::Client::new(&api_key).context("Failed to create OpenAI client")?;

    // Create the extractor for the SongMetadata struct
    let extractor = client
        .extractor::<SongMetadata>(GPT_LUNA)
        .max_tokens(500)
        .preamble(
            r#"You extract song metadata from audio filenames.

Rules:
1. Strip the file extension and any trailing video ID in square brackets (e.g. [kSoTN8suQ1o]).
2. Use ONLY information that literally appears in the filename. Never fill in an artist or album from your own knowledge of the song: if the filename does not name the artist, return null even when you recognize the track.
3. "<Artist> - <Title>" is the most common layout. A leading track number (e.g. "01 - ") is not part of the title.
4. When the filename is marked as a full album, the release title is BOTH the song name and the album, and the other side of the dash is the artist.
5. Return null - not an empty string, not the text "null" - for anything the filename does not state.

Worked examples:
- "Night Ripper - Girl Talk (Full Album) [kSoTN8suQ1o].mp3" -> name "Night Ripper", artist "Girl Talk", album "Night Ripper"
- "01 - Pink Floyd - Another Brick in the Wall.flac" -> name "Another Brick in the Wall", artist "Pink Floyd", album null
- "Bohemian Rhapsody.mp3" -> name "Bohemian Rhapsody", artist null, album null (you know who recorded it; that does not matter)
- "track_01.wav" -> name "track_01", artist null, album null"#,
        )
        .additional_params(serde_json::json!({"temperature": 0}))
        .build();

    // Extract the structured data
    let mut extracted_data = extractor
        .extract(filename)
        .await
        .context("Failed to extract song metadata from filename")?;

    // Basic validation: ensure song name is not empty
    if extracted_data.name.trim().is_empty() {
        anyhow::bail!("Song name cannot be empty");
    }

    // Backstop: normalize any placeholder the model used in place of a real null.
    extracted_data.artist = normalize_missing(extracted_data.artist);
    extracted_data.album = normalize_missing(extracted_data.album);

    Ok(extracted_data)
}

/// Placeholders a model might reach for instead of emitting a real JSON null.
/// The nullable schema on SongMetadata is the real fix; this is a backstop so a
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
    value.filter(|s| {
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

    #[tokio::test]
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
    async fn test_artist_song_format() {
        let metadata = extract_song_metadata("The Beatles - Hey Jude.mp3")
            .await
            .unwrap();
        assert_eq!(metadata.name, "Hey Jude");
        assert_eq!(metadata.artist.as_deref(), Some("The Beatles"));
    }

    #[tokio::test]
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
    async fn test_complex_filename() {
        let metadata = extract_song_metadata("01 - Pink Floyd - Another Brick in the Wall.flac")
            .await
            .unwrap();
        assert_eq!(metadata.name, "Another Brick in the Wall");
        assert_eq!(metadata.artist.as_deref(), Some("Pink Floyd"));
    }

    #[tokio::test]
    async fn test_youtube_id_removal() {
        let metadata = extract_song_metadata("Drake - God's Plan [6ONRf7h3Mdk].mp4")
            .await
            .unwrap();
        assert_eq!(metadata.name, "God's Plan");
        assert_eq!(metadata.artist.as_deref(), Some("Drake"));
    }

    #[tokio::test]
    async fn test_ambiguous_filename() {
        let metadata = extract_song_metadata("track_01.wav").await.unwrap();
        assert_eq!(metadata.name, "track_01");
        // Artist and album should be None for ambiguous filenames
        assert!(metadata.artist.is_none());
        assert!(metadata.album.is_none());
    }
}
