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
  useQuery,
} from '@tanstack/react-query';
import { AudioPlayer } from './components/AudioPlayer';
import { LibraryTable } from './components/LibraryTable';
import { MusicIcon } from './components/MusicIcon';
import { ImportMusic } from './components/ImportMusic';
import { QueuePanel } from './components/QueuePanel';
import { PlaylistSidebar } from './components/PlaylistSidebar';
import { BookmarkSidebar } from './components/BookmarkSidebar';
import { SonosModal } from './components/SonosModal';
import { SettingsDialog } from './components/SettingsDialog';
import { useLibrary } from './hooks/useLibrary';
import { useQueueStore } from './hooks/useQueue';
import { usePlayback } from './hooks/usePlayback';
import { usePlayerStore } from './stores/playerStore';
import { usePlaybackTargetStore } from './stores/playbackTargetStore';
import { matchesLibrarySearch } from './utils/libraryBrowser';
import './App.css';

const queryClient = new QueryClient();
type Collection = 'all' | 'favourites' | 'recent' | 'unplayed';
interface Playlist {
  id: string;
  name: string;
  items: Record<string, { library_item_id: string; position: number }>;
}

function AppContent() {
  const [searchQuery, setSearchQuery] = useState('');
  const deferredSearch = useDeferredValue(searchQuery);
  const [collection, setCollection] = useState<Collection>('all');
  const [recentCutoff, setRecentCutoff] = useState(
    () => Date.now() - 30 * 24 * 60 * 60 * 1000
  );
  const [panel, setPanel] = useState<
    'queue' | 'bookmarks' | 'playlists' | null
  >(null);
  const [isImportOpen, setIsImportOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [droppedFiles, setDroppedFiles] = useState<File[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const dragDepth = useRef(0);
  const searchRef = useRef<HTMLInputElement>(null);
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
  const play = usePlayback();
  const {
    currentItem,
    currentItemId,
    restoreCurrentItem,
    refreshCurrentItem,
    clearCurrentItem,
  } = usePlayerStore();
  const playbackTarget = usePlaybackTargetStore((state) => state.target);
  const { reconcileWithLibrary, setContext, manualQueue } = useQueueStore();
  const { data: playlists = [] } = useQuery<Playlist[]>({
    queryKey: ['playlists'],
    queryFn: async () => {
      const response = await fetch('/api/playlists');
      if (!response.ok) throw new Error('Failed to fetch playlists');
      return response.json();
    },
  });

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
  const filteredItems = useMemo(() => {
    const playlistIds = selectedPlaylist
      ? new Set(
          Object.values(selectedPlaylist.items).map(
            (item) => item.library_item_id
          )
        )
      : null;
    return items.filter((item) => {
      if (playlistIds && !playlistIds.has(item.id)) return false;
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
      return matchesLibrarySearch(item, deferredSearch);
    });
  }, [items, selectedPlaylist, collection, deferredSearch, recentCutoff]);
  const moments = useMemo(
    () =>
      filteredItems.flatMap((item) =>
        Object.values(item.bookmarks)
          .sort((a, b) => a.position - b.position)
          .map((bookmark) => ({ item, bookmark }))
      ),
    [filteredItems]
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
    setContext(
      filteredItems,
      filteredItems.findIndex((item) => item.id === next.item.id),
      'Saved moments',
      true
    );
    void play(next.item, next.bookmark.position);
  }, [moments, currentItemId, setContext, filteredItems, play]);
  const randomFavourite = useCallback(() => {
    const targets = items.flatMap((item) => [
      ...Object.values(item.bookmarks).map((bookmark) => ({
        item,
        position: bookmark.position,
      })),
      ...(item.is_favorite ? [{ item, position: 0 }] : []),
    ]);
    if (!targets.length) return;
    const next = targets[Math.floor(Math.random() * targets.length)];
    void play(next.item, next.position);
  }, [items, play]);

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
        randomFavourite();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [randomFavourite]);

  const chooseCollection = (next: Collection) => {
    setCollection(next);
    setSelectedPlaylistId(null);
    if (next === 'recent')
      setRecentCutoff(Date.now() - 30 * 24 * 60 * 60 * 1000);
  };
  const togglePanel = (next: typeof panel) =>
    setPanel(panel === next ? null : next);

  return (
    <div
      className="music-app"
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
        <span className="app-name">ReiTunes</span>
        <AudioPlayer
          onPlaybackPosition={reportPlaybackPosition}
          items={items}
          onChooseOutput={() => setIsSonosOpen(true)}
        />
        <button
          className="output-button"
          onClick={() => setIsSonosOpen(true)}
          aria-label="Sonos"
          title="Choose playback output"
        >
          <MusicIcon name="speaker" size={14} />
          <span>
            {playbackTarget.kind === 'sonos'
              ? playbackTarget.groupName
              : 'This browser'}
          </span>
        </button>
        <button
          className="settings-button"
          aria-label="Settings"
          title="Settings"
          onClick={() => setIsSettingsOpen(true)}
        >
          <MusicIcon name="settings" size={16} />
        </button>
      </header>

      <div className="library-toolbar">
        <div className="library-search">
          <MusicIcon name="search" size={14} />
          <input
            ref={searchRef}
            type="search"
            aria-label="Search library"
            placeholder="Search"
            value={searchQuery}
            autoComplete="off"
            onChange={(event) => setSearchQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setSearchQuery('');
                searchRef.current?.blur();
              }
            }}
          />
          {searchQuery ? (
            <button
              onClick={() => {
                setSearchQuery('');
                searchRef.current?.focus();
              }}
              aria-label="Clear search"
            >
              <MusicIcon name="close" size={13} />
            </button>
          ) : (
            <kbd>/</kbd>
          )}
        </div>
        <select
          aria-label="Collection"
          value={
            selectedPlaylistId ? `playlist:${selectedPlaylistId}` : collection
          }
          onChange={(event) =>
            chooseCollection(event.target.value as Collection)
          }
        >
          <option value="all">All music</option>
          <option value="favourites">Favourites</option>
          <option value="recent">Recently added</option>
          <option value="unplayed">Unplayed</option>
          {selectedPlaylist && (
            <option value={`playlist:${selectedPlaylist.id}`}>
              {selectedPlaylist.name}
            </option>
          )}
        </select>
        <div className="toolbar-actions">
          <button onClick={() => setIsImportOpen(true)}>
            <MusicIcon name="plus" size={14} />
            Import music
          </button>
          <button
            onClick={() => togglePanel('playlists')}
            aria-pressed={panel === 'playlists'}
          >
            Playlists
          </button>
          <button
            onClick={() => togglePanel('bookmarks')}
            aria-pressed={panel === 'bookmarks'}
          >
            Bookmarks
          </button>
          <button
            onClick={nextMoment}
            disabled={!moments.length}
            title="Jump to the next bookmark"
          >
            Next saved moment
          </button>
          <button
            aria-label="Queue"
            aria-pressed={panel === 'queue'}
            onClick={() => togglePanel('queue')}
          >
            Queue{manualQueue.length > 0 && ` (${manualQueue.length})`}
          </button>
        </div>
      </div>

      <main className="library-content" aria-label="Music library">
        {panel === 'playlists' && (
          <aside className="library-sidepanel">
            <button
              className="panel-close"
              aria-label="Close playlists"
              onClick={() => setPanel(null)}
            >
              <MusicIcon name="close" size={14} />
            </button>
            <PlaylistSidebar
              selectedPlaylistId={selectedPlaylistId}
              onSelectPlaylist={(id) => {
                setSelectedPlaylistId(id);
                setCollection('all');
              }}
            />
          </aside>
        )}
        {panel === 'bookmarks' && (
          <aside className="library-sidepanel">
            <button
              className="panel-close"
              aria-label="Close bookmarks"
              onClick={() => setPanel(null)}
            >
              <MusicIcon name="close" size={14} />
            </button>
            <BookmarkSidebar items={filteredItems} onPlay={play} />
          </aside>
        )}
        <div
          className="library-results"
          aria-busy={isLoading || searchQuery !== deferredSearch}
        >
          {error ? (
            <div className="library-message" role="alert">
              Couldn’t load the library.{' '}
              <button
                onClick={() =>
                  void queryClient.invalidateQueries({ queryKey: ['library'] })
                }
              >
                Retry
              </button>
            </div>
          ) : isLoading ? (
            <div className="library-message" role="status">
              Loading…
            </div>
          ) : (
            <>
              <div className="song-table">
                <LibraryTable
                  key={selectedPlaylistId || 'library'}
                  items={filteredItems}
                  searchQuery=""
                  playlistId={selectedPlaylistId}
                  onSearchChange={setSearchQuery}
                />
              </div>
              {!filteredItems.length && (
                <div className="library-message empty-grid-message">
                  {items.length === 0 ? (
                    <>
                      No music.{' '}
                      <button onClick={() => setIsImportOpen(true)}>
                        Import files or a link
                      </button>
                    </>
                  ) : (
                    <>
                      No matching tracks.{' '}
                      {searchQuery && (
                        <button onClick={() => setSearchQuery('')}>
                          Clear search
                        </button>
                      )}
                    </>
                  )}
                </div>
              )}
            </>
          )}
        </div>
        {panel === 'queue' && (
          <aside className="library-sidepanel queue-sidepanel">
            <button
              className="panel-close"
              aria-label="Close queue"
              onClick={() => setPanel(null)}
            >
              <MusicIcon name="close" size={14} />
            </button>
            <QueuePanel />
          </aside>
        )}
      </main>

      <footer className="library-status" role="status">
        <span>
          {filteredItems.length.toLocaleString()}
          {filteredItems.length !== items.length &&
            ` of ${items.length.toLocaleString()}`}{' '}
          {items.length === 1 ? 'track' : 'tracks'}
          {selectedPlaylist && ` · ${selectedPlaylist.name}`}
        </span>
        {collection === 'recent' && <span>Last 30 days</span>}
      </footer>
      {isDragging && (
        <div className="global-drop-overlay">Drop audio files to import</div>
      )}
      <ImportMusic
        isOpen={isImportOpen}
        onClose={() => setIsImportOpen(false)}
        droppedFiles={droppedFiles}
        onDroppedFilesConsumed={() => setDroppedFiles([])}
        onImported={() => {
          setIsImportOpen(false);
          chooseCollection('recent');
          setSearchQuery('');
        }}
      />
      <SonosModal isOpen={isSonosOpen} onClose={() => setIsSonosOpen(false)} />
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
