import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { LibraryItem } from '../types';
import { effectiveTags, tagProgress, tagsRequest, type TagSnapshot } from '../hooks/useTags';
import './Tags.css';

export function TagBrowser({ items, snapshot, showWork, onShowWork, onFilterTag, onEdit, loadError }: {
  items: LibraryItem[]; snapshot?: TagSnapshot;
  showWork: boolean; onShowWork: (show: boolean) => void;
  loadError: Error | null;
  onFilterTag: (tag: string) => void; onEdit: (item: LibraryItem) => void;
}) {
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [receipt, setReceipt] = useState<string[] | null>(null);
  const client = useQueryClient();
  const counts = new Map<string, number>();
  for (const item of items) for (const tag of effectiveTags(snapshot?.items[item.id])) counts.set(tag, (counts.get(tag) || 0) + 1);
  const sorted = [...items].sort((a, b) => b.created_time_utc.localeCompare(a.created_time_utc) || a.id.localeCompare(b.id));
  const candidates = sorted.filter(item => !snapshot?.items[item.id] || snapshot.items[item.id].status === 'stale').slice(0, 20);
  const recentIds = Object.keys(snapshot?.items || {}).sort((a, b) => (snapshot?.items[b]?.updatedAt || 0) - (snapshot?.items[a]?.updatedAt || 0)).slice(0, 20);
  const work = sorted.filter(item => ['running', 'queued', 'failed'].includes(snapshot?.items[item.id]?.status || '') || receipt?.includes(item.id) || recentIds.includes(item.id));
  const active = work.filter(item => ['running', 'queued'].includes(snapshot?.items[item.id]?.status || '')).length;
  const completed = receipt?.filter(id => snapshot?.items[id]?.status === 'ready').length || 0;
  const failed = receipt?.filter(id => snapshot?.items[id]?.status === 'failed').length || 0;
  async function suggest() {
    setBusy(true); setError('');
    try {
      const result = await tagsRequest<{ queued: number; itemIds: string[] }>('/queue', { itemIds: candidates.map(item => item.id) });
      setReceipt(result.itemIds);
      await client.invalidateQueries({ queryKey: ['tags'] });
    } catch (error) { setError(error instanceof Error ? error.message : 'Could not queue suggestions'); }
    finally { setBusy(false); }
  }
  const matchingTags = [...counts].sort(([a], [b]) => a.localeCompare(b)).filter(([tag]) => tag.includes(search.toLowerCase().trim()));
  return <section className="library-tags" aria-label="Browse tags">
    <h2>Tags</h2>
    {loadError && <p role="alert">{loadError.message}</p>}
    {!snapshot && !loadError && <p role="status">Loading tags…</p>}
    <div className="tag-browser-tabs"><button aria-pressed={!showWork} onClick={() => onShowWork(false)}>Browse tags</button><button aria-pressed={showWork} onClick={() => onShowWork(true)}>Automatic tags{active ? ` (${active})` : ''}</button></div>
    {!showWork ? <>
      <p>Choose a tag to see matching music across your whole library.</p>
      <input aria-label="Find a tag" placeholder="Find a tag…" value={search} onChange={event => setSearch(event.target.value)} />
      <p className="tag-help">Tags are applied automatically. Use a track’s tag menu to add or remove them.</p>
      <div className="tag-directory">{matchingTags.map(([tag, count]) => <button key={tag} onClick={() => onFilterTag(tag)} aria-label={`Browse music tagged ${tag}`}><span>{tag}</span><span>{count} {count === 1 ? 'track' : 'tracks'}</span></button>)}</div>
      {snapshot && !matchingTags.length && <p>{search ? 'No matching tags.' : 'No tags yet. Add a tag from a track’s tag menu, or open Automatic tags to generate some.'}</p>}
    </> : <>
      <h3>Automatic tags</h3>
      <p>Tags are added to your library automatically, with no review needed. Generate tags for new or changed tracks, newest first.</p>
      <button className="tag-generate" disabled={busy || !snapshot?.enabled || !candidates.length || active > 0} onClick={() => void suggest()}>{busy ? 'Adding tracks…' : `Generate for ${candidates.length} ${candidates.length === 1 ? 'track' : 'tracks'}`}</button>
      {snapshot && !snapshot.enabled && <p>Automatic suggestions aren’t configured. You can still add tags manually.</p>}
      {active > 0 && <p>Metadata lookup and generation can take a few minutes. Progress updates automatically while you browse.</p>}
      {receipt && <p role="status">{receipt.length ? `${completed} of ${receipt.length} tracks ready${failed ? ` · ${failed} failed` : ''}.` : 'No tracks added; these tracks are already queued or have current results.'}</p>}
      {error && <p role="alert">{error}</p>}
      {work.length > 0 && <ul className="tag-work-list" aria-label="Suggestion progress">{work.map(item => <li key={item.id}><button onClick={() => onEdit(item)}>{item.name}<small>{item.artist}</small></button><span>{tagProgress(snapshot?.items[item.id])}</span></li>)}</ul>}
      {!active && candidates.length > 0 && <details><summary>Tracks included in the next batch ({candidates.length})</summary><ul className="tag-work-list">{candidates.map(item => <li key={item.id}><button onClick={() => onEdit(item)}>{item.name}<small>{item.artist}</small></button></li>)}</ul></details>}
      {!candidates.length && !active && <p>No new or changed tracks need suggestions. Failed tracks can be retried individually.</p>}
    </>}
  </section>;
}
