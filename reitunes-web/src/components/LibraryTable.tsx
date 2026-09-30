import { Fragment, memo, useMemo, useState, useCallback, useEffect, useLayoutEffect, useRef, useId, type ReactNode, type Ref } from 'react';
import { autoUpdate, flip, FloatingPortal, offset, safePolygon, shift, useFloating, useHover, useInteractions } from '@floating-ui/react';
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  flexRender,
  createColumnHelper,
  type SortingState,
  type ColumnFiltersState,
  type Table,
} from '@tanstack/react-table';
import type { LibraryItem, Bookmark, Playlist } from '../types';
import { usePlayerStore } from '../stores/playerStore';
import { useQueueStore } from '../hooks/useQueue';
import { usePlayback } from '../hooks/usePlayback';
import { useMetadataSuggestions, useUpdateLibraryItem, deleteItem as apiDeleteItem } from '../hooks/useLibrary';
import { requestConfirmation, showMessage } from '../stores/dialogStore';
import { FavoriteButton } from './FavoriteButton';
import { Tooltip } from './Tooltip';
import { usePlaylists, usePlaylistMutation } from '../hooks/usePlaylists';
import { draggedTrackIds, moveTracksBefore, TRACK_DRAG_TYPE } from '../utils/playlists';
import { SongInfoDialog } from './SongInfoDialog';
import { MetadataInput } from './MetadataInput';
import { fitColumnWidths, libraryColumns, maxColumnWidth, useLibraryPreferences, type LibraryColumnId } from '../stores/libraryPreferences';
import { ColumnsDialog } from './ColumnsDialog';
import type { ItemTags } from '../hooks/useTags';
import { RowTags } from './RowTags';
import { TracklistDialog } from './TracklistDialog';
import { AlbumTrackRows } from './AlbumTrackRows';
import { MusicIcon } from './MusicIcon';
import { createLibraryRowVisibility, type LibraryRowVisibility } from './libraryRowVisibility';

const editableFields = ['name', 'artist', 'album'] as const;
type EditableField = typeof editableFields[number];
function editableField(target: HTMLElement): EditableField {
  const field = target.closest('td')?.getAttribute('data-column');
  return editableFields.find(value => value === field) ?? 'name';
}

import { durationLabel, trackDuration } from '../utils/duration';
const columnHelper = createColumnHelper<LibraryItem>();
const savedViews = new Map<string, { sorting: SortingState; scrollTop: number }>();
const COLUMN_DRAG_TYPE = 'application/x-reitunes-column';

function PlaylistSubmenu({ playlists, disabled, onSelect }: {
  playlists: Playlist[]; disabled: boolean; onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const focusOnOpen = useRef(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const id = useId();
  const { refs: { setReference, setFloating, floating }, floatingStyles, context, isPositioned } = useFloating({
    open, onOpenChange: setOpen, placement: 'right-start', strategy: 'fixed',
    middleware: [offset(2), flip({ padding: 4 }), shift({ padding: 4 })],
    whileElementsMounted: autoUpdate,
  });
  const hover = useHover(context, { handleClose: safePolygon(), mouseOnly: true });
  const { getReferenceProps, getFloatingProps } = useInteractions([hover]);
  const close = () => { setOpen(false); triggerRef.current?.focus(); };
  useLayoutEffect(() => {
    if (!open || !isPositioned || !focusOnOpen.current) return;
    focusOnOpen.current = false;
    const menu = floating.current;
    (menu?.querySelector<HTMLButtonElement>('button:not(:disabled)') ?? menu)?.focus();
  }, [open, isPositioned, floating]);

  return <>
    <button type="button" ref={node => { triggerRef.current = node; setReference(node); }}
      aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined}
      className="playlist-submenu-trigger w-full px-3 py-2 text-solarized-base1 cursor-pointer flex justify-between items-center"
      {...getReferenceProps()}
        onClick={event => {
          focusOnOpen.current = event.detail === 0;
          if (open && focusOnOpen.current) floating.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
          setOpen(true);
        }}
        onKeyDown={event => {
          if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
            event.preventDefault(); event.stopPropagation();
            focusOnOpen.current = true;
            if (open) floating.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
            else setOpen(true);
          } else if (event.key === 'Escape' && open) {
            event.preventDefault(); event.stopPropagation(); close();
          }
        }}>
      <span>&#9835; Add to Playlist</span><span aria-hidden="true">&#9656;</span>
    </button>
    {open && <FloatingPortal>
      <div ref={setFloating} style={floatingStyles} id={id} role="menu" aria-label="Add to playlist" tabIndex={-1}
        className="playlist-submenu"
        {...getFloatingProps()}
          onKeyDown={event => {
            if (event.key === 'Escape' || event.key === 'ArrowLeft') {
              event.preventDefault(); event.stopPropagation(); close();
            } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
              event.preventDefault(); event.stopPropagation();
              const buttons = Array.from(floating.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
              const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
              const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
                : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
              buttons[next]?.focus();
            }
          }}
          onBlur={event => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null) && event.relatedTarget !== triggerRef.current) setOpen(false);
          }}>
        {playlists.length === 0 ? <div className="px-3 py-2 text-solarized-base0 italic">No playlists</div>
          : playlists.map(playlist => <button type="button" role="menuitem" key={playlist.id} tabIndex={-1}
            title={playlist.name} disabled={disabled} onClick={() => onSelect(playlist.id)}>{playlist.name}</button>)}
      </div>
    </FloatingPortal>}
  </>;
}

