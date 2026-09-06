import type { LibraryItem, PlaybackTarget } from '../types/index.ts';

export function trackTarget(item: LibraryItem): PlaybackTarget {
  return { libraryItemId: item.id, startPosition: 0 };
}

export function bookmarkTarget(item: LibraryItem, bookmarkId: string): PlaybackTarget {
  return { libraryItemId: item.id, bookmarkId, startPosition: item.bookmarks[bookmarkId].position };
}

export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds / 60) % 60;
  const secs = Math.floor(seconds % 60).toString().padStart(2, '0');
  return hours ? `${hours}:${minutes.toString().padStart(2, '0')}:${secs}` : `${minutes}:${secs}`;
}

export function describeTarget(target: PlaybackTarget, item?: LibraryItem): string {
  if (!item) return 'Unavailable track';
  return target.bookmarkId
    ? `${item.bookmarks[target.bookmarkId]?.emoji || '🔖'} ${formatTime(target.startPosition)} · ${item.name}`
    : item.name;
}
