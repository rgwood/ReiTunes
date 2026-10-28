import { create } from 'zustand';
import { sonosRequest } from '../utils/sonosRequest';
import type { PlaybackTarget } from './playbackTargetStore';

// The speakers Reilly usually plays to together. Sonos sometimes splits them
// up; ReiTunes can put them back together.
export interface PreferredSonosGroup {
  householdId: string;
  name: string;
  playerIds: string[];
  playerNames: string[];
}

export interface RegroupResult {
  group: { id: string; name: string; coordinatorId: string; playerIds: string[] };
  missingPlayerIds: string[];
}

const URL = '/api/sonos/preferred-group';

interface PreferredSonosGroupState {
  preferred: PreferredSonosGroup | null;
  loaded: boolean;
  isRegrouping: boolean;
  error: string | null;
  load: () => Promise<void>;
  save: (group: PreferredSonosGroup) => Promise<void>;
  forget: () => Promise<void>;
  regroup: () => Promise<RegroupResult | null>;
}

export const usePreferredSonosGroupStore = create<PreferredSonosGroupState>()((set, get) => ({
  preferred: null,
  loaded: false,
  isRegrouping: false,
  error: null,
  load: async () => {
    try {
      set({ preferred: await sonosRequest<PreferredSonosGroup | null>(URL, {}, 20_000), loaded: true });
    } catch {
      // Sonos may not be configured. The preferred group is an optional extra.
      set({ loaded: true });
    }
  },
  save: async (group) => {
    await sonosRequest(URL, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(group),
    });
    set({ preferred: group, error: null });
  },
  forget: async () => {
    await sonosRequest(URL, { method: 'DELETE' });
    set({ preferred: null, error: null });
  },
  regroup: async () => {
    if (get().isRegrouping) return null;
    set({ isRegrouping: true, error: null });
    try {
      return await sonosRequest<RegroupResult>(`${URL}/regroup`, { method: 'POST' });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Could not regroup the speakers' });
      return null;
    } finally {
      set({ isRegrouping: false });
    }
  },
}));

/** Names of preferred speakers missing from a target chosen as the preferred group. */
export function missingPreferredSpeakers(target: PlaybackTarget, preferred: PreferredSonosGroup | null): string[] {
  if (target.kind !== 'sonos' || !target.preferredGroup || !preferred || !target.playerIds?.length
    || preferred.householdId !== target.householdId) return [];
  return preferred.playerIds.flatMap((id, index) =>
    target.playerIds!.includes(id) ? [] : [preferred.playerNames[index] ?? id]);
}

/** A group counts as the preferred group when every preferred speaker is in it. */
export function isPreferredGroup(householdId: string, playerIds: string[], preferred: PreferredSonosGroup | null) {
  return !!preferred && preferred.householdId === householdId
    && preferred.playerIds.every(id => playerIds.includes(id));
}
