import { Fragment, memo, useMemo, useState, useCallback, useEffect, useRef } from 'react';
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  flexRender,
  createColumnHelper,
  type Cell,
  type Row,
  type SortingState,
  type ColumnFiltersState,
} from '@tanstack/react-table';
import { useQuery } from '@tanstack/react-query';
import type { LibraryItem, Bookmark } from '../types';
import { usePlayerStore } from '../stores/playerStore';
import { useQueueStore } from '../hooks/useQueue';
import { usePlayback } from '../hooks/usePlayback';
import { updateLibraryItem, deleteItem as apiDeleteItem } from '../hooks/useLibrary';
import { FavoriteButton } from './FavoriteButton';
import { Tooltip } from './Tooltip';
import { useLibraryViewport, LIBRARY_HEADER_HEIGHT } from '../hooks/useLibraryViewport';
import { useAddToPlaylist } from '../hooks/useAddToPlaylist';
import { effectiveTags, tagProgress, type ItemTags } from '../hooks/useTags';

interface Playlist {
  id: string;
  name: string;
  items: Record<string, { library_item_id: string; position: number }>;
}

const columnHelper = createColumnHelper<LibraryItem>();

interface LibraryTableProps {
  items: LibraryItem[];
  searchQuery: string;
  filterKey?: string;
  playlistId?: string | null;
  onSearchChange?: (query: string) => void;
  revealRequest?: { itemId: string } | null;
  onRevealed?: () => void;
  onManageBookmarks?: (item: LibraryItem) => void;
  onManageTags?: (item: LibraryItem) => void;
  onFilterTag?: (tag: string) => void;
  tagItems?: Record<string, ItemTags>;
  includeSuggestedTags?: boolean;
  selectedTagItemId?: string | null;
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

  // Regex to match field:"value" (with escaped quotes) or unquoted words
  const regex = /(artist|album):"((?:[^"\\]|\\.)*)"|(\S+)/gi;
  let match;

  while ((match = regex.exec(query)) !== null) {
    if (match[1] && match[2] !== undefined) {
      // Field filter: artist:"value" or album:"value"
      const field = match[1].toLowerCase();
      const value = match[2].replace(/\\"/g, '"');
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
      <button
        type="button"
        key={id}
        className="bookmark-emoji cursor-pointer hover:underline decoration-solarized-blue decoration-2 rounded"
        data-position={bookmark.position}
        title={bookmark.label ? `${bookmark.label} · ${timeString}` : timeString}
      >
        {bookmark.emoji || '\u{1F516}'}
      </button>
    );
  });
}

const shortDateFormatter = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const fullDateFormatter = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });

function formatCreatedTime(value: string, short = false): string {
  const date = new Date(/Z|[+-]\d\d:\d\d$/.test(value) ? value : `${value}Z`);
  return Number.isNaN(date.getTime()) ? value : (short ? shortDateFormatter : fullDateFormatter).format(date);
}

interface TagTableMeta {
  tagItems?: Record<string, ItemTags>;
  includeSuggestedTags?: boolean;
  selectedTagItemId?: string | null;
  onManageTags?: (item: LibraryItem) => void;
  onFilterTag?: (tag: string) => void;
}

