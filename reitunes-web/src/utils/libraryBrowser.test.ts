import { describe, expect, it } from 'vitest';
import type { LibraryItem } from '../types';
import { albumSearch, albumTracks, matchesLibrarySearch, searchedAlbum, tagSearch } from './libraryBrowser';

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
  it('matches plain search terms against tags', () => {
    const track = item('one');
    const tags = ['dj-mix', 'house'];
    expect(matchesLibrarySearch(track, 'house', tags)).toBe(true);
    expect(matchesLibrarySearch(track, 'dj mix', tags)).toBe(true);
    expect(matchesLibrarySearch(track, 'dj-mix night', tags)).toBe(true);
    expect(matchesLibrarySearch(track, 'techno', tags)).toBe(false);
    expect(matchesLibrarySearch(track, 'house')).toBe(false);
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

describe('albums', () => {
  it('round-trips album names through an album search', () => {
    for (const album of ['Ys', 'Heaven or Las Vegas', 'The "Quoted" One', 'Back\\slash']) {
      expect(searchedAlbum(albumSearch(album))).toBe(album);
      expect(matchesLibrarySearch(item('a', { album }), albumSearch(album))).toBe(true);
    }
    expect(searchedAlbum('album:Ys')).toBe('Ys');
  });

  it('only treats a search that is just one album as an album view', () => {
    expect(searchedAlbum('album:Ys artist:"Joanna Newsom"')).toBeNull();
    expect(searchedAlbum('album:Ys emily')).toBeNull();
    expect(searchedAlbum('Ys')).toBeNull();
    expect(searchedAlbum('')).toBeNull();
  });

  it('lists an album in track order with unnumbered songs last', () => {
    const songs = [
      item('bonus', { album: 'Ys', track_number: null }),
      item('three', { album: 'YS', track_number: 3 }),
      item('other', { album: 'Ys Live', track_number: 1 }),
      item('one', { album: 'Ys', track_number: 1 }),
      item('demo', { album: 'Ys', track_number: null }),
    ];
    expect(albumTracks(songs, 'ys').map(song => song.id)).toEqual(['one', 'three', 'bonus', 'demo']);
  });
});
