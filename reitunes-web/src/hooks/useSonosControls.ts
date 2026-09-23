import { useCallback, useEffect, useRef, useState } from 'react';
import { SONOS_REALTIME_EVENT } from './useLibrary';
import { usePlaybackTargetStore } from '../stores/playbackTargetStore';
import type { SonosRealtimeUpdate } from '../types';
import { sonosRequest, SonosRequestError } from '../utils/sonosRequest';

const PLAYBACK_POLL_MILLIS = 30_000;
const VOLUME_POLL_MILLIS = 60_000;
const VOLUME_SETTLE_MILLIS = 1_500;
const VOLUME_RECHECK_MILLIS = 250;

export interface SonosPlaybackStatus {
  playbackState: string;
  positionMillis: number;
  itemId?: string;
  queueVersion?: string;
  sourceItemId?: string;
  reitunesSessionActive: boolean;
  availablePlaybackActions?: {
    canPause?: boolean;
  };
}

export interface SonosGroupVolume {
  volume: number;
  muted: boolean;
  fixed: boolean;
}

interface ObservedPlayback extends SonosPlaybackStatus {
  observedAt: number;
}

export function useSonosControls(groupId: string | null) {
  const activeGroupRef = useRef(groupId);
  activeGroupRef.current = groupId;
  const playbackRevision = useRef(0);
  const volumeRevision = useRef(0);
  const latestPlayback = useRef<SonosPlaybackStatus | null>(null);
  const [playback, setPlayback] = useState<ObservedPlayback | null>(null);
  const [positionMillis, setPositionMillis] = useState(0);
  const [volume, setVolumeState] = useState<SonosGroupVolume | null>(null);
  const [playbackPollError, setPlaybackPollError] = useState<string | null>(null);
  const [volumePollError, setVolumePollError] = useState<string | null>(null);
  const [commandError, setCommandError] = useState<string | null>(null);
  const { target: activeTarget, isTransportPending, setTransportPending: setIsTransportPending } = usePlaybackTargetStore();
  const [isVolumePending, setIsVolumePending] = useState(false);
  const [requestedVolume, setRequestedVolume] = useState<number | null>(null);
  const volumeWork = useRef<{ value: number; accepting: boolean; promise: Promise<void> | null } | null>(null);
  const volumeIntent = useRef<{ value: number; expiresAt: number } | null>(null);

  const applyPlayback = useCallback((next: SonosPlaybackStatus, requestedGroup: string) => {
    if (activeGroupRef.current !== requestedGroup) return;
    playbackRevision.current += 1;
    latestPlayback.current = next;
    const observed = { ...next, observedAt: Date.now() };
    setPlayback(observed);
    setPositionMillis(next.positionMillis);
    setPlaybackPollError(null);
  }, []);

  const applyVolume = useCallback((next: SonosGroupVolume, requestedGroup: string) => {
    if (activeGroupRef.current !== requestedGroup) return false;
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
    setVolumePollError(null);
    return true;
  }, []);

  const refreshPlayback = useCallback(async () => {
    if (!groupId) return;
    const requestedGroup = groupId;
    const revision = ++playbackRevision.current;
    const next = await sonosRequest<SonosPlaybackStatus>(
      `/api/sonos/groups/${encodeURIComponent(requestedGroup)}/playback`,
      {}, 20_000,
    ).catch(error => {
      if (revision === playbackRevision.current && activeGroupRef.current === requestedGroup) throw error;
      return null;
    });
    if (next && revision === playbackRevision.current) applyPlayback(next, requestedGroup);
    return activeGroupRef.current === requestedGroup ? latestPlayback.current : null;
  }, [applyPlayback, groupId]);

  const refreshVolume = useCallback(async () => {
    if (!groupId) return;
    const requestedGroup = groupId;
    const revision = ++volumeRevision.current;
    while (revision === volumeRevision.current && activeGroupRef.current === requestedGroup) {
      const next = await sonosRequest<SonosGroupVolume>(
        `/api/sonos/groups/${encodeURIComponent(requestedGroup)}/volume`,
        {}, 20_000,
      ).catch(error => {
        if (revision === volumeRevision.current && activeGroupRef.current === requestedGroup) throw error;
        return null;
      });
      if (!next || revision !== volumeRevision.current || activeGroupRef.current !== requestedGroup) return;
      if (applyVolume(next, requestedGroup)) return;
      if (volumeIntent.current?.expiresAt === Infinity) return; // The command will start its own readback.
      // Retry observations only, never the volume command. Once the grace
      // period expires, accept reality (including another controller's change).
      await new Promise(resolve => window.setTimeout(resolve, VOLUME_RECHECK_MILLIS));
    }
  }, [applyVolume, groupId]);

  useEffect(() => {
    if (!groupId) return;
    let refreshingVolume = false;
    const handleSonosEvent = (event: Event) => {
      const update = (event as CustomEvent<SonosRealtimeUpdate>).detail;
      if (update.targetId !== groupId) return;

      if (update.namespace === 'playback' && update.eventType === 'playbackStatus') {
        applyPlayback(update.payload as SonosPlaybackStatus, groupId);
      } else if (
        update.namespace === 'groupVolume' &&
        update.eventType === 'groupVolume'
      ) {
        const accepted = applyVolume(update.payload as SonosGroupVolume, groupId);
        if (!accepted && !volumeWork.current && !refreshingVolume) {
          refreshingVolume = true;
          void refreshVolume().catch(error => {
            if (activeGroupRef.current === groupId) {
              setVolumePollError(error instanceof Error ? error.message : 'Could not read Sonos volume');
            }
          }).finally(() => { refreshingVolume = false; });
        }
      } else if (update.eventType.endsWith('Error')) {
        const payload = update.payload as { errorCode?: string; reason?: string };
        setCommandError(
          payload.reason || payload.errorCode || `Sonos reported ${update.eventType}`
        );
      }
    };
    window.addEventListener(SONOS_REALTIME_EVENT, handleSonosEvent);
    return () => window.removeEventListener(SONOS_REALTIME_EVENT, handleSonosEvent);
  }, [applyPlayback, applyVolume, groupId, refreshVolume]);

  useEffect(() => {
    playbackRevision.current += 1;
    volumeRevision.current += 1;
    latestPlayback.current = null;
    setPlayback(null);
    setPositionMillis(0);
    setVolumeState(null);
    setPlaybackPollError(null);
    setVolumePollError(null);
    setCommandError(null);
    volumeWork.current = null;
    volumeIntent.current = null;
    setRequestedVolume(null);
    setIsVolumePending(false);
    if (!groupId) return;

    let pending = false;
    const refresh = () => {
      if (pending || document.visibilityState === 'hidden') return;
      pending = true;
      void refreshPlayback().catch((nextError) => {
        if (activeGroupRef.current === groupId) {
          setPlaybackPollError(nextError instanceof Error ? nextError.message : 'Could not read Sonos playback');
        }
      }).finally(() => { pending = false; });
    };
    refresh();
    const interval = window.setInterval(refresh, PLAYBACK_POLL_MILLIS);
    window.addEventListener('online', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('online', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [activeTarget, groupId, refreshPlayback]);

  useEffect(() => {
    if (!groupId) return;
    let pending = false;
    const refresh = () => {
      if (pending || document.visibilityState === 'hidden') return;
      pending = true;
      void refreshVolume().catch((nextError) => {
        if (activeGroupRef.current === groupId) {
          setVolumePollError(nextError instanceof Error ? nextError.message : 'Could not read Sonos volume');
        }
      }).finally(() => { pending = false; });
    };
    refresh();
    const interval = window.setInterval(refresh, VOLUME_POLL_MILLIS);
    window.addEventListener('online', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('online', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [groupId, refreshVolume]);

  useEffect(() => {
    if (!playback) return;
    setPositionMillis(playback.positionMillis);
    if (playback.playbackState !== 'PLAYBACK_STATE_PLAYING') return;

    const update = () => {
      const position = playback.positionMillis + Date.now() - playback.observedAt;
      setPositionMillis(position);
    };
    const interval = window.setInterval(update, 250);
    return () => window.clearInterval(interval);
  }, [playback]);

  const sendTransport = useCallback(
    async (command: 'play' | 'pause') => {
      const output = usePlaybackTargetStore.getState();
      if (!groupId || output.isTransportPending || output.isSending || output.isSwitchingOutput) return false;
      setIsTransportPending(true);
      setCommandError(null);
      playbackRevision.current += 1;
      const isCurrent = () => usePlaybackTargetStore.getState().target === output.target;

      let readAttempted = false;
      try {
        await sonosRequest(
          `/api/sonos/groups/${encodeURIComponent(groupId)}/playback/${command}`,
          { method: 'POST', credentials: 'include' }
        );
        readAttempted = true;
        await refreshPlayback();
      } catch (nextError) {
        if (!isCurrent()) return false;
        if (nextError instanceof SonosRequestError && nextError.status === 409) {
          usePlaybackTargetStore.getState().failSending(nextError.message, true);
        }
        // A lost reply is ambiguous: ask the speaker before showing a failure.
        const observed = readAttempted ? null : await refreshPlayback().catch(() => null);
        if (!isCurrent()) return false;
        const desiredState = command === 'play' ? 'PLAYBACK_STATE_PLAYING' : 'PLAYBACK_STATE_PAUSED';
        if (observed?.reitunesSessionActive && observed.playbackState === desiredState &&
          !(nextError instanceof SonosRequestError && nextError.status === 409)) return true;
        setCommandError(nextError instanceof Error ? nextError.message : `Could not ${command} Sonos`);
        return false;
      } finally {
        if (isCurrent()) setIsTransportPending(false);
      }
      return isCurrent();
    },
    [groupId, refreshPlayback, setIsTransportPending]
  );

  const setGroupVolume = useCallback(
    async (nextVolume: number) => {
      if (!groupId || !volume || volume.fixed || !Number.isFinite(nextVolume)) return;
      // Mute and failed-command recovery still need to finish before volume work.
      if (isVolumePending && !volumeWork.current?.accepting) return;
      const rounded = Math.min(100, Math.max(0, Math.round(nextVolume)));
      setRequestedVolume(rounded);
      setCommandError(null);
      volumeRevision.current += 1;
      volumeIntent.current = { value: rounded, expiresAt: Infinity };
      if (volumeWork.current) {
        volumeWork.current.value = rounded;
        return volumeWork.current.promise;
      }
      const work = { value: rounded, accepting: true, promise: null as Promise<void> | null };
      volumeWork.current = work;
      setIsVolumePending(true);
      const target = usePlaybackTargetStore.getState().target;
      const isCurrent = () => volumeWork.current === work && usePlaybackTargetStore.getState().target === target;
      work.promise = (async () => {
        let readAttempted = false;
        try {
          while (isCurrent()) {
            const sending = work.value;
            readAttempted = false;
            await sonosRequest(
              `/api/sonos/groups/${encodeURIComponent(groupId)}/volume`,
              { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ volume: sending }) },
            );
            if (!isCurrent()) return;
            // Keep only the latest requested level, not a queue of individual clicks.
            if (work.value !== sending) continue;
            volumeIntent.current = { value: sending, expiresAt: Date.now() + VOLUME_SETTLE_MILLIS };
            readAttempted = true;
            await refreshVolume();
            if (work.value === sending) break;
          }
        } catch (error) {
          if (!isCurrent()) return;
          work.accepting = false;
          volumeIntent.current = null;
          setRequestedVolume(null);
          setCommandError(error instanceof Error ? error.message : 'Could not change Sonos volume');
          if (!readAttempted) await refreshVolume().catch(() => undefined);
        } finally {
          if (isCurrent()) {
            volumeWork.current = null;
            setRequestedVolume(null);
            setIsVolumePending(false);
          }
        }
      })();
      return work.promise;
    },
    [groupId, isVolumePending, refreshVolume, volume]
  );

  const seek = useCallback(async (position: number) => {
    const output = usePlaybackTargetStore.getState();
    if (!groupId || !playback?.reitunesSessionActive || !playback.itemId ||
      output.isTransportPending || output.isSending || output.isSwitchingOutput ||
      !Number.isFinite(position)) return;
    setIsTransportPending(true);
    setCommandError(null);
    playbackRevision.current += 1;
    const isCurrent = () => usePlaybackTargetStore.getState().target === output.target;
    let readAttempted = false;
    try {
      await sonosRequest(
        `/api/sonos/groups/${encodeURIComponent(groupId)}/playback/seek`,
        {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ itemId: playback.itemId, positionMillis: Math.min(2_147_483_647, Math.max(0, Math.round(position))) }),
        }
      );
      readAttempted = true;
      await refreshPlayback();
    } catch (nextError) {
      if (!isCurrent()) return;
      if (nextError instanceof SonosRequestError && nextError.status === 409) {
        usePlaybackTargetStore.getState().failSending(nextError.message, true);
      }
      setCommandError(nextError instanceof Error ? nextError.message : 'Could not seek on Sonos');
      if (!readAttempted) await refreshPlayback().catch(() => undefined);
    } finally {
      if (isCurrent()) setIsTransportPending(false);
    }
  }, [groupId, playback, refreshPlayback, setIsTransportPending]);

  const setMuted = useCallback(
    async (muted: boolean) => {
      if (!groupId || isVolumePending || volume?.fixed) return;
      setIsVolumePending(true);
      setCommandError(null);
      volumeRevision.current += 1;
      volumeIntent.current = null;
      const target = usePlaybackTargetStore.getState().target;
      const isCurrent = () => usePlaybackTargetStore.getState().target === target;
      let readAttempted = false;
      try {
        await sonosRequest(
          `/api/sonos/groups/${encodeURIComponent(groupId)}/mute`,
          {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ muted }),
          }
        );
        readAttempted = true;
        await refreshVolume();
      } catch (nextError) {
        if (!isCurrent()) return;
        setCommandError(nextError instanceof Error ? nextError.message : 'Could not change Sonos mute');
        if (!readAttempted) await refreshVolume().catch(() => undefined);
      } finally {
        if (isCurrent()) setIsVolumePending(false);
      }
    },
    [groupId, isVolumePending, refreshVolume, volume?.fixed]
  );

  const play = useCallback(() => sendTransport('play'), [sendTransport]);
  const pause = useCallback(() => sendTransport('pause'), [sendTransport]);

  return {
    playback,
    positionMillis,
    volume,
    error: commandError ?? playbackPollError ?? volumePollError,
    isTransportPending,
    isVolumePending,
    requestedVolume,
    play,
    pause,
    seek,
    setGroupVolume,
    setMuted,
    refreshPlayback,
  };
}
