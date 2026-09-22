import { useState } from 'react';
import { DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useQueueStore } from '../hooks/useQueue';
import { usePlayerStore } from '../stores/playerStore';
import { usePlaybackTargetStore } from '../stores/playbackTargetStore';
import { usePlayback } from '../hooks/usePlayback';
import type { LibraryItem } from '../types';
import './QueuePanel.css';

function TrackButton({ item, onPlay, disabled }: { item: LibraryItem; onPlay: () => void; disabled: boolean }) {
  return <button className="queue-track" onClick={onPlay} disabled={disabled} aria-label={`Play ${item.name} now`} title={`Play ${item.name} now`}>
    <span className="queue-play" aria-hidden="true">▶</span>
    <span className="queue-track-text"><span>{item.name}</span><small>{item.artist || 'Unknown artist'}</small></span>
  </button>;
}

function QueuedTrack({ item, index, onPlay, disabled }: { item: LibraryItem; index: number; onPlay: () => void; disabled: boolean }) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: `manual-${index}`, disabled });
  const remove = useQueueStore(state => state.removeFromManualQueue);
  return <li ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }} className="queue-row">
    <button className="queue-drag" {...attributes} {...listeners} aria-label={`Reorder ${item.name}`} disabled={disabled} title="Drag to reorder; Space and arrow keys also work">⠿</button>
    <TrackButton item={item} onPlay={onPlay} disabled={disabled} />
    <button className="queue-remove" onClick={() => remove(index)} disabled={disabled} aria-label={`Remove ${item.name} from queue`} title="Remove from queue">×</button>
  </li>;
}

export function QueuePanel() {
  const queue = useQueueStore();
  const { currentItem } = usePlayerStore();
  const target = usePlaybackTargetStore();
  const play = usePlayback();
  const [pending, setPending] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const busy = pending || target.isSending || target.isSwitchingOutput || target.isTransportPending;
  const upcoming = queue.shuffleEnabled
    ? queue.contextItems.filter(item => item.id !== currentItem?.id)
    : queue.getUpcomingContext();
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
      if (source === 'manual' && current.manualQueue === after.manualQueue) useQueueStore.setState({ manualQueue: before.manualQueue });
      if (source === 'context' && current.contextIndex === after.contextIndex) useQueueStore.setState({ contextIndex: before.contextIndex });
    }
    setPending(false);
  }

  return <section className="up-next" aria-label="Up Next">
    <header><h2>Up Next</h2></header>
    <div className="queue-scroll">
      {currentItem && <section aria-label="Now playing"><h3>Now playing</h3>
        <div className="queue-current"><span aria-hidden="true">▶</span><span className="queue-track-text"><span>{currentItem.name}</span><small>{currentItem.artist}</small></span></div>
      </section>}
      {queue.repeatMode === 'one' && <p className="queue-note">Repeat one is on. Choose a track below to change songs.</p>}
      {!!queue.manualQueue.length && <section aria-label="Added to queue">
        <h3>Added by you <span>{queue.manualQueue.length}</span><button onClick={queue.clearManualQueue} disabled={busy}>Clear</button></h3>
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={({ active, over }) => {
          if (busy || !over || active.id === over.id) return;
          queue.moveManualQueueItem(Number(String(active.id).split('-')[1]), Number(String(over.id).split('-')[1]));
        }}>
          <SortableContext items={queue.manualQueue.map((_, index) => `manual-${index}`)} strategy={verticalListSortingStrategy}>
            <ol>{queue.manualQueue.map((item, index) => <QueuedTrack key={`${index}-${item.id}`} item={item} index={index} disabled={busy}
              onPlay={() => void playNow('manual', index, item.id)} />)}</ol>
          </SortableContext>
        </DndContext>
      </section>}
      {!!upcoming.length && <section aria-label={`From ${queue.contextName}`}>
        <h3>{queue.shuffleEnabled ? 'Shuffle from' : 'Then from'} {queue.contextName}<span>{upcoming.length}</span></h3>
        {queue.shuffleEnabled && <p className="queue-note">Next is chosen at random. You can also pick a track.</p>}
        <ol>{(showAll ? upcoming : upcoming.slice(0, 30)).map((item, index) => <li className="queue-row" key={`${index}-${item.id}`}>
          <TrackButton item={item} onPlay={() => void playNow('context', index, item.id)} disabled={busy} />
        </li>)}</ol>
        {!showAll && upcoming.length > 30 && <button className="queue-show-all" onClick={() => setShowAll(true)}>Show all {upcoming.length} tracks</button>}
      </section>}
      {!upcoming.length && !queue.manualQueue.length && <p className="queue-note">{currentItem ? 'Nothing else queued. Add songs with Play Next or Add to Queue.' : 'Nothing queued yet. Play a song to get started.'}</p>}
    </div>
  </section>;
}
