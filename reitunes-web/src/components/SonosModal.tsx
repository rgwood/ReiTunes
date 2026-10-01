import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { usePlaybackTargetStore } from '../stores/playbackTargetStore';
import { usePlayerStore } from '../stores/playerStore';
import type { LibraryItem } from '../types';
import type { SonosPlaybackStatus } from '../hooks/useSonosControls';
import { sendSonosQueue } from '../hooks/usePlayback';
import { recordPlaybackEvent } from '../utils/playbackDiagnostics';
import { sonosRequest, SonosRequestError } from '../utils/sonosRequest';
import { canEditSharedSession, ownsBrowserPlayback, useSharedSessionStore } from '../stores/sharedSessionStore';
import { flushSharedSession, refreshSharedSession, stageSharedPlayback } from '../hooks/useSharedPlaybackSession';
import './SonosModal.css';
import { requestConfirmation } from '../stores/dialogStore';

interface SonosStatus {
  configured: boolean;
  connected: boolean;
}

interface SonosHousehold {
  id: string;
}

interface SonosGroup {
  id: string;
  name: string;
  coordinatorId: string;
  playerIds: string[];
  playbackState?: string;
}

interface SonosPlayer {
  id: string;
  name: string;
  capabilities: string[];
}

interface GroupsResponse {
  groups: SonosGroup[];
  players: SonosPlayer[];
}

interface DiscoveredHousehold {
  household: SonosHousehold;
  discovery: GroupsResponse;
}

interface SonosModalProps {
  audioRef: RefObject<HTMLAudioElement | null>;
  isOpen: boolean;
  onClose: () => void;
  items: LibraryItem[];
}

async function fetchJson<T>(url: string): Promise<T> {
  return sonosRequest<T>(url, {}, 20_000);
}

async function pauseSonosForHandoff(groupId: string) {
  const url = `/api/sonos/groups/${encodeURIComponent(groupId)}/playback`;
  const before = await fetchJson<SonosPlaybackStatus>(url);
  const wasPlaying = before.playbackState === 'PLAYBACK_STATE_PLAYING' ||
    before.playbackState === 'PLAYBACK_STATE_BUFFERING';
  let playback = before;
  if (before.reitunesSessionActive && wasPlaying) {
    await sonosRequest(`${url}/pause`, { method: 'POST', credentials: 'include' });
    playback = await fetchJson<SonosPlaybackStatus>(url).catch(() => before);
  }
  return { playback, wasPlaying };
}

