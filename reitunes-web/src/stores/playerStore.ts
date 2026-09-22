import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { LibraryItem } from '../types';

export const PLAYER_STORAGE_KEY = 'reitunes-player';
export interface PlaybackRange {
  start: number;
  end: number | null;
  bookmarkId?: string;
  afterEnd?: 'pause';
}

interface PersistedPlayerState {
  currentItemId: string | null;
  resumePosition: number;
  volume: number;
  isMuted: boolean;
  playbackRange: PlaybackRange | null;
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
  play: (item: LibraryItem, startPosition?: number, range?: PlaybackRange) => void;
  selectRemoteItem: (item: LibraryItem, startPosition?: number, range?: PlaybackRange) => void;
  setPlaybackRange: (range: PlaybackRange | null) => void;
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
      playbackRange: null,
      setPlaybackRange: playbackRange => set({ playbackRange }),

      setIsPlaying: (playing) => set({ isPlaying: playing }),
      clearPendingSeek: () => set({ pendingSeek: null }),
      setResumePosition: (position) => set({ resumePosition: normalizePosition(position) }),
      setVolume: (volume) => set({ volume: Math.min(1, Math.max(0, volume)) }),
      setMuted: (muted) => set({ isMuted: muted }),

      play: (item, startPosition = 0, range) => {
        const position = normalizePosition(startPosition);
        set({
          currentItem: item,
          currentItemId: item.id,
          isPlaying: true,
          pendingSeek: position,
          resumePosition: position,
          playbackRange: range ?? null,
        });
      },

      selectRemoteItem: (item, startPosition = 0, range) => {
        const position = normalizePosition(startPosition);
        set({
          currentItem: item,
          currentItemId: item.id,
          isPlaying: false,
          pendingSeek: null,
          resumePosition: position,
          playbackRange: range ?? null,
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

      refreshCurrentItem: (item) => set(state => {
        const range = state.playbackRange;
        const bookmark = range?.bookmarkId ? item.bookmarks[range.bookmarkId] : undefined;
        return { currentItem: item, playbackRange: range?.bookmarkId
          ? bookmark ? { ...range, start: bookmark.position, end: bookmark.end_position ?? null } : null : range };
      }),

      clearCurrentItem: () => set({
        currentItem: null,
        currentItemId: null,
        isPlaying: false,
        pendingSeek: null,
        resumePosition: 0,
        playbackRange: null,
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
        playbackRange: state.playbackRange,
      }),
    }
  )
);
