import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { discoveryRequest, isInboxEntry, useDiscovery, type DiscoveryEntry, type DiscoverySource } from '../hooks/useDiscovery';
import { DownloadProgress } from './DownloadProgress';
import { NtsTracklist } from './NtsTracklist';
import { useDownloadJob, useDownloads } from '../hooks/useDownloads';
import { usePlayerStore } from '../stores/playerStore';
import { usePlaybackTargetStore } from '../stores/playbackTargetStore';
import { discoveryEmbed, mixDiscoverySources } from '../utils/discovery';
import { DiscoveryArtwork } from './DiscoveryArtwork';
import './Discover.css';

interface Preview {
  source: DiscoverySource;
  entries: DiscoveryEntry[];
}

type View = 'inbox' | 'saved' | 'sources' | 'all' | 'history';
type Sort = 'mixed' | 'found' | 'published' | 'shortest' | 'longest' | 'shuffle';
type Length = 'any' | 'short' | 'hour' | 'two-hours' | 'long';
const lengths: { value: Length; label: string }[] = [
  { value: 'any', label: 'Any length' }, { value: 'short', label: 'Under 30 min' }, { value: 'hour', label: '30–60 min' },
  { value: 'two-hours', label: '1–2 hours' }, { value: 'long', label: '2+ hours' },
];

function durationLabel(seconds: number | null) {
  if (seconds === null) return 'Duration unavailable';
  const minutes = Math.floor(seconds / 60);
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
}

function publishedLabel(date: string | null) {
  return date && /^\d{8}$/.test(date) ? `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}` : null;
}

