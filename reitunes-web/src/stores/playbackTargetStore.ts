import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

export const PLAYBACK_TARGET_STORAGE_KEY = 'reitunes-playback-target';

export interface BrowserPlaybackTarget {
  kind: 'browser';
}

export interface SonosPlaybackTarget {
  kind: 'sonos';
  householdId: string;
  groupId: string;
  groupName: string;
  playerNames: string[];
}

export type PlaybackTarget = BrowserPlaybackTarget | SonosPlaybackTarget;

interface PersistedPlaybackTargetState {
  target: PlaybackTarget;
  takeoverRequired: boolean;
}

interface PlaybackTargetState extends PersistedPlaybackTargetState {
  isSending: boolean;
  error: string | null;
  setBrowserTarget: () => void;
  setSonosTarget: (target: Omit<SonosPlaybackTarget, 'kind'>) => void;
  beginSending: () => void;
  finishSending: () => void;
  failSending: (error: string, takeoverRequired: boolean) => void;
  clearError: () => void;
}

export const usePlaybackTargetStore = create<PlaybackTargetState>()(
  persist<PlaybackTargetState, [], [], PersistedPlaybackTargetState>(
    (set) => ({
      target: { kind: 'browser' },
      takeoverRequired: false,
      isSending: false,
      error: null,

      setBrowserTarget: () =>
        set({
          target: { kind: 'browser' },
          takeoverRequired: false,
          isSending: false,
          error: null,
        }),
      setSonosTarget: (target) =>
        set({
          target: { kind: 'sonos', ...target },
          takeoverRequired: true,
          isSending: false,
          error: null,
        }),
      beginSending: () => set({ isSending: true, error: null }),
      finishSending: () => set({ isSending: false, takeoverRequired: false, error: null }),
      failSending: (error, takeoverRequired) =>
        set({ isSending: false, error, takeoverRequired }),
      clearError: () => set({ error: null }),
    }),
    {
      name: PLAYBACK_TARGET_STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      version: 1,
      partialize: (state) => ({
        target: state.target,
        takeoverRequired: state.takeoverRequired,
      }),
    }
  )
);
