// Library item matching the Rust backend structure
export interface Bookmark {
  position: number; // in seconds
  end_position?: number | null;
  emoji: string;
  label: string | null;
  created_time_utc: string;
}

export interface AlbumTrack { title: string; start: number; end: number | null; is_favorite?: boolean }
export interface Tracklist {
  tracks: AlbumTrack[];
  source_url: string | null;
  source_label: string;
  timing: 'chapters' | 'estimated' | 'edited';
  duration: number | null;
}

export interface LibraryItem {
  duration_seconds?: number | null;
  id: string;
  name: string;
  created_time_utc: string;
  file_path: string;
  artist: string;
  album: string;
  track_number: number | null;
  play_count: number;
  bookmarks: Record<string, Bookmark>;
  tracklist?: Tracklist | null;
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

export type RealtimeUpdate = LibraryUpdate | SonosRealtimeUpdate |
  { type: 'playbackSession'; snapshot: import('../stores/sharedSessionStore').SharedPlaybackSnapshot };

// Queue item for playback queue
export interface QueueItem {
  id: string;
  libraryItemId: string;
  // Optional bookmark to start from
  bookmarkPosition?: number;
}

export interface SmartPlaylistRules {
  expression?: SmartRule | null;
  added_within_days: number | null;
  play_state: 'any' | 'unplayed' | 'played';
  favourites_only: boolean;
  bookmark_state?: 'any' | 'with' | 'without';
}

export type Comparison = 'lt' | 'lte' | 'eq' | 'gte' | 'gt';
export type SmartRule =
  | { type: 'all' | 'any'; rules: SmartRule[] }
  | { type: 'duration'; comparison: Comparison; seconds: number }
  | { type: 'duration_known' | 'favourite' | 'bookmarks' | 'has_tags'; value: boolean }
  | { type: 'tag'; value: string; present: boolean }
  | { type: 'play_count'; comparison: Comparison; value: number }
  | { type: 'added_within'; days: number }
  | { type: 'text'; field: 'name' | 'artist' | 'album'; comparison: 'contains' | 'is' | 'is_not' | 'does_not_contain'; value: string };

export interface Playlist {
  id: string;
  name: string;
  items: Record<string, { library_item_id: string; position: number }>;
  smart_rules?: SmartPlaylistRules | null;
}
