import { useState, useCallback, useMemo } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AudioPlayer } from './components/AudioPlayer';
import { LibraryTable } from './components/LibraryTable';
import { SearchBar } from './components/SearchBar';
import { QueuePanel } from './components/QueuePanel';
import { UploadModal } from './components/UploadModal';
import { PlaylistSidebar } from './components/PlaylistSidebar';
import { useLibrary } from './hooks/useLibrary';
import { usePlayerStore } from './stores/playerStore';
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
};

const queryClient = new QueryClient();

function AppContent() {
  const [searchQuery, setSearchQuery] = useState('');
  const [isQueueOpen, setIsQueueOpen] = useState(false);
  const [isUploadOpen, setIsUploadOpen] = useState(false);
  const [isPlaylistsOpen, setIsPlaylistsOpen] = useState(false);
  const [selectedPlaylistId, setSelectedPlaylistId] = useState<string | null>(null);

  const { items, isLoading, error } = useLibrary();
  const { play } = usePlayerStore();

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
    play(random.item, random.position);
  }, [allRandomTargets, play]);

  const toggleQueue = useCallback(() => {
    setIsQueueOpen((prev) => !prev);
  }, []);

  const toggleUpload = useCallback(() => {
    setIsUploadOpen((prev) => !prev);
  }, []);

  const togglePlaylists = useCallback(() => {
    setIsPlaylistsOpen((prev) => !prev);
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
        <AudioPlayer />
        <div className="flex justify-between items-center px-4 pb-2">
          <button
            onClick={togglePlaylists}
            className={`p-1.5 rounded transition-colors ${
              isPlaylistsOpen
                ? 'text-solarized-cyan bg-solarized-base02'
                : 'text-solarized-base0 hover:text-solarized-base1 hover:bg-solarized-base02'
            }`}
            title="Playlists"
          >
            {Icons.playlist}
          </button>
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
