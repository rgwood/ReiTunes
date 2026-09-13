import { useQuery } from '@tanstack/react-query';

export interface DiscoverySource {
  id: string;
  url: string;
  title: string;
  provider: string;
  minMinutes: number;
  lastChecked: number | null;
  lastAttempt: number | null;
  error: string | null;
  archiveOffset: number;
  archiveFinished: boolean;
}

export interface DiscoveryEntry {
  id: string;
  mediaId: string;
  url: string;
  title: string;
  uploader: string;
  duration: number | null;
  published: string | null;
  sources: string[];
  inbox: boolean;
  status: 'new' | 'dismissed' | 'queued' | 'import_failed';
  discoveredAt: number;
  libraryItemId: string | null;
  downloadJobId?: number | null;
  error: string | null;
}

export interface DiscoveryData {
  sources: DiscoverySource[];
  entries: DiscoveryEntry[];
  refreshing: boolean;
}

export async function discoveryRequest<T>(path = '', body?: unknown, method = 'POST'): Promise<T> {
  const response = await fetch(`/api/discovery${path}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const message = await response.text();
    throw new Error(message && !message.trimStart().startsWith('<') ? message : 'Could not reach discovery. Please retry.');
  }
  if (response.status === 204 || response.status === 202 || response.status === 201) return undefined as T;
  return response.json() as Promise<T>;
}

export function isInboxEntry(entry: DiscoveryEntry) {
  return entry.inbox && entry.sources.length > 0 && !entry.libraryItemId
    && (entry.status === 'new' || entry.status === 'import_failed');
}

export function useDiscovery() {
  return useQuery<DiscoveryData>({
    queryKey: ['discovery'],
    queryFn: () => discoveryRequest('', undefined, 'GET'),
    staleTime: 10_000,
    refetchInterval: (query) => query.state.data?.refreshing ? 2_000 : 30_000,
    retry: 1,
  });
}
