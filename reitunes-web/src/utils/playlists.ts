import type { LibraryItem, Playlist, SmartPlaylistRules } from '../types';

export const TRACK_DRAG_TYPE = 'application/x-reitunes-tracks';

export function matchesSmartPlaylist(item: LibraryItem, rules: SmartPlaylistRules, now: number): boolean {
  if (rules.favourites_only && !item.is_favorite) return false;
  if (rules.play_state === 'unplayed' && item.play_count !== 0) return false;
  if (rules.play_state === 'played' && item.play_count === 0) return false;
  if (rules.added_within_days !== null) {
    const date = item.created_time_utc;
    const added = Date.parse(/Z|[+-]\d\d:\d\d$/.test(date) ? date : date + 'Z');
    if (!Number.isFinite(added) || added < now - rules.added_within_days * 86400000) return false;
  }
  return true;
}

export function playlistItems(playlist: Playlist, items: LibraryItem[], now: number): LibraryItem[] {
  if (playlist.smart_rules) return items.filter(item => matchesSmartPlaylist(item, playlist.smart_rules!, now));
  const byId = new Map(items.map(item => [item.id, item]));
  return Object.values(playlist.items).sort((a, b) => a.position - b.position)
    .flatMap(entry => { const item = byId.get(entry.library_item_id); return item ? [item] : []; });
}

export function draggedTrackIds(transfer: DataTransfer): string[] {
  try {
    const value: unknown = JSON.parse(transfer.getData(TRACK_DRAG_TYPE));
    return Array.isArray(value) && value.every(id => typeof id === 'string') ? [...new Set(value)] : [];
  } catch { return []; }
}

export function moveTracksBefore(order: string[], moving: string[], before: string | null): string[] {
  const ids = new Set(moving);
  if (before !== null && ids.has(before)) return order;
  const remaining = order.filter(id => !ids.has(id));
  const index = before === null ? remaining.length : remaining.indexOf(before);
  if (index < 0) return order;
  remaining.splice(index, 0, ...order.filter(id => ids.has(id)));
  return remaining;
}
