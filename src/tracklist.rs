use serde::{Deserialize, Serialize};

/// Chapters reference the original audio; bookmarks remain independent.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AlbumTrack {
    pub title: String,
    pub start: f64,
    pub end: Option<f64>,
    #[serde(default)]
    pub is_favorite: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Tracklist {
    pub tracks: Vec<AlbumTrack>,
    pub source_url: Option<String>,
    pub source_label: String,
    pub timing: String,
    pub duration: Option<f64>,
}

impl Tracklist {
    /// Only remove a complete sequence of track-number prefixes. A title such
    /// as "128 Harps" or "2.0" on its own is not evidence of numbering.
    pub fn clean_numbered_titles(&mut self) {
        if self.tracks.len() < 2 {
            return;
        }
        let titles: Option<Vec<String>> = self
            .tracks
            .iter()
            .enumerate()
            .map(|(index, track)| {
                let title = track.title.trim();
                let digits = title.chars().take_while(char::is_ascii_digit).count();
                if title.get(..digits)?.parse::<usize>().ok()? != index + 1 {
                    return None;
                }
                let tail = &title[digits..];
                let tail = tail
                    .strip_prefix('.')
                    .or_else(|| tail.strip_prefix(')'))
                    .or_else(|| tail.strip_prefix(" -"))?;
                if !tail.starts_with(char::is_whitespace) || tail.trim().is_empty() {
                    return None;
                }
                Some(tail.trim().to_owned())
            })
            .collect();
        if let Some(titles) = titles {
            for (track, title) in self.tracks.iter_mut().zip(titles) {
                track.title = title;
            }
        }
    }
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.tracks.is_empty() || self.tracks.len() > 300 {
            return Err("A tracklist must contain between 1 and 300 tracks.");
        }
        let valid_time = |t: f64| t.is_finite() && (0.0..=604800.0).contains(&t);
        if self.duration.is_some_and(|t| !valid_time(t) || t == 0.0) {
            return Err("Invalid recording duration.");
        }
        if !matches!(self.timing.as_str(), "chapters" | "estimated" | "edited")
            || self.source_label.len() > 500
        {
            return Err("Invalid tracklist source.");
        }
        if let Some(url) = &self.source_url {
            if url.len() > 2000 || !(url.starts_with("https://") || url.starts_with("http://")) {
                return Err("Source must be an HTTP or HTTPS URL.");
            }
        }
        for (i, track) in self.tracks.iter().enumerate() {
            if track.title.trim().is_empty() || track.title.len() > 500 || !valid_time(track.start)
            {
                return Err("Each track needs a title and a valid start time.");
            }
            if i > 0 && track.start <= self.tracks[i - 1].start {
                return Err("Track starts must be in increasing order.");
            }
            if track.end.is_some_and(|end| {
                !valid_time(end)
                    || end <= track.start
                    || self.tracks.get(i + 1).is_some_and(|next| end > next.start)
            }) {
                return Err("An end must follow its start and must not overlap the next track.");
            }
            if self.duration.is_some_and(|duration| {
                track.start >= duration || track.end.is_some_and(|end| end > duration)
            }) {
                return Err("Track times must fit within the recording.");
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::*;
    #[test]
    fn cleans_only_complete_numbered_sequences_and_loads_legacy_favourites() {
        let mut list: Tracklist = serde_json::from_value(serde_json::json!({
            "tracks": [{"title":"1. Locked","start":0,"end":510}, {"title":"2. 128 Harps","start":510,"end":null}],
            "source_url":null,"source_label":"Upload","timing":"chapters","duration":null
        })).unwrap();
        assert!(!list.tracks[0].is_favorite);
        list.clean_numbered_titles();
        assert_eq!(list.tracks[0].title, "Locked");
        assert_eq!(list.tracks[1].title, "128 Harps");
        for (one, two) in [
            ("1.0", "2.0"),
            ("1. Song", "128 Harps"),
            ("1999", "2. Lion"),
            ("1. Song", "3. Another song"),
        ] {
            list.tracks[0].title = one.into();
            list.tracks[1].title = two.into();
            list.clean_numbered_titles();
            assert_eq!(list.tracks[0].title, one);
            assert_eq!(list.tracks[1].title, two);
        }
        list.tracks[0].title = "01) Locked".into();
        list.tracks[1].title = "02) Lion".into();
        list.clean_numbered_titles();
        assert_eq!(list.tracks[1].title, "Lion");
    }
    #[test]
    fn tracklist_events_round_trip_without_touching_bookmarks() {
        let id = uuid::Uuid::new_v4();
        let list = Tracklist {
            tracks: vec![
                AlbumTrack {
                    title: "Intro".into(),
                    start: 0.0,
                    end: Some(10.25),
                    is_favorite: true,
                },
                AlbumTrack {
                    title: "Main".into(),
                    start: 10.25,
                    end: None,
                    is_favorite: false,
                },
            ],
            source_url: None,
            source_label: "Manual".into(),
            timing: "edited".into(),
            duration: Some(100.0),
        };
        assert!(list.validate().is_ok());
        let mut library = Library::new();
        let created = EventWithMetadata::new(
            id,
            Event::LibraryItemCreatedEvent {
                name: "Album".into(),
                artist: None,
                album: None,
                track_number: None,
                file_path: "album.mp3".into(),
            },
        )
        .unwrap();
        library.apply(&created);
        let event = EventWithMetadata::new(
            id,
            Event::LibraryItemTracklistChangedEvent {
                tracklist: Some(list.clone()),
            },
        )
        .unwrap();
        let decoded = serde_json::from_str(&serde_json::to_string(&event).unwrap()).unwrap();
        library.apply(&decoded);
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        connection
            .execute_batch(include_str!("../schema.sql"))
            .unwrap();
        save_event_to_db(&connection, &created).unwrap();
        save_event_to_db(&connection, &decoded).unwrap();
        assert_eq!(
            load_library_from_db(&connection).unwrap().items[&id].tracklist,
            Some(list.clone())
        );
        assert_eq!(library.items[&id].tracklist, Some(list.clone()));
        assert!(library.items[&id].bookmarks.is_empty());
        let mut invalid = list;
        invalid.tracks[1].start = 9.0;
        assert!(invalid.validate().is_err());
        invalid.tracks[1].start = f64::NAN;
        assert!(invalid.validate().is_err());
        library.apply(
            &EventWithMetadata::new(
                id,
                Event::LibraryItemTracklistChangedEvent { tracklist: None },
            )
            .unwrap(),
        );
        assert!(library.items[&id].tracklist.is_none());
    }
}
