import { useMemo, useState, useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  flexRender,
  createColumnHelper,
  type SortingState,
  type ColumnFiltersState,
  type ColumnSizingState,
} from '@tanstack/react-table';
import type { LibraryItem, Bookmark } from '../types';
import { usePlayerStore } from '../stores/playerStore';
import { useQueueStore } from '../hooks/useQueue';
import { usePlayback } from '../hooks/usePlayback';
import { useMetadataSuggestions, useUpdateLibraryItem, deleteItem as apiDeleteItem } from '../hooks/useLibrary';
import { FavoriteButton } from './FavoriteButton';
import { Tooltip } from './Tooltip';
import { usePlaylists, usePlaylistMutation } from '../hooks/usePlaylists';
import { draggedTrackIds, moveTracksBefore, TRACK_DRAG_TYPE } from '../utils/playlists';
import { SongInfoDialog } from './SongInfoDialog';
import { MetadataInput } from './MetadataInput';
import { useLibraryPreferences } from '../stores/libraryPreferences';

const editableFields = ['name', 'artist', 'album'] as const;
type EditableField = typeof editableFields[number];
function editableField(target: HTMLElement): EditableField {
  const field = target.closest('td')?.getAttribute('data-column');
  return editableFields.find(value => value === field) ?? 'name';
}

const columnHelper = createColumnHelper<LibraryItem>();
const savedViews = new Map<string, { sorting: SortingState; columnSizing: ColumnSizingState; scrollTop: number }>();

