import type { LibraryItem } from '../types';

// Parse once per query, rather than once for every track on every keystroke.
export function createLibrarySearch(query: string, getTags: (item: LibraryItem) => string[] = () => []) {
  const terms = [...query.matchAll(/(artist|album|tag):(?:"((?:[^"\\]|\\.)*)"|(\S+))|"([^"]+)"|(\S+)/gi)].map(term => ({
    field: term[1]?.toLowerCase(),
    value: (term[2] ?? term[3] ?? term[4] ?? term[5]).replace(/\\(["\\])/g, '$1').toLowerCase(),
  }));
  if (!terms.length) return () => true;
  return (item: LibraryItem): boolean => {
    let haystack: string | undefined;
    let tags: string[] | undefined;
    return terms.every(({ field, value }) => {
      if (field === 'tag') {
        tags ??= getTags(item);
        return tags.includes(value.trim().replace(/\s+/g, '-'));
      }
      if (field === 'artist' || field === 'album') return item[field].toLowerCase() === value;
      tags ??= getTags(item);
      haystack ??= [item.name, item.artist, item.album, ...Object.values(item.bookmarks).map(bookmark => bookmark.label || ''), ...(item.tracklist?.tracks.map(track => track.title) ?? []), ...tags, ...tags.map(tag => tag.replace(/-/g, ' '))].join(' ').toLowerCase();
      return haystack.includes(value);
    });
  };
}

export function matchesLibrarySearch(item: LibraryItem, query: string, tags: string[] = []): boolean {
  return createLibrarySearch(query, () => tags)(item);
}

export function tagSearch(tag: string): string {
  if (!/[\s"\\]/.test(tag)) return `tag:${tag}`;
  return `tag:"${tag.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function albumSearch(album: string): string {
  return `album:"${album.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** The album a search shows, when the search is nothing but one album filter. */
export function searchedAlbum(query: string): string | null {
  const match = /^\s*album:(?:"((?:[^"\\]|\\.)*)"|(\S+))\s*$/i.exec(query);
  return match ? (match[1] ?? match[2]).replace(/\\(["\\])/g, '$1') : null;
}

/** An album's songs in track order. Songs without a track number go last, in library order. */
export function albumTracks(items: LibraryItem[], album: string): LibraryItem[] {
  const name = album.toLowerCase();
  return items.filter(item => item.album.toLowerCase() === name)
    .sort((a, b) => (a.track_number ?? Infinity) - (b.track_number ?? Infinity) || 0);
}
