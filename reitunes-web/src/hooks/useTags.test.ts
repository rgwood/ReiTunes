import { QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyTagPatch, effectiveTags, fetchTagSnapshot, mergeTagPatch, normalizeLibraryTag } from './useTags';
import type { ItemTags, TagSnapshot } from './useTags';

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

describe('tag patches', () => {
  const tagged = (tag: string): ItemTags => ({ status: 'ready', tags: [{ tag, confidence: .8, basis: 'inference' }], labels: {} });
  const revision = (number: number, boot = 1) => ({ boot, number });
  const snapshot: TagSnapshot = { enabled: true, revision: revision(5), items: { a: tagged('folk'), b: tagged('jazz') } };

  it('updates and removes only the patched items', () => {
    const merged = mergeTagPatch(snapshot, { revision: revision(6), items: { a: tagged('house'), b: null, c: tagged('ambient') } });
    expect(merged.items).toEqual({ a: tagged('house'), c: tagged('ambient') });
    expect(snapshot.items.b).toBeDefined(); // not mutated
  });

  it('ignores patches older than what it already has', () => {
    expect(mergeTagPatch(snapshot, { revision: revision(4), items: { a: null } }).items.a).toEqual(tagged('folk'));
    const newer = mergeTagPatch(snapshot, { revision: revision(8), items: { a: tagged('house') } });
    // A late, older patch for the same item can't undo a newer one.
    expect(mergeTagPatch(newer, { revision: revision(7), items: { a: tagged('techno') } }).items.a).toEqual(tagged('house'));
    expect(mergeTagPatch(newer, { revision: revision(7), items: { b: null } }).items.b).toBeUndefined();
  });

  it('ignores patches from a different server run', () => {
    expect(mergeTagPatch(snapshot, { revision: revision(9, 2), items: { a: null } })).toBe(snapshot);
  });
});

describe('tag snapshot requests', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('replays patches that arrive while the snapshot is loading', async () => {
    let respond!: (body: TagSnapshot) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise(resolve => {
      respond = body => resolve(new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } }));
    })));
    const client = new QueryClient();
    const loading = client.fetchQuery({ queryKey: ['tags'], queryFn: fetchTagSnapshot });
    await vi.waitFor(() => expect(respond).toBeDefined());
    // Built before this change reached the database, but delivered after the patch.
    applyTagPatch(client, { revision: { boot: 1, number: 6 }, items: { a: null, c: { status: 'queued', tags: [], labels: {} } } });
    respond({ enabled: true, revision: { boot: 1, number: 5 }, items: { a: { status: 'ready', tags: [], labels: {} } } });
    const result = await loading;
    expect(Object.keys(result.items)).toEqual(['c']);
  });
});