interface LibraryTableProps {
  items: LibraryItem[];
  searchQuery: string;
  playlistId?: string | null;
  onSearchChange?: (query: string) => void;
  revealRequest?: { itemId: string } | null;
  onRevealed?: () => void;
  onManageBookmarks?: (item: LibraryItem) => void;
  contextName?: string;
  allowReordering?: boolean;
  onNewPlaylist?: (itemIds: string[]) => void;
  viewId?: string;
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

function formatCreatedTime(value: string, short = false): string {
  // Parse the UTC time and convert to local time
  // Input format: "2025-01-24T14:30:45.123456789" (UTC)
  const utcDate = new Date(value.split('.')[0] + 'Z'); // Add 'Z' to indicate UTC

  if (short) {
    return utcDate.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  }

  return utcDate.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function LibraryTable({ items, searchQuery, playlistId, onSearchChange, revealRequest, onRevealed, onManageBookmarks, contextName: sourceName, allowReordering, onNewPlaylist, viewId = 'all' }: LibraryTableProps) {
  // TanStack Table v8 exposes mutable state through stable methods. Remove this
  // opt-out when useReactTable supports React Compiler memoization.
  'use no memo';
  const showDetails = useLibraryPreferences(state => state.showDetails);

  const scrollRef = useRef<HTMLDivElement>(null);
  const revealRowRef = useRef<HTMLTableRowElement>(null);
  useLayoutEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = savedViews.get(viewId)?.scrollTop ?? 0;
  }, [viewId]);
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    const row = revealRowRef.current;
    if (!revealRequest || !scroller || !row) return;
    // Wait for deferred search to expose the row, then reveal it just once.
    // Measuring the sticky header also keeps upward jumps out from under it.
    const bounds = scroller.getBoundingClientRect();
    const headerHeight = scroller.querySelector('thead')?.getBoundingClientRect().height ?? 0;
    const rowBounds = row.getBoundingClientRect();
    const visibleTop = bounds.top + headerHeight;
    if (rowBounds.top < visibleTop || rowBounds.bottom > bounds.bottom) {
      scroller.scrollTop += rowBounds.top - visibleTop -
        (scroller.clientHeight - headerHeight - rowBounds.height) / 2;
    }
    onRevealed?.();
  }, [revealRequest, items, onRevealed]);
  const [sorting, setSorting] = useState<SortingState>(savedViews.get(viewId)?.sorting ?? (playlistId ? [] : [
    { id: 'created_time_utc', desc: true },
  ]));
  const [columnSizing, setColumnSizing] = useState<ColumnSizingState>(savedViews.get(viewId)?.columnSizing ?? {});
  useEffect(() => {
    savedViews.set(viewId, { sorting, columnSizing, scrollTop: scrollRef.current?.scrollTop ?? 0 });
  }, [viewId, sorting, columnSizing]);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [selection, setSelection] = useState<{ rowId: string; field: EditableField } | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const anchor = useRef<string | null>(null);
  const [playlistError, setPlaylistError] = useState('');
  const [dropRow, setDropRow] = useState<{ id: string; after: boolean } | null>(null);
  const [editingCell, setEditingCell] = useState<{ rowId: string; field: EditableField } | null>(null);
  const [editValue, setEditValue] = useState('');
  const [editError, setEditError] = useState<string | null>(null);
  const [editPending, setEditPending] = useState(false);
  const editSaving = useRef(false);
  const editFinished = useRef(false);
  const editInputRef = useRef<HTMLInputElement>(null);
  const [infoItem, setInfoItem] = useState<LibraryItem | null>(null);
  const returnFocusRef = useRef<HTMLTableRowElement | null>(null);
  const updateItem = useUpdateLibraryItem();
  const suggestions = useMetadataSuggestions();
  const editClickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clickWasSelected = useRef(false);
  const cancelClickEdit = useCallback(() => {
    if (editClickTimer.current !== null) clearTimeout(editClickTimer.current);
    editClickTimer.current = null;
  }, []);
  useEffect(() => cancelClickEdit, [cancelClickEdit]);

  // Context menu state
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; item: LibraryItem } | null>(null);
  const [showPlaylistSubmenu, setShowPlaylistSubmenu] = useState(false);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const menu = contextMenuRef.current;
    if (!contextMenu || !menu) return;
    const bounds = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(4, Math.min(contextMenu.x, innerWidth - bounds.width - 4))}px`;
    menu.style.top = `${Math.max(4, Math.min(contextMenu.y, innerHeight - bounds.height - 4))}px`;
    if (!menu.contains(document.activeElement)) menu.querySelector('button')?.focus();
  }, [contextMenu, showPlaylistSubmenu]);
  useEffect(() => {
    if (editingCell && !editPending) editInputRef.current?.focus();
  }, [editingCell, editPending]);

  const { currentItem } = usePlayerStore();
  const play = usePlayback();
  const { addToQueue, addNext, setContext } = useQueueStore();

  // Fetch playlists for context menu and filtering
  const { data: playlists = [] } = usePlaylists();
  const playlistMutation = usePlaylistMutation();
  async function changePlaylist(path: string, method: string, body?: unknown) {
    setPlaylistError('');
    try { await playlistMutation.mutateAsync({ path, method, body }); }
    catch { setPlaylistError('Could not update the playlist. Please try again.'); }
  }

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
  ], []);

  const table = useReactTable({
    data: filteredItems,
    columns,
    state: {
      sorting,
      columnFilters,
      columnSizing,
      columnVisibility: { track_number: showDetails, created_time_utc: showDetails },
      columnOrder: ['is_favorite', 'name', 'artist', 'album', 'bookmarks', 'play_count', 'track_number', 'created_time_utc'],
    },
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onColumnSizingChange: setColumnSizing,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getRowId: (row) => row.id,
    columnResizeMode: 'onChange',
  });

  const handleRowPlay = useCallback((item: LibraryItem, rowIndex: number, e: React.MouseEvent | React.KeyboardEvent) => {
    // Don't play if clicking a bookmark or editing
    const target = e.target as HTMLElement;
    if (target.closest('button, input') || editingCell) {
      return;
    }
    // Get all visible items in their current sorted order
    const sortedItems = table.getRowModel().rows.map(row => row.original);
    // Set the context to the library or playlist name
    const contextName = sourceName || selectedPlaylist?.name || 'Library';
    setContext(sortedItems, rowIndex, contextName);
    void play(item);
  }, [play, editingCell, table, setContext, selectedPlaylist, sourceName]);

  const handleBookmarkClick = useCallback((item: LibraryItem, position: number, e: React.MouseEvent) => {
    e.stopPropagation();
    void play(item, position);
  }, [play]);

  const beginCellEdit = useCallback((item: LibraryItem, field: EditableField) => {
    cancelClickEdit();
    setSelectedIds(new Set([item.id]));
    editFinished.current = false;
    setEditingCell({ rowId: item.id, field });
    setEditValue(item[field]);
    setEditError(null);
  }, [cancelClickEdit]);

  const closeCellEdit = (restoreFocus = true) => {
    editFinished.current = true;
    setEditingCell(null);
    setEditError(null);
    if (restoreFocus) returnFocusRef.current?.focus();
  };

  const saveCellEdit = async (restoreFocus = true) => {
    if (!editingCell || editSaving.current || editFinished.current) return false;
    if (editingCell.field === 'name' && !editValue.trim()) {
      setEditError('Enter a song name.');
      editInputRef.current?.focus();
      return false;
    }
    editSaving.current = true;
    setEditPending(true);
    setEditError(null);
    try {
      const item = items.find(item => item.id === editingCell.rowId);
      if (!item) throw new Error('Song no longer exists');
      if (editValue !== item[editingCell.field]) {
        await updateItem(item.id, editingCell.field, editValue);
      }
      closeCellEdit(restoreFocus);
      return true;
    } catch {
      setEditError('Could not save this field. Your edit is still here; press Enter to retry or Escape to cancel.');
      return false;
    } finally {
      editSaving.current = false;
      setEditPending(false);
    }
  };

  const moveCellEdit = async (columnOffset: number, rowOffset: number, wrap = false) => {
    if (!editingCell || editSaving.current) return;
    const visibleRows = table.getRowModel().rows;
    let rowIndex = visibleRows.findIndex(row => row.id === editingCell.rowId) + rowOffset;
    let columnIndex = editableFields.indexOf(editingCell.field) + columnOffset;
    if (wrap && columnIndex < 0) { rowIndex--; columnIndex = editableFields.length - 1; }
    if (wrap && columnIndex >= editableFields.length) { rowIndex++; columnIndex = 0; }
    const destination = visibleRows[rowIndex]?.original;
    const field = editableFields[columnIndex];
    if (!destination || !field) return;
    if (!await saveCellEdit(false)) return;
    // A save may reorder or filter the rows. Follow the destination's identity,
    // after React has rendered the updated library, rather than its old index.
    requestAnimationFrame(() => {
      const row = scrollRef.current?.querySelector<HTMLTableRowElement>(`tr[data-item-id="${CSS.escape(destination.id)}"]`);
      if (!row) return;
      returnFocusRef.current = row;
      setSelection({ rowId: destination.id, field });
      beginCellEdit(destination, field);
    });
  };

  const handleContextMenu = useCallback((e: React.MouseEvent, item: LibraryItem) => {
    e.preventDefault();
    cancelClickEdit();
    if (editingCell) return;
    if (!selectedIds.has(item.id)) setSelectedIds(new Set([item.id]));
    setSelection({ rowId: item.id, field: editableField(e.target as HTMLElement) });
    returnFocusRef.current = e.currentTarget as HTMLTableRowElement;
    returnFocusRef.current.focus();
    setContextMenu({ x: e.clientX, y: e.clientY, item });
  }, [editingCell, selectedIds, cancelClickEdit]);

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
      const selected = table.getRowModel().rows.map(row => row.original).filter(item => selectedIds.has(item.id));
      (selected.length ? selected : [contextMenu.item]).forEach(addToQueue);
      setContextMenu(null);
    }
  }, [contextMenu, addToQueue, selectedIds, table]);

  const handlePlayNext = useCallback(() => {
    if (contextMenu) {
      const selected = table.getRowModel().rows.map(row => row.original).filter(item => selectedIds.has(item.id));
      (selected.length ? selected : [contextMenu.item]).slice().reverse().forEach(addNext);
      setContextMenu(null);
    }
  }, [contextMenu, addNext, selectedIds, table]);

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

  const rows = table.getRowModel().rows;
  const contextItems = contextMenu ? rows.filter(row => selectedIds.has(row.id)).map(row => row.original) : [];
  const contextIds = contextItems.length ? contextItems.map(item => item.id) : contextMenu ? [contextMenu.item.id] : [];
  const manualPlaylists = playlists.filter(playlist => !playlist.smart_rules);
  function selectRows(id: string, extend: boolean, toggle: boolean) {
    if (extend && anchor.current && rows.some(row => row.id === anchor.current)) {
      const first = rows.findIndex(row => row.id === anchor.current);
      const last = rows.findIndex(row => row.id === id);
      setSelectedIds(new Set(rows.slice(Math.min(first, last), Math.max(first, last) + 1).map(row => row.id)));
    } else if (toggle) {
      setSelectedIds(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next; });
      anchor.current = id;
    } else { setSelectedIds(new Set([id])); anchor.current = id; }
  }
  const tabStopId = rows.find(row => row.id === selection?.rowId)?.id ?? rows[0]?.id;

  return (
    <div className="px-5 h-full flex flex-col">
      {editError && <div role="alert" className="library-edit-error">{editError}</div>}
      {playlistError && <div role="alert" className="library-edit-error">{playlistError}</div>}
      {infoItem && <SongInfoDialog key={infoItem.id} item={infoItem} onClose={() => {
        setInfoItem(null);
        queueMicrotask(() => returnFocusRef.current?.focus());
      }} />}
      <div ref={scrollRef} className="overflow-auto flex-grow" onScroll={event => {
        const saved = savedViews.get(viewId);
        if (saved) saved.scrollTop = event.currentTarget.scrollTop;
      }}>
        <table aria-label="Tracks" aria-description="Click to select; Ctrl-click, Shift-click or Ctrl+A to select several. Click a selected text cell again or press F2 to edit. Double-click or Enter to play. Ctrl+I opens song info." className={`w-full border-collapse table-fixed ${table.getState().columnSizingInfo.isResizingColumn ? 'select-none' : ''}`}>
          <colgroup>
            {table.getVisibleLeafColumns().map(column => (
              <col key={column.id} style={{
                // Pixel widths on every column get stretched by table layout.
                // Reserve the heart's space and share the rest among text columns.
                width: column.id === 'is_favorite'
                  ? 28
                  : `${100 * column.getSize() / (table.getVisibleLeafColumns().reduce((total, column) => total + column.getSize(), 0) - 28)}%`,
              }} />
            ))}
          </colgroup>
          <thead className="sticky top-0 bg-solarized-base02">
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id}>
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
            {rows.map((row, rowIndex) => {
              const isCurrentlyPlaying = currentItem?.id === row.original.id;
              return (
                <tr
                  key={row.id}
                  data-item-id={row.id}
                  ref={row.original.id === revealRequest?.itemId ? revealRowRef : undefined}
                  aria-current={isCurrentlyPlaying ? 'true' : undefined}
                  aria-selected={selectedIds.has(row.id)}
                  data-drop-target={dropRow?.id === row.id ? (dropRow.after ? 'after' : 'before') : undefined}
                  draggable={!editingCell}
                  onDragStart={event => {
                    cancelClickEdit();
                    if (editingCell) { event.preventDefault(); return; }
                    const ids = selectedIds.has(row.id) ? rows.filter(row => selectedIds.has(row.id)).map(row => row.id) : [row.id];
                    setSelectedIds(new Set(ids));
                    event.dataTransfer.setData(TRACK_DRAG_TYPE, JSON.stringify(ids));
                    event.dataTransfer.effectAllowed = 'copyMove';
                  }}
                  onDragOver={event => {
                    if (allowReordering && sorting.length === 0 && event.dataTransfer.types.includes(TRACK_DRAG_TYPE)) {
                      event.preventDefault(); event.dataTransfer.dropEffect = 'move';
                      const bounds = event.currentTarget.getBoundingClientRect();
                      setDropRow({ id: row.id, after: event.clientY > bounds.top + bounds.height / 2 });
                    }
                  }}
                  onDragLeave={() => setDropRow(null)} onDragEnd={() => setDropRow(null)}
                  onDrop={event => {
                    setDropRow(null);
                    if (!allowReordering || !selectedPlaylist || sorting.length || playlistMutation.isPending) return;
                    const moving = draggedTrackIds(event.dataTransfer);
                    if (!moving.length) return;
                    event.preventDefault();
                    const order = Object.values(selectedPlaylist.items).sort((a, b) => a.position - b.position).map(item => item.library_item_id);
                    if (moving.includes(row.id)) return;
                    const bounds = event.currentTarget.getBoundingClientRect();
                    const before = event.clientY > bounds.top + bounds.height / 2 ? order[order.indexOf(row.id) + 1] ?? null : row.id;
                    void changePlaylist('/' + selectedPlaylist.id + '/order', 'PUT', { library_item_ids: moveTracksBefore(order, moving, before) });
                  }}
                  tabIndex={tabStopId === row.id ? 0 : -1}
                  onFocus={event => {
                    if (event.target === event.currentTarget) setSelection(previous => ({ rowId: row.id, field: previous?.field ?? 'name' }));
                  }}
                  onKeyDown={(event) => {
                    cancelClickEdit();
                    if (event.target !== event.currentTarget || editingCell) return;
                    returnFocusRef.current = event.currentTarget;
                    const field = selection?.rowId === row.id ? selection.field : 'name';
                    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
                      event.preventDefault(); setSelectedIds(new Set(rows.map(row => row.id)));
                    } else if (event.key === 'Escape') {
                      setSelectedIds(new Set());
                    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'i') {
                      event.preventDefault();
                      setContextMenu(null);
                      setInfoItem(row.original);
                    } else if (event.key === 'F2') {
                      event.preventDefault();
                      beginCellEdit(row.original, field);
                    } else if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) {
                      event.preventDefault();
                      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                        const index = Math.max(0, Math.min(2, editableFields.indexOf(field) + (event.key === 'ArrowLeft' ? -1 : 1)));
                        setSelection({ rowId: row.id, field: editableFields[index] });
                      } else {
                        const next = event.key === 'ArrowUp' ? event.currentTarget.previousElementSibling : event.currentTarget.nextElementSibling;
                        if (next instanceof HTMLTableRowElement) {
                          const nextId = rows[rowIndex + (event.key === 'ArrowUp' ? -1 : 1)]?.id;
                          if (nextId) { setSelection({ rowId: nextId, field }); selectRows(nextId, event.shiftKey, false); }
                          next.focus();
                        }
                      }
                    } else if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
                      event.preventDefault();
                      const rect = event.currentTarget.getBoundingClientRect();
                      setSelection({ rowId: row.id, field });
                      if (!selectedIds.has(row.id)) setSelectedIds(new Set([row.id]));
                      setContextMenu({ x: rect.left + 10, y: rect.bottom, item: row.original });
                    } else if ((event.key === 'Enter' || event.key === ' ') && !event.repeat) {
                      event.preventDefault();
                      event.stopPropagation();
                      handleRowPlay(row.original, rowIndex, event);
                    }
                  }}
                  className={`hover:bg-solarized-base02 cursor-pointer ${isCurrentlyPlaying ? 'bg-solarized-base02' : ''}`}
                  onPointerDown={event => {
                    cancelClickEdit();
                    clickWasSelected.current = selectedIds.size === 1 && selectedIds.has(row.id) && selection?.rowId === row.id && selection.field === editableField(event.target as HTMLElement);
                  }}
                  onBlur={event => { if (event.target === event.currentTarget) cancelClickEdit(); }}
                  onClick={event => {
                    if ((event.target as HTMLElement).closest('button, input')) return;
                    const field = editableField(event.target as HTMLElement);
                    const isTextCell = editableFields.some(value => value === (event.target as HTMLElement).closest('td')?.getAttribute('data-column'));
                    const rowElement = event.currentTarget;
                    setSelection({ rowId: row.id, field });
                    selectRows(row.id, event.shiftKey, event.ctrlKey || event.metaKey);
                    rowElement.focus();
                    if (!editingCell && clickWasSelected.current && isTextCell && event.detail === 1 && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
                      // Defer rename so a second click can still produce normal playback.
                      editClickTimer.current = setTimeout(() => {
                        editClickTimer.current = null;
                        if (!rowElement.isConnected || document.activeElement !== rowElement) return;
                        returnFocusRef.current = rowElement;
                        beginCellEdit(row.original, field);
                      }, 500);
                    }
                  }}
                  onDoubleClick={event => { cancelClickEdit(); handleRowPlay(row.original, rowIndex, event); }}
                  onContextMenu={(e) => handleContextMenu(e, row.original)}
                >
                  {row.getVisibleCells().map((cell) => {
                    const field = cell.column.id;
                    const isEditing = editingCell?.rowId === row.id && editingCell?.field === field;

                    return (
                      <td
                        key={cell.id}
                        data-column={field}
                        data-selected-cell={selection?.rowId === row.id && selection.field === field || undefined}
                        className="px-2 py-1 border-b border-solarized-base02 whitespace-nowrap overflow-hidden text-ellipsis max-w-0"
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
                          <MetadataInput
                            ref={editInputRef}
                            suggestions={field === 'artist' || field === 'album' ? suggestions[field] : undefined}
                            type="text"
                            aria-label={`Edit ${field}`}
                            disabled={editPending}
                            value={editValue}
                            onValueChange={value => { setEditValue(value); setEditError(null); }}
                            onBlur={() => { void saveCellEdit(false); }}
                            onKeyDown={event => {
                              event.stopPropagation();
                              if (event.nativeEvent.isComposing) return;
                              const input = event.currentTarget;
                              const allSelected = input.selectionStart === 0 && input.selectionEnd === input.value.length;
                              const caret = input.selectionStart === input.selectionEnd;
                              if (event.key === 'Tab') {
                                // At the ends of the table, let Tab leave normally.
                                // Blur saves the edit without trapping keyboard focus.
                                if (event.shiftKey ? rowIndex === 0 && field === 'name' : rowIndex === rows.length - 1 && field === 'album') return;
                                event.preventDefault(); void moveCellEdit(event.shiftKey ? -1 : 1, 0, true); return;
                              }
                              if (!event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
                                if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
                                  event.preventDefault(); void moveCellEdit(0, event.key === 'ArrowUp' ? -1 : 1); return;
                                }
                                if (event.key === 'ArrowLeft' && (allSelected || (caret && input.selectionStart === 0))) {
                                  event.preventDefault(); void moveCellEdit(-1, 0); return;
                                }
                                if (event.key === 'ArrowRight' && (allSelected || (caret && input.selectionEnd === input.value.length))) {
                                  event.preventDefault(); void moveCellEdit(1, 0); return;
                                }
                              }
                              if (event.key === 'Enter') { event.preventDefault(); void saveCellEdit(); }
                              if (event.key === 'Escape' && !editSaving.current) { event.preventDefault(); closeCellEdit(); }
                            }}
                            className="w-full bg-solarized-base03 text-solarized-base1 border border-solarized-blue px-1"
                            onFocus={event => event.target.select()}
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
          ref={contextMenuRef}
          className="library-context-menu fixed z-50 bg-solarized-base02 border border-solarized-blue rounded shadow-lg py-1 min-w-32"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={event => {
            if (event.key === 'Escape') {
              event.preventDefault(); event.stopPropagation();
              setContextMenu(null); returnFocusRef.current?.focus();
            }
          }}
        >
          {contextIds.length > 1 && <div className="context-selection-count">{contextIds.length} selected tracks</div>}
          {contextIds.length === 1 && <><button type="button" className="w-full text-left px-3 py-2 text-solarized-base1 hover:bg-solarized-blue"
            onClick={() => { setInfoItem(contextMenu.item); setContextMenu(null); }}>
            Get Info… <span className="menu-shortcut">Ctrl+I</span>
          </button>
          <button type="button" className="w-full text-left px-3 py-2 text-solarized-base1 hover:bg-solarized-blue"
            onClick={() => { beginCellEdit(contextMenu.item, selection?.field ?? 'name'); setContextMenu(null); }}>
            Edit {selection?.field ?? 'name'} <span className="menu-shortcut">F2</span>
          </button></>}
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
            <button type="button" aria-expanded={showPlaylistSubmenu} onClick={() => setShowPlaylistSubmenu(!showPlaylistSubmenu)} className="w-full px-3 py-2 text-solarized-base1 hover:bg-solarized-blue hover:bg-opacity-30 cursor-pointer flex justify-between items-center">
              <span>&#9835; Add to Playlist</span>
              <span>&#9656;</span>
            </button>
            {showPlaylistSubmenu && (
              <div className="playlist-submenu bg-solarized-base02 py-1 min-w-32">
                {manualPlaylists.length === 0 ? (
                  <div className="px-3 py-2 text-solarized-base0 italic">No playlists</div>
                ) : (
                  manualPlaylists.map((playlist) => (
                    <button type="button"
                      key={playlist.id}
                      className="w-full text-left px-3 py-2 text-solarized-base1 hover:bg-solarized-blue hover:bg-opacity-30 cursor-pointer"
                      disabled={playlistMutation.isPending}
                      onClick={() => {
                        void changePlaylist('/' + playlist.id + '/items', 'POST', { library_item_ids: contextIds });
                        setContextMenu(null);
                        setShowPlaylistSubmenu(false);
                      }}
                    >
                      {playlist.name}
                    </button>
                  ))
                )}
              </div>
            )}
          </div>
          {onNewPlaylist && <button type="button" className="w-full text-left px-3 py-2" onClick={() => {
            onNewPlaylist(contextIds); setContextMenu(null);
          }}>New playlist from selection…</button>}
          {selectedPlaylist && <button type="button" className="w-full text-left px-3 py-2" disabled={playlistMutation.isPending} onClick={() => {
            void changePlaylist('/' + selectedPlaylist.id + '/items', 'DELETE', { library_item_ids: contextIds });
            setContextMenu(null);
          }}>Remove from playlist</button>}
          {contextIds.length === 1 && <div
            className="px-3 py-2 text-solarized-base1 hover:bg-solarized-red hover:text-solarized-base3 cursor-pointer"
            onClick={handleDelete}
          >
            &#128465; Delete from Library
          </div>}
        </div>
      )}
    </div>
  );
}
