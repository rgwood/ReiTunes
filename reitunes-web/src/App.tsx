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

const queryClient = new QueryClient();

function AppContent() {
  const [searchQuery, setSearchQuery] = useState('');
  const [isQueueOpen, setIsQueueOpen] = useState(false);
  const [isUploadOpen, setIsUploadOpen] = useState(false);
  const [isPlaylistsOpen, setIsPlaylistsOpen] = useState(false);
  const [selectedPlaylistId, setSelectedPlaylistId] = useState<string | null>(null);

  const { items, isLoading, error } = useLibrary();
  const { play } = usePlayerStore();

  // Get all bookmarks for random bookmark feature
  const allBookmarks = useMemo(() => {
    const bookmarks: { item: LibraryItem; position: number }[] = [];
    items.forEach((item) => {
      Object.values(item.bookmarks).forEach((bookmark) => {
        bookmarks.push({ item, position: bookmark.position });
      });
    });
    return bookmarks;
  }, [items]);

  const handleRandomBookmark = useCallback(() => {
    if (allBookmarks.length === 0) {
      alert('No bookmarks found in the library.');
      return;
    }
    const random = allBookmarks[Math.floor(Math.random() * allBookmarks.length)];
    play(random.item, random.position);
  }, [allBookmarks, play]);

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
      <div className="flex-shrink-0 bg-solarized-base03 z-10">
        <AudioPlayer />
        <div className="flex justify-between items-center px-5 pb-3">
          <button
            onClick={togglePlaylists}
            className={`px-3 py-1 rounded transition-colors duration-300 ${
              isPlaylistsOpen
                ? 'bg-solarized-cyan text-solarized-base03'
                : 'bg-solarized-violet text-solarized-base03 hover:bg-solarized-cyan'
            }`}
            title="Toggle playlists"
          >
            &#9835;
          </button>
          <div className="flex items-center gap-2">
            <SearchBar
              value={searchQuery}
              onChange={setSearchQuery}
              onRandomBookmark={handleRandomBookmark}
            />
            <button
              onClick={toggleUpload}
              className="px-3 py-1 bg-solarized-green text-solarized-base03 rounded hover:bg-solarized-cyan transition-colors duration-300"
              title="Upload music"
            >
              &#43;
            </button>
            <button
              onClick={toggleQueue}
              className={`px-3 py-1 rounded transition-colors duration-300 ${
                isQueueOpen
                  ? 'bg-solarized-cyan text-solarized-base03'
                  : 'bg-solarized-blue text-solarized-base03 hover:bg-solarized-cyan'
              }`}
              title="Toggle queue"
            >
              &#9776;
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
            <div className="flex items-center justify-center h-64 text-solarized-base01">
              Loading...
            </div>
          ) : (
            <LibraryTable
              items={items}
              searchQuery={searchQuery}
              playlistId={selectedPlaylistId}
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