function sameLabel(a: string, b: string) {
  return a.trim().replace(/\s+/g, ' ').toLocaleLowerCase() === b.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

function shuffleRank(id: string, seed: number) {
  let hash = 2166136261 ^ seed;
  for (const char of id) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  hash = Math.imul(hash ^ (hash >>> 16), 2246822507);
  return (hash ^ (hash >>> 13)) >>> 0;
}

function isSavedEntry(entry: DiscoveryEntry) {
  return Boolean(entry.saved) && !entry.libraryItemId && !entry.importCompleted;
}

function WatchImport({ id }: { id: number }) { useDownloadJob(id); return null; }

function isNtsEpisode(input: string) {
  try {
    const url = new URL(input);
    return url.protocol === 'https:' && ['nts.live', 'www.nts.live'].includes(url.hostname)
      && !url.username && !url.password && !url.port
      && /^\/shows\/[a-zA-Z0-9_-]{1,200}\/episodes\/[a-zA-Z0-9_-]{1,200}\/?$/.test(url.pathname);
  } catch {
    return false;
  }
}

export function Discover({ searchQuery, onOpenLibrary, pauseForPreview }: {
  searchQuery: string; onOpenLibrary: (id: string) => void; pauseForPreview: () => Promise<boolean>;
}) {
  const { data, isLoading, error: loadError, refetch } = useDiscovery();
  const queryClient = useQueryClient();
  const [view, changeView] = useState<View>('inbox');
  const [sourceId, setSourceId] = useState('');
  const [length, setLength] = useState<Length>('any');
  const [sort, setSort] = useState<Sort>('mixed');
  const [shuffleSeed, setShuffleSeed] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [listeningId, setListeningId] = useState<string | null>(null);
  const [preparingId, setPreparingId] = useState<string | null>(null);
  const previewRequest = useRef(0);
  const pausingForPreview = useRef(false);
  const selectedRow = useRef<HTMLElement | null>(null);
  const [showFollow, setShowFollow] = useState(false);
  const [url, setUrl] = useState('');
  const [minMinutes, setMinMinutes] = useState('30');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [undoEntry, setUndoEntry] = useState<DiscoveryEntry | null>(null);
  const jobs = useDownloads(state => state.jobs);
  const sources = data?.sources ?? [];
  const hasFollowedSource = (entry: DiscoveryEntry) => entry.sources.some(id => sources.some(source => source.id === id));
  const entries = (data?.entries ?? []).filter(entry => hasFollowedSource(entry) || entry.saved || entry.status !== 'new' || entry.libraryItemId);
  const selectedSource = sources.find(source => source.id === sourceId);
  const inboxCount = entries.filter(entry => hasFollowedSource(entry) && isInboxEntry(entry)).length;
  const savedCount = entries.filter(isSavedEntry).length;
  const importCandidates = entries.filter(entry => entry.status === 'queued' && !entry.libraryItemId && !entry.importCompleted);
  const imports = importCandidates.filter(entry => jobs.find(job => job.id === entry.downloadJobId)?.stage !== 'completed')
    .sort((a, b) => (b.downloadJobId ?? 0) - (a.downloadJobId ?? 0) || b.discoveredAt - a.discoveredAt || a.id.localeCompare(b.id));
  const hasActivity = view !== 'history' && imports.length > 0;
  const failedImports = imports.filter(entry => !entry.downloadJobId || jobs.find(job => job.id === entry.downloadJobId)?.stage === 'failed');
  const selectedEntry = entries.find(entry => entry.id === selectedId);
  const selectedEmbed = selectedEntry ? discoveryEmbed(selectedEntry) : null;

  useEffect(() => {
    if (!notice) return;
    const timeout = setTimeout(() => { setNotice(''); setUndoEntry(null); }, undoEntry ? 15_000 : 7_000);
    return () => clearTimeout(timeout);
  }, [notice, undoEntry]);
  useEffect(() => {
    const requestState = previewRequest;
    const stop = () => { previewRequest.current++; setListeningId(null); setPreparingId(null); };
    const unsubscribePlayer = usePlayerStore.subscribe((state, previous) => {
      if (state.isPlaying && !previous.isPlaying || state.currentItemId !== previous.currentItemId) stop();
    });
    const unsubscribeOutput = usePlaybackTargetStore.subscribe((state, previous) => {
      if (state.target !== previous.target || state.isSending && !previous.isSending || state.isTransportPending && !previous.isTransportPending && !pausingForPreview.current) stop();
    });
    return () => { requestState.current++; unsubscribePlayer(); unsubscribeOutput(); };
  }, []);

  function selectEntry(entry: DiscoveryEntry, row?: HTMLElement) {
    if (row) selectedRow.current = row;
    if (entry.id !== selectedId) { previewRequest.current++; setListeningId(null); setPreparingId(null); }
    setSelectedId(entry.id);
  }
  function closeDetails() {
    previewRequest.current++; setSelectedId(null); setListeningId(null); setPreparingId(null);
    selectedRow.current?.focus();
  }
  function setView(next: View) {
    previewRequest.current++; setSelectedId(null); setListeningId(null); setPreparingId(null); changeView(next);
  }
  async function listen(entry: DiscoveryEntry) {
    if (pausingForPreview.current) return;
    selectEntry(entry);
    if (!discoveryEmbed(entry)) return;
    const request = ++previewRequest.current;
    setPreparingId(entry.id); setListeningId(null); setError('');
    // Pausing may update the output store; only this explicit request may start a preview.
    try {
      pausingForPreview.current = true;
      const paused = await pauseForPreview();
      if (request !== previewRequest.current) return;
      if (!paused) throw new Error('Could not pause the current player. Pause it, then try Listen again.');
      setListeningId(entry.id);
    } catch (error) { if (request === previewRequest.current) setError(error instanceof Error ? error.message : 'Could not start the preview.'); }
    finally { pausingForPreview.current = false; if (request === previewRequest.current) setPreparingId(null); }
  }

  async function act(key: string, operation: () => Promise<void>) {
    setBusy(key);
    setError('');
    setNotice('');
    setUndoEntry(null);
    try {
      await operation();
      await queryClient.invalidateQueries({ queryKey: ['discovery'] });
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Something went wrong. Please retry.');
    } finally {
      setBusy(null);
    }
  }

  function previewSource(event: FormEvent) {
    event.preventDefault();
    void act('preview', async () => {
      setPreview(null);
      setPreview(await discoveryRequest<Preview>('/preview', { url, minMinutes: Number(minMinutes) }));
    });
  }

  function showHistory() {
    setView('history'); setSourceId(''); setLength('any');
  }

  const matchingEntries = entries.filter(entry => {
    if (sourceId && !entry.sources.includes(sourceId)) return false;
    const sourceTitles = sources.filter(source => entry.sources.includes(source.id)).map(source => source.title);
    const matchesSearch = `${entry.title} ${entry.uploader} ${sourceTitles.join(' ')} ${(entry.genres ?? []).join(' ')} ${entry.description ?? ''}`.toLowerCase().includes(searchQuery.toLowerCase());
    if (!matchesSearch) return false;
    if (length !== 'any') {
      if (entry.duration === null) return false;
      if (length === 'short' && entry.duration >= 1800) return false;
      if (length === 'hour' && (entry.duration < 1800 || entry.duration >= 3600)) return false;
      if (length === 'two-hours' && (entry.duration < 3600 || entry.duration >= 7200)) return false;
      if (length === 'long' && entry.duration < 7200) return false;
    }
    if (view === 'inbox') return hasFollowedSource(entry) && isInboxEntry(entry);
    if (view === 'saved') return isSavedEntry(entry);
    if (view === 'history') return entry.status !== 'new' || Boolean(entry.libraryItemId);
    return true;
  });
  const sortedEntries = matchingEntries.filter(entry => view === 'history' || entry.status !== 'queued' || entry.libraryItemId || entry.importCompleted)
    .sort((a, b) => {
      const fallback = a.title.localeCompare(b.title) || a.id.localeCompare(b.id);
      if (sort === 'shuffle') return shuffleRank(a.id, shuffleSeed) - shuffleRank(b.id, shuffleSeed) || fallback;
      if (sort === 'shortest' || sort === 'longest') {
        if (a.duration === null) return b.duration === null ? fallback : 1;
        if (b.duration === null) return -1;
        return (sort === 'shortest' ? a.duration - b.duration : b.duration - a.duration) || fallback;
      }
      if (sort === 'published') return (b.published ?? '').localeCompare(a.published ?? '') || b.discoveredAt - a.discoveredAt || fallback;
      return b.discoveredAt - a.discoveredAt || fallback;
    });
  const visibleEntries = sort === 'mixed' ? mixDiscoverySources(sortedEntries) : sortedEntries;

  function importControls(entry: DiscoveryEntry) {
    if (entry.libraryItemId) return <button onClick={() => onOpenLibrary(entry.libraryItemId!)}>In library</button>;
    if (entry.importCompleted || jobs.find(job => job.id === entry.downloadJobId)?.stage === 'completed') return <span className="discovery-completed">✓ Added to library</span>;
    if (entry.downloadJobId) return <DownloadProgress key={entry.downloadJobId} id={entry.downloadJobId}
      canRestore={hasFollowedSource(entry)}
      onRestore={async () => {
        await discoveryRequest(`/entries/${entry.id}/restore`);
        await queryClient.invalidateQueries({ queryKey: ['discovery'] });
        setView('inbox'); setSourceId(''); setLength('any'); setNotice(`Returned “${entry.title}” to the inbox.`);
      }}
      onRetry={async () => {
        await discoveryRequest(`/entries/${entry.id}/import`);
        await queryClient.invalidateQueries({ queryKey: ['discovery'] });
      }} />;
    if (entry.status === 'queued') return <div className="discovery-recovery">
      <span className="discovery-queued">Sent to downloader</span>
      <p>No progress was saved for this import. If it failed, you can resend it{hasFollowedSource(entry) ? ' or return it to your inbox' : ''}.</p>
      <div className="discovery-actions">
        <button disabled={Boolean(busy)} onClick={() => void act(entry.id, async () => {
          await discoveryRequest(`/entries/${entry.id}/import`);
          setNotice(`Resent “${entry.title}” to the downloader.`);
        })}>{busy === entry.id ? 'Sending…' : 'Resend to downloader'}</button>
        {hasFollowedSource(entry) && <button disabled={Boolean(busy)} onClick={() => void act(entry.id, async () => {
          await discoveryRequest(`/entries/${entry.id}/restore`);
          setView('inbox'); setSourceId(''); setLength('any'); setNotice(`Returned “${entry.title}” to the inbox.`);
        })}>Return to inbox</button>}
      </div>
    </div>;
    if (entry.canImport === false) return <span className="discovery-unavailable">No downloadable audio available for this episode.</span>;
    return <button className="discovery-import" disabled={Boolean(busy)} onClick={() => void act(entry.id, async () => {
      await discoveryRequest(`/entries/${entry.id}/import`);
      setNotice(`Adding “${entry.title}” to your library. You can keep browsing.`);
    })}>{busy === entry.id ? 'Adding…' : entry.status === 'import_failed' ? 'Retry import' : 'Add to library'}</button>;
  }

  return (
    <section className="discovery" aria-label="Discover sets">
      <header className="discovery-heading">
        <h1 className="sr-only">Discover</h1>
        <nav className="discovery-tabs" aria-label="Discovery views">
          <button aria-pressed={view === 'inbox'} onClick={() => setView('inbox')}>Inbox{inboxCount > 0 ? ` (${inboxCount})` : ''}</button>
          <button aria-pressed={view === 'saved'} onClick={() => setView('saved')}>Listen later ({savedCount})</button>
          <button aria-pressed={view === 'all'} onClick={() => setView('all')}>All sets</button>
          <button aria-pressed={view === 'sources'} onClick={() => setView('sources')}>Sources{sources.length > 0 ? ` (${sources.length})` : ''}</button>
          <button aria-pressed={view === 'history'} onClick={() => setView('history')}>History</button>
        </nav>
        <div className="discovery-actions">
          <button onClick={() => setShowFollow(!showFollow)} aria-expanded={showFollow}>Follow a source</button>
          <button disabled={Boolean(busy) || data?.refreshing || !sources.length}
            onClick={() => void act('refresh', async () => { await discoveryRequest('/refresh'); setNotice('Refresh requested. See Sources for check times and errors.'); })}>
            {data?.refreshing ? 'Checking sources…' : 'Refresh'}
          </button>
        </div>
      </header>

      {showFollow && (
        <form className="discovery-follow" onSubmit={previewSource}>
          <div className="discovery-follow-fields">
            <label className="discovery-url">Source URL
              <input type="url" required placeholder="YouTube channel, SoundCloud profile or NTS show"
                value={url} disabled={Boolean(busy)} onChange={event => { setUrl(event.target.value); setPreview(null); }} />
            </label>
            <label>Minimum minutes
              <input type="number" required min="0" max="1440" step="1" value={minMinutes} disabled={Boolean(busy)}
                onChange={event => { setMinMinutes(event.target.value); setPreview(null); }} />
            </label>
            <button type="submit" disabled={Boolean(busy) || data?.refreshing}>{busy === 'preview' ? 'Reading source…' : 'Preview source'}</button>
            <button type="button" disabled={Boolean(busy)} onClick={() => { setShowFollow(false); setPreview(null); }}>Cancel</button>
          </div>
          {preview && (
            <div className="discovery-preview">
              <h2>{preview.source.title}</h2>
              <p>{preview.entries.length} matching sets · The first {Math.min(10, preview.entries.length)} will appear in your inbox. Find the rest in All sets.</p>
              {preview.entries.length > 0 ? <ul>{preview.entries.slice(0, 10).map(entry => (
                <li key={entry.id}><span>{entry.title}</span><span>{durationLabel(entry.duration)}</span></li>
              ))}</ul> : <p>No matching sets in this batch. You can still follow this source for future uploads.</p>}
              <button type="button" disabled={Boolean(busy)} onClick={() => void act('follow', async () => {
                await discoveryRequest('/sources', { url: preview.source.url, minMinutes: preview.source.minMinutes });
                setShowFollow(false); setPreview(null); setUrl(''); setView('inbox'); setSourceId(''); setLength('any');
                setNotice(`Following ${preview.source.title}. Sources refresh every 3 hours while the server is running.`);
              })}>{busy === 'follow' ? 'Following…' : 'Follow this source'}</button>
            </div>
          )}
        </form>
      )}

      {error && <p className="discovery-error" role="alert">{error}</p>}
      {notice && <div className="discovery-notice" role="status"><span>{notice}</span>{undoEntry && <button disabled={Boolean(busy)} onClick={() => void act(undoEntry.id, async () => {
        await discoveryRequest(`/entries/${undoEntry.id}/restore`); setNotice(`Returned “${undoEntry.title}” to the inbox.`);
      })}>Undo</button>}<button aria-label="Dismiss notification" onClick={() => { setNotice(''); setUndoEntry(null); }}>×</button></div>}

      {importCandidates.map(entry => entry.downloadJobId ? <WatchImport key={entry.downloadJobId} id={entry.downloadJobId} /> : null)}
      {!loadError && hasActivity && <section className="discovery-activity" aria-label="Import activity">
        <span>{imports.length - failedImports.length > 0 && `${imports.length - failedImports.length} adding to library`}
          {failedImports.length > 0 && `${imports.length > failedImports.length ? ' · ' : ''}${failedImports.length} need attention`}</span>
        <button onClick={showHistory}>View progress</button>
      </section>}

      {loadError ? <p className="discovery-error" role="alert">Could not load discovery. <button onClick={() => void refetch()}>Retry</button></p>
        : isLoading ? <p role="status">Loading discovery…</p>
        : !sources.length && (view === 'inbox' || view === 'sources' || !entries.length) ? <div className="discovery-empty"><h2>No sources yet</h2><p>Follow a YouTube channel, SoundCloud profile or NTS show.</p><button onClick={() => setShowFollow(true)}>Add your first source</button></div>
        : view === 'sources' ? <div className="discovery-sources">{sources.map(source => {
          const sourceEntries = entries.filter(entry => entry.sources.includes(source.id));
          const sourceInbox = sourceEntries.filter(isInboxEntry).length;
          return <article key={source.id} className="discovery-source">
            <div className="discovery-source-heading"><h2><a href={source.url} target="_blank" rel="noopener noreferrer">{source.title} ↗</a></h2><span className="discovery-provider">{source.provider}</span></div>
            <p>{sourceInbox} in inbox · {sourceEntries.length} {sourceEntries.length === 1 ? 'set' : 'sets'} found · {source.minMinutes ? `At least ${source.minMinutes} minutes` : 'Any duration'}</p>
            <p>{source.lastChecked ? `Last checked ${new Date(source.lastChecked * 1000).toLocaleString()}` : 'Not checked yet'}</p>
            {source.error && <p className="discovery-error" role="alert">{source.error}</p>}
            <div className="discovery-actions">
              <button onClick={() => { setSourceId(source.id); setView('all'); setLength('any'); }}>Browse sets</button>
              <button disabled={Boolean(busy)} onClick={() => void act(source.id, async () => {
                await discoveryRequest(`/sources/${source.id}`, undefined, 'DELETE');
                if (sourceId === source.id) setSourceId('');
                setNotice(`Unfollowed ${source.title}. Imported music stays in your library.`);
              })}>Unfollow</button>
            </div>
          </article>;
        })}</div> : <>
          {sources.some(source => source.error) && <p className="discovery-error">Some sources could not refresh. <button onClick={() => setView('sources')}>See source errors</button></p>}
          <div className="discovery-browse">
            <div className="discovery-browse-selects">
              <select aria-label="Filter by source" value={sourceId} onChange={event => setSourceId(event.target.value)}>
                <option value="">All sources</option>
                {sources.map(source => <option key={source.id} value={source.id}>{source.title}</option>)}
              </select>
              <select aria-label="Filter by duration" value={length} onChange={event => setLength(event.target.value as Length)}>
                {lengths.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
              <select aria-label="Sort sets" value={sort} onChange={event => setSort(event.target.value as Sort)}>
                <option value="mixed">Mixed sources</option><option value="published">Newest release</option><option value="found">Recently found</option>
                <option value="shortest">Shortest first</option><option value="longest">Longest first</option><option value="shuffle">Shuffled</option>
              </select>
              <button onClick={() => { setShuffleSeed(seed => seed + 1); setSort('shuffle'); }}>{sort === 'shuffle' ? 'Shuffle again' : 'Shuffle'}</button>
            </div>
            {(view !== 'inbox' || visibleEntries.length !== inboxCount) && <span className="discovery-result-count">{visibleEntries.length} {visibleEntries.length === 1 ? 'set' : 'sets'}</span>}
          </div>
          {view === 'saved' && <p className="discovery-view-help">Your listening shortlist. Nothing downloads until you choose Add to library.</p>}
          {!visibleEntries.length && <div className="discovery-empty"><h2>{searchQuery || sourceId || length !== 'any' ? 'No matching sets' : view === 'inbox' ? 'You’re all caught up' : view === 'saved' ? 'Nothing saved for later' : 'Nothing here yet'}</h2><p>{view === 'saved' ? 'Choose Listen later on a set to keep it here without downloading.'
            : view === 'inbox' ? 'Check your sources or browse All sets for something older.' : 'Sets you import or dismiss stay in History.'}</p>
            {(sourceId || length !== 'any') && <button onClick={() => { setSourceId(''); setLength('any'); }}>Clear filters</button>}
            {!searchQuery && !sourceId && length === 'any' && (view === 'inbox' || view === 'saved') && <button onClick={() => setView('all')}>Explore all sets</button>}
          </div>}
          <div className="discovery-workspace"><div className="discovery-entries" aria-label="Discovered sets">{visibleEntries.map((entry, index) => {
            const entrySources = sources.filter(source => entry.sources.includes(source.id));
            const published = publishedLabel(entry.published);
            const uploader = [entry.title, ...entrySources.map(source => source.title)].some(label => sameLabel(label, entry.uploader)) ? '' : entry.uploader;
            const provider = isNtsEpisode(entry.url) ? 'NTS' : entrySources[0]?.provider ?? discoveryEmbed(entry)?.provider ?? 'Source';
            return <article className="discovery-entry" key={entry.id} data-entry-id={entry.id} data-selected={selectedId === entry.id || undefined}
              tabIndex={selectedId === entry.id || !selectedId && index === 0 ? 0 : -1}
              onClick={event => { if (!(event.target as HTMLElement).closest('button, a')) { selectEntry(entry, event.currentTarget); event.currentTarget.focus(); } }}
              onDoubleClick={event => { if (!(event.target as HTMLElement).closest('button, a')) void listen(entry); }}
              onKeyDown={event => {
                if (event.target !== event.currentTarget) return;
                if (event.key === 'Enter') { event.preventDefault(); void listen(entry); }
                if (event.key === 'Escape') { event.preventDefault(); closeDetails(); }
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  event.preventDefault(); const next = visibleEntries[index + (event.key === 'ArrowDown' ? 1 : -1)];
                  const row = event.key === 'ArrowDown' ? event.currentTarget.nextElementSibling : event.currentTarget.previousElementSibling;
                  if (next && row instanceof HTMLElement) { selectEntry(next, row); row.focus(); row.scrollIntoView({ block: 'nearest' }); }
                }
              }}>
              <button className="discovery-artwork" disabled={!!preparingId} aria-label={`Listen to ${entry.title}`} title="Listen before adding to your library" onClick={event => {
                selectedRow.current = event.currentTarget.closest('article'); void listen(entry);
              }}><DiscoveryArtwork entry={entry} provider={provider} /><span className="discovery-artwork-play" aria-hidden="true">▶</span></button>
              <div className="discovery-entry-info">
                <h2><button title={entry.title} onClick={event => selectEntry(entry, event.currentTarget.closest('article')!)} onDoubleClick={() => void listen(entry)}>{entry.title}</button></h2>
                <div className="discovery-entry-meta">
                  {uploader && <span>{uploader}</span>}
                  {entrySources.map(source => <button key={source.id} aria-label={`Browse ${source.title}`} title={`Browse ${source.title}`} onClick={() => { setSourceId(source.id); setView('all'); setLength('any'); }}>{sameLabel(source.title, entry.title) ? source.provider : source.title}</button>)}
                  <span>{published || provider}</span>
                </div>
                <p className="discovery-description">{entry.description || entry.genres?.join(' · ')}</p>
              </div>
              <span className="discovery-duration">{durationLabel(entry.duration)}</span>
              <div className="discovery-entry-actions">
                {importControls(entry)}
                {!entry.libraryItemId && !entry.importCompleted && <button aria-label={entry.saved ? 'Remove from Listen later' : 'Listen later'} title={entry.saved ? 'Remove from your shortlist' : 'Keep on your shortlist without downloading'} aria-pressed={Boolean(entry.saved)} className="discovery-save" disabled={Boolean(busy)} onClick={() => void act(`save-${entry.id}`, async () => {
                  await discoveryRequest(`/entries/${entry.id}/save`, { saved: !entry.saved });
                  setNotice(entry.saved ? `Removed “${entry.title}” from Listen later.` : `Kept “${entry.title}” in Listen later. Nothing downloaded.`);
                })}>{entry.saved ? '✓ Later' : 'Listen later'}</button>}
                {entry.status === 'dismissed' ? hasFollowedSource(entry) && <button disabled={Boolean(busy)} onClick={() => void act(entry.id, async () => { await discoveryRequest(`/entries/${entry.id}/restore`); setNotice('Returned to inbox.'); })}>Restore</button>
                  : hasFollowedSource(entry) && entry.status !== 'queued' && !entry.libraryItemId && <button className="discovery-dismiss" aria-label="Dismiss" title="Dismiss this set" disabled={Boolean(busy)} onClick={() => void act(entry.id, async () => {
                    await discoveryRequest(`/entries/${entry.id}/dismiss`); setNotice(`Dismissed “${entry.title}”.`); setUndoEntry(entry);
                  })}>×</button>}
              </div>
            </article>;
          })}</div>
          {selectedEntry && <aside className="discovery-details" aria-label="Set details" onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); closeDetails(); } }}>
            <header><span>{listeningId ? 'Listening · This device' : 'Set details'}</span><button aria-label="Close details" onClick={closeDetails}>×</button></header>
            <h2>{selectedEntry.title}</h2>
            <p>{[selectedEntry.uploader, durationLabel(selectedEntry.duration), publishedLabel(selectedEntry.published)].filter(Boolean).join(' · ')}</p>
            <div className="discovery-detail-actions">
              {selectedEmbed && listeningId !== selectedEntry.id && <button className="discovery-listen" disabled={!!preparingId} onClick={() => void listen(selectedEntry)}>{preparingId ? 'Pausing player…' : 'Listen here'}</button>}
              <a href={selectedEntry.url} target="_blank" rel="noopener noreferrer">Open on {isNtsEpisode(selectedEntry.url) ? 'NTS' : sources.find(source => selectedEntry.sources.includes(source.id))?.provider ?? selectedEmbed?.provider ?? 'source'} ↗</a>
            </div>
            {listeningId === selectedEntry.id && selectedEmbed && <div className="discovery-player">
              <iframe key={selectedEntry.id} title={`Listen to ${selectedEntry.title}`} src={selectedEmbed.url} allow="autoplay; encrypted-media; fullscreen; picture-in-picture" allowFullScreen referrerPolicy="strict-origin-when-cross-origin" />
              <p>Preview plays on this device. If it won’t play here, use the source link above.</p>
            </div>}
            {!selectedEmbed && <p className="discovery-view-help">This set is available to listen to on its source page.</p>}
            <div className="discovery-detail-actions">{importControls(selectedEntry)}</div>
            {selectedEntry.genres?.length ? <p className="discovery-detail-genres">{selectedEntry.genres.join(' · ')}</p> : null}
            <h3>About this set</h3><p className="discovery-full-description">{selectedEntry.description || 'The source has not provided a description for this set.'}</p>
            {isNtsEpisode(selectedEntry.url) && <NtsTracklist entryId={selectedEntry.id} />}
            {selectedEntry.error && <p className="discovery-error" role="alert">{selectedEntry.error}</p>}
          </aside>}</div>
          {view === 'all' && selectedSource && <div className="discovery-archive-more">
            <button disabled={Boolean(busy) || data?.refreshing || selectedSource.archiveFinished} onClick={() => void act('archive', async () => {
              await discoveryRequest(`/sources/${selectedSource.id}/archive`); setNotice('Another batch requested. Older sets will appear here when ready.');
            })}>{selectedSource.archiveFinished ? 'All available entries fetched' : data?.refreshing ? 'Checking source…' : 'Load 50 more entries'}</button>
          </div>}
        </>}
    </section>
  );
}
