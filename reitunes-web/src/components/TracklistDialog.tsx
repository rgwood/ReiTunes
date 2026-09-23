import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { AlbumTrack, LibraryItem, Tracklist } from '../types';
import { usePlayback } from '../hooks/usePlayback';
import { usePlayerStore } from '../stores/playerStore';
import { formatBookmarkPosition as format, parseBookmarkPosition as parse } from '../utils/bookmarks';
import { parseTracklist, saveTracklist, tracklistError } from '../utils/tracklists';
import './Tracklist.css';

interface Candidate { id: string; title: string; detail: string; tracklist: Tracklist }
interface DraftTrack { title: string; start: string; end: string }
const draftTracks = (tracks: AlbumTrack[]) => tracks.map(t => ({ title: t.title, start: format(t.start, true), end: t.end === null ? '' : format(t.end, true) }));

export function TracklistDialog({ item, onClose, onApplied }: { item: LibraryItem; onClose: () => void; onApplied: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const request = useRef<AbortController | null>(null);
  const editVersion = useRef(0);
  const queryClient = useQueryClient();
  const play = usePlayback();
  const [artist, setArtist] = useState(item.artist);
  const [album, setAlbum] = useState(item.album || item.name);
  const [source, setSource] = useState('');
  const [duration, setDuration] = useState<number | null>(item.tracklist?.duration ?? null);
  const [durationError, setDurationError] = useState(false);
  const [list, setList] = useState<Tracklist | null>(item.tracklist ?? null);
  const [tracks, setTracks] = useState<DraftTrack[]>(draftTracks(item.tracklist?.tracks ?? []));
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [candidateId, setCandidateId] = useState('');
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [finding, setFinding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [shift, setShift] = useState('0');
  const [paste, setPaste] = useState('');
  const [selected, setSelected] = useState(0);
  const [showSearch, setShowSearch] = useState(!item.tracklist);
  useEffect(() => {
    dialog.current?.showModal();
    const audio = new Audio();
    audio.preload = 'metadata';
    audio.onloadedmetadata = () => {
      if (Number.isFinite(audio.duration) && audio.duration > 0) setDuration(audio.duration);
      else setDurationError(true);
    };
    audio.onerror = () => setDurationError(true);
    audio.src = item.url;
    return () => { request.current?.abort(); audio.onloadedmetadata = null; audio.onerror = null; audio.removeAttribute('src'); audio.load(); };
  }, [item.url]);
  const parsed: AlbumTrack[] = tracks.map(t => ({ title: t.title.trim(), start: parse(t.start) ?? NaN, end: t.end.trim() ? parse(t.end) ?? NaN : null }));
  const validation = tracklistError(parsed, duration);
  const sourceDuration = list?.tracks.at(-1)?.end;
  const mismatch = duration !== null && sourceDuration != null ? duration - sourceDuration : null;
  function choose(candidate: Candidate) {
    editVersion.current++;
    setList(candidate.tracklist); setTracks(draftTracks(candidate.tracklist.tracks)); setCandidateId(candidate.id); setSelected(0); setError('');
  }
  function edited(next: DraftTrack[]) {
    editVersion.current++;
    setTracks(next); setList(old => old ? { ...old, timing: 'edited' } : { tracks: [], source_url: null, source_label: 'Entered manually', timing: 'edited', duration }); setError('');
  }
  async function find() {
    if (finding || saving) return;
    const controller = new AbortController(); request.current = controller;
    const versionAtStart = editVersion.current;
    setFinding(true); setError(''); setWarnings([]);
    try {
      const response = await fetch(`/api/items/${item.id}/tracklist/find`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
        body: JSON.stringify({ artist, album, source_url: source.trim() || null, duration }) });
      if (!response.ok) throw new Error(await response.text());
      const result = await response.json() as { candidates: Candidate[]; warnings: string[] };
      setCandidates(result.candidates); setWarnings(result.warnings);
      // Research never silently replaces a list the user has already edited.
      if (!list && editVersion.current === versionAtStart && result.candidates[0]) choose(result.candidates[0]);
    } catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : 'Lookup failed. Try again.'); }
    finally { if (!controller.signal.aborted) setFinding(false); }
  }
  async function save(remove = false) {
    if (saving || !remove && (validation || !list)) return;
    setSaving(true); setError('');
    try {
      const updated = await saveTracklist(item, remove ? null : { ...list!, tracks: parsed, duration });
      queryClient.setQueryData<LibraryItem[]>(['library'], old => old?.map(i => i.id === item.id ? updated : i));
      if (usePlayerStore.getState().currentItemId === item.id) usePlayerStore.getState().refreshCurrentItem(updated);
      onApplied(); onClose();
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not save. Your changes are still here.'); }
    finally { setSaving(false); }
  }
  function preview(index: number) {
    const track = parsed[index];
    if (!track || !Number.isFinite(track.start) || track.start < 0 || duration !== null && track.start >= duration) return;
    const start = Math.max(0, track.start - 3);
    const end = Math.min(track.start + 5, duration ?? Infinity);
    void play(item, start, 'tracklist-preview', { start, end, afterEnd: 'pause' });
  }
  return <dialog ref={dialog} className="tracklist-dialog" aria-labelledby="tracklist-heading"
    onCancel={e => { e.preventDefault(); if (!saving) onClose(); }}>
    <header><div><h2 id="tracklist-heading">{item.tracklist ? 'Edit tracklist' : 'Find tracklist'}</h2><p>{item.artist} — {item.name}</p></div>
      <button type="button" onClick={onClose} disabled={saving} aria-label="Close tracklist">×</button></header>
    <div className="tracklist-content">
      {item.tracklist && <button type="button" onClick={() => setShowSearch(!showSearch)} aria-expanded={showSearch}>Find another edition…</button>}
      {showSearch && <form className="tracklist-search" onSubmit={e => { e.preventDefault(); void find(); }}>
        <label>Artist<input value={artist} onChange={e => setArtist(e.target.value)} disabled={finding || saving} /></label>
        <label>Album<input value={album} onChange={e => setAlbum(e.target.value)} required disabled={finding || saving} /></label>
        <label className="tracklist-source">Original upload URL (optional)<input type="url" placeholder="YouTube or SoundCloud — otherwise inferred from the filename" value={source} onChange={e => setSource(e.target.value)} disabled={finding || saving} /></label>
        <button type="submit" disabled={finding || saving}>{finding ? 'Finding tracklist…' : 'Find tracklist'}</button>
        {finding && <p role="status">Checking source chapters and album editions. This can take a minute or two.</p>}
      </form>}
      <p className="tracklist-help">{duration !== null ? `Recording length: ${format(duration)}.` : durationError ? 'Could not read the audio duration; check that the timings fit before applying.' : 'Reading recording length…'} Double-click a track in the library to play from there. The album continues normally.</p>
      {warnings.map((warning, i) => <p key={i} className="tracklist-warning" role="status">{warning}</p>)}
      {candidates.length > 0 && <label className="tracklist-choice">Source / edition<select value={candidateId} disabled={saving} onChange={e => { const candidate = candidates.find(c => c.id === e.target.value); if (candidate) choose(candidate); }}>
        <option value="" disabled>Choose a tracklist to preview</option>
        {candidates.map(c => <option key={c.id} value={c.id}>{c.title || 'Original upload'} · {c.tracklist.tracks.length} tracks · {format(c.tracklist.tracks.at(-1)?.end ?? 0)}{c.detail ? ` · ${c.detail}` : ''}</option>)}
      </select></label>}
      {list && <div className="tracklist-provenance">
        {list.source_url ? <a href={list.source_url} target="_blank" rel="noreferrer">{list.source_label} ↗</a> : <span>{list.source_label}</span>}
        <span>{list.timing === 'estimated' ? 'Estimated starts, calculated from track lengths' : list.timing === 'chapters' ? 'Source timestamps — check against your file' : 'Timings edited'}</span>
        {mismatch !== null && Math.abs(mismatch) > 2 && <p className="tracklist-warning">Your recording is {format(Math.abs(mismatch))} {mismatch > 0 ? 'longer' : 'shorter'} than this tracklist. Check the edition and preview a few boundaries.</p>}
      </div>}
      {tracks.length > 0 && <>
        <div className="tracklist-adjust">
          <label>Shift all starts and ends by <input type="number" step="0.1" value={shift} onChange={e => setShift(e.target.value)} disabled={saving} /> seconds</label>
          <button type="button" disabled={saving || !shift.trim() || !Number.isFinite(Number(shift))} onClick={() => {
            const amount = Number(shift);
            if (parsed.some(t => !Number.isFinite(t.start) || t.start + amount < 0 || t.end !== null && !Number.isFinite(t.end))) { setError('Enter valid times first; shifting must not produce a negative start.'); return; }
            edited(draftTracks(parsed.map(t => ({ ...t, start: t.start + amount, end: t.end === null ? null : t.end + amount })))); setShift('0');
          }}>Shift</button>
        </div>
        <div className="tracklist-editor-scroll"><table className="tracklist-editor"><thead><tr><th>#</th><th>Track title</th><th>Start</th><th>End (optional)</th><th /></tr></thead><tbody>
          {tracks.map((track, index) => <tr key={index} data-selected={selected === index || undefined} onFocus={() => setSelected(index)}>
            <td>{index + 1}</td>
            {(['title', 'start', 'end'] as const).map(field => <td key={field}><input aria-label={`Track ${index + 1} ${field}`} value={track[field]} disabled={saving}
              onChange={e => edited(tracks.map((t, i) => i === index ? { ...t, [field]: e.target.value } : t))} /></td>)}
            <td><button type="button" disabled={saving} onClick={() => preview(index)} aria-label={`Preview track ${index + 1} boundary`}>▶</button>
              <button type="button" disabled={saving} onClick={() => edited(tracks.filter((_, i) => i !== index))} aria-label={`Remove track ${index + 1}`}>×</button></td>
          </tr>)}
        </tbody></table></div>
        <div className="tracklist-adjust"><span>Track {Math.min(selected + 1, tracks.length)} start:</span>
          {[-1, 1].map(offset => <button key={offset} type="button" disabled={saving || !parsed[selected] || !Number.isFinite(parsed[selected].start) || parsed[selected].start + offset < 0}
            onClick={() => { const next = tracks.map(t => ({ ...t })); const start = parsed[selected].start + offset; next[selected].start = format(start, true);
              if (selected > 0 && parsed[selected - 1].end === parsed[selected].start) next[selected - 1].end = format(start, true);
              edited(next); }}>{offset < 0 ? '−1s' : '+1s'}</button>)}
          <button type="button" disabled={saving} onClick={() => {
            const player = usePlayerStore.getState(); if (player.currentItemId !== item.id) { setError('Play this recording first.'); return; }
            const next = tracks.map(t => ({ ...t })); if (next[selected]) { next[selected].start = format(player.resumePosition, true); if (selected > 0 && parsed[selected - 1].end === parsed[selected].start) next[selected - 1].end = next[selected].start; edited(next); }
          }}>Use playback position</button>
          <button type="button" disabled={saving} onClick={() => preview(selected)}>Preview boundary</button>
        </div>
        <p className="tracklist-help">Times accept seconds, m:ss or h:mm:ss, including decimals. A blank end uses the next track’s start. Preview plays from three seconds before the boundary and pauses five seconds after it.</p>
        {validation && <p className="tracklist-warning" role="status">{validation}</p>}
      </>}
      <details><summary>Paste a timestamped tracklist</summary><textarea aria-label="Timestamped tracklist" rows={4} placeholder={'0:00 First song\n8:30 Second song'} value={paste} onChange={e => setPaste(e.target.value)} disabled={saving} />
        <button type="button" disabled={!paste.trim() || saving} onClick={() => { try { const parsed = parseTracklist(paste); editVersion.current++; setList({ tracks: parsed, source_url: null, source_label: 'Pasted tracklist', timing: 'edited', duration }); setTracks(draftTracks(parsed)); setCandidateId(''); setSelected(0); setError(''); } catch (e) { setError((e as Error).message); } }}>Preview pasted tracklist</button></details>
      {error && <p className="tracklist-warning" role="alert">{error}</p>}
    </div>
    <footer>{item.tracklist && <button type="button" disabled={saving || finding} onClick={() => void save(true)}>Remove tracklist</button>}
      <span /><button type="button" onClick={onClose} disabled={saving}>Cancel</button>
      <button type="button" disabled={saving || finding || !!validation || !list} onClick={() => void save()}>{saving ? 'Saving…' : 'Apply tracklist'}</button></footer>
  </dialog>;
}
