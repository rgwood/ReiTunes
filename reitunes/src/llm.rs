use anyhow::{Context, Result};
use rig::client::CompletionClient;
use rig::providers::anthropic::ClientBuilder;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Deserialize, Serialize, JsonSchema, Debug)]
pub struct SongMetadata {
    pub name: String,
    pub artist: Option<String>,
    pub album: Option<String>,
}

pub async fn extract_song_metadata(filename: &str) -> Result<SongMetadata> {
    let api_key = env!("ANTHROPIC_API_KEY");
    let client = ClientBuilder::new(&api_key).build();

    // Create the extractor for the SongMetadata struct
    let extractor = client.extractor::<SongMetadata>("claude-3-5-haiku-20241022")
    .max_tokens(500)
    .preamble("You are a helpful assistant that extracts song metadata from filenames. Extract the song name, artist, and album from the filename. For full album files like 'Night Ripper - Girl Talk (Full Album) [kSoTN8suQ1o].mp3', use 'Night Ripper' as both the name and album. Remove file extensions and video IDs in brackets. If artist or album information is not clear or missing, return null for those fields. For ambiguous filenames like 'track_01.wav', use the filename (without extension) as the song name and return null for artist and album.")
    .build();

    // Extract the structured data
    let extracted_data = extractor
        .extract(filename)
        .await
        .context("Failed to extract song metadata from filename")?;

    // Basic validation: ensure song name is not empty
    if extracted_data.name.trim().is_empty() {
        anyhow::bail!("Song name cannot be empty");
    }

    Ok(extracted_data)
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
        // Artist and album should not be guessed
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
