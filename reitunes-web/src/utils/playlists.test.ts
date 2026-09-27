import { describe, expect, it } from 'vitest';
import { matchesSmartPlaylist, moveTracksBefore, playlistItems, ruleExpression } from './playlists';
import type { LibraryItem, SmartPlaylistRules, SmartRule } from '../types';
import type { ItemTags } from '../hooks/useTags';

const now = Date.parse('2026-09-22T12:00:00Z');
const item: LibraryItem = { id: 'a', name: 'A', artist: 'Artist', album: '', file_path: '', url: '', track_number: null,
  created_time_utc: '2026-09-01T12:00:00', play_count: 0, is_favorite: true, bookmarks: {} };
const rules: SmartPlaylistRules = { added_within_days: 30, play_state: 'unplayed', favourites_only: true };

describe('Smart Playlists', () => {
  it('matches exact normalized tags, respecting manual overrides and unfinished tagging', () => {
    const tagItems: Record<string, ItemTags> = { a: { status: 'ready', tags: ['folk', 'indie-rock', 'house', 'ambient'].map(tag => ({ tag, basis: 'database', confidence: .8, evidence: 'MusicBrainz', sourceUrls: [] })),
      labels: { house: { tag: 'house', verdict: 'rejected', reason: '' }, ambient: { tag: 'ambient', verdict: 'uncertain', reason: '' }, piano: { tag: 'piano', verdict: 'accepted', reason: '' } } } };
    const match = (expression: SmartRule, data = tagItems) => matchesSmartPlaylist(item, { ...rules, expression }, now, data);
    expect(match({ type: 'tag', value: ' Indie Rock ', present: true })).toBe(true);
    expect(match({ type: 'tag', value: 'rock', present: true })).toBe(false);
    expect(match({ type: 'tag', value: 'house', present: false })).toBe(true);
    expect(match({ type: 'tag', value: 'ambient', present: true })).toBe(false);
    expect(match({ type: 'all', rules: [{ type: 'tag', value: 'house', present: false }, { type: 'any', rules: [{ type: 'tag', value: 'jazz', present: true }, { type: 'tag', value: 'piano', present: true }] }] })).toBe(true);
    for (const status of ['queued', 'running', 'stale', 'failed']) {
      tagItems.a.status = status;
      expect(match({ type: 'tag', value: 'folk', present: true })).toBe(false);
      expect(match({ type: 'tag', value: 'piano', present: true })).toBe(true);
      expect(match({ type: 'has_tags', value: true })).toBe(true);
    }
    expect(match({ type: 'has_tags', value: false }, {})).toBe(true);
    expect(match({ type: 'tag', value: 'folk', present: false }, {})).toBe(true);
    expect(match({ type: 'tag', value: ' ', present: false })).toBe(false);
    // Not fetched yet is different from a fetched snapshot with no tags.
    expect(matchesSmartPlaylist(item, { ...rules, expression: { type: 'has_tags', value: false } }, now)).toBe(false);
    expect(matchesSmartPlaylist(item, { ...rules, expression: { type: 'tag', value: 'folk', present: false } }, now)).toBe(false);
  });
  it('combines duration and nested OR conditions, excluding unknown lengths', () => {
    const nested: SmartPlaylistRules = { ...rules, expression: { type: 'all', rules: [
      { type: 'duration', comparison: 'lt', seconds: 600 },
      { type: 'any', rules: [{ type: 'text', field: 'artist', comparison: 'contains', value: 'beck' }, { type: 'favourite', value: true }] },
    ] } };
    expect(matchesSmartPlaylist({ ...item, duration_seconds: 300 }, nested, now)).toBe(true);
    expect(matchesSmartPlaylist({ ...item, duration_seconds: 600 }, nested, now)).toBe(false);
    expect(matchesSmartPlaylist(item, nested, now)).toBe(false);
    expect(matchesSmartPlaylist({ ...item, duration_seconds: 300, is_favorite: false, artist: 'Beck' }, nested, now)).toBe(true);
    expect(matchesSmartPlaylist({ ...item, duration_seconds: 300, is_favorite: false }, nested, now)).toBe(false);
  });
  it('converts existing smart rules without changing their membership', () => {
    for (const old of [rules, { ...rules, bookmark_state: 'without' as const }, { ...rules, play_state: 'played' as const }]) {
      for (const track of [item, { ...item, play_count: 2 }, { ...item, is_favorite: false }]) {
        expect(matchesSmartPlaylist(track, { ...old, expression: ruleExpression(old) }, now)).toBe(matchesSmartPlaylist(track, old, now));
      }
    }
  });
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
  it('matches bookmark presence independently or alongside the existing rules', () => {
    const bookmarked: LibraryItem = { ...item, play_count: 5, is_favorite: false,
      bookmarks: { intro: { position: 10, emoji: '🎵', label: null, created_time_utc: item.created_time_utc } } };
    const all: SmartPlaylistRules = { added_within_days: null, play_state: 'any', favourites_only: false };
    expect(matchesSmartPlaylist(bookmarked, { ...all, bookmark_state: 'with' }, now)).toBe(true);
    expect(matchesSmartPlaylist(item, { ...all, bookmark_state: 'with' }, now)).toBe(false);
    expect(matchesSmartPlaylist(bookmarked, { ...all, bookmark_state: 'without' }, now)).toBe(false);
    expect(matchesSmartPlaylist(item, { ...all, bookmark_state: 'without' }, now)).toBe(true);
    expect(matchesSmartPlaylist(bookmarked, { ...rules, bookmark_state: 'with' }, now)).toBe(false);
    expect(matchesSmartPlaylist({ ...item, bookmarks: bookmarked.bookmarks }, { ...rules, bookmark_state: 'with' }, now)).toBe(true);
    expect(matchesSmartPlaylist(item, all, now)).toBe(true); // Rules saved before bookmark filtering.
  });
});

it('moves a selected block in playlist order without losing or duplicating tracks', () => {
  expect(moveTracksBefore(['a', 'b', 'c', 'd'], ['d', 'b'], 'a')).toEqual(['b', 'd', 'a', 'c']);
  expect(moveTracksBefore(['a', 'b', 'c'], ['a', 'b'], 'b')).toEqual(['a', 'b', 'c']);
  expect(moveTracksBefore(['a', 'b'], ['unknown'], 'a')).toEqual(['a', 'b']);
  expect(moveTracksBefore(['a', 'b', 'c'], ['a'], null)).toEqual(['b', 'c', 'a']);
});
