import { useState, type HTMLAttributes } from 'react';
import { DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useQueueStore } from '../hooks/useQueue';
import { usePlayerStore } from '../stores/playerStore';
import { usePlaybackTargetStore } from '../stores/playbackTargetStore';
import { usePlayback } from '../hooks/usePlayback';
import type { LibraryItem } from '../types';
import { MobileQueue, type QueueSource } from './MobileQueue';
import './QueuePanel.css';

function TrackButton({ item, onPlay, disabled }: { item: LibraryItem; onPlay: () => void; disabled: boolean }) {
  return <button className="queue-track" onClick={onPlay} disabled={disabled} aria-label={`Play ${item.name} now`} title={`Play ${item.name} now`}>
    <span className="queue-play" aria-hidden="true">▶</span>
    <span className="queue-track-text"><span>{item.name}</span><small>{item.artist || 'Unknown artist'}</small></span>
  </button>;
}

function QueuedTrack({ item, entryId, onPlay, disabled }: { item: LibraryItem; entryId: string; onPlay: () => void; disabled: boolean }) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: entryId, disabled });
  const remove = useQueueStore(state => state.removeQueuedOccurrence);
  return <li ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }} className="queue-row">
    <button className="queue-drag" {...attributes} {...listeners} aria-label={`Reorder ${item.name}`} disabled={disabled} title="Drag to reorder; Space and arrow keys also work">⠿</button>
    <TrackButton item={item} onPlay={onPlay} disabled={disabled} />
    <button className="queue-remove" onClick={() => remove(entryId)} disabled={disabled} aria-label={`Remove ${item.name} from Up Next`} title="Remove from Up Next">×</button>
  </li>;
}

