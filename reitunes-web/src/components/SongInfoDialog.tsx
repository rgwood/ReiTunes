import { useEffect, useId, useRef, useState } from 'react';
import type { LibraryItem } from '../types';
import { useMetadataSuggestions, useUpdateLibraryItem } from '../hooks/useLibrary';
import { MetadataInput } from './MetadataInput';
import './SongInfoDialog.css';

const fields = ['name', 'artist', 'album', 'track_number'] as const;
const labels = { name: 'Name', artist: 'Artist', album: 'Album', track_number: 'Track number' };

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
        {error && <p role="alert">{error}</p>}
        <footer>
          <button type="button" disabled={pending} onClick={onClose}>Cancel</button>
          <button type="submit" disabled={pending}>{pending ? 'Saving…' : 'Save'}</button>
        </footer>
      </form>
    </dialog>
  );
}
