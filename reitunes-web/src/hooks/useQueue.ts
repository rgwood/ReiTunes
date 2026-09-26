import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { LibraryItem } from '../types';

type RepeatMode = 'off' | 'one' | 'all';

export const QUEUE_STORAGE_KEY = 'reitunes-queue';

interface PersistedQueueState {
  manualQueue: LibraryItem[];
  contextItems: LibraryItem[];
  contextIndex: number;
  contextName: string;
  shuffleEnabled: boolean;
  repeatMode: RepeatMode;
}

interface QueueState extends PersistedQueueState {
  editVersion: number;
  addToQueue: (item: LibraryItem) => void;
  addNext: (item: LibraryItem) => void;
  removeFromManualQueue: (index: number) => void;
  moveManualQueueItem: (fromIndex: number, toIndex: number) => void;
  setContext: (items: LibraryItem[], startIndex: number, name: string, preserveManualQueue?: boolean) => void;
  playNext: () => LibraryItem | null;
  playPrevious: () => LibraryItem | null;
  clearManualQueue: () => void;
  takeQueuedItem: (index: number) => LibraryItem | null;
  chooseContextItem: (id: string) => LibraryItem | null;
  getCurrentItem: () => LibraryItem | null;
  toggleShuffle: () => void;
  cycleRepeatMode: () => void;
  getUpcomingManualQueue: () => LibraryItem[];
  getUpcomingContext: () => LibraryItem[];
  reconcileWithLibrary: (items: LibraryItem[]) => void;
}

export function reconcileLibraryItems(
  savedItems: LibraryItem[],
  libraryItems: LibraryItem[]
): LibraryItem[] {
  const currentItems = new Map(libraryItems.map((item) => [item.id, item]));
  return savedItems
    .map((item) => currentItems.get(item.id))
    .filter((item): item is LibraryItem => item !== undefined);
}

export const useQueueStore = create<QueueState>()(
  persist<QueueState, [], [], PersistedQueueState>(
    (set, get) => ({
      manualQueue: [],
      editVersion: 0,
      contextItems: [],
      contextIndex: -1,
      contextName: 'Library',
      shuffleEnabled: false,
      repeatMode: 'off',

      addToQueue: (item) => set((state) => ({
        editVersion: state.editVersion + 1,
        manualQueue: [...state.manualQueue, item],
      })),

      addNext: (item) => set((state) => ({
        editVersion: state.editVersion + 1,
        manualQueue: [item, ...state.manualQueue],
      })),

      removeFromManualQueue: (index) => set((state) => {
        const newQueue = [...state.manualQueue];
        newQueue.splice(index, 1);
        return { manualQueue: newQueue, editVersion: state.editVersion + 1 };
      }),

      moveManualQueueItem: (fromIndex, toIndex) => set((state) => {
        const newQueue = [...state.manualQueue];
        const [item] = newQueue.splice(fromIndex, 1);
        newQueue.splice(toIndex, 0, item);
        return { manualQueue: newQueue, editVersion: state.editVersion + 1 };
      }),

      setContext: (items, startIndex, name, preserveManualQueue = false) => set((state) => ({
        contextItems: items,
        contextIndex: startIndex,
        contextName: name,
        manualQueue: preserveManualQueue ? state.manualQueue : [],
      })),

      playNext: () => {
        const state = get();

        if (state.repeatMode === 'one') {
          return state.getCurrentItem();
        }

        if (state.manualQueue.length > 0) {
          const [nextItem, ...rest] = state.manualQueue;
          set({ manualQueue: rest });
          return nextItem;
        }

        if (state.shuffleEnabled) {
          const remainingIndices: number[] = [];
          for (let i = 0; i < state.contextItems.length; i++) {
            if (i !== state.contextIndex) remainingIndices.push(i);
          }
          if (remainingIndices.length > 0) {
            const randomIdx = remainingIndices[Math.floor(Math.random() * remainingIndices.length)];
            set({ contextIndex: randomIdx });
            return state.contextItems[randomIdx];
          }
          return null;
        }

        if (state.contextIndex < state.contextItems.length - 1) {
          const nextIndex = state.contextIndex + 1;
          set({ contextIndex: nextIndex });
          return state.contextItems[nextIndex];
        }

        if (state.repeatMode === 'all' && state.contextItems.length > 0) {
          set({ contextIndex: 0 });
          return state.contextItems[0];
        }

        return null;
      },

      playPrevious: () => {
        const state = get();
        if (state.contextIndex > 0) {
          const prevIndex = state.contextIndex - 1;
          set({ contextIndex: prevIndex });
          return state.contextItems[prevIndex];
        }
        return null;
      },

      clearManualQueue: () => set(state => ({ manualQueue: [], editVersion: state.editVersion + 1 })),
      takeQueuedItem: index => {
        const item = get().manualQueue[index];
        if (!item) return null;
        set(state => ({ manualQueue: state.manualQueue.filter((_, i) => i !== index) }));
        return item;
      },
      chooseContextItem: id => {
        const index = get().contextItems.findIndex(item => item.id === id);
        if (index < 0) return null;
        set({ contextIndex: index });
        return get().contextItems[index];
      },

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
        return { repeatMode: modes[(currentIdx + 1) % modes.length] };
      }),

      getUpcomingManualQueue: () => get().manualQueue,

      getUpcomingContext: () => {
        const state = get();
        if (state.contextIndex < 0 || state.contextItems.length === 0) return [];

        const remaining = state.contextItems.slice(state.contextIndex + 1);
        if (state.repeatMode === 'all') {
          return [...remaining, ...state.contextItems.slice(0, state.contextIndex)];
        }
        return remaining;
      },

      reconcileWithLibrary: (items) => set((state) => {
        const currentContextItem = state.contextItems[state.contextIndex];
        const contextItems = reconcileLibraryItems(state.contextItems, items);
        const contextIndex = currentContextItem
          ? contextItems.findIndex((item) => item.id === currentContextItem.id)
          : -1;

        return {
          manualQueue: reconcileLibraryItems(state.manualQueue, items),
          contextItems,
          contextIndex,
        };
      }),
    }),
    {
      name: QUEUE_STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      version: 1,
      partialize: (state) => ({
        manualQueue: state.manualQueue,
        contextItems: state.contextItems,
        contextIndex: state.contextIndex,
        contextName: state.contextName,
        shuffleEnabled: state.shuffleEnabled,
        repeatMode: state.repeatMode,
      }),
    }
  )
);
