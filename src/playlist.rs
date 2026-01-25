use anyhow::{Context, Result};
use indexmap::IndexMap;
use jiff::civil::DateTime;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use tracing::info;
use uuid::Uuid;

use crate::database::{load_all_events_from_db, save_event_to_db};

/// Playlist event types
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "$type", rename_all_fields = "PascalCase")]
pub enum PlaylistEvent {
    PlaylistCreatedEvent { name: String },
    PlaylistRenamedEvent { new_name: String },
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
                self.items
                    .sort_by(|_, a, _, b| a.position.cmp(&b.position));
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
                    self.items
                        .sort_by(|_, a, _, b| a.position.cmp(&b.position));
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

    /// Get non-deleted playlists
    pub fn active_playlists(&self) -> Vec<&Playlist> {
        self.playlists
            .values()
            .filter(|p| !p.is_deleted)
            .collect()
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
}
