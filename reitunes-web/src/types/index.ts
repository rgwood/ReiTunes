// Library item matching the Rust backend structure
export interface Bookmark {
  position: number; // in seconds
  emoji: string;
  label: string | null;
  created_time_utc: string;
}

export interface LibraryItem {
  id: string;
  name: string;
  created_time_utc: string;
  file_path: string;
  artist: string;
  album: string;
  track_number: number | null;
  play_count: number;
  bookmarks: Record<string, Bookmark>;
  is_favorite?: boolean;
  url: string;  // Full URL provided by backend
}

// WebSocket update messages
export type LibraryUpdate =
  | { type: 'update'; item: LibraryItem }
  | { type: 'delete'; id: string };

export interface SonosRealtimeUpdate {
  type: 'sonos';
  namespace: string;
  eventType: string;
  targetId: string;
  payload: unknown;
}

export type RealtimeUpdate = LibraryUpdate | SonosRealtimeUpdate;

// Queue item for playback queue
export interface QueueItem {
  id: string;
  libraryItemId: string;
  // Optional bookmark to start from
  bookmarkPosition?: number;
}

export interface SmartPlaylistRules {
  added_within_days: number | null;
  play_state: 'any' | 'unplayed' | 'played';
  favourites_only: boolean;
  bookmark_state?: 'any' | 'with' | 'without';
}

export interface Playlist {
  id: string;
  name: string;
  items: Record<string, { library_item_id: string; position: number }>;
  smart_rules?: SmartPlaylistRules | null;
}
