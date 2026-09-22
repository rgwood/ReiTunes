import { describe, expect, it } from 'vitest';
import { effectiveTags, normalizeLibraryTag } from './useTags';
import type { ItemTags } from './useTags';

describe('library tag filters', () => {
  const item: ItemTags = { status: 'ready', tags: ['house', 'vocal', 'energetic'].map(tag => ({ tag, confidence: .7, basis: 'inference', evidence: '', sourceUrls: [] })), labels: {
    vocal: { tag: 'vocal', verdict: 'rejected', reason: 'No singing' },
    energetic: { tag: 'energetic', verdict: 'uncertain', reason: 'Depends on the section' },
    instrumental: { tag: 'instrumental', verdict: 'accepted', reason: 'Listened' },
  } };
  it('uses human decisions over suggestions and can restrict to accepted tags', () => {
    expect(effectiveTags(item)).toEqual(['house', 'instrumental']);
    expect(effectiveTags(item, false)).toEqual(['instrumental']);
  });
  it('does not use stale predictions but preserves human labels', () => {
    expect(effectiveTags({ ...item, status: 'stale' })).toEqual(['instrumental']);
    expect(effectiveTags(undefined)).toEqual([]);
  });
  it('normalizes manual tags like the lab', () => { expect(normalizeLibraryTag(' High Energy ')).toBe('high-energy'); });
});
