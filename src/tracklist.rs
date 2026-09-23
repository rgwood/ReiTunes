use serde::{Deserialize, Serialize};

/// Chapters reference the original audio; bookmarks remain independent.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AlbumTrack {
    pub title: String,
    pub start: f64,
    pub end: Option<f64>,
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
    fn tracklist_events_round_trip_without_touching_bookmarks() {
        let id = uuid::Uuid::new_v4();
        let list = Tracklist {
            tracks: vec![
                AlbumTrack {
                    title: "Intro".into(),
                    start: 0.0,
                    end: Some(10.25),
                },
                AlbumTrack {
                    title: "Main".into(),
                    start: 10.25,
                    end: None,
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
