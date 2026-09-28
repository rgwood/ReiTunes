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
const { usePlaybackTargetStore } = await import('./playbackTargetStore');

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
      playbackRange: null,
    });
    useQueueStore.setState({
      manualQueue: [],
      contextItems: [],
      contextIndex: -1,
      contextName: 'Library',
      shuffleEnabled: false,
      shuffledIds: [],
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
      playbackRange: null,
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

  it('preserves deliberate queue additions when jumping to a saved moment', () => {
    const queued = item('queued');
    const mix = item('mix');
    useQueueStore.getState().addToQueue(queued);
    useQueueStore.getState().setContext([mix], 0, 'Saved moments', true);
    expect(useQueueStore.getState().manualQueue).toEqual([queued]);
    expect(useQueueStore.getState().playNext()).toEqual(queued);
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

  it('removes deleted songs from the shuffle order without reshuffling surviving songs', () => {
    const tracks = ['current', 'deleted', 'next', 'last'].map(id => item(id));
    useQueueStore.setState({ contextItems: tracks, contextIndex: 0, shuffleEnabled: true,
      shuffledIds: ['current', 'last', 'deleted', 'next'] });
    useQueueStore.getState().reconcileWithLibrary(tracks.filter(track => track.id !== 'deleted'));
    expect(useQueueStore.getState().shuffledIds).toEqual(['current', 'last', 'next']);
    expect(useQueueStore.getState().getUpcomingContext().map(track => track.id)).toEqual(['last', 'next']);
    useQueueStore.getState().reconcileWithLibrary([]);
    expect(useQueueStore.getState().shuffledIds).toEqual([]);
  });

  it('repairs an old saved shuffle order on reload', async () => {
    useQueueStore.setState({ contextItems: [item('one'), item('two')], contextIndex: 0,
      shuffleEnabled: true, shuffledIds: ['one', 'deleted', 'two', 'two'] });
    await useQueueStore.persist.rehydrate();
    expect(useQueueStore.getState().shuffledIds).toEqual(['one', 'two']);
  });

  it('uses one stable shuffle order for preview, next, previous, and reload without repeats', async () => {
    const tracks = ['a', 'b', 'c', 'd', 'e'].map(id => item(id));
    const queue = useQueueStore.getState();
    queue.setContext(tracks, 2, 'Test');
    queue.toggleShuffle();
    const version = useQueueStore.getState().editVersion;
    const upcoming = queue.getUpcomingContext();
    expect(upcoming).toHaveLength(4);
    expect(new Set(upcoming.map(item => item.id)).size).toBe(4);
    expect(upcoming.some(item => item.id === 'c')).toBe(false);
    await useQueueStore.persist.rehydrate();
    expect(queue.getUpcomingContext()).toEqual(upcoming);
    expect(queue.playNext()).toEqual(upcoming[0]);
    expect(queue.playPrevious()?.id).toBe('c');
    for (const next of upcoming) expect(queue.playNext()).toEqual(next);
    expect(queue.playNext()).toBeNull();
    expect(queue.getUpcomingContext()).toEqual([]);
    queue.toggleShuffle();
    expect(useQueueStore.getState().editVersion).toBe(version + 1);
  });

  it('playing a queued duplicate consumes only that occurrence and keeps other additions', () => {
    const one = item('one'), two = item('two');
    useQueueStore.setState({ manualQueue: [one, two, one], contextItems: [one, two], contextIndex: 0 });
    expect(useQueueStore.getState().takeQueuedItem(2)).toEqual(one);
    expect(useQueueStore.getState().manualQueue).toEqual([one, two]);
    expect(useQueueStore.getState().contextIndex).toBe(0);
    expect(useQueueStore.getState().chooseContextItem('two')).toEqual(two);
    expect(useQueueStore.getState().contextIndex).toBe(1);
    expect(useQueueStore.getState().manualQueue).toEqual([one, two]);
    expect(useQueueStore.getState().takeQueuedItem(99)).toBeNull();
  });

  it('does not replace the queue context when a second song is selected during a pending output command', () => {
    const queue = useQueueStore.getState();
    queue.setContext([item('one'), item('two')], 0, 'Original');
    queue.addToQueue(item('queued'));
    const before = useQueueStore.getState();
    usePlaybackTargetStore.getState().beginSending();
    try {
      queue.setContext([item('other')], 0, 'New selection');
      expect(queue.takeQueuedItem(0)).toBeNull();
      expect(queue.playNext()).toBeNull();
      expect(useQueueStore.getState().contextItems).toBe(before.contextItems);
      expect(useQueueStore.getState().manualQueueIds).toEqual(before.manualQueueIds);
      expect(useQueueStore.getState().manualQueue).toEqual([item('queued')]);
    } finally { usePlaybackTargetStore.getState().finishSending(); }
  });

  it('refreshes active bookmark limits and clears them for ordinary playback', () => {
    const mix = { ...item('mix'), bookmarks: { b: { position: 20, end_position: 40, label: 'Intro', emoji: '🎹', created_time_utc: '' } } };
    usePlayerStore.getState().play(mix, 20, { start: 20, end: 40, bookmarkId: 'b' });
    const changed = { ...mix, bookmarks: { b: { ...mix.bookmarks.b, end_position: 50 } } };
    usePlayerStore.getState().refreshCurrentItem(changed);
    expect(usePlayerStore.getState().playbackRange?.end).toBe(50);
    expect(JSON.parse(storage.getItem(PLAYER_STORAGE_KEY)!).state.playbackRange.end).toBe(50);
    usePlayerStore.getState().play(mix);
    expect(usePlayerStore.getState().playbackRange).toBeNull();
  });
});
