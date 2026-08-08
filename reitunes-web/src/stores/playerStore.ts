import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { LibraryItem } from '../types';

export const PLAYER_STORAGE_KEY = 'reitunes-player';

interface PersistedPlayerState {
  currentItemId: string | null;
  resumePosition: number;
  volume: number;
  isMuted: boolean;
}

interface PlayerState extends PersistedPlayerState {
  currentItem: LibraryItem | null;
  isPlaying: boolean;
  pendingSeek: number | null;

  setIsPlaying: (playing: boolean) => void;
  clearPendingSeek: () => void;
  setResumePosition: (position: number) => void;
  setVolume: (volume: number) => void;
  setMuted: (muted: boolean) => void;
  play: (item: LibraryItem, startPosition?: number) => void;
  selectRemoteItem: (item: LibraryItem, startPosition?: number) => void;
  restoreCurrentItem: (item: LibraryItem) => void;
  refreshCurrentItem: (item: LibraryItem) => void;
  clearCurrentItem: () => void;
  seekTo: (position: number) => void;
}

function normalizePosition(position: number): number {
  return Number.isFinite(position) ? Math.max(0, position) : 0;
}

export const usePlayerStore = create<PlayerState>()(
  persist<PlayerState, [], [], PersistedPlayerState>(
    (set, get) => ({
      currentItem: null,
      currentItemId: null,
      isPlaying: false,
      pendingSeek: null,
      resumePosition: 0,
      volume: 1,
      isMuted: false,

      setIsPlaying: (playing) => set({ isPlaying: playing }),
      clearPendingSeek: () => set({ pendingSeek: null }),
      setResumePosition: (position) => set({ resumePosition: normalizePosition(position) }),
      setVolume: (volume) => set({ volume: Math.min(1, Math.max(0, volume)) }),
      setMuted: (muted) => set({ isMuted: muted }),

      play: (item, startPosition = 0) => {
        const position = normalizePosition(startPosition);
        set({
          currentItem: item,
          currentItemId: item.id,
          isPlaying: true,
          pendingSeek: position,
          resumePosition: position,
        });
      },

      selectRemoteItem: (item, startPosition = 0) => {
        const position = normalizePosition(startPosition);
        set({
          currentItem: item,
          currentItemId: item.id,
          isPlaying: false,
          pendingSeek: null,
          resumePosition: position,
        });
      },

      restoreCurrentItem: (item) => {
        const position = normalizePosition(get().resumePosition);
        set({
          currentItem: item,
          currentItemId: item.id,
          isPlaying: false,
          pendingSeek: position,
        });
      },

      refreshCurrentItem: (item) => set({ currentItem: item }),

      clearCurrentItem: () => set({
        currentItem: null,
        currentItemId: null,
        isPlaying: false,
        pendingSeek: null,
        resumePosition: 0,
      }),

      seekTo: (position) => {
        const normalized = normalizePosition(position);
        set({ pendingSeek: normalized, resumePosition: normalized });
      },
    }),
    {
      name: PLAYER_STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      version: 1,
      partialize: (state) => ({
        currentItemId: state.currentItemId,
        resumePosition: state.resumePosition,
        volume: state.volume,
        isMuted: state.isMuted,
      }),
    }
  )
);
