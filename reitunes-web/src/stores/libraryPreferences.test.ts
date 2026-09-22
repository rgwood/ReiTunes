import { describe, expect, it } from 'vitest';
import { fitColumnWidths, normalizeColumns } from './libraryPreferences';

describe('saved library columns', () => {
  it('repairs stale or malformed preferences and always keeps Name', () => {
    const result = normalizeColumns({ columnOrder: ['album', 'gone', 'album'],
      columnVisibility: { name: false, album: false }, columnWidths: { name: -1, artist: Infinity, album: 99999, is_favorite: 100 } });
    expect(result.columnOrder.slice(0, 3)).toEqual(['album', 'is_favorite', 'name']);
    expect(new Set(result.columnOrder).size).toBe(9);
    expect(result.columnVisibility.name).toBe(true);
    expect(result.columnVisibility.album).toBe(false);
    expect(result.columnWidths).toEqual({ name: 100, album: 10000 });
  });
  it('preserves the old details option', () => {
    expect(normalizeColumns({ showDetails: true }).columnVisibility).toMatchObject({ track_number: true, created_time_utc: true });
  });
  it('uses spare width, respects resized columns, and overflows rather than crushing cells', () => {
    const { columnOrder, columnVisibility } = normalizeColumns(null);
    const widths = fitColumnWidths(columnOrder, columnVisibility, { name: 450 }, 1200);
    expect(widths.name).toBe(450);
    expect(Object.values(widths).reduce((a, b) => a + b, 0)).toBeCloseTo(1200);
    const narrow = fitColumnWidths(columnOrder, columnVisibility, { name: 450 }, 300);
    expect(narrow).toEqual({ is_favorite: 28, name: 450, artist: 70, album: 70, bookmarks: 70, play_count: 45, tags: 100 });
    expect(fitColumnWidths(['name'], {}, {}, 800)).toEqual({ name: 800 });
  });
});