interface LibraryTableProps {
  items: LibraryItem[];
  searchQuery: string;
  onlyFavouriteTracks?: boolean;
  playlistId?: string | null;
  onSearchChange?: (query: string) => void;
  revealRequest?: { itemId: string; focus?: boolean } | null;
  onRevealed?: () => void;
  onManageBookmarks?: (item: LibraryItem) => void;
  onManageTags?: (item: LibraryItem) => void;
  onFilterTag?: (tag: string) => void;
  tagItems?: Record<string, ItemTags>;
  selectedTagItemId?: string | null;
  contextName?: string;
  allowReordering?: boolean;
  onNewPlaylist?: (itemIds: string[]) => void;
  onSelectionCountChange?: (count: number) => void;
  onViewItemsChange?: (items: LibraryItem[]) => void;
  playbackState?: 'playing' | 'paused';
  viewId?: string;
}

type TagTableMeta = Pick<LibraryTableProps, 'onManageTags' | 'onFilterTag'>;

// Selection changes the row/cell attributes, but not its song content. Keep
// thousands of tooltip and tag components out of that render path.
const LibraryCellContent = memo(function LibraryCellContent({ item, column, table, tags, tagSelected }: {
  item: LibraryItem; column: string; table: Table<LibraryItem>; tags?: ItemTags; tagSelected: boolean;
}) {
  if (column === 'tags') {
    // TanStack keeps its table object stable. Read the current callbacks when
    // clicked so memoized cells never retain an old parent callback.
    const actions = () => table.options.meta as TagTableMeta;
    return <RowTags name={item.name} data={tags} selected={tagSelected}
      onEdit={() => actions().onManageTags?.(item)} onFilter={tag => actions().onFilterTag?.(tag)} />;
  }
  switch (column) {
    case 'is_favorite': return <FavoriteButton itemId={item.id} isFavorite={item.is_favorite ?? false} />;
    case 'name': case 'artist': case 'album': return <Tooltip content={item[column]}>{item[column]}</Tooltip>;
    case 'track_number': return item.track_number ?? '';
    case 'duration_seconds': return durationLabel(trackDuration(item));
    case 'play_count': return item.play_count;
    case 'bookmarks': return formatBookmarks(item.bookmarks);
    case 'created_time_utc': return <Tooltip content={formatCreatedTime(item.created_time_utc)} force>{formatCreatedTime(item.created_time_utc, true)}</Tooltip>;
    default: return null;
  }
});

interface RowCellAppearance {
  isCurrentlyPlaying: boolean;
  playbackState?: 'playing' | 'paused';
  expanded: boolean;
  onBookmarkClick: (item: LibraryItem, position: number, bookmarkId: string, event: React.MouseEvent) => void;
  onToggleTracklist: (id: string, expanded: boolean) => void;
}

function LibraryCellFrame({ item, column: field, cellRef, selected, editing, isCurrentlyPlaying, playbackState, expanded,
  onBookmarkClick, onToggleTracklist, children }: RowCellAppearance & {
  item: LibraryItem; column: string; cellRef?: Ref<HTMLTableCellElement>; selected: boolean; editing?: boolean; children: ReactNode;
}) {
  return <td ref={cellRef} data-column={field} data-has-tracklist={field === 'name' && !!item.tracklist || undefined}
    data-selected-cell={selected || undefined} data-editing={editing || undefined}
    className="px-2 py-1 border-b border-solarized-base02 whitespace-nowrap overflow-hidden text-ellipsis max-w-0"
    onClick={event => {
      const target = event.target as HTMLElement;
      if (target.classList.contains('bookmark-emoji')) {
        onBookmarkClick(item, parseFloat(target.getAttribute('data-position') || '0'), target.getAttribute('data-bookmark-id') || '', event);
      }
    }}>
    {field === 'name' && isCurrentlyPlaying && <span className="library-playback-indicator" role="img"
      aria-label={playbackState === 'playing' ? 'Playing' : playbackState === 'paused' ? 'Paused' : 'Current track'}>
      <MusicIcon name={playbackState === 'paused' ? 'pause' : 'volume'} size={16} />
    </span>}
    {field === 'name' && item.tracklist && !editing && <button type="button" className="tracklist-disclosure"
      aria-label={`Tracklist for ${item.name}`} aria-expanded={expanded}
      onClick={event => { event.stopPropagation(); onToggleTracklist(item.id, !expanded); }}>
      {expanded ? '▾' : '▸'}</button>}
    {children}
  </td>;
}

