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

export function formatBookmarkPosition(position: number): string {
  const totalSeconds = Math.max(0, Math.floor(position));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  return hours > 0
    ? `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`
    : `${minutes}:${seconds.toString().padStart(2, '0')}`;
}
