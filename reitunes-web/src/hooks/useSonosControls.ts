import { useCallback, useEffect, useRef, useState } from 'react';
import { usePlaybackTargetStore } from '../stores/playbackTargetStore';

const PLAYBACK_POLL_MILLIS = 2_000;
const VOLUME_POLL_MILLIS = 10_000;

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

async function responseError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string };
    return body.error || `Request failed (${response.status})`;
  } catch {
    return `Request failed (${response.status})`;
  }
}

export function useSonosControls(groupId: string | null) {
  const activeGroupRef = useRef(groupId);
  activeGroupRef.current = groupId;
  const positionRef = useRef(0);
  const [playback, setPlayback] = useState<ObservedPlayback | null>(null);
  const [positionMillis, setPositionMillis] = useState(0);
  const [volume, setVolumeState] = useState<SonosGroupVolume | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [commandError, setCommandError] = useState<string | null>(null);
  const [isTransportPending, setIsTransportPending] = useState(false);
  const [isVolumePending, setIsVolumePending] = useState(false);

  const refreshPlayback = useCallback(async () => {
    if (!groupId) return;
    const requestedGroup = groupId;
    const response = await fetch(
      `/api/sonos/groups/${encodeURIComponent(requestedGroup)}/playback`,
      { credentials: 'include' }
    );
    if (!response.ok) throw new Error(await responseError(response));
    const next = (await response.json()) as SonosPlaybackStatus;
    if (activeGroupRef.current !== requestedGroup) return;
    const observed = { ...next, observedAt: Date.now() };
    setPlayback(observed);
    positionRef.current = next.positionMillis;
    setPositionMillis(next.positionMillis);
    setPollError(null);
  }, [groupId]);

  const refreshVolume = useCallback(async () => {
    if (!groupId) return;
    const requestedGroup = groupId;
    const response = await fetch(
      `/api/sonos/groups/${encodeURIComponent(requestedGroup)}/volume`,
      { credentials: 'include' }
    );
    if (!response.ok) throw new Error(await responseError(response));
    const next = (await response.json()) as SonosGroupVolume;
    if (activeGroupRef.current !== requestedGroup) return;
    setVolumeState(next);
    setPollError(null);
  }, [groupId]);

  useEffect(() => {
    if (!groupId) {
      setPlayback(null);
      setPositionMillis(0);
      setVolumeState(null);
      setPollError(null);
      setCommandError(null);
      return;
    }

    const refresh = () => {
      void refreshPlayback().catch((nextError) => {
        if (activeGroupRef.current === groupId) {
          setPollError(nextError instanceof Error ? nextError.message : 'Could not read Sonos playback');
        }
      });
    };
    refresh();
    const interval = window.setInterval(refresh, PLAYBACK_POLL_MILLIS);
    return () => window.clearInterval(interval);
  }, [groupId, refreshPlayback]);

  useEffect(() => {
    if (!groupId) return;
    const refresh = () => {
      void refreshVolume().catch((nextError) => {
        if (activeGroupRef.current === groupId) {
          setPollError(nextError instanceof Error ? nextError.message : 'Could not read Sonos volume');
        }
      });
    };
    refresh();
    const interval = window.setInterval(refresh, VOLUME_POLL_MILLIS);
    return () => window.clearInterval(interval);
  }, [groupId, refreshVolume]);

  useEffect(() => {
    if (!playback) return;
    positionRef.current = playback.positionMillis;
    setPositionMillis(playback.positionMillis);
    if (playback.playbackState !== 'PLAYBACK_STATE_PLAYING') return;

    const update = () => {
      const position = playback.positionMillis + Date.now() - playback.observedAt;
      positionRef.current = position;
      setPositionMillis(position);
    };
    const interval = window.setInterval(update, 250);
    return () => window.clearInterval(interval);
  }, [playback]);

  const sendTransport = useCallback(
    async (command: 'play' | 'pause') => {
      if (!groupId || isTransportPending) return;
      setIsTransportPending(true);
      setCommandError(null);
      if (playback) {
        setPlayback({
          ...playback,
          playbackState:
            command === 'play' ? 'PLAYBACK_STATE_PLAYING' : 'PLAYBACK_STATE_PAUSED',
          positionMillis: positionRef.current,
          observedAt: Date.now(),
        });
      }

      try {
        const response = await fetch(
          `/api/sonos/groups/${encodeURIComponent(groupId)}/playback/${command}`,
          { method: 'POST', credentials: 'include' }
        );
        if (!response.ok) {
          const message = await responseError(response);
          if (response.status === 409) {
            usePlaybackTargetStore.getState().failSending(message, true);
          }
          throw new Error(message);
        }
        await refreshPlayback();
      } catch (nextError) {
        setCommandError(nextError instanceof Error ? nextError.message : `Could not ${command} Sonos`);
      } finally {
        setIsTransportPending(false);
      }
    },
    [groupId, isTransportPending, playback, refreshPlayback]
  );

  const setGroupVolume = useCallback(
    async (nextVolume: number) => {
      if (!groupId || isVolumePending || volume?.fixed) return;
      const rounded = Math.min(100, Math.max(0, Math.round(nextVolume)));
      setIsVolumePending(true);
      setCommandError(null);
      setVolumeState((current) =>
        current ? { ...current, volume: rounded, muted: false } : current
      );
      try {
        const response = await fetch(
          `/api/sonos/groups/${encodeURIComponent(groupId)}/volume`,
          {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ volume: rounded }),
          }
        );
        if (!response.ok) throw new Error(await responseError(response));
        await refreshVolume();
      } catch (nextError) {
        setCommandError(nextError instanceof Error ? nextError.message : 'Could not change Sonos volume');
        await refreshVolume().catch(() => undefined);
      } finally {
        setIsVolumePending(false);
      }
    },
    [groupId, isVolumePending, refreshVolume, volume?.fixed]
  );

  const setMuted = useCallback(
    async (muted: boolean) => {
      if (!groupId || isVolumePending || volume?.fixed) return;
      setIsVolumePending(true);
      setCommandError(null);
      setVolumeState((current) => (current ? { ...current, muted } : current));
      try {
        const response = await fetch(
          `/api/sonos/groups/${encodeURIComponent(groupId)}/mute`,
          {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ muted }),
          }
        );
        if (!response.ok) throw new Error(await responseError(response));
        await refreshVolume();
      } catch (nextError) {
        setCommandError(nextError instanceof Error ? nextError.message : 'Could not change Sonos mute');
        await refreshVolume().catch(() => undefined);
      } finally {
        setIsVolumePending(false);
      }
    },
    [groupId, isVolumePending, refreshVolume, volume?.fixed]
  );

  return {
    playback,
    positionMillis,
    volume,
    error: commandError ?? pollError,
    isTransportPending,
    isVolumePending,
    play: () => sendTransport('play'),
    pause: () => sendTransport('pause'),
    setGroupVolume,
    setMuted,
  };
}