// Filtering rebuilds TanStack rows/cells even for surviving songs. Use the
// original item and stable column order to retain their rendered content.
const LibraryRowCells = memo(function LibraryRowCells({ item, columns, table, visibility, eager, selectedField, editorField, editor, tags, tagSelected, ...appearance }:
  RowCellAppearance & { item: LibraryItem; columns: string[]; table: Table<LibraryItem>; visibility: LibraryRowVisibility;
    eager: boolean; selectedField?: EditableField; editorField?: EditableField; editor?: ReactNode; tags?: ItemTags; tagSelected: boolean }) {
  const firstCell = useRef<HTMLTableCellElement>(null);
  const [visible, setVisible] = useState(false);
  useLayoutEffect(() => {
    const row = firstCell.current?.parentElement;
    if (row) return visibility.observe(row, setVisible);
  }, [visibility]);
  if (!eager && !visible && !selectedField && !editor) {
    return <td ref={firstCell} colSpan={columns.length} aria-label={`${item.name} — ${item.artist}`} />;
  }
  return columns.map((column, index) => <LibraryCellFrame key={column} item={item} column={column}
    cellRef={index === 0 ? firstCell : undefined} selected={selectedField === column} editing={editorField === column} {...appearance}>
    {editorField === column ? editor : <LibraryCellContent item={item} column={column} table={table}
      tags={column === 'tags' ? tags : undefined} tagSelected={column === 'tags' && tagSelected} />}
  </LibraryCellFrame>);
});

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
      const value = match[2].replace(/\\(["\\])/g, '$1');
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
        data-bookmark-id={id}
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

export const LibraryTable = memo(function LibraryTable({ items, searchQuery, onlyFavouriteTracks = false, playlistId, onSearchChange, revealRequest, onRevealed, onManageBookmarks, onManageTags, onFilterTag, tagItems, selectedTagItemId, contextName: sourceName, allowReordering, onNewPlaylist, onSelectionCountChange, onViewItemsChange, playbackState, viewId = 'all' }: LibraryTableProps) {
  // TanStack Table v8 exposes mutable state through stable methods. Remove this
  // opt-out when useReactTable supports React Compiler memoization.
  'use no memo';
  const headerId = useId();
  const [rowVisibility] = useState(createLibraryRowVisibility);
  const { columnOrder, columnVisibility, columnWidths, resizeColumn, moveColumn } = useLibraryPreferences();
  const [choosingColumns, setChoosingColumns] = useState(false);
  const [tracklistItem, setTracklistItem] = useState<LibraryItem | null>(null);
  const [expandedAlbums, setExpandedAlbums] = useState<Map<string, boolean>>(new Map());
  const [columnDrop, setColumnDrop] = useState<{ id: string; after: boolean } | null>(null);
  const draggedColumn = useRef<string | null>(null);
  const columnResize = useRef<{ id: string; x: number; width: number } | null>(null);
  const [resizingColumn, setResizingColumn] = useState(false);
  const [availableWidth, setAvailableWidth] = useState(900);
  const visibleEditableFields = columnOrder.filter((id): id is EditableField =>
    editableFields.includes(id as EditableField) && columnVisibility[id] !== false);
  function selectedField(field?: EditableField): EditableField {
    return field && visibleEditableFields.includes(field) ? field : 'name';
  }
  const columnSizing = fitColumnWidths(columnOrder, columnVisibility, columnWidths, availableWidth);

  const scrollRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const observer = new ResizeObserver(() => setAvailableWidth(scroller.clientWidth));
    observer.observe(scroller);
    setAvailableWidth(scroller.clientWidth);
    return () => observer.disconnect();
  }, []);
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
    if (revealRequest.focus) {
      setSelection({ rowId: revealRequest.itemId, field: 'name' });
      setSelectedIds(new Set([revealRequest.itemId]));
      anchor.current = revealRequest.itemId;
      row.focus({ preventScroll: true });
    }
    onRevealed?.();
  }, [revealRequest, items, onRevealed]);
  const [sorting, setSorting] = useState<SortingState>(savedViews.get(viewId)?.sorting ?? (playlistId ? [] : [
    { id: 'created_time_utc', desc: true },
  ]));
  useEffect(() => {
    savedViews.set(viewId, { sorting, scrollTop: scrollRef.current?.scrollTop ?? 0 });
  }, [viewId, sorting]);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [selection, setSelection] = useState<{ rowId: string; field: EditableField } | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const anchor = useRef<string | null>(null);
  const dragPreviewRef = useRef<HTMLDivElement>(null);
  const [playlistError, setPlaylistError] = useState('');
  const [dropRow, setDropRow] = useState<{ id: string; after: boolean } | null>(null);
  const [editingCell, setEditingCell] = useState<{ rowId: string; field: EditableField } | null>(null);
  const [editValue, setEditValue] = useState('');
  const [editError, setEditError] = useState<string | null>(null);
  const [editPending, setEditPending] = useState(false);
  const editSaving = useRef(false);
  const editFinished = useRef(false);
  const editComposing = useRef(false);
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
  const toggleTracklist = useCallback((id: string, expanded: boolean) => {
    cancelClickEdit();
    setExpandedAlbums(previous => new Map(previous).set(id, expanded));
  }, [cancelClickEdit]);

  // Context menu state
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; item: LibraryItem } | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const menu = contextMenuRef.current;
    if (!contextMenu || !menu) return;
    const bounds = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(4, Math.min(contextMenu.x, innerWidth - bounds.width - 4))}px`;
    menu.style.top = `${Math.max(4, Math.min(contextMenu.y, innerHeight - bounds.height - 4))}px`;
    if (!menu.contains(document.activeElement)) menu.querySelector('button')?.focus();
  }, [contextMenu]);
  useLayoutEffect(() => {
    if (editingCell) {
      editInputRef.current?.focus();
      editInputRef.current?.select();
    }
  }, [editingCell]);

  const currentItemId = usePlayerStore(state => state.currentItemId);
  const play = usePlayback();
  const addToQueue = useQueueStore(state => state.addToQueue);
  const addNext = useQueueStore(state => state.addNext);
  const setContext = useQueueStore(state => state.setContext);

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
        // Field filters identify one artist or album; free text remains a substring search.
        if (artist && item.artist.toLowerCase() !== artist.toLowerCase()) {
          return false;
        }
        if (album && item.album.toLowerCase() !== album.toLowerCase()) {
          return false;
        }
        // General text search across all fields
        if (text) {
          const query = text.toLowerCase();
          return item.name.toLowerCase().includes(query) ||
                 item.artist.toLowerCase().includes(query) ||
                 item.album.toLowerCase().includes(query) ||
                 item.tracklist?.tracks.some(track => track.title.toLowerCase().includes(query));
        }
        return true;
      });
    }

    return result;
  }, [items, searchQuery, selectedPlaylist]);

  const columns = useMemo(() => [
    columnHelper.accessor('is_favorite', {
      header: '\u2665',
      size: 28,
      minSize: 28,
      maxSize: 28,
      enableResizing: false,
      enableSorting: true,
    }),
    columnHelper.accessor('name', {
      header: 'Name',
      size: 220,
    }),
    columnHelper.accessor('artist', {
      header: 'Artist',
      size: 140,
    }),
    columnHelper.accessor('album', {
      header: 'Album',
      size: 140,
    }),
    columnHelper.accessor('track_number', {
      header: '#',
      size: 40,
    }),
    columnHelper.accessor(item => trackDuration(item) ?? undefined, {
      id: 'duration_seconds', header: 'Duration',
      sortUndefined: 'last', size: 65,
    }),
    columnHelper.accessor('play_count', {
      header: 'Plays',
      size: 50,
    }),
    columnHelper.accessor('bookmarks', {
      header: 'Bookmarks',
      size: 100,
      enableSorting: false,
    }),
    columnHelper.display({
      id: 'tags', header: 'Tags', size: 160,
    }),
    columnHelper.accessor('created_time_utc', {
      header: 'Created',
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
      columnVisibility,
      columnOrder,
    },
    meta: { onManageTags, onFilterTag } satisfies TagTableMeta,
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    defaultColumn: { minSize: 40 },
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getRowId: (row) => row.id,
  });

  function holdPrecedingWidths(id: string) {
    // Keep the dragged edge under the pointer. Only columns to its right may
    // absorb spare space; resizing the last column can widen the whole table.
    for (const column of table.getVisibleLeafColumns()) {
      if (column.id === id) break;
      if (column.getCanResize()) resizeColumn(column.id, column.getSize());
    }
  }

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
    const favourite = onlyFavouriteTracks && !item.is_favorite ? item.tracklist?.tracks.find(track => track.is_favorite) : undefined;
    const nextStart = item.tracklist?.tracks.find(track => favourite && track.start > favourite.start)?.start;
    void play(item, favourite?.start ?? 0, 'selection', favourite ? { start: favourite.start, end: favourite.end ?? nextStart ?? item.tracklist?.duration ?? null, afterEnd: 'pause' } : undefined);
  }, [play, editingCell, table, setContext, selectedPlaylist, sourceName, onlyFavouriteTracks]);

  const handleBookmarkClick = useCallback((item: LibraryItem, position: number, bookmarkId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    void play(item, position, 'bookmark', { start: position, end: item.bookmarks[bookmarkId]?.end_position ?? null, bookmarkId });
  }, [play]);

  const beginCellEdit = useCallback((item: LibraryItem, field: EditableField) => {
    cancelClickEdit();
    setSelectedIds(new Set([item.id]));
    editFinished.current = false;
    editComposing.current = false;
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
      const ownsFocus = document.activeElement === editInputRef.current;
      closeCellEdit(restoreFocus && ownsFocus);
      return ownsFocus ? 'focused' : 'blurred';
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
    let columnIndex = visibleEditableFields.indexOf(editingCell.field) + columnOffset;
    if (wrap && columnIndex < 0) { rowIndex--; columnIndex = visibleEditableFields.length - 1; }
    if (wrap && columnIndex >= visibleEditableFields.length) { rowIndex++; columnIndex = 0; }
    const destination = visibleRows[rowIndex]?.original;
    const field = visibleEditableFields[columnIndex];
    if (!destination || !field) return;
    const input = editInputRef.current;
    if (await saveCellEdit(false) !== 'focused') return;
    // A save may reorder or filter the rows. Follow the destination's identity,
    // after React has rendered the updated library, rather than its old index.
    requestAnimationFrame(() => {
      // Respect a click or Tab made while the save was finishing.
      if (document.activeElement !== document.body && document.activeElement !== input) return;
      const row = scrollRef.current?.querySelector<HTMLTableRowElement>(`tr[data-item-id="${CSS.escape(destination.id)}"]`);
      const item = table.getRowModel().rows.find(row => row.id === destination.id)?.original;
      if (!row || !item) return;
      returnFocusRef.current = row;
      setSelection({ rowId: destination.id, field });
      beginCellEdit(item, field);
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
      setContextMenu(null);
      returnFocusRef.current?.focus();
      if (await requestConfirmation({ title: 'Delete song?', message: `“${item.name}” will be deleted. Its audio file will also be permanently deleted unless another song uses it.`, actionLabel: 'Delete song', destructive: true })) {
        try {
          await apiDeleteItem(item.id);
        } catch (err) {
          console.error('Failed to delete:', err);
          showMessage('Could not delete song', `“${item.name}” could not be deleted. Please try again.`);
        }
      }
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
      const escaped = contextMenu.item.artist.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      onSearchChange(`artist:"${escaped}"`);
      setContextMenu(null);
    }
  }, [contextMenu, onSearchChange]);

  const handleFilterByAlbum = useCallback(() => {
    if (contextMenu && onSearchChange) {
      const escaped = contextMenu.item.album.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      onSearchChange(`album:"${escaped}"`);
      setContextMenu(null);
    }
  }, [contextMenu, onSearchChange]);

  // Close context menu on click outside
  useEffect(() => {
    const handleClick = () => {
      setContextMenu(null);
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setContextMenu(null);
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
  const visibleColumns = table.getVisibleLeafColumns();
  const visibleColumnIds = useMemo(() => visibleColumns.map(column => column.id), [visibleColumns]);
  useLayoutEffect(() => { onViewItemsChange?.(rows.map(row => row.original)); }, [rows, onViewItemsChange]);
  const selectedRows = rows.filter(row => selectedIds.has(row.id));
  const selectedCount = selectedRows.length;
  useEffect(() => { onSelectionCountChange?.(selectedCount); }, [selectedCount, onSelectionCountChange]);
  const contextItems = contextMenu ? selectedRows.map(row => row.original) : [];
  const contextIds = contextItems.length ? contextItems.map(item => item.id) : contextMenu ? [contextMenu.item.id] : [];
  const manualPlaylists = playlists.filter(playlist => !playlist.smart_rules);
  function selectRows(id: string, extend: boolean, toggle: boolean) {
    if (extend && anchor.current && rows.some(row => row.id === anchor.current)) {
      const first = rows.findIndex(row => row.id === anchor.current);
      const last = rows.findIndex(row => row.id === id);
      const range = rows.slice(Math.min(first, last), Math.max(first, last) + 1).map(row => row.id);
      setSelectedIds(previous => new Set(toggle ? [...previous, ...range] : range));
    } else if (toggle) {
      setSelectedIds(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next; });
      anchor.current = id;
    } else { setSelectedIds(new Set([id])); anchor.current = id; }
  }
  const tabStopId = rows.find(row => row.id === selection?.rowId)?.id ?? rows[0]?.id;

  function renderCellEditor(itemId: string, rowIndex: number, field: EditableField) {
    return (
      <MetadataInput
        ref={editInputRef}
        suggestions={field === 'artist' || field === 'album' ? suggestions[field] : undefined}
        type="text"
        aria-label={`Edit ${field}`}
        readOnly={editPending}
        aria-busy={editPending || undefined}
        aria-invalid={!!editError}
        value={editValue}
        onValueChange={value => { setEditValue(value); setEditError(null); }}
        onCompositionStart={() => { editComposing.current = true; }}
        onCompositionEnd={() => { editComposing.current = false; }}
        onBlur={() => { void saveCellEdit(false); }}
        onKeyDown={event => {
          event.stopPropagation();
          if (editComposing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
          if (editSaving.current) {
            if (['Tab', 'Enter', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) event.preventDefault();
            return;
          }
          const input = event.currentTarget;
          const caret = input.selectionStart === input.selectionEnd;
          if (event.key === 'Tab' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.repeat) {
            // At the ends of the table, let Tab leave normally.
            // Blur saves the edit without trapping keyboard focus.
            if (event.shiftKey ? rowIndex === 0 && field === visibleEditableFields[0] : rowIndex === rows.length - 1 && field === visibleEditableFields.at(-1)) return;
            event.preventDefault(); void moveCellEdit(event.shiftKey ? -1 : 1, 0, true); return;
          }
          if (!event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey && !event.repeat) {
            if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
              event.preventDefault(); void moveCellEdit(0, event.key === 'ArrowUp' ? -1 : 1); return;
            }
            if (event.key === 'ArrowLeft' && caret && input.selectionStart === 0) {
              event.preventDefault(); void moveCellEdit(-1, 0); return;
            }
            if (event.key === 'ArrowRight' && caret && input.selectionEnd === input.value.length) {
              event.preventDefault(); void moveCellEdit(1, 0); return;
            }
          }
          if (event.key === 'Enter') { event.preventDefault(); if (!event.repeat) void saveCellEdit(); }
          if (event.key === 'Escape' && !editSaving.current) { event.preventDefault(); closeCellEdit(); }
        }}
        className="library-cell-editor"
        onFocus={() => {
          setSelection({ rowId: itemId, field: field as EditableField });
          setSelectedIds(new Set([itemId]));
        }}
        autoFocus
      />
    );
  }

  return (
    <div className="px-5 h-full flex flex-col">
      <div ref={dragPreviewRef} className="library-drag-preview" aria-hidden="true" />
      {choosingColumns && <ColumnsDialog onClose={() => setChoosingColumns(false)} />}
      {tracklistItem && <TracklistDialog key={tracklistItem.id} item={tracklistItem} onClose={() => setTracklistItem(null)}
        onApplied={() => setExpandedAlbums(old => new Map(old).set(tracklistItem.id, true))} />}
      {editError && <div role="alert" className="library-edit-error">{editError}</div>}
      {playlistError && <div role="alert" className="library-edit-error">{playlistError}</div>}
      {infoItem && <SongInfoDialog key={infoItem.id} item={items.find(item => item.id === infoItem.id) ?? infoItem} onClose={() => {
        setInfoItem(null);
        queueMicrotask(() => returnFocusRef.current?.focus());
      }} />}
      <div ref={scrollRef} data-library-scroll className="overflow-auto flex-grow" onScroll={event => {
        const saved = savedViews.get(viewId);
        if (saved) saved.scrollTop = event.currentTarget.scrollTop;
      }}>
        <table style={{ width: Object.values(columnSizing).reduce((sum, width) => sum + width, 0) }} aria-label="Tracks" aria-description="Right-click a column header to choose columns. Drag headers to reorder or their edges to resize. Click to select; Ctrl-click or Command-click toggles tracks, Shift-click selects a range, and Ctrl+A or Command+A selects all visible tracks. Drag any selected row to a playlist or the queue to add the selection in its displayed order. Click a selected text cell again or press F2 to edit. Double-click or Enter to play. Ctrl+I opens song info." className={`border-collapse table-fixed ${resizingColumn ? 'select-none' : ''}`}>
          <colgroup>
            {table.getVisibleLeafColumns().map(column => (
              <col key={column.id} style={{
                width: column.getSize(),
              }} />
            ))}
          </colgroup>
          <thead className="sticky top-0 bg-solarized-base02">
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <th
                    key={header.id}
                    aria-labelledby={`${headerId}-${header.id}`}
                    data-column={header.column.id}
                    data-column-drop={columnDrop?.id === header.column.id ? (columnDrop.after ? 'after' : 'before') : undefined}
                    aria-sort={header.column.getIsSorted() === 'asc' ? 'ascending' : header.column.getIsSorted() === 'desc' ? 'descending' : undefined}
                    onContextMenu={event => {
                      event.preventDefault();
                      event.currentTarget.querySelector('button')?.focus();
                      setChoosingColumns(true);
                    }}
                    onKeyDown={event => {
                      if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
                        event.preventDefault(); setChoosingColumns(true);
                      }
                    }}
                    onDragOver={event => {
                      if (!event.dataTransfer.types.includes(COLUMN_DRAG_TYPE)) return;
                      event.preventDefault(); event.dataTransfer.dropEffect = 'move';
                      setColumnDrop({ id: header.column.id, after: columnOrder.indexOf(draggedColumn.current as LibraryColumnId) < columnOrder.indexOf(header.column.id as LibraryColumnId) });
                    }}
                    onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setColumnDrop(null); }}
                    onDrop={event => {
                      const id = event.dataTransfer.getData(COLUMN_DRAG_TYPE) as LibraryColumnId;
                      if (!columnOrder.includes(id)) return;
                      event.preventDefault(); setColumnDrop(null); moveColumn(id, header.column.id as LibraryColumnId);
                    }}
                    className="relative text-left px-2 py-1 border-b border-solarized-base01 cursor-pointer hover:bg-solarized-base01 whitespace-nowrap overflow-hidden text-ellipsis"
                  >
                    <button
                      type="button"
                      id={`${headerId}-${header.id}`}
                      title="Drag to reorder. Right-click to choose columns."
                      draggable
                      onDragStart={event => {
                        draggedColumn.current = header.column.id;
                        event.dataTransfer.setData(COLUMN_DRAG_TYPE, header.column.id);
                        event.dataTransfer.effectAllowed = 'move';
                      }}
                      onDragEnd={() => { setColumnDrop(null); draggedColumn.current = null; }}
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
                      role="separator" tabIndex={0} aria-orientation="vertical"
                      aria-label={`Resize ${libraryColumns.find(column => column.id === header.column.id)?.label}`}
                      aria-valuenow={Math.round(header.column.getSize())}
                      aria-valuemin={libraryColumns.find(column => column.id === header.column.id)?.min} aria-valuemax={maxColumnWidth}
                      title="Drag to resize. Double-click to reset. Arrow keys adjust width; Home resets."
                      onDoubleClick={() => resizeColumn(header.column.id)}
                      onKeyDown={event => {
                        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                          event.preventDefault(); event.stopPropagation();
                          holdPrecedingWidths(header.column.id);
                          resizeColumn(header.column.id, header.column.getSize() + (event.key === 'ArrowLeft' ? -10 : 10));
                        } else if (event.key === 'Home') { event.preventDefault(); resizeColumn(header.column.id); }
                      }}
                      onPointerDown={event => {
                        if (event.button !== 0) return;
                        event.preventDefault(); event.stopPropagation(); event.currentTarget.focus();
                        event.currentTarget.setPointerCapture(event.pointerId);
                        columnResize.current = { id: header.column.id, x: event.clientX, width: header.column.getSize() };
                        holdPrecedingWidths(header.column.id);
                        setResizingColumn(true);
                      }}
                      onPointerMove={event => {
                        const resize = columnResize.current;
                        if (resize) resizeColumn(resize.id, resize.width + event.clientX - resize.x);
                      }}
                      onPointerUp={event => {
                        columnResize.current = null; setResizingColumn(false);
                        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
                      }}
                      onLostPointerCapture={() => { columnResize.current = null; setResizingColumn(false); }}
                      onClick={(e) => e.stopPropagation()}
                      className="absolute right-0 top-0 h-full w-1 cursor-col-resize hover:bg-solarized-blue touch-none"
                    />}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {rows.map((row, rowIndex) => {
              const isCurrentlyPlaying = currentItemId === row.original.id;
              const expanded = expandedAlbums.get(row.id) ?? (onlyFavouriteTracks && !!row.original.tracklist?.tracks.some(track => track.is_favorite));
              return (
                <Fragment key={row.id}>
                <tr
                  key={row.id}
                  data-item-id={row.id}
                  data-tag-selected={selectedTagItemId === row.id || undefined}
                  ref={row.original.id === revealRequest?.itemId ? revealRowRef : undefined}
                  aria-current={isCurrentlyPlaying ? 'true' : undefined}
                  aria-selected={selectedIds.has(row.id)}
                  data-drop-target={dropRow?.id === row.id ? (dropRow.after ? 'after' : 'before') : undefined}
                  draggable={!editingCell}
                  onDragStart={event => {
                    cancelClickEdit();
                    if (editingCell) { event.preventDefault(); return; }
                    const draggedRows = selectedIds.has(row.id) ? selectedRows : [row];
                    const ids = draggedRows.map(row => row.id);
                    if (!selectedIds.has(row.id)) anchor.current = row.id;
                    setSelectedIds(new Set(ids));
                    event.dataTransfer.setData(TRACK_DRAG_TYPE, JSON.stringify(ids));
                    event.dataTransfer.effectAllowed = 'copyMove';
                    const preview = dragPreviewRef.current;
                    if (preview) {
                      const count = document.createElement('strong');
                      count.className = 'library-drag-count';
                      count.textContent = `${ids.length} ${ids.length === 1 ? 'track' : 'tracks'}`;
                      const cards = draggedRows.slice(0, 3).map((row, index) => {
                        const card = document.createElement('div');
                        card.className = 'library-drag-track';
                        card.style.marginLeft = `${index * 4}px`;
                        const name = document.createElement('span');
                        name.textContent = row.original.name;
                        const artist = document.createElement('small');
                        artist.textContent = row.original.artist || 'Unknown artist';
                        card.append(name, artist);
                        return card;
                      });
                      preview.replaceChildren(count, ...cards);
                      if (ids.length > cards.length) {
                        const more = document.createElement('span');
                        more.className = 'library-drag-more';
                        more.textContent = `+${ids.length - cards.length} more`;
                        preview.append(more);
                      }
                      event.dataTransfer.setDragImage(preview, 16, 14);
                    }
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
                    if (event.target === event.currentTarget) setSelection(previous => ({ rowId: row.id, field: selectedField(previous?.field) }));
                  }}
                  onKeyDown={(event) => {
                    cancelClickEdit();
                    if (event.target !== event.currentTarget || editingCell) return;
                    returnFocusRef.current = event.currentTarget;
                    const field = selectedField(selection?.rowId === row.id ? selection.field : undefined);
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
                        const index = Math.max(0, Math.min(visibleEditableFields.length - 1, visibleEditableFields.indexOf(field) + (event.key === 'ArrowLeft' ? -1 : 1)));
                        setSelection({ rowId: row.id, field: visibleEditableFields[index] });
                      } else {
                        let next = event.key === 'ArrowUp' ? event.currentTarget.previousElementSibling : event.currentTarget.nextElementSibling;
                        if (next?.classList.contains('album-tracklist')) next = event.key === 'ArrowUp' ? next.previousElementSibling : next.nextElementSibling;
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
                  onBlur={event => {
                    if (event.target === event.currentTarget) cancelClickEdit();
                    if (!event.currentTarget.contains(event.relatedTarget)) rowVisibility.releaseFocus(event.currentTarget);
                  }}
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
                  onDoubleClick={event => {
                    cancelClickEdit();
                    if (!event.ctrlKey && !event.metaKey && !event.shiftKey) handleRowPlay(row.original, rowIndex, event);
                  }}
                  onContextMenu={(e) => handleContextMenu(e, row.original)}
                >
                  <LibraryRowCells item={row.original} columns={visibleColumnIds} table={table}
                    visibility={rowVisibility} eager={rowIndex < 40 || revealRequest?.itemId === row.id}
                    selectedField={selection?.rowId === row.id ? selection.field : undefined}
                    editorField={editingCell?.rowId === row.id ? editingCell.field : undefined}
                    editor={editingCell?.rowId === row.id ? renderCellEditor(row.id, rowIndex, editingCell.field) : undefined}
                    tags={tagItems?.[row.id]} tagSelected={selectedTagItemId === row.id}
                    isCurrentlyPlaying={isCurrentlyPlaying} playbackState={isCurrentlyPlaying ? playbackState : undefined}
                    expanded={expanded} onBookmarkClick={handleBookmarkClick} onToggleTracklist={toggleTracklist} />
                </tr>
                {expanded && row.original.tracklist && <AlbumTrackRows item={row.original} columns={row.getVisibleCells().length} onlyFavourites={onlyFavouriteTracks && !row.original.is_favorite}
                  onEdit={() => setTracklistItem(row.original)} onPlayContext={() => setContext(rows.map(r => r.original), rowIndex, sourceName || selectedPlaylist?.name || 'Library')} />}
                </Fragment>
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
          {contextIds.length === 1 && <button type="button" className="w-full text-left px-3 py-2 text-solarized-base1 hover:bg-solarized-blue"
            onClick={() => { setTracklistItem(contextMenu.item); setContextMenu(null); }}>{contextMenu.item.tracklist ? 'Edit tracklist…' : 'Find tracklist…'}</button>}
          {onManageBookmarks && Object.keys(contextMenu.item.bookmarks).length > 0 && (
            <button type="button" className="w-full text-left px-3 py-2 text-solarized-base1 hover:bg-solarized-blue"
              onClick={() => {
                onManageBookmarks(contextMenu.item);
                setContextMenu(null);
              }}>
              Manage bookmarks
            </button>
          )}
          {contextIds.length === 1 && onManageTags && <button type="button" className="w-full text-left px-3 py-2 text-solarized-base1 hover:bg-solarized-blue"
            onClick={() => { onManageTags(contextMenu.item); setContextMenu(null); }}>Edit tags…</button>}
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
          <PlaylistSubmenu key={`${contextMenu.item.id}:${contextMenu.x}:${contextMenu.y}`}
            playlists={manualPlaylists} disabled={playlistMutation.isPending} onSelect={id => {
              void changePlaylist('/' + id + '/items', 'POST', { library_item_ids: contextIds });
              setContextMenu(null); returnFocusRef.current?.focus();
            }} />
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
});
