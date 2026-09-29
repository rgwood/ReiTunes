import { describe, expect, it } from 'vitest';
import type { LibraryItem } from '../types';
import { matchesLibrarySearch, tagSearch } from './libraryBrowser';

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
  it('matches whole artist and album names while keeping free text broad', () => {
    const ys = item('ys', { artist: 'Joanna Newsom', album: 'Ys' });
    const days = item('days', { artist: 'Joanna Newsom and friends', album: 'Days' });
    expect(matchesLibrarySearch(ys, 'album:"ys" artist:"JOANNA NEWSOM"')).toBe(true);
    expect(matchesLibrarySearch(days, 'album:Ys')).toBe(false);
    expect(matchesLibrarySearch(days, 'artist:"Joanna Newsom"')).toBe(false);
    expect(matchesLibrarySearch(days, 'ys')).toBe(true);
    expect(matchesLibrarySearch(item('live', { album: 'Ys Live' }), 'album:Ys')).toBe(false);
  });
  it('combines exact tag matches with text and artist/album filters', () => {
    const track = item('one');
    const tags = ['dj-mix', 'house', 'high-energy', 'odd"tag'];
    expect(matchesLibrarySearch(track, 'tag:DJ-MIX tag:house artist:"Four Tet" night', tags)).toBe(true);
    expect(matchesLibrarySearch(track, 'tag:dj', tags)).toBe(false);
    expect(matchesLibrarySearch(track, 'tag:missing', tags)).toBe(false);
    expect(matchesLibrarySearch(track, 'tag:"high energy" album:Rounds', tags)).toBe(true);
    expect(matchesLibrarySearch(track, 'tag:dj-mix')).toBe(false);
    expect(matchesLibrarySearch(track, tagSearch('odd"tag'), tags)).toBe(true);
    expect(tagSearch('dj-mix')).toBe('tag:dj-mix');
  });
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
