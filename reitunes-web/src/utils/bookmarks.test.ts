import { describe, expect, it } from 'vitest';
import type { LibraryItem } from '../types';
import {
  bookmarkEntries,
  filterBookmarkEntries,
  formatBookmarkPosition,
} from './bookmarks';

function item(
  id: string,
  name: string,
  artist: string,
  album: string,
  bookmarks: LibraryItem['bookmarks']
): LibraryItem {
  return {
    id,
    name,
    artist,
    album,
    bookmarks,
    created_time_utc: '2026-01-01T00:00:00',
    file_path: `${id}.mp3`,
    track_number: null,
    play_count: 0,
    is_favorite: false,
    url: `/${id}.mp3`,
  };
}

describe('bookmark entries', () => {
  const items = [
    item('one', 'Northern Sky', 'Nick Drake', 'Bryter Layter', {
      older: {
        position: 70,
        emoji: '🎸',
        label: 'Guitar entrance',
        created_time_utc: '2026-01-01T00:00:00',
      },
    }),
    item('two', 'River Man', 'Nick Drake', 'Five Leaves Left', {
      newer: {
        position: 3723,
        emoji: '🎻',
        label: null,
        created_time_utc: '2026-02-01T00:00:00',
      },
    }),
  ];

  it('flattens bookmarks newest first and keeps their IDs', () => {
    const entries = bookmarkEntries(items);

    expect(entries.map((entry) => entry.bookmarkId)).toEqual(['newer', 'older']);
  });

  it('filters across labels and track metadata', () => {
    const entries = bookmarkEntries(items);

    expect(filterBookmarkEntries(entries, 'guitar')[0]?.bookmarkId).toBe('older');
    expect(filterBookmarkEntries(entries, 'five leaves')[0]?.bookmarkId).toBe('newer');
    expect(filterBookmarkEntries(entries, 'NICK')).toHaveLength(2);
    expect(filterBookmarkEntries(entries, 'missing')).toEqual([]);
  });

  it('formats short and long bookmark positions', () => {
    expect(formatBookmarkPosition(70.9)).toBe('1:10');
    expect(formatBookmarkPosition(3723)).toBe('1:02:03');
  });
});