// Tag state changes through table metadata; column renderer identities never change.
// Changing a renderer makes React unmount its cells, including every tooltip.
const columns = [
    columnHelper.accessor('is_favorite', {
      header: '\u2665',
      cell: (info) => (
        <FavoriteButton
          itemId={info.row.original.id}
          isFavorite={info.getValue() ?? false}
        />
      ),
      size: 28,
      minSize: 28,
      maxSize: 28,
      enableResizing: false,
      enableSorting: true,
    }),
    columnHelper.accessor('name', {
      header: 'Name',
      cell: (info) => <Tooltip content={info.getValue()}>{info.getValue()}</Tooltip>,
      size: 220,
    }),
    columnHelper.accessor('artist', {
      header: 'Artist',
      cell: (info) => <Tooltip content={info.getValue()}>{info.getValue()}</Tooltip>,
      size: 140,
    }),
    columnHelper.accessor('album', {
      header: 'Album',
      cell: (info) => <Tooltip content={info.getValue()}>{info.getValue()}</Tooltip>,
      size: 140,
    }),
    columnHelper.accessor('track_number', {
      header: '#',
      cell: (info) => info.getValue() ?? '',
      size: 40,
    }),
    columnHelper.accessor('play_count', {
      header: 'Plays',
      cell: (info) => info.getValue(),
      size: 50,
    }),
    columnHelper.display({
      id: 'tags', header: 'Tags', size: 230,
      cell: ({ row, table }) => {
        const { tagItems, includeSuggestedTags, selectedTagItemId, onManageTags, onFilterTag } = table.options.meta as TagTableMeta;
        const data = tagItems?.[row.original.id];
        const itemTags = effectiveTags(data, includeSuggestedTags);
        return <div className="row-tags">
          <span className="row-tag-links">{itemTags.slice(0, 2).map(tag => <button key={tag} className="row-tag-link" title={`Browse all music tagged ${tag}`} aria-label={`Browse music tagged ${tag}`} onClick={event => { event.stopPropagation(); onFilterTag?.(tag); }}>{tag}</button>)}
          {!itemTags.length && <span className="row-tags-empty" title={tagProgress(data)}>{data?.status === 'running' ? 'Generating…' : data?.status === 'queued' ? 'Waiting…' : data?.status === 'failed' ? 'Failed' : '—'}</span>}</span>
          <button type="button" className={`row-tag-edit${itemTags.length > 2 ? ' has-more' : ''}`} aria-label={`Edit tags for ${row.original.name}`} aria-pressed={selectedTagItemId === row.original.id} title={itemTags.length > 2 ? `${itemTags.join(', ')} — manage tags` : 'Add or remove tags'} onClick={event => { event.stopPropagation(); onManageTags?.(row.original); }}>{itemTags.length > 2 ? `+${itemTags.length - 2}` : '…'}</button>
        </div>;
      },
    }),
    columnHelper.accessor('bookmarks', {
      header: 'Bookmarks',
      cell: (info) => formatBookmarks(info.getValue()),
      size: 100,
      enableSorting: false,
    }),
    columnHelper.accessor('created_time_utc', {
      header: 'Created',
      cell: (info) => {
        const full = formatCreatedTime(info.getValue());
        const short = formatCreatedTime(info.getValue(), true);
        return <Tooltip content={full} force>{short}</Tooltip>;
      },
      size: 130,
    }),
];

interface RenderedCellProps {
  cell: Cell<LibraryItem, unknown>;
  tagData?: ItemTags;
  tagSelected?: boolean;
  includeSuggestedTags?: boolean;
  onManageTags?: (item: LibraryItem) => void;
  onFilterTag?: (tag: string) => void;
}

// Explicit tag dependencies are needed because TanStack's table/meta are mutable.
// An unchanged cell can skip rendering even when another row's tag state changes.
const RenderedCell = memo(function RenderedCell({ cell }: RenderedCellProps) {
  return flexRender(cell.column.columnDef.cell, cell.getContext());
});

interface LibraryRowProps {
  row: Row<LibraryItem>;
  rowIndex: number;
  isCurrentlyPlaying: boolean;
  tagSelected: boolean;
  tagData?: ItemTags;
  includeSuggestedTags?: boolean;
  onManageTags?: (item: LibraryItem) => void;
  onFilterTag?: (tag: string) => void;
  editingField: string | null;
  editValue: string;
  setEditValue: (value: string) => void;
  handleRowClick: (item: LibraryItem, rowIndex: number, event: React.MouseEvent | React.KeyboardEvent) => void;
  handleContextMenu: (event: React.MouseEvent, item: LibraryItem) => void;
  handleCellDoubleClick: (rowId: string, field: string, value: string) => void;
  handleBookmarkClick: (item: LibraryItem, position: number, event: React.MouseEvent) => void;
  handleEditBlur: () => void;
  handleEditKeyDown: (event: React.KeyboardEvent) => void;
}

