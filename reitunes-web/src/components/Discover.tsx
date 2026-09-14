import { useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { discoveryRequest, isInboxEntry, useDiscovery, type DiscoveryEntry, type DiscoverySource } from '../hooks/useDiscovery';
import { DownloadProgress } from './DownloadProgress';
import { NtsTracklist } from './NtsTracklist';
import './Discover.css';

interface Preview {
  source: DiscoverySource;
  entries: DiscoveryEntry[];
}

type View = 'inbox' | 'saved' | 'sources' | 'all' | 'history';
type Sort = 'found' | 'published' | 'shortest' | 'longest' | 'shuffle';
type Length = 'any' | 'hour' | 'two-hours' | 'long';
const lengths: { value: Length; label: string }[] = [
  { value: 'any', label: 'Any length' }, { value: 'hour', label: '30–60 min' },
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
  return Boolean(entry.saved) && !entry.libraryItemId;
}

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

export function Discover({ searchQuery, onOpenLibrary }: { searchQuery: string; onOpenLibrary: (id: string) => void }) {
  const { data, isLoading, error: loadError, refetch } = useDiscovery();
  const queryClient = useQueryClient();
  const [view, setView] = useState<View>('inbox');
  const [sourceId, setSourceId] = useState('');
  const [length, setLength] = useState<Length>('any');
  const [sort, setSort] = useState<Sort>('found');
  const [shuffleSeed, setShuffleSeed] = useState(0);
  const [showImports, setShowImports] = useState(true);
  const [showFollow, setShowFollow] = useState(false);
  const [url, setUrl] = useState('');
  const [minMinutes, setMinMinutes] = useState('30');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [undoEntry, setUndoEntry] = useState<DiscoveryEntry | null>(null);
  const sources = data?.sources ?? [];
  const hasFollowedSource = (entry: DiscoveryEntry) => entry.sources.some(id => sources.some(source => source.id === id));
  const entries = (data?.entries ?? []).filter(entry => hasFollowedSource(entry) || entry.saved || entry.status !== 'new' || entry.libraryItemId);
  const selectedSource = sources.find(source => source.id === sourceId);
  const inboxCount = entries.filter(entry => hasFollowedSource(entry) && isInboxEntry(entry)).length;
  const savedCount = entries.filter(isSavedEntry).length;
  const imports = entries.filter(entry => entry.status === 'queued' && !entry.libraryItemId)
    .sort((a, b) => (b.downloadJobId ?? 0) - (a.downloadJobId ?? 0) || b.discoveredAt - a.discoveredAt || a.id.localeCompare(b.id));
  const hasActivity = view !== 'history' && imports.length > 0;

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
      if (length === 'hour' && (entry.duration < 1800 || entry.duration >= 3600)) return false;
      if (length === 'two-hours' && (entry.duration < 3600 || entry.duration >= 7200)) return false;
      if (length === 'long' && entry.duration < 7200) return false;
    }
    if (view === 'inbox') return hasFollowedSource(entry) && isInboxEntry(entry);
    if (view === 'saved') return isSavedEntry(entry);
    if (view === 'history') return entry.status !== 'new' || Boolean(entry.libraryItemId);
    return true;
  });
  const visibleEntries = matchingEntries.filter(entry => !hasActivity || entry.status !== 'queued' || entry.libraryItemId)
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

  function importControls(entry: DiscoveryEntry) {
    if (entry.libraryItemId) return <button onClick={() => onOpenLibrary(entry.libraryItemId!)}>In library</button>;
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
      setShowImports(true); setNotice(`Queued “${entry.title}”. Its progress is shown in Imports.`);
    })}>{busy === entry.id ? 'Sending…' : entry.status === 'import_failed' ? 'Retry import' : 'Import'}</button>;
  }

  return (
    <section className="discovery" aria-label="Discover sets">
      <header className="discovery-heading">
        <h1>Discover</h1>
        <nav className="discovery-tabs" aria-label="Discovery views">
          <button aria-pressed={view === 'inbox'} onClick={() => setView('inbox')}>Inbox{inboxCount > 0 ? ` (${inboxCount})` : ''}</button>
          <button aria-pressed={view === 'saved'} onClick={() => setView('saved')}>Saved{savedCount > 0 ? ` (${savedCount})` : ''}</button>
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
      })}>Undo</button>}</div>}

      {!loadError && hasActivity && <section className="discovery-activity" aria-label="Imports">
        <div className="discovery-activity-heading">
          <button className="discovery-activity-toggle" aria-expanded={showImports} aria-controls="discovery-imports" onClick={() => setShowImports(!showImports)}>
            <span aria-hidden="true">{showImports ? '▾' : '▸'}</span> Imports ({imports.length})
          </button>
          <button onClick={showHistory}>View import history</button>
        </div>
        {showImports && <div id="discovery-imports" className="discovery-activity-list">
          {imports.slice(0, 5).map(entry => <div key={entry.id} className="discovery-activity-item">
            <a href={entry.url} target="_blank" rel="noopener noreferrer">{entry.title}</a>
            {importControls(entry)}
          </div>)}
          {imports.length > 5 && <p>Showing 5 of {imports.length} imports. Open History for the rest.</p>}
        </div>}
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
            <div className="discovery-lengths" role="group" aria-label="Filter by duration">{lengths.map(option => <button key={option.value} aria-pressed={length === option.value} onClick={() => setLength(option.value)}>{option.label}</button>)}</div>
            <div className="discovery-browse-selects">
              <select aria-label="Filter by source" value={sourceId} onChange={event => setSourceId(event.target.value)}>
                <option value="">All sources</option>
                {sources.map(source => <option key={source.id} value={source.id}>{source.title}</option>)}
              </select>
              <select aria-label="Sort sets" value={sort} onChange={event => setSort(event.target.value as Sort)}>
                <option value="found">Recently found</option><option value="published">Newest release</option>
                <option value="shortest">Shortest first</option><option value="longest">Longest first</option><option value="shuffle">Shuffled</option>
              </select>
              <button onClick={() => { setShuffleSeed(seed => seed + 1); setSort('shuffle'); }}>{sort === 'shuffle' ? 'Shuffle again' : 'Shuffle'}</button>
            </div>
            {(view !== 'inbox' || visibleEntries.length !== inboxCount) && <span className="discovery-result-count">{visibleEntries.length} {visibleEntries.length === 1 ? 'set' : 'sets'}</span>}
          </div>
          {!visibleEntries.length && <div className="discovery-empty"><h2>{searchQuery || sourceId || length !== 'any' ? 'No matching sets' : view === 'inbox' ? 'You’re all caught up' : view === 'saved' ? 'No saved sets' : 'Nothing here yet'}</h2><p>{view === 'saved' ? 'Choose Save on a set to keep it here without downloading.'
            : view === 'inbox' ? 'Check your sources or browse All sets for something older.' : 'Sets you import or dismiss stay in History.'}</p>
            {(sourceId || length !== 'any') && <button onClick={() => { setSourceId(''); setLength('any'); }}>Clear filters</button>}
            {!searchQuery && !sourceId && length === 'any' && (view === 'inbox' || view === 'saved') && <button onClick={() => setView('all')}>Explore all sets</button>}
          </div>}
          <div className="discovery-entries">{visibleEntries.map(entry => {
            const entrySources = sources.filter(source => entry.sources.includes(source.id));
            const published = publishedLabel(entry.published);
            const ntsEpisode = isNtsEpisode(entry.url);
            const uploader = [entry.title, ...entrySources.map(source => source.title)].some(label => sameLabel(label, entry.uploader)) ? '' : entry.uploader;
            const listenLabel = `Listen on ${ntsEpisode ? 'NTS' : entrySources[0]?.provider ?? 'source'} ↗`;
            return <article className={`discovery-entry${entry.saved ? ' discovery-entry-saved' : ''}`} key={entry.id}>
              <div className="discovery-entry-info">
                <h2><a href={entry.url} target="_blank" rel="noopener noreferrer">{entry.title}</a></h2>
                <div className="discovery-entry-meta">
                  <span>{[uploader, durationLabel(entry.duration), published].filter(Boolean).join(' · ')}</span>
                  {entrySources.map(source => <button key={source.id} aria-label={`Browse ${source.title}`} title={`Browse ${source.title}`} onClick={() => { setSourceId(source.id); setView('all'); setLength('any'); }}>{sameLabel(source.title, entry.title) ? source.provider : source.title}</button>)}
                </div>
                {Boolean(entry.genres?.length) && <p className="discovery-genres">{entry.genres!.join(' · ')}</p>}
              </div>
              <div className="discovery-entry-description">
                {entry.description && <p className="discovery-description">{entry.description}</p>}
                {ntsEpisode && <NtsTracklist entryId={entry.id} />}
                {entry.error && <p className="discovery-error">{entry.error}</p>}
              </div>
              <div className="discovery-entry-actions">
                <a className="discovery-listen" href={entry.url} target="_blank" rel="noopener noreferrer" aria-label={listenLabel} title={listenLabel}>Listen ↗</a>
                {importControls(entry)}
                {!entry.libraryItemId && <button aria-label={entry.saved ? 'Saved for later' : 'Save for later'} title={entry.saved ? 'Remove from saved sets' : 'Save for later'} aria-pressed={Boolean(entry.saved)} className="discovery-save" disabled={Boolean(busy)} onClick={() => void act(`save-${entry.id}`, async () => {
                  await discoveryRequest(`/entries/${entry.id}/save`, { saved: !entry.saved });
                  setNotice(entry.saved ? `Removed “${entry.title}” from Saved.` : `Saved “${entry.title}” for later.`);
                })}>{entry.saved ? 'Saved' : 'Save'}</button>}
                {entry.status === 'dismissed' ? hasFollowedSource(entry) && <button disabled={Boolean(busy)} onClick={() => void act(entry.id, async () => { await discoveryRequest(`/entries/${entry.id}/restore`); setNotice('Returned to inbox.'); })}>Restore</button>
                  : hasFollowedSource(entry) && entry.status !== 'queued' && !entry.libraryItemId && <button className="discovery-dismiss" disabled={Boolean(busy)} onClick={() => void act(entry.id, async () => {
                    await discoveryRequest(`/entries/${entry.id}/dismiss`); setNotice(`Dismissed “${entry.title}”.`); setUndoEntry(entry);
                  })}>Dismiss</button>}
              </div>
            </article>;
          })}</div>
          {view === 'all' && selectedSource && <div className="discovery-archive-more">
            <button disabled={Boolean(busy) || data?.refreshing || selectedSource.archiveFinished} onClick={() => void act('archive', async () => {
              await discoveryRequest(`/sources/${selectedSource.id}/archive`); setNotice('Another batch requested. Older sets will appear here when ready.');
            })}>{selectedSource.archiveFinished ? 'All available entries fetched' : data?.refreshing ? 'Checking source…' : 'Load 50 more entries'}</button>
          </div>}
        </>}
    </section>
  );
}
