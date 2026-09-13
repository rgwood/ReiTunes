import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface DownloadJob {
  id: number;
  url: string;
  dl_type: string;
  stage: 'queued' | 'downloading' | 'processing' | 'uploading' | 'importing' | 'completed' | 'failed';
  download_percent: number | null;
  error: string | null;
}

export const isFinished = (job?: DownloadJob) => job?.stage === 'completed' || job?.stage === 'failed';

export const useDownloads = create(persist<{
  jobs: DownloadJob[];
  remember: (job: DownloadJob) => void;
  forget: (id: number) => void;
}>((set) => ({
  jobs: [],
  remember: (job) => set(state => {
    if (JSON.stringify(state.jobs.find(item => item.id === job.id)) === JSON.stringify(job)) return state;
    const jobs = [job, ...state.jobs.filter(item => item.id !== job.id)];
    // Keep active work even when the recent history fills up.
    let finished = 0;
    return { jobs: jobs.filter(item => !isFinished(item) || ++finished <= 20) };
  }),
  forget: (id) => set(state => ({ jobs: state.jobs.filter(job => job.id !== id) })),
}), { name: 'reitunes-downloads-v1' }));

class DownloadError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) { super(message); this.status = status; }
}

async function requestJob(path: string, init?: RequestInit): Promise<DownloadJob> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 35_000);
  try {
    const response = await fetch(path, { ...init, cache: 'no-store', signal: controller.signal });
    if (!response.ok) {
      const raw = await response.text();
      throw new DownloadError(response.status === 401 ? 'Sign in again to check download progress.'
        : raw && !raw.trimStart().startsWith('<') ? raw : 'Could not check the downloader. Try checking again.', response.status);
    }
    return await response.json() as DownloadJob;
  } catch (error) {
    if (error instanceof DownloadError) throw error;
    throw new DownloadError('The downloader did not respond. Check progress before submitting again.');
  } finally {
    window.clearTimeout(timeout);
  }
}

export async function submitDownload(url: string, dl_type: string) {
  const job = await requestJob('/api/download', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url, dl_type }),
  });
  useDownloads.getState().remember(job);
  return job;
}

export function useDownloadJob(id: number, enabled = true) {
  const client = useQueryClient();
  const query = useQuery<DownloadJob, DownloadError>({
    queryKey: ['download', id],
    queryFn: () => requestJob(`/api/downloads/${id}`),
    initialData: () => useDownloads.getState().jobs.find(job => job.id === id),
    enabled,
    staleTime: 1_000,
    refetchInterval: query => isFinished(query.state.data) || [401, 404].includes(query.state.error?.status ?? 0)
      ? false : query.state.error ? 5_000 : 2_000,
    retry: false,
  });
  useEffect(() => {
    if (!query.data) return;
    useDownloads.getState().remember(query.data);
    if (query.data.stage === 'completed') {
      void client.invalidateQueries({ queryKey: ['library'] });
      void client.invalidateQueries({ queryKey: ['discovery'] });
    }
  }, [query.data, client]);
  return query;
}
