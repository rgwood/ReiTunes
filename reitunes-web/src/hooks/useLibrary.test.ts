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
  client.setQueryData(['discovery'], { sources: [], entries: [], refreshing: false });
  return client;
}

describe('library updates and cached tags', () => {
  it.each(['name', 'artist', 'album', 'file_path', 'play_count'] as const)('leaves tags to the server when %s changes', field => {
    // The server sends the item's new tags itself, instead of us refetching all of them.
    const client = clientWithTrack();
    const changed = { ...track, [field]: field === 'play_count' ? 1 : 'Corrected metadata' };
    applyLibraryUpdate(client, { type: 'update', item: changed });
    expect(client.getQueryData(['library'])).toEqual([changed]);
    expect(client.getQueryState(['tags'])?.isInvalidated).toBe(false);
    expect(client.getQueryState(['discovery'])?.isInvalidated).toBe(false);
    client.clear();
  });

  it('refreshes discovery, which links entries to songs, when a track arrives or is deleted', () => {
    const client = clientWithTrack();
    const imported = { ...track, id: 'two' };
    applyLibraryUpdate(client, { type: 'update', item: imported });
    expect(client.getQueryData(['library'])).toEqual([track, imported]);
    expect(client.getQueryState(['discovery'])?.isInvalidated).toBe(true);
    client.setQueryData(['discovery'], { sources: [], entries: [], refreshing: false });
    applyLibraryUpdate(client, { type: 'delete', id: track.id });
    expect(client.getQueryData(['library'])).toEqual([imported]);
    expect(client.getQueryState(['discovery'])?.isInvalidated).toBe(true);
    expect(client.getQueryState(['tags'])?.isInvalidated).toBe(false);
    client.clear();
  });
});
