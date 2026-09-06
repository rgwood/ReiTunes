// Library item matching the Rust backend structure
export interface Bookmark {
  position: number; // in seconds
  emoji: string;
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

// A track or bookmark, resolved against the live library at playback time.
export interface PlaybackTarget {
  libraryItemId: string;
  startPosition: number;
  bookmarkId?: string;
}

// Each queued occurrence has its own identity, even for the same track.
export interface PlaybackEntry extends PlaybackTarget {
  id: string;
}
