import { useCallback, useEffect, useState } from 'react';
import { usePlaybackTargetStore } from '../stores/playbackTargetStore';
import { usePlayerStore } from '../stores/playerStore';

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
  isOpen: boolean;
  onClose: () => void;
}

async function responseError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string };
    return body.error || `Request failed (${response.status})`;
  } catch {
    return `Request failed (${response.status})`;
  }
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { credentials: 'include' });
  if (!response.ok) throw new Error(await responseError(response));
  return response.json() as Promise<T>;
}

export function SonosModal({ isOpen, onClose }: SonosModalProps) {
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

  const disconnect = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/sonos/connection', {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!response.ok) throw new Error(await responseError(response));
      setStatus({ configured: true, connected: false });
      setHouseholds([]);
      setBrowserTarget();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not disconnect Sonos');
    } finally {
      setIsLoading(false);
    }
  }, [setBrowserTarget]);

  const chooseBrowser = useCallback(() => {
    usePlayerStore.getState().setIsPlaying(false);
    setBrowserTarget();
  }, [setBrowserTarget]);

  const chooseGroup = useCallback(
    (
      household: SonosHousehold,
      group: SonosGroup,
      players: Map<string, SonosPlayer>
    ) => {
      const playerNames = group.playerIds.map(
        (playerId) => players.get(playerId)?.name || playerId
      );
      const isAlreadySelected = target.kind === 'sonos' && target.groupId === group.id;
      const isBusy =
        group.playbackState !== undefined &&
        group.playbackState !== 'PLAYBACK_STATE_IDLE';
      if (
        (isBusy || (isAlreadySelected && takeoverRequired && playbackError !== null)) &&
        !window.confirm(
          `${group.name} may already be in use. Playing from ReiTunes will replace its current Sonos queue. Continue?`
        )
      ) {
        return;
      }

      usePlayerStore.getState().setIsPlaying(false);
      setSonosTarget({
        householdId: household.id,
        groupId: group.id,
        groupName: group.name,
        playerNames,
      });
    },
    [playbackError, setSonosTarget, takeoverRequired, target]
  );

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div
        className="bg-solarized-base02 border border-solarized-blue rounded-lg p-6 w-[560px] max-w-[calc(100%_-_2rem)] max-h-[80vh] flex flex-col"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sonos-heading"
      >
        <div className="flex justify-between items-center mb-4">
          <div>
            <h2 id="sonos-heading" className="text-lg text-solarized-base1">
              Sonos
            </h2>
            <p className="text-xs text-solarized-base0 mt-1">
              Choose where new play actions go. Changing output does not start or stop audio.
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
              target.kind === 'browser'
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
              onClick={chooseBrowser}
              disabled={target.kind === 'browser'}
              className="shrink-0 px-3 py-1.5 text-xs bg-solarized-base01 text-solarized-base2 rounded hover:bg-solarized-base00 disabled:text-solarized-cyan disabled:bg-solarized-base02 transition-colors"
            >
              {target.kind === 'browser' ? 'Selected' : 'Use browser'}
            </button>
          </div>

          {isLoading && !status && (
            <div className="text-solarized-base0 py-6 text-center">Discovering Sonos…</div>
          )}

          {error && (
            <div className="text-sm text-solarized-red border border-solarized-red rounded p-3 mb-4">
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
                              onClick={() => chooseGroup(household, group, players)}
                              disabled={isSelected && !needsConfirmation}
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
              disabled={isLoading}
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
    </div>
  );
}
