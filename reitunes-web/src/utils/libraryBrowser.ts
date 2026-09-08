import type { LibraryItem } from '../types';

export function matchesLibrarySearch(
  item: LibraryItem,
  query: string
): boolean {
  const terms = [
    ...query.matchAll(/(artist|album):"((?:[^"\\]|\\.)*)"|"([^"]+)"|(\S+)/gi),
  ];
  const haystack = [
    item.name,
    item.artist,
    item.album,
    ...Object.values(item.bookmarks).map((bookmark) => bookmark.label || ''),
  ]
    .join(' ')
    .toLowerCase();
  return terms.every((term) => {
    if (term[1]) {
      const field = term[1].toLowerCase() as 'artist' | 'album';
      return item[field]
        .toLowerCase()
        .includes(term[2].replace(/\\"/g, '"').toLowerCase());
    }
    return haystack.includes((term[3] || term[4]).toLowerCase());
  });
}
