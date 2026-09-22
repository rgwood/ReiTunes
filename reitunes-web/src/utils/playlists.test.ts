import { describe, expect, it } from 'vitest';
import { matchesSmartPlaylist, moveTracksBefore, playlistItems } from './playlists';
import type { LibraryItem, SmartPlaylistRules } from '../types';

const now = Date.parse('2026-09-22T12:00:00Z');
const item: LibraryItem = { id: 'a', name: 'A', artist: 'Artist', album: '', file_path: '', url: '', track_number: null,
  created_time_utc: '2026-09-01T12:00:00', play_count: 0, is_favorite: true, bookmarks: {} };
const rules: SmartPlaylistRules = { added_within_days: 30, play_state: 'unplayed', favourites_only: true };

describe('Smart Playlists', () => {
  it('combines rules and updates membership as metadata and time change', () => {
    expect(matchesSmartPlaylist(item, rules, now)).toBe(true);
    expect(matchesSmartPlaylist({ ...item, play_count: 1 }, rules, now)).toBe(false);
    expect(matchesSmartPlaylist({ ...item, is_favorite: false }, rules, now)).toBe(false);
    expect(matchesSmartPlaylist(item, rules, now + 31 * 86400000)).toBe(false);
    expect(matchesSmartPlaylist(item, { ...rules, added_within_days: null }, now + 31 * 86400000)).toBe(true);
  });
  it('accepts UTC and offset timestamps and includes the cutoff boundary', () => {
    const cutoff = now - 30 * 86400000;
    expect(matchesSmartPlaylist({ ...item, created_time_utc: new Date(cutoff).toISOString() }, rules, now)).toBe(true);
    expect(matchesSmartPlaylist({ ...item, created_time_utc: '2026-09-01T05:00:00-07:00' }, rules, now)).toBe(true);
    expect(matchesSmartPlaylist({ ...item, created_time_utc: 'bad date' }, rules, now)).toBe(false);
  });
  it('uses rules rather than saved membership for smart playlists', () => {
    expect(playlistItems({ id: 'p', name: 'Fresh', items: {}, smart_rules: rules }, [item], now)).toEqual([item]);
    expect(playlistItems({ id: 'p', name: 'Manual', items: { a: { library_item_id: 'missing', position: 0 } } }, [item], now)).toEqual([]);
  });
});

it('moves a selected block in playlist order without losing or duplicating tracks', () => {
  expect(moveTracksBefore(['a', 'b', 'c', 'd'], ['d', 'b'], 'a')).toEqual(['b', 'd', 'a', 'c']);
  expect(moveTracksBefore(['a', 'b', 'c'], ['a', 'b'], 'b')).toEqual(['a', 'b', 'c']);
  expect(moveTracksBefore(['a', 'b'], ['unknown'], 'a')).toEqual(['a', 'b']);
  expect(moveTracksBefore(['a', 'b', 'c'], ['a'], null)).toEqual(['b', 'c', 'a']);
});
