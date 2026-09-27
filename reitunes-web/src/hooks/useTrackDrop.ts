import { useEffect, useState, type DragEvent } from 'react';
import { draggedTrackIds, TRACK_DRAG_TYPE } from '../utils/playlists';

// Native grid drags can cross several children inside a single drop target.
export function useTrackDrop(onDrop: (ids: string[], destination: string) => void) {
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  useEffect(() => {
    const clear = () => setDropTarget(null);
    document.addEventListener('dragend', clear);
    document.addEventListener('drop', clear);
    return () => {
      document.removeEventListener('dragend', clear);
      document.removeEventListener('drop', clear);
    };
  }, []);

  function dropProps(destination: string, enabled = true) {
    const accepts = (event: DragEvent<HTMLElement>) => enabled && event.dataTransfer.types.includes(TRACK_DRAG_TYPE);
    const hover = (event: DragEvent<HTMLElement>) => {
      if (!accepts(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
      setDropTarget(destination);
    };
    return {
      onDragEnter: hover,
      onDragOver: hover,
      onDragLeave: (event: DragEvent<HTMLElement>) => {
        if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) {
          setDropTarget(current => current === destination ? null : current);
        }
      },
      onDrop: (event: DragEvent<HTMLElement>) => {
        setDropTarget(null);
        if (!accepts(event)) return;
        event.preventDefault();
        const ids = draggedTrackIds(event.dataTransfer);
        if (ids.length) onDrop(ids, destination);
      },
    };
  }
  return { dropTarget, dropProps };
}
