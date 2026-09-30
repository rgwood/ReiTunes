import { useEffect, useRef, useState } from 'react';
import { useQueueStore } from '../hooks/useQueue';
import type { LibraryItem } from '../types';
import { durationLabel, trackDuration } from '../utils/duration';
import { MusicIcon } from './MusicIcon';

export interface QueueSource { id: string; name: string; items: LibraryItem[] }

export function MobileQueue({ busy, onPlay, currentView, sources, currentItemId }: {
  busy: boolean;
  onPlay: (source: 'manual' | 'context', index: number, id: string) => void;
  currentView: { name: string; items: LibraryItem[] } | null;
  sources: QueueSource[];
  currentItemId?: string;
}) {
  const queue = useQueueStore();
  const [editing, setEditing] = useState(false);
  const [choosingSource, setChoosingSource] = useState(false);
  const [limit, setLimit] = useState(30);
  const dialog = useRef<HTMLDialogElement>(null);
  const changeSourceButton = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (choosingSource) dialog.current?.showModal(); }, [choosingSource]);
  const closeSource = () => { setChoosingSource(false); changeSourceButton.current?.focus(); };
  const upcoming = queue.getUpcomingContext();
  const count = queue.manualQueue.length + upcoming.length;
  const sourceName = ['All music', 'Library'].includes(queue.contextName) ? 'Your library' : queue.contextName;
  const choose = (source: { name: string; items: LibraryItem[] }) => {
    if (busy) return;
    queue.replaceUpcomingContext(source.items, source.name);
    setLimit(30); closeSource();
  };
  const playable = (source: { items: LibraryItem[] }) => source.items.some(item => item.id !== currentItemId);
  const row = (item: LibraryItem, index: number, source: 'manual' | 'context') => {
    const manual = source === 'manual';
    const number = index + 1 + (manual ? 0 : queue.manualQueue.length);
    const duration = trackDuration(item);
    return <li className="queue-row" key={manual ? queue.manualQueueIds[index] : item.id}>
      <button className="queue-track" disabled={busy} aria-label={`Play ${item.name} now`} onClick={() => onPlay(source, index, item.id)}>
        <span className="mobile-queue-number" aria-hidden="true">{number}</span>
        <span className="queue-track-text"><span>{item.name}</span><small>{item.artist || 'Unknown artist'}{duration !== null && ` · ${durationLabel(duration)}`}</small></span>
      </button>
      {manual && editing && <div className="queue-touch-reorder">
        <button disabled={busy || index === 0} aria-label={`Move ${item.name} up`} onClick={() => queue.moveManualQueueItem(index, index - 1)}>↑</button>
        <button disabled={busy || index === queue.manualQueue.length - 1} aria-label={`Move ${item.name} down`} onClick={() => queue.moveManualQueueItem(index, index + 1)}>↓</button>
      </div>}
      <button className="queue-remove" disabled={busy} aria-label={`Remove ${item.name} from Up Next`}
        onClick={() => manual ? queue.removeQueuedOccurrence(queue.manualQueueIds[index]) : queue.removeUpcomingContext(item.id)}><MusicIcon name="close" /></button>
    </li>;
  };
  return <section className="up-next mobile-queue" aria-label="Up Next">
    <header><div><h2>Up next</h2><p>{count ? `${count.toLocaleString()} ${count === 1 ? 'song' : 'songs'} coming up` : 'Choose what plays next'}</p></div></header>
    <div className="queue-scroll">
      {queue.repeatMode === 'one' && <p className="queue-note">Repeat one is on. Choose a song below to change songs.</p>}
      {!!queue.manualQueue.length && <section aria-label="Added to queue">
        <h3>Added by you<button aria-label={editing ? 'Done editing queue' : 'Edit queue'} aria-pressed={editing} onClick={() => setEditing(!editing)}>{editing ? 'Done' : 'Edit'}</button></h3>
        {editing && <button className="mobile-queue-clear" disabled={busy} onClick={queue.clearManualQueue}>Clear added songs</button>}
        <ol>{queue.manualQueue.map((item, index) => row(item, index, 'manual'))}</ol>
      </section>}
      <section aria-label={`From ${queue.contextName}`}>
        <div className="mobile-queue-source"><div><small>{queue.manualQueue.length ? 'Then continue with' : 'Playing from'}</small><strong>{sourceName}</strong>
          {queue.shuffleEnabled && <span>Shuffled</span>}</div>
          <button ref={changeSourceButton} disabled={busy} onClick={() => setChoosingSource(true)}>Change source</button>
        </div>
        <ol>{upcoming.slice(0, limit).map((item, index) => row(item, index, 'context'))}</ol>
        {upcoming.length > limit && <button className="queue-show-all" onClick={() => setLimit(value => value + 50)}>Show more songs</button>}
      </section>
      {!count && <div className="mobile-queue-empty"><MusicIcon name="queue" size={32} /><p>Your queue is clear.</p><small>Choose a source above, or add songs from Browse.</small></div>}
    </div>
    <div className="queue-feedback" role="status" aria-live="polite" aria-atomic="true">
      {queue.queueUndo && queue.canUndoQueueEdit() && <><span>{queue.queueUndo.message}</span><button disabled={busy} onClick={queue.undoQueueEdit}>Undo</button></>}
    </div>
    {choosingSource && <dialog ref={dialog} className="mobile-action-sheet" aria-label="Choose queue source"
      onCancel={event => { event.preventDefault(); closeSource(); }}>
      <header><div><h2>Continue with…</h2><p>Your current song and added songs stay put.</p></div><button aria-label="Close source picker" onClick={closeSource}><MusicIcon name="close" /></button></header>
      <div className="mobile-action-list">
        {currentView && <><p className="mobile-source-label">Last browsed</p><button disabled={busy || !playable(currentView)} onClick={() => choose(currentView)}><MusicIcon name="search" /><span>Use {currentView.name}</span></button></>}
        <p className="mobile-source-label">Library & playlists</p>
        {sources.map(source => <button key={source.id} disabled={busy || !playable(source)} onClick={() => choose(source)}>
          <MusicIcon name={source.id === 'library' ? 'music' : 'playlist'} /><span>{source.name}<small>{source.items.length.toLocaleString()} songs</small></span>
        </button>)}
      </div>
    </dialog>}
  </section>;
}
