import type { AlbumTrack, LibraryItem, Tracklist } from '../types';
import { parseBookmarkPosition } from './bookmarks';

export function tracklistError(tracks: AlbumTrack[], duration: number | null): string | null {
  if (!tracks.length || tracks.length > 300) return 'Use between 1 and 300 tracks.';
  for (let i = 0; i < tracks.length; i++) {
    const track = tracks[i];
    if (!track.title.trim()) return `Track ${i + 1} needs a title.`;
    if (!Number.isFinite(track.start) || track.start < 0) return `Track ${i + 1} needs a valid start time.`;
    if (i && track.start <= tracks[i - 1].start) return 'Start times must increase down the list.';
    if (track.end !== null && (!Number.isFinite(track.end) || track.end <= track.start)) return `Track ${i + 1}: end must follow start.`;
    if (track.end !== null && tracks[i + 1] && track.end > tracks[i + 1].start) return `Track ${i + 1} overlaps the next track.`;
    if (duration !== null && (track.start >= duration || track.end !== null && track.end > duration)) return `Track ${i + 1} extends past this recording (${Math.round(duration)} seconds). Adjust its timing.`;
  }
  return null;
}

export function parseTracklist(text: string): AlbumTrack[] {
  const lines = text.trim().split('\n').filter(line => line.trim());
  const tracks = lines.map(line => {
    const match = line.trim().match(/^(\d+(?::[0-5]\d){0,2}(?:\.\d+)?)\s+(?:[-–—|]\s*)?(.+)$/);
    const start = match && parseBookmarkPosition(match[1]);
    if (!match || start === null) throw new Error('Use one track per line: 0:00 Track title');
    return { title: match[2].trim(), start, end: null } as AlbumTrack;
  });
  const error = tracklistError(tracks, null);
  if (error) throw new Error(error);
  return tracks;
}

export async function saveTracklist(item: LibraryItem, tracklist: Tracklist | null): Promise<LibraryItem> {
  const response = await fetch(`/api/items/${item.id}/tracklist`, { method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tracklist, expected: item.tracklist ?? null }) });
  if (!response.ok) throw new Error(await response.text() || 'Could not save the tracklist.');
  return response.json();
}
