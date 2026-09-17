import { useCallback, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { defaultRangeExtractor, useVirtualizer, type Range } from '@tanstack/react-virtual';

// Match the compact grid's row/header heights in App.css. Cells never wrap.
export const LIBRARY_ROW_HEIGHT = 23;
export const LIBRARY_HEADER_HEIGHT = 24;

export function useLibraryViewport({ rows, scrollRef, filterKey, sorting, editingId, revealRequest, onRevealed }: {
  rows: { id: string }[];
  scrollRef: RefObject<HTMLDivElement | null>;
  filterKey: string;
  sorting: unknown;
  editingId?: string;
  revealRequest?: { itemId: string } | null;
  onRevealed?: () => void;
}) {
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const pendingFocus = useRef<{ id: string; lastControl: boolean } | null>(null);
  const indexById = useMemo(() => new Map(rows.map((row, index) => [row.id, index])), [rows]);
  const focusedIndex = focusedId ? indexById.get(focusedId) : undefined;
  const editingIndex = editingId ? indexById.get(editingId) : undefined;
  const rangeExtractor = useCallback((range: Range) => {
    const indexes = new Set(defaultRangeExtractor(range));
    // Scrolling must not destroy keyboard focus or an unsaved inline edit.
    if (focusedIndex !== undefined) indexes.add(focusedIndex);
    if (editingIndex !== undefined) indexes.add(editingIndex);
    return [...indexes].sort((a, b) => a - b);
  }, [focusedIndex, editingIndex]);
  const getItemKey = useCallback((index: number) => rows[index].id, [rows]);
  // eslint-disable-next-line react-hooks/incompatible-library -- The table explicitly opts out of compiler memoization.
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => LIBRARY_ROW_HEIGHT,
    getItemKey,
    overscan: 8,
    scrollMargin: LIBRARY_HEADER_HEIGHT,
    scrollPaddingStart: LIBRARY_HEADER_HEIGHT,
    rangeExtractor,
  });

  useLayoutEffect(() => {
    virtualizer.scrollToOffset(0);
  }, [filterKey, sorting, virtualizer]);

  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const mountedRow = (id: string) => Array.from(scroller.querySelectorAll<HTMLTableRowElement>('tr[data-item-id]')).find(row => row.dataset.itemId === id);
    if (pendingFocus.current) {
      const row = mountedRow(pendingFocus.current.id);
      if (row) {
        const controls = row.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)');
        const target = pendingFocus.current.lastControl ? controls[controls.length - 1] || row : row;
        pendingFocus.current = null;
        target.focus({ preventScroll: true });
      }
    }
    if (!revealRequest) return;
    const index = indexById.get(revealRequest.itemId);
    if (index === undefined) return; // Deferred search may not have exposed it yet.
    const row = mountedRow(revealRequest.itemId);
    const bounds = scroller.getBoundingClientRect();
    const rowBounds = row?.getBoundingClientRect();
    if (!rowBounds || rowBounds.top < bounds.top + LIBRARY_HEADER_HEIGHT || rowBounds.bottom > bounds.bottom) {
      virtualizer.scrollToIndex(index, { align: 'center' });
    } else onRevealed?.();
  });

  const focusRow = (index: number, lastControl = false) => {
    const row = rows[Math.max(0, Math.min(index, rows.length - 1))];
    if (!row) return;
    pendingFocus.current = { id: row.id, lastControl };
    setFocusedId(row.id);
    virtualizer.scrollToIndex(indexById.get(row.id)!, { align: 'auto' });
  };
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    const row = target.closest<HTMLTableRowElement>('tr[data-item-id]');
    if (!row) return;
    const index = indexById.get(row.dataset.itemId!);
    if (index === undefined) return;
    if (target === row) {
      const page = Math.max(1, Math.floor((scrollRef.current?.clientHeight || 300) / LIBRARY_ROW_HEIGHT) - 1);
      const next = ({ ArrowDown: index + 1, ArrowUp: index - 1, PageDown: index + page, PageUp: index - page, Home: 0, End: rows.length - 1 } as Record<string, number>)[event.key];
      if (next !== undefined) { event.preventDefault(); focusRow(next); return; }
    }
    if (event.key === 'Tab') {
      const controls = row.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)');
      const next = event.shiftKey ? index - 1 : index + 1;
      const atEdge = event.shiftKey ? target === row : target === controls[controls.length - 1];
      if (atEdge && rows[next] && !Array.from(event.currentTarget.querySelectorAll<HTMLElement>('tr[data-item-id]')).some(element => element.dataset.itemId === rows[next].id)) {
        event.preventDefault(); focusRow(next, event.shiftKey);
      }
    }
  };
  return {
    virtualRows: virtualizer.getVirtualItems(),
    totalHeight: virtualizer.getTotalSize(),
    onKeyDown,
    onFocusCapture: (event: React.FocusEvent<HTMLDivElement>) => setFocusedId((event.target as HTMLElement).closest<HTMLElement>('tr[data-item-id]')?.dataset.itemId || null),
    onBlurCapture: (event: React.FocusEvent<HTMLDivElement>) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocusedId(null);
    },
  };
}
