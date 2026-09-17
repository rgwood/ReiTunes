import { describe, expect, it } from 'vitest';
import { emptyReview, exportReview, mergeReviews, normalizeTag, parseReview, scoreRun } from './review';
import type { Experiment, Review, Run } from './review';

const review: Review = { schema_version: 1, items: { song: { notes: 'Needs the whole set', uncertain: true, labels: {
  house: { tag: 'house', verdict: 'accepted', updated_at: '2026-09-17T00:00:00Z', origin: 'human' },
  instrumental: { tag: 'instrumental', verdict: 'uncertain', updated_at: '2026-09-17T00:00:00Z', origin: 'human' },
} } } };
const run: Run = { id: 'run-a', model: 'test', prompt_version: 'v1', harness_version: 'v1', repeat: 1, latency_seconds: 1, cost_usd: 0.01,
  predictions: [{ id: 'song', uncertainty: '', tags: ['house', 'instrumental', 'high energy'].map(tag => ({ tag, basis: 'inference', confidence: 0.8, evidence: 'Test' })) }] };

describe('human review data', () => {
  it('round-trips independently of model output and excludes uncertainty from precision', () => {
    expect(parseReview(JSON.parse(JSON.stringify(review)))).toEqual(review);
    expect(scoreRun(run, review)).toEqual({ accepted: 1, rejected: 0, uncertain: 1, pending: 1, judged: 1, precision: 1 });
    expect(scoreRun(run, emptyReview()).precision).toBeNull();
    expect(normalizeTag(' High Energy ')).toBe('high-energy');
  });
  it('preserves existing edits on import and adds previously unseen labels', () => {
    const incoming = structuredClone(review);
    incoming.items.song.labels.house.verdict = 'rejected';
    incoming.items.song.labels.house.reason = 'An older interpretation';
    incoming.items.song.notes = 'Old note';
    incoming.items.song.labels.jazz = { ...incoming.items.song.labels.house, tag: 'jazz' };
    const merged = mergeReviews(review, incoming);
    expect(merged.items.song.labels.house.verdict).toBe('accepted');
    expect(merged.items.song.labels.house.reason).toBeUndefined();
    expect(merged.items.song.labels.jazz.verdict).toBe('rejected');
    expect(merged.items.song.labels.jazz.reason).toBe('An older interpretation');
    expect(merged.items.song.notes).toBe('Needs the whole set');
    expect(review.items.song.labels.jazz).toBeUndefined();
  });
  it('round-trips optional per-tag reasons without changing old labels or scores', () => {
    const explained = structuredClone(review);
    explained.items.song.labels.house.reason = 'The steady kick is audible throughout.\nNot just an artist genre.';
    const restored = parseReview(JSON.parse(JSON.stringify(explained)));
    expect(restored).toEqual(explained);
    expect(restored.items.song.labels.instrumental.reason).toBeUndefined();
    expect(scoreRun(run, restored)).toEqual(scoreRun(run, review));
    for (const reason of [null, 123, {}, []]) {
      const bad = JSON.parse(JSON.stringify(explained));
      bad.items.song.labels.house.reason = reason;
      expect(() => parseReview(bad)).toThrow('Invalid label reason');
    }
  });
  it('rejects malformed imports and prototype keys before replacing anything', () => {
    for (const bad of [null, {}, { ...review, schema_version: 2 }, { schema_version: 1, items: { song: { notes: '', uncertain: false, labels: { foo: { verdict: 'accepted' } } } } },
      JSON.parse('{"schema_version":1,"items":{"__proto__":{"notes":"","uncertain":false,"labels":{}}}}')]) {
      expect(() => parseReview(bad)).toThrow();
    }
    const bad = structuredClone(review); bad.items.song.labels.house.updated_at = 'yesterday';
    expect(() => parseReview(bad)).toThrow();
  });
  it('exports model provenance and labels for scoring future experiments', () => {
    const experiment: Experiment = { schema_version: 1, id: 'dataset', created_at: '', evidence_mode: 'metadata-only', sample_method: 'test', items: [], runs: [run] };
    const exported = exportReview(experiment, review);
    expect(exported.experiment.runs[0].id).toBe('run-a');
    expect(exported.human_review).toEqual(review);
    expect(exported.scores[0].accepted).toBe(1);
  });
});
