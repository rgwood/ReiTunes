import { useState } from 'react';
import type { LibraryItem } from '../types';
import { formatBookmarkPosition as format } from '../utils/bookmarks';
import { usePlayback } from '../hooks/usePlayback';
import './Tracklist.css';

export function AlbumTrackRows({ item, columns, onEdit, onPlayContext }: {
  item: LibraryItem; columns: number; onEdit: () => void; onPlayContext: () => void;
}) {
  const [selected, setSelected] = useState<number | null>(null);
  const play = usePlayback();
  const list = item.tracklist;
  if (!list) return null;
  function start(index: number) { onPlayContext(); void play(item, list!.tracks[index].start, 'album-track'); }
  return <tr className="album-tracklist"><td colSpan={columns}><div>
    <header><span>{list.tracks.length} tracks · {list.timing === 'estimated' ? 'Estimated timings' : 'Tracklist'}</span>
      <button type="button" onClick={onEdit}>Edit tracklist…</button></header>
    <ol role="listbox" aria-label={`Tracks within ${item.name}`}>
      {list.tracks.map((track, index) => {
        const end = track.end ?? list.tracks[index + 1]?.start ?? list.duration;
        return <li key={index} role="option" aria-selected={selected === index} tabIndex={selected === index || selected === null && index === 0 ? 0 : -1}
          onClick={e => { setSelected(index); e.currentTarget.focus(); }}
          onDoubleClick={() => start(index)}
          onKeyDown={e => {
            if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) { e.preventDefault(); e.stopPropagation(); start(index); }
            if (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'Home' || e.key === 'End') {
              e.preventDefault(); e.stopPropagation();
              const next = e.key === 'Home' ? 0 : e.key === 'End' ? list.tracks.length - 1 : Math.max(0, Math.min(list.tracks.length - 1, index + (e.key === 'ArrowUp' ? -1 : 1)));
              setSelected(next); (e.currentTarget.parentElement?.children[next] as HTMLElement)?.focus();
            }
          }}><span>{index + 1}</span><span title={track.title}>{track.title}</span><time title="Start">{format(track.start)}</time><time title="Length">{end == null ? '—' : format(end - track.start)}</time></li>;
      })}
    </ol>
  </div></td></tr>;
}
