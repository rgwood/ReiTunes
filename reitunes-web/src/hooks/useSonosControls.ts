import { useCallback, useEffect, useRef, useState } from 'react';
import { SONOS_REALTIME_EVENT } from './useLibrary';
import { usePlaybackTargetStore, type PlaybackTarget } from '../stores/playbackTargetStore';
import type { SonosRealtimeUpdate } from '../types';
import { sonosRequest, SonosRequestError } from '../utils/sonosRequest';
import { recordPlaybackEvent } from '../utils/playbackDiagnostics';
import { useSonosVolume } from './useSonosVolume';

const PLAYBACK_POLL_MILLIS = 30_000;
const SEEK_SETTLE_MILLIS = 1_500;
const SEEK_RECHECK_MILLIS = 250;

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

interface ObservedPlayback extends SonosPlaybackStatus {
  observedAt: number;
}

interface SeekWork {
  value: number;
  itemId: string;
  sourceItemId?: string;
  target: PlaybackTarget;
  accepting: boolean;
  promise: Promise<void> | null;
}

export function useSonosControls(groupId: string | null) {
  const activeGroupRef = useRef(groupId);
  activeGroupRef.current = groupId;
  const playbackRevision = useRef(0);
  const latestPlayback = useRef<ObservedPlayback | null>(null);
  const [playback, setPlayback] = useState<ObservedPlayback | null>(null);
  const [positionMillis, setPositionMillis] = useState(0);
  const [playbackPollError, setPlaybackPollError] = useState<string | null>(null);
  const [commandError, setCommandError] = useState<string | null>(null);
  const { target: activeTarget, isTransportPending, setTransportPending: setIsTransportPending } = usePlaybackTargetStore();
  // Volume and transport commands share one error line, so either kind of
  // command clears the other's stale error.
  const groupVolume = useSonosVolume(groupId, 'group', {
    resetKey: activeTarget, onCommand: () => setCommandError(null),
  });
  const { clearCommandError: clearVolumeError } = groupVolume;
  const seekWork = useRef<SeekWork | null>(null);
  const [requestedSeekMillis, setRequestedSeekMillis] = useState<number | null>(null);

  const applyPlayback = useCallback((next: SonosPlaybackStatus, requestedGroup: string) => {
    if (activeGroupRef.current !== requestedGroup) return;
    const previous = latestPlayback.current;
    if (previous?.sourceItemId !== next.sourceItemId || previous?.playbackState !== next.playbackState || previous?.itemId !== next.itemId) {
      recordPlaybackEvent('media', { target: 'sonos', origin: 'sonos-observation',
        mediaEvent: 'playbackStatus', itemId: next.sourceItemId, previousItemId: previous?.sourceItemId,
        position: next.positionMillis / 1000, outcome: next.playbackState });
    }
    const work = seekWork.current;
    if (work && (!next.reitunesSessionActive || next.itemId !== work.itemId || next.sourceItemId !== work.sourceItemId)) {
      // A queued jump belongs to one queue item, never the next song/session.
      seekWork.current = null;
      setRequestedSeekMillis(null);
      if (usePlaybackTargetStore.getState().target === work.target) setIsTransportPending(false);
    }
    playbackRevision.current += 1;
    const observed = { ...next, observedAt: Date.now() };
    latestPlayback.current = observed;
    setPlayback(observed);
    setPositionMillis(next.positionMillis);
    setPlaybackPollError(null);
  }, [setIsTransportPending]);

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

  useEffect(() => {
    if (!groupId) return;
    const handleSonosEvent = (event: Event) => {
      const update = (event as CustomEvent<SonosRealtimeUpdate>).detail;
      if (update.targetId !== groupId) return;

      if (update.namespace === 'playback' && update.eventType === 'playbackStatus') {
        applyPlayback(update.payload as SonosPlaybackStatus, groupId);
      } else if (update.eventType.endsWith('Error')) {
        const payload = update.payload as { errorCode?: string; reason?: string };
        setCommandError(
          payload.reason || payload.errorCode || `Sonos reported ${update.eventType}`
        );
      }
    };
    window.addEventListener(SONOS_REALTIME_EVENT, handleSonosEvent);
    return () => window.removeEventListener(SONOS_REALTIME_EVENT, handleSonosEvent);
  }, [applyPlayback, groupId]);

  useEffect(() => {
    playbackRevision.current += 1;
    latestPlayback.current = null;
    setPlayback(null);
    setPositionMillis(0);
    setPlaybackPollError(null);
    setCommandError(null);
    seekWork.current = null;
    setRequestedSeekMillis(null);
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
      clearVolumeError();
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
        if (nextError instanceof SonosRequestError && nextError.status === 409 &&
          (nextError.code === undefined || nextError.code === 'takeover_required')) {
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
    [clearVolumeError, groupId, refreshPlayback, setIsTransportPending]
  );

  const seek = useCallback(async (position: number, options: { relative?: boolean; maxPositionMillis?: number } = {}) => {
    const output = usePlaybackTargetStore.getState();
    const observed = latestPlayback.current;
    const pending = seekWork.current;
    if (!groupId || output.target.kind !== 'sonos' || output.target.groupId !== groupId ||
      !observed?.reitunesSessionActive || !observed.itemId ||
      (pending && pending.target !== output.target) ||
      (output.isTransportPending && (!pending?.accepting || pending.target !== output.target)) ||
      output.isSending || output.isSwitchingOutput ||
      !Number.isFinite(position)) return;
    const elapsed = observed.playbackState === 'PLAYBACK_STATE_PLAYING' ? Math.max(0, Date.now() - observed.observedAt) : 0;
    const base = pending?.value ?? observed.positionMillis + elapsed;
    const limit = Number.isFinite(options.maxPositionMillis)
      ? Math.min(2_147_483_647, Math.max(0, Math.round(options.maxPositionMillis!))) : 2_147_483_647;
    const value = Math.min(limit, Math.max(0, Math.round(options.relative ? base + position : position)));
    setRequestedSeekMillis(value);
    setCommandError(null);
    clearVolumeError();
    playbackRevision.current += 1;
    if (pending) {
      pending.value = value;
      return pending.promise;
    }
    const work: SeekWork = { value, itemId: observed.itemId, sourceItemId: observed.sourceItemId,
      target: output.target, accepting: true, promise: null };
    seekWork.current = work;
    setIsTransportPending(true);
    const isCurrent = () => seekWork.current === work && usePlaybackTargetStore.getState().target === work.target;
    work.promise = (async () => {
      let readAttempted = false;
      try {
        while (isCurrent()) {
          const sending = work.value;
          const sentAt = Date.now();
          readAttempted = false;
          await sonosRequest(
            `/api/sonos/groups/${encodeURIComponent(groupId)}/playback/seek`,
            {
              method: 'POST', credentials: 'include',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ itemId: work.itemId, positionMillis: sending }),
            }
          );
          if (!isCurrent()) return;
          // Relative clicks accumulate in work.value, including synchronous
          // media-key repeats. Only send the latest destination after the ACK.
          if (work.value !== sending) continue;
          const settleUntil = Date.now() + SEEK_SETTLE_MILLIS;
          do {
            readAttempted = true;
            const confirmed = await refreshPlayback();
            if (!isCurrent()) return;
            if (work.value !== sending) break;
            const elapsed = confirmed?.playbackState === 'PLAYBACK_STATE_PLAYING' ? Date.now() - sentAt : 0;
            // ACKs can precede the position update. Give observations a brief
            // chance to catch up, without resending an uncertain seek command.
            if (confirmed && confirmed.positionMillis >= sending - 2_000 &&
              confirmed.positionMillis <= sending + elapsed + 2_000) break;
            if (Date.now() >= settleUntil) break;
            await new Promise(resolve => window.setTimeout(resolve, SEEK_RECHECK_MILLIS));
          } while (isCurrent() && work.value === sending);
          if (work.value === sending) break;
        }
      } catch (nextError) {
        if (!isCurrent()) return;
        work.accepting = false;
        setRequestedSeekMillis(null);
        if (nextError instanceof SonosRequestError && nextError.status === 409 &&
          (nextError.code === undefined || nextError.code === 'takeover_required')) {
          usePlaybackTargetStore.getState().failSending(nextError.message, true);
        }
        setCommandError(nextError instanceof Error ? nextError.message : 'Could not seek on Sonos');
        if (!readAttempted) await refreshPlayback().catch(() => undefined);
      } finally {
        if (isCurrent()) {
          seekWork.current = null;
          setRequestedSeekMillis(null);
          setIsTransportPending(false);
        }
      }
    })();
    return work.promise;
  }, [clearVolumeError, groupId, refreshPlayback, setIsTransportPending]);

  const play = useCallback(() => sendTransport('play'), [sendTransport]);
  const pause = useCallback(() => sendTransport('pause'), [sendTransport]);

  return {
    playback,
    positionMillis,
    volume: groupVolume.volume,
    error: commandError ?? groupVolume.commandError ?? playbackPollError ?? groupVolume.pollError,
    isTransportPending,
    isVolumePending: groupVolume.isPending,
    requestedVolume: groupVolume.requestedVolume,
    requestedSeekMillis,
    play,
    pause,
    seek,
    setGroupVolume: groupVolume.setVolume,
    setMuted: groupVolume.setMuted,
    refreshVolume: groupVolume.refresh,
    refreshPlayback,
  };
}
