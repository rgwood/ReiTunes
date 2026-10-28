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
import { isPreferredGroup, usePreferredSonosGroupStore, type PreferredSonosGroup } from '../stores/preferredSonosGroupStore';

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

// Offline speakers can't be grouped, so only the online ones need to be together.
function groupHoldingPreferred(discovery: GroupsResponse, preferred: PreferredSonosGroup | null) {
  if (!preferred) return undefined;
  const online = preferred.playerIds.filter(id => discovery.players.some(player => player.id === id));
  return online.length ? discovery.groups.find(group => online.every(id => group.playerIds.includes(id))) : undefined;
}

function sameSpeakers(preferred: PreferredSonosGroup | null, householdId: string, playerIds: string[]) {
  return !!preferred && preferred.householdId === householdId && preferred.playerIds.length === playerIds.length
    && isPreferredGroup(householdId, playerIds, preferred);
}

function PreferredGroupCard({ preferred, discovery, target, busy, isRegrouping, error, onPlay, onForget }: {
  preferred: PreferredSonosGroup;
  discovery: GroupsResponse;
  target: ReturnType<typeof usePlaybackTargetStore.getState>['target'];
  busy: boolean;
  isRegrouping: boolean;
  error: string | null;
  onPlay: () => void;
  onForget: () => void;
}) {
  const online = new Set(discovery.players.map(player => player.id));
  const nameOf = (id: string) => preferred.playerNames[preferred.playerIds.indexOf(id)] ?? id;
  const offline = preferred.playerIds.filter(id => !online.has(id));
  const fragments = discovery.groups.filter(group => group.playerIds.some(id => preferred.playerIds.includes(id)));
  const together = fragments.length <= 1;
  const grouped = groupHoldingPreferred(discovery, preferred);
  const isSelected = target.kind === 'sonos' && target.preferredGroup === true &&
    fragments.some(group => group.id === target.groupId);
  const status = [
    together ? `${preferred.playerIds.length - offline.length} of ${preferred.playerIds.length} speakers grouped`
      : `Split across ${fragments.length} groups`,
    offline.length ? `${offline.map(nameOf).join(', ')} offline` : null,
  ].filter(Boolean).join(' · ');
  return (
    <div
      className={`border rounded p-3 flex items-center justify-between gap-4 ${
        isSelected ? 'border-solarized-cyan bg-solarized-base03' : 'border-solarized-base01'
      }`}
      data-testid="preferred-sonos-group"
    >
      <div className="min-w-0">
        <div className="text-solarized-base1">{preferred.name}</div>
        <div className="text-xs text-solarized-base0 mt-1 truncate">{preferred.playerNames.join(' + ')}</div>
        <div className={`text-xs mt-1 ${together && !offline.length ? 'text-solarized-base0' : 'text-solarized-yellow'}`}>
          {isRegrouping ? 'Regrouping…' : status}
        </div>
        {error && <div role="alert" className="text-xs text-solarized-red mt-1">{error}</div>}
        <button type="button" onClick={onForget} disabled={busy} aria-label={`Forget ${preferred.name}`}
          className="text-xs text-solarized-base00 hover:underline mt-1">
          Forget
        </button>
      </div>
      <div className="shrink-0">
        <button
          type="button"
          onClick={onPlay}
          disabled={busy || (isSelected && !!grouped)}
          className="px-3 py-1.5 text-xs bg-solarized-base01 text-solarized-base2 rounded hover:bg-solarized-base00 disabled:text-solarized-cyan disabled:bg-solarized-base02 transition-colors"
        >
          {isSelected ? grouped ? 'Selected' : 'Regroup' : grouped ? `Use ${preferred.name}` : 'Regroup and use'}
        </button>
      </div>
    </div>
  );
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
  // The speaker may have advanced while this screen was idle. Its playback
  // response reconciles the shared listening ID before the handoff continues.
  if (playback.reitunesSessionActive) await refreshSharedSession();
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
  const preferredGroups = usePreferredSonosGroupStore();
  const preferred = preferredGroups.preferred;

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

      const [householdResponse] = await Promise.all([
        fetchJson<{ households: SonosHousehold[] }>('/api/sonos/households'),
        usePreferredSonosGroupStore.getState().load(),
      ]);
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
        player.selectRemoteItem(item, position, undefined, usePlayerStore.getState().listenId ?? undefined);
      } else {
        player.setIsPlaying(false);
      }
      setBrowserTarget();
      stageSharedPlayback();
      if (!await flushSharedSession()) throw new Error('The shared session changed. Please try again.');
      if (item) {
        player.play(item, position, undefined, usePlayerStore.getState().listenId ?? undefined);
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
      players: Map<string, SonosPlayer>,
      preferredGroup = isPreferredGroup(household.id, group.playerIds, usePreferredSonosGroupStore.getState().preferred),
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
          playerIds: group.playerIds,
          // Match the server's serialization, which omits a false flag.
          ...(preferredGroup ? { preferredGroup: true } : {}),
        });
        if (item) player.selectRemoteItem(item, position, undefined, usePlayerStore.getState().listenId ?? undefined);
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

  const savePreferred = useCallback(async (household: SonosHousehold, group: SonosGroup, players: Map<string, SonosPlayer>) => {
    setError(null);
    try {
      await usePreferredSonosGroupStore.getState().save({
        householdId: household.id,
        name: usePreferredSonosGroupStore.getState().preferred?.name ?? 'Whole house',
        playerIds: group.playerIds,
        playerNames: group.playerIds.map(id => players.get(id)?.name || id),
      });
    } catch (err) {
      setError(`Could not save the preferred group: ${err instanceof Error ? err.message : 'ReiTunes did not respond'}`);
    }
  }, []);

  const forgetPreferred = useCallback(async () => {
    setError(null);
    try {
      await usePreferredSonosGroupStore.getState().forget();
    } catch (err) {
      setError(`Could not forget the preferred group: ${err instanceof Error ? err.message : 'ReiTunes did not respond'}`);
    }
  }, []);

  // Regrouping changes membership, so re-read the household afterwards.
  const regroup = useCallback(async (household: SonosHousehold) => {
    const result = await usePreferredSonosGroupStore.getState().regroup();
    if (!result) return null;
    const discovery = await fetchJson<GroupsResponse>(
      `/api/sonos/households/${encodeURIComponent(household.id)}/groups`
    ).catch(() => null);
    if (discovery) {
      setHouseholds(current => current.map(entry =>
        entry.household.id === household.id ? { household, discovery } : entry));
    }
    return { result, discovery };
  }, []);

  const playOnPreferred = useCallback(async (household: SonosHousehold, discovery: GroupsResponse) => {
    let groups = discovery;
    let group = groupHoldingPreferred(groups, preferred);
    if (!group) {
      const regrouped = await regroup(household);
      if (!regrouped) return;
      groups = regrouped.discovery ?? groups;
      group = groups.groups.find(candidate => candidate.id === regrouped.result.group.id) ?? regrouped.result.group;
    }
    const output = usePlaybackTargetStore.getState();
    if (output.target.kind === 'sonos' && output.target.groupId === group.id) {
      // Already playing here: just mark it so ReiTunes keeps it together.
      if (!output.target.preferredGroup && canEditSharedSession()) {
        usePlaybackTargetStore.setState({ target: { ...output.target, playerIds: group.playerIds, preferredGroup: true } });
        stageSharedPlayback();
        await flushSharedSession();
      }
      onClose();
      return;
    }
    await chooseGroup(household, group, new Map(groups.players.map(player => [player.id, player] as const)), true);
  }, [chooseGroup, onClose, preferred, regroup]);

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
                      {preferred?.householdId === household.id && (
                        <PreferredGroupCard
                          preferred={preferred}
                          discovery={discovery}
                          target={target}
                          busy={(session.enabled && (!session.ready || !session.connected || session.refreshing)) || isSending || isSwitchingOutput || isTransportPending || preferredGroups.isRegrouping}
                          isRegrouping={preferredGroups.isRegrouping}
                          error={preferredGroups.error}
                          onPlay={() => void playOnPreferred(household, discovery)}
                          onForget={() => void forgetPreferred()}
                        />
                      )}
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
                              {group.playerIds.length > 1 && !sameSpeakers(preferred, household.id, group.playerIds) && (
                                <button
                                  type="button"
                                  onClick={() => void savePreferred(household, group, players)}
                                  className="text-xs text-solarized-cyan hover:underline mt-1"
                                >
                                  {preferred ? `Save as ${preferred.name}` : 'Save as Whole house'}
                                </button>
                              )}
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
