import { useMemo } from 'react';
import { DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useShallow } from 'zustand/react/shallow';
import { usePlayerStore } from '../stores/playerStore';
import type { LibraryItem, PlaybackEntry } from '../types';
import { describeTarget, formatTime } from '../utils/playback';

function EntryLabel({ entry, item }: { entry: PlaybackEntry; item?: LibraryItem }) {
  return (
    <div className="min-w-0 flex-1">
      <div className="text-xs truncate" title={describeTarget(entry, item)}>{item?.name ?? 'Unavailable track'}</div>
      <div className="text-xs text-solarized-base0 truncate mt-0.5">
        {entry.bookmarkId ? `🔖 ${formatTime(entry.startPosition)} · ` : ''}{item?.artist}
      </div>
    </div>
  );
}

function SortableEntry({ entry, item }: { entry: PlaybackEntry; item?: LibraryItem }) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: entry.id });
  const remove = usePlayerStore(state => state.removeFromQueue);
  return (
    <li ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }}
      className="flex items-center gap-2 px-3 py-2 hover:bg-solarized-base02">
      <button {...attributes} {...listeners} aria-label={`Reorder ${describeTarget(entry, item)}`}
        className="p-1 text-solarized-base0 cursor-grab touch-none">⠿</button>
      <EntryLabel entry={entry} item={item} />
      <button onClick={() => remove(entry.id)} aria-label={`Remove ${describeTarget(entry, item)} from queue`}
        className="p-2 text-solarized-base0 hover:text-solarized-red">×</button>
    </li>
  );
}

export function QueuePanel({ itemsById, onClose }: { itemsById: Map<string, LibraryItem>; onClose: () => void }) {
  const { currentEntry, manualQueue, forwardHistory, contextOrder, contextIndex, contextName, repeatMode, shuffleEnabled } = usePlayerStore(useShallow(state => ({
    currentEntry: state.currentEntry, manualQueue: state.manualQueue, forwardHistory: state.forwardHistory,
    contextOrder: state.contextOrder, contextIndex: state.contextIndex, contextName: state.contextName,
    repeatMode: state.repeatMode, shuffleEnabled: state.shuffleEnabled,
  })));
  const clear = usePlayerStore(state => state.clearManualQueue);
  const move = usePlayerStore(state => state.moveQueueEntry);
  const next = usePlayerStore(state => state.next);
  const upcoming = useMemo(() => contextOrder.slice(contextIndex + 1), [contextOrder, contextIndex]);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const list = (entries: PlaybackEntry[]) => (
    <ul>{entries.slice(0, 15).map(entry => (
      <li key={entry.id} className="flex px-3 py-2 text-solarized-base1"><EntryLabel entry={entry} item={itemsById.get(entry.libraryItemId)} /></li>
    ))}{entries.length > 15 && <li className="px-3 py-2 text-xs text-solarized-base0">+{entries.length - 15} more</li>}</ul>
  );

  return (
    <aside aria-label="Playback queue" onKeyDown={event => { if (event.key === 'Escape') onClose(); }}
      className="absolute inset-y-0 right-0 z-20 w-full max-w-80 md:static md:w-72 flex-shrink-0 bg-solarized-base03 border-l border-solarized-base01 flex flex-col h-full shadow-xl md:shadow-none">
      <div className="flex items-center justify-between px-3 py-2 border-b border-solarized-base02">
        <h2 className="text-sm text-solarized-base2">Queue</h2>
        <button onClick={onClose} aria-label="Close queue" className="w-10 h-10 text-solarized-base0 hover:text-solarized-base2">×</button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {currentEntry && (
          <div className="border-b border-solarized-base02 pb-2">
            <h3 className="px-3 pt-3 pb-1 text-xs text-solarized-base0">Now playing</h3>
            <div className="flex items-center gap-2 px-3 py-2 text-solarized-cyan"><span>▶</span><EntryLabel entry={currentEntry} item={itemsById.get(currentEntry.libraryItemId)} /></div>
            {repeatMode === 'one' && <p className="px-3 text-xs text-solarized-base0">Repeating this entry. Next skips to the queue.</p>}
          </div>
        )}
        {!!forwardHistory.length && <><h3 className="px-3 pt-3 text-xs text-solarized-base0">Back through your history</h3>{list(forwardHistory)}</>}
        {!!manualQueue.length && (
          <div className="border-b border-solarized-base02">
            <div className="flex justify-between items-center px-3 pt-3">
              <h3 className="text-xs text-solarized-base0">Next up</h3>
              <button onClick={clear} className="text-xs text-solarized-base0 hover:text-solarized-red">Clear</button>
            </div>
            {!currentEntry && <button onClick={() => next()} className="mx-3 mt-2 px-3 py-2 text-xs bg-solarized-cyan text-solarized-base03 rounded">Play queue</button>}
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={({ active, over }) => { if (over) move(String(active.id), String(over.id)); }}>
              <SortableContext items={manualQueue.map(entry => entry.id)} strategy={verticalListSortingStrategy}>
                <ul>{manualQueue.map(entry => <SortableEntry key={entry.id} entry={entry} item={itemsById.get(entry.libraryItemId)} />)}</ul>
              </SortableContext>
            </DndContext>
          </div>
        )}
        {currentEntry && <>
          <h3 className="px-3 pt-3 text-xs text-solarized-base0">{contextName}{shuffleEnabled ? ' · shuffled' : ''}</h3>
          {list(upcoming)}
          <p className="px-3 py-3 text-xs text-solarized-base0">{repeatMode === 'all' ? 'Repeat all starts another cycle after this queue.' : !upcoming.length ? 'End of queue' : ''}</p>
        </>}
        {!currentEntry && !manualQueue.length && <p className="px-3 py-6 text-sm text-solarized-base0">Queue a track to listen next.</p>}
      </div>
    </aside>
  );
}
