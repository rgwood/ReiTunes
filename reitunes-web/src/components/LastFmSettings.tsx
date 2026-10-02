import { useEffect, useId, useState } from 'react';
import { clearLastFmOutbox } from '../hooks/useLastFmListening';

interface Status { configured: boolean; connected: boolean; username: string | null; enabled: boolean; pending: number; submitted: number; lastError: string | null }

export function LastFmSettings({ isOpen }: { isOpen: boolean }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [secret, setSecret] = useState('');
  const [editingApplication, setEditingApplication] = useState(false);
  const id = useId();
  const refresh = async () => {
    const response = await fetch('/api/lastfm/status', { credentials: 'include' });
    if (!response.ok) throw new Error('Could not load Last.fm settings');
    setStatus(await response.json() as Status);
  };
  useEffect(() => {
    if (!isOpen) return;
    let disposed = false;
    const load = async () => {
      try {
        const response = await fetch('/api/lastfm/status', { credentials: 'include', signal: AbortSignal.timeout(10_000) });
        if (!response.ok) throw new Error('Could not load Last.fm settings');
        const value = await response.json() as Status;
        if (!disposed) setStatus(value);
      } catch (error) { if (!disposed) setError(error instanceof Error ? error.message : 'Could not load Last.fm settings'); }
    };
    void load(); const timer = window.setInterval(() => { void load(); }, 15_000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [isOpen]);
  const request = async (path: string, body?: object, method = 'POST') => {
    const response = await fetch(`/api/lastfm/${path}`, { method, credentials: 'include', headers: { 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20_000) });
    if (!response.ok) { const value = await response.json() as { error?: string }; throw new Error(value.error || 'Last.fm request failed'); }
    return response;
  };
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError('');
    try { await action(); await refresh(); window.dispatchEvent(new Event('reitunes:lastfm')); }
    catch (error) { setError(error instanceof Error ? error.message : 'Last.fm request failed'); }
    finally { setBusy(false); }
  };
  const connect = async () => {
    const response = await request('authorize');
    const value = await response.json() as { url: string };
    window.location.assign(value.url);
  };
  return <section aria-labelledby={`${id}-heading`} className="lastfm-settings">
    <h3 id={`${id}-heading`}>Last.fm</h3>
    <p>Scrobble songs you listen to in this browser or on Sonos. Your listening appears on Last.fm according to your account’s privacy settings.</p>
    {status?.connected ? <>
      <p>Connected as <a href={`https://www.last.fm/user/${encodeURIComponent(status.username || '')}`} target="_blank" rel="noreferrer">{status.username}</a>.</p>
      <label className="settings-field"><span>Scrobbling</span><input type="checkbox" checked={status.enabled} disabled={busy}
        onChange={event => {
          const enabled = event.target.checked;
          setStatus({ ...status, enabled });
          void run(async () => {
            try { await request('enabled', { enabled }); }
            catch (error) { setStatus(status); throw error; }
          });
        }} /></label>
      <p>{status.submitted.toLocaleString()} scrobbles sent from ReiTunes{status.pending ? ` · ${status.pending} waiting to send` : ''}.</p>
      <button disabled={busy} onClick={() => void run(async () => {
        await request('connection', undefined, 'DELETE');
        clearLastFmOutbox();
      })}>Disconnect Last.fm</button>
    </> : status?.configured && !editingApplication ? <>
      <button disabled={busy} onClick={() => void run(connect)}>Connect quobobo to Last.fm</button>
      <button disabled={busy} onClick={() => setEditingApplication(true)}>Change API application</button>
    </> : status ? <>
      <p>Create a <a href="https://www.last.fm/api/account/create" target="_blank" rel="noreferrer">Last.fm API application</a> named ReiTunes. Set its callback URL to <code>{`${window.location.origin}/api/lastfm/callback`}</code>.</p>
      <form onSubmit={event => { event.preventDefault(); void run(async () => {
        await request('setup', { apiKey: apiKey.trim(), secret: secret.trim() }); setApiKey(''); setSecret(''); setEditingApplication(false);
      }); }}>
        <label className="settings-field" htmlFor={`${id}-key`}><span>API key</span><input id={`${id}-key`} type="password" autoComplete="off" required value={apiKey} onChange={event => setApiKey(event.target.value)} /></label>
        <label className="settings-field" htmlFor={`${id}-secret`}><span>Shared secret</span><input id={`${id}-secret`} type="password" autoComplete="off" required value={secret} onChange={event => setSecret(event.target.value)} /></label>
        <button disabled={busy} type="submit">Save Last.fm credentials</button>
      </form>
    </> : <p>Loading Last.fm settings…</p>}
    <p className="lastfm-help">Songs need an artist, title and duration. Scrobbles count after half the song or four minutes of listening. Seeking ahead doesn’t count.</p>
    {(error || status?.lastError) && <p role="alert">{error || status?.lastError}</p>}
  </section>;
}
