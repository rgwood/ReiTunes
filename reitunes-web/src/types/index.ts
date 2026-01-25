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
}

// WebSocket update messages
export type LibraryUpdate =
  | { type: 'update'; item: LibraryItem }
  | { type: 'delete'; id: string };

// Queue item for playback queue
export interface QueueItem {
  id: string;
  libraryItemId: string;
  // Optional bookmark to start from
  bookmarkPosition?: number;
}
