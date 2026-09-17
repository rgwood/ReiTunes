import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { deleteBookmark, updateBookmark } from '../hooks/useLibrary';
import type { LibraryItem } from '../types';
import { bookmarkEntries, filterBookmarkEntries, formatBookmarkPosition } from '../utils/bookmarks';

interface BookmarkSidebarProps {
  items: LibraryItem[];
  selectedItem?: LibraryItem;
  onClearItem: () => void;
  onPlay: (item: LibraryItem, position: number) => void;
}

interface EditState {
  key: string;
  label: string;
  emoji: string;
}

export function BookmarkSidebar({ items, selectedItem, onClearItem, onPlay }: BookmarkSidebarProps) {
  const queryClient = useQueryClient();
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<EditState | null>(null);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const entries = useMemo(() => {
    const entries = bookmarkEntries(selectedItem ? [selectedItem] : items);
    if (selectedItem) entries.sort((a, b) => a.bookmark.position - b.bookmark.position);
    return filterBookmarkEntries(entries, query);
  }, [items, selectedItem, query]);

  const saveEdit = async (itemId: string, bookmarkId: string) => {
    if (!editing || pendingKey) return;
    setPendingKey(editing.key);
    setError(null);
    try {
      await updateBookmark(itemId, bookmarkId, editing.label, editing.emoji);
      await queryClient.invalidateQueries({ queryKey: ['library'] });
      setEditing(null);
    } catch {
      setError('Could not save the bookmark. Your changes are still here; try again.');
    } finally {
      setPendingKey(null);
    }
  };

  const removeBookmark = async (itemId: string, bookmarkId: string, label: string) => {
    if (pendingKey || !confirm(`Delete bookmark "${label}"?`)) return;
    setPendingKey(`${itemId}:${bookmarkId}`);
    setError(null);
    try {
      await deleteBookmark(itemId, bookmarkId);
      await queryClient.invalidateQueries({ queryKey: ['library'] });
    } catch {
      setError('Could not delete the bookmark.');
    } finally {
      setPendingKey(null);
    }
  };

  return (
    <section className="bookmark-sidebar" aria-label="Bookmark management">
      <header className="bookmark-header">
        <h2>Bookmarks <span className="bookmark-count">{entries.length}</span></h2>
        {selectedItem && (
          <div className="bookmark-scope">
            <span title={selectedItem.name}>{selectedItem.name}</span>
            <button type="button" onClick={onClearItem} disabled={pendingKey !== null}>All bookmarks</button>
          </div>
        )}
        <input type="search" value={query} onChange={event => setQuery(event.target.value)}
          placeholder="Filter bookmarks…" aria-label="Filter bookmarks" />
      </header>
      {error && <div role="alert" className="bookmark-error">{error}</div>}
      <div className="bookmark-list">
        {entries.length === 0 && <p className="bookmark-empty">{query ? 'No matching bookmarks' : 'No bookmarks yet'}</p>}
        {entries.map(({ item, bookmarkId, bookmark }) => {
          const key = `${item.id}:${bookmarkId}`;
          const isEditing = editing?.key === key;
          const displayLabel = bookmark.label || 'Unlabelled bookmark';
          const beginEdit = () => {
            setError(null);
            setEditing({ key, label: bookmark.label || '', emoji: bookmark.emoji || '🔖' });
          };
          return (
            <div key={key} className="bookmark-row">
              {isEditing ? (
                <form className="bookmark-editor" onSubmit={event => {
                  event.preventDefault();
                  void saveEdit(item.id, bookmarkId);
                }} onKeyDown={event => {
                  if (event.key === 'Escape') {
                    event.stopPropagation();
                    if (!pendingKey) { setEditing(null); setError(null); }
                  }
                }}>
                  <input className="bookmark-emoji-input" value={editing.emoji} disabled={pendingKey !== null}
                    onChange={event => setEditing({ ...editing, emoji: event.target.value })}
                    aria-label={`Bookmark emoji for ${item.name}`} />
                  <input className="bookmark-label-input" value={editing.label} disabled={pendingKey !== null}
                    onChange={event => setEditing({ ...editing, label: event.target.value })}
                    aria-label={`Bookmark label for ${item.name}`} placeholder="Add a name…"
                    autoFocus onFocus={event => event.target.select()} />
                  <button type="submit" disabled={pendingKey !== null} title="Save (Enter)" aria-label="Save bookmark">✓</button>
                  <button type="button" disabled={pendingKey !== null} title="Cancel (Escape)" aria-label="Cancel editing bookmark"
                    onClick={() => { setEditing(null); setError(null); }}>×</button>
                </form>
              ) : (
                <div className="bookmark-main">
                  <button type="button" className="bookmark-name" onClick={() => onPlay(item, bookmark.position)}
                    aria-label={`Play ${item.name} from ${displayLabel}`} title={`Play from ${formatBookmarkPosition(bookmark.position)}`}>
                    <span aria-hidden="true">{bookmark.emoji || '🔖'}</span>
                    <span>{displayLabel}</span>
                    <span className="bookmark-position">{formatBookmarkPosition(bookmark.position)}</span>
                  </button>
                  <button type="button" className="bookmark-rename" onClick={beginEdit} disabled={pendingKey !== null}
                    aria-label={`Rename ${displayLabel} for ${item.name}`} title="Rename bookmark">✎</button>
                  <button type="button" className="bookmark-delete" disabled={pendingKey !== null}
                    onClick={() => void removeBookmark(item.id, bookmarkId, displayLabel)}
                    aria-label={`Delete bookmark for ${item.name}`} title="Delete bookmark">×</button>
                </div>
              )}
              {(!selectedItem || isEditing) && <div className="bookmark-track" title={[item.name, item.artist].filter(Boolean).join(' · ')}>
                {selectedItem ? formatBookmarkPosition(bookmark.position) : [item.name, item.artist].filter(Boolean).join(' · ')}
              </div>}
            </div>
          );
        })}
      </div>
    </section>
  );
}