export function QueuePanel({ dropActive, dropProps, mobile = false, disabled = false, currentView = null, mobileSources = [] }: {
  dropActive: boolean;
  dropProps: Pick<HTMLAttributes<HTMLElement>, 'onDragEnter' | 'onDragOver' | 'onDragLeave' | 'onDrop'>;
  mobile?: boolean;
  disabled?: boolean;
  currentView?: { name: string; items: LibraryItem[] } | null;
  mobileSources?: QueueSource[];
}) {
  const queue = useQueueStore();
  const { currentItem } = usePlayerStore();
  const target = usePlaybackTargetStore();
  const play = usePlayback();
  const [pending, setPending] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const busy = disabled || pending || target.isSending || target.isSwitchingOutput || target.isTransportPending;
  const upcoming = queue.getUpcomingContext();
  const viewHasUpcoming = currentView?.items.some(item => item.id !== currentItem?.id) ?? false;
  const manualIds = queue.manualQueue.map((_, index) => queue.manualQueueIds[index] ?? `manual-${index}`);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));

  async function playNow(source: 'manual' | 'context', index: number, id: string) {
    if (busy) return;
    const before = useQueueStore.getState();
    const item = source === 'manual' ? before.takeQueuedItem(index) : before.chooseContextItem(id);
    if (!item) return;
    const after = useQueueStore.getState();
    setPending(true);
    const started = await play(item, 0, 'up-next');
    if (!started) {
      const current = useQueueStore.getState();
      // Another controller can replace the source while this play request is
      // pending. A failed request must not restore a cursor in that new source.
      const sameContext = current.contextId === after.contextId && current.contextName === after.contextName &&
        current.contextItems.length === after.contextItems.length &&
        current.contextItems.every((item, index) => item.id === after.contextItems[index].id);
      if (sameContext && source === 'manual' && current.manualQueueIds.length === after.manualQueueIds.length &&
        current.manualQueueIds.every((id, index) => id === after.manualQueueIds[index])) {
        useQueueStore.setState({ manualQueue: before.manualQueue, manualQueueIds: before.manualQueueIds });
      }
      if (sameContext && source === 'context' && current.contextIndex === after.contextIndex) useQueueStore.setState({ contextIndex: before.contextIndex });
    }
    setPending(false);
  }

  if (mobile) return <MobileQueue busy={busy} onPlay={(...args) => void playNow(...args)} currentView={currentView}
    sources={mobileSources} currentItemId={currentItem?.id} />;

  return <section className={`up-next${dropActive ? ' drop-target' : ''}`} aria-label="Up Next" {...dropProps}>
    <header><h2>{dropActive ? 'Drop to add to queue' : 'Up Next'}</h2></header>
    <div className="queue-scroll">
      {currentItem && <section aria-label="Now playing"><h3>Now playing</h3>
        <div className="queue-current"><span aria-hidden="true">▶</span><span className="queue-track-text"><span>{currentItem.name}</span><small>{currentItem.artist}</small></span></div>
      </section>}
      {queue.repeatMode === 'one' && <p className="queue-note">Repeat one is on. Choose a track below to change songs.</p>}
      {!!queue.manualQueue.length && <section aria-label="Added to queue">
        <h3>Added by you <span>{queue.manualQueue.length}</span><button onClick={queue.clearManualQueue} disabled={busy}>Clear</button></h3>
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={({ active, over }) => {
          if (busy || !over || active.id === over.id) return;
          const from = manualIds.indexOf(String(active.id));
          const to = manualIds.indexOf(String(over.id));
          if (from >= 0 && to >= 0) queue.moveManualQueueItem(from, to);
        }}>
          <SortableContext items={manualIds} strategy={verticalListSortingStrategy}>
            <ol>{queue.manualQueue.map((item, index) => <QueuedTrack key={manualIds[index]} entryId={manualIds[index]} item={item} disabled={busy}
              onPlay={() => void playNow('manual', index, item.id)} />)}</ol>
          </SortableContext>
        </DndContext>
      </section>}
      <section aria-label={`From ${queue.contextName}`}>
        <h3>{queue.shuffleEnabled ? 'Shuffle from' : 'Then from'} {queue.contextName}<span>{upcoming.length}</span></h3>
        <div className="queue-source-picker">
          <button className="queue-use-view" disabled={busy || !viewHasUpcoming}
            title="Replace the automatic sequence. Keep the current song and Added by you."
            onClick={() => {
              if (!busy && currentView && viewHasUpcoming) {
                queue.replaceUpcomingContext(currentView.items, currentView.name);
                setShowAll(false);
              }
            }}>Use current view</button>
          <p>{currentView ? `${currentView.name} · ${currentView.items.length.toLocaleString()} ${currentView.items.length === 1 ? 'track' : 'tracks'}`
            : 'Open a playlist or your library to choose a source.'}</p>
        </div>
        {queue.shuffleEnabled && !!upcoming.length && <p className="queue-note">Tracks play in this shuffled order.</p>}
        <ol>{(showAll ? upcoming : upcoming.slice(0, 30)).map((item, index) => <li className="queue-row" key={`${index}-${item.id}`}>
          <TrackButton item={item} onPlay={() => void playNow('context', index, item.id)} disabled={busy} />
          <button className="queue-remove" onClick={() => queue.removeUpcomingContext(item.id)} disabled={busy}
            aria-label={`Remove ${item.name} from Up Next`} title="Remove from Up Next">×</button>
        </li>)}</ol>
        {!showAll && upcoming.length > 30 && <button className="queue-show-all" onClick={() => setShowAll(true)}>Show all {upcoming.length} tracks</button>}
      </section>
      {!upcoming.length && !queue.manualQueue.length && <p className="queue-note">{currentItem ? 'Nothing else queued.' : 'Nothing queued yet.'} Drag songs here, or use Play Next or Add to Queue.</p>}
    </div>
    <div className="queue-feedback" role="status" aria-live="polite" aria-atomic="true">
      {queue.queueUndo && queue.canUndoQueueEdit() && <><span>{queue.queueUndo.message}</span><button disabled={busy} onClick={queue.undoQueueEdit}>Undo</button></>}
    </div>
  </section>;
}