export function SonosModal({ audioRef, isOpen, onClose, items }: SonosModalProps) {
  const session = useSharedSessionStore();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [status, setStatus] = useState<SonosStatus | null>(null);
  const [households, setHouseholds] = useState<DiscoveredHousehold[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const {
    target,
    takeoverRequired,
    error: playbackError,
    setBrowserTarget,
    setSonosTarget,
    isSending,
    isSwitchingOutput,
    isTransportPending,
  } =
    usePlaybackTargetStore();

  const discover = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const nextStatus = await fetchJson<SonosStatus>('/api/sonos/status');
      setStatus(nextStatus);
      if (!nextStatus.connected) {
        setHouseholds([]);
        return;
      }

      const householdResponse = await fetchJson<{ households: SonosHousehold[] }>(
        '/api/sonos/households'
      );
      const discovered = await Promise.all(
        householdResponse.households.map(async (household) => ({
          household,
          discovery: await fetchJson<GroupsResponse>(
            `/api/sonos/households/${encodeURIComponent(household.id)}/groups`
          ),
        }))
      );
      setHouseholds(discovered);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not discover Sonos speakers');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isOpen) void discover();
  }, [discover, isOpen]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (isOpen && !dialog.open) dialog.showModal();
    if (!isOpen && dialog.open) dialog.close();
  }, [isOpen]);

  const disconnect = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      await sonosRequest('/api/sonos/connection', {
        method: 'DELETE',
        credentials: 'include',
      });
      setStatus({ configured: true, connected: false });
      setHouseholds([]);
      setBrowserTarget();
      stageSharedPlayback();
      await flushSharedSession();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not disconnect Sonos');
    } finally {
      setIsLoading(false);
    }
  }, [setBrowserTarget]);

  const chooseBrowser = useCallback(async () => {
    const output = usePlaybackTargetStore.getState();
    if (!canEditSharedSession() || ownsBrowserPlayback(output.target) || output.isSending || output.isSwitchingOutput || output.isTransportPending) return;
    output.setSwitchingOutput(true);
    setError(null);
    recordPlaybackEvent('command', { origin: 'handoff-to-browser', target: 'sonos' });
    try {
      const player = usePlayerStore.getState();
      const snapshot = output.target.kind === 'sonos' ? await pauseSonosForHandoff(output.target.groupId) : null;
      const item = snapshot ? snapshot.playback.reitunesSessionActive
        ? items.find(candidate => candidate.id === snapshot.playback.sourceItemId) : undefined : player.currentItem;
      const position = snapshot ? snapshot.playback.positionMillis / 1000 : player.resumePosition;
      const wasPlaying = snapshot?.wasPlaying ?? false;
      // Commit the output only after pause succeeds, so a failed request cannot
      // leave both outputs playing. A paused Sonos session stays paused locally.
      if (item) {
        player.selectRemoteItem(item, position);
      } else {
        player.setIsPlaying(false);
      }
      setBrowserTarget();
      stageSharedPlayback();
      if (!await flushSharedSession()) throw new Error('The shared session changed. Please try again.');
      if (item) {
        player.play(item, position);
        player.setIsPlaying(wasPlaying);
      }
      recordPlaybackEvent('command', {
        origin: 'handoff-complete', target: 'browser', itemId: item?.id,
        position: item ? position : undefined,
        isPlaying: !!item && wasPlaying,
      });
      onClose();
    } catch (err) {
      setError(`Could not switch to this browser: ${err instanceof Error ? err.message : 'Sonos did not respond'}`);
      recordPlaybackEvent('play-rejected', {
        origin: 'handoff-to-browser', target: 'sonos',
        errorName: err instanceof Error ? err.name : 'UnknownError',
      });
    } finally {
      output.setSwitchingOutput(false);
    }
  }, [items, onClose, setBrowserTarget]);

  const chooseGroup = useCallback(
    async (
      household: SonosHousehold,
      group: SonosGroup,
      players: Map<string, SonosPlayer>
    ) => {
      let output = usePlaybackTargetStore.getState();
      if (!canEditSharedSession() || output.isSending || output.isSwitchingOutput || output.isTransportPending) return;
      const playerNames = group.playerIds.map(
        (playerId) => players.get(playerId)?.name || playerId
      );
      const isAlreadySelected = target.kind === 'sonos' && target.groupId === group.id;
      const isBusy =
        group.playbackState !== undefined &&
        group.playbackState !== 'PLAYBACK_STATE_IDLE';
      if (isBusy || (isAlreadySelected && takeoverRequired && playbackError !== null)) {
        if (!await requestConfirmation({
          title: 'Replace Sonos queue?',
          message: `${group.name} may already be in use. Playing from ReiTunes will replace its current Sonos queue.`,
          actionLabel: 'Replace Sonos queue',
        })) return;
        // Playback can change on another screen while this dialog is open.
        output = usePlaybackTargetStore.getState();
        if (!canEditSharedSession() || output.isSending || output.isSwitchingOutput || output.isTransportPending) return;
      }

      output.setSwitchingOutput(true);
      setError(null);
      try {
        const player = usePlayerStore.getState();
        let item = player.currentItem;
        let position = player.pendingSeek ?? (ownsBrowserPlayback(output.target)
          ? audioRef.current?.currentTime ?? player.resumePosition : player.resumePosition);
        let wasPlaying = player.isPlaying;
        if (output.target.kind === 'sonos') {
          const snapshot = await pauseSonosForHandoff(output.target.groupId);
          item = snapshot.playback.reitunesSessionActive
            ? items.find(candidate => candidate.id === snapshot.playback.sourceItemId) ?? null
            : null;
          position = snapshot.playback.positionMillis / 1000;
          wasPlaying = snapshot.wasPlaying;
        } else {
          // Read the media element directly: persisted progress can be five seconds old.
          audioRef.current?.pause();
        }
        player.setIsPlaying(false);
        setSonosTarget({
          householdId: household.id, groupId: group.id, groupName: group.name, playerNames,
        });
        if (item) player.selectRemoteItem(item, position);
        stageSharedPlayback();
        if (!await flushSharedSession()) throw new Error('The shared session changed. Please try again.');
        if (item) {
          const next = usePlaybackTargetStore.getState();
          if (next.target.kind !== 'sonos') return;
          next.beginSending();
          try {
            await sendSonosQueue(item, position, next.target, next.takeoverRequired, wasPlaying);
            if (usePlaybackTargetStore.getState().target !== next.target) return;
            next.finishSending();
          } catch (err) {
            if (usePlaybackTargetStore.getState().target !== next.target) return;
            next.failSending(
              err instanceof Error ? err.message : 'Could not transfer playback to Sonos',
              err instanceof SonosRequestError && err.status === 409 &&
                (err.code === undefined || err.code === 'takeover_required'),
            );
            if (err instanceof SonosRequestError && err.code === 'shared_session_conflict') await refreshSharedSession();
            throw err;
          }
        }
        onClose();
      } catch (err) {
        setError(`Could not switch to Sonos: ${err instanceof Error ? err.message : 'Sonos did not respond'}`);
      } finally {
        output.setSwitchingOutput(false);
      }
    },
    [audioRef, items, onClose, playbackError, setSonosTarget, takeoverRequired, target]
  );

  return (
    <dialog
      ref={dialogRef}
      className="sonos-dialog"
      aria-labelledby="sonos-heading"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="bg-solarized-base02 border border-solarized-blue rounded-lg p-6 w-full max-h-[80vh] flex flex-col"
      >
        <div className="flex justify-between items-center mb-4">
          <div>
            <h2 id="sonos-heading" className="text-lg text-solarized-base1">
              Sonos
            </h2>
            <p className="text-xs text-solarized-base0 mt-1">
              Switching speakers keeps your current track, position, and play/pause state.
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-solarized-base0 hover:text-solarized-base1"
            aria-label="Close Sonos"
          >
            &#10005;
          </button>
        </div>

        <div className="overflow-y-auto">
          <div
            className={`border rounded p-3 mb-4 flex items-center justify-between gap-4 ${
              ownsBrowserPlayback(target)
                ? 'border-solarized-cyan bg-solarized-base03'
                : 'border-solarized-base01'
            }`}
          >
            <div>
              <div className="text-solarized-base1">This browser</div>
              <div className="text-xs text-solarized-base0 mt-1">
                Play through this device as usual.
              </div>
            </div>
            <button
              type="button"
              onClick={() => void chooseBrowser()}
              disabled={(session.enabled && (!session.ready || !session.connected || session.refreshing)) || ownsBrowserPlayback(target) || isSending || isSwitchingOutput || isTransportPending}
              className="shrink-0 px-3 py-1.5 text-xs bg-solarized-base01 text-solarized-base2 rounded hover:bg-solarized-base00 disabled:text-solarized-cyan disabled:bg-solarized-base02 transition-colors"
            >
              {isSwitchingOutput ? 'Switching…' : ownsBrowserPlayback(target) ? 'Selected' : 'Listen on this device'}
            </button>
          </div>

          {isLoading && !status && (
            <div className="text-solarized-base0 py-6 text-center">Discovering Sonos…</div>
          )}

          {error && (
            <div role="alert" className="text-sm text-solarized-red border border-solarized-red rounded p-3 mb-4">
              {error}
            </div>
          )}

          {status && !status.configured && (
            <div className="text-sm text-solarized-base0">
              Sonos Direct Control is not configured on this server. Add the four
              <code className="text-solarized-base1"> SONOS_*</code> settings from
              <code className="text-solarized-base1"> prod.env.example</code> first.
            </div>
          )}

          {status?.configured && !status.connected && (
            <div>
              <p className="text-sm text-solarized-base0 mb-4">
                Connect the Sonos household that ReiTunes should be allowed to discover.
              </p>
              <a
                href="/api/sonos/authorize"
                className="inline-block px-4 py-2 bg-solarized-blue text-solarized-base03 rounded hover:bg-solarized-cyan transition-colors"
              >
                Connect Sonos
              </a>
            </div>
          )}

          {status?.connected && !isLoading && households.length === 0 && !error && (
            <div className="text-sm text-solarized-base0">No Sonos households were found.</div>
          )}

          {status?.connected && households.length > 0 && (
            <div className="space-y-5">
              {households.map(({ household, discovery }, householdIndex) => {
                const players = new Map(
                  discovery.players.map((player) => [player.id, player] as const)
                );
                return (
                  <section key={household.id}>
                    {households.length > 1 && (
                      <h3 className="text-xs text-solarized-base00 mb-2">
                        Household {householdIndex + 1}
                      </h3>
                    )}
                    <div className="space-y-2">
                      {discovery.groups.map((group) => {
                        const isSelected =
                          target.kind === 'sonos' && target.groupId === group.id;
                        const needsConfirmation =
                          isSelected && takeoverRequired && playbackError !== null;
                        return (
                          <div
                            key={group.id}
                            className={`border rounded p-3 flex items-center justify-between gap-4 ${
                              isSelected
                                ? 'border-solarized-cyan bg-solarized-base03'
                                : 'border-solarized-base01'
                            }`}
                          >
                            <div className="min-w-0">
                              <div className="text-solarized-base1">{group.name}</div>
                              <div className="text-xs text-solarized-base0 mt-1 truncate">
                                {group.playerIds
                                  .map((playerId) => players.get(playerId)?.name || playerId)
                                  .join(' + ')}
                              </div>
                            </div>
                            <button
                              type="button"
                              onClick={() => void chooseGroup(household, group, players)}
                              disabled={(session.enabled && (!session.ready || !session.connected || session.refreshing)) || isSending || isSwitchingOutput || isTransportPending || (isSelected && !needsConfirmation)}
                              className="shrink-0 px-3 py-1.5 text-xs bg-solarized-base01 text-solarized-base2 rounded hover:bg-solarized-base00 disabled:text-solarized-cyan disabled:bg-solarized-base02 transition-colors"
                            >
                              {isSelected
                                ? needsConfirmation
                                  ? 'Confirm takeover'
                                  : 'Selected'
                                : 'Use this group'}
                            </button>
                          </div>
                        );
                      })}
                      {discovery.groups.length === 0 && (
                        <div className="text-sm text-solarized-base0">
                          No speaker groups were found.
                        </div>
                      )}
                    </div>
                  </section>
                );
              })}
            </div>
          )}
        </div>

        <div className="mt-5 flex justify-end gap-2">
          {status?.connected && (
            <button
              onClick={() => void disconnect()}
              disabled={isLoading || isSending || isSwitchingOutput || isTransportPending}
              className="px-3 py-2 text-sm text-solarized-orange hover:bg-solarized-base03 rounded transition-colors disabled:text-solarized-base00"
            >
              Forget connection
            </button>
          )}
          {status?.connected && (
            <button
              onClick={() => void discover()}
              disabled={isLoading}
              className="px-3 py-2 text-sm bg-solarized-base01 text-solarized-base2 rounded hover:bg-solarized-base00 transition-colors disabled:text-solarized-base00"
            >
              {isLoading ? 'Refreshing…' : 'Refresh speakers'}
            </button>
          )}
          <button
            onClick={onClose}
            className="px-3 py-2 text-sm bg-solarized-base01 text-solarized-base2 rounded hover:bg-solarized-base00 transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </dialog>
  );
}
