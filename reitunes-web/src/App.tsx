import { useState, useCallback, useEffect, useMemo } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AudioPlayer } from './components/AudioPlayer';
import { LibraryTable } from './components/LibraryTable';
import { SearchBar } from './components/SearchBar';
import { QueuePanel } from './components/QueuePanel';
import { UploadModal } from './components/UploadModal';
import { DownloadModal } from './components/DownloadModal';
import { PlaylistSidebar } from './components/PlaylistSidebar';
import { BookmarkSidebar } from './components/BookmarkSidebar';
import { SonosModal } from './components/SonosModal';
import { useLibrary } from './hooks/useLibrary';
import { useQueueStore } from './hooks/useQueue';
import { usePlayback } from './hooks/usePlayback';
import { usePlayerStore } from './stores/playerStore';
import { usePlaybackTargetStore } from './stores/playbackTargetStore';
import type { LibraryItem } from './types';

// Toolbar icons
const Icons = {
  playlist: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 18V5l12-2v13" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="18" cy="16" r="3" />
    </svg>
  ),
  bookmark: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1z" />
    </svg>
  ),
  upload: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </svg>
  ),
  queue: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="8" y1="6" x2="21" y2="6" />
      <line x1="8" y1="12" x2="21" y2="12" />
      <line x1="8" y1="18" x2="21" y2="18" />
      <line x1="3" y1="6" x2="3.01" y2="6" />
      <line x1="3" y1="12" x2="3.01" y2="12" />
      <line x1="3" y1="18" x2="3.01" y2="18" />
    </svg>
  ),
  download: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  ),
  sonos: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 8.5a5 5 0 0 1 0 7" />
      <path d="M8.5 5a10 10 0 0 1 0 14" />
      <circle cx="3" cy="12" r="1" fill="currentColor" stroke="none" />
      <rect x="13" y="4" width="8" height="16" rx="2" />
      <circle cx="17" cy="9" r="1.5" />
      <circle cx="17" cy="15" r="2.5" />
    </svg>
  ),
};

const queryClient = new QueryClient();

