import { useEffect, useId, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { LibraryItem, Playlist, SmartPlaylistRules } from '../types';
import { playlistRequest } from '../hooks/usePlaylists';
import { matchesSmartPlaylist } from '../utils/playlists';

export interface PlaylistDraft {
  playlist?: Playlist;
  smart: boolean;
  itemIds?: string[];
}

export function PlaylistDialog({ draft, items, onClose, onSaved }: {
  draft: PlaylistDraft;
  items: LibraryItem[];
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const createdId = useRef<string | null>(null);
  const id = useId();
  const client = useQueryClient();
  const [name, setName] = useState(draft.playlist?.name ?? '');
  const [rules, setRules] = useState<SmartPlaylistRules>(() => ({
    added_within_days: null, play_state: 'any', favourites_only: false, bookmark_state: 'any',
    ...draft.playlist?.smart_rules,
  }));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [now] = useState(Date.now);
  useEffect(() => { dialog.current?.showModal(); nameInput.current?.focus(); }, []);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (pending || !name.trim()) return;
    setPending(true); setError('');
    try {
      let playlistId = draft.playlist?.id ?? createdId.current;
      if (!playlistId) {
        const created = await playlistRequest<Playlist>('', 'POST', { name: name.trim(), smart_rules: draft.smart ? rules : null });
        playlistId = created.id;
        createdId.current = playlistId;
      } else {
        await playlistRequest('/' + playlistId, 'PUT', { name: name.trim() });
        if (draft.smart) await playlistRequest('/' + playlistId + '/rules', 'PUT', rules);
      }
      if (!draft.smart && draft.itemIds?.length) {
        await playlistRequest('/' + playlistId + '/items', 'POST', { library_item_ids: draft.itemIds });
      }
      await client.invalidateQueries({ queryKey: ['playlists'] });
      onSaved(playlistId);
    } catch {
      setError('Could not save the playlist. Your changes are still here; try again.');
    } finally { setPending(false); }
  }

  return <dialog ref={dialog} className="settings-dialog playlist-dialog" aria-labelledby={id}
    onCancel={event => { event.preventDefault(); if (!pending) onClose(); }}>
    <form className="settings-content" onSubmit={save}>
      <header className="settings-header"><h2 id={id}>{draft.playlist ? 'Edit' : 'New'} {draft.smart ? 'Smart Playlist' : 'playlist'}</h2></header>
      <label className="playlist-name-field">Name<input ref={nameInput} required maxLength={120} value={name}
        onChange={event => setName(event.target.value)} disabled={pending} /></label>
      {draft.smart && <fieldset disabled={pending} className="playlist-rules">
        <legend>Match all of these rules</legend>
        <label>Date added<select aria-label="Date added rule" value={rules.added_within_days === null ? 'any' : 'recent'}
          onChange={event => setRules({ ...rules, added_within_days: event.target.value === 'any' ? null : 30 })}>
          <option value="any">Any time</option><option value="recent">In the last</option>
        </select></label>
        {rules.added_within_days !== null && <label>Days<input aria-label="Days since added" type="number" min={1} max={3650} required
          value={rules.added_within_days || ''} onChange={event => setRules({ ...rules, added_within_days: Number(event.target.value) })} /></label>}
        <label>Play count<select value={rules.play_state} onChange={event => setRules({ ...rules, play_state: event.target.value as SmartPlaylistRules['play_state'] })}>
          <option value="any">Any</option><option value="unplayed">Is 0</option><option value="played">Is greater than 0</option>
        </select></label>
        <label>Bookmarks<select value={rules.bookmark_state ?? 'any'}
          onChange={event => setRules({ ...rules, bookmark_state: event.target.value as SmartPlaylistRules['bookmark_state'] })}>
          <option value="any">Any</option><option value="with">Has bookmarks</option><option value="without">No bookmarks</option>
        </select></label>
        <label className="playlist-favourites"><input type="checkbox" checked={rules.favourites_only}
          onChange={event => setRules({ ...rules, favourites_only: event.target.checked })} /> Favourites only</label>
        <p>{items.filter(item => matchesSmartPlaylist(item, rules, now)).length} matching tracks · updates automatically</p>
      </fieldset>}
      {!draft.smart && !!draft.itemIds?.length && <p>{draft.itemIds.length} selected tracks will be included.</p>}
      {error && <p role="alert" className="library-edit-error">{error}</p>}
      <footer><button type="button" disabled={pending} onClick={onClose}>Cancel</button>
        <button type="submit" disabled={pending || !name.trim()}>{pending ? 'Saving…' : draft.playlist ? 'Save changes' : 'Create playlist'}</button></footer>
    </form>
  </dialog>;
}
