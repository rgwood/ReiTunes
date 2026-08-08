import { useState, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

interface Playlist {
  id: string;
  name: string;
  created_time_utc: string;
  items: Record<string, { library_item_id: string; position: number }>;
}

async function fetchPlaylists(): Promise<Playlist[]> {
  const response = await fetch('/api/playlists');
  if (!response.ok) throw new Error('Failed to fetch playlists');
  return response.json();
}

async function createPlaylist(name: string): Promise<Playlist> {
  const response = await fetch('/api/playlists', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!response.ok) throw new Error('Failed to create playlist');
  return response.json();
}

async function deletePlaylist(id: string): Promise<void> {
  const response = await fetch(`/api/playlists/${id}`, { method: 'DELETE' });
  if (!response.ok) throw new Error('Failed to delete playlist');
}

async function addToPlaylist(playlistId: string, libraryItemId: string): Promise<void> {
  const response = await fetch(`/api/playlists/${playlistId}/items`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ library_item_id: libraryItemId }),
  });
  if (!response.ok) throw new Error('Failed to add to playlist');
}

interface PlaylistSidebarProps {
  selectedPlaylistId: string | null;
  onSelectPlaylist: (id: string | null) => void;
}

export function PlaylistSidebar({ selectedPlaylistId, onSelectPlaylist }: PlaylistSidebarProps) {
  const [newPlaylistName, setNewPlaylistName] = useState('');
  const [isCreating, setIsCreating] = useState(false);

  const queryClient = useQueryClient();

  const { data: playlists = [], isLoading } = useQuery({
    queryKey: ['playlists'],
    queryFn: fetchPlaylists,
  });

  const createMutation = useMutation({
    mutationFn: createPlaylist,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['playlists'] });
      setNewPlaylistName('');
      setIsCreating(false);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: deletePlaylist,
    onSuccess: (_, deletedId) => {
      queryClient.invalidateQueries({ queryKey: ['playlists'] });
      // If we deleted the selected playlist, go back to library
      if (selectedPlaylistId === deletedId) {
        onSelectPlaylist(null);
      }
    },
  });

  const handleCreatePlaylist = useCallback(() => {
    if (newPlaylistName.trim()) {
      createMutation.mutate(newPlaylistName.trim());
    }
  }, [newPlaylistName, createMutation]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        handleCreatePlaylist();
      } else if (e.key === 'Escape') {
        setIsCreating(false);
        setNewPlaylistName('');
      }
    },
    [handleCreatePlaylist]
  );

  // Count items in each playlist
  const getPlaylistItemCount = (playlist: Playlist) => {
    return Object.keys(playlist.items).length;
  };

  return (
    <div className="w-48 flex-shrink-0 bg-solarized-base03 border-r border-solarized-base02 flex flex-col h-full">
      {/* Header */}
      <div className="p-3 border-b border-solarized-base02">
        <h2 className="text-sm font-semibold text-solarized-base1 uppercase tracking-wide">Playlists</h2>
      </div>

      {/* Navigation list */}
      <div className="flex-grow overflow-y-auto">
        {/* Library option - always first */}
        <div
          className={`px-3 py-2 cursor-pointer flex items-center gap-2 ${
            selectedPlaylistId === null
              ? 'bg-solarized-base02 text-solarized-blue'
              : 'text-solarized-base1 hover:bg-solarized-base02'
          }`}
          onClick={() => onSelectPlaylist(null)}
        >
          <span>&#9835;</span>
          <span>Library</span>
        </div>

        {/* Divider */}
        <div className="border-b border-solarized-base02 my-1" />

        {/* Playlists */}
        {isLoading ? (
          <div className="px-3 py-2 text-solarized-base0 text-sm">Loading...</div>
        ) : playlists.length === 0 ? (
          <div className="px-3 py-2 text-solarized-base0 text-sm italic">No playlists</div>
        ) : (
          playlists.map((playlist) => (
            <div
              key={playlist.id}
              className={`group px-3 py-2 cursor-pointer flex items-center justify-between ${
                selectedPlaylistId === playlist.id
                  ? 'bg-solarized-base02 text-solarized-blue'
                  : 'text-solarized-base1 hover:bg-solarized-base02'
              }`}
              onClick={() => onSelectPlaylist(playlist.id)}
            >
              <div className="flex-grow min-w-0">
                <div className="truncate text-sm">{playlist.name}</div>
                <div className="text-xs text-solarized-base0">
                  {getPlaylistItemCount(playlist)} songs
                </div>
              </div>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  if (confirm(`Delete "${playlist.name}"?`)) {
                    deleteMutation.mutate(playlist.id);
                  }
                }}
                className="opacity-0 group-hover:opacity-100 text-solarized-base01 hover:text-solarized-red px-1 text-sm"
                title="Delete playlist"
              >
                &#10005;
              </button>
            </div>
          ))
        )}
      </div>

      {/* Create new playlist */}
      <div className="p-3 border-t border-solarized-base02">
        {isCreating ? (
          <div className="flex gap-1">
            <input
              type="text"
              value={newPlaylistName}
              onChange={(e) => setNewPlaylistName(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Name..."
              className="flex-grow px-2 py-1 bg-solarized-base03 text-solarized-base1 border border-solarized-blue text-sm min-w-0"
              autoFocus
            />
            <button
              onClick={handleCreatePlaylist}
              className="px-2 py-1 bg-solarized-blue text-solarized-base03 rounded text-sm hover:bg-solarized-cyan flex-shrink-0"
            >
              &#10003;
            </button>
          </div>
        ) : (
          <button
            onClick={() => setIsCreating(true)}
            className="w-full px-2 py-1 bg-solarized-blue text-solarized-base03 rounded text-sm hover:bg-solarized-cyan transition-colors"
          >
            + New
          </button>
        )}
      </div>
    </div>
  );
}

// Export a hook for adding items to playlists from the context menu
export function useAddToPlaylist() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ playlistId, libraryItemId }: { playlistId: string; libraryItemId: string }) =>
      addToPlaylist(playlistId, libraryItemId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['playlists'] });
    },
  });
}
