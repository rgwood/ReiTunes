import { create } from 'zustand';
import type { PlaybackEntry, PlaybackTarget } from '../types/index.ts';

type RepeatMode = 'off' | 'one' | 'all';

interface PlayerState {
  currentEntry: PlaybackEntry | null;
  // Repeated play requests must work for the same entry and position too.
  playRequest: number;
  manualQueue: PlaybackEntry[];
  contextItems: PlaybackEntry[];
  contextOrder: PlaybackEntry[];
  contextIndex: number;
  contextName: string;
  history: PlaybackEntry[];
  forwardHistory: PlaybackEntry[];
  shuffleEnabled: boolean;
  repeatMode: RepeatMode;
  play: (target: PlaybackTarget) => void;
  playFrom: (targets: PlaybackTarget[], index: number, name: string, shuffle?: boolean) => void;
  next: (reason?: 'skip' | 'ended') => void;
  previous: () => void;
  restart: () => void;
  addToQueue: (target: PlaybackTarget) => void;
  addNext: (target: PlaybackTarget) => void;
  removeFromQueue: (id: string) => void;
  moveQueueEntry: (id: string, beforeId: string) => void;
  clearManualQueue: () => void;
  toggleShuffle: () => void;
  cycleRepeatMode: () => void;
}

let nextEntryId = 0;

function entry(target: PlaybackTarget): PlaybackEntry {
  return { ...target, startPosition: Math.max(0, target.startPosition), id: `queue-${++nextEntryId}` };
}

function shuffled<T>(items: T[]): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function remember(state: PlayerState): PlaybackEntry[] {
  return state.currentEntry ? [...state.history, state.currentEntry].slice(-100) : state.history;
}

export const usePlayerStore = create<PlayerState>((set, get) => ({
  currentEntry: null,
  playRequest: 0,
  manualQueue: [],
  contextItems: [],
  contextOrder: [],
  contextIndex: -1,
  contextName: 'Library',
  history: [],
  forwardHistory: [],
  shuffleEnabled: false,
  repeatMode: 'off',

  // A bookmark jump leaves the existing track queue in place.
  play: target => set(state => ({
    currentEntry: entry(target),
    playRequest: state.playRequest + 1,
    history: remember(state),
    forwardHistory: [],
  })),

  playFrom: (targets, index, name, shuffle = get().shuffleEnabled) => {
    if (!targets[index]) return;
    const items = targets.map(entry);
    const current = items[index];
    set(state => ({
      currentEntry: current,
      playRequest: state.playRequest + 1,
      contextItems: items,
      contextOrder: shuffle ? [current, ...shuffled(items.filter(item => item !== current))] : items,
      contextIndex: shuffle ? 0 : index,
      contextName: name,
      shuffleEnabled: shuffle,
      history: remember(state),
      forwardHistory: [],
      // Choosing something to play preserves deliberate queue additions.
    }));
  },

  next: (reason = 'skip') => {
    const state = get();
    if (reason === 'ended' && state.repeatMode === 'one' && state.currentEntry) {
      state.restart();
      return;
    }
    let currentEntry: PlaybackEntry | undefined;
    let forwardHistory = state.forwardHistory;
    let manualQueue = state.manualQueue;
    let contextOrder = state.contextOrder;
    let contextIndex = state.contextIndex;

    // Retrace actual playback after Previous, including manual queue entries.
    if (forwardHistory.length) {
      [currentEntry, ...forwardHistory] = forwardHistory;
    } else if (manualQueue.length) {
      [currentEntry, ...manualQueue] = manualQueue;
    } else if (contextIndex + 1 < contextOrder.length) {
      currentEntry = contextOrder[++contextIndex];
    } else if (state.repeatMode === 'all' && state.contextItems.length) {
      contextOrder = state.shuffleEnabled ? shuffled(state.contextItems) : state.contextItems;
      if (state.shuffleEnabled && contextOrder.length > 1 && contextOrder[0].id === state.currentEntry?.id) {
        [contextOrder[0], contextOrder[1]] = [contextOrder[1], contextOrder[0]];
      }
      contextIndex = 0;
      currentEntry = contextOrder[0];
    }
    if (!currentEntry) return;
    set({ currentEntry, forwardHistory, manualQueue, contextOrder, contextIndex,
      history: remember(state), playRequest: state.playRequest + 1 });
  },

  previous: () => {
    const state = get();
    const previous = state.history.at(-1);
    if (!previous) {
      state.restart();
      return;
    }
    set({
      currentEntry: previous,
      history: state.history.slice(0, -1),
      forwardHistory: state.currentEntry ? [state.currentEntry, ...state.forwardHistory] : state.forwardHistory,
      playRequest: state.playRequest + 1,
    });
  },

  restart: () => set(state => ({ playRequest: state.playRequest + 1 })),
  addToQueue: target => set(state => ({ manualQueue: [...state.manualQueue, entry(target)] })),
  addNext: target => set(state => ({
    // An explicit Play next takes priority even after the user went back.
    manualQueue: [entry(target), ...state.forwardHistory, ...state.manualQueue],
    forwardHistory: [],
  })),
  removeFromQueue: id => set(state => ({ manualQueue: state.manualQueue.filter(item => item.id !== id) })),
  moveQueueEntry: (id, beforeId) => set(state => {
    const from = state.manualQueue.findIndex(item => item.id === id);
    const to = state.manualQueue.findIndex(item => item.id === beforeId);
    if (from < 0 || to < 0 || from === to) return state;
    const manualQueue = [...state.manualQueue];
    const [item] = manualQueue.splice(from, 1);
    manualQueue.splice(to, 0, item);
    return { manualQueue };
  }),
  clearManualQueue: () => set({ manualQueue: [] }),

  toggleShuffle: () => set(state => {
    const shuffleEnabled = !state.shuffleEnabled;
    const visited = state.contextOrder.slice(0, state.contextIndex + 1);
    const visitedIds = new Set(visited.map(item => item.id));
    const remaining = state.contextItems.filter(item => !visitedIds.has(item.id));
    return { shuffleEnabled, contextOrder: [...visited, ...(shuffleEnabled ? shuffled(remaining) : remaining)] };
  }),
  cycleRepeatMode: () => set(state => ({
    repeatMode: state.repeatMode === 'off' ? 'all' : state.repeatMode === 'all' ? 'one' : 'off',
  })),
}));
