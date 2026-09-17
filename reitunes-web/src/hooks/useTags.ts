import { useQuery } from '@tanstack/react-query';

export type TagVerdict = 'accepted' | 'rejected' | 'uncertain';
export interface TagLabel { tag: string; verdict: TagVerdict; reason: string }
export interface TagSuggestion { tag: string; basis: string; confidence: number; evidence: string; sourceUrls: string[] }
export interface ItemTags {
  status: string; tags: TagSuggestion[]; labels: Record<string, TagLabel>;
  phase?: string | null;
  updatedAt?: number | null;
  error?: string | null; uncertainty?: string | null; model?: string | null;
  provider?: string | null; costUsd?: number | null;
}
export interface TagSnapshot { enabled: boolean; items: Record<string, ItemTags> }

export function tagProgress(item: ItemTags | undefined): string {
  if (!item) return 'No automatic tags yet';
  if (item.status === 'queued') return 'Waiting to start';
  if (item.status === 'running') return ({ researching: 'Looking up music metadata…', prepared: 'Metadata ready; waiting for other tracks…', classifying: 'GLM is generating suggestions…' })[item.phase || ''] || 'Preparing suggestions…';
  if (item.status === 'failed') return 'Could not generate tags — retry available';
  if (item.status === 'stale') return 'Metadata changed — updating tags';
  return item.tags.length ? 'Tags applied automatically' : 'No tags found. You can add your own.';
}

export function normalizeLibraryTag(value: string) { return value.trim().toLowerCase().replace(/\s+/g, '-'); }

export function effectiveTags(item: ItemTags | undefined, includeSuggestions = true): string[] {
  const tags = new Set<string>();
  if (includeSuggestions && item?.status === 'ready') {
    for (const tag of item.tags) if (!item.labels[tag.tag]) tags.add(tag.tag);
  }
  for (const label of Object.values(item?.labels || {})) if (label.verdict === 'accepted') tags.add(label.tag);
  return [...tags].sort();
}

export async function tagsRequest<T>(path = '', body?: unknown, method = 'POST'): Promise<T> {
  const response = await fetch(`/api/tags${path}`, {
    method, headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text && !text.trimStart().startsWith('<') ? text : 'Could not load tags. Please retry.');
  }
  return response.status === 204 || response.status === 202 ? undefined as T : response.json();
}

export function useTags() {
  return useQuery<TagSnapshot>({
    queryKey: ['tags'], queryFn: () => tagsRequest('', undefined, 'GET'), retry: 1,
    staleTime: 5_000,
    refetchInterval: query => Object.values(query.state.data?.items || {}).some(item => ['queued', 'running'].includes(item.status)) ? 3_000 : 30_000,
  });
}
