use anyhow::{Context, Result};
use indexmap::IndexMap;
use jiff::civil::DateTime;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use tracing::warn;
use uuid::Uuid;

use crate::database::load_all_playlist_events_from_db;
use crate::library::EventRow;

/// Load and rebuild playlists from their stored events.
pub fn load_playlists_from_db(conn: &Connection) -> Result<PlaylistStore> {
    let events = load_all_playlist_events_from_db(conn)?;
    Ok(PlaylistStore::build_from_events(events))
}

/// Playlist event types
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "$type", rename_all_fields = "PascalCase")]
pub enum PlaylistEvent {
    PlaylistCreatedEvent {
        name: String,
    },
    PlaylistRenamedEvent {
        new_name: String,
    },
    PlaylistDeletedEvent,
    PlaylistItemAddedEvent {
        library_item_id: Uuid,
        position: u32,
    },
    PlaylistItemRemovedEvent {
        library_item_id: Uuid,
    },
    PlaylistItemMovedEvent {
        library_item_id: Uuid,
        new_position: u32,
    },
}

/// Playlist item (reference to a library item)
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PlaylistItem {
    pub library_item_id: Uuid,
    pub position: u32,
}

/// Playlist representation
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Playlist {
    pub id: Uuid,
    pub name: String,
    pub created_time_utc: DateTime,
    pub items: IndexMap<Uuid, PlaylistItem>,
    pub is_deleted: bool,
}

impl Playlist {
    pub fn new(id: Uuid, name: String, created_time_utc: DateTime) -> Self {
        Playlist {
            id,
            name,
            created_time_utc,
            items: IndexMap::new(),
            is_deleted: false,
        }
    }

    /// Apply an event to update the playlist state
    pub fn apply(&mut self, event: &PlaylistEvent) {
        match event {
            PlaylistEvent::PlaylistCreatedEvent { name } => {
                self.name = name.clone();
            }
            PlaylistEvent::PlaylistRenamedEvent { new_name } => {
                self.name = new_name.clone();
            }
            PlaylistEvent::PlaylistDeletedEvent => {
                self.is_deleted = true;
            }
            PlaylistEvent::PlaylistItemAddedEvent {
                library_item_id,
                position,
            } => {
                self.items.insert(
                    *library_item_id,
                    PlaylistItem {
                        library_item_id: *library_item_id,
                        position: *position,
                    },
                );
                // Sort by position
                self.items.sort_by(|_, a, _, b| a.position.cmp(&b.position));
            }
            PlaylistEvent::PlaylistItemRemovedEvent { library_item_id } => {
                self.items.shift_remove(library_item_id);
            }
            PlaylistEvent::PlaylistItemMovedEvent {
                library_item_id,
                new_position,
            } => {
                if let Some(item) = self.items.get_mut(library_item_id) {
                    item.position = *new_position;
                    // Re-sort
                    self.items.sort_by(|_, a, _, b| a.position.cmp(&b.position));
                }
            }
        }
    }
}

/// In-memory collection of all playlists
#[derive(Clone, Default)]
pub struct PlaylistStore {
    pub playlists: IndexMap<Uuid, Playlist>,
}

impl PlaylistStore {
    pub fn new() -> Self {
        PlaylistStore {
            playlists: IndexMap::new(),
        }
    }

    /// Rebuild all playlists from events in chronological order.
    pub fn build_from_events(events: Vec<PlaylistEventWithMetadata>) -> Self {
        let mut store = PlaylistStore::new();

        for event in events {
            match &event.event {
                PlaylistEvent::PlaylistCreatedEvent { name } => {
                    store.playlists.insert(
                        event.aggregate_id,
                        Playlist::new(event.aggregate_id, name.clone(), event.created_time_utc),
                    );
                }
                playlist_event => {
                    if let Some(playlist) = store.playlists.get_mut(&event.aggregate_id) {
                        playlist.apply(playlist_event);
                    } else {
                        warn!(
                            playlist_id = %event.aggregate_id,
                            ?playlist_event,
                            "Ignoring playlist event without a creation event"
                        );
                    }
                }
            }
        }

        store
    }

