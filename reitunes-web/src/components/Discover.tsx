import { useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { discoveryRequest, isInboxEntry, useDiscovery, type DiscoveryEntry, type DiscoverySource } from '../hooks/useDiscovery';
import './Discover.css';

interface Preview {
  source: DiscoverySource;
  entries: DiscoveryEntry[];
}

function durationLabel(seconds: number | null) {
  if (seconds === null) return 'Duration unavailable';
  const minutes = Math.floor(seconds / 60);
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
}

function publishedLabel(date: string | null) {
  return date && /^\d{8}$/.test(date) ? `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}` : null;
}

export function Discover({ searchQuery, onOpenLibrary }: { searchQuery: string; onOpenLibrary: (id: string) => void }) {
  const { data, isLoading, error: loadError, refetch } = useDiscovery();
  const queryClient = useQueryClient();
  const [view, setView] = useState<'inbox' | 'sources' | 'archive' | 'history'>('inbox');
  const [sourceId, setSourceId] = useState('');
  const [showFollow, setShowFollow] = useState(false);
  const [url, setUrl] = useState('');
  const [minMinutes, setMinMinutes] = useState('30');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const sources = data?.sources ?? [];
  const selectedSource = sources.find((source) => source.id === sourceId);
  const inboxCount = data?.entries.filter(isInboxEntry).length ?? 0;

  async function act(key: string, operation: () => Promise<void>) {
    setBusy(key);
    setError('');
    setNotice('');
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

  const visibleEntries = (data?.entries ?? []).filter((entry) => {
    if (!entry.sources.some((id) => sources.some((source) => source.id === id))) return false;
    if (sourceId && !entry.sources.includes(sourceId)) return false;
    const sourceTitles = sources.filter((source) => entry.sources.includes(source.id)).map((source) => source.title);
    const matchesSearch = `${entry.title} ${entry.uploader} ${sourceTitles.join(' ')}`.toLowerCase().includes(searchQuery.toLowerCase());
    if (!matchesSearch) return false;
    if (view === 'inbox') return isInboxEntry(entry);
    if (view === 'history') return entry.status !== 'new' || Boolean(entry.libraryItemId);
    return true;
  }).sort((a, b) => b.discoveredAt - a.discoveredAt);

  return (
    <section className="discovery" aria-label="Discover sets">
      <header className="discovery-heading">
        <div>
          <h1>Discover</h1>
          <p>Find a set. Listen at the source. Import the ones you want to keep.</p>
        </div>
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
              <input type="url" required placeholder="YouTube channel/playlist or SoundCloud profile/playlist"
                value={url} disabled={Boolean(busy)} onChange={(event) => { setUrl(event.target.value); setPreview(null); }} />
            </label>
            <label>Minimum minutes
              <input type="number" required min="0" max="1440" step="1" value={minMinutes} disabled={Boolean(busy)}
                onChange={(event) => { setMinMinutes(event.target.value); setPreview(null); }} />
            </label>
            <button type="submit" disabled={Boolean(busy) || data?.refreshing}>{busy === 'preview' ? 'Reading source…' : 'Preview source'}</button>
            <button type="button" disabled={Boolean(busy)} onClick={() => { setShowFollow(false); setPreview(null); }}>Cancel</button>
          </div>
          <p>Checks the first 50 uploads or playlist entries. Sets with an unknown duration are excluded when a minimum is set.</p>
          {preview && (
            <div className="discovery-preview">
              <h2>{preview.source.title}</h2>
              <p>{preview.entries.length} matching sets · The first {Math.min(10, preview.entries.length)} will appear in your inbox. The rest stay in the archive.</p>
              {preview.entries.length > 0 ? <ul>{preview.entries.slice(0, 10).map((entry) => (
                <li key={entry.id}><span>{entry.title}</span><span>{durationLabel(entry.duration)}</span></li>
              ))}</ul> : <p>No matching sets in this batch. You can still follow this source for future uploads.</p>}
              <button type="button" disabled={Boolean(busy)} onClick={() => void act('follow', async () => {
                await discoveryRequest('/sources', { url: preview.source.url, minMinutes: preview.source.minMinutes });
                setShowFollow(false); setPreview(null); setUrl(''); setView('inbox'); setSourceId('');
                setNotice(`Following ${preview.source.title}. Sources refresh every 3 hours while the server is running.`);
              })}>{busy === 'follow' ? 'Following…' : 'Follow this source'}</button>
            </div>
          )}
        </form>
      )}

      <nav className="discovery-tabs" aria-label="Discovery views">
        <button aria-pressed={view === 'inbox'} onClick={() => setView('inbox')}>Inbox{inboxCount > 0 ? ` (${inboxCount})` : ''}</button>
        <button aria-pressed={view === 'sources'} onClick={() => setView('sources')}>Sources{sources.length > 0 ? ` (${sources.length})` : ''}</button>
        <button aria-pressed={view === 'archive'} onClick={() => setView('archive')}>Archive</button>
        <button aria-pressed={view === 'history'} onClick={() => setView('history')}>History</button>
        {view !== 'sources' && sources.length > 0 && <select aria-label="Filter by source" value={sourceId} onChange={(event) => setSourceId(event.target.value)}>
          <option value="">All sources</option>
          {sources.map((source) => <option key={source.id} value={source.id}>{source.title}</option>)}
        </select>}
      </nav>

      {error && <p className="discovery-error" role="alert">{error}</p>}
      {notice && <p className="discovery-notice" role="status">{notice}</p>}
      {loadError ? <p className="discovery-error" role="alert">Could not load discovery. <button onClick={() => void refetch()}>Retry</button></p>
        : isLoading ? <p role="status">Loading discovery…</p>
        : !sources.length ? <div className="discovery-empty"><h2>Your next favourite set starts here</h2><p>Follow a DJ, mix series, label, or curated playlist on YouTube or SoundCloud. New sets will arrive here every 3 hours.</p><button onClick={() => setShowFollow(true)}>Add your first source</button></div>
        : view === 'sources' ? <div className="discovery-sources">{sources.map((source) => (
          <article key={source.id} className="discovery-source">
            <h2><a href={source.url} target="_blank" rel="noopener noreferrer">{source.title} ↗</a></h2>
            <p>{source.provider} · {source.minMinutes ? `At least ${source.minMinutes} minutes` : 'Any duration'}</p>
            <p>{source.lastChecked ? `Last checked ${new Date(source.lastChecked * 1000).toLocaleString()}` : 'Not checked yet'} · Refreshes every 3 hours</p>
            {source.error && <p className="discovery-error" role="alert">{source.error}</p>}
            <div className="discovery-actions">
              <button onClick={() => { setSourceId(source.id); setView('archive'); }}>Browse archive</button>
              <button disabled={Boolean(busy)} onClick={() => void act(source.id, async () => {
                await discoveryRequest(`/sources/${source.id}`, undefined, 'DELETE');
                if (sourceId === source.id) setSourceId('');
                setNotice(`Unfollowed ${source.title}. Imported music stays in your library.`);
              })}>Unfollow</button>
            </div>
          </article>
        ))}</div> : <>
          {sources.some((source) => source.error) && <p className="discovery-error">Some sources could not refresh. <button onClick={() => setView('sources')}>See source errors</button></p>}
          {view === 'history' && <p className="discovery-hint">“Sent to downloader” confirms the request was queued. It does not confirm the download finished.</p>}
          {view === 'archive' && <p className="discovery-hint">Previously fetched sets, including older uploads. Choose a source to load another batch.</p>}
          {!visibleEntries.length && <div className="discovery-empty"><h2>{searchQuery || sourceId ? 'No matching sets' : view === 'inbox' ? 'You’re all caught up' : 'Nothing here yet'}</h2><p>{view === 'inbox' ? 'Check your sources or browse the archive for something older.' : 'Sets you import or dismiss stay in History.'}</p></div>}
          <div className="discovery-entries">{visibleEntries.map((entry) => {
            const entrySources = sources.filter((source) => entry.sources.includes(source.id));
            const published = publishedLabel(entry.published);
            return <article className="discovery-entry" key={entry.id}>
              <div className="discovery-entry-info">
                <h2><a href={entry.url} target="_blank" rel="noopener noreferrer">{entry.title}</a></h2>
                <p>{[entry.uploader, durationLabel(entry.duration), published].filter(Boolean).join(' · ')}</p>
                <p>From {entrySources.map((source) => source.title).join(', ')}</p>
                {entry.error && <p className="discovery-error">{entry.error}</p>}
              </div>
              <div className="discovery-entry-actions">
                <a className="discovery-listen" href={entry.url} target="_blank" rel="noopener noreferrer">Listen on {entrySources[0]?.provider ?? 'source'} ↗</a>
                {entry.libraryItemId ? <button onClick={() => onOpenLibrary(entry.libraryItemId!)}>In library</button>
                  : entry.status === 'queued' ? <span className="discovery-queued">Sent to downloader</span>
                  : <button disabled={Boolean(busy)} onClick={() => void act(entry.id, async () => {
                    await discoveryRequest(`/entries/${entry.id}/import`);
                    setNotice(`Sent “${entry.title}” to the downloader. You can find it in History.`);
                  })}>{busy === entry.id ? 'Sending…' : entry.status === 'import_failed' ? 'Retry import' : 'Import'}</button>}
                {entry.status === 'dismissed' ? <button disabled={Boolean(busy)} onClick={() => void act(entry.id, async () => { await discoveryRequest(`/entries/${entry.id}/restore`); setNotice('Returned to inbox.'); })}>Restore</button>
                  : entry.status !== 'queued' && !entry.libraryItemId && <button disabled={Boolean(busy)} onClick={() => void act(entry.id, async () => { await discoveryRequest(`/entries/${entry.id}/dismiss`); setNotice('Dismissed. You can restore it from History.'); })}>Dismiss</button>}
              </div>
            </article>;
          })}</div>
          {view === 'archive' && selectedSource && <div className="discovery-archive-more">
            <button disabled={Boolean(busy) || data?.refreshing || selectedSource.archiveFinished} onClick={() => void act('archive', async () => {
              await discoveryRequest(`/sources/${selectedSource.id}/archive`); setNotice('Another archive batch requested. New entries will appear here when ready.');
            })}>{selectedSource.archiveFinished ? 'All available entries fetched' : data?.refreshing ? 'Checking source…' : 'Load 50 more entries'}</button>
          </div>}
        </>}
    </section>
  );
}
