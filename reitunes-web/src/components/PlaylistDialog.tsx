import { useEffect, useId, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { LibraryItem, Playlist, SmartPlaylistRules } from '../types';
import { playlistRequest } from '../hooks/usePlaylists';
import { matchesSmartPlaylist, ruleExpression, type PlaylistTagItems } from '../utils/playlists';
import { effectiveTags } from '../hooks/useTags';
import { SmartRulesEditor } from './SmartRulesEditor';
import { durationLabel, trackDuration } from '../utils/duration';

export interface PlaylistDraft {
  playlist?: Playlist;
  smart: boolean;
  itemIds?: string[];
}

export function PlaylistDialog({ draft, items, tagItems, tagError, onClose, onSaved }: {
  draft: PlaylistDraft;
  items: LibraryItem[];
  tagItems?: PlaylistTagItems;
  tagError?: boolean;
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
    expression: ruleExpression(draft.playlist?.smart_rules),
  }));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [now] = useState(Date.now);
  const matching = items.filter(item => matchesSmartPlaylist(item, rules, now, tagItems));
  const availableTags = [...new Set(items.flatMap(item => effectiveTags(tagItems?.[item.id])))].sort();
  const knownDurations = matching.map(trackDuration).filter((seconds): seconds is number => seconds !== null);
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
        <legend>Rules</legend>
        <SmartRulesEditor rule={rules.expression!} tagOptionsId={id + '-tags'} onChange={expression => setRules({ ...rules, expression })} />
        <datalist id={id + '-tags'}>{availableTags.map(tag => <option key={tag} value={tag} />)}</datalist>
        <p>{matching.length} matching {matching.length === 1 ? 'track' : 'tracks'} · {durationLabel(knownDurations.reduce((sum, seconds) => sum + seconds, 0))} total
          {knownDurations.length < matching.length && ` · ${matching.length - knownDurations.length} with unknown duration`}</p>
        <p className="tracklist-help">Updates automatically. Duration comparisons exclude tracks whose duration is unknown.</p>
        <p className="tracklist-help">Tag rules use the tags shown in your library, including your additions and removals. “Has tags: No” finds tracks with no current tags, including tracks still waiting for tagging.</p>
        {!tagItems && <p role="status">{tagError ? 'Could not load tags. Tag matches will update when tags are available.' : 'Loading tags…'}</p>}
      </fieldset>}
      {!draft.smart && !!draft.itemIds?.length && <p>{draft.itemIds.length} selected tracks will be included.</p>}
      {error && <p role="alert" className="library-edit-error">{error}</p>}
      <footer><button type="button" disabled={pending} onClick={onClose}>Cancel</button>
        <button type="submit" disabled={pending || !name.trim()}>{pending ? 'Saving…' : draft.playlist ? 'Save changes' : 'Create playlist'}</button></footer>
    </form>
  </dialog>;
}
