import { useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { deleteBookmark } from '../hooks/useLibrary';
import type { LibraryItem } from '../types';
import { bookmarkEntries, filterBookmarkEntries, formatBookmarkPosition as format, type BookmarkEntry } from '../utils/bookmarks';
import { BookmarkEditor, type BookmarkPlaybackProps } from './BookmarkEditor';
import './Bookmarks.css';

interface BookmarkSidebarProps extends BookmarkPlaybackProps {
  items: LibraryItem[];
  selectedItem?: LibraryItem;
  onClearItem: () => void;
  query?: string;
  onQueryChange?: (query: string) => void;
  hideSearch?: boolean;
  onNextMoment?: () => void;
}
type SortField = 'label' | 'name' | 'artist' | 'position' | 'end_position' | 'length';
const entryKey = (entry: BookmarkEntry) => `${entry.item.id}:${entry.bookmarkId}`;
function sortValue(entry: BookmarkEntry, field: SortField): string | number {
  if (field === 'name' || field === 'artist') return entry.item[field];
  if (field === 'length') return entry.bookmark.end_position == null ? Infinity : entry.bookmark.end_position - entry.bookmark.position;
  return entry.bookmark[field] ?? (field === 'label' ? '' : Infinity);
}

export function BookmarkSidebar({ items, selectedItem, onClearItem, onPlay, query: externalQuery, onQueryChange, hideSearch, onNextMoment, getPlaybackTime }: BookmarkSidebarProps) {
  const queryClient = useQueryClient();
  const [localQuery, setLocalQuery] = useState('');
  const query = externalQuery ?? localQuery, setQuery = onQueryChange ?? setLocalQuery;
  const [editing, setEditing] = useState<BookmarkEntry | null>(null);
  const [selection, setSelection] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [sort, setSort] = useState<{ field: SortField; desc: boolean } | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const entries = useMemo(() => {
    const result = filterBookmarkEntries(bookmarkEntries(selectedItem ? [selectedItem] : items), query);
    if (sort) result.sort((a, b) => {
      const left = sortValue(a, sort.field), right = sortValue(b, sort.field);
      return (typeof left === 'string' ? left.localeCompare(String(right), undefined, { numeric: true }) : left === right ? 0 : left < Number(right) ? -1 : 1) * (sort.desc ? -1 : 1);
    });
    else if (selectedItem) result.sort((a, b) => a.bookmark.position - b.bookmark.position);
    return result;
  }, [items, selectedItem, query, sort]);
  const beginEdit = (entry: BookmarkEntry) => {
    if (editing || pending) return;
    returnFocus.current = document.activeElement as HTMLElement;
    setEditing(entry); setSelection(entryKey(entry)); setError('');
  };
  const closeEdit = () => { setEditing(null); requestAnimationFrame(() => returnFocus.current?.focus()); };
  const playEntry = ({ item, bookmark, bookmarkId }: BookmarkEntry) => onPlay(item, bookmark.position,
    { start: bookmark.position, end: bookmark.end_position ?? null, bookmarkId });
  async function remove(entry: BookmarkEntry) {
    if (pending || editing || !confirm(`Delete bookmark "${entry.bookmark.label || 'Unlabelled bookmark'}"?`)) return;
    setPending(true); setError('');
    try { await deleteBookmark(entry.item.id, entry.bookmarkId); await queryClient.invalidateQueries({ queryKey: ['library'] }); }
    catch { setError('Could not delete the bookmark.'); }
    finally { setPending(false); }
  }
  const editButtons = (entry: BookmarkEntry) => <>
    <button type="button" className="bookmark-edit" disabled={pending || !!editing} onClick={() => beginEdit(entry)}
      aria-label={`Edit ${entry.bookmark.label || 'Unlabelled bookmark'} bookmark for ${entry.item.name}`}>Edit</button>
    <button type="button" className="bookmark-delete" disabled={pending || !!editing} onClick={() => void remove(entry)}
      aria-label={`Delete bookmark for ${entry.item.name}`} title="Delete bookmark">×</button>
  </>;
  const playButton = (entry: BookmarkEntry) => <button type="button" className="bookmark-play" onClick={() => playEntry(entry)}
    aria-label={`Play ${entry.item.name} from ${entry.bookmark.label || 'Unlabelled bookmark'}`} title="Play this bookmark"><span aria-hidden="true">▶</span> {format(entry.bookmark.position)}</button>;
  const tabStop = entries.find(entry => entryKey(entry) === selection) ?? entries[0];

  return <section className={`bookmark-sidebar ${hideSearch ? 'bookmark-grid-view' : ''}`} aria-label="Bookmark management">
    <header className={hideSearch ? 'bookmark-grid-heading' : 'bookmark-header'}>
      <h2 className={hideSearch ? 'sr-only' : undefined}>Bookmarks {!hideSearch && <span className="bookmark-count">{entries.length}</span>}</h2>
      {selectedItem && <div className="bookmark-scope"><span title={selectedItem.name}>{selectedItem.name}</span><button onClick={onClearItem} disabled={pending || !!editing}>All bookmarks</button></div>}
      {!hideSearch && <input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Filter bookmarks…" aria-label="Filter bookmarks" />}
      {!hideSearch && onNextMoment && <button className="next-bookmark" onClick={onNextMoment} disabled={!entries.length}>Next saved moment</button>}
    </header>
    {error && <p role="alert" className="bookmark-error">{error}</p>}
    <div className="bookmark-workspace">
      {hideSearch ? <div className="bookmark-grid-scroll song-table"><table className="bookmark-grid" aria-label="Bookmarks">
        <colgroup><col style={{ width: '22%' }} /><col style={{ width: '27%' }} /><col style={{ width: '17%' }} /><col style={{ width: 95 }} /><col style={{ width: 75 }} /><col style={{ width: 75 }} /><col style={{ width: 64 }} /></colgroup>
        <thead><tr>{([['label', 'Bookmark'], ['name', 'Recording'], ['artist', 'Artist'], ['position', 'Start'], ['end_position', 'End'], ['length', 'Length']] as const).map(([field, label]) =>
          <th key={field} aria-sort={sort?.field === field ? sort.desc ? 'descending' : 'ascending' : undefined}><button onClick={() => setSort({ field, desc: sort?.field === field && !sort.desc })}>{label}{sort?.field === field ? sort.desc ? ' ▾' : ' ▴' : ''}</button></th>)}<th aria-label="Bookmark actions" /></tr></thead>
        <tbody>{entries.map((entry, index) => <tr key={entryKey(entry)} data-bookmark-id={entry.bookmarkId} aria-selected={selection === entryKey(entry)} tabIndex={entry === tabStop ? 0 : -1}
          onClick={event => { if (!(event.target as HTMLElement).closest('button')) { setSelection(entryKey(entry)); event.currentTarget.focus(); } }}
          onDoubleClick={event => { if (!(event.target as HTMLElement).closest('button')) playEntry(entry); }}
          onKeyDown={event => {
            if (event.target !== event.currentTarget) return;
            if (event.key === 'F2' || (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'i') { event.preventDefault(); beginEdit(entry); }
            if (event.key === 'Enter') { event.preventDefault(); playEntry(entry); }
            if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
              event.preventDefault(); const next = entries[index + (event.key === 'ArrowUp' ? -1 : 1)];
              if (next) { setSelection(entryKey(next));
                const row = event.key === 'ArrowUp' ? event.currentTarget.previousElementSibling : event.currentTarget.nextElementSibling;
                if (row instanceof HTMLElement) { row.focus(); row.scrollIntoView({ block: 'nearest' }); } }
            }
          }}>
          <td title={entry.bookmark.label || undefined}>{entry.bookmark.emoji || '🔖'} <span>{entry.bookmark.label || 'Unlabelled bookmark'}</span></td>
          <td title={entry.item.name}>{entry.item.name}</td><td title={entry.item.artist}>{entry.item.artist}</td><td>{playButton(entry)}</td>
          <td>{entry.bookmark.end_position == null ? '—' : format(entry.bookmark.end_position)}</td>
          <td>{entry.bookmark.end_position == null ? '—' : format(entry.bookmark.end_position - entry.bookmark.position)}</td>
          <td className="bookmark-actions">{editButtons(entry)}</td>
        </tr>)}</tbody>
      </table>{!entries.length && <p className="bookmark-empty">{query ? 'No matching bookmarks' : 'No bookmarks yet'}</p>}</div>
        : !editing && <div className="bookmark-list">{!entries.length && <p className="bookmark-empty">{query ? 'No matching bookmarks' : 'No bookmarks yet'}</p>}
          {entries.map(entry => <div key={entryKey(entry)} className="bookmark-row"><div className="bookmark-main">
            <div className="bookmark-name"><span>{entry.bookmark.emoji || '🔖'}</span><span>{entry.bookmark.label || 'Unlabelled bookmark'}</span></div>
            {playButton(entry)}{editButtons(entry)}</div>{entry.bookmark.end_position != null && <div className="bookmark-track">Ends at {format(entry.bookmark.end_position)}</div>}
            {!selectedItem && <div className="bookmark-track">{[entry.item.name, entry.item.artist].filter(Boolean).join(' · ')}</div>}</div>)}
        </div>}
      {editing && <aside className="bookmark-inspector"><BookmarkEditor key={entryKey(editing)} entry={editing} onClose={closeEdit} onPlay={onPlay} getPlaybackTime={getPlaybackTime} /></aside>}
    </div>
  </section>;
}