const LibraryRow = memo(function LibraryRow({ row, rowIndex, isCurrentlyPlaying, tagSelected, tagData,
  includeSuggestedTags, onManageTags, onFilterTag, editingField, editValue, setEditValue, handleRowClick,
  handleContextMenu, handleCellDoubleClick, handleBookmarkClick, handleEditBlur, handleEditKeyDown }: LibraryRowProps) {
  return (
  <tr
    key={row.id}
    data-item-id={row.id}
    aria-rowindex={rowIndex + 2}
    data-stripe={rowIndex % 2 === 1 || undefined}
    aria-current={isCurrentlyPlaying ? 'true' : undefined}
    data-tag-selected={tagSelected || undefined}
    tabIndex={0}
    onKeyDown={(event) => {
      if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) {
        event.preventDefault();
        handleRowClick(row.original, rowIndex, event);
      }
    }}
    className={`hover:bg-solarized-base02 cursor-pointer ${isCurrentlyPlaying ? 'bg-solarized-base02' : ''}`}
    onClick={(e) => handleRowClick(row.original, rowIndex, e)}
    onContextMenu={(e) => handleContextMenu(e, row.original)}
  >
    {row.getVisibleCells().map((cell) => {
      const field = cell.column.id;
      const isEditing = editingField === field;
      const isEditable = ['name', 'artist', 'album'].includes(field);

      return (
        <td
          key={cell.id}
          data-column={field}
          className="px-2 py-1 border-b border-solarized-base02 whitespace-nowrap overflow-hidden text-ellipsis max-w-0"
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
            <RenderedCell cell={cell}
              tagData={field === 'tags' ? tagData : undefined}
              tagSelected={field === 'tags' ? tagSelected : undefined}
              includeSuggestedTags={field === 'tags' ? includeSuggestedTags : undefined}
              onManageTags={field === 'tags' ? onManageTags : undefined}
              onFilterTag={field === 'tags' ? onFilterTag : undefined} />
          )}
        </td>
      );
    })}
  </tr>
  );
});

