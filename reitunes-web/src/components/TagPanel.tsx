import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { LibraryItem } from '../types';
import { tagsRequest, normalizeLibraryTag, tagProgress } from '../hooks/useTags';
import type { ItemTags, TagLabel, TagSnapshot, TagSuggestion, TagVerdict } from '../hooks/useTags';
import './Tags.css';

function TagDecision({ itemId, tag, label, suggestion, refresh, onFilterTag }: {
  itemId: string; tag: string; label?: TagLabel; suggestion?: TagSuggestion; refresh: () => Promise<void>; onFilterTag: (tag: string) => void;
}) {
  const removed = label?.verdict === 'rejected' || label?.verdict === 'uncertain';
  const [reason, setReason] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [feedbackOpen, setFeedbackOpen] = useState(removed || !!label?.reason);
  const feedback = reason ?? label?.reason ?? '';
  const dirty = reason !== null && reason !== (label?.reason ?? '');
  async function save(verdict: TagVerdict, message: string) {
    setBusy(true); setError(''); setNotice('');
    try {
      await tagsRequest(`/items/${itemId}/labels`, { tag, verdict, reason: feedback }, 'PUT');
      await refresh(); setReason(null); setNotice(message);
      if (verdict !== 'accepted') setFeedbackOpen(true);
    } catch (error) { setError(error instanceof Error ? error.message : 'Could not save tag'); }
    finally { setBusy(false); }
  }
  const basis = suggestion && ({
    inference: 'AI inferred this from metadata.',
    metadata: 'AI based this on the song’s metadata.',
    database: 'AI based this on MusicBrainz metadata.',
  }[suggestion.basis] || 'AI suggested this from metadata.');
  return <article className="library-tag-decision" aria-label={`Tag ${tag}`}>
    <header className="tag-decision-heading">
      <button className="tag-link" aria-label={`Browse music tagged ${tag}`} onClick={() => onFilterTag(tag)}>{tag} ↗</button>
      {removed && <span className="tag-review-state">Removed</span>}
      <button className="tag-remove" disabled={busy} onClick={() => void save(removed ? 'accepted' : 'rejected', removed ? 'Tag restored.' : 'Tag removed.')} aria-label={`${removed ? 'Restore' : 'Remove'} tag ${tag}`}>{removed ? 'Restore' : 'Remove'}</button>
    </header>
    {suggestion && <details className="tag-ai-explanation">
      <summary>Why AI suggested this tag</summary>
      <div className="tag-ai-evidence">
        <p className="tag-basis">{basis}</p>
        <blockquote>{suggestion.evidence}</blockquote>
        {!!suggestion.sourceUrls?.length && <div className="tag-sources">{suggestion.sourceUrls.filter(url => /^https:\/\/musicbrainz\.org\//.test(url)).map(url => <a key={url} href={url} target="_blank" rel="noreferrer">MusicBrainz source ↗</a>)}</div>}
      </div>
    </details>}
    <details className="tag-feedback" open={feedbackOpen} onToggle={event => setFeedbackOpen(event.currentTarget.open)}>
      <summary>Your feedback <span className="tag-optional">(optional)</span></summary>
      <form onSubmit={event => { event.preventDefault(); void save(label?.verdict || 'accepted', 'Feedback saved.'); }}>
        <p className="tag-feedback-help">Your notes stay with this tag when you remove or restore it.</p>
        <label><span className="sr-only">Your feedback on {tag}</span><textarea disabled={busy} value={feedback} maxLength={2000} rows={2}
          onChange={event => { setReason(event.target.value); setNotice(''); }} placeholder={removed ? 'Why did you remove this tag?' : 'Your comments or corrections about this tag'} /></label>
        <div className="tag-feedback-actions">
          <button type="submit" disabled={busy || !dirty}>{busy ? 'Saving…' : 'Save feedback'}</button>
          {dirty && <button type="button" disabled={busy} onClick={() => { setReason(null); setError(''); }}>Cancel</button>}
          {!dirty && label?.reason && !notice && <span className="tag-feedback-saved">Saved</span>}
        </div>
      </form>
    </details>
    {notice && <p className="tag-save-notice" role="status">{notice}</p>}
    {error && <p role="alert">{error}</p>}
  </article>;
}

export function TagPanel({ item, snapshot, loading, loadError, onPlay, onFilterTag, onBrowse }: {
  item?: LibraryItem;
  onFilterTag: (tag: string) => void; onBrowse: () => void;
  snapshot?: TagSnapshot; loading: boolean; loadError: Error | null; onPlay: (item: LibraryItem) => void;
}) {
  const client = useQueryClient();
  const data: ItemTags | undefined = item && snapshot?.items[item.id];
  const [newTag, setNewTag] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const refresh = async () => { await client.invalidateQueries({ queryKey: ['tags'] }); };
  async function action(path: string, body?: unknown, method = 'POST') {
    setBusy(true); setError(''); setNotice('');
    try { await tagsRequest(path, body, method); await refresh(); setNotice(method === 'PUT' ? 'Tag saved' : ''); return true; }
    catch (error) { setError(error instanceof Error ? error.message : 'Could not update tags'); return false; }
    finally { setBusy(false); }
  }
  const allTags = [...new Set([...(data?.status === 'ready' ? data.tags : []).map(tag => tag.tag), ...Object.keys(data?.labels || {})])].sort();
  const active = data?.status === 'running' || data?.status === 'queued';
  return <section className="library-tags" aria-label="Library tags">
    <button className="tag-back" onClick={onBrowse}>← Browse all tags</button>
    <h2>Track tags</h2>
    {item ? <header className="tag-track-heading"><h3>{item.name}</h3><p>{[item.artist, item.album].filter(Boolean).join(' · ')}</p></header> : <p>Choose a track’s tag menu to add or remove tags.</p>}
    {loading && <p role="status">Loading tags…</p>}
    {loadError && <p role="alert">{loadError.message}</p>}
    {snapshot && !snapshot.enabled && <p>Automatic suggestions aren’t configured. You can still add tags.</p>}
    {item && <>
      <div className="tag-track-actions"><button onClick={() => onPlay(item)}>Listen</button><button className="tag-generate" disabled={busy || active || !snapshot?.enabled} onClick={() => void action(`/items/${item.id}/classify`)}>{busy ? 'Saving…' : active ? 'In progress' : data?.status === 'failed' ? 'Retry automatic tags' : data?.status === 'ready' ? 'Regenerate tags' : 'Generate tags for this track'}</button></div>
      <p className="tag-progress" role="status">{tagProgress(data)}</p>
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert">{error}</p>}
      {active && <p>Metadata lookup and generation can take a few minutes. You can keep browsing; this updates automatically.</p>}
      {data?.error && <p role="alert">{data.error}</p>}
      {data?.uncertainty && <p>{data.uncertainty}</p>}
      <form className="tag-add" onSubmit={event => { event.preventDefault(); const tag = normalizeLibraryTag(newTag); if (tag) void action(`/items/${item.id}/labels`, { tag, verdict: 'accepted', reason: data?.labels[tag]?.reason || '' }, 'PUT').then(saved => { if (saved) setNewTag(''); }); }}>
        <input aria-label="New library tag" placeholder="Add a tag" value={newTag} maxLength={60} onChange={event => setNewTag(event.target.value)} />
        <button disabled={busy || !newTag.trim()}>Add</button>
      </form>
      {allTags.map(tag => <TagDecision key={`${item.id}:${tag}`} itemId={item.id} tag={tag} label={data?.labels[tag]} suggestion={data?.status === 'ready' ? data.tags.find(t => t.tag === tag) : undefined} refresh={refresh} onFilterTag={onFilterTag} />)}
    </>}
    <footer className="tag-panel-footer">
      <p>Suggestions use metadata; no model has listened to the recording.</p>
    </footer>
  </section>;
}
