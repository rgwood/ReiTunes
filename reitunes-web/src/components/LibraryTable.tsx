import { useMemo, useState, useCallback, useEffect } from 'react';
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  flexRender,
  createColumnHelper,
  type SortingState,
  type ColumnFiltersState,
} from '@tanstack/react-table';
import { useQuery } from '@tanstack/react-query';
import type { LibraryItem, Bookmark } from '../types';
import { usePlayerStore } from '../stores/playerStore';
import { useQueueStore } from '../hooks/useQueue';
import { updateLibraryItem, deleteItem as apiDeleteItem, reloadTags } from '../hooks/useLibrary';
import { FavoriteButton } from './FavoriteButton';
import { useAddToPlaylist } from './PlaylistSidebar';

interface Playlist {
  id: string;
  name: string;
  items: Record<string, { library_item_id: string; position: number }>;
}

const columnHelper = createColumnHelper<LibraryItem>();

interface LibraryTableProps {
  items: LibraryItem[];
  searchQuery: string;
  playlistId?: string | null;
  onSearchChange?: (query: string) => void;
}

interface ParsedSearch {
  artist: string | null;
  album: string | null;
  text: string;
}

/**
 * Parse a search query that may contain field filters like artist:"Beatles" or album:"Abbey Road"
 * Returns the extracted field values and any remaining text
 */
function parseSearchQuery(query: string): ParsedSearch {
  let artist: string | null = null;
  let album: string | null = null;
  const textParts: string[] = [];

  // Regex to match field:"value" or unquoted words
  const regex = /(artist|album):"([^"]+)"|(\S+)/gi;
  let match;

  while ((match = regex.exec(query)) !== null) {
    if (match[1] && match[2]) {
      // Field filter: artist:"value" or album:"value"
      const field = match[1].toLowerCase();
      const value = match[2];
      if (field === 'artist') {
        artist = value;
      } else if (field === 'album') {
        album = value;
      }
    } else if (match[3]) {
      // Regular word
      textParts.push(match[3]);
    }
  }

  return { artist, album, text: textParts.join(' ') };
}

function formatBookmarks(bookmarks: Record<string, Bookmark>): React.ReactNode {
  return Object.entries(bookmarks).map(([id, bookmark]) => {
    const minutes = Math.floor(bookmark.position / 60);
    const seconds = Math.floor(bookmark.position % 60);
    const timeString = `${minutes}:${seconds.toString().padStart(2, '0')}`;
    return (
      <span
        key={id}
        className="bookmark-emoji cursor-pointer hover:underline decoration-solarized-blue decoration-2 rounded"
        data-position={bookmark.position}
        title={timeString}
      >
        {bookmark.emoji || '\u{1F516}'}
      </span>
    );
  });
}

