import { useCallback } from 'react';
import type { LibraryItem } from '../types';
import { useQueueStore } from './useQueue';
import { markPlayed } from './useLibrary';
import { usePlayerStore, type PlaybackRange } from '../stores/playerStore';
import { usePlaybackTargetStore, type SonosPlaybackTarget } from '../stores/playbackTargetStore';
import { recordPlaybackEvent } from '../utils/playbackDiagnostics';
import { sonosRequest, SonosRequestError } from '../utils/sonosRequest';
import { acknowledgeSonosQueue, canEditSharedSession, ownsBrowserPlayback, useSharedSessionStore } from '../stores/sharedSessionStore';
import { flushSharedSession, refreshSharedSession, stageSharedPlayback } from './useSharedPlaybackSession';

function sonosQueueFor(item: LibraryItem): LibraryItem[] {
  const queue = useQueueStore.getState();
  const upcomingContext = queue.getUpcomingContext();
  return [item, ...queue.manualQueue, ...upcomingContext].slice(0, 500);
}

export async function sendSonosQueue(
  item: LibraryItem, startPosition: number, target: SonosPlaybackTarget,
  allowTakeover: boolean, playOnCompletion = true,
) {
  const session = useSharedSessionStore.getState();
  const queueVersion = session.queueSyncVersion;
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
      ...(session.enabled ? { expectedSessionRevision: session.revision } : {}),
    }),
  }, 50_000);
  acknowledgeSonosQueue(queueVersion);
}

export function usePlayback() {
  return useCallback(async (item: LibraryItem, startPosition = 0, origin = 'selection', range?: PlaybackRange): Promise<boolean> => {
    const targetState = usePlaybackTargetStore.getState();
    const continuingOwnedAudio = origin === 'ended' && ownsBrowserPlayback(targetState.target);
    if ((!canEditSharedSession() && !continuingOwnedAudio) || targetState.isSwitchingOutput || targetState.isTransportPending) return false;
    recordPlaybackEvent('request', { itemId: item.id, position: startPosition, target: targetState.target.kind, origin });
    if (targetState.target.kind === 'browser') {
      targetState.clearError();
      if (!ownsBrowserPlayback(targetState.target)) {
        // Selection is explicit permission to move browser playback here. Save
        // ownership before starting audio so another page relinquishes it.
        targetState.setBrowserTarget();
        usePlayerStore.getState().selectRemoteItem(item, startPosition, range);
        stageSharedPlayback();
        if (!await flushSharedSession()) return false;
        if (!ownsBrowserPlayback(usePlaybackTargetStore.getState().target)) return false;
      }
      // Owned browser playback, including automatic next-track transitions,
      // never waits for a network request before calling the media element.
      usePlayerStore.getState().play(item, startPosition, range);
      stageSharedPlayback();
      return true;
    }

    if (targetState.isSending) return false;

    const target = targetState.target;
    usePlayerStore.getState().selectRemoteItem(item, startPosition, range);
    targetState.beginSending();

    try {
      stageSharedPlayback();
      if (!await flushSharedSession()) {
        usePlaybackTargetStore.getState().finishSending();
        return false;
      }
      if (usePlaybackTargetStore.getState().target !== target) return false;
      await sendSonosQueue(item, startPosition, target, targetState.takeoverRequired);
      if (usePlaybackTargetStore.getState().target !== target) return false;

      usePlaybackTargetStore.getState().finishSending();
      void markPlayed(item.id).catch((error) => {
        console.error('Sonos playback started, but the play count could not be updated:', error);
      });
      return true;
    } catch (error) {
      if (usePlaybackTargetStore.getState().target !== target) return false;
      recordPlaybackEvent('play-rejected', { target: 'sonos', itemId: item.id, origin,
        errorName: error instanceof Error ? error.name : 'UnknownError',
        errorMessage: error instanceof Error ? error.message : undefined,
        httpStatus: error instanceof SonosRequestError ? error.status : undefined,
        outcome: error instanceof SonosRequestError ? error.code : undefined });
      const message = error instanceof Error ? error.message : 'Could not play on Sonos';
      // An uncertain result must not carry permission to replace another app
      // into a later retry. Only a fresh conflict requests confirmation.
      const takeoverRequired = error instanceof SonosRequestError && error.status === 409 &&
        (error.code === undefined || error.code === 'takeover_required');
      usePlaybackTargetStore.getState().failSending(message, takeoverRequired);
      if (error instanceof SonosRequestError && error.code === 'shared_session_conflict') {
        await refreshSharedSession();
        useSharedSessionStore.setState({ error: 'Playback changed on another screen. Your song selection was not applied; please try again.' });
      }
      return false;
    }
  }, []);
}
