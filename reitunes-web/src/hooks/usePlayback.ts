import { useCallback } from 'react';
import type { LibraryItem } from '../types';
import { useQueueStore } from './useQueue';
import { markPlayed } from './useLibrary';
import { usePlayerStore, type PlaybackRange } from '../stores/playerStore';
import { usePlaybackTargetStore, type SonosPlaybackTarget } from '../stores/playbackTargetStore';
import { recordPlaybackEvent } from '../utils/playbackDiagnostics';
import { sonosRequest, SonosRequestError } from '../utils/sonosRequest';

function sonosQueueFor(item: LibraryItem): LibraryItem[] {
  const queue = useQueueStore.getState();
  const contextIndex = queue.contextItems.findIndex((candidate) => candidate.id === item.id);
  const upcomingContext = contextIndex >= 0 ? queue.contextItems.slice(contextIndex + 1) : [];
  return [item, ...queue.manualQueue, ...upcomingContext].slice(0, 500);
}

export async function sendSonosQueue(
  item: LibraryItem, startPosition: number, target: SonosPlaybackTarget,
  allowTakeover: boolean, playOnCompletion = true,
) {
  await sonosRequest('/api/sonos/play', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      groupId: target.groupId,
      itemIds: sonosQueueFor(item).map(queueItem => queueItem.id),
      startItemId: item.id,
      positionMillis: Math.round(Math.max(0, startPosition) * 1000),
      allowTakeover,
      playOnCompletion,
    }),
  }, 50_000);
}

export function usePlayback() {
  return useCallback(async (item: LibraryItem, startPosition = 0, origin = 'selection', range?: PlaybackRange): Promise<boolean> => {
    const targetState = usePlaybackTargetStore.getState();
    if (targetState.isSwitchingOutput || targetState.isTransportPending) return false;
    recordPlaybackEvent('request', { itemId: item.id, position: startPosition, target: targetState.target.kind, origin });
    if (targetState.target.kind === 'browser') {
      targetState.clearError();
      usePlayerStore.getState().play(item, startPosition, range);
      return true;
    }

    if (targetState.isSending) return false;

    const target = targetState.target;
    usePlayerStore.getState().selectRemoteItem(item, startPosition, range);
    targetState.beginSending();

    try {
      await sendSonosQueue(item, startPosition, target, targetState.takeoverRequired);
      if (usePlaybackTargetStore.getState().target !== target) return false;

      usePlaybackTargetStore.getState().finishSending();
      void markPlayed(item.id).catch((error) => {
        console.error('Sonos playback started, but the play count could not be updated:', error);
      });
      return true;
    } catch (error) {
      if (usePlaybackTargetStore.getState().target !== target) return false;
      recordPlaybackEvent('play-rejected', { target: 'sonos', itemId: item.id, errorName: error instanceof Error ? error.name : 'UnknownError' });
      const message = error instanceof Error ? error.message : 'Could not play on Sonos';
      // An uncertain result must not carry permission to replace another app
      // into a later retry. Only a fresh conflict requests confirmation.
      const takeoverRequired = error instanceof SonosRequestError && error.status === 409;
      usePlaybackTargetStore.getState().failSending(message, takeoverRequired);
      return false;
    }
  }, []);
}
