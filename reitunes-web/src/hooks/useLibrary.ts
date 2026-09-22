import { QueryClient, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { metadataSuggestions } from '../utils/metadataSuggestions';
import type { LibraryItem, LibraryUpdate, RealtimeUpdate } from '../types';

export const SONOS_REALTIME_EVENT = 'reitunes:sonos';

export function applyLibraryUpdate(queryClient: QueryClient, message: LibraryUpdate) {
  const oldItems = queryClient.getQueryData<LibraryItem[]>(['library']);
  const previous = oldItems?.find(item => item.id === (message.type === 'update' ? message.item.id : message.id));
  const tagsChanged = message.type === 'delete' || !previous ||
    (['name', 'artist', 'album', 'file_path'] as const).some(field => previous[field] !== message.item[field]);

  queryClient.setQueryData<LibraryItem[]>(['library'], items => {
    if (!items) return items;
    if (message.type === 'delete') return items.filter(item => item.id !== message.id);
    return previous ? items.map(item => item.id === message.item.id ? message.item : item) : [...items, message.item];
  });
  if (tagsChanged) void queryClient.invalidateQueries({ queryKey: ['tags'] });
}

export function getItemUrl(item: LibraryItem): string {
  // URL is now provided by the backend
  console.info(`[Audio] Playing "${item.name}" from: ${item.url}`);
  return item.url;
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

export function useMetadataSuggestions() {
  const { data } = useQuery({ queryKey: ['library'], queryFn: fetchLibraryItems, staleTime: Infinity });
  return useMemo(() => ({
    artist: metadataSuggestions(data ?? [], 'artist'),
    album: metadataSuggestions(data ?? [], 'album'),
  }), [data]);
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
    let mounted = true;
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/updates`;

    const connect = () => {
      if (!mounted) return;

      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onmessage = (event) => {
        const message: RealtimeUpdate = JSON.parse(event.data);

        if (message.type === 'sonos') {
          window.dispatchEvent(
            new CustomEvent(SONOS_REALTIME_EVENT, { detail: message })
          );
          return;
        }

        applyLibraryUpdate(queryClient, message);
      };

      ws.onclose = () => {
        // Reconnect after a delay, but not if we've been unmounted
        if (mounted) {
          setTimeout(connect, 3000);
        }
      };

      ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        ws.close();
      };
    };

    connect();

    return () => {
      mounted = false;
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
export function useUpdateLibraryItem() {
  const queryClient = useQueryClient();
  return useCallback(async (id: string, field: 'name' | 'artist' | 'album' | 'track_number', value: string) => {
    await updateLibraryItem(id, field, value);
    queryClient.setQueryData<LibraryItem[]>(['library'], items => items?.map(item =>
      item.id === id ? { ...item, [field]: field === 'track_number' ? (value === '' ? null : Number(value)) : value } : item
    ));
    if (field !== 'track_number') void queryClient.invalidateQueries({ queryKey: ['tags'] });
  }, [queryClient]);
}

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

export async function updateBookmark(
  itemId: string,
  bookmarkId: string,
  label: string,
  emoji: string,
  position?: number,
  endPosition?: number | null,
): Promise<void> {
  const response = await fetch(`/ui/${itemId}/bookmarks/${bookmarkId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label: label.trim() || null, emoji, position, end_position: endPosition }),
    credentials: 'include',
  });
  if (!response.ok) {
    throw new Error('Failed to update bookmark');
  }
}

export async function deleteBookmark(itemId: string, bookmarkId: string): Promise<void> {
  const response = await fetch(`/ui/${itemId}/bookmarks/${bookmarkId}`, {
    method: 'DELETE',
    credentials: 'include',
  });
  if (!response.ok) {
    throw new Error('Failed to delete bookmark');
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
