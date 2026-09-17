export interface Tag { tag: string; basis: 'metadata' | 'inference' | 'web' | 'database'; confidence: number; evidence: string; source_urls?: string[]; sources_verified?: boolean }
export interface Prediction { id: string; uncertainty: string; tags: Tag[] }
export interface Run {
  id: string; model: string; prompt_version: string; harness_version: string; repeat: number;
  latency_seconds: number; cost_usd: number | null; predictions: Prediction[];
  reasoning?: { effort: string }; evidence_mode?: string; provider?: string;
}
export interface Item {
  id: string; name: string; artist: string; album: string; is_favorite: boolean;
  created_time_utc: string; play_count: number; url?: string;
  musicbrainz?: { recording_status: string; identity_caveat?: string; research_reasons: string[]; sources: string[];
    recording?: { title: string; artist_credits: string[] }; artist?: { name: string; community_tags: string[] } };
}
export interface Experiment {
  schema_version: 1; id: string; created_at: string; evidence_mode: string;
  sample_method: string; items: Item[]; runs: Run[];
  failed_attempts?: { id: string; model: string; validation_error: string; cost_usd: number | null }[];
}
export type Verdict = 'accepted' | 'rejected' | 'uncertain';
export interface Label { tag: string; verdict: Verdict; reason?: string; updated_at: string; origin: 'human' }
export interface ItemReview { labels: Record<string, Label>; notes: string; uncertain: boolean }
export interface Review { schema_version: 1; items: Record<string, ItemReview> }
export const STORAGE_KEY = 'reitunes-tagging-human-labels-v1';
export const emptyReview = (): Review => ({ schema_version: 1, items: {} });
export const emptyItemReview = (): ItemReview => ({ labels: {}, notes: '', uncertain: false });
export const normalizeTag = (tag: string) => tag.trim().toLowerCase().replace(/\s+/g, '-');

// Validate imports before merging; malformed files must never replace existing labels.
export function parseReview(value: unknown): Review {
  if (!value || typeof value !== 'object') throw new Error('Invalid review file');
  const review = value as Review;
  if (review.schema_version !== 1 || !review.items || typeof review.items !== 'object' || Array.isArray(review.items)) throw new Error('Unsupported review schema');
  const result = emptyReview();
  for (const [id, item] of Object.entries(review.items)) {
    if (!/^[a-zA-Z0-9-]+$/.test(id) || !item || typeof item.notes !== 'string' || typeof item.uncertain !== 'boolean' || !item.labels || typeof item.labels !== 'object' || Array.isArray(item.labels)) throw new Error('Invalid item review');
    const labels: Record<string, Label> = {};
    for (const [key, label] of Object.entries(item.labels)) {
      if (!label || typeof label.tag !== 'string' || !label.tag.trim() || label.tag.length > 60 || key !== normalizeTag(label.tag) || ['__proto__', 'constructor', 'prototype'].includes(key) || !['accepted', 'rejected', 'uncertain'].includes(label.verdict) || label.origin !== 'human' || typeof label.updated_at !== 'string' || !Number.isFinite(Date.parse(label.updated_at))) throw new Error('Invalid tag label');
      if (label.reason !== undefined && typeof label.reason !== 'string') throw new Error('Invalid label reason');
      labels[key] = { ...label };
    }
    result.items[id] = { labels, notes: item.notes, uncertain: item.uncertain };
  }
  return result;
}

// Existing edits win on import. Import is additive, including across sample versions.
export function mergeReviews(current: Review, incoming: Review): Review {
  const result = parseReview(incoming);
  for (const [id, item] of Object.entries(current.items)) {
    result.items[id] = { ...item, labels: { ...result.items[id]?.labels, ...item.labels } };
  }
  return result;
}

export function scoreRun(run: Run, review: Review) {
  const counts = { accepted: 0, rejected: 0, uncertain: 0, pending: 0 };
  for (const prediction of run.predictions) for (const tag of prediction.tags) {
    const verdict = review.items[prediction.id]?.labels[normalizeTag(tag.tag)]?.verdict;
    counts[verdict || 'pending']++;
  }
  const judged = counts.accepted + counts.rejected;
  return { ...counts, judged, precision: judged ? counts.accepted / judged : null };
}

export function exportReview(experiment: Experiment, review: Review) {
  return {
    format: 'reitunes-tagging-review', schema_version: 1, exported_at: new Date().toISOString(),
    experiment, human_review: review,
    scores: experiment.runs.map(run => ({ run_id: run.id, ...scoreRun(run, review) })),
    scoring_note: 'Exact normalized tag matching. Precision excludes pending/uncertain. Human additions reveal omissions but do not define exhaustive recall. Model confidence is not accuracy.',
  };
}
