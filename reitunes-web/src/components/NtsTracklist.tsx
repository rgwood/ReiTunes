import { useId, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import './NtsTracklist.css';

interface EpisodeDetails {
  description: string;
  genres: string[];
  tracks: { artist: string; title: string }[];
}

export function NtsTracklist({ entryId }: { entryId: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const { data, isPending, error, refetch, isFetching } = useQuery<EpisodeDetails>({
    queryKey: ['nts-tracklist', entryId],
    enabled: open,
    staleTime: 30 * 60_000,
    retry: false,
    queryFn: async ({ signal }) => {
      const response = await fetch(`/api/discovery/entries/${encodeURIComponent(entryId)}/details`, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
      });
      if (!response.ok) throw new Error('The NTS tracklist could not be loaded.');
      return response.json() as Promise<EpisodeDetails>;
    },
  });
  return <div className="nts-tracklist">
    <button type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
      {open ? 'Hide tracklist' : 'Tracklist'}{data?.tracks.length ? ` (${data.tracks.length})` : ''}
    </button>
    {open && <div id={id} className="nts-tracklist__body">
      {error ? <p role="alert">Could not load the NTS tracklist. <button disabled={isFetching} onClick={() => void refetch()}>Try again</button></p>
        : isPending ? <p role="status">Reading tracklist…</p>
        : data?.tracks.length ? <ol aria-label="Episode tracklist">{data.tracks.map((track, index) => <li key={index}>
          <span>{track.artist}</span><span>{track.title}</span>
        </li>)}</ol> : <p>NTS has not published a tracklist for this episode.</p>}
    </div>}
  </div>;
}
