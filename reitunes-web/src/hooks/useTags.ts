import { QueryClient, useQuery } from '@tanstack/react-query';

export type TagVerdict = 'accepted' | 'rejected' | 'uncertain';
export interface TagLabel { tag: string; verdict: TagVerdict; reason: string }
/** `evidence` and `sourceUrls` are only in an item's detail (`useTagDetail`), not the list snapshot. */
export interface TagSuggestion { tag: string; basis: string; confidence: number; evidence?: string; sourceUrls?: string[] }
export interface ItemTags {
  status: string; tags: TagSuggestion[]; labels: Record<string, TagLabel>;
  phase?: string | null;
  updatedAt?: number | null;
  error?: string | null; uncertainty?: string | null; model?: string | null;
  provider?: string | null; costUsd?: number | null;
}
/** A server revision. `boot` tells revisions from different server runs apart. */
export interface TagRevision { boot: number; number: number }
export interface TagSnapshot {
  enabled: boolean; items: Record<string, ItemTags>; revision: TagRevision;
  /** Client-side: the revision of the last patch applied to each item, if newer than `revision`. */
  itemRevisions?: Record<string, number>;
}
/** Some items' state as of `revision`; `null` means the item has no tags any more. */
export interface TagPatch { revision: TagRevision; items: Record<string, ItemTags | null> }
export interface TagDetail { revision: TagRevision; item: ItemTags | null }

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

/**
 * Applies a patch unless an item already has newer state. Patches and snapshots are each
 * at least as new as their revision, so on equal revisions either is fine.
 */
export function mergeTagPatch(snapshot: TagSnapshot, patch: TagPatch): TagSnapshot {
  if (patch.revision.boot !== snapshot.revision.boot) return snapshot;
  const items = { ...snapshot.items };
  const itemRevisions = { ...snapshot.itemRevisions };
  for (const [id, item] of Object.entries(patch.items)) {
    if ((itemRevisions[id] ?? snapshot.revision.number) > patch.revision.number) continue;
    itemRevisions[id] = patch.revision.number;
    if (item) items[id] = item; else delete items[id];
  }
  return { ...snapshot, items, itemRevisions };
}

// Patches that arrive while a snapshot request is in flight may be newer than the snapshot,
// and would otherwise be overwritten by it. Keep them and replay them over the result.
let snapshotRequests = 0;
let patchesDuringRequest: TagPatch[] = [];

export async function fetchTagSnapshot(): Promise<TagSnapshot> {
  snapshotRequests++;
  try {
    const snapshot = await tagsRequest<TagSnapshot>('', undefined, 'GET');
    return patchesDuringRequest.reduce(mergeTagPatch, snapshot);
  } finally {
    if (--snapshotRequests === 0) patchesDuringRequest = [];
  }
}

/** Applies a patch pushed over the WebSocket. */
export function applyTagPatch(queryClient: QueryClient, patch: TagPatch) {
  if (snapshotRequests > 0) patchesDuringRequest.push(patch);
  queryClient.setQueryData<TagSnapshot>(['tags'], snapshot => snapshot && mergeTagPatch(snapshot, patch));
  // Only refetches when a tag panel is showing one of these items.
  for (const id of Object.keys(patch.items)) void queryClient.invalidateQueries({ queryKey: ['tagDetail', id] });
}

async function fetchTagDetail(id: string): Promise<TagDetail> {
  return tagsRequest<TagDetail>(`/items/${id}`, undefined, 'GET');
}

/** Refetches one item after changing it, without waiting for the WebSocket patch. */
export async function refreshTagItem(queryClient: QueryClient, id: string) {
  const detail = await fetchTagDetail(id);
  queryClient.setQueryData(['tagDetail', id], detail);
  const patch: TagPatch = { revision: detail.revision, items: { [id]: detail.item } };
  if (snapshotRequests > 0) patchesDuringRequest.push(patch);
  queryClient.setQueryData<TagSnapshot>(['tags'], snapshot => snapshot && mergeTagPatch(snapshot, patch));
}

export function useTags() {
  return useQuery<TagSnapshot>({
    queryKey: ['tags'], queryFn: fetchTagSnapshot, retry: 1,
    staleTime: Infinity, // The WebSocket sends changed items, including tagging progress
  });
}

/** Everything about one item, including the tag evidence the list snapshot leaves out. */
export function useTagDetail(id: string | undefined) {
  return useQuery<TagDetail>({
    queryKey: ['tagDetail', id], queryFn: () => fetchTagDetail(id!), enabled: !!id,
    staleTime: Infinity, // Refetched when a patch for this item arrives
  });
}
