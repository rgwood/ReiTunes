import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Playlist } from '../types';

export async function playlistRequest<T = void>(path: string, method: string, body?: unknown): Promise<T> {
  const response = await fetch('/api/playlists' + path, {
    method, headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error('Could not save the playlist. Please try again.');
  if (response.headers.get('content-type')?.includes('application/json')) return response.json();
  return undefined as T;
}

export function usePlaylists() {
  return useQuery<Playlist[]>({
    queryKey: ['playlists'],
    queryFn: async () => {
      const response = await fetch('/api/playlists');
      if (!response.ok) throw new Error('Could not load playlists.');
      return response.json();
    },
    refetchInterval: 30000,
  });
}

export function usePlaylistMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ path, method, body }: { path: string; method: string; body?: unknown }) =>
      playlistRequest(path, method, body),
    onSettled: () => client.invalidateQueries({ queryKey: ['playlists'] }),
  });
}
