import { useMutation, useQueryClient } from '@tanstack/react-query';

async function addToPlaylist(playlistId: string, libraryItemId: string): Promise<void> {
  const response = await fetch(`/api/playlists/${playlistId}/items`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ library_item_id: libraryItemId }),
  });
  if (!response.ok) throw new Error('Failed to add to playlist');
}

export function useAddToPlaylist() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ playlistId, libraryItemId }: { playlistId: string; libraryItemId: string }) =>
      addToPlaylist(playlistId, libraryItemId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['playlists'] });
    },
  });
}
