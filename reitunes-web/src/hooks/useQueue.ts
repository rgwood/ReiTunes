import { create } from 'zustand';
import type { LibraryItem } from '../types';

type RepeatMode = 'off' | 'one' | 'all';

interface QueueState {
  // Manual queue (priority) - items added via "Add to Queue" / "Play Next"
  manualQueue: LibraryItem[];

  // Context (playing from) - the list you started playing from
  contextItems: LibraryItem[];
  contextIndex: number;
  contextName: string; // "Library" or playlist name

  // Shuffle and repeat
  shuffleEnabled: boolean;
  repeatMode: RepeatMode;

  // Actions
  addToQueue: (item: LibraryItem) => void;      // append to manual queue
  addNext: (item: LibraryItem) => void;         // prepend to manual queue
  removeFromManualQueue: (index: number) => void;
  moveManualQueueItem: (fromIndex: number, toIndex: number) => void;
  setContext: (items: LibraryItem[], startIndex: number, name: string) => void;
  playNext: () => LibraryItem | null;           // returns next item (manual first, then context)
  playPrevious: () => LibraryItem | null;
  clearManualQueue: () => void;
  getCurrentItem: () => LibraryItem | null;
  toggleShuffle: () => void;
  cycleRepeatMode: () => void;  // off → all → one → off

  // For getting preview of upcoming items
  getUpcomingManualQueue: () => LibraryItem[];
  getUpcomingContext: () => LibraryItem[];
}

export const useQueueStore = create<QueueState>()((set, get) => ({
  manualQueue: [],
  contextItems: [],
  contextIndex: -1,
  contextName: 'Library',
  shuffleEnabled: false,
  repeatMode: 'off' as RepeatMode,

  addToQueue: (item) => set((state) => ({
    manualQueue: [...state.manualQueue, item],
  })),

  addNext: (item) => set((state) => ({
    manualQueue: [item, ...state.manualQueue],
  })),

  removeFromManualQueue: (index) => set((state) => {
    const newQueue = [...state.manualQueue];
    newQueue.splice(index, 1);
    return { manualQueue: newQueue };
  }),

  moveManualQueueItem: (fromIndex, toIndex) => set((state) => {
    const newQueue = [...state.manualQueue];
    const [item] = newQueue.splice(fromIndex, 1);
    newQueue.splice(toIndex, 0, item);
    return { manualQueue: newQueue };
  }),

  setContext: (items, startIndex, name) => set({
    contextItems: items,
    contextIndex: startIndex,
    contextName: name,
    // Clear manual queue when setting new context (clicking a new song)
    manualQueue: [],
  }),

  playNext: () => {
    const state = get();

    // If repeat one, return current item (caller handles replay)
    if (state.repeatMode === 'one') {
      return state.getCurrentItem();
    }

    // First priority: manual queue
    if (state.manualQueue.length > 0) {
      const [nextItem, ...rest] = state.manualQueue;
      set({ manualQueue: rest });
      return nextItem;
    }

    // Second priority: context
    if (state.shuffleEnabled) {
      // Pick random from remaining context items (excluding current)
      const remainingIndices: number[] = [];
      for (let i = 0; i < state.contextItems.length; i++) {
        if (i !== state.contextIndex) {
          remainingIndices.push(i);
        }
      }
      if (remainingIndices.length > 0) {
        const randomIdx = remainingIndices[Math.floor(Math.random() * remainingIndices.length)];
        set({ contextIndex: randomIdx });
        return state.contextItems[randomIdx];
      }
      return null;
    }

    // Normal sequential play
    if (state.contextIndex < state.contextItems.length - 1) {
      const nextIndex = state.contextIndex + 1;
      set({ contextIndex: nextIndex });
      return state.contextItems[nextIndex];
    }

    // At end of context - check repeat all
    if (state.repeatMode === 'all' && state.contextItems.length > 0) {
      set({ contextIndex: 0 });
      return state.contextItems[0];
    }

    return null;
  },

  playPrevious: () => {
    const state = get();
    // For now, just go back in context
    // Manual queue items that were played are already removed, so we can't go back to them
    if (state.contextIndex > 0) {
      const prevIndex = state.contextIndex - 1;
      set({ contextIndex: prevIndex });
      return state.contextItems[prevIndex];
    }
    return null;
  },

  clearManualQueue: () => set({ manualQueue: [] }),

  getCurrentItem: () => {
    const state = get();
    if (state.contextIndex >= 0 && state.contextIndex < state.contextItems.length) {
      return state.contextItems[state.contextIndex];
    }
    return null;
  },

  toggleShuffle: () => set((state) => ({ shuffleEnabled: !state.shuffleEnabled })),

  cycleRepeatMode: () => set((state) => {
    const modes: RepeatMode[] = ['off', 'all', 'one'];
    const currentIdx = modes.indexOf(state.repeatMode);
    const nextIdx = (currentIdx + 1) % modes.length;
    return { repeatMode: modes[nextIdx] };
  }),

  getUpcomingManualQueue: () => {
    return get().manualQueue;
  },

  getUpcomingContext: () => {
    const state = get();
    if (state.contextIndex < 0 || state.contextItems.length === 0) {
      return [];
    }

    // Items after current position
    const remaining = state.contextItems.slice(state.contextIndex + 1);

    // If repeat all and at/near end, wrap around to show beginning items
    if (state.repeatMode === 'all') {
      const itemsFromStart = state.contextItems.slice(0, state.contextIndex);
      return [...remaining, ...itemsFromStart];
    }

    return remaining;
  },
}));
