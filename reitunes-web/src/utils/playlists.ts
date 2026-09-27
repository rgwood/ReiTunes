import type { Comparison, LibraryItem, Playlist, SmartPlaylistRules, SmartRule } from '../types';
import { hasFavourite } from './tracklists';
import { trackDuration } from './duration';
import { effectiveTags, normalizeLibraryTag, type ItemTags } from '../hooks/useTags';

export type PlaylistTagItems = Record<string, ItemTags>;

export const TRACK_DRAG_TYPE = 'application/x-reitunes-tracks';

const compare = (value: number, operator: Comparison, expected: number) => {
  switch (operator) {
    case 'lt': return value < expected;
    case 'lte': return value <= expected;
    case 'eq': return value === expected;
    case 'gte': return value >= expected;
    case 'gt': return value > expected;
  }
};

export function matchesRule(item: LibraryItem, rule: SmartRule, now: number, tagItems?: PlaylistTagItems): boolean {
  switch (rule.type) {
    case 'all': return rule.rules.every(child => matchesRule(item, child, now, tagItems));
    case 'any': return rule.rules.some(child => matchesRule(item, child, now, tagItems));
    case 'tag': {
      const value = normalizeLibraryTag(rule.value);
      return tagItems !== undefined && !!value && effectiveTags(tagItems[item.id]).includes(value) === rule.present;
    }
    case 'has_tags': return tagItems !== undefined && (effectiveTags(tagItems[item.id]).length > 0) === rule.value;
    case 'duration': {
      const duration = trackDuration(item);
      return duration !== null && compare(duration, rule.comparison, rule.seconds);
    }
    case 'duration_known': return (trackDuration(item) !== null) === rule.value;
    case 'play_count': return compare(item.play_count, rule.comparison, rule.value);
    case 'favourite': return hasFavourite(item) === rule.value;
    case 'bookmarks': return (Object.keys(item.bookmarks).length > 0) === rule.value;
    case 'added_within': {
      const date = item.created_time_utc;
      const added = Date.parse(/Z|[+-]\d\d:\d\d$/.test(date) ? date : date + 'Z');
      return Number.isFinite(added) && added >= now - rule.days * 86400000;
    }
    case 'text': {
      const value = item[rule.field].toLocaleLowerCase(), expected = rule.value.trim().toLocaleLowerCase();
      if (!expected) return false;
      switch (rule.comparison) {
        case 'is': return value === expected;
        case 'is_not': return value !== expected;
        case 'contains': return value.includes(expected);
        case 'does_not_contain': return !value.includes(expected);
      }
    }
  }
}

export function ruleExpression(rules?: SmartPlaylistRules | null): SmartRule {
  if (rules?.expression) return rules.expression;
  const children: SmartRule[] = [];
  if (rules?.added_within_days != null) children.push({ type: 'added_within', days: rules.added_within_days });
  if (rules?.favourites_only) children.push({ type: 'favourite', value: true });
  if (rules?.play_state && rules.play_state !== 'any') children.push({ type: 'play_count', comparison: rules.play_state === 'played' ? 'gt' : 'eq', value: 0 });
  if (rules?.bookmark_state && rules.bookmark_state !== 'any') children.push({ type: 'bookmarks', value: rules.bookmark_state === 'with' });
  return { type: 'all', rules: children };
}

export function matchesSmartPlaylist(item: LibraryItem, rules: SmartPlaylistRules, now: number, tagItems?: PlaylistTagItems): boolean {
  if (rules.expression) return matchesRule(item, rules.expression, now, tagItems);
  if (rules.favourites_only && !hasFavourite(item)) return false;
  const hasBookmarks = Object.keys(item.bookmarks).length > 0;
  if (rules.bookmark_state === 'with' && !hasBookmarks) return false;
  if (rules.bookmark_state === 'without' && hasBookmarks) return false;
  if (rules.play_state === 'unplayed' && item.play_count !== 0) return false;
  if (rules.play_state === 'played' && item.play_count === 0) return false;
  if (rules.added_within_days !== null) {
    const date = item.created_time_utc;
    const added = Date.parse(/Z|[+-]\d\d:\d\d$/.test(date) ? date : date + 'Z');
    if (!Number.isFinite(added) || added < now - rules.added_within_days * 86400000) return false;
  }
  return true;
}

export function playlistItems(playlist: Playlist, items: LibraryItem[], now: number, tagItems?: PlaylistTagItems): LibraryItem[] {
  if (playlist.smart_rules) return items.filter(item => matchesSmartPlaylist(item, playlist.smart_rules!, now, tagItems));
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
