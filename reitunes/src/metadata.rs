use anyhow::{Context, Result};
use lofty::file::AudioFile;
use lofty::prelude::*;
use lofty::file::TaggedFile;
use lofty::probe::Probe;
use std::path::Path;
use std::time::Duration;
use tracing::info;

/// Extracted metadata from an audio file
#[derive(Debug, Clone, Default)]
#[allow(dead_code)]
pub struct AudioMetadata {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub track_number: Option<u32>,
    pub year: Option<u32>,
    pub genre: Option<String>,
    pub duration: Option<Duration>,
}

impl AudioMetadata {
    /// Check if this metadata has any useful information
    pub fn has_info(&self) -> bool {
        self.title.is_some() || self.artist.is_some() || self.album.is_some()
    }
}

/// Extract metadata from an audio file
pub fn extract_metadata(path: &Path) -> Result<AudioMetadata> {
    info!(path = ?path, "Extracting metadata from audio file");

    let tagged_file = Probe::open(path)
        .context("Failed to open audio file")?
        .read()
        .context("Failed to read audio file")?;

    let metadata = from_tagged_file(&tagged_file);

    info!(
        title = ?metadata.title,
        artist = ?metadata.artist,
        album = ?metadata.album,
        duration = ?metadata.duration,
        "Extracted metadata"
    );

    Ok(metadata)
}

/// Read the useful tags and duration from an already parsed file.
pub fn from_tagged_file(tagged_file: &TaggedFile) -> AudioMetadata {
    let duration = tagged_file.properties().duration();
    let duration = if duration.is_zero() { None } else { Some(duration) };

    // Try to get primary tag first, then any tag
    match tagged_file.primary_tag().or_else(|| tagged_file.first_tag()) {
        Some(tag) => AudioMetadata {
            title: tag.title().map(|s| s.to_string()),
            artist: tag.artist().map(|s| s.to_string()),
            album: tag.album().map(|s| s.to_string()),
            track_number: tag.track(),
            year: tag.year(),
            genre: tag.genre().map(|s| s.to_string()),
            duration,
        },
        None => AudioMetadata { duration, ..Default::default() },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn test_extract_metadata_nonexistent() {
        let path = PathBuf::from("/nonexistent/file.mp3");
        let result = extract_metadata(&path);
        assert!(result.is_err());
    }
}
