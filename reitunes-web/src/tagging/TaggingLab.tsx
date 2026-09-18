import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { emptyItemReview, emptyReview, exportReview, mergeReviews, normalizeTag, parseReview, scoreRun, STORAGE_KEY } from './review';
import type { Experiment, ItemReview, Review, Verdict } from './review';
import './tagging.css';

export default function TaggingLab() {
  const [experiment, setExperiment] = useState<Experiment>();
  const [review, setReview] = useState<Review>(emptyReview);
  const [error, setError] = useState('');
  const [storageBlocked, setStorageBlocked] = useState(false);
  const [status, setStatus] = useState('');
  const [selected, setSelected] = useState('');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [newTag, setNewTag] = useState('');
  const [blind, setBlind] = useState(false);
  const [showBaselines, setShowBaselines] = useState(false);
  const importRef = useRef<HTMLInputElement>(null);
  const addRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) setReview(parseReview(JSON.parse(saved)));
    } catch {
      setStorageBlocked(true);
      setError('Saved labels could not be loaded. They have not been overwritten. Export any new labels before closing this tab.');
    }
    const controller = new AbortController();
    fetch('/tagging-experiment.json', { cache: 'no-store', signal: controller.signal })
      .then(r => { if (!r.ok) throw new Error(); return r.json(); })
      .then((data: Experiment) => {
        if (data.schema_version !== 1 || !Array.isArray(data.items) || !Array.isArray(data.runs)) throw new Error();
        setExperiment(data); setSelected(data.items[0]?.id || '');
      }).catch(e => { if (e.name !== 'AbortError') setError('No archived experiment loaded. Current evals use the Rust tagging-eval CLI; see tagging-engine/README.md.'); });
    const changed = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY) {
        try { setReview(event.newValue ? parseReview(JSON.parse(event.newValue)) : emptyReview()); }
        catch { setError('Another tab saved invalid review data. Export this tab’s labels.'); }
      }
    };
    window.addEventListener('storage', changed);
    return () => { controller.abort(); window.removeEventListener('storage', changed); };
  }, []);

  function persist(update: (current: Review) => Review) {
    let current = review;
    try {
      if (!storageBlocked) {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved) current = parseReview(JSON.parse(saved));
      }
      const next = update(current);
      setReview(next);
      if (storageBlocked) { setStatus('Changes kept in this tab only — export to save'); return; }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      setStatus('Saved in this browser');
    } catch {
      setReview(update(current));
      setStorageBlocked(true);
      setError('Browser storage is unavailable or full. Changes remain in this tab; export to save them.');
    }
  }

  const items = experiment?.items.filter(item => {
    const textMatch = `${item.name} ${item.artist} ${item.album}`.toLowerCase().includes(query.toLowerCase());
    const ir = review.items[item.id];
    const tags = experiment.runs.flatMap(r => r.predictions.find(p => p.id === item.id)?.tags || []);
    return textMatch && (filter === 'all' || (filter === 'favorites' && item.is_favorite) ||
      (filter === 'uncertain' && (ir?.uncertain || Object.values(ir?.labels || {}).some(l => l.verdict === 'uncertain'))) ||
      (filter === 'pending' && (tags.length === 0 || tags.some(t => !ir?.labels[normalizeTag(t.tag)]))));
  }) || [];
  const item = items.find(i => i.id === selected) || items[0];
  const itemReview = item ? review.items[item.id] || emptyItemReview() : emptyItemReview();
  const allRuns = experiment?.runs || [];
  const latestBatch = allRuns[0]?.id.replace(/-\d+-\d+$/, '');
  const batchRuns = showBaselines ? allRuns : allRuns.filter(r => r.id.replace(/-\d+-\d+$/, '') === latestBatch);
  const runs = batchRuns.filter((run, index, all) => all.findIndex(r => r.model === run.model && r.harness_version === run.harness_version && r.reasoning?.effort === run.reasoning?.effort) === index);
  const attempts = [...(experiment?.runs || []), ...(experiment?.failed_attempts || [])];

  function updateItem(change: (current: ItemReview) => ItemReview) {
    if (!item) return;
    persist(current => ({ ...current, items: { ...current.items, [item.id]: change(current.items[item.id] || emptyItemReview()) } }));
  }
  function label(tag: string, verdict: Verdict) {
    const key = normalizeTag(tag);
    if (!key || key.length > 60 || ['__proto__', 'constructor', 'prototype'].includes(key)) return;
    updateItem(current => ({ ...current, labels: { ...current.labels, [key]: { ...current.labels[key], tag: key, verdict, origin: 'human', updated_at: new Date().toISOString() } } }));
  }
  function explainLabel(tag: string, reason: string) {
    const key = normalizeTag(tag);
    updateItem(current => {
      const existing = current.labels[key];
      if (!existing) return current;
      return { ...current, labels: { ...current.labels, [key]: { ...existing, reason, updated_at: new Date().toISOString() } } };
    });
  }
  function move(delta: number) {
    if (!item) return;
    const index = items.findIndex(i => i.id === item.id);
    setSelected(items[Math.max(0, Math.min(items.length - 1, index + delta))].id);
    setNewTag('');
  }
  function download() {
    if (!experiment) return;
    const blob = new Blob([JSON.stringify(exportReview(experiment, review), null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a'); link.href = url; link.download = `reitunes-labels-${new Date().toISOString().slice(0, 10)}.json`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setStatus('Export downloaded, including model provenance and human labels');
  }

  const onKeyDown = useEffectEvent((e: KeyboardEvent) => {
    if ((e.target as HTMLElement).closest('input, textarea, select, audio') || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'j' || e.key === 'k') { e.preventDefault(); move(e.key === 'j' ? 1 : -1); }
    if (e.key === 'a') { e.preventDefault(); addRef.current?.focus(); }
    if (e.key === '/') { e.preventDefault(); searchRef.current?.focus(); }
  });
  useEffect(() => {
    const listener = (event: KeyboardEvent) => onKeyDown(event);
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, []);

  return <main className="lab">
    <header><div><span className="eyebrow">REITUNES / EXPERIMENTS</span><h1>Tagging lab <span>01</span></h1></div>
      <div className="actions"><button onClick={() => setBlind(!blind)} aria-pressed={blind}>{blind ? 'Show models' : 'Hide model names'}</button><button onClick={() => importRef.current?.click()}>Import labels</button><button className="primary" onClick={download} disabled={!experiment}>Export review ↓</button></div>
    </header>
    <p className="intro">Listen, judge, correct. Suggestions use metadata{allRuns.some(r => r.evidence_mode === 'musicbrainz') ? ' and cached MusicBrainz evidence' : ''}{allRuns.some(r => r.evidence_mode === 'web-enabled') ? ' and, where marked, web sources' : ''} — no model has heard these recordings. Your labels stay separate from the library.</p>
    <label className="intro"><input type="checkbox" checked={showBaselines} onChange={e => setShowBaselines(e.target.checked)} /> Show earlier model and harness comparisons</label>
    <input ref={importRef} hidden type="file" accept="application/json,.json" onChange={async e => {
      const file = e.target.files?.[0]; if (!file) return;
      try {
        if (file.size > 10_000_000) throw new Error('Review file is too large');
        const data = JSON.parse(await file.text());
        const incoming = parseReview(data.human_review ?? data);
        persist(current => mergeReviews(current, incoming));
        setStatus('Imported labels; existing edits take precedence');
      } catch { setError('Import rejected: invalid review file. Existing labels are unchanged.'); }
      e.target.value = '';
    }} />
    {error && <div role="alert" className="error">{error} <button onClick={() => setError('')}>Dismiss</button></div>}
    <section className="metrics" aria-label="Experiment summary">
      <div><b>{experiment?.items.length ?? '—'}</b><span>library items</span></div>
      <div><b>{experiment ? attempts.length : '—'}</b><span>bounded model calls</span></div>
      <div><b>{attempts.length ? `$${attempts.reduce((n, r) => n + (r.cost_usd || 0), 0).toFixed(4)}${attempts.some(r => r.cost_usd == null) ? ' + unknown' : ''}` : '—'}</b><span>reported API cost</span></div>
      <div className="save-status" role="status">{status || 'Labels save in this browser. Export for a portable backup.'}</div>
    </section>
    {!!experiment?.failed_attempts?.length && <p className="uncertainty">{experiment.failed_attempts.length} failed or interrupted attempt(s) were excluded from suggestions. Available costs and failure details are included in the export.</p>}
    <div className="workspace">
      <aside><div className="filters"><input ref={searchRef} aria-label="Search sample" placeholder="Search sample  /" value={query} onChange={e => setQuery(e.target.value)} />
        <select aria-label="Filter sample" value={filter} onChange={e => setFilter(e.target.value)}><option value="all">All items</option><option value="pending">Needs review</option><option value="favorites">Favourites</option><option value="uncertain">Uncertain</option></select></div>
        <div className="item-list">{items.map((i, index) => <button key={i.id} className={`item ${i.id === item?.id ? 'selected' : ''}`} onClick={() => { setSelected(i.id); setNewTag(''); }} aria-current={i.id === item?.id ? 'true' : undefined}>
          <span className="ordinal">{String(index + 1).padStart(2, '0')}</span><span><strong>{i.name}</strong><small>{i.artist || 'Artist not set'}{i.is_favorite ? ' · ★ favourite' : ''}</small></span>
          <span className="review-count">{Object.keys(review.items[i.id]?.labels || {}).length || '·'}</span>
        </button>)}</div><p className="hint">j / k: next / previous · a: add tag<br />Tab between decisions; Enter to apply.</p>
      </aside>
      <section className="detail" aria-label="Item review">
        {!item ? <p>No items match this filter.</p> : <>
          <div className="item-heading"><div><span className="eyebrow">{item.is_favorite ? '★ FAVOURITE' : 'LIBRARY SAMPLE'} · IMPORTED {item.created_time_utc.slice(0, 10)}</span><h2>{item.name}</h2><p>{item.artist || 'Artist not set'}{item.album ? ` / ${item.album}` : ''}</p></div><div className="actions"><button onClick={() => move(-1)} aria-label="Previous item">↑</button><button onClick={() => move(1)} aria-label="Next item">↓</button></div></div>
          {item.url && <audio key={item.id} controls preload="none" src={item.url} aria-label="Listen to selected item" />}
          {item.musicbrainz && <details className="database-evidence"><summary>MusicBrainz evidence · {item.musicbrainz.recording_status.replaceAll('-', ' ')}</summary>
            {item.musicbrainz.recording && <p>{item.musicbrainz.recording.title} · {item.musicbrainz.recording.artist_credits.join(', ')}</p>}
            <p>{item.musicbrainz.identity_caveat || 'No confirmed recording identity. Artist metadata does not establish this recording’s sound.'}</p>
            {item.musicbrainz.artist && <p>Artist candidate: {item.musicbrainz.artist.name}. Community tags: {item.musicbrainz.artist.community_tags.join(', ') || 'none'}.</p>}
            <p>Unresolved: {item.musicbrainz.research_reasons.join(', ') || 'No additional research flags'}</p>
            <p>{item.musicbrainz.sources.filter(url => url.startsWith('https://musicbrainz.org/')).map((url, i) => <a key={url} href={url} target="_blank" rel="noreferrer">MusicBrainz source {i + 1} ↗ </a>)}</p>
          </details>}
          <div className="human-panel"><div className="section-heading"><h3>Your labels</h3><label><input type="checkbox" checked={itemReview.uncertain} onChange={e => updateItem(r => ({ ...r, uncertain: e.target.checked }))} /> Needs another listen</label></div>
            <div className="human-tags">{Object.values(itemReview.labels).map(l => <div key={l.tag} className="human-label"><span className={`human-tag ${l.verdict}`}>{l.verdict === 'accepted' ? '✓' : l.verdict === 'rejected' ? '×' : '?'} {l.tag}<button aria-label={`Reset ${l.tag}`} onClick={() => updateItem(r => { const labels = { ...r.labels }; delete labels[normalizeTag(l.tag)]; return { ...r, labels }; })}>↶</button></span><textarea rows={1} aria-label={`Reason for ${l.tag}`} placeholder="Reason for this label (optional)" value={l.reason ?? ''} onChange={e => explainLabel(l.tag, e.target.value)} /></div>)}{!Object.keys(itemReview.labels).length && <span className="muted">No judgments yet. Accept, reject or mark any suggestion uncertain.</span>}</div>
            <form onSubmit={e => { e.preventDefault(); label(newTag, 'accepted'); setNewTag(''); }}><input ref={addRef} aria-label="Add or correct tag" placeholder="Add a missing or corrected tag…" value={newTag} maxLength={60} onChange={e => setNewTag(e.target.value)} /><button type="submit" disabled={!newTag.trim()}>Add tag</button></form>
            <input className="notes" aria-label="Review notes" placeholder="Notes: what made this useful or misleading?" value={itemReview.notes} onChange={e => updateItem(r => ({ ...r, notes: e.target.value }))} />
          </div>
          {!runs.length && <p className="empty">Sample ready. Model runs are pending; you can already listen and add your own labels.</p>}
          <div className="model-columns">{runs.map((run, index) => {
            const prediction = run.predictions.find(p => p.id === item.id);
            const score = scoreRun(run, review);
            return <section key={run.id} className="model"><div className="section-heading"><h3>{blind ? `Model ${String.fromCharCode(65 + index)}` : run.model.split('/')[1]}</h3><small>{run.latency_seconds.toFixed(1)}s / batch</small></div>
              <div className="model-meta">{!blind && <>{run.provider || 'Unknown provider'} · </>}{run.harness_version} · {run.prompt_version}{run.reasoning ? ` · ${run.reasoning.effort} reasoning` : ''}<br />{score.judged} judged · {score.precision === null ? 'no quality score yet' : `${Math.round(score.precision * 100)}% accepted among judged`} · {score.pending} pending</div>
              {prediction?.tags.map(tag => {
                const verdict = itemReview.labels[normalizeTag(tag.tag)]?.verdict;
                return <article className={`suggestion ${verdict || ''}`} key={tag.tag}><div className="tag-heading"><strong>{tag.tag}</strong><span>{tag.basis} · {Math.round(tag.confidence * 100)}%</span></div><p>{tag.evidence}</p>
                  {(tag.basis === 'web' || tag.basis === 'database') && <p>{tag.sources_verified ? tag.source_urls?.filter(url => url.startsWith('https://')).map((url, i) => <a key={url} href={url} target="_blank" rel="noreferrer">Source {i + 1} ↗ </a>) : 'Citation does not match the supplied evidence — check before accepting.'}</p>}
                  <div className="decisions" aria-label={`Judge ${tag.tag}`}>
                    {(['accepted', 'rejected', 'uncertain'] as Verdict[]).map(v => <button key={v} aria-label={`${v === 'accepted' ? 'Accept' : v === 'rejected' ? 'Reject' : 'Uncertain'} ${tag.tag}`} aria-pressed={verdict === v} onClick={() => label(tag.tag, v)}>{v === 'accepted' ? '✓ Accept' : v === 'rejected' ? '× Reject' : '? Unsure'}</button>)}
                  </div></article>;
              })}
              <p className="uncertainty">{prediction?.uncertainty || 'No suggestions for this item.'}</p>
            </section>;
          })}</div>
        </>}
      </section>
    </div>
    <footer>{experiment?.sample_method} · Percentages on suggestions are model confidence, not accuracy. Repeat runs and full provenance are included in the export. Judgments apply to the same tag across models.</footer>
  </main>;
}
