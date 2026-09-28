import { useEffect, useRef, useState } from 'react';
import { useQueueStore } from './useQueue';
import { usePlaybackTargetStore, type PlaybackTarget } from '../stores/playbackTargetStore';
import type { SonosPlaybackStatus } from './useSonosControls';
import { sonosRequest, SonosRequestError } from '../utils/sonosRequest';
import { acknowledgeSonosQueue, useSharedSessionStore } from '../stores/sharedSessionStore';
import { retrySharedQueueSync } from './useSharedPlaybackSession';

// Queue edits change the cloud queue in place. Loading a new queue here would
// restart the current song and could resume a paused speaker.
export function useSonosQueueSync(playback: SonosPlaybackStatus | null, refreshPlayback: () => Promise<unknown>) {
  const { target, isSending, isSwitchingOutput } = usePlaybackTargetStore();
  const editVersion = useQueueStore(state => state.editVersion);
  const session = useSharedSessionStore();
  const syncVersion = session.enabled ? session.queueSyncVersion : editVersion;
  const synced = useRef(syncVersion);
  const previousTarget = useRef(target);
  const pending = useRef(false);
  const [error, setError] = useState<{ target: PlaybackTarget; message: string } | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (previousTarget.current !== target) {
      previousTarget.current = target;
      synced.current = syncVersion;
    }
    // The server projects the durable shared queue to Sonos, including after
    // this controller closes. Attaching another screen never sends a queue.
    if (session.enabled) return;
    if (session.enabled) synced.current = Math.max(synced.current, session.sonosAppliedVersion);
    if (target.kind !== 'sonos' || pending.current || isSending || isSwitchingOutput ||
        synced.current === syncVersion || !playback?.reitunesSessionActive ||
        !playback.itemId || !playback.queueVersion) return;

    const timer = setTimeout(() => {
      const queue = useQueueStore.getState();
      const currentSession = useSharedSessionStore.getState();
      const version = currentSession.enabled ? currentSession.queueSyncVersion : queue.editVersion;
      const itemIds = [...queue.manualQueue, ...queue.getUpcomingContext()].map(item => item.id).slice(0, 499);
      pending.current = true;
      synced.current = version;
      setError(null);
      void sonosRequest(`/api/sonos/groups/${encodeURIComponent(target.groupId)}/queue`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ itemId: playback.itemId, queueVersion: playback.queueVersion, itemIds }),
      }, 50_000).then(async () => {
        acknowledgeSonosQueue(version);
        if (usePlaybackTargetStore.getState().target === target) await refreshPlayback();
      }).catch(async error => {
        if (error instanceof SonosRequestError && error.status === 409 &&
            usePlaybackTargetStore.getState().target === target) {
          await refreshPlayback().catch(() => undefined);
        }
        if (usePlaybackTargetStore.getState().target === target) {
          setError({ target, message: `Could not update the Sonos queue. ${error instanceof Error ? error.message : ''}` });
        }
      }).finally(() => {
        pending.current = false;
        setAttempt(value => value + 1);
      });
    }, 150);
    return () => clearTimeout(timer);
  }, [target, isSending, isSwitchingOutput, syncVersion, session.enabled, session.ready,
    session.refreshing, session.sonosAppliedVersion, playback, attempt, refreshPlayback]);

  return { error: session.enabled ? session.queueSyncError : error?.target === target ? error.message : null,
    retry: () => { if (session.enabled) { void retrySharedQueueSync(); return; }
      synced.current = -1; setAttempt(value => value + 1); } };
}
