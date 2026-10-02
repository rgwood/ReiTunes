import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { LibraryItem } from '../types';
import { canEditSharedSession, ownsBrowserPlayback } from '../stores/sharedSessionStore';
import { usePlaybackTargetStore } from '../stores/playbackTargetStore';
import { usePlayerStore } from '../stores/playerStore';

type RepeatMode = 'off' | 'one' | 'all';

export const QUEUE_STORAGE_KEY = 'reitunes-queue';

interface PersistedQueueState {
  manualQueue: LibraryItem[];
  manualQueueIds: string[];
  contextItems: LibraryItem[];
  contextIndex: number;
  contextName: string;
  contextId: string | null;
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

// Library deletion and session hydration can remove context tracks. Preserve
// the surviving shuffle order so every subsequent shared-session save is valid.
export function reconcileShuffleOrder(ids: string[], items: LibraryItem[]): string[] {
  const available = new Set(items.map(item => item.id));
  return [...new Set(ids)].filter(id => available.has(id));
}

function shuffled(items: LibraryItem[], currentId?: string): string[] {
  const ids = [...new Set(items.filter(item => item.id !== currentId).map(item => item.id))];
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

type AutomaticContext = Pick<PersistedQueueState, 'contextItems' | 'contextIndex' | 'contextName' | 'contextId' | 'shuffledIds'>;
type Neighbors = { previousId?: string; nextId?: string; index: number };
type QueueUndo = { message: string; contextId: string | null } & (
  | { kind: 'manual'; item: LibraryItem; occurrenceId: string; neighbors: Neighbors }
  | { kind: 'context'; item: LibraryItem; cursorId: string | null; neighbors: Neighbors; shuffleNeighbors: Neighbors }
  | { kind: 'replacement'; previous: AutomaticContext; previousShuffleEnabled: boolean }
);

function neighbors(ids: string[], index: number): Neighbors {
  return { previousId: ids[index - 1], nextId: ids[index + 1], index };
}

function insertionIndex(ids: string[], position: Neighbors): number {
  const next = position.nextId ? ids.indexOf(position.nextId) : -1;
  if (next >= 0) return next;
  const previous = position.previousId ? ids.indexOf(position.previousId) : -1;
  return previous >= 0 ? previous + 1 : Math.min(position.index, ids.length);
}

function cursorId(state: AutomaticContext) {
  return state.contextItems[state.contextIndex]?.id ?? null;
}

function contextName(name: string): string {
  const encoded = new TextEncoder().encode(name);
  if (encoded.length <= 1_000) return name;
  // The server limits this label in bytes. Don't split a multibyte character.
  let end = 1_000;
  while ((encoded[end] & 0xc0) === 0x80) end -= 1;
  return new TextDecoder().decode(encoded.subarray(0, end));
}

function undoIsValid(state: QueueState): boolean {
  const undo = state.queueUndo;
  if (!undo || undo.contextId !== state.contextId) return false;
  if (undo.kind === 'manual') return !state.manualQueueIds.includes(undo.occurrenceId);
  if (undo.kind === 'replacement') return state.contextIndex === -1;
  return cursorId(state) === undo.cursorId && !state.contextItems.some(item => item.id === undo.item.id);
}

interface QueueState extends PersistedQueueState {
  editVersion: number;
  queueUndo: QueueUndo | null;
  addToQueue: (item: LibraryItem) => void;
  addNext: (item: LibraryItem) => void;
  removeFromManualQueue: (index: number) => void;
  removeQueuedOccurrence: (entryId: string) => void;
  removeUpcomingContext: (itemId: string) => void;
  replaceUpcomingContext: (items: LibraryItem[], name: string) => void;
  undoQueueEdit: () => void;
  canUndoQueueEdit: () => boolean;
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
  toggleRepeatAll: () => void;
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
      queueUndo: null,
      contextItems: [],
      contextIndex: -1,
      contextName: 'Library',
      contextId: null,
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

      removeFromManualQueue: (index) => {
        if (!canSelectTrack()) return;
        const state = get();
        if (!state.manualQueue[index]) return;
        const ids = queueOccurrenceIds(state);
        if (ids.some((id, i) => id !== state.manualQueueIds[i])) set({ manualQueueIds: ids });
        state.removeQueuedOccurrence(ids[index]);
      },

      removeQueuedOccurrence: (entryId) => canSelectTrack() && set((state) => {
        const ids = queueOccurrenceIds(state);
        const index = ids.indexOf(entryId);
        if (index < 0) return {};
        const item = state.manualQueue[index];
        return {
          manualQueue: state.manualQueue.filter((_, i) => i !== index),
          manualQueueIds: ids.filter(id => id !== entryId), editVersion: state.editVersion + 1,
          queueUndo: { kind: 'manual', item, occurrenceId: entryId, neighbors: neighbors(ids, index),
            contextId: state.contextId, message: `Removed ${item.name} from Up Next` },
        };
      }),

      removeUpcomingContext: (itemId) => canSelectTrack() && set((state) => {
        // A speaker observation can advance while the Remove button is being
        // clicked. Never remove the song that has become the current track.
        if (!state.getUpcomingContext().some(item => item.id === itemId)) return {};
        const index = state.contextItems.findIndex(item => item.id === itemId);
        const item = state.contextItems[index];
        const currentId = cursorId(state);
        const order = orderedContext({ ...state, shuffleEnabled: true });
        const contextItems = state.contextItems.filter(item => item.id !== itemId);
        return {
          contextItems, contextIndex: currentId ? contextItems.findIndex(item => item.id === currentId) : -1,
          shuffledIds: state.shuffledIds.filter(id => id !== itemId), editVersion: state.editVersion + 1,
          queueUndo: { kind: 'context', item, contextId: state.contextId, cursorId: currentId,
            neighbors: neighbors(state.contextItems.map(item => item.id), index),
            shuffleNeighbors: neighbors(order.map(item => item.id), order.findIndex(item => item.id === itemId)),
            message: `Removed ${item.name} from Up Next` },
        };
      }),

      replaceUpcomingContext: (items, name) => canSelectTrack() && set((state) => {
        const currentId = usePlayerStore.getState().currentItemId;
        const contextItems = [...new Map(items.filter(item => item.id !== currentId).map(item => [item.id, item])).values()];
        const contextId = crypto.randomUUID();
        return {
          contextItems, contextIndex: -1, contextName: contextName(name), contextId,
          shuffledIds: state.shuffleEnabled ? shuffled(contextItems) : [], editVersion: state.editVersion + 1,
          queueUndo: { kind: 'replacement', contextId, previousShuffleEnabled: state.shuffleEnabled,
            previous: { contextItems: state.contextItems, contextIndex: state.contextIndex,
              contextName: state.contextName, contextId: state.contextId, shuffledIds: state.shuffledIds },
            message: `Up Next now uses ${name}` },
        };
      }),

      canUndoQueueEdit: () => canSelectTrack() && undoIsValid(get()),

      undoQueueEdit: () => {
        if (!canSelectTrack()) return;
        set(state => {
          const undo = state.queueUndo;
          if (!undo || !undoIsValid(state)) return { queueUndo: null };
          const changed = { queueUndo: null, editVersion: state.editVersion + 1 };
          if (undo.kind === 'manual') {
            const manualQueue = [...state.manualQueue], manualQueueIds = queueOccurrenceIds(state);
            const index = insertionIndex(manualQueueIds, undo.neighbors);
            manualQueue.splice(index, 0, undo.item);
            manualQueueIds.splice(index, 0, undo.occurrenceId);
            return { ...changed, manualQueue, manualQueueIds };
          }
          if (undo.kind === 'context') {
            const contextItems = [...state.contextItems];
            contextItems.splice(insertionIndex(contextItems.map(item => item.id), undo.neighbors), 0, undo.item);
            const shuffledIds = orderedContext({ ...state, shuffleEnabled: true }).map(item => item.id);
            shuffledIds.splice(insertionIndex(shuffledIds, undo.shuffleNeighbors), 0, undo.item.id);
            return { ...changed, contextItems,
              contextIndex: undo.cursorId ? contextItems.findIndex(item => item.id === undo.cursorId) : -1,
              shuffledIds: state.shuffleEnabled ? shuffledIds : state.shuffledIds };
          }
          return { ...changed, ...undo.previous,
            shuffledIds: !state.shuffleEnabled ? [] : undo.previousShuffleEnabled
              ? undo.previous.shuffledIds : shuffled(undo.previous.contextItems, cursorId(undo.previous) ?? undefined) };
        });
      },

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
        contextId: crypto.randomUUID(),
        queueUndo: null,
        contextItems: items,
        contextIndex: startIndex,
        contextName: contextName(name),
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
          return usePlayerStore.getState().currentItem;
        }

        if (state.manualQueue.length > 0) {
          const [nextItem, ...rest] = state.manualQueue;
          set({ manualQueue: rest, manualQueueIds: queueOccurrenceIds(state).slice(1) });
          return nextItem;
        }

        const next = (state.contextIndex < 0 ? orderedContext(state)[0] : state.getUpcomingContext()[0])
          ?? (state.repeatMode === 'all' ? state.getCurrentItem() : null);
        if (next) set({ contextIndex: state.contextItems.findIndex(item => item.id === next.id),
          queueUndo: state.queueUndo?.kind === 'manual' ? state.queueUndo : null });
        return next;
      },