    /// Get non-deleted playlists
    pub fn active_playlists(&self) -> Vec<&Playlist> {
        self.playlists.values().filter(|p| !p.is_deleted).collect()
    }
}

/// Event with metadata wrapper for playlists
#[derive(Debug, Serialize, Deserialize)]
#[allow(dead_code)]
pub struct PlaylistEventWithMetadata {
    pub id: Uuid,
    pub aggregate_id: Uuid,
    pub aggregate_type: String,
    pub created_time_utc: DateTime,
    pub machine_name: String,
    pub event: PlaylistEvent,
}

impl PlaylistEventWithMetadata {
    pub fn new(playlist_id: Uuid, event: PlaylistEvent) -> Result<Self> {
        use jiff::tz::TimeZone;
        use jiff::Zoned;

        let created_time_utc = Zoned::now().with_time_zone(TimeZone::UTC).datetime();
        let event_with_metadata = PlaylistEventWithMetadata {
            id: Uuid::new_v4(),
            aggregate_id: playlist_id,
            aggregate_type: "Playlist".to_string(),
            created_time_utc,
            machine_name: hostname::get()?.to_string_lossy().into(),
            event,
        };
        Ok(event_with_metadata)
    }

    pub fn from_row(row: EventRow) -> Result<Self> {
        let event = serde_json::from_str(&row.serialized)
            .context("Failed to deserialize playlist event")?;

        Ok(PlaylistEventWithMetadata {
            id: row.id,
            aggregate_id: row.aggregate_id,
            aggregate_type: row.aggregate_type,
            created_time_utc: row.created_time_utc,
            machine_name: row.machine_name,
            event,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::save_playlist_event_to_db;

    #[test]
    fn playlists_survive_database_reload() -> Result<()> {
        let conn = Connection::open_in_memory()?;
        conn.execute_batch(include_str!("../schema.sql"))?;

        let playlist_id = Uuid::new_v4();
        let item_id = Uuid::new_v4();
        for event in [
            PlaylistEvent::PlaylistCreatedEvent {
                name: "Morning music".to_string(),
            },
            PlaylistEvent::PlaylistItemAddedEvent {
                library_item_id: item_id,
                position: 0,
            },
            PlaylistEvent::PlaylistRenamedEvent {
                new_name: "Morning bangers".to_string(),
            },
        ] {
            save_playlist_event_to_db(&conn, &PlaylistEventWithMetadata::new(playlist_id, event)?)?;
        }

        let reloaded = load_playlists_from_db(&conn)?;
        let playlist = reloaded.playlists.get(&playlist_id).unwrap();
        assert_eq!(playlist.name, "Morning bangers");
        assert_eq!(playlist.items.get(&item_id).unwrap().position, 0);
        assert_eq!(reloaded.active_playlists().len(), 1);

        Ok(())
    }

    #[test]
    fn deleted_playlists_remain_deleted_after_reload() -> Result<()> {
        let conn = Connection::open_in_memory()?;
        conn.execute_batch(include_str!("../schema.sql"))?;

        let playlist_id = Uuid::new_v4();
        for event in [
            PlaylistEvent::PlaylistCreatedEvent {
                name: "Temporary".to_string(),
            },
            PlaylistEvent::PlaylistDeletedEvent,
        ] {
            save_playlist_event_to_db(&conn, &PlaylistEventWithMetadata::new(playlist_id, event)?)?;
        }

        let reloaded = load_playlists_from_db(&conn)?;
        assert!(reloaded.playlists.get(&playlist_id).unwrap().is_deleted);
        assert!(reloaded.active_playlists().is_empty());

        Ok(())
    }
}
