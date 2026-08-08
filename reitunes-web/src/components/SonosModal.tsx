import { useCallback, useEffect, useState } from 'react';

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
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not disconnect Sonos');
    } finally {
      setIsLoading(false);
    }
  }, []);

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
              Speaker discovery only — playback is not wired up yet.
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
                      {discovery.groups.map((group) => (
                        <div
                          key={group.id}
                          className="border border-solarized-base01 rounded p-3"
                        >
                          <div className="text-solarized-base1">{group.name}</div>
                          <div className="text-xs text-solarized-base0 mt-1">
                            {group.playerIds
                              .map((playerId) => players.get(playerId)?.name || playerId)
                              .join(' + ')}
                          </div>
                        </div>
                      ))}
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