      playPrevious: () => {
        if (!canSelectTrack()) return null;
        const state = get();
        const order = orderedContext(state);
        const index = order.findIndex(item => item.id === state.getCurrentItem()?.id);
        if (index > 0) {
          const previous = order[index - 1];
          set({ contextIndex: state.contextItems.findIndex(item => item.id === previous.id),
            queueUndo: state.queueUndo?.kind === 'manual' ? state.queueUndo : null });
          return previous;
        }
        return null;
      },

      clearManualQueue: () => canEditSharedSession() && set(state => ({ manualQueue: [], manualQueueIds: [],
        queueUndo: state.queueUndo?.kind === 'manual' ? null : state.queueUndo, editVersion: state.editVersion + 1 })),
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
        set(state => ({ contextIndex: index, queueUndo: state.queueUndo?.kind === 'manual' ? state.queueUndo : null }));
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

      toggleRepeatAll: () => canEditSharedSession() && set(state => ({
        repeatMode: state.repeatMode === 'all' ? 'off' : 'all', editVersion: state.editVersion + 1,
      })),

      getUpcomingManualQueue: () => get().manualQueue,

      getUpcomingContext: () => {
        const state = get();
        if (state.contextItems.length === 0) return [];

        const order = orderedContext(state);
        if (state.contextIndex < 0) return order;
        const index = order.findIndex(item => item.id === state.contextItems[state.contextIndex]?.id);
        const remaining = order.slice(index + 1);
        if (state.repeatMode === 'all') {
          return [...remaining, ...order.slice(0, index)];
        }
        return remaining;
      },

      reconcileWithLibrary: (items) => set((state) => {
        const undo = state.queueUndo;
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
          shuffledIds: reconcileShuffleOrder(state.shuffledIds, contextItems),
          queueUndo: undo && (undo.kind === 'replacement'
            ? undo.previous.contextItems.every(item => items.some(available => available.id === item.id))
            : items.some(item => item.id === undo.item.id)) ? undo : null,
        };
      }),
    }),
    {
      name: QUEUE_STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      version: 1,
      merge: (persisted, current) => {
        const restored = { ...current, ...persisted as Partial<PersistedQueueState> };
        restored.queueUndo = null;
        restored.manualQueueIds = queueOccurrenceIds(restored);
        restored.shuffledIds = reconcileShuffleOrder(restored.shuffledIds, restored.contextItems);
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
        contextId: state.contextId,
        shuffleEnabled: state.shuffleEnabled,
        shuffledIds: state.shuffledIds,
        repeatMode: state.repeatMode,
      }),
    }
  )
);
