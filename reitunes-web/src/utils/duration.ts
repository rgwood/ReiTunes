import type { LibraryItem } from '../types';

export function trackDuration(item: LibraryItem): number | null {
  const value = item.duration_seconds ?? item.tracklist?.duration;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

export function durationLabel(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return '—';
  const total = Math.round(seconds), minutes = Math.floor(total / 60);
  return `${minutes >= 60 ? `${Math.floor(minutes / 60)}:` : ''}${minutes >= 60 ? String(minutes % 60).padStart(2, '0') : minutes}:${String(total % 60).padStart(2, '0')}`;
}

export async function saveDuration(item: LibraryItem, seconds: number): Promise<void> {
  if (!Number.isFinite(seconds) || seconds <= 0 || Math.abs((item.duration_seconds ?? 0) - seconds) < 0.1) return;
  const response = await fetch(`/api/items/${encodeURIComponent(item.id)}/duration`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ duration_seconds: seconds, file_path: item.file_path }),
  });
  if (!response.ok) throw new Error('Could not save recording duration');
}

/** Human-readable total length, e.g. "3 hr 12 min"; null when no track has a known duration. */
export function totalDurationLabel(items: LibraryItem[]): string | null {
  const seconds = items.reduce((sum, item) => sum + (trackDuration(item) ?? 0), 0);
  if (seconds <= 0) return null;
  const minutes = Math.round(seconds / 60), hours = Math.floor(minutes / 60);
  if (hours === 0) return `${Math.max(minutes, 1)} min`;
  return minutes % 60 ? `${hours} hr ${minutes % 60} min` : `${hours} hr`;
}
