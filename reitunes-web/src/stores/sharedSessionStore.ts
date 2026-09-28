import { create } from 'zustand';
import type { PlaybackTarget } from './playbackTargetStore';
import type { PlaybackRange } from './playerStore';

export interface SharedQueueEntry { id: string; itemId: string }
export interface SharedPlaybackState {
  target: PlaybackTarget;
  currentItemId: string | null;
  position: number;
  playbackRange: PlaybackRange | null;
  queue: {
    manualQueue: SharedQueueEntry[];
    contextItemIds: string[];
    contextIndex: number;
    contextName: string;
    shuffleEnabled: boolean;
    shuffledIds: string[];
    repeatMode: 'off' | 'one' | 'all';
  };
}
export interface SharedPlaybackSnapshot {
  revision: number;
  state: SharedPlaybackState | null;
  queueSyncPending?: boolean;
  queueSyncError?: string | null;
}

// A page instance owns browser audio. Duplicating a tab must not duplicate its
// ownership, which is why this is deliberately not stored in sessionStorage.
const clientId = globalThis.crypto.randomUUID();
export function getPlaybackClientId() { return clientId; }

export const useSharedSessionStore = create<{
  enabled: boolean;
  ready: boolean;
  connected: boolean;
  refreshing: boolean;
  error: string | null;
  revision: number;
  queueSyncVersion: number;
  sonosAppliedVersion: number;
  queueSyncPending: boolean;
  queueSyncError: string | null;
}>()(() => ({ enabled: false, ready: false, connected: false, refreshing: false, error: null,
  revision: 0, queueSyncVersion: 0, sonosAppliedVersion: 0, queueSyncPending: false, queueSyncError: null }));

export function canEditSharedSession() {
  const session = useSharedSessionStore.getState();
  return !session.enabled || (session.ready && session.connected && !session.refreshing);
}

export function ownsBrowserPlayback(target: PlaybackTarget) {
  if (target.kind !== 'browser') return false;
  const session = useSharedSessionStore.getState();
  return !session.enabled || (session.ready && target.ownerId === clientId);
}

export function acknowledgeSonosQueue(version: number) {
  useSharedSessionStore.setState(state => ({ sonosAppliedVersion: Math.max(state.sonosAppliedVersion, version) }));
}
