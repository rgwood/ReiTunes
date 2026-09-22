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
import { AudioPlayer } from './components/AudioPlayer';
import { LibraryTable } from './components/LibraryTable';
import { MusicIcon } from './components/MusicIcon';
import { ImportMusic } from './components/ImportMusic';
import { QueuePanel } from './components/QueuePanel';
import { LibrarySidebar } from './components/LibrarySidebar';
import { PlaylistDialog, type PlaylistDraft } from './components/PlaylistDialog';
import { usePlaylists } from './hooks/usePlaylists';
import { playlistItems } from './utils/playlists';
import { useLibraryPreferences } from './stores/libraryPreferences';
import { BookmarkSidebar } from './components/BookmarkSidebar';
import type { PlaybackRange } from './stores/playerStore';
import { SonosModal } from './components/SonosModal';
import { SettingsDialog } from './components/SettingsDialog';
import { Discover } from './components/Discover';
import { TagPanel } from './components/TagPanel';
import { TagBrowser } from './components/TagBrowser';
import { effectiveTags, useTags } from './hooks/useTags';
import { isInboxEntry, useDiscovery } from './hooks/useDiscovery';
import { useLibrary } from './hooks/useLibrary';
import { useQueueStore } from './hooks/useQueue';
import { usePlayback } from './hooks/usePlayback';
import { usePlayerStore } from './stores/playerStore';
import { usePlaybackTargetStore } from './stores/playbackTargetStore';
import type { LibraryItem } from './types';
import { createLibrarySearch, tagSearch } from './utils/libraryBrowser';
import './App.css';
import './LibraryLayout.css';
import './components/Tags.css';

const queryClient = new QueryClient();
type Collection = 'all' | 'favourites' | 'recent' | 'unplayed';

