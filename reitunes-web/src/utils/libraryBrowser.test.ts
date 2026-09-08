import { describe, expect, it } from 'vitest';
import type { LibraryItem } from '../types';
import { matchesLibrarySearch } from './libraryBrowser';

function item(id: string, changes: Partial<LibraryItem> = {}): LibraryItem {
  return {
    id,
    name: 'Night drive',
    artist: 'Four Tet',
    album: 'Rounds',
    track_number: null,
    created_time_utc: '2026-09-01T00:00:00',
    file_path: '',
    play_count: 0,
    bookmarks: {},
    url: '',
    ...changes,
  };
}

describe('library search', () => {
  it('searches across words, bookmark labels, and existing artist/album syntax', () => {
    const track = item('one', {
      bookmarks: {
        moment: {
          position: 120,
          label: 'Piano entrance',
          emoji: '🎹',
          created_time_utc: '',
        },
      },
    });
    expect(matchesLibrarySearch(track, 'tet night piano')).toBe(true);
    expect(
      matchesLibrarySearch(track, 'artist:"Four Tet" album:"Rounds" piano')
    ).toBe(true);
    expect(matchesLibrarySearch(track, 'artist:"Bonobo" piano')).toBe(false);
    expect(matchesLibrarySearch(track, 'night absent')).toBe(false);
  });
});
