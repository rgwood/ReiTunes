import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import type { LibraryItem, LibraryUpdate } from '../types';

const AZURE_STORAGE_URL = 'https://reitunes.blob.core.windows.net/music/';

export function getItemUrl(item: LibraryItem): string {
  let url: string;

  // If file_path looks like a URL or contains azure blob storage path, use it directly
  if (item.file_path.startsWith('http://') || item.file_path.startsWith('https://')) {
    url = item.file_path;
  } else if (item.file_path.includes('/')) {
    // If file_path contains a slash, it's likely an Azure blob path (legacy)
    url = `${AZURE_STORAGE_URL}${encodeURIComponent(item.file_path)}`;
  } else {
    // Otherwise, it's a local file - serve from /music endpoint
    url = `/music/${encodeURIComponent(item.file_path)}`;
  }

  console.info(`[Audio] Playing "${item.name}" from: ${url}`);
  return url;
}

async function fetchLibraryItems(): Promise<LibraryItem[]> {
  // The backend serves items embedded in the HTML, but we'll use the API
  // For now, we'll parse items from the initial HTML data
  const response = await fetch('/api/items');
  if (!response.ok) {
    throw new Error('Failed to fetch library items');
  }
  return response.json();
}

export function useLibrary() {
  const queryClient = useQueryClient();
  const wsRef = useRef<WebSocket | null>(null);

  const query = useQuery({
    queryKey: ['library'],
    queryFn: fetchLibraryItems,
    staleTime: Infinity, // WebSocket keeps data fresh
  });

  // WebSocket connection for real-time updates
  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/updates`;

    const connect = () => {
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onmessage = (event) => {
        const message: LibraryUpdate = JSON.parse(event.data);

        queryClient.setQueryData<LibraryItem[]>(['library'], (oldItems) => {
          if (!oldItems) return oldItems;

          if (message.type === 'update') {
            const existingIndex = oldItems.findIndex(item => item.id === message.item.id);
            if (existingIndex >= 0) {
              // Update existing item
              const newItems = [...oldItems];
              newItems[existingIndex] = message.item;
              return newItems;
            } else {
              // Add new item
              return [...oldItems, message.item];
            }
          } else if (message.type === 'delete') {
            return oldItems.filter(item => item.id !== message.id);
          }

          return oldItems;
        });
      };

      ws.onclose = () => {
        // Reconnect after a delay
        setTimeout(connect, 3000);
      };

      ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        ws.close();
      };
    };

    connect();

    return () => {
      wsRef.current?.close();
    };
  }, [queryClient]);

  return {
    items: query.data ?? [],
    isLoading: query.isLoading,
    error: query.error,
  };
}

// API functions for mutations
export async function updateLibraryItem(
  id: string,
  field: string,
  value: string
): Promise<void> {
  const response = await fetch('/ui/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, field, value }),
    credentials: 'include',
  });
  if (!response.ok) {
    throw new Error('Failed to update item');
  }
}

export async function markPlayed(id: string): Promise<void> {
  const response = await fetch('/ui/play', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
    credentials: 'include',
  });
  if (!response.ok) {
    throw new Error('Failed to mark as played');
  }
}

export async function deleteItem(id: string): Promise<void> {
  const response = await fetch('/ui/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
    credentials: 'include',
  });
  if (!response.ok) {
    throw new Error('Failed to delete item');
  }
}

export async function addBookmark(id: string, position: number): Promise<void> {
  const response = await fetch(`/ui/${id}/bookmarks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ position }),
    credentials: 'include',
  });
  if (!response.ok) {
    throw new Error('Failed to add bookmark');
  }
}

export async function toggleFavorite(id: string, isFavorite: boolean): Promise<void> {
  const endpoint = isFavorite ? `/ui/${id}/unfavorite` : `/ui/${id}/favorite`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
  });
  if (!response.ok) {
    throw new Error('Failed to toggle favorite');
  }
}

export async function reloadTags(id: string): Promise<void> {
  const response = await fetch(`/ui/${id}/reload-tags`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
  });
  if (!response.ok) {
    throw new Error('Failed to reload tags');
  }
}
