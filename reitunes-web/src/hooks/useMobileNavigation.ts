import { useCallback, useEffect, useState } from 'react';

export type MobileTab = 'playing' | 'queue' | 'browse';
export type MobileBrowse = 'library' | 'playlists' | 'discover' | 'bookmarks';
export interface MobileRoute { tab: MobileTab; browse: MobileBrowse; playlistId?: string }

function readRoute(): MobileRoute {
  const parts = window.location.hash.slice(1).split('/');
  if (parts[0] === 'queue') return { tab: 'queue', browse: 'library' };
  if (parts[0] !== 'browse') return { tab: 'playing', browse: 'library' };
  if (parts[1] === 'playlist' && parts[2]) {
    try { return { tab: 'browse', browse: 'playlists', playlistId: decodeURIComponent(parts[2]) }; } catch { /* Invalid links open the library. */ }
  }
  const browse = ['playlists', 'discover', 'bookmarks'].includes(parts[1]) ? parts[1] as MobileBrowse : 'library';
  return { tab: 'browse', browse };
}

export function useMobileNavigation() {
  const [isMobile, setMobile] = useState(() => window.matchMedia('(max-width: 700px)').matches);
  const [route, setRoute] = useState<MobileRoute>(readRoute);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 700px)');
    const resize = () => setMobile(media.matches);
    const restore = () => setRoute(readRoute());
    media.addEventListener('change', resize);
    window.addEventListener('popstate', restore);
    window.addEventListener('hashchange', restore);
    return () => {
      media.removeEventListener('change', resize);
      window.removeEventListener('popstate', restore);
      window.removeEventListener('hashchange', restore);
    };
  }, []);
  const navigate = useCallback((next: MobileRoute) => {
    const hash = next.tab === 'browse'
      ? next.playlistId ? `#browse/playlist/${encodeURIComponent(next.playlistId)}` : `#browse/${next.browse}`
      : `#${next.tab}`;
    if (window.location.hash !== hash) window.history.pushState(null, '', hash);
    setRoute(next);
  }, []);
  return { isMobile, route, navigate };
}
