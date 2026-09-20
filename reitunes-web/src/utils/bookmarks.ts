import type { Bookmark, LibraryItem } from '../types';

export interface BookmarkEntry {
  item: LibraryItem;
  bookmarkId: string;
  bookmark: Bookmark;
}

export function bookmarkEntries(items: LibraryItem[]): BookmarkEntry[] {
  return items
    .flatMap((item) =>
      Object.entries(item.bookmarks).map(([bookmarkId, bookmark]) => ({
        item,
        bookmarkId,
        bookmark,
      }))
    )
    .sort((left, right) => {
      const byCreated = right.bookmark.created_time_utc.localeCompare(
        left.bookmark.created_time_utc
      );
      if (byCreated !== 0) return byCreated;
      return left.bookmark.position - right.bookmark.position;
    });
}

export function filterBookmarkEntries(
  entries: BookmarkEntry[],
  query: string
): BookmarkEntry[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return entries;

  return entries.filter(({ item, bookmark }) =>
    [bookmark.label, item.name, item.artist, item.album]
      .filter(Boolean)
      .some((value) => value!.toLocaleLowerCase().includes(normalizedQuery))
  );
}

export function formatBookmarkPosition(position: number, includeFraction = false): string {
  const normalized = includeFraction ? Number(Math.max(0, position).toFixed(9)) : Math.max(0, position);
  const totalSeconds = Math.floor(normalized);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const formatted = hours > 0
    ? `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`
    : `${minutes}:${seconds.toString().padStart(2, '0')}`;
  const fraction = includeFraction ? normalized.toFixed(9).split('.')[1]?.replace(/0+$/, '') : undefined;
  return fraction ? `${formatted}.${fraction}` : formatted;
}

export function parseBookmarkPosition(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+(?::[0-5]\d){0,2}(?:\.\d+)?$/.test(trimmed)) return null;
  const position = trimmed.split(':').reduce((total, part) => total * 60 + Number(part), 0);
  return Number.isFinite(position) && position <= Number.MAX_SAFE_INTEGER ? position : null;
}
