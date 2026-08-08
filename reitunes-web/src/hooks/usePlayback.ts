import { useCallback } from 'react';
import type { LibraryItem } from '../types';
import { useQueueStore } from './useQueue';
import { markPlayed } from './useLibrary';
import { usePlayerStore } from '../stores/playerStore';
import { usePlaybackTargetStore } from '../stores/playbackTargetStore';

function sonosQueueFor(item: LibraryItem): LibraryItem[] {
  const queue = useQueueStore.getState();
  const contextIndex = queue.contextItems.findIndex((candidate) => candidate.id === item.id);
  const upcomingContext = contextIndex >= 0 ? queue.contextItems.slice(contextIndex + 1) : [];
  return [item, ...queue.manualQueue, ...upcomingContext].slice(0, 500);
}

async function responseError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string };
    return body.error || `Request failed (${response.status})`;
  } catch {
    return `Request failed (${response.status})`;
  }
}

export function usePlayback() {
  return useCallback(async (item: LibraryItem, startPosition = 0): Promise<void> => {
    const targetState = usePlaybackTargetStore.getState();
    if (targetState.target.kind === 'browser') {
      targetState.clearError();
      usePlayerStore.getState().play(item, startPosition);
      return;
    }

    if (targetState.isSending) return;

    const target = targetState.target;
    const items = sonosQueueFor(item);
    usePlayerStore.getState().selectRemoteItem(item, startPosition);
    targetState.beginSending();

    try {
      const response = await fetch('/api/sonos/play', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          groupId: target.groupId,
          itemIds: items.map((queueItem) => queueItem.id),
          startItemId: item.id,
          positionMillis: Math.round(Math.max(0, startPosition) * 1000),
          allowTakeover: targetState.takeoverRequired,
        }),
      });
      if (!response.ok) {
        throw Object.assign(new Error(await responseError(response)), {
          takeoverRequired: response.status === 409,
        });
      }

      usePlaybackTargetStore.getState().finishSending();
      void markPlayed(item.id).catch((error) => {
        console.error('Sonos playback started, but the play count could not be updated:', error);
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not play on Sonos';
      const takeoverRequired =
        targetState.takeoverRequired ||
        (error instanceof Error &&
          'takeoverRequired' in error &&
          error.takeoverRequired === true);
      usePlaybackTargetStore.getState().failSending(message, takeoverRequired);
    }
  }, []);
}
