import { beforeEach, describe, expect, it } from 'vitest';
import type { LibraryItem } from '../types';

const storedValues = new Map<string, string>();
const storage: Storage = {
  get length() {
    return storedValues.size;
  },
  clear: () => storedValues.clear(),
  getItem: (key) => storedValues.get(key) ?? null,
  key: (index) => [...storedValues.keys()][index] ?? null,
  removeItem: (key) => storedValues.delete(key),
  setItem: (key, value) => storedValues.set(key, value),
};

Object.defineProperty(globalThis, 'localStorage', { value: storage });

const { PLAYER_STORAGE_KEY, usePlayerStore } = await import('./playerStore');
const { QUEUE_STORAGE_KEY, reconcileLibraryItems, useQueueStore } = await import('../hooks/useQueue');
const { sonosQueueFor } = await import('../hooks/usePlayback');

function item(id: string, name = id): LibraryItem {
  return {
    id,
    name,
    created_time_utc: '2026-08-08T00:00:00',
    file_path: `${id}.mp3`,
    artist: '',
    album: '',
    track_number: null,
    play_count: 0,
    bookmarks: {},
    url: `https://example.com/${id}.mp3`,
  };
}

describe('playback persistence', () => {
  beforeEach(() => {
    storage.clear();
    usePlayerStore.setState({
      currentItem: null,
      currentItemId: null,
      isPlaying: false,
      pendingSeek: null,
      resumePosition: 0,
      volume: 1,
      isMuted: false,
    });
    useQueueStore.setState({
      manualQueue: [],
      contextItems: [],
      contextIndex: -1,
      contextName: 'Library',
      shuffleEnabled: false,
      repeatMode: 'off',
    });
    storage.clear();
  });

  it('stores only the durable player fields', () => {
    usePlayerStore.getState().play(item('one'), 42);
    usePlayerStore.getState().setVolume(0.4);
    usePlayerStore.getState().setMuted(true);

    const saved = JSON.parse(storage.getItem(PLAYER_STORAGE_KEY) ?? '{}');
    expect(saved.state).toEqual({
      currentItemId: 'one',
      resumePosition: 42,
      volume: 0.4,
      isMuted: true,
    });
    expect(saved.state.currentItem).toBeUndefined();
    expect(saved.state.isPlaying).toBeUndefined();
  });

  it('restores a saved track paused at its previous position', () => {
    usePlayerStore.setState({ currentItemId: 'one', resumePosition: 91 });
    usePlayerStore.getState().restoreCurrentItem(item('one', 'Fresh metadata'));

    const state = usePlayerStore.getState();
    expect(state.currentItem?.name).toBe('Fresh metadata');
    expect(state.pendingSeek).toBe(91);
    expect(state.isPlaying).toBe(false);
  });

  it('reconciles saved queue entries with current library data', () => {
    const saved = [item('one', 'Old name'), item('deleted')];
    const current = [item('one', 'New name'), item('two')];

    expect(reconcileLibraryItems(saved, current)).toEqual([current[0]]);
  });

  it('keeps the context index attached to the same track after reconciliation', () => {
    useQueueStore.setState({
      contextItems: [item('deleted'), item('current', 'Old name'), item('next')],
      contextIndex: 1,
      manualQueue: [item('deleted'), item('next', 'Old next')],
    });

    const library = [item('current', 'New name'), item('next', 'New next')];
    useQueueStore.getState().reconcileWithLibrary(library);

    const state = useQueueStore.getState();
    expect(state.contextItems).toEqual(library);
    expect(state.contextIndex).toBe(0);
    expect(state.manualQueue).toEqual([library[1]]);
  });

  it('persists queue order and playback settings', () => {
    useQueueStore.getState().setContext([item('one'), item('two')], 0, 'Favourites');
    useQueueStore.getState().addToQueue(item('three'));
    useQueueStore.getState().toggleShuffle();

    const saved = JSON.parse(storage.getItem(QUEUE_STORAGE_KEY) ?? '{}');
    expect(saved.state.contextItems.map((entry: LibraryItem) => entry.id)).toEqual(['one', 'two']);
    expect(saved.state.manualQueue.map((entry: LibraryItem) => entry.id)).toEqual(['three']);
    expect(saved.state.contextName).toBe('Favourites');
    expect(saved.state.shuffleEnabled).toBe(true);
  });

  it('keeps earlier context in Sonos queues without changing Play Next order', () => {
    const previous = item('previous');
    const current = item('current');
    const next = item('next');
    const manuallyQueued = item('manual');
    useQueueStore.getState().setContext([previous, current, next], 1, 'Library');
    useQueueStore.getState().addNext(manuallyQueued);

    expect(sonosQueueFor(current).map((entry) => entry.id)).toEqual([
      'previous',
      'current',
      'manual',
      'next',
    ]);
  });

  it('bounds Sonos history while retaining the selected song and queue limit', () => {
    const context = Array.from({ length: 700 }, (_, index) => item(`track-${index}`));
    useQueueStore.getState().setContext(context, 150, 'Library');

    const sonosQueue = sonosQueueFor(context[150]);
    expect(sonosQueue).toHaveLength(500);
    expect(sonosQueue[0].id).toBe('track-50');
    expect(sonosQueue[100].id).toBe('track-150');
    expect(sonosQueue.at(-1)?.id).toBe('track-549');
  });
});
