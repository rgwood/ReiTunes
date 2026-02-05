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

// Minimal icons
const DragIcon = (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
    <circle cx="9" cy="6" r="2" />
    <circle cx="15" cy="6" r="2" />
    <circle cx="9" cy="12" r="2" />
    <circle cx="15" cy="12" r="2" />
    <circle cx="9" cy="18" r="2" />
    <circle cx="15" cy="18" r="2" />
  </svg>
);

const CloseIcon = (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6" y1="6" x2="18" y2="18" />
  </svg>
);

const PlayIcon = (
  <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
    <polygon points="5 3 19 12 5 21 5 3" />
  </svg>
);

const RepeatIcon = (
  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <path d="M17 2l4 4-4 4" />
    <path d="M3 11v-1a4 4 0 0 1 4-4h14" />
    <path d="M7 22l-4-4 4-4" />
    <path d="M21 13v1a4 4 0 0 1-4 4H3" />
  </svg>
);

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
      className="flex items-center gap-2 px-3 py-1.5 hover:bg-solarized-base02 group"
    >
      <div
        {...attributes}
        {...listeners}
        className="cursor-grab text-solarized-base01 hover:text-solarized-base1 opacity-0 group-hover:opacity-100"
      >
        {DragIcon}
      </div>
      <div className="flex-grow min-w-0">
        <div className="text-xs text-solarized-base1 truncate">{item.name}</div>
        {item.artist && (
          <div className="text-[10px] text-solarized-base0 truncate">{item.artist}</div>
        )}
      </div>
      <button
        onClick={onRemove}
        className="text-solarized-base01 hover:text-solarized-red opacity-0 group-hover:opacity-100 transition-opacity"
        title="Remove"
      >
        {CloseIcon}
      </button>
    </div>
  );
}

interface ContextItemProps {
  item: LibraryItem;
}

function ContextItem({ item }: ContextItemProps) {
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 opacity-60">
      <div className="w-3" />
      <div className="flex-grow min-w-0">
        <div className="text-xs text-solarized-base0 truncate">{item.name}</div>
        {item.artist && (
          <div className="text-[10px] text-solarized-base0 truncate">{item.artist}</div>
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
    <div className="w-64 flex-shrink-0 bg-solarized-base03 border-l border-solarized-base02 flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-solarized-base02">
        <span className="text-[10px] text-solarized-base0 uppercase tracking-wider">Queue</span>
        {hasManualQueue && (
          <button
            onClick={clearManualQueue}
            className="text-[10px] text-solarized-base01 hover:text-solarized-red uppercase"
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
            <div className="px-3 py-1 text-[10px] text-solarized-base0 uppercase tracking-wider">
              Now Playing
            </div>
            <div className="flex items-center gap-2 px-3 py-1.5 bg-solarized-base02">
              <span className="text-solarized-blue">{PlayIcon}</span>
              <div className="flex-grow min-w-0">
                <div className="text-xs text-solarized-blue truncate">{currentItem.name}</div>
                {currentItem.artist && (
                  <div className="text-[10px] text-solarized-base0 truncate">{currentItem.artist}</div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Manual Queue */}
        {hasManualQueue && (
          <div className="border-b border-solarized-base02">
            <div className="px-3 py-1 text-[10px] text-solarized-base0 uppercase tracking-wider">
              Next Up
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

        {/* Context Queue */}
        {currentItem && (
          <div>
            <div className="px-3 py-1 text-[10px] text-solarized-base0 uppercase tracking-wider flex items-center justify-between">
              <span>
                {repeatMode === 'one' ? 'Repeating' : shuffleEnabled ? 'Shuffled' : contextName}
              </span>
              {repeatMode === 'all' && !shuffleEnabled && (
                <span className="text-solarized-green">loop</span>
              )}
            </div>

            {/* Repeat One */}
            {repeatMode === 'one' && (
              <div className="flex items-center gap-2 px-3 py-1.5 opacity-60">
                <span className="text-solarized-cyan">{RepeatIcon}</span>
                <div className="flex-grow min-w-0">
                  <div className="text-xs text-solarized-base0 truncate">{currentItem.name}</div>
                </div>
              </div>
            )}

            {/* Shuffle */}
            {shuffleEnabled && repeatMode !== 'one' && (
              <div className="px-3 py-1.5 text-[10px] text-solarized-base0">
                Random from {upcomingContext.length + 1} tracks
              </div>
            )}

            {/* Normal/Repeat All list */}
            {!shuffleEnabled && repeatMode !== 'one' && hasUpcomingContext && (
              <>
                {upcomingContext.slice(0, 15).map((item, index) => (
                  <ContextItem key={`context-${index}-${item.id}`} item={item} />
                ))}
                {upcomingContext.length > 15 && (
                  <div className="px-3 py-1 text-[10px] text-solarized-base0 text-center">
                    +{upcomingContext.length - 15} more
                  </div>
                )}
              </>
            )}

            {/* End of queue */}
            {!shuffleEnabled && repeatMode === 'off' && !hasUpcomingContext && (
              <div className="px-3 py-1.5 text-[10px] text-solarized-base0">
                End of queue
              </div>
            )}
          </div>
        )}

        {/* Empty state */}
        {!currentItem && !hasManualQueue && (
          <div className="px-3 py-4 text-xs text-solarized-base0 text-center">
            Nothing queued
          </div>
        )}
      </div>
    </div>
  );
}
