import { describe, expect, it } from 'vitest';
import type { LibraryItem } from '../types';
import {
  bookmarkEntries,
  filterBookmarkEntries,
  formatBookmarkPosition,
  parseBookmarkPosition,
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
    expect(formatBookmarkPosition(70.125, true)).toBe('1:10.125');
    expect(formatBookmarkPosition(1.1 - 1, true)).toBe('0:00.1');
    expect(formatBookmarkPosition(0.000000001, true)).toBe('0:00.000000001');
  });
});

describe('bookmark time input', () => {
  it.each([
    ['0', 0], ['70.125', 70.125], ['1:05.5', 65.5], ['1:02:03', 3723],
    ['90:00', 5400], [' 0:02 ', 2],
  ])('parses %s as %s seconds', (value, expected) => {
    expect(parseBookmarkPosition(value)).toBe(expected);
  });

  it.each(['', ' ', '-1', '1:60', '1:99:00', '1:2:3:4', 'NaN', 'Infinity', '1e3', 'abc', '1:', '9007199254740992'])('rejects %j', value => {
    expect(parseBookmarkPosition(value)).toBeNull();
  });
});