export const LibraryTable = memo(function LibraryTable({ items, searchQuery, filterKey = searchQuery, playlistId, onSearchChange, revealRequest, onRevealed, onManageBookmarks, onManageTags, onFilterTag, tagItems, includeSuggestedTags, selectedTagItemId }: LibraryTableProps) {
  // TanStack Table v8 exposes mutable state through stable methods. Remove this
  // opt-out when useReactTable supports React Compiler memoization.
  'use no memo';

  const scrollRef = useRef<HTMLDivElement>(null);
  const [sorting, setSorting] = useState<SortingState>(playlistId ? [] : [
    { id: 'created_time_utc', desc: true },
  ]);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [editingCell, setEditingCell] = useState<{ rowId: string; field: string } | null>(null);
  const [editValue, setEditValue] = useState('');

  // Context menu state
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; item: LibraryItem } | null>(null);
  const [showPlaylistSubmenu, setShowPlaylistSubmenu] = useState(false);

  const currentItemId = usePlayerStore(state => state.currentItemId);
  const play = usePlayback();
  const addToQueue = useQueueStore(state => state.addToQueue);
  const addNext = useQueueStore(state => state.addNext);
  const setContext = useQueueStore(state => state.setContext);

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



  // eslint-disable-next-line react-hooks/incompatible-library -- LibraryTable opts out of compiler memoization above.
  const table = useReactTable({
    data: filteredItems,
    columns,
    meta: { tagItems, includeSuggestedTags, selectedTagItemId, onManageTags, onFilterTag } satisfies TagTableMeta,
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
    columnResizeMode: 'onChange',
  });

  const rows = table.getRowModel().rows;
  const viewport = useLibraryViewport({ rows, scrollRef, filterKey, sorting,
    editingId: editingCell?.rowId, revealRequest, onRevealed });

  const bottomGap = viewport.virtualRows.length ? Math.max(0, viewport.totalHeight - (viewport.virtualRows[viewport.virtualRows.length - 1].end - LIBRARY_HEADER_HEIGHT)) : 0;

  const handleRowClick = useCallback((item: LibraryItem, rowIndex: number, e: React.MouseEvent | React.KeyboardEvent) => {
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
    void play(item);
  }, [play, editingCell, table, setContext, selectedPlaylist]);

  const handleBookmarkClick = useCallback((item: LibraryItem, position: number, e: React.MouseEvent) => {
    e.stopPropagation();
    void play(item, position);
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

  const handleFilterByArtist = useCallback(() => {
    if (contextMenu && onSearchChange) {
      const escaped = contextMenu.item.artist.replace(/"/g, '\\"');
      onSearchChange(`artist:"${escaped}"`);
      setContextMenu(null);
    }
  }, [contextMenu, onSearchChange]);

  const handleFilterByAlbum = useCallback(() => {
    if (contextMenu && onSearchChange) {
      const escaped = contextMenu.item.album.replace(/"/g, '\\"');
      onSearchChange(`album:"${escaped}"`);
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
      <div ref={scrollRef} className="overflow-auto flex-grow" onKeyDown={viewport.onKeyDown} onFocusCapture={viewport.onFocusCapture} onBlurCapture={viewport.onBlurCapture}>
        <table aria-label="Tracks" aria-rowcount={table.getRowModel().rows.length + 1} className={`w-full border-collapse table-fixed ${table.getState().columnSizingInfo.isResizingColumn ? 'select-none' : ''}`}>
          <colgroup>
            {table.getVisibleLeafColumns().map(column => (
              <col key={column.id} style={{
                // Pixel widths on every column get stretched by table layout.
                // Reserve the heart's space and share the rest among text columns.
                width: column.id === 'is_favorite'
                  ? 28
                  : `${100 * column.getSize() / (table.getTotalSize() - 28)}%`,
              }} />
            ))}
          </colgroup>
          <thead className="sticky top-0 bg-solarized-base02">
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id} aria-rowindex={1}>
                {headerGroup.headers.map((header) => (
                  <th
                    key={header.id}
                    className="relative text-left px-2 py-1 border-b border-solarized-base01 cursor-pointer hover:bg-solarized-base01 whitespace-nowrap overflow-hidden text-ellipsis"
                  >
                    <button
                      type="button"
                      className="flex items-center gap-1"
                      onClick={header.column.getToggleSortingHandler()}
                    >
                      {flexRender(header.column.columnDef.header, header.getContext())}
                      {{
                        asc: ' \u25B2',
                        desc: ' \u25BC',
                      }[header.column.getIsSorted() as string] ?? null}
                    </button>
                    {header.column.getCanResize() && <div
                      onMouseDown={header.getResizeHandler()}
                      onTouchStart={header.getResizeHandler()}
                      onClick={(e) => e.stopPropagation()}
                      className={`absolute right-0 top-0 h-full w-1 cursor-col-resize hover:bg-solarized-blue ${
                        header.column.getIsResizing() ? 'bg-solarized-blue' : ''
                      }`}
                    />}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {viewport.virtualRows.map((virtualRow, virtualIndex) => {
              const rowIndex = virtualRow.index;
              const row = rows[rowIndex];
              const previousEnd = virtualIndex ? viewport.virtualRows[virtualIndex - 1].end : LIBRARY_HEADER_HEIGHT;
              const gap = virtualRow.start - previousEnd;
              return <Fragment key={row.id}>
              {gap > 0 && <tr aria-hidden="true" role="presentation" className="virtual-spacer"><td colSpan={columns.length} style={{ height: gap }} /></tr>}
              <LibraryRow
              row={row} rowIndex={rowIndex}
              isCurrentlyPlaying={currentItemId === row.original.id}
              tagSelected={selectedTagItemId === row.id} tagData={tagItems?.[row.id]}
              includeSuggestedTags={includeSuggestedTags} onManageTags={onManageTags} onFilterTag={onFilterTag}
              editingField={editingCell?.rowId === row.id ? editingCell.field : null}
              editValue={editingCell?.rowId === row.id ? editValue : ''} setEditValue={setEditValue}
              handleRowClick={handleRowClick} handleContextMenu={handleContextMenu}
              handleCellDoubleClick={handleCellDoubleClick} handleBookmarkClick={handleBookmarkClick}
              handleEditBlur={handleEditBlur} handleEditKeyDown={handleEditKeyDown} />
              </Fragment>;
            })}
            {bottomGap > 0 && <tr aria-hidden="true" role="presentation" className="virtual-spacer"><td colSpan={columns.length} style={{ height: bottomGap }} /></tr>}
          </tbody>
        </table>
      </div>

      {/* Context Menu */}
      {contextMenu && (
        <div
          className="library-context-menu fixed z-50 bg-solarized-base02 border border-solarized-blue rounded shadow-lg py-1 min-w-32"
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
          {onManageTags && <button type="button" className="w-full text-left px-3 py-2 text-solarized-base1 hover:bg-solarized-blue" onClick={() => { onManageTags(contextMenu.item); setContextMenu(null); }}>Manage tags</button>}
          {onManageBookmarks && Object.keys(contextMenu.item.bookmarks).length > 0 && (
            <button type="button" className="w-full text-left px-3 py-2 text-solarized-base1 hover:bg-solarized-blue"
              onClick={() => {
                onManageBookmarks(contextMenu.item);
                setContextMenu(null);
              }}>
              Manage bookmarks
            </button>
          )}
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
                  <div className="px-3 py-2 text-solarized-base0 italic">No playlists</div>
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
            className="px-3 py-2 text-solarized-base1 hover:bg-solarized-red hover:text-solarized-base3 cursor-pointer"
            onClick={handleDelete}
          >
            &#128465; Delete
          </div>
        </div>
      )}
    </div>
  );
});
