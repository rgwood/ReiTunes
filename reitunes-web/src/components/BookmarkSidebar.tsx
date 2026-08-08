import { useMemo, useState } from 'react';
import { deleteBookmark, updateBookmark } from '../hooks/useLibrary';
import type { LibraryItem } from '../types';
import {
  bookmarkEntries,
  filterBookmarkEntries,
  formatBookmarkPosition,
} from '../utils/bookmarks';

interface BookmarkSidebarProps {
  items: LibraryItem[];
  onPlay: (item: LibraryItem, position: number) => void;
}

interface EditState {
  bookmarkId: string;
  label: string;
  emoji: string;
}

export function BookmarkSidebar({ items, onPlay }: BookmarkSidebarProps) {
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<EditState | null>(null);
  const [pendingBookmarkId, setPendingBookmarkId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const entries = useMemo(
    () => filterBookmarkEntries(bookmarkEntries(items), query),
    [items, query]
  );

  const saveEdit = async (itemId: string) => {
    if (!editing) return;
    setPendingBookmarkId(editing.bookmarkId);
    setError(null);
    try {
      await updateBookmark(itemId, editing.bookmarkId, editing.label, editing.emoji);
      setEditing(null);
    } catch {
      setError('Could not save the bookmark.');
    } finally {
      setPendingBookmarkId(null);
    }
  };

  const removeBookmark = async (itemId: string, bookmarkId: string, label: string) => {
    if (!confirm(`Delete bookmark "${label}"?`)) return;
    setPendingBookmarkId(bookmarkId);
    setError(null);
    try {
      await deleteBookmark(itemId, bookmarkId);
    } catch {
      setError('Could not delete the bookmark.');
    } finally {
      setPendingBookmarkId(null);
    }
  };

  return (
    <aside className="w-72 flex-shrink-0 bg-solarized-base03 border-r border-solarized-base02 flex flex-col h-full">
      <div className="p-3 border-b border-solarized-base02">
        <h2 className="text-sm font-semibold text-solarized-base1 uppercase tracking-wide">
          Bookmarks
        </h2>
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Filter bookmarks..."
          aria-label="Filter bookmarks"
          className="mt-2 w-full px-2 py-1 bg-solarized-base03 text-solarized-base1 border border-solarized-base01 focus:border-solarized-blue outline-none text-sm"
        />
      </div>

      {error && (
        <div role="alert" className="px-3 py-2 text-xs text-solarized-red border-b border-solarized-base02">
          {error}
        </div>
      )}

      <div className="flex-grow overflow-y-auto">
        {entries.length === 0 ? (
          <div className="px-3 py-4 text-solarized-base0 text-sm italic">
            {query ? 'No matching bookmarks' : 'No bookmarks yet'}
          </div>
        ) : (
          entries.map(({ item, bookmarkId, bookmark }) => {
            const isEditing = editing?.bookmarkId === bookmarkId;
            const isPending = pendingBookmarkId === bookmarkId;
            const displayLabel = bookmark.label || 'Unlabelled bookmark';

            return (
              <div
                key={`${item.id}:${bookmarkId}`}
                className="group px-3 py-2 border-b border-solarized-base02 hover:bg-solarized-base02"
              >
                {isEditing ? (
                  <form
                    className="space-y-2"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void saveEdit(item.id);
                    }}
                  >
                    <div className="flex gap-1">
                      <input
                        value={editing.emoji}
                        onChange={(event) =>
                          setEditing({ ...editing, emoji: event.target.value })
                        }
                        aria-label={`Bookmark emoji for ${item.name}`}
                        className="w-10 px-1 py-1 bg-solarized-base03 border border-solarized-blue text-center"
                      />
                      <input
                        value={editing.label}
                        onChange={(event) =>
                          setEditing({ ...editing, label: event.target.value })
                        }
                        aria-label={`Bookmark label for ${item.name}`}
                        placeholder="Add a label..."
                        autoFocus
                        className="min-w-0 flex-grow px-2 py-1 bg-solarized-base03 border border-solarized-blue text-sm"
                      />
                    </div>
                    <div className="flex justify-end gap-2 text-xs">
                      <button
                        type="button"
                        onClick={() => setEditing(null)}
                        className="text-solarized-base0 hover:text-solarized-base1"
                      >
                        Cancel
                      </button>
                      <button
                        type="submit"
                        disabled={isPending}
                        className="text-solarized-cyan hover:text-solarized-green disabled:opacity-50"
                      >
                        Save
                      </button>
                    </div>
                  </form>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={() => onPlay(item, bookmark.position)}
                      className="w-full text-left"
                      aria-label={`Play ${item.name} from ${displayLabel}`}
                    >
                      <div className="flex items-start gap-2">
                        <span aria-hidden="true">{bookmark.emoji || '🔖'}</span>
                        <div className="min-w-0 flex-grow">
                          <div className="truncate text-sm text-solarized-base1">
                            {displayLabel}
                          </div>
                          <div className="truncate text-xs text-solarized-blue">{item.name}</div>
                          <div className="truncate text-xs text-solarized-base0">
                            {[item.artist, formatBookmarkPosition(bookmark.position)]
                              .filter(Boolean)
                              .join(' · ')}
                          </div>
                        </div>
                      </div>
                    </button>
                    <div className="mt-1 flex justify-end gap-2 text-xs opacity-0 group-hover:opacity-100 focus-within:opacity-100">
                      <button
                        type="button"
                        onClick={() =>
                          setEditing({
                            bookmarkId,
                            label: bookmark.label || '',
                            emoji: bookmark.emoji || '🔖',
                          })
                        }
                        className="text-solarized-base0 hover:text-solarized-cyan"
                        aria-label={`Edit bookmark for ${item.name}`}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        disabled={isPending}
                        onClick={() => void removeBookmark(item.id, bookmarkId, displayLabel)}
                        className="text-solarized-base0 hover:text-solarized-red disabled:opacity-50"
                        aria-label={`Delete bookmark for ${item.name}`}
                      >
                        Delete
                      </button>
                    </div>
                  </>
                )}
              </div>
            );
          })
        )}
      </div>
    </aside>
  );
}
