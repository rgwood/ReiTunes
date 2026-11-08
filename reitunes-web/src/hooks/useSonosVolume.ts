import { useCallback, useEffect, useRef, useState } from 'react';
import { SONOS_REALTIME_EVENT } from './useLibrary';
import { usePlaybackTargetStore } from '../stores/playbackTargetStore';
import type { SonosRealtimeUpdate } from '../types';
import { sonosRequest } from '../utils/sonosRequest';

const VOLUME_POLL_MILLIS = 60_000;
const VOLUME_SETTLE_MILLIS = 1_500;
const VOLUME_RECHECK_MILLIS = 250;

export interface SonosVolume {
  volume: number;
  muted: boolean;
  fixed: boolean;
}

export type SonosVolumeScope = 'group' | 'player';

const scopes = {
  group: { path: 'groups', namespace: 'groupVolume' },
  player: { path: 'players', namespace: 'playerVolume' },
} as const;

/**
 * Volume and mute for one Sonos group or player. Groups and players share a
 * volume API shape, so they also share the command coalescing and readback.
 *
 * `resetKey` clears in-flight work and observations when it changes, on top
 * of `targetId` changing. `onCommand` runs whenever a volume or mute command
 * starts, so a caller can clear errors it reports alongside this hook's.
 */
export function useSonosVolume(
  targetId: string | null,
  scope: SonosVolumeScope,
  { resetKey, onCommand }: { resetKey?: unknown; onCommand?: () => void } = {},
) {
  const { path, namespace } = scopes[scope];
  const activeTargetRef = useRef(targetId);
  activeTargetRef.current = targetId;
  const onCommandRef = useRef(onCommand);
  onCommandRef.current = onCommand;
  const volumeRevision = useRef(0);
  const [volume, setVolumeState] = useState<SonosVolume | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [commandError, setCommandError] = useState<string | null>(null);
  const [isPending, setIsPending] = useState(false);
  const [requestedVolume, setRequestedVolume] = useState<number | null>(null);
  const volumeWork = useRef<{ value: number; accepting: boolean; promise: Promise<void> | null } | null>(null);
  const volumeIntent = useRef<{ value: number; expiresAt: number } | null>(null);
  const url = targetId ? `/api/sonos/${path}/${encodeURIComponent(targetId)}` : null;

  const startCommand = useCallback(() => {
    setCommandError(null);
    onCommandRef.current?.();
  }, []);

  const applyVolume = useCallback((next: SonosVolume, requestedTarget: string) => {
    if (activeTargetRef.current !== requestedTarget) return false;
    const intent = volumeIntent.current;
    // Group members settle separately; a command ACK (or even a matching GET)
    // can be followed by an intermediate event from an earlier adjustment.
    if (intent && Date.now() < intent.expiresAt && next.volume !== intent.value && !next.fixed) {
      setVolumeState({ ...next, volume: intent.value });
      return false;
    }
    if (intent && (next.fixed || Date.now() >= intent.expiresAt)) volumeIntent.current = null;
    volumeRevision.current += 1;
    setVolumeState(next);
    setPollError(null);
    return true;
  }, []);

  const refresh = useCallback(async () => {
    if (!targetId || !url) return;
    const requestedTarget = targetId;
    const revision = ++volumeRevision.current;
    while (revision === volumeRevision.current && activeTargetRef.current === requestedTarget) {
      const next = await sonosRequest<SonosVolume>(`${url}/volume`, {}, 20_000).catch(error => {
        if (revision === volumeRevision.current && activeTargetRef.current === requestedTarget) throw error;
        return null;
      });
      if (!next || revision !== volumeRevision.current || activeTargetRef.current !== requestedTarget) return;
      if (applyVolume(next, requestedTarget)) return;
      if (volumeIntent.current?.expiresAt === Infinity) return; // The command will start its own readback.
      // Retry observations only, never the volume command. Once the grace
      // period expires, accept reality (including another controller's change).
      await new Promise(resolve => window.setTimeout(resolve, VOLUME_RECHECK_MILLIS));
    }
  }, [applyVolume, targetId, url]);

  useEffect(() => {
    if (!targetId) return;
    let refreshing = false;
    const handleSonosEvent = (event: Event) => {
      const update = (event as CustomEvent<SonosRealtimeUpdate>).detail;
      if (update.targetId !== targetId || update.namespace !== namespace || update.eventType !== namespace) return;
      const accepted = applyVolume(update.payload as SonosVolume, targetId);
      if (!accepted && !volumeWork.current && !refreshing) {
        refreshing = true;
        void refresh().catch(error => {
          if (activeTargetRef.current === targetId) {
            setPollError(error instanceof Error ? error.message : 'Could not read Sonos volume');
          }
        }).finally(() => { refreshing = false; });
      }
    };
    window.addEventListener(SONOS_REALTIME_EVENT, handleSonosEvent);
    return () => window.removeEventListener(SONOS_REALTIME_EVENT, handleSonosEvent);
  }, [applyVolume, namespace, refresh, targetId]);

  useEffect(() => {
    volumeRevision.current += 1;
    setVolumeState(null);
    setPollError(null);
    setCommandError(null);
    volumeWork.current = null;
    volumeIntent.current = null;
    setRequestedVolume(null);
    setIsPending(false);
    if (!targetId) return;

    let pending = false;
    const poll = () => {
      if (pending || document.visibilityState === 'hidden') return;
      pending = true;
      void refresh().catch((nextError) => {
        if (activeTargetRef.current === targetId) {
          setPollError(nextError instanceof Error ? nextError.message : 'Could not read Sonos volume');
        }
      }).finally(() => { pending = false; });
    };
    poll();
    const interval = window.setInterval(poll, VOLUME_POLL_MILLIS);
    window.addEventListener('online', poll);
    document.addEventListener('visibilitychange', poll);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('online', poll);
      document.removeEventListener('visibilitychange', poll);
    };
  }, [refresh, resetKey, targetId]);

  const setVolume = useCallback(
    async (nextVolume: number) => {
      if (!url || !volume || volume.fixed || !Number.isFinite(nextVolume)) return;
      // Mute and failed-command recovery still need to finish before volume work.
      if (isPending && !volumeWork.current?.accepting) return;
      const rounded = Math.min(100, Math.max(0, Math.round(nextVolume)));
      setRequestedVolume(rounded);
      startCommand();
      volumeRevision.current += 1;
      volumeIntent.current = { value: rounded, expiresAt: Infinity };
      if (volumeWork.current) {
        volumeWork.current.value = rounded;
        return volumeWork.current.promise;
      }
      const work = { value: rounded, accepting: true, promise: null as Promise<void> | null };
      volumeWork.current = work;
      setIsPending(true);
      const target = usePlaybackTargetStore.getState().target;
      const isCurrent = () => volumeWork.current === work && usePlaybackTargetStore.getState().target === target;
      work.promise = (async () => {
        let readAttempted = false;
        try {
          while (isCurrent()) {
            const sending = work.value;
            readAttempted = false;
            await sonosRequest(
              `${url}/volume`,
              { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ volume: sending }) },
            );
            if (!isCurrent()) return;
            // Keep only the latest requested level, not a queue of individual clicks.
            if (work.value !== sending) continue;
            volumeIntent.current = { value: sending, expiresAt: Date.now() + VOLUME_SETTLE_MILLIS };
            readAttempted = true;
            await refresh();
            if (work.value === sending) break;
          }
        } catch (error) {
          if (!isCurrent()) return;
          work.accepting = false;
          volumeIntent.current = null;
          setRequestedVolume(null);
          setCommandError(error instanceof Error ? error.message : 'Could not change Sonos volume');
          if (!readAttempted) await refresh().catch(() => undefined);
        } finally {
          if (isCurrent()) {
            volumeWork.current = null;
            setRequestedVolume(null);
            setIsPending(false);
          }
        }
      })();
      return work.promise;
    },
    [isPending, refresh, startCommand, url, volume]
  );

  const setMuted = useCallback(
    async (muted: boolean) => {
      if (!url || isPending || volume?.fixed) return;
      setIsPending(true);
      startCommand();
      volumeRevision.current += 1;
      volumeIntent.current = null;
      const target = usePlaybackTargetStore.getState().target;
      const isCurrent = () => usePlaybackTargetStore.getState().target === target;
      let readAttempted = false;
      try {
        await sonosRequest(
          `${url}/mute`,
          {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ muted }),
          }
        );
        readAttempted = true;
        await refresh();
      } catch (nextError) {
        if (!isCurrent()) return;
        setCommandError(nextError instanceof Error ? nextError.message : 'Could not change Sonos mute');
        if (!readAttempted) await refresh().catch(() => undefined);
      } finally {
        if (isCurrent()) setIsPending(false);
      }
    },
    [isPending, refresh, startCommand, url, volume?.fixed]
  );

  return {
    volume,
    requestedVolume,
    isPending,
    commandError,
    pollError,
    clearCommandError: useCallback(() => setCommandError(null), []),
    refresh,
    setVolume,
    setMuted,
  };
}
