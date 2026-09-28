import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { LibraryItem } from '../types';
import { canEditSharedSession, ownsBrowserPlayback } from '../stores/sharedSessionStore';
import { usePlaybackTargetStore } from '../stores/playbackTargetStore';

type RepeatMode = 'off' | 'one' | 'all';

export const QUEUE_STORAGE_KEY = 'reitunes-queue';

interface PersistedQueueState {
  manualQueue: LibraryItem[];
  manualQueueIds: string[];
  contextItems: LibraryItem[];
  contextIndex: number;
  contextName: string;
  shuffleEnabled: boolean;
  shuffledIds: string[];
  repeatMode: RepeatMode;
}

// Queue occurrences have their own identity: adding the same song twice is
// intentional, and another screen must be able to remove just one copy.
export function queueOccurrenceIds(state: Pick<PersistedQueueState, 'manualQueue' | 'manualQueueIds'>): string[] {
  return state.manualQueue.map((_, index) => state.manualQueueIds?.[index] ?? crypto.randomUUID());
}

function canSelectTrack() {
  const output = usePlaybackTargetStore.getState();
  return canEditSharedSession() && !output.isSending && !output.isSwitchingOutput && !output.isTransportPending;
}

function shuffled(items: LibraryItem[], currentId?: string): string[] {
  const ids = items.filter(item => item.id !== currentId).map(item => item.id);
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  return currentId ? [currentId, ...ids] : ids;
}

function orderedContext(state: PersistedQueueState): LibraryItem[] {
  if (!state.shuffleEnabled) return state.contextItems;
  const byId = new Map(state.contextItems.map(item => [item.id, item]));
  const ids = [...new Set([...state.shuffledIds, ...byId.keys()])];
  return ids.flatMap(id => byId.has(id) ? [byId.get(id)!] : []);
}

interface QueueState extends PersistedQueueState {
  editVersion: number;
  addToQueue: (item: LibraryItem) => void;
  addNext: (item: LibraryItem) => void;
  removeFromManualQueue: (index: number) => void;
  moveManualQueueItem: (fromIndex: number, toIndex: number) => void;
  setContext: (items: LibraryItem[], startIndex: number, name: string, preserveManualQueue?: boolean) => void;
  playNext: (allowWhileOffline?: boolean) => LibraryItem | null;
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
      manualQueueIds: [],
      editVersion: 0,
      contextItems: [],
      contextIndex: -1,
      contextName: 'Library',
      shuffleEnabled: false,
      shuffledIds: [],
      repeatMode: 'off',

      addToQueue: (item) => canEditSharedSession() && set((state) => ({
        editVersion: state.editVersion + 1,
        manualQueue: [...state.manualQueue, item],
        manualQueueIds: [...queueOccurrenceIds(state), crypto.randomUUID()],
      })),

      addNext: (item) => canEditSharedSession() && set((state) => ({
        editVersion: state.editVersion + 1,
        manualQueue: [item, ...state.manualQueue],
        manualQueueIds: [crypto.randomUUID(), ...queueOccurrenceIds(state)],
      })),

      removeFromManualQueue: (index) => canEditSharedSession() && set((state) => {
        const newQueue = [...state.manualQueue];
        const ids = queueOccurrenceIds(state);
        newQueue.splice(index, 1);
        ids.splice(index, 1);
        return { manualQueue: newQueue, manualQueueIds: ids, editVersion: state.editVersion + 1 };
      }),

      moveManualQueueItem: (fromIndex, toIndex) => canEditSharedSession() && set((state) => {
        if (fromIndex < 0 || toIndex < 0 || fromIndex >= state.manualQueue.length || toIndex >= state.manualQueue.length) return {};
        const newQueue = [...state.manualQueue];
        const ids = queueOccurrenceIds(state);
        const [item] = newQueue.splice(fromIndex, 1);
        newQueue.splice(toIndex, 0, item);
        const [id] = ids.splice(fromIndex, 1);
        ids.splice(toIndex, 0, id);
        return { manualQueue: newQueue, manualQueueIds: ids, editVersion: state.editVersion + 1 };
      }),

