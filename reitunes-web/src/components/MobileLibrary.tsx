import { memo, useEffect, useRef, useState } from 'react';
import type { LibraryItem, Playlist } from '../types';
import { MusicIcon } from './MusicIcon';
import { SongInfoDialog } from './SongInfoDialog';
import { TracklistDialog } from './TracklistDialog';
import { usePlayback } from '../hooks/usePlayback';
import { useQueueStore } from '../hooks/useQueue';
import { usePlayerStore } from '../stores/playerStore';
import { usePlaylistMutation } from '../hooks/usePlaylists';
import { toggleFavorite } from '../hooks/useLibrary';
import { durationLabel, trackDuration } from '../utils/duration';

interface Props {
  items: LibraryItem[];
  playlists: Playlist[];
  contextName: string;
  disabled: boolean;
  onTags: (item: LibraryItem) => void;
  onBookmarks: (item: LibraryItem) => void;
  onNewPlaylist: (itemIds: string[]) => void;
}

function SongActions({ item, playlists, disabled, onClose, onTags, onBookmarks, onInfo, onTracklist, onNewPlaylist, onNotice }: {
  item: LibraryItem; playlists: Playlist[]; disabled: boolean; onClose: () => void;
  onTags: () => void; onBookmarks: () => void; onInfo: () => void; onTracklist: () => void;
  onNewPlaylist: () => void; onNotice: (message: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [pickingPlaylist, setPickingPlaylist] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const mutation = usePlaylistMutation();
  useEffect(() => { dialog.current?.showModal(); }, []);
  const queue = (next: boolean) => {
    if (disabled) return;
    if (next) useQueueStore.getState().addNext(item);
    else useQueueStore.getState().addToQueue(item);
    onNotice(next ? `${item.name} will play next` : `Added ${item.name} to queue`);
    onClose();
  };
  const addPlaylist = async (id: string) => {
    setPending(true); setError('');
    try {
      await mutation.mutateAsync({ path: `/${id}/items`, method: 'POST', body: { library_item_ids: [item.id] } });
      onNotice(`Added to ${playlists.find(playlist => playlist.id === id)?.name ?? 'playlist'}`);
      onClose();
    } catch (error) { setError(error instanceof Error ? error.message : 'Could not add this song.'); }
    finally { setPending(false); }
  };
  return <dialog ref={dialog} className="mobile-action-sheet" aria-labelledby="mobile-song-actions-title"
    onCancel={event => { event.preventDefault(); if (!pending) onClose(); }}
    onClick={event => { if (event.target === event.currentTarget && !pending) onClose(); }}>
    <header><div><h2 id="mobile-song-actions-title">{pickingPlaylist ? 'Add to playlist' : item.name}</h2><p>{pickingPlaylist ? item.name : item.artist}</p></div>
      <button onClick={onClose} disabled={pending} aria-label="Close song actions"><MusicIcon name="close" /></button></header>
    {error && <p className="mobile-action-error" role="alert">{error}</p>}
    <div className="mobile-action-list">
      {pickingPlaylist ? <>
        <button onClick={() => setPickingPlaylist(false)}>← Song actions</button>
        <button onClick={onNewPlaylist}><MusicIcon name="plus" />New playlist</button>
        {playlists.filter(playlist => !playlist.smart_rules).map(playlist => <button key={playlist.id} disabled={pending} onClick={() => void addPlaylist(playlist.id)}><MusicIcon name="playlist" />{playlist.name}</button>)}
        {!playlists.some(playlist => !playlist.smart_rules) && <p>Create a playlist to add this song.</p>}
      </> : <>
        <button disabled={disabled} onClick={() => queue(true)}><MusicIcon name="play" />Play next</button>
        <button disabled={disabled} onClick={() => queue(false)}><MusicIcon name="queue" />Add to queue</button>
        <button onClick={() => setPickingPlaylist(true)}><MusicIcon name="playlist" />Add to playlist…</button>
        <button disabled={pending} onClick={async () => {
          setPending(true); setError('');
          try { await toggleFavorite(item.id, !!item.is_favorite); onNotice(item.is_favorite ? 'Removed from favourites' : 'Added to favourites'); onClose(); }
          catch { setError('Could not update favourite. Please try again.'); }
          finally { setPending(false); }
        }}><MusicIcon name="heart" />{item.is_favorite ? 'Remove favourite' : 'Favourite'}</button>
        <button onClick={onInfo}><MusicIcon name="music" />Song info</button>
        <button onClick={onTracklist}><MusicIcon name="playlist" />{item.tracklist ? 'Tracklist' : 'Find tracklist…'}</button>
        <button onClick={onTags}><MusicIcon name="tag" />Tags</button>
        <button onClick={onBookmarks}><MusicIcon name="bookmark" />Bookmarks</button>
      </>}
    </div>
  </dialog>;
}

function MobileTracklist({ item, disabled, onClose, onEdit }: { item: LibraryItem; disabled: boolean; onClose: () => void; onEdit: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const play = usePlayback();
  useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog ref={dialog} className="mobile-action-sheet" aria-label={`Tracks within ${item.name}`}
    onCancel={event => { event.preventDefault(); onClose(); }}>
    <header><div><h2>{item.name}</h2><p>{item.artist} · {item.tracklist?.tracks.length} tracks</p></div>
      <button aria-label="Close tracklist" onClick={onClose}><MusicIcon name="close" /></button></header>
    <div className="mobile-action-list">
      {item.tracklist?.tracks.map((track, index) => <button key={`${index}-${track.start}`} disabled={disabled}
        onClick={() => {
          void play(item, track.start, 'mobile-chapter', { start: track.start, end: track.end ?? item.tracklist?.tracks[index + 1]?.start ?? item.tracklist?.duration ?? null });
          onClose();
        }}><MusicIcon name="play" /><span>{track.title}</span><small>{durationLabel(track.start)}</small></button>)}
      <button onClick={onEdit}><MusicIcon name="playlist" />Edit tracklist…</button>
    </div>
  </dialog>;
}

export const MobileLibrary = memo(function MobileLibrary({ items, playlists, contextName, disabled, onTags, onBookmarks, onNewPlaylist }: Props) {
  const currentItemId = usePlayerStore(state => state.currentItemId);
  const play = usePlayback();
  const [actionItem, setActionItem] = useState<LibraryItem | null>(null);
  const [infoItem, setInfoItem] = useState<LibraryItem | null>(null);
  const [tracklistItem, setTracklistItem] = useState<LibraryItem | null>(null);
  const [editingTracklist, setEditingTracklist] = useState(false);
  const [notice, setNotice] = useState('');
  const [limit, setLimit] = useState(100);
  useEffect(() => { if (!notice) return; const timer = window.setTimeout(() => setNotice(''), 3500); return () => window.clearTimeout(timer); }, [notice]);
  const open = (callback: (item: LibraryItem) => void) => { if (actionItem) callback(actionItem); setActionItem(null); };
  return <>
    <ol className="mobile-song-list" aria-label={contextName}>
      {items.slice(0, limit).map((item, index) => {
        const duration = trackDuration(item);
        return <li key={item.id} data-item-id={item.id} aria-current={item.id === currentItemId ? 'true' : undefined}>
          <button className="mobile-song-play" disabled={disabled} aria-label={`Play ${item.name}`} onClick={() => {
            useQueueStore.getState().setContext(items, index, contextName);
            void play(item, 0, 'mobile-song');
          }}>
            <span className="mobile-song-mark" aria-hidden="true">{item.id === currentItemId ? <MusicIcon name="play" /> : <MusicIcon name="music" />}</span>
            <span className="mobile-song-copy"><span>{item.name}</span><small>{item.artist || 'Unknown artist'}{item.album && ` · ${item.album}`}</small></span>
            {duration !== null && <span className="mobile-song-duration">{durationLabel(duration)}</span>}
          </button>
          <button className="mobile-song-more" aria-label={`Actions for ${item.name}`} onClick={() => setActionItem(item)}>•••</button>
        </li>;
      })}
    </ol>
    {items.length > limit && <button className="mobile-show-more" onClick={() => setLimit(value => value + 100)}>Show more songs ({items.length - limit} remaining)</button>}
    {notice && <p className="mobile-notice" role="status">{notice}</p>}
    {actionItem && <SongActions item={items.find(item => item.id === actionItem.id) ?? actionItem} playlists={playlists} disabled={disabled}
      onClose={() => setActionItem(null)} onTags={() => open(onTags)} onBookmarks={() => open(onBookmarks)}
      onInfo={() => open(setInfoItem)} onTracklist={() => open(item => { setTracklistItem(item); setEditingTracklist(!item.tracklist); })}
      onNewPlaylist={() => open(item => onNewPlaylist([item.id]))} onNotice={setNotice} />}
    {infoItem && <SongInfoDialog item={items.find(item => item.id === infoItem.id) ?? infoItem} onClose={() => setInfoItem(null)} />}
    {tracklistItem && (editingTracklist
      ? <TracklistDialog item={items.find(item => item.id === tracklistItem.id) ?? tracklistItem} onClose={() => setTracklistItem(null)} onApplied={() => setNotice('Tracklist saved')} />
      : <MobileTracklist item={items.find(item => item.id === tracklistItem.id) ?? tracklistItem} disabled={disabled} onClose={() => setTracklistItem(null)} onEdit={() => setEditingTracklist(true)} />)}
  </>;
});
