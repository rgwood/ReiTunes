import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type GridDensity = 'compact' | 'comfortable';
export const maxColumnWidth = 10000;

export const libraryColumns = [
  { id: 'is_favorite', label: 'Favourite', width: 28, min: 28 },
  { id: 'name', label: 'Name', width: 220, min: 100 },
  { id: 'artist', label: 'Artist', width: 140, min: 70 },
  { id: 'album', label: 'Album', width: 140, min: 70 },
  { id: 'bookmarks', label: 'Bookmarks', width: 100, min: 70 },
  { id: 'play_count', label: 'Plays', width: 50, min: 45 },
  { id: 'tags', label: 'Tags', width: 160, min: 100 },
  { id: 'track_number', label: 'Track number', width: 40, min: 40 },
  { id: 'created_time_utc', label: 'Date added', width: 130, min: 100 },
] as const;
export type LibraryColumnId = typeof libraryColumns[number]['id'];
const defaultOrder = libraryColumns.map(column => column.id);
const defaultVisibility: Record<string, boolean> = { track_number: false, created_time_utc: false };

export function normalizeColumns(value: unknown) {
  const saved = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const columnOrder = [...new Set([
    ...(Array.isArray(saved.columnOrder) ? saved.columnOrder.filter((id): id is LibraryColumnId => defaultOrder.includes(id)) : []),
    ...defaultOrder,
  ])];
  const columnVisibility = { ...defaultVisibility };
  const columnWidths: Record<string, number> = {};
  for (const column of libraryColumns) {
    const visible = (saved.columnVisibility as Record<string, unknown> | undefined)?.[column.id];
    if (typeof visible === 'boolean') columnVisibility[column.id] = visible;
    const width = (saved.columnWidths as Record<string, unknown> | undefined)?.[column.id];
    if (typeof width === 'number' && Number.isFinite(width) && column.id !== 'is_favorite') {
      columnWidths[column.id] = Math.max(column.min, Math.min(maxColumnWidth, width));
    }
  }
  if (saved.showDetails === true && !saved.columnVisibility) {
    columnVisibility.track_number = columnVisibility.created_time_utc = true;
  }
  columnVisibility.name = true;
  return { columnOrder, columnVisibility, columnWidths };
}

// Explicit widths stay in pixels; untouched columns share the remaining space.
export function fitColumnWidths(order: string[], visibility: Record<string, boolean>, widths: Record<string, number>, available: number) {
  const columns = order.map(id => libraryColumns.find(column => column.id === id)!).filter(column => column && visibility[column.id] !== false);
  let remaining = available;
  const result: Record<string, number> = {};
  let flexible = columns.filter(column => {
    const fixed = column.id === 'is_favorite' ? 28 : widths[column.id];
    if (fixed !== undefined) { result[column.id] = fixed; remaining -= fixed; return false; }
    return true;
  });
  while (flexible.length) {
    const weight = flexible.reduce((sum, column) => sum + column.width, 0);
    const constrained = flexible.filter(column => remaining * column.width / weight < column.min);
    if (!constrained.length) {
      for (const column of flexible) result[column.id] = remaining * column.width / weight;
      break;
    }
    for (const column of constrained) { result[column.id] = column.min; remaining -= column.min; }
    flexible = flexible.filter(column => !constrained.includes(column));
  }
  return result;
}

export const useLibraryPreferences = create<{
  density: GridDensity;
  columnOrder: LibraryColumnId[];
  columnVisibility: Record<string, boolean>;
  columnWidths: Record<string, number>;
  setColumnVisible: (id: LibraryColumnId, visible: boolean) => void;
  moveColumn: (id: LibraryColumnId, target: LibraryColumnId) => void;
  resizeColumn: (id: string, width?: number) => void;
  resetColumns: () => void;
  setDensity: (density: GridDensity) => void;
}>()(persist(set => ({
  density: 'compact',
  ...normalizeColumns(null),
  setColumnVisible: (id, visible) => set(state => ({ columnVisibility: { ...state.columnVisibility, [id]: id === 'name' || visible } })),
  moveColumn: (id, target) => set(state => {
    const columnOrder = [...state.columnOrder];
    const from = columnOrder.indexOf(id), to = columnOrder.indexOf(target);
    if (from < 0 || to < 0) return {};
    columnOrder.splice(from, 1); columnOrder.splice(to, 0, id);
    return { columnOrder };
  }),
  resizeColumn: (id, width) => set(state => {
    const columnWidths = { ...state.columnWidths };
    if (width === undefined) delete columnWidths[id];
    else columnWidths[id] = width;
    return { columnWidths: normalizeColumns({ columnWidths }).columnWidths };
  }),
  resetColumns: () => set(normalizeColumns(null)),
  setDensity: density => set({ density }),
}), {
  name: 'reitunes-library-preferences',
  partialize: ({ density, columnOrder, columnVisibility, columnWidths }) => ({ density, columnOrder, columnVisibility, columnWidths }),
  merge: (persisted, current) => ({ ...current, ...normalizeColumns(persisted),
    density: (persisted as { density?: unknown })?.density === 'comfortable' ? 'comfortable' : 'compact' }),
}));