      setContext: (items, startIndex, name, preserveManualQueue = false) => canSelectTrack() && set((state) => ({
        contextItems: items,
        contextIndex: startIndex,
        contextName: name,
        shuffledIds: state.shuffleEnabled ? shuffled(items, items[startIndex]?.id) : [],
        manualQueue: preserveManualQueue ? state.manualQueue : [],
        manualQueueIds: preserveManualQueue ? queueOccurrenceIds(state) : [],
      })),

      playNext: (allowWhileOffline = false) => {
        const output = usePlaybackTargetStore.getState();
        if (output.isSending || output.isSwitchingOutput || output.isTransportPending ||
          (!canEditSharedSession() && !(allowWhileOffline && ownsBrowserPlayback(output.target)))) return null;
        const state = get();

        if (state.repeatMode === 'one') {
          return state.getCurrentItem();
        }

        if (state.manualQueue.length > 0) {
          const [nextItem, ...rest] = state.manualQueue;
          set({ manualQueue: rest, manualQueueIds: queueOccurrenceIds(state).slice(1) });
          return nextItem;
        }

        const next = (state.contextIndex < 0 ? orderedContext(state)[0] : state.getUpcomingContext()[0])
          ?? (state.repeatMode === 'all' ? state.getCurrentItem() : null);
        if (next) set({ contextIndex: state.contextItems.findIndex(item => item.id === next.id) });
        return next;
      },

      playPrevious: () => {
        if (!canSelectTrack()) return null;
        const state = get();
        const order = orderedContext(state);
        const index = order.findIndex(item => item.id === state.getCurrentItem()?.id);
        if (index > 0) {
          const previous = order[index - 1];
          set({ contextIndex: state.contextItems.findIndex(item => item.id === previous.id) });
          return previous;
        }
        return null;
      },

      clearManualQueue: () => canEditSharedSession() && set(state => ({ manualQueue: [], manualQueueIds: [], editVersion: state.editVersion + 1 })),
      takeQueuedItem: index => {
        if (!canSelectTrack()) return null;
        const item = get().manualQueue[index];
        if (!item) return null;
        set(state => ({ manualQueue: state.manualQueue.filter((_, i) => i !== index),
          manualQueueIds: queueOccurrenceIds(state).filter((_, i) => i !== index) }));
        return item;
      },
      chooseContextItem: id => {
        if (!canSelectTrack()) return null;
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

      toggleShuffle: () => canEditSharedSession() && set((state) => ({
        shuffleEnabled: !state.shuffleEnabled,
        shuffledIds: !state.shuffleEnabled ? shuffled(state.contextItems, state.contextItems[state.contextIndex]?.id) : [],
        editVersion: state.editVersion + 1,
      })),

      cycleRepeatMode: () => canEditSharedSession() && set((state) => {
        const modes: RepeatMode[] = ['off', 'all', 'one'];
        const currentIdx = modes.indexOf(state.repeatMode);
        return { repeatMode: modes[(currentIdx + 1) % modes.length] };
      }),

      getUpcomingManualQueue: () => get().manualQueue,

      getUpcomingContext: () => {
        const state = get();
        if (state.contextIndex < 0 || state.contextItems.length === 0) return [];

        const order = orderedContext(state);
        const index = order.findIndex(item => item.id === state.contextItems[state.contextIndex]?.id);
        const remaining = order.slice(index + 1);
        if (state.repeatMode === 'all') {
          return [...remaining, ...order.slice(0, index)];
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
          manualQueueIds: queueOccurrenceIds(state).filter((_, index) => items.some(item => item.id === state.manualQueue[index].id)),
          contextItems,
          contextIndex,
        };
      }),
    }),
    {
      name: QUEUE_STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      version: 1,
      merge: (persisted, current) => {
        const restored = { ...current, ...persisted as Partial<PersistedQueueState> };
        restored.manualQueueIds = queueOccurrenceIds(restored);
        if (restored.shuffleEnabled && !restored.shuffledIds.length) {
          restored.shuffledIds = shuffled(restored.contextItems, restored.contextItems[restored.contextIndex]?.id);
        }
        return restored;
      },
      partialize: (state) => ({
        manualQueue: state.manualQueue,
        manualQueueIds: state.manualQueueIds,
        contextItems: state.contextItems,
        contextIndex: state.contextIndex,
        contextName: state.contextName,
        shuffleEnabled: state.shuffleEnabled,
        shuffledIds: state.shuffledIds,
        repeatMode: state.repeatMode,
      }),
    }
  )
);