function formatCreatedTime(value: string): string {
  // Parse the UTC time and convert to local time
  // Input format: "2025-01-24T14:30:45.123456789" (UTC)
  const utcDate = new Date(value.split('.')[0] + 'Z'); // Add 'Z' to indicate UTC

  // Format as local time: "Jan 24, 2025 9:30 AM"
  return utcDate.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function LibraryTable({ items, searchQuery, playlistId, onSearchChange }: LibraryTableProps) {
  const [sorting, setSorting] = useState<SortingState>([
    { id: 'created_time_utc', desc: true },
  ]);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [editingCell, setEditingCell] = useState<{ rowId: string; field: string } | null>(null);
  const [editValue, setEditValue] = useState('');

  // Context menu state
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; item: LibraryItem } | null>(null);
  const [showPlaylistSubmenu, setShowPlaylistSubmenu] = useState(false);

  const { play, currentItem } = usePlayerStore();
  const { addToQueue, addNext, setContext } = useQueueStore();

  // Fetch playlists for context menu and filtering
  const { data: playlists = [] } = useQuery<Playlist[]>({
    queryKey: ['playlists'],
    queryFn: async () => {
      const response = await fetch('/api/playlists');
      if (!response.ok) throw new Error('Failed to fetch playlists');
      return response.json();
    },
  });

  const addToPlaylistMutation = useAddToPlaylist();

  // Get the selected playlist (if any)
  const selectedPlaylist = playlistId ? playlists.find(p => p.id === playlistId) : null;

  // Filter items based on playlist and search query
  const filteredItems = useMemo(() => {
    let result = items;

    // Filter by playlist if one is selected
    if (selectedPlaylist) {
      const playlistItemIds = new Set(
        Object.values(selectedPlaylist.items).map(item => item.library_item_id)
      );
      // Sort by position in playlist
      const positionMap = new Map(
        Object.values(selectedPlaylist.items).map(item => [item.library_item_id, item.position])
      );
      result = items
        .filter(item => playlistItemIds.has(item.id))
        .sort((a, b) => (positionMap.get(a.id) ?? 0) - (positionMap.get(b.id) ?? 0));
    }

    // Then filter by search query (supports field filters like artist:"Beatles")
    if (searchQuery) {
      const { artist, album, text } = parseSearchQuery(searchQuery);
      result = result.filter(item => {
        // Field-specific filters (case-insensitive contains match)
        if (artist && !item.artist.toLowerCase().includes(artist.toLowerCase())) {
          return false;
        }
        if (album && !item.album.toLowerCase().includes(album.toLowerCase())) {
          return false;
        }
        // General text search across all fields
        if (text) {
          const query = text.toLowerCase();
          return item.name.toLowerCase().includes(query) ||
                 item.artist.toLowerCase().includes(query) ||
                 item.album.toLowerCase().includes(query);
        }
        return true;
      });
    }

    return result;
  }, [items, searchQuery, selectedPlaylist]);

  const columns = useMemo(() => [
    columnHelper.accessor('is_favorite', {
      header: '\u2665',
      cell: (info) => (
        <FavoriteButton
          itemId={info.row.original.id}
          isFavorite={info.getValue() ?? false}
        />
      ),
      size: 40,
      enableSorting: true,
    }),
    columnHelper.accessor('name', {
      header: 'Name',
      cell: (info) => info.getValue(),
      size: 300,
    }),
    columnHelper.accessor('artist', {
      header: 'Artist',
      cell: (info) => info.getValue(),
      size: 200,
    }),
    columnHelper.accessor('album', {
      header: 'Album',
      cell: (info) => info.getValue(),
      size: 150,
    }),
    columnHelper.accessor('track_number', {
      header: '#',
      cell: (info) => info.getValue() ?? '',
      size: 50,
    }),
    columnHelper.accessor('play_count', {
      header: 'Plays',
      cell: (info) => info.getValue(),
      size: 80,
    }),
    columnHelper.accessor('bookmarks', {
      header: 'Bookmarks',
      cell: (info) => formatBookmarks(info.getValue()),
      size: 150,
      enableSorting: false,
    }),
    columnHelper.accessor('created_time_utc', {
      header: 'Created',
      cell: (info) => formatCreatedTime(info.getValue()),
      size: 180,
    }),
  ], []);

  const table = useReactTable({
    data: filteredItems,
    columns,
    state: {
      sorting,
      columnFilters,
    },
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getRowId: (row) => row.id,
  });

  const handleRowClick = useCallback((item: LibraryItem, rowIndex: number, e: React.MouseEvent) => {
    // Don't play if clicking a bookmark or editing
    const target = e.target as HTMLElement;
    if (target.classList.contains('bookmark-emoji') || editingCell) {
      return;
    }
    // Get all visible items in their current sorted order
    const sortedItems = table.getRowModel().rows.map(row => row.original);
    // Set the context to the library or playlist name
    const contextName = selectedPlaylist ? selectedPlaylist.name : 'Library';
    setContext(sortedItems, rowIndex, contextName);
    play(item);
  }, [play, editingCell, table, setContext, selectedPlaylist]);

  const handleBookmarkClick = useCallback((item: LibraryItem, position: number, e: React.MouseEvent) => {
    e.stopPropagation();
    play(item, position);
  }, [play]);

  const handleCellDoubleClick = useCallback((rowId: string, field: string, currentValue: string) => {
    if (['name', 'artist', 'album'].includes(field)) {
      setEditingCell({ rowId, field });
      setEditValue(currentValue);
    }
  }, []);

  const handleEditBlur = useCallback(async () => {
    if (editingCell) {
      const item = items.find(i => i.id === editingCell.rowId);
      if (item) {
        const originalValue = item[editingCell.field as keyof LibraryItem] as string;
        if (editValue !== originalValue) {
          try {
            await updateLibraryItem(editingCell.rowId, editingCell.field, editValue);
          } catch (err) {
            console.error('Failed to update:', err);
            alert('Failed to update field');
          }
        }
      }
      setEditingCell(null);
    }
  }, [editingCell, editValue, items]);

  const handleEditKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleEditBlur();
    } else if (e.key === 'Escape') {
      setEditingCell(null);
    }
  }, [handleEditBlur]);

  const handleContextMenu = useCallback((e: React.MouseEvent, item: LibraryItem) => {
    e.preventDefault();
    setContextMenu({ x: e.pageX, y: e.pageY, item });
  }, []);

  const handleDelete = useCallback(async () => {
    if (contextMenu) {
      const item = contextMenu.item;
      if (confirm(`Are you sure you want to delete "${item.name}"?`)) {
        try {
          await apiDeleteItem(item.id);
        } catch (err) {
          console.error('Failed to delete:', err);
          alert('Failed to delete item');
        }
      }
      setContextMenu(null);
    }
  }, [contextMenu]);

  const handleAddToQueue = useCallback(() => {
    if (contextMenu) {
      addToQueue(contextMenu.item);
      setContextMenu(null);
    }
  }, [contextMenu, addToQueue]);

  const handlePlayNext = useCallback(() => {
    if (contextMenu) {
      addNext(contextMenu.item);
      setContextMenu(null);
    }
  }, [contextMenu, addNext]);

  const handleReloadTags = useCallback(async () => {
    if (contextMenu) {
      try {
        await reloadTags(contextMenu.item.id);
      } catch (err) {
        console.error('Failed to reload tags:', err);
      }
      setContextMenu(null);
    }
  }, [contextMenu]);

  const handleFilterByArtist = useCallback(() => {
    if (contextMenu && onSearchChange) {
      onSearchChange(`artist:"${contextMenu.item.artist}"`);
      setContextMenu(null);
    }
  }, [contextMenu, onSearchChange]);

  const handleFilterByAlbum = useCallback(() => {
    if (contextMenu && onSearchChange) {
      onSearchChange(`album:"${contextMenu.item.album}"`);
      setContextMenu(null);
    }
  }, [contextMenu, onSearchChange]);

  // Close context menu on click outside
  useEffect(() => {
    const handleClick = () => {
      setContextMenu(null);
      setShowPlaylistSubmenu(false);
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setContextMenu(null);
        setShowPlaylistSubmenu(false);
      }
    };

    document.addEventListener('click', handleClick);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('click', handleClick);
      document.removeEventListener('keydown', handleEscape);
    };
  }, []);

  return (
    <div className="px-5 h-full flex flex-col">
      <div className="overflow-auto flex-grow">
        <table className="w-full border-collapse">
          <thead className="sticky top-0 bg-solarized-base02">
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <th
                    key={header.id}
                    className="text-left px-2 py-1 border-b border-solarized-base01 cursor-pointer hover:bg-solarized-base01"
                    style={{ width: header.getSize() }}
                    onClick={header.column.getToggleSortingHandler()}
                  >
                    <div className="flex items-center gap-1">
                      {flexRender(header.column.columnDef.header, header.getContext())}
                      {{
                        asc: ' \u25B2',
                        desc: ' \u25BC',
                      }[header.column.getIsSorted() as string] ?? null}
                    </div>
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row, rowIndex) => {
              const isCurrentlyPlaying = currentItem?.id === row.original.id;
              return (
                <tr
                  key={row.id}
                  className={`hover:bg-solarized-base02 cursor-pointer ${isCurrentlyPlaying ? 'bg-solarized-base02' : ''}`}
                  onClick={(e) => handleRowClick(row.original, rowIndex, e)}
                  onContextMenu={(e) => handleContextMenu(e, row.original)}
                >
                  {row.getVisibleCells().map((cell) => {
                    const field = cell.column.id;
                    const isEditing = editingCell?.rowId === row.id && editingCell?.field === field;
                    const isEditable = ['name', 'artist', 'album'].includes(field);

                    return (
                      <td
                        key={cell.id}
                        className="px-2 py-1 border-b border-solarized-base02"
                        onDoubleClick={() => {
                          if (isEditable) {
                            handleCellDoubleClick(row.id, field, cell.getValue() as string);
                          }
                        }}
                        onClick={(e) => {
                          // Handle bookmark clicks
                          const target = e.target as HTMLElement;
                          if (target.classList.contains('bookmark-emoji')) {
                            const position = parseFloat(target.getAttribute('data-position') || '0');
                            handleBookmarkClick(row.original, position, e);
                          }
                        }}
                      >
                        {isEditing ? (
                          <input
                            type="text"
                            value={editValue}
                            onChange={(e) => setEditValue(e.target.value)}
                            onBlur={handleEditBlur}
                            onKeyDown={handleEditKeyDown}
                            className="w-full bg-solarized-base03 text-solarized-base1 border border-solarized-blue px-1"
                            autoFocus
                          />
                        ) : (
                          flexRender(cell.column.columnDef.cell, cell.getContext())
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Context Menu */}
      {contextMenu && (
        <div
          className="fixed z-50 bg-solarized-base02 border border-solarized-blue rounded shadow-lg py-1 min-w-32"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <div
            className="px-3 py-2 text-solarized-base1 hover:bg-solarized-blue hover:bg-opacity-30 cursor-pointer"
            onClick={handlePlayNext}
          >
            &#9654; Play Next
          </div>
          <div
            className="px-3 py-2 text-solarized-base1 hover:bg-solarized-blue hover:bg-opacity-30 cursor-pointer"
            onClick={handleAddToQueue}
          >
            &#43; Add to Queue
          </div>
          <div className="border-t border-solarized-base01 my-1" />
          {onSearchChange && (
            <>
              <div
                className="px-3 py-2 text-solarized-base1 hover:bg-solarized-blue hover:bg-opacity-30 cursor-pointer"
                onClick={handleFilterByArtist}
              >
                &#128269; Filter by Artist
              </div>
              <div
                className="px-3 py-2 text-solarized-base1 hover:bg-solarized-blue hover:bg-opacity-30 cursor-pointer"
                onClick={handleFilterByAlbum}
              >
                &#128269; Filter by Album
              </div>
              <div className="border-t border-solarized-base01 my-1" />
            </>
          )}
          <div
            className="relative"
            onMouseEnter={() => setShowPlaylistSubmenu(true)}
            onMouseLeave={() => setShowPlaylistSubmenu(false)}
          >
            <div className="px-3 py-2 text-solarized-base1 hover:bg-solarized-blue hover:bg-opacity-30 cursor-pointer flex justify-between items-center">
              <span>&#9835; Add to Playlist</span>
              <span>&#9656;</span>
            </div>
            {showPlaylistSubmenu && (
              <div className="absolute left-full top-0 bg-solarized-base02 border border-solarized-blue rounded shadow-lg py-1 min-w-32">
                {playlists.length === 0 ? (
                  <div className="px-3 py-2 text-solarized-base01 italic">No playlists</div>
                ) : (
                  playlists.map((playlist) => (
                    <div
                      key={playlist.id}
                      className="px-3 py-2 text-solarized-base1 hover:bg-solarized-blue hover:bg-opacity-30 cursor-pointer"
                      onClick={() => {
                        addToPlaylistMutation.mutate({
                          playlistId: playlist.id,
                          libraryItemId: contextMenu.item.id,
                        });
                        setContextMenu(null);
                        setShowPlaylistSubmenu(false);
                      }}
                    >
                      {playlist.name}
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
          <div
            className="px-3 py-2 text-solarized-base1 hover:bg-solarized-blue hover:bg-opacity-30 cursor-pointer"
            onClick={handleReloadTags}
          >
            &#128260; Reload ID3 Tags
          </div>
          <div
            className="px-3 py-2 text-solarized-base1 hover:bg-solarized-red hover:text-solarized-base3 cursor-pointer"
            onClick={handleDelete}
          >
            &#128465; Delete
          </div>
        </div>
      )}
    </div>
  );
}
