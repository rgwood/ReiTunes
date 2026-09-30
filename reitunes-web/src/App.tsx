import { AppDialogs } from './components/AppDialogs';
import { requestConfirmation } from './stores/dialogStore';
import {
  useState,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useDeferredValue,
} from 'react';
import {
  QueryClient,
  QueryClientProvider,
} from '@tanstack/react-query';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { useShallow } from 'zustand/react/shallow';
import { AudioPlayer } from './components/AudioPlayer';
import { LibraryTable } from './components/LibraryTable';
import { hasFavourite } from './utils/tracklists';
import { MusicIcon } from './components/MusicIcon';
import { ImportMusic } from './components/ImportMusic';
import { QueuePanel } from './components/QueuePanel';
import { LibrarySidebar } from './components/LibrarySidebar';
import { PlaylistDialog, type PlaylistDraft } from './components/PlaylistDialog';
import { usePlaylists, usePlaylistMutation } from './hooks/usePlaylists';
import { playlistItems } from './utils/playlists';
import { useLibraryPreferences } from './stores/libraryPreferences';
import { BookmarkSidebar } from './components/BookmarkSidebar';
import type { PlaybackRange } from './stores/playerStore';
import { SonosModal } from './components/SonosModal';
import { SettingsDialog } from './components/SettingsDialog';
import { Discover } from './components/Discover';
import { TagPanel } from './components/TagPanel';
import { TagBrowser } from './components/TagBrowser';
import { MobileLibrary } from './components/MobileLibrary';
import { useMobileNavigation, type MobileBrowse } from './hooks/useMobileNavigation';
import { useSharedPlaybackSession } from './hooks/useSharedPlaybackSession';
import { effectiveTags, useTags } from './hooks/useTags';
import { isInboxEntry, useDiscovery } from './hooks/useDiscovery';
import { useLibrary } from './hooks/useLibrary';
import { useQueueStore } from './hooks/useQueue';
import { useTrackDrop } from './hooks/useTrackDrop';
import { usePlayback } from './hooks/usePlayback';
import { usePlayerStore } from './stores/playerStore';
import { usePlaybackTargetStore } from './stores/playbackTargetStore';
import { ownsBrowserPlayback } from './stores/sharedSessionStore';
import type { LibraryItem } from './types';
import { createLibrarySearch, tagSearch } from './utils/libraryBrowser';
import './App.css';
import './LibraryLayout.css';
import './components/Tags.css';
import './components/MobileShell.css';

const queryClient = new QueryClient();
type Collection = 'all' | 'favourites' | 'recent' | 'unplayed';

function LibrarySelectionCount({ store }: { store: StoreApi<{ count: number }> }) {
  const count = useStore(store, state => state.count);
  return count > 0 ? <span className="library-selection-count" title="Drag the selected tracks to a playlist or the queue"> · {count.toLocaleString()} selected</span> : null;
}