function AppContent() {
  const [view, setView] = useState<'library' | 'discover' | 'bookmarks'>('library');
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
  const [collection, setCollection] = useState<Collection>('all');
  const [revealRequest, setRevealRequest] = useState<{ itemId: string } | null>(null);
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
  const playbackPosition = useRef<{ itemId: string; position: number } | null>(
    null
  );
  const reportPlaybackPosition = useCallback(
    (itemId: string, position: number) => {
      playbackPosition.current = { itemId, position };
    },
    []
  );
  const [selectedPlaylistId, setSelectedPlaylistId] = useState<string | null>(
    null
  );
  const [isSonosOpen, setIsSonosOpen] = useState(
    () =>
      window.location.hash === '#sonos=connected' ||
      new URLSearchParams(window.location.search).get('sonos') === 'connected'
  );
  const { items, isLoading, error } = useLibrary();
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
  } = usePlayerStore();
  const playbackTarget = usePlaybackTargetStore((state) => state.target);
  const { reconcileWithLibrary, setContext, manualQueue } = useQueueStore();
  const { data: playlists = [], isError: playlistError } = usePlaylists();

  useEffect(() => {
    if (isLoading || error) return;
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
    const candidates = selectedPlaylist ? playlistItems(selectedPlaylist, items, now) : items;
    return candidates.filter((item) => {
      if (collection === 'favourites' && !item.is_favorite) return false;
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
  }, [items, selectedPlaylist, collection, matchesSearch, recentCutoff, now]);
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

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (document.querySelector('dialog[open], [role="dialog"]')) return;
      const editing = (event.target as HTMLElement).closest(
        'input, textarea, select, [contenteditable="true"]'
      );
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
  }, [randomFavourite]);

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
  const toggleQueue = () => setPanel(panel === 'queue' ? null : 'queue');
  const browseTag = useCallback((tag: string) => {
    setView('library'); setCollection('all'); setSelectedPlaylistId(null);
    setLibrarySearch(tagSearch(tag)); setPanel(null);
  }, []);
  const manageTags = useCallback((item: LibraryItem) => {
    tagReturnFocus.current = document.activeElement instanceof HTMLElement && document.activeElement.matches('.row-tag-edit')
      ? document.activeElement : document.querySelector<HTMLElement>(`tr[data-item-id="${CSS.escape(item.id)}"]`);
    setTagItemId(item.id); setPanel('tags');
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
      className="music-app"
      data-density={density}
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
          <AudioPlayer audioRef={audioRef} onPlaybackPosition={reportPlaybackPosition} items={items} />
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
          <button className="queue-toggle" aria-label="Queue" title={panel === 'queue' ? 'Hide Up next' : 'Show Up next'} aria-pressed={panel === 'queue'} onClick={toggleQueue}>
            <MusicIcon name="queue" size={18} />
            {manualQueue.length > 0 && <span className="queue-count" aria-hidden="true">{manualQueue.length}</span>}
          </button>
        </div>
      </header>

      <main className={`library-content${panel === 'tags' ? ' with-tags' : ''}`} aria-label={view === 'discover' ? 'Music discovery' : 'Music library'}>
        <LibrarySidebar active={activeSource} items={items} playlists={playlists} now={now} discoveryCount={discoveryCount}
          playlistError={playlistError} onSelect={selectSource} onEdit={setPlaylistDraft}
          tagsOpen={panel === 'tags'} activeTagCount={activeTagCount} failedTagCount={failedTagCount}
          onTags={() => panel === 'tags' && !tagItemId ? setPanel(null) : openTagBrowser()}
          outputName={playbackTarget.kind === 'sonos' ? playbackTarget.groupName : 'This browser'} onOutput={() => setIsSonosOpen(true)}
          onImport={() => setIsImportOpen(true)} onSettings={() => setIsSettingsOpen(true)} />
        <div className="library-results" aria-busy={(view !== 'discover' && isLoading) || searchQuery !== deferredSearch}>
          {view === 'discover' ? <Discover searchQuery={deferredSearch} onOpenLibrary={id => {
            chooseCollection('all'); setLibrarySearch(''); setRevealRequest({ itemId: id });
          }} /> : error ? <div className="library-message" role="alert">Couldn’t load the library. <button onClick={() => void queryClient.invalidateQueries({ queryKey: ['library'] })}>Retry</button></div>
            : isLoading ? <div className="library-message" role="status">Loading…</div>
            : view === 'bookmarks' ? <div className="bookmark-main-view">
              <BookmarkSidebar items={items} onPlay={playBookmark} getPlaybackTime={getBookmarkPlaybackTime} onClearItem={() => setBookmarkItemId(null)}
                query={deferredSearch} onQueryChange={setBookmarkSearch} hideSearch onNextMoment={nextMoment} />
            </div> : <>
              <div className="song-table">
                <LibraryTable key={selectedPlaylistId || collection} items={filteredItems} searchQuery=""
                  viewId={selectedPlaylistId || collection}
                  playlistId={selectedPlaylist?.smart_rules ? null : selectedPlaylistId}
                  contextName={selectedPlaylist?.name} allowReordering={!librarySearch && !!selectedPlaylist && !selectedPlaylist.smart_rules}
                  onNewPlaylist={itemIds => setPlaylistDraft({ smart: false, itemIds })}
                  onSearchChange={setLibrarySearch} revealRequest={revealRequest} onRevealed={finishReveal}
                  onManageTags={manageTags} onFilterTag={browseTag} tagItems={tags.data?.items}
                  selectedTagItemId={panel === 'tags' ? tagItemId : null}
                  onManageBookmarks={item => { setBookmarkItemId(item.id); setPanel('bookmarks'); }} />
              </div>
              {!filteredItems.length && <div className="library-message empty-grid-message">
                {items.length === 0 ? <>No music. <button onClick={() => setIsImportOpen(true)}>Import files or a link</button></>
                  : <>No matching tracks. {searchQuery && <button onClick={() => setSearchQuery('')}>Clear search</button>}</>}
              </div>}
            </>}
          <footer className="library-status" role="status">
            {view === 'discover' ? <span>{discoveryCount} sets in inbox · {discovery?.sources.length ?? 0} sources</span>
              : view === 'bookmarks' ? <span>{items.reduce((n, item) => n + Object.keys(item.bookmarks).length, 0)} bookmarks</span>
              : <span>{filteredItems.length.toLocaleString()}{filteredItems.length !== items.length && ` of ${items.length.toLocaleString()}`} {filteredItems.length === 1 ? 'track' : 'tracks'}{selectedPlaylist && ` · ${selectedPlaylist.name}`}</span>}
            {view === 'library' && selectedPlaylist?.smart_rules && <button onClick={() => setPlaylistDraft({ playlist: selectedPlaylist, smart: true })}>Edit rules…</button>}
            {view === 'bookmarks' && <button onClick={nextMoment} disabled={!moments.length}>Next saved moment</button>}
          </footer>
        </div>
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
        {panel === 'queue' && <aside className="library-sidepanel queue-sidepanel">
          <button className="panel-close" aria-label="Close queue" onClick={() => setPanel(null)}><MusicIcon name="close" size={14} /></button><QueuePanel />
        </aside>}
      </main>
      {playlistDraft && <PlaylistDialog draft={playlistDraft} items={items} onClose={() => setPlaylistDraft(null)}
        onSaved={id => { setPlaylistDraft(null); selectSource('playlist:' + id); }} />}
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
        }}
      />
      <SonosModal audioRef={audioRef} items={items} isOpen={isSonosOpen} onClose={() => setIsSonosOpen(false)} />
      <SettingsDialog
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        outputName={
          playbackTarget.kind === 'sonos'
            ? playbackTarget.groupName
            : 'This browser'
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
