import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import type { LibraryItem } from '../types';
import { applyLibraryUpdate } from './useLibrary';

const track: LibraryItem = {
  id: 'one', name: 'Night drive', artist: 'Four Tet', album: 'Rounds',
  file_path: 'one.mp3', url: '/music/one.mp3', created_time_utc: '2026-09-01T00:00:00',
  track_number: null, play_count: 0, bookmarks: {},
};

function clientWithTrack() {
  const client = new QueryClient();
  client.setQueryData(['library'], [track]);
  client.setQueryData(['tags'], { enabled: true, items: {} });
  return client;
}

describe('library updates and cached tags', () => {
  it.each(['name', 'artist', 'album', 'file_path'] as const)('refreshes tags when %s changes', field => {
    const client = clientWithTrack();
    const changed = { ...track, [field]: 'Corrected metadata' };
    applyLibraryUpdate(client, { type: 'update', item: changed });
    expect(client.getQueryData(['library'])).toEqual([changed]);
    expect(client.getQueryState(['tags'])?.isInvalidated).toBe(true);
    client.clear();
  });

  it('refreshes tags when a track arrives or is deleted', () => {
    const client = clientWithTrack();
    const imported = { ...track, id: 'two' };
    applyLibraryUpdate(client, { type: 'update', item: imported });
    expect(client.getQueryData(['library'])).toEqual([track, imported]);
    expect(client.getQueryState(['tags'])?.isInvalidated).toBe(true);
    client.setQueryData(['tags'], { enabled: true, items: {} });
    applyLibraryUpdate(client, { type: 'delete', id: track.id });
    expect(client.getQueryData(['library'])).toEqual([imported]);
    expect(client.getQueryState(['tags'])?.isInvalidated).toBe(true);
    client.clear();
  });

  it('keeps tags fresh for listening, favourites, bookmarks and track numbers', () => {
    const client = clientWithTrack();
    const changed = {
      ...track, play_count: 1, is_favorite: true, track_number: 3,
      bookmarks: { moment: { position: 12, emoji: '🎹', label: 'Piano', created_time_utc: '' } },
    };
    applyLibraryUpdate(client, { type: 'update', item: changed });
    expect(client.getQueryData(['library'])).toEqual([changed]);
    expect(client.getQueryState(['tags'])?.isInvalidated).toBe(false);
    client.clear();
  });
});
