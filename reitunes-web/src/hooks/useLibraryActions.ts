import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { LibraryItem } from '../types';
import { deleteItem, toggleFavorite } from './useLibrary';

export type LibraryAction = 'delete' | 'favourite' | 'unfavourite';

export function useLibraryActions() {
  const client = useQueryClient();
  const running = useRef(false);
  const [progress, setProgress] = useState<{ action: LibraryAction; completed: number; total: number } | null>(null);

  async function run(items: LibraryItem[], action: LibraryAction) {
    if (running.current) return null;
    const targets = [...new Map(items.map(item => [item.id, item])).values()];
    const succeeded: LibraryItem[] = [];
    const failed: LibraryItem[] = [];
    running.current = true;
    setProgress({ action, completed: 0, total: targets.length });
    try {
      // The endpoints set a desired state, so retries don't toggle successes
      // back. Send one at a time rather than flooding the event writer.
      for (const item of targets) {
        try {
          if (action === 'delete') await deleteItem(item.id);
          else if (!!item.is_favorite !== (action === 'favourite')) {
            await toggleFavorite(item.id, action === 'unfavourite');
          }
          succeeded.push(item);
        } catch { failed.push(item); }
        setProgress({ action, completed: succeeded.length + failed.length, total: targets.length });
      }
      const ids = new Set(succeeded.map(item => item.id));
      // Also update locally: a dropped WebSocket mustn't leave deleted rows or
      // old hearts behind. Change only the affected field, keeping newer metadata.
      client.setQueryData<LibraryItem[]>(['library'], current => action === 'delete'
        ? current?.filter(item => !ids.has(item.id))
        : current?.map(item => ids.has(item.id) ? { ...item, is_favorite: action === 'favourite' } : item));
      if (action === 'delete' && ids.size) void client.invalidateQueries({ queryKey: ['tags'] });
      return { succeeded, failed };
    } finally {
      running.current = false;
      setProgress(null);
    }
  }

  return { run, progress, pending: progress !== null };
}
