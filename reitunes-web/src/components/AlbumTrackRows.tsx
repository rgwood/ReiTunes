import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { LibraryItem } from '../types';
import { formatBookmarkPosition as format } from '../utils/bookmarks';
import { usePlayback } from '../hooks/usePlayback';
import { saveTracklist } from '../utils/tracklists';
import { usePlayerStore } from '../stores/playerStore';
import './Tracklist.css';

export function AlbumTrackRows({ item, columns, onEdit, onPlayContext, onlyFavourites = false }: {
  item: LibraryItem; columns: number; onEdit: () => void; onPlayContext: () => void; onlyFavourites?: boolean;
}) {
  const [selected, setSelected] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const busy = useRef(false);
  const [error, setError] = useState('');
  const queryClient = useQueryClient();
  const play = usePlayback();
  const list = item.tracklist;
  if (!list) return null;
  const visible = list.tracks.map((track, index) => ({ track, index })).filter(({ track }) => !onlyFavourites || track.is_favorite);
  function start(index: number) {
    const track = list!.tracks[index];
    onPlayContext(); void play(item, track.start, 'album-track', onlyFavourites ? {
      start: track.start, end: track.end ?? list!.tracks[index + 1]?.start ?? list!.duration, afterEnd: 'pause',
    } : undefined);
  }
  async function favourite(index: number) {
    if (busy.current) return;
    busy.current = true; setSaving(true); setError('');
    try {
      const updated = await saveTracklist(item, { ...list!, tracks: list!.tracks.map((track, i) => i === index ? { ...track, is_favorite: !track.is_favorite } : track) });
      queryClient.setQueryData<LibraryItem[]>(['library'], old => old?.map(i => i.id === item.id ? updated : i));
      if (usePlayerStore.getState().currentItemId === item.id) usePlayerStore.getState().refreshCurrentItem(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save this favourite. Try again.');
      void queryClient.invalidateQueries({ queryKey: ['library'] });
    } finally { busy.current = false; setSaving(false); }
  }
  return <tr className="album-tracklist"><td colSpan={columns}><div>
    <header><span>{visible.length} {onlyFavourites ? 'favourite ' : ''}{visible.length === 1 ? 'track' : 'tracks'} · {list.timing === 'estimated' ? 'Estimated timings' : 'Tracklist'}</span>
      <button type="button" onClick={onEdit}>Edit tracklist…</button></header>
    {error && <p role="alert" className="album-track-error">{error}</p>}
    <div role="grid" aria-label={`Tracks within ${item.name}`}>
      {visible.map(({ track, index }, visibleIndex) => {
        const end = track.end ?? list.tracks[index + 1]?.start ?? list.duration;
        return <div key={index} role="row" aria-selected={selected === index} tabIndex={selected === index || !visible.some(t => t.index === selected) && visibleIndex === 0 ? 0 : -1}
          onClick={e => { setSelected(index); e.currentTarget.focus(); }}
          onDoubleClick={() => start(index)}
          onKeyDown={e => {
            if (e.target !== e.currentTarget) return;
            if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) { e.preventDefault(); e.stopPropagation(); start(index); }
            if (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'Home' || e.key === 'End') {
              e.preventDefault(); e.stopPropagation();
              const next = e.key === 'Home' ? 0 : e.key === 'End' ? visible.length - 1 : Math.max(0, Math.min(visible.length - 1, visibleIndex + (e.key === 'ArrowUp' ? -1 : 1)));
              setSelected(visible[next].index); (e.currentTarget.parentElement?.children[next] as HTMLElement)?.focus();
            }
          }}><span role="gridcell"><button type="button" className="album-track-heart" aria-pressed={!!track.is_favorite} disabled={saving}
            aria-label={track.is_favorite ? `Remove ${track.title} from favourites` : `Favourite ${track.title}`}
            title={track.is_favorite ? 'Remove from favourites' : 'Add to favourites'}
            onClick={e => { e.stopPropagation(); void favourite(index); }} onDoubleClick={e => e.stopPropagation()}
            onKeyDown={e => e.stopPropagation()}>{track.is_favorite ? '♥' : '♡'}</button></span>
          <span role="gridcell">{index + 1}</span><span role="gridcell" title={track.title}>{track.title}</span><time role="gridcell" title="Start">{format(track.start)}</time><time role="gridcell" title="Length">{end == null ? '—' : format(end - track.start)}</time></div>;
      })}
    </div>
  </div></td></tr>;
}
