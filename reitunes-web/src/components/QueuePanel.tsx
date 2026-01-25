import { useCallback } from 'react';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useQueueStore } from '../hooks/useQueue';
import { usePlayerStore } from '../stores/playerStore';
import type { LibraryItem } from '../types';

interface SortableItemProps {
  item: LibraryItem;
  index: number;
  onRemove: () => void;
}

function SortableItem({ item, index, onRemove }: SortableItemProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
  } = useSortable({ id: `manual-${index}-${item.id}` });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="flex items-center gap-2 p-2 border-b border-solarized-base02 hover:bg-solarized-base02"
    >
      <div
        {...attributes}
        {...listeners}
        className="cursor-grab text-solarized-base01 hover:text-solarized-base1"
      >
        &#9776;
      </div>
      <div className="flex-grow">
        <div className="text-sm text-solarized-base1">
          {item.name}
        </div>
        {item.artist && (
          <div className="text-xs text-solarized-base01">
            {item.artist}
          </div>
        )}
      </div>
      <button
        onClick={onRemove}
        className="text-solarized-base01 hover:text-solarized-red px-2"
        title="Remove from queue"
      >
        &#10005;
      </button>
    </div>
  );
}

interface ContextItemProps {
  item: LibraryItem;
}

function ContextItem({ item }: ContextItemProps) {
  return (
    <div className="flex items-center gap-2 p-2 border-b border-solarized-base02 opacity-70">
      <div className="w-5" /> {/* Spacer to align with sortable items */}
      <div className="flex-grow">
        <div className="text-sm text-solarized-base01">
          {item.name}
        </div>
        {item.artist && (
          <div className="text-xs text-solarized-base01">
            {item.artist}
          </div>
        )}
      </div>
    </div>
  );
}

export function QueuePanel() {
  const {
    manualQueue,
    contextName,
    removeFromManualQueue,
    clearManualQueue,
    moveManualQueueItem,
    getUpcomingContext,
    repeatMode,
    shuffleEnabled,
  } = useQueueStore();
  const { currentItem } = usePlayerStore();

  const upcomingContext = getUpcomingContext();

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;

    if (over && active.id !== over.id) {
      // Extract indices from the sortable IDs
      const activeIdParts = String(active.id).split('-');
      const overIdParts = String(over.id).split('-');
      const oldIndex = parseInt(activeIdParts[1], 10);
      const newIndex = parseInt(overIdParts[1], 10);
      moveManualQueueItem(oldIndex, newIndex);
    }
  }, [moveManualQueueItem]);

  const hasManualQueue = manualQueue.length > 0;
  const hasUpcomingContext = upcomingContext.length > 0;

  return (
    <div className="w-80 flex-shrink-0 bg-solarized-base03 border-l border-solarized-base02 flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between p-3 border-b border-solarized-base02">
        <h2 className="text-sm font-semibold text-solarized-base1 uppercase tracking-wide">Queue</h2>
        {hasManualQueue && (
          <button
            onClick={clearManualQueue}
            className="text-xs text-solarized-base01 hover:text-solarized-red"
            title="Clear manual queue"
          >
            Clear
          </button>
        )}
      </div>

      {/* Queue Content */}
      <div className="flex-grow overflow-y-auto">
        {/* Now Playing */}
        {currentItem && (
          <div className="border-b border-solarized-base02">
            <div className="px-4 py-2 text-xs text-solarized-base01 uppercase tracking-wide">
              Now Playing
            </div>
            <div className="flex items-center gap-2 p-2 bg-solarized-base02">
              <div className="w-5 text-solarized-blue">&#9654;</div>
              <div className="flex-grow">
                <div className="text-sm text-solarized-blue">
                  {currentItem.name}
                </div>
                {currentItem.artist && (
                  <div className="text-xs text-solarized-base01">
                    {currentItem.artist}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Manual Queue (Next in Queue) */}
        {hasManualQueue && (
          <div className="border-b border-solarized-base02">
            <div className="px-4 py-2 text-xs text-solarized-base01 uppercase tracking-wide">
              Next in Queue
            </div>
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleDragEnd}
            >
              <SortableContext
                items={manualQueue.map((item, index) => `manual-${index}-${item.id}`)}
                strategy={verticalListSortingStrategy}
              >
                {manualQueue.map((item, index) => (
                  <SortableItem
                    key={`manual-${index}-${item.id}`}
                    item={item}
                    index={index}
                    onRemove={() => removeFromManualQueue(index)}
                  />
                ))}
              </SortableContext>
            </DndContext>
          </div>
        )}

        {/* Repeat One Indicator */}
        {repeatMode === 'one' && currentItem && (
          <div className="px-4 py-3 text-xs text-solarized-cyan flex items-center gap-2 border-b border-solarized-base02">
            <span>&#128257;</span>
            <span>Current song on repeat</span>
          </div>
        )}

        {/* Shuffle Indicator */}
        {shuffleEnabled && repeatMode !== 'one' && (
          <div className="px-4 py-3 text-xs text-solarized-green flex items-center gap-2 border-b border-solarized-base02">
            <span>&#128256;</span>
            <span>Shuffle enabled - next song is random</span>
          </div>
        )}

        {/* Context Queue (Next from Library/Playlist) */}
        {hasUpcomingContext && repeatMode !== 'one' && !shuffleEnabled && (
          <div>
            <div className="px-4 py-2 text-xs text-solarized-base01 uppercase tracking-wide">
              Next from {contextName}
              {repeatMode === 'all' && <span className="ml-2 text-solarized-violet">(Repeat All)</span>}
            </div>
            {upcomingContext.slice(0, 20).map((item, index) => (
              <ContextItem key={`context-${index}-${item.id}`} item={item} />
            ))}
            {upcomingContext.length > 20 && (
              <div className="p-2 text-center text-xs text-solarized-base01">
                +{upcomingContext.length - 20} more
              </div>
            )}
          </div>
        )}

        {/* Empty state */}
        {!currentItem && !hasManualQueue && !hasUpcomingContext && (
          <div className="p-4 text-solarized-base01 text-center">
            Queue is empty
          </div>
        )}
      </div>
    </div>
  );
}
