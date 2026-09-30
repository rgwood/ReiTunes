import { useCallback, useEffect, useRef, useState } from 'react';
import { usePlayback } from './usePlayback';
import { useQueueStore } from './useQueue';
import { refreshSharedSession } from './useSharedPlaybackSession';
import { usePlaybackTargetStore } from '../stores/playbackTargetStore';
import { usePlayerStore } from '../stores/playerStore';
import { canEditSharedSession, useSharedSessionStore } from '../stores/sharedSessionStore';
import { recordPlaybackEvent } from '../utils/playbackDiagnostics';

export function useTrackNavigation() {
  const play = usePlayback();
  const inFlight = useRef(false);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!notice || pending) return;
    const timer = window.setTimeout(() => setNotice(null), 5000);
    return () => window.clearTimeout(timer);
  }, [notice, pending]);
  const navigate = useCallback(async (direction: 'next' | 'previous') => {
    const target = usePlaybackTargetStore.getState().target;
    const started = performance.now();
    const operationId = crypto.randomUUID();
    const trace = (outcome: string) => {
      const session = useSharedSessionStore.getState();
      const queue = useQueueStore.getState();
      recordPlaybackEvent('command', { origin: direction, target: target.kind, operationId, outcome,
        itemId: usePlayerStore.getState().currentItemId, elapsedMs: Math.round(performance.now() - started),
        expectedRevision: session.revision, contextCount: queue.contextItems.length,
        manualQueueCount: queue.manualQueue.length, sessionReady: session.ready,
        sessionConnected: session.connected, sessionRefreshing: session.refreshing });
    };
    const busy = () => {
      const output = usePlaybackTargetStore.getState();
      return output.isSending || output.isSwitchingOutput || output.isTransportPending;
    };
    if (inFlight.current || busy()) { trace('blocked-busy'); return; }
    inFlight.current = true;
    setPending(true); setNotice(null);
    trace('requested');
    try {
      // A waking controller must read the latest queue first. Remember this
      // one press instead of silently dropping it while that read is pending.
      if (useSharedSessionStore.getState().refreshing) {
        setNotice('Updating playback before changing songs…');
        trace('waiting-for-session');
        await refreshSharedSession();
      }
      if (usePlaybackTargetStore.getState().target !== target) {
        setNotice('Playback output changed. Press Next or Previous again.');
        trace('cancelled-output-changed'); return;
      }
      if (!canEditSharedSession() || !useSharedSessionStore.getState().ready) {
        setNotice('Could not update playback. Reconnect and try again.');
        trace('blocked-session'); return;
      }
      if (busy()) { setNotice('Playback is changing. Please try again.'); trace('blocked-busy'); return; }
      const queue = useQueueStore.getState();
      const item = direction === 'next' ? queue.playNext() : queue.playPrevious();
      if (!item) {
        setNotice(direction === 'next' ? 'No more songs in Up Next.' : 'No previous song in this queue.');
        trace('queue-empty'); return;
      }
      setNotice(null);
      const applied = await play(item, 0, direction);
      trace(applied ? 'completed' : 'failed');
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }, [play]);
  return { navigate, pending, notice };
}
