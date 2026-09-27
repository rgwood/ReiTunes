import { useEffect, useId, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { LibraryItem } from '../types';
import { useMetadataSuggestions, useUpdateLibraryItem } from '../hooks/useLibrary';
import { MetadataInput } from './MetadataInput';
import { durationLabel, trackDuration } from '../utils/duration';
import './SongInfoDialog.css';

const fields = ['name', 'artist', 'album', 'track_number'] as const;
const labels = { name: 'Name', artist: 'Artist', album: 'Album', track_number: 'Track number' };

interface FileInfo {
  file_path: string;
  size_bytes: number;
  format: string | null;
  codec: string | null;
  bitrate_kbps: number | null;
  duration_seconds: number | null;
  sample_rate_hz: number | null;
  channels: number | null;
  bit_depth: number | null;
  error: string | null;
}

function fileSize(bytes: number) {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  const unit = Math.min(units.length - 1, Math.floor(Math.log2(Math.max(1, bytes)) / 10));
  return `${(bytes / 1024 ** unit).toLocaleString(undefined, { maximumFractionDigits: 2 })} ${units[unit]} (${bytes.toLocaleString()} bytes)`;
}

export function SongInfoDialog({ item, onClose }: { item: LibraryItem; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const id = useId();
  const [draft, setDraft] = useState({ name: item.name, artist: item.artist, album: item.album, track_number: item.track_number?.toString() ?? '' });
  const saved = useRef(draft);
  const saving = useRef(false);
  const composing = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const updateItem = useUpdateLibraryItem();
  const suggestions = useMetadataSuggestions();
  const fileInfo = useQuery<FileInfo>({
    queryKey: ['file-info', item.id, item.file_path],
    queryFn: async ({ signal }) => {
      const response = await fetch(`/api/items/${encodeURIComponent(item.id)}/file-info`, { signal });
      if (!response.ok) throw new Error('Could not load file details');
      const info: FileInfo = await response.json();
      if (info.file_path !== item.file_path) throw new Error('The audio file changed. Reopen Song info to see the new file.');
      return info;
    },
    staleTime: 3600_000,
    retry: false,
  });
  const info = fileInfo.data;
  const unknown = fileInfo.isFetching ? 'Loading…' : 'Unknown';
  const duration = info?.duration_seconds ?? trackDuration(item);
  const added = new Date(/Z|[+-]\d\d:\d\d$/.test(item.created_time_utc) ? item.created_time_utc : item.created_time_utc + 'Z');

  useEffect(() => {
    const dialog = dialogRef.current!;
    dialog.showModal();
    nameRef.current?.focus();
    nameRef.current?.select();
    return () => dialog.close();
  }, []);

  const save = async () => {
    if (saving.current) return;
    if (!draft.name.trim()) {
      setError('Enter a song name.');
      nameRef.current?.focus();
      return;
    }
    saving.current = true;
    setPending(true);
    setError(null);
    try {
      for (const field of fields) {
        const value = field === 'track_number' && draft[field] !== '' ? String(Number(draft[field])) : draft[field];
        if (value === saved.current[field]) continue;
        await updateItem(item.id, field, value);
        // A retry only sends fields that haven't already saved successfully.
        saved.current = { ...saved.current, [field]: value };
      }
      onClose();
    } catch {
      setError('Could not save all changes. Your edits are still here; try again.');
    } finally {
      saving.current = false;
      setPending(false);
    }
  };

  return (
    <dialog ref={dialogRef} className="song-info-dialog" aria-labelledby={`${id}-title`}
      onCancel={event => { event.preventDefault(); if (!saving.current && !composing.current) onClose(); }}>
      <form
        onCompositionStart={() => { composing.current = true; }}
        onCompositionEnd={() => { composing.current = false; }}
        onKeyDown={event => {
          // IME confirmation/cancellation must not submit or close the dialog.
          // Safari can report isComposing=false for that keydown, but keeps 229.
          if (['Enter', 'Escape'].includes(event.key) && (composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)) {
            event.preventDefault();
          }
        }}
        onSubmit={event => { event.preventDefault(); if (!composing.current) void save(); }}>
        <h2 id={`${id}-title`}>Song info</h2>
        <fieldset disabled={pending}>
          {fields.map(field => (
            <label key={field}>
              <span>{labels[field]}</span>
              <MetadataInput ref={field === 'name' ? nameRef : undefined} value={draft[field]}
                suggestions={field === 'artist' || field === 'album' ? suggestions[field] : undefined}
                type={field === 'track_number' ? 'number' : 'text'} required={field === 'name'}
                min={field === 'track_number' ? 0 : undefined} max={field === 'track_number' ? 4294967295 : undefined}
                step={field === 'track_number' ? 1 : undefined}
                onValueChange={value => { setDraft({ ...draft, [field]: value }); setError(null); }} />
            </label>
          ))}
        </fieldset>
        <section className="song-file-info" aria-labelledby={`${id}-file-title`} aria-busy={fileInfo.isFetching}>
          <h3 id={`${id}-file-title`}>File details</h3>
          <dl>
            <dt>Filename</dt><dd>{item.file_path.split('/').pop()}</dd>
            {item.file_path.includes('/') && <><dt>Storage path</dt><dd>{item.file_path}</dd></>}
            <dt>File size</dt><dd>{info ? fileSize(info.size_bytes) : unknown}</dd>
            <dt>Duration</dt><dd>{duration == null ? unknown : durationLabel(duration)}</dd>
            <dt>Format</dt><dd>{info?.format ?? unknown}</dd>
            <dt>Codec</dt><dd>{info?.codec ?? unknown}</dd>
            <dt>Audio bitrate</dt><dd>{info?.bitrate_kbps ? `${info.bitrate_kbps.toLocaleString()} kbps (average)` : unknown}</dd>
            <dt>Sample rate</dt><dd>{info?.sample_rate_hz ? `${(info.sample_rate_hz / 1000).toLocaleString()} kHz` : unknown}</dd>
            <dt>Channels</dt><dd>{info?.channels ? info.channels === 1 ? 'Mono (1)' : info.channels === 2 ? 'Stereo (2)' : info.channels : unknown}</dd>
            {info?.bit_depth != null && <><dt>Bit depth</dt><dd>{info.bit_depth}-bit</dd></>}
            <dt>Date added</dt><dd>{Number.isNaN(added.getTime()) ? 'Unknown' : added.toLocaleString()}</dd>
            <dt>Play count</dt><dd>{item.play_count.toLocaleString()}</dd>
            <dt>Audio file</dt><dd><a href={item.url} target="_blank" rel="noreferrer">Open original file ↗</a></dd>
          </dl>
          {(fileInfo.isError || info?.error) && <p className="file-info-error" role="status">
            {info?.error ?? 'Could not load file details. Your song information is still editable.'}{' '}
            <button type="button" disabled={fileInfo.isFetching} onClick={() => void fileInfo.refetch()}>{fileInfo.isFetching ? 'Retrying…' : 'Retry'}</button>
          </p>}
        </section>
        {error && <p role="alert">{error}</p>}
        <footer>
          <button type="button" disabled={pending} onClick={onClose}>Cancel</button>
          <button type="submit" disabled={pending}>{pending ? 'Saving…' : 'Save'}</button>
        </footer>
      </form>
    </dialog>
  );
}
