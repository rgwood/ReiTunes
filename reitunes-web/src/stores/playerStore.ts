import { create } from 'zustand';
import type { LibraryItem } from '../types';

interface PlayerState {
  currentItem: LibraryItem | null;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  pendingSeek: number | null;  // Only set when an explicit seek is requested

  // Actions
  setCurrentItem: (item: LibraryItem | null) => void;
  setIsPlaying: (playing: boolean) => void;
  setCurrentTime: (time: number) => void;
  setDuration: (duration: number) => void;
  clearPendingSeek: () => void;
  play: (item: LibraryItem, startPosition?: number) => void;
  seekTo: (position: number) => void;
}

export const usePlayerStore = create<PlayerState>((set) => ({
  currentItem: null,
  isPlaying: false,
  currentTime: 0,
  duration: 0,
  pendingSeek: null,

  setCurrentItem: (item) => set({ currentItem: item }),
  setIsPlaying: (playing) => set({ isPlaying: playing }),
  setCurrentTime: (time) => set({ currentTime: time }),
  setDuration: (duration) => set({ duration: duration }),
  clearPendingSeek: () => set({ pendingSeek: null }),

  play: (item, startPosition) => set({
    currentItem: item,
    isPlaying: true,
    pendingSeek: startPosition && startPosition > 0 ? startPosition : null,
  }),

  seekTo: (position) => set({ pendingSeek: position }),
}));
