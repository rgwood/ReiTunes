import { beforeEach, describe, expect, it } from 'vitest';
import type { LibraryItem } from '../types';
import type { SharedPlaybackState } from './sharedSessionStore';

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
const { useSharedSessionStore } = await import('./sharedSessionStore');
const { sharedUpcomingItemIds, rebaseSonosSelection } = await import('../hooks/useSharedPlaybackSession');

function sonosState(): SharedPlaybackState {
  return { target: { kind: 'sonos', householdId: 'home', groupId: 'living-room', groupName: 'Living room', playerNames: [] },
    currentItemId: 'one', position: 100, playbackRange: null,
    queue: { contextId: 'plan', contextItemIds: ['one', 'two', 'three'], contextIndex: 0, contextName: 'Library',
      manualQueue: [], shuffleEnabled: false, shuffledIds: [], repeatMode: 'off' } };
}

describe('Sonos selection conflicts', () => {
  it('keeps an explicit selection when the old automatic queue advances, including shuffle and repeat', () => {
    for (const mode of ['ordinary', 'shuffle', 'repeat']) {
      const base = sonosState();
      if (mode === 'shuffle') { base.queue.shuffleEnabled = true; base.queue.shuffledIds = ['one', 'three', 'two']; }
      if (mode === 'repeat') { base.queue.repeatMode = 'all'; base.currentItemId = 'three'; base.queue.contextIndex = 2; }
      const selection = { ...structuredClone(base), currentItemId: 'chosen', position: 0 };
      selection.queue.contextId = 'new-plan';
      selection.queue.contextItemIds = ['chosen', 'next'];
      selection.queue.contextIndex = 0;
      const latest = structuredClone(base);
      latest.currentItemId = mode === 'ordinary' ? 'two' : mode === 'shuffle' ? 'three' : 'one';
      latest.queue.contextIndex = base.queue.contextItemIds.indexOf(latest.currentItemId);
      latest.position = 0;
      expect(rebaseSonosSelection(base, selection, latest)).toEqual(selection);
    }
  });

  it('removes consumed queue occurrences without removing another copy of the same song', () => {
    const base = sonosState();
    base.queue.manualQueue = [{ id: 'copy-a', itemId: 'two' }, { id: 'copy-b', itemId: 'two' }];
    const selection = { ...structuredClone(base), currentItemId: 'chosen', position: 0 };
    const latest = structuredClone(base);
    latest.queue.manualQueue.shift(); latest.currentItemId = 'two';
    const rebased = rebaseSonosSelection(base, selection, latest);
    expect(rebased?.currentItemId).toBe('chosen');
    expect(rebased?.queue.manualQueue).toEqual([{ id: 'copy-b', itemId: 'two' }]);
    expect(selection.queue.manualQueue).toHaveLength(2);
    expect(base.queue.manualQueue).toHaveLength(2);
  });

  it('rejects unrelated queue, selection, range and output changes', () => {
    const base = sonosState();
    const selection = { ...structuredClone(base), currentItemId: 'chosen', position: 0 };
    const changes: Array<(latest: SharedPlaybackState) => void> = [
      state => { state.queue.manualQueue.push({ id: 'added', itemId: 'two' }); },
      state => { state.queue.contextId = 'another-selection'; },
      state => { state.queue.contextItemIds.reverse(); },
      state => { state.queue.shuffleEnabled = true; },
      state => { state.queue.repeatMode = 'all'; },
      state => { state.currentItemId = 'outside-plan'; },
      state => { state.playbackRange = { start: 1, end: 10 }; },
      state => { state.target = { kind: 'browser', ownerId: 'other' }; },
      state => { state.target = { ...base.target, groupId: 'other' } as SharedPlaybackState['target']; },
    ];
    for (const change of changes) {
      const latest = structuredClone(base); change(latest);
      expect(rebaseSonosSelection(base, selection, latest)).toBeNull();
    }
    const browser = { ...base, target: { kind: 'browser' as const, ownerId: 'owner' } };
    expect(rebaseSonosSelection(browser, selection, browser)).toBeNull();
  });
});

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
      manualQueueIds: [],
      contextItems: [],
      contextIndex: -1,
      contextName: 'Library',
      contextId: null,
      queueUndo: null,
      shuffleEnabled: false,
      shuffledIds: [],
      repeatMode: 'off',
    });
    useSharedSessionStore.setState({ enabled: false });
    usePlaybackTargetStore.setState({ isSending: false, isSwitchingOutput: false, isTransportPending: false });
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

  it('removes only the requested queued occurrence and Undo keeps later additions and playback', () => {
    const queue = useQueueStore.getState();
    queue.setContext([item('current'), item('duplicate'), item('last')], 0, 'Housewarming');
    for (const id of ['first', 'duplicate', 'duplicate', 'last']) queue.addToQueue(item(id));
    const before = useQueueStore.getState();
    const occurrence = before.manualQueueIds[1];
    queue.removeQueuedOccurrence(occurrence);
    queue.addNext(item('new-first'));
    queue.addToQueue(item('new-last'));
    usePlayerStore.getState().play(item('playing'), 75);
    queue.undoQueueEdit();
    const after = useQueueStore.getState();
    expect(after.manualQueue.map(item => item.id)).toEqual(['new-first', 'first', 'duplicate', 'duplicate', 'last', 'new-last']);
    expect(after.manualQueueIds[2]).toBe(occurrence);
    expect(after.manualQueueIds[3]).toBe(before.manualQueueIds[2]);
    expect(after.contextItems).toBe(before.contextItems);
    expect(usePlayerStore.getState().currentItemId).toBe('playing');
    expect(usePlayerStore.getState().resumePosition).toBe(75);
  });

  it('ignores a stale manual remove and does not restore already-restored occurrences twice', () => {
    const queue = useQueueStore.getState();
    queue.addToQueue(item('one'));
    const occurrence = useQueueStore.getState().manualQueueIds[0];
    queue.removeQueuedOccurrence('not-an-occurrence');
    expect(queue.getUpcomingManualQueue()).toHaveLength(1);
    queue.removeQueuedOccurrence(occurrence);
    useQueueStore.setState({ manualQueue: [item('one')], manualQueueIds: [occurrence] });
    expect(queue.canUndoQueueEdit()).toBe(false);
    queue.undoQueueEdit();
    expect(queue.getUpcomingManualQueue()).toHaveLength(1);
  });

  it('restores a removed manual occurrence even after its neighbors were consumed', () => {
    const queue = useQueueStore.getState();
    for (const id of ['first', 'removed', 'last']) queue.addToQueue(item(id));
    queue.removeQueuedOccurrence(useQueueStore.getState().manualQueueIds[1]);
    expect(queue.playNext()?.id).toBe('first');
    expect(queue.playNext()?.id).toBe('last');
    queue.undoQueueEdit();
    expect(queue.getUpcomingManualQueue().map(item => item.id)).toEqual(['removed']);
  });

  it('keeps automatic removal through shuffle, repeat, reload, and library reconciliation', async () => {
    const queue = useQueueStore.getState();
    const tracks = ['current', 'removed', 'next'].map(id => item(id));
    queue.setContext(tracks, 0, 'Housewarming');
    queue.addToQueue(tracks[1]);
    queue.removeUpcomingContext('removed');
    queue.toggleShuffle();
    queue.cycleRepeatMode();
    await useQueueStore.persist.rehydrate();
    queue.reconcileWithLibrary(tracks);
    expect(queue.getUpcomingContext().map(item => item.id)).toEqual(['next']);
    expect(queue.getUpcomingManualQueue().map(item => item.id)).toEqual(['removed']);
    expect(useQueueStore.getState().shuffledIds).not.toContain('removed');
    queue.toggleShuffle();
    expect(queue.getUpcomingContext().map(item => item.id)).toEqual(['next']);
    queue.setContext(tracks, 0, 'Housewarming');
    expect(queue.getUpcomingContext().map(item => item.id)).toEqual(['removed', 'next']);
  });

  it('removes an automatic repeat-all item before the cursor without changing the cursor', () => {
    const queue = useQueueStore.getState();
    queue.setContext(['earlier', 'current', 'next'].map(id => item(id)), 1, 'Housewarming');
    queue.cycleRepeatMode();
    queue.removeUpcomingContext('earlier');
    expect(queue.getCurrentItem()?.id).toBe('current');
    expect(useQueueStore.getState().contextIndex).toBe(0);
    queue.undoQueueEdit();
    expect(queue.getCurrentItem()?.id).toBe('current');
    expect(useQueueStore.getState().contextIndex).toBe(1);
    expect(queue.getUpcomingContext().map(item => item.id)).toEqual(['next', 'earlier']);
  });

  it('Undo restores just an automatic track while keeping newer manual entries and shuffle settings', () => {
    const queue = useQueueStore.getState();
    queue.setContext(['current', 'removed', 'next'].map(id => item(id)), 0, 'Housewarming');
    queue.removeUpcomingContext('removed');
    queue.addToQueue(item('manual'));
    queue.toggleShuffle();
    queue.cycleRepeatMode();
    queue.undoQueueEdit();
    expect(queue.getUpcomingContext().map(item => item.id)).toEqual(['removed', 'next']);
    expect(queue.getUpcomingManualQueue().map(item => item.id)).toEqual(['manual']);
    expect(useQueueStore.getState().shuffleEnabled).toBe(true);
    expect(useQueueStore.getState().repeatMode).toBe('all');
  });

  it('rejects stale automatic removal after advancement, but can remove a future copy of a playing manual track', () => {
    const queue = useQueueStore.getState();
    queue.setContext(['current', 'next', 'last'].map(id => item(id)), 0, 'Housewarming');
    usePlayerStore.getState().play(item('next'));
    queue.removeUpcomingContext('next');
    expect(queue.getUpcomingContext().map(item => item.id)).toEqual(['last']);
    expect(usePlayerStore.getState().currentItemId).toBe('next');
    queue.undoQueueEdit();
    queue.chooseContextItem('next');
    queue.removeUpcomingContext('next');
    expect(queue.getCurrentItem()?.id).toBe('next');
    expect(useQueueStore.getState().contextItems.map(item => item.id)).toEqual(['current', 'next', 'last']);
  });

  it('replaces only automatic playback with a snapshot, keeping current playback and manual occurrence IDs', () => {
    const queue = useQueueStore.getState();
    queue.setContext(['current', 'old-next'].map(id => item(id)), 0, 'Old');
    queue.addToQueue(item('first'));
    queue.addToQueue(item('second'));
    usePlayerStore.getState().play(item('current'), 42);
    const before = useQueueStore.getState();
    const incoming = ['current', 'second', 'third', 'second'].map(id => item(id));
    queue.replaceUpcomingContext(incoming, 'Search: foobar');
    incoming.reverse();
    const after = useQueueStore.getState();
    expect(after.manualQueue).toBe(before.manualQueue);
    expect(after.manualQueueIds).toBe(before.manualQueueIds);
    expect(after.contextId).not.toBe(before.contextId);
    expect(after.contextIndex).toBe(-1);
    expect(after.getUpcomingContext().map(item => item.id)).toEqual(['second', 'third']);
    expect(usePlayerStore.getState().currentItemId).toBe('current');
    expect(usePlayerStore.getState().resumePosition).toBe(42);
    expect(queue.playNext()?.id).toBe('first');
    expect(queue.playNext()?.id).toBe('second');
    expect(useQueueStore.getState().contextIndex).toBe(-1);
    expect(queue.playNext()?.id).toBe('second');
    expect(queue.playNext()?.id).toBe('third');
  });

  it('projects an unstarted shuffled replacement exactly once even with repeat-all', () => {
    const queue = useQueueStore.getState();
    queue.toggleShuffle();
    queue.cycleRepeatMode();
    queue.replaceUpcomingContext(['a', 'b', 'c'].map(id => item(id)), 'Favourites');
    queue.addToQueue(item('manual'));
    const state = useQueueStore.getState();
    const expected = state.shuffledIds;
    expect(expected).toHaveLength(3);
    expect(state.getUpcomingContext().map(item => item.id)).toEqual(expected);
    expect(sharedUpcomingItemIds({ target: { kind: 'browser' }, currentItemId: 'old', position: 10, playbackRange: null,
      queue: { manualQueue: [{ id: 'manual-occurrence', itemId: 'manual' }], contextItemIds: state.contextItems.map(item => item.id),
        contextIndex: -1, contextName: state.contextName, contextId: state.contextId,
        shuffleEnabled: true, shuffledIds: expected, repeatMode: 'all' },
    })).toEqual(['manual', ...expected]);
    expect(queue.playNext()?.id).toBe('manual');
    for (const id of expected) expect(queue.playNext()?.id).toBe(id);
    expect(queue.playNext()?.id).toBe(expected[0]);
  });

  it('Undo replacement restores only the prior automatic plan and keeps newer manual playback and settings', () => {
    const queue = useQueueStore.getState();
    queue.setContext(['current', 'old-next'].map(id => item(id)), 0, 'Old');
    const originalId = useQueueStore.getState().contextId;
    queue.replaceUpcomingContext(['new-one', 'new-two'].map(id => item(id)), 'New');
    queue.addNext(item('manual'));
    const addedId = useQueueStore.getState().manualQueueIds[0];
    queue.toggleShuffle();
    queue.cycleRepeatMode();
    usePlayerStore.getState().play(item('another-manual'), 99);
    queue.undoQueueEdit();
    const after = useQueueStore.getState();
    expect(after.contextId).toBe(originalId);
    expect(after.contextName).toBe('Old');
    expect(after.getUpcomingContext().map(item => item.id)).toEqual(['old-next']);
    expect(after.manualQueueIds).toEqual([addedId]);
    expect(after.shuffleEnabled).toBe(true);
    expect(after.repeatMode).toBe('all');
    expect(usePlayerStore.getState().currentItemId).toBe('another-manual');
    expect(usePlayerStore.getState().resumePosition).toBe(99);
  });

  it('invalidates automatic Undo after source advancement and fresh contexts', () => {
    const queue = useQueueStore.getState();
    queue.replaceUpcomingContext(['new-one', 'new-two'].map(id => item(id)), 'New');
    expect(queue.canUndoQueueEdit()).toBe(true);
    queue.playNext();
    expect(queue.canUndoQueueEdit()).toBe(false);
    queue.undoQueueEdit();
    expect(queue.getCurrentItem()?.id).toBe('new-one');
    queue.removeUpcomingContext('new-two');
    queue.setContext([item('newer')], 0, 'Newer');
    expect(queue.canUndoQueueEdit()).toBe(false);
    queue.undoQueueEdit();
    expect(useQueueStore.getState().contextName).toBe('Newer');
  });

  it('invalidates stale replacement Undo when its source ID changes even if the cursor is still unstarted', () => {
    const queue = useQueueStore.getState();
    queue.replaceUpcomingContext([item('one')], 'First');
    useQueueStore.setState({ contextId: 'new-remote-context', contextItems: [item('remote')] });
    expect(queue.canUndoQueueEdit()).toBe(false);
    queue.undoQueueEdit();
    expect(queue.getUpcomingContext().map(item => item.id)).toEqual(['remote']);
  });

  it('repeats the actual playing item after replacement or manual selection', () => {
    const queue = useQueueStore.getState();
    queue.setContext([item('automatic'), item('later')], 0, 'Old');
    usePlayerStore.getState().play(item('manual'));
    queue.replaceUpcomingContext([item('new')], 'New');
    queue.cycleRepeatMode();
    queue.cycleRepeatMode();
    expect(queue.playNext()?.id).toBe('manual');
    expect(useQueueStore.getState().contextIndex).toBe(-1);
  });

  it('blocks queue edits while disconnected or a playback command is pending', () => {
    const queue = useQueueStore.getState();
    queue.setContext(['one', 'two'].map(id => item(id)), 0, 'Old');
    queue.addToQueue(item('manual'));
    const occurrence = useQueueStore.getState().manualQueueIds[0];
    queue.removeUpcomingContext('two');
    const before = useQueueStore.getState();
    for (const mode of ['disconnected', 'sending']) {
      useSharedSessionStore.setState({ enabled: mode === 'disconnected', ready: true, connected: false });
      usePlaybackTargetStore.setState({ isSending: mode === 'sending' });
      queue.removeQueuedOccurrence(occurrence);
      queue.replaceUpcomingContext([item('other')], 'Blocked');
      queue.undoQueueEdit();
      expect(queue.canUndoQueueEdit()).toBe(false);
      expect(useQueueStore.getState().manualQueue).toBe(before.manualQueue);
      expect(useQueueStore.getState().contextItems).toBe(before.contextItems);
    }
  });

  it('persists source identity and bounds source labels without splitting Unicode', async () => {
    const queue = useQueueStore.getState();
    queue.replaceUpcomingContext([item('one')], '🎹'.repeat(400));
    const state = useQueueStore.getState();
    expect(state.contextName).toBe('🎹'.repeat(250));
    const saved = JSON.parse(storage.getItem(QUEUE_STORAGE_KEY)!);
    expect(saved.state.contextId).toBe(state.contextId);
    expect(saved.state.queueUndo).toBeUndefined();
    await useQueueStore.persist.rehydrate();
    expect(useQueueStore.getState().contextId).toBe(state.contextId);
    expect(useQueueStore.getState().queueUndo).toBeNull();
    expect(queue.getUpcomingContext().map(item => item.id)).toEqual(['one']);
  });
});