function AppContent() {
  const [searchQuery, setSearchQuery] = useState('');
  const [isQueueOpen, setIsQueueOpen] = useState(false);
  const [isUploadOpen, setIsUploadOpen] = useState(false);
  const [isDownloadOpen, setIsDownloadOpen] = useState(false);
  const [isPlaylistsOpen, setIsPlaylistsOpen] = useState(false);
  const [isBookmarksOpen, setIsBookmarksOpen] = useState(false);
  const [isSonosOpen, setIsSonosOpen] = useState(
    () =>
      window.location.hash === '#sonos=connected' ||
      new URLSearchParams(window.location.search).get('sonos') === 'connected'
  );
  const [selectedPlaylistId, setSelectedPlaylistId] = useState<string | null>(null);

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
  const { reconcileWithLibrary } = useQueueStore();

  // Resolve persisted IDs and stale queue snapshots against the current library.
  // Restored tracks stay paused until the user explicitly resumes playback.
  useEffect(() => {
    if (isLoading) return;

    reconcileWithLibrary(items);

    if (!currentItemId) return;
    const libraryItem = items.find((item) => item.id === currentItemId);
    if (!libraryItem) {
      clearCurrentItem();
    } else if (!currentItem) {
      restoreCurrentItem(libraryItem);
    } else if (currentItem !== libraryItem) {
      refreshCurrentItem(libraryItem);
    }
  }, [
    items,
    isLoading,
    currentItem,
    currentItemId,
    clearCurrentItem,
    reconcileWithLibrary,
    refreshCurrentItem,
    restoreCurrentItem,
  ]);

  // Get all random targets: bookmarks + favourited songs (from start)
  const allRandomTargets = useMemo(() => {
    const targets: { item: LibraryItem; position: number }[] = [];
    items.forEach((item) => {
      Object.values(item.bookmarks).forEach((bookmark) => {
        targets.push({ item, position: bookmark.position });
      });
      if (item.is_favorite) {
        targets.push({ item, position: 0 });
      }
    });
    return targets;
  }, [items]);

  const handleRandomBookmark = useCallback(() => {
    if (allRandomTargets.length === 0) {
      alert('No bookmarks or favourites found in the library.');
      return;
    }
    const random = allRandomTargets[Math.floor(Math.random() * allRandomTargets.length)];
    void play(random.item, random.position);
  }, [allRandomTargets, play]);

  const toggleQueue = useCallback(() => {
    setIsQueueOpen((prev) => !prev);
  }, []);

  const toggleUpload = useCallback(() => {
    setIsUploadOpen((prev) => !prev);
  }, []);

  const toggleDownload = useCallback(() => {
    setIsDownloadOpen((prev) => !prev);
  }, []);

  const togglePlaylists = useCallback(() => {
    setIsPlaylistsOpen((prev) => !prev);
    setIsBookmarksOpen(false);
  }, []);

  const toggleBookmarks = useCallback(() => {
    setIsBookmarksOpen((prev) => !prev);
    setIsPlaylistsOpen(false);
  }, []);

  useEffect(() => {
    const url = new URL(window.location.href);
    const hasSonosQuery = url.searchParams.has('sonos');
    const hasSonosHash = url.hash === '#sonos=connected';
    if (hasSonosQuery || hasSonosHash) {
      url.searchParams.delete('sonos');
      if (hasSonosHash) url.hash = '';
      window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
    }
  }, []);

  if (error) {
    return (
      <div className="flex items-center justify-center h-screen bg-solarized-base03 text-solarized-red">
        Error loading library: {String(error)}
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col bg-solarized-base03 text-solarized-base1 font-mono overflow-hidden">
      {/* Header - sticky at top */}
      <div className="flex-shrink-0 bg-solarized-base03 z-10 border-b border-solarized-base02">
        <AudioPlayer items={items} onChooseOutput={() => setIsSonosOpen(true)} />
        <div className="flex justify-between items-center px-4 pb-2">
          <div className="flex items-center gap-1">
            <button
              onClick={togglePlaylists}
              className={`p-1.5 rounded transition-colors ${
                isPlaylistsOpen
                  ? 'text-solarized-cyan bg-solarized-base02'
                  : 'text-solarized-base0 hover:text-solarized-base1 hover:bg-solarized-base02'
              }`}
              title="Playlists"
              aria-label="Playlists"
            >
              {Icons.playlist}
            </button>
            <button
              onClick={toggleBookmarks}
              className={`p-1.5 rounded transition-colors ${
                isBookmarksOpen
                  ? 'text-solarized-cyan bg-solarized-base02'
                  : 'text-solarized-base0 hover:text-solarized-base1 hover:bg-solarized-base02'
              }`}
              title="Bookmarks"
              aria-label="Bookmarks"
            >
              {Icons.bookmark}
            </button>
          </div>
          <div className="flex items-center gap-2">
            <SearchBar
              value={searchQuery}
              onChange={setSearchQuery}
              onRandomBookmark={handleRandomBookmark}
            />
            <button
              onClick={toggleUpload}
              className="p-1.5 text-solarized-base0 hover:text-solarized-green hover:bg-solarized-base02 rounded transition-colors"
              title="Upload"
            >
              {Icons.upload}
            </button>
            <button
              onClick={toggleDownload}
              className="p-1.5 text-solarized-base0 hover:text-solarized-green hover:bg-solarized-base02 rounded transition-colors"
              title="Download from URL"
            >
              {Icons.download}
            </button>
            <button
              onClick={() => setIsSonosOpen(true)}
              className={`p-1.5 rounded transition-colors flex items-center gap-1.5 max-w-48 ${
                playbackTarget.kind === 'sonos'
                  ? 'text-solarized-cyan bg-solarized-base02'
                  : 'text-solarized-base0 hover:text-solarized-cyan hover:bg-solarized-base02'
              }`}
              title={
                playbackTarget.kind === 'sonos'
                  ? `Playback output: ${playbackTarget.groupName}`
                  : 'Playback output: This browser'
              }
              aria-label="Sonos"
            >
              {Icons.sonos}
              {playbackTarget.kind === 'sonos' && (
                <span className="text-xs truncate hidden sm:inline">
                  {playbackTarget.groupName}
                </span>
              )}
            </button>
            <button
              onClick={toggleQueue}
              className={`p-1.5 rounded transition-colors ${
                isQueueOpen
                  ? 'text-solarized-cyan bg-solarized-base02'
                  : 'text-solarized-base0 hover:text-solarized-base1 hover:bg-solarized-base02'
              }`}
              title="Queue"
            >
              {Icons.queue}
            </button>
          </div>
        </div>
      </div>

      {/* Main content area with sidebars */}
      <div className="flex-grow flex overflow-hidden">
        {/* Playlist Sidebar - left */}
        {isPlaylistsOpen && (
          <PlaylistSidebar
            selectedPlaylistId={selectedPlaylistId}
            onSelectPlaylist={setSelectedPlaylistId}
          />
        )}

        {isBookmarksOpen && <BookmarkSidebar items={items} onPlay={play} />}

        {/* Main table - center */}
        <div className="flex-grow overflow-hidden">
          {isLoading ? (
            <div className="flex items-center justify-center h-64 text-solarized-base0">
              Loading...
            </div>
          ) : (
            <LibraryTable
              items={items}
              searchQuery={searchQuery}
              playlistId={selectedPlaylistId}
              onSearchChange={setSearchQuery}
            />
          )}
        </div>

        {/* Queue Panel - right */}
        {isQueueOpen && <QueuePanel />}
      </div>

      <UploadModal isOpen={isUploadOpen} onClose={() => setIsUploadOpen(false)} />
      <DownloadModal isOpen={isDownloadOpen} onClose={() => setIsDownloadOpen(false)} />
      <SonosModal isOpen={isSonosOpen} onClose={() => setIsSonosOpen(false)} />
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