function AppContent() {
  const { isMobile, iosStandalone, route: mobileRoute, navigate: navigateMobile } = useMobileNavigation();
  const [desktopView, setView] = useState<'library' | 'discover' | 'bookmarks'>('library');
  const view = isMobile ? mobileRoute.browse === 'discover' || mobileRoute.browse === 'bookmarks' ? mobileRoute.browse : 'library' : desktopView;
  const [librarySearch, setLibrarySearch] = useState('');
  const [discoverySearch, setDiscoverySearch] = useState('');
  const [bookmarkSearch, setBookmarkSearch] = useState('');
  const [playlistDraft, setPlaylistDraft] = useState<PlaylistDraft | null>(null);
  const [now, setNow] = useState(Date.now);
  const density = useLibraryPreferences(state => state.density);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60000);
    return () => window.clearInterval(timer);
  }, []);
  const searchQuery = view === 'discover' ? discoverySearch : view === 'bookmarks' ? bookmarkSearch : librarySearch;
  const setSearchQuery = view === 'discover' ? setDiscoverySearch : view === 'bookmarks' ? setBookmarkSearch : setLibrarySearch;
  const deferredSearch = useDeferredValue(searchQuery);
  const deferredLibrarySearch = useDeferredValue(librarySearch);
  const [selectedCollection, setCollection] = useState<Collection>('all');
  const collection = isMobile && mobileRoute.playlistId ? 'all' : selectedCollection;
  const [revealRequest, setRevealRequest] = useState<{ itemId: string; focus?: boolean } | null>(null);
  // Only the footer subscribes, so selecting tracks doesn't render the whole app again.
  const [selectionCountStore] = useState(() => createStore(() => ({ count: 0 })));
  const reportSelectionCount = useCallback((count: number) => {
    selectionCountStore.setState({ count });
  }, [selectionCountStore]);
  const [gridView, setGridView] = useState<{ key: string; items: LibraryItem[] } | null>(null);
  const [playbackState, setPlaybackState] = useState<'playing' | 'paused'>();
  const finishReveal = useCallback(() => setRevealRequest(null), []);
  const [recentCutoff, setRecentCutoff] = useState(
    () => Date.now() - 30 * 24 * 60 * 60 * 1000
  );
  const [panel, setPanel] = useState<
    'queue' | 'bookmarks' | 'tags' | null
  >(null);
  const [bookmarkItemId, setBookmarkItemId] = useState<string | null>(null);
  const [tagItemId, setTagItemId] = useState<string | null>(null);
  const [tagWorkOpen, setTagWorkOpen] = useState(false);
  const tagReturnFocus = useRef<HTMLElement | null>(null);
  const [isImportOpen, setIsImportOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [droppedFiles, setDroppedFiles] = useState<File[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const dragDepth = useRef(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const previewPauseRef = useRef<(() => Promise<boolean>) | null>(null);
  const playbackPosition = useRef<{ itemId: string; position: number } | null>(
    null
  );
  const reportPlaybackPosition = useCallback(
    (itemId: string, position: number) => {
      playbackPosition.current = { itemId, position };
    },
    []
  );
  const [desktopPlaylistId, setSelectedPlaylistId] = useState<string | null>(
    null
  );
  const selectedPlaylistId = isMobile ? mobileRoute.playlistId ?? null : desktopPlaylistId;
  const [isSonosOpen, setIsSonosOpen] = useState(
    () =>
      window.location.hash === '#sonos=connected' ||
      new URLSearchParams(window.location.search).get('sonos') === 'connected'
  );
  const { items, isLoading, error } = useLibrary();
  const sharedSession = useSharedPlaybackSession(items, isLoading || Boolean(error));
  const sessionBusy = !sharedSession.ready || !sharedSession.connected || sharedSession.refreshing;
  const queueDrop = useTrackDrop((ids) => {
    const byId = new Map(items.map(item => [item.id, item]));
    const tracks = ids.flatMap(id => byId.has(id) ? [byId.get(id)!] : []);
    if (!tracks.length) return;
    tracks.forEach(useQueueStore.getState().addToQueue);
    setPanel('queue');
  });
  const tags = useTags();
  const activeTagCount = Object.values(tags.data?.items || {}).filter(item => ['queued', 'running'].includes(item.status)).length;
  const failedTagCount = Object.values(tags.data?.items || {}).filter(item => item.status === 'failed').length;
  const { data: discovery } = useDiscovery();
  const discoveryCount = discovery?.entries.filter(entry => isInboxEntry(entry)
    && entry.sources.some(id => discovery.sources.some(source => source.id === id))).length ?? 0;
  const play = usePlayback();
  const playBookmark = (item: LibraryItem, position: number, range?: PlaybackRange) => { void play(item, position, 'bookmark', range); };
  const getBookmarkPlaybackTime = (itemId: string) => {
    const player = usePlayerStore.getState();
    if (player.currentItemId !== itemId) return null;
    const remote = usePlaybackTargetStore.getState().target.kind === 'sonos';
    const remotePosition = playbackPosition.current?.itemId === itemId ? playbackPosition.current.position : player.resumePosition;
    const position = player.pendingSeek ?? (remote ? remotePosition : audioRef.current?.currentTime ?? player.resumePosition);
    return { position, duration: remote ? 0 : audioRef.current?.duration ?? 0 };
  };
  const {
    currentItem,
    currentItemId,
    restoreCurrentItem,
    refreshCurrentItem,
    clearCurrentItem,
  } = usePlayerStore(useShallow(state => ({
    currentItem: state.currentItem,
    currentItemId: state.currentItemId,
    restoreCurrentItem: state.restoreCurrentItem,
    refreshCurrentItem: state.refreshCurrentItem,
    clearCurrentItem: state.clearCurrentItem,
  })));
  const playbackTarget = usePlaybackTargetStore((state) => state.target);
  const { reconcileWithLibrary, setContext, manualQueue } = useQueueStore(useShallow(state => ({
    reconcileWithLibrary: state.reconcileWithLibrary,
    setContext: state.setContext,
    manualQueue: state.manualQueue,
  })));
  const { data: playlists = [], isError: playlistError } = usePlaylists();
  const playlistMutation = usePlaylistMutation();
  const [playlistActionError, setPlaylistActionError] = useState('');

  useEffect(() => {
    if (isLoading || error || !sharedSession.ready) return;
    reconcileWithLibrary(items);
    if (!currentItemId) return;
    const libraryItem = items.find((item) => item.id === currentItemId);
    if (!libraryItem) clearCurrentItem();
    else if (!currentItem) restoreCurrentItem(libraryItem);
    else if (currentItem !== libraryItem) refreshCurrentItem(libraryItem);
  }, [
    items,
    isLoading,
    error,
    currentItem,
    currentItemId,
    clearCurrentItem,
    reconcileWithLibrary,
    refreshCurrentItem,
    restoreCurrentItem,
    sharedSession.ready,
  ]);

  useEffect(() => {
    const url = new URL(window.location.href);
    // Old experiment links open the same track grid as the home page.
    url.searchParams.delete('view');
    url.searchParams.delete('sonos');
    if (url.hash === '#sonos=connected') url.hash = '';
    window.history.replaceState(
      {},
      '',
      `${url.pathname}${url.search}${url.hash}`
    );
  }, []);

  const selectedPlaylist = playlists.find(
    (playlist) => playlist.id === selectedPlaylistId
  );
  const matchesSearch = useMemo(() => createLibrarySearch(deferredLibrarySearch,
    item => effectiveTags(tags.data?.items[item.id])), [deferredLibrarySearch, tags.data]);
  const filteredItems = useMemo(() => {
    const candidates = selectedPlaylist ? playlistItems(selectedPlaylist, items, now, tags.data?.items) : items;
    return candidates.filter((item) => {
      if (collection === 'favourites' && !hasFavourite(item)) return false;
      if (collection === 'unplayed' && item.play_count !== 0) return false;
      if (
        collection === 'recent' &&
        Date.parse(
          /Z|[+-]\d\d:\d\d$/.test(item.created_time_utc)
            ? item.created_time_utc
            : `${item.created_time_utc}Z`
        ) < recentCutoff
      )
        return false;
      return matchesSearch(item);
    });
  }, [items, selectedPlaylist, collection, matchesSearch, recentCutoff, now, tags.data]);
  const viewKey = `${selectedPlaylistId ?? collection}:${deferredLibrarySearch}`;
  const reportViewItems = useCallback((visibleItems: LibraryItem[]) => {
    setGridView(previous => previous?.key === viewKey && previous.items.length === visibleItems.length &&
      previous.items.every((item, index) => item === visibleItems[index])
      ? previous : { key: viewKey, items: visibleItems });
  }, [viewKey]);
  const collectionName = selectedPlaylist?.name ?? ({ all: 'All music', favourites: 'Favourites', recent: 'Recently added', unplayed: 'Unplayed' } as const)[collection];
  const currentViewName = deferredLibrarySearch.trim() ? `${collectionName} · “${deferredLibrarySearch.trim()}”` : collectionName;
  const viewAvailable = view === 'library' && !isLoading && !error && librarySearch === deferredLibrarySearch &&
    (!selectedPlaylistId || !!selectedPlaylist) && !(isMobile && mobileRoute.browse === 'playlists' && !mobileRoute.playlistId);
  const currentQueueView = viewAvailable && (isMobile || gridView?.key === viewKey)
    ? { name: currentViewName, items: isMobile ? filteredItems : gridView!.items } : null;
  const mobileQueueSources = useMemo(() => isMobile && mobileRoute.tab === 'queue'
    ? [{ id: 'library', name: 'Your library', items }, ...playlists.map(playlist => ({
      id: playlist.id, name: playlist.name, items: playlistItems(playlist, items, now, tags.data?.items),
    }))] : [], [isMobile, mobileRoute.tab, items, playlists, now, tags.data]);
  const moments = useMemo(
    () =>
      (view === 'bookmarks' ? items : filteredItems).flatMap((item) =>
        Object.values(item.bookmarks)
          .sort((a, b) => a.position - b.position)
          .map((bookmark) => ({ item, bookmark }))
      ),
    [filteredItems, items, view]
  );
  const nextMoment = useCallback(() => {
    if (!moments.length) return;
    const player = usePlayerStore.getState();
    const position =
      player.pendingSeek ??
      (playbackPosition.current?.itemId === currentItemId
        ? playbackPosition.current.position
        : player.resumePosition);
    const inCurrent = moments.find(
      (entry) =>
        entry.item.id === currentItemId &&
        entry.bookmark.position > position + 1
    );
    let currentIndex = -1;
    moments.forEach((entry, index) => {
      if (entry.item.id === currentItemId) currentIndex = index;
    });
    const next = inCurrent || moments[(currentIndex + 1) % moments.length];
    const context = view === 'bookmarks' ? items : filteredItems;
    setContext(
      context,
      context.findIndex((item) => item.id === next.item.id),
      'Saved moments',
      true
    );
    void play(next.item, next.bookmark.position, 'next-bookmark', { start: next.bookmark.position, end: next.bookmark.end_position ?? null });
  }, [moments, currentItemId, setContext, filteredItems, play, view, items]);
  const randomFavourite = useCallback(() => {
    const targets = items.flatMap((item) => [
      ...Object.values(item.bookmarks).map((bookmark) => ({
        item,
        position: bookmark.position,
        range: { start: bookmark.position, end: bookmark.end_position ?? null },
      })),
      ...(item.is_favorite ? [{ item, position: 0, range: undefined }] : []),
      ...(item.tracklist?.tracks.flatMap((track, index) => track.is_favorite ? [{ item, position: track.start,
        range: { start: track.start, end: track.end ?? item.tracklist?.tracks[index + 1]?.start ?? item.tracklist?.duration ?? null, afterEnd: 'pause' as const } }] : []) ?? []),
    ]);
    if (!targets.length) return;
    const next = targets[Math.floor(Math.random() * targets.length)];
    void play(next.item, next.position, 'ctrl-e', next.range);
    if (!filteredItems.some((item) => item.id === next.item.id)) {
      setLibrarySearch('');
      setCollection('all');
      setSelectedPlaylistId(null);
    }
    setView('library');
    setRevealRequest({ itemId: next.item.id });
  }, [items, play, filteredItems]);

  const revealCurrentSong = useCallback(() => {
    if (!currentItemId || !items.some(item => item.id === currentItemId)) return;
    if (librarySearch !== deferredLibrarySearch || !filteredItems.some(item => item.id === currentItemId)) {
      setLibrarySearch('');
      setCollection('all');
      setSelectedPlaylistId(null);
    }
    setView('library');
    setRevealRequest({ itemId: currentItemId, focus: true });
  }, [currentItemId, items, filteredItems, librarySearch, deferredLibrarySearch]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (document.querySelector('dialog[open], [role="dialog"]')) return;
      if ((event.ctrlKey || event.metaKey) && event.key === ',' && !event.altKey && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        setIsSettingsOpen(true);
        return;
      }
      const editing = (event.target as HTMLElement).closest(
        'input, textarea, select, [contenteditable="true"]'
      );
      if (!isMobile && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'l'
        && !event.altKey && !event.shiftKey && !event.isComposing
        && (!editing || event.target === searchRef.current)) {
        event.preventDefault();
        if (!event.repeat) revealCurrentSong();
        return;
      }
      if (
        ((event.metaKey || event.ctrlKey) &&
          ['k', 'f'].includes(event.key.toLowerCase())) ||
        (event.key === '/' && !editing)
      ) {
        event.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
      if (
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === 'e' &&
        !editing
      ) {
        event.preventDefault();
        if (!event.repeat) randomFavourite();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [randomFavourite, revealCurrentSong, isMobile]);

  const chooseCollection = (next: Collection) => {
    setView('library');
    setCollection(next);
    setSelectedPlaylistId(null);
    if (next === 'recent')
      setRecentCutoff(Date.now() - 30 * 24 * 60 * 60 * 1000);
  };
  const activeSource = view !== 'library' ? view : selectedPlaylistId ? `playlist:${selectedPlaylistId}` : collection;
  const selectSource = (source: string) => {
    if (source === 'discover' || source === 'bookmarks') {
      setView(source);
      if (source === 'bookmarks') setBookmarkItemId(null);
    } else if (source.startsWith('playlist:')) {
      setSelectedPlaylistId(source.slice(9)); setCollection('all'); setView('library');
    } else chooseCollection(source as Collection);
  };
  const browseMobile = (browse: MobileBrowse, playlistId?: string) => {
    setPanel(null);
    setPlaylistActionError('');
    navigateMobile({ tab: 'browse', browse, playlistId });
  };
  const toggleQueue = () => setPanel(panel === 'queue' ? null : 'queue');
  const browseTag = useCallback((tag: string) => {
    setView('library'); setCollection('all'); setSelectedPlaylistId(null);
    setLibrarySearch(tagSearch(tag)); setPanel(null);
    if (isMobile) navigateMobile({ tab: 'browse', browse: 'library' });
  }, [isMobile, navigateMobile]);
  const manageTags = useCallback((item: LibraryItem) => {
    tagReturnFocus.current = isMobile ? document.querySelector<HTMLElement>(`li[data-item-id="${CSS.escape(item.id)}"] .mobile-song-more`)
      : document.activeElement instanceof HTMLElement && document.activeElement.matches('.row-tag-edit')
        ? document.activeElement : document.querySelector<HTMLElement>(`tr[data-item-id="${CSS.escape(item.id)}"]`);
    setTagItemId(item.id); setPanel('tags');
  }, [isMobile]);
  const manageBookmarks = useCallback((item: LibraryItem) => {
    setBookmarkItemId(item.id); setPanel('bookmarks');
  }, []);
  const newPlaylistFromSelection = useCallback((itemIds: string[]) => {
    setPlaylistDraft({ smart: false, itemIds });
  }, []);
  const openTagBrowser = () => {
    if (panel !== 'tags') tagReturnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setTagItemId(null); setTagWorkOpen(false); setPanel('tags');
  };
  const closeTags = () => {
    setPanel(null);
    requestAnimationFrame(() => {
      const target = tagReturnFocus.current;
      if (target?.isConnected) target.focus();
      else document.querySelector<HTMLButtonElement>('.source-sidebar button[aria-label="Tags"]')?.focus();
    });
  };


  return (
    <div
      className={`music-app${isMobile ? ' mobile-app' : ''}`}
      data-density={density}
      data-mobile-tab={isMobile ? mobileRoute.tab : undefined}
      data-ios-standalone={isMobile && iosStandalone ? 'true' : undefined}
      onDragEnter={(event) => {
        if (isImportOpen || !event.dataTransfer.types.includes('Files')) return;
        event.preventDefault();
        dragDepth.current += 1;
        setIsDragging(true);
      }}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes('Files')) event.preventDefault();
      }}
      onDragLeave={(event) => {
        if (isImportOpen || !event.dataTransfer.types.includes('Files')) return;
        dragDepth.current -= 1;
        if (dragDepth.current <= 0) setIsDragging(false);
      }}
      onDrop={(event) => {
        if (isImportOpen || !event.dataTransfer.types.includes('Files')) return;
        event.preventDefault();
        dragDepth.current = 0;
        setIsDragging(false);
        if (event.dataTransfer.files.length) {
          setDroppedFiles(Array.from(event.dataTransfer.files));
          setIsImportOpen(true);
        }
      }}
    >
      <header className="player-bar">
        <div className="player-audio">
          <AudioPlayer audioRef={audioRef} previewPauseRef={previewPauseRef} onPlaybackPosition={reportPlaybackPosition} onPlaybackState={setPlaybackState} items={items}
            onRevealCurrent={isMobile ? undefined : revealCurrentSong}
            mobile={isMobile} expanded={mobileRoute.tab === 'playing'}
            onExpand={() => { setPanel(null); navigateMobile({ ...mobileRoute, tab: 'playing' }); }}
            onQueue={() => { setPanel(null); navigateMobile({ ...mobileRoute, tab: 'queue' }); }}
            onOutput={() => setIsSonosOpen(true)} />
        </div>
        <div className="player-tools">
          <div className="library-search">
            <MusicIcon name="search" size={14} />
            <input ref={searchRef} type="search"
              aria-label={view === 'discover' ? 'Search discovery' : view === 'bookmarks' ? 'Filter bookmarks' : 'Search library'}
              placeholder={view === 'discover' ? 'Search sets and sources' : view === 'bookmarks' ? 'Filter bookmarks' : selectedPlaylist ? `Search ${selectedPlaylist.name}` : 'Search library'}
              value={searchQuery} autoComplete="off" onChange={event => setSearchQuery(event.target.value)}
              onKeyDown={event => { if (event.key === 'Escape') { setSearchQuery(''); searchRef.current?.blur(); } }} />
            {searchQuery ? <button aria-label="Clear search" onClick={() => { setSearchQuery(''); searchRef.current?.focus(); }}><MusicIcon name="close" size={13} /></button> : <kbd>/</kbd>}
          </div>
          <button className={`queue-toggle${queueDrop.dropTarget === 'button' ? ' drop-target' : ''}`} aria-label="Queue"
            title="Show or hide Up Next • Drop songs here to add to queue" aria-pressed={panel === 'queue'} onClick={toggleQueue}
            {...queueDrop.dropProps('button')}>
            <MusicIcon name="queue" size={18} />
            {(queueDrop.dropTarget === 'button' || manualQueue.length > 0) && <span className="queue-count" aria-hidden="true">{queueDrop.dropTarget === 'button' ? '+' : manualQueue.length}</span>}
          </button>
        </div>
      </header>
      {(sessionBusy || sharedSession.error) && <div className="session-banner" role={sharedSession.error ? 'alert' : 'status'}>
        <span>{sharedSession.error || (sharedSession.ready ? 'Reconnecting to playback…' : 'Connecting to playback…')}</span>
        {sharedSession.error && <button onClick={() => void sharedSession.refresh()}>Retry</button>}
      </div>}

      <main className={isMobile ? 'mobile-content' : `library-content${panel === 'tags' ? ' with-tags' : ''}`} aria-label={isMobile ? mobileRoute.tab === 'queue' ? 'Playback queue' : mobileRoute.tab === 'playing' ? 'Now playing' : 'Browse music' : view === 'discover' ? 'Music discovery' : 'Music library'}>
        {isMobile ? <>
          {mobileRoute.tab === 'queue' && <QueuePanel mobile disabled={sessionBusy} currentView={currentQueueView} dropActive={false} dropProps={{}}
            mobileSources={mobileQueueSources} />}
          {mobileRoute.tab === 'browse' && <div className="mobile-browse">
            <header className="mobile-browse-header"><h1>Browse</h1><div>
              <button aria-label="Import music" onClick={() => setIsImportOpen(true)}><MusicIcon name="plus" size={22} /></button>
              <button aria-label="Settings" onClick={() => setIsSettingsOpen(true)}><MusicIcon name="settings" size={22} /></button>
            </div></header>
            <nav className="mobile-browse-tabs" aria-label="Browse collections">
              {(['library', 'playlists', 'discover', 'bookmarks'] as const).map(browse => <button key={browse}
                aria-current={mobileRoute.browse === browse ? 'page' : undefined} onClick={() => browseMobile(browse)}>
                {browse[0].toUpperCase() + browse.slice(1)}</button>)}
            </nav>
            {mobileRoute.browse !== 'playlists' || mobileRoute.playlistId ? <div className="mobile-search">
              <MusicIcon name="search" /><input type="search" aria-label={view === 'discover' ? 'Search discovery' : view === 'bookmarks' ? 'Filter bookmarks' : 'Search library'}
                placeholder={view === 'discover' ? 'Search sets and sources' : view === 'bookmarks' ? 'Find a bookmark' : 'Songs, artists, albums, tags'}
                value={searchQuery} onChange={event => setSearchQuery(event.target.value)} />
              {searchQuery && <button aria-label="Clear search" onClick={() => setSearchQuery('')}><MusicIcon name="close" /></button>}
            </div> : null}
            {mobileRoute.browse === 'playlists' && !mobileRoute.playlistId ? <div className="mobile-playlists">
              <button className="mobile-new-playlist" onClick={() => setPlaylistDraft({ smart: false })}><MusicIcon name="plus" />New playlist</button>
              <button className="mobile-new-playlist" onClick={() => setPlaylistDraft({ smart: true })}><MusicIcon name="smart" />New Smart Playlist</button>
              {playlistError && <p role="alert">Could not load playlists. <button onClick={() => void queryClient.invalidateQueries({ queryKey: ['playlists'] })}>Retry</button></p>}
              {playlists.map(playlist => <button className="mobile-playlist-row" key={playlist.id} onClick={() => browseMobile('playlists', playlist.id)}>
                <MusicIcon name={playlist.smart_rules ? 'smart' : 'playlist'} size={24} /><span>{playlist.name}<small>{playlistItems(playlist, items, now, tags.data?.items).length} songs{playlist.smart_rules ? ' · Smart playlist' : ''}</small></span><span aria-hidden="true">›</span>
              </button>)}
              {!playlistError && !playlists.length && <p>No playlists yet. Create one to collect your songs.</p>}
            </div> : mobileRoute.browse === 'discover' ? <Discover searchQuery={deferredSearch} pauseForPreview={() => previewPauseRef.current?.() ?? Promise.resolve(false)} onOpenLibrary={() => {
              chooseCollection('all'); setLibrarySearch(''); browseMobile('library');
            }} /> : error ? <div className="library-message" role="alert">Couldn’t load the library. <button onClick={() => void queryClient.invalidateQueries({ queryKey: ['library'] })}>Retry</button></div>
              : isLoading ? <p className="mobile-loading" role="status">Loading music…</p>
              : mobileRoute.browse === 'bookmarks' ? <BookmarkSidebar items={items} onPlay={playBookmark} getPlaybackTime={getBookmarkPlaybackTime}
                query={deferredSearch} onQueryChange={setBookmarkSearch} hideSearch onNextMoment={nextMoment} onClearItem={() => setBookmarkItemId(null)} />
              : <>
                {selectedPlaylist ? <div className="mobile-collection-heading"><button onClick={() => browseMobile('playlists')}>‹ Playlists</button><h2>{selectedPlaylist.name}</h2>
                  <button onClick={() => setPlaylistDraft({ playlist: selectedPlaylist, smart: !!selectedPlaylist.smart_rules })}>Edit{selectedPlaylist.smart_rules ? ' rules' : ''}</button>
                  <button className="mobile-delete-playlist" disabled={playlistMutation.isPending} onClick={async () => {
                    if (!await requestConfirmation({ title: 'Delete playlist?', message: `“${selectedPlaylist.name}” will be deleted. The songs stay in your library.`, actionLabel: 'Delete playlist', destructive: true })) return;
                    try {
                      await playlistMutation.mutateAsync({ path: `/${selectedPlaylist.id}`, method: 'DELETE' });
                      setSelectedPlaylistId(null); browseMobile('playlists');
                    } catch { setPlaylistActionError('Could not delete the playlist. Please try again.'); }
                  }}>Delete playlist</button>
                  {playlistActionError && <p role="alert">{playlistActionError}</p>}</div>
                  : <div className="mobile-library-filter"><label>Show<select aria-label="Library collection" value={collection} onChange={event => chooseCollection(event.target.value as Collection)}>
                    <option value="all">All songs</option><option value="favourites">Favourites</option><option value="recent">Recently added</option><option value="unplayed">Unplayed</option></select></label><span>{filteredItems.length.toLocaleString()} songs</span></div>}
                <MobileLibrary key={`${selectedPlaylistId || collection}:${deferredLibrarySearch}`} items={filteredItems} playlists={playlists} disabled={sessionBusy}
                  contextName={currentViewName} onTags={manageTags} onBookmarks={manageBookmarks}
                  onNewPlaylist={newPlaylistFromSelection} />
                {!filteredItems.length && <p className="mobile-empty">{items.length ? 'No matching songs.' : 'Your library is empty.'}</p>}
              </>}
          </div>}
        </> : <>
        <LibrarySidebar active={activeSource} items={items} playlists={playlists} now={now} tagItems={tags.data?.items} discoveryCount={discoveryCount}
          playlistError={playlistError} onSelect={selectSource} onEdit={setPlaylistDraft}
          tagsOpen={panel === 'tags'} activeTagCount={activeTagCount} failedTagCount={failedTagCount}
          onTags={() => panel === 'tags' && !tagItemId ? setPanel(null) : openTagBrowser()}
          outputName={playbackTarget.kind === 'sonos' ? playbackTarget.groupName : ownsBrowserPlayback(playbackTarget) ? 'This browser' : currentItem ? 'Another browser' : 'Choose output'} onOutput={() => setIsSonosOpen(true)}
          onImport={() => setIsImportOpen(true)} onSettings={() => setIsSettingsOpen(true)} />
        <div className="library-results" aria-busy={(view !== 'discover' && isLoading) || searchQuery !== deferredSearch}>
          {view === 'discover' ? <Discover searchQuery={deferredSearch} pauseForPreview={() => previewPauseRef.current?.() ?? Promise.resolve(false)} onOpenLibrary={id => {
            chooseCollection('all'); setLibrarySearch(''); setRevealRequest({ itemId: id });
          }} /> : error ? <div className="library-message" role="alert">Couldn’t load the library. <button onClick={() => void queryClient.invalidateQueries({ queryKey: ['library'] })}>Retry</button></div>
            : isLoading || !sharedSession.ready ? <div className="library-message" role="status">Loading…</div>
            : view === 'bookmarks' ? <div className="bookmark-main-view">
              <BookmarkSidebar items={items} onPlay={playBookmark} getPlaybackTime={getBookmarkPlaybackTime} onClearItem={() => setBookmarkItemId(null)}
                query={deferredSearch} onQueryChange={setBookmarkSearch} hideSearch onNextMoment={nextMoment} />
            </div> : <>
              <div className="song-table">
                <LibraryTable key={selectedPlaylistId || collection} items={filteredItems} searchQuery="" playbackState={playbackState}
                  onlyFavouriteTracks={collection === 'favourites' || selectedPlaylist?.smart_rules?.favourites_only === true}
                  viewId={selectedPlaylistId || collection}
                  playlistId={selectedPlaylist?.smart_rules ? null : selectedPlaylistId}
                  contextName={currentViewName} allowReordering={!deferredLibrarySearch && !!selectedPlaylist && !selectedPlaylist.smart_rules}
                  onNewPlaylist={newPlaylistFromSelection}
                  onSelectionCountChange={reportSelectionCount}
                  onViewItemsChange={reportViewItems}
                  onSearchChange={setLibrarySearch} revealRequest={revealRequest} onRevealed={finishReveal}
                  onManageTags={manageTags} onFilterTag={browseTag} tagItems={tags.data?.items}
                  selectedTagItemId={panel === 'tags' ? tagItemId : null}
                  onManageBookmarks={manageBookmarks} />
              </div>
              {!filteredItems.length && <div className="library-message empty-grid-message">
                {items.length === 0 ? <>No music. <button onClick={() => setIsImportOpen(true)}>Import files or a link</button></>
                  : <>No matching tracks. {searchQuery && <button onClick={() => setSearchQuery('')}>Clear search</button>}</>}
              </div>}
            </>}
          <footer className="library-status" role="status">
            {view === 'discover' ? <span>{discoveryCount} sets in inbox · {discovery?.sources.length ?? 0} sources</span>
              : view === 'bookmarks' ? <span>{items.reduce((n, item) => n + Object.keys(item.bookmarks).length, 0)} bookmarks</span>
              : <span>{filteredItems.length.toLocaleString()}{filteredItems.length !== items.length && ` of ${items.length.toLocaleString()}`} {filteredItems.length === 1 ? 'track' : 'tracks'}{selectedPlaylist && ` · ${selectedPlaylist.name}`}
                <LibrarySelectionCount store={selectionCountStore} /></span>}
            {view === 'library' && selectedPlaylist?.smart_rules && <button onClick={() => setPlaylistDraft({ playlist: selectedPlaylist, smart: true })}>Edit rules…</button>}
            {view === 'bookmarks' && <button onClick={nextMoment} disabled={!moments.length}>Next saved moment</button>}
          </footer>
        </div>
        </>}
        {panel === 'tags' && <aside className="library-sidepanel tag-sidepanel">
          <button className="panel-close" aria-label="Close tags" onClick={closeTags}><MusicIcon name="close" size={14} /></button>
          {tagItemId ? <TagPanel key={tagItemId} item={items.find(item => item.id === tagItemId)} snapshot={tags.data}
            loading={tags.isLoading} loadError={tags.error} onPlay={play} onFilterTag={browseTag} onBrowse={openTagBrowser} />
            : <TagBrowser items={items} snapshot={tags.data} showWork={tagWorkOpen} onShowWork={setTagWorkOpen}
              onFilterTag={browseTag} onEdit={setTagItem => setTagItemId(setTagItem.id)} loadError={tags.error} />}
        </aside>}
        {panel === 'bookmarks' && <aside className="library-sidepanel bookmark-sidepanel">
          <button className="panel-close" aria-label="Close bookmarks" onClick={() => setPanel(null)}><MusicIcon name="close" size={14} /></button>
          <BookmarkSidebar key={bookmarkItemId || 'all'} items={items} onPlay={playBookmark} getPlaybackTime={getBookmarkPlaybackTime}
            selectedItem={items.find(item => item.id === bookmarkItemId)} onClearItem={() => setBookmarkItemId(null)} onNextMoment={nextMoment} />
        </aside>}
        {!isMobile && panel === 'queue' && <aside className="library-sidepanel queue-sidepanel">
          <button className="panel-close" aria-label="Close queue" onClick={() => setPanel(null)}><MusicIcon name="close" size={14} /></button>
          <QueuePanel disabled={sessionBusy} currentView={currentQueueView} dropActive={queueDrop.dropTarget === 'panel'} dropProps={queueDrop.dropProps('panel')} />
        </aside>}
      </main>
      {isMobile && <nav className="mobile-bottom-nav" aria-label="Main navigation">
        {(['playing', 'queue', 'browse'] as const).map(tab => <button key={tab} aria-current={mobileRoute.tab === tab ? 'page' : undefined}
          onClick={() => { setPanel(null); navigateMobile({ ...mobileRoute, tab }); }}>
          <MusicIcon name={tab === 'playing' ? 'play' : tab === 'queue' ? 'queue' : 'music'} size={23} />
          <span>{tab[0].toUpperCase() + tab.slice(1)}</span>
        </button>)}
      </nav>}
      {playlistDraft && <PlaylistDialog draft={playlistDraft} items={items} tagItems={tags.data?.items} tagError={tags.isError} onClose={() => setPlaylistDraft(null)}
        onSaved={id => { setPlaylistDraft(null); selectSource('playlist:' + id); if (isMobile) browseMobile('playlists', id); }} />}
      {isDragging && <div className="global-drop-overlay">Drop audio files to import</div>}
      <ImportMusic
        isOpen={isImportOpen}
        onClose={() => setIsImportOpen(false)}
        droppedFiles={droppedFiles}
        onDroppedFilesConsumed={() => setDroppedFiles([])}
        onImported={() => {
          setIsImportOpen(false);
          chooseCollection('recent');
          setLibrarySearch('');
          if (isMobile) browseMobile('library');
        }}
      />
      <AppDialogs />
      <SonosModal audioRef={audioRef} items={items} isOpen={isSonosOpen} onClose={() => setIsSonosOpen(false)} />
      <SettingsDialog
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        outputName={
          playbackTarget.kind === 'sonos'
            ? playbackTarget.groupName
            : ownsBrowserPlayback(playbackTarget) ? isMobile ? 'This device' : 'This browser' : currentItem ? 'Another browser' : 'Choose output'
        }
        onChooseOutput={() => {
          setIsSettingsOpen(false);
          setIsSonosOpen(true);
        }}
      />
    </div>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AppContent />
    </QueryClientProvider>
  );
}
