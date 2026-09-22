import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { LibraryItem, Playlist } from '../types';
import { draggedTrackIds, playlistItems, TRACK_DRAG_TYPE } from '../utils/playlists';
import { usePlaylistMutation } from '../hooks/usePlaylists';
import { MusicIcon } from './MusicIcon';
import type { PlaylistDraft } from './PlaylistDialog';

const collections = [
  ['all', 'All music', 'music'], ['recent', 'Recently added', 'clock'],
  ['unplayed', 'Unplayed', 'play'], ['favourites', 'Favourites', 'heart'], ['bookmarks', 'Bookmarks', 'bookmark'],
] as const;

export function LibrarySidebar({ active, items, playlists, now, discoveryCount, playlistError, onSelect, onEdit, onImport, onSettings, outputName, onOutput, tagsOpen, activeTagCount, failedTagCount, onTags }: {
  active: string; items: LibraryItem[]; playlists: Playlist[]; now: number; discoveryCount: number;
  playlistError: boolean; onSelect: (id: string) => void; onEdit: (draft: PlaylistDraft) => void;
  onImport: () => void; onSettings: () => void;
  outputName: string; onOutput: () => void;
  tagsOpen: boolean; activeTagCount: number; failedTagCount: number; onTags: () => void;
}) {
  const mutation = usePlaylistMutation();
  const [error, setError] = useState('');
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ playlist: Playlist; x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!menu || !menuRef.current) return;
    const el = menuRef.current;
    el.style.left = Math.max(4, Math.min(menu.x, innerWidth - el.offsetWidth - 4)) + 'px';
    el.style.top = Math.max(4, Math.min(menu.y, innerHeight - el.offsetHeight - 4)) + 'px';
    el.querySelector('button')?.focus();
  }, [menu]);
  useEffect(() => {
    const close = () => setMenu(null);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, []);

  const count = (id: string) => id === 'all' ? items.length : id === 'recent'
    ? items.filter(item => Date.parse(/Z|[+-]\d\d:\d\d$/.test(item.created_time_utc) ? item.created_time_utc : item.created_time_utc + 'Z') >= now - 30 * 86400000).length
    : id === 'unplayed' ? items.filter(item => item.play_count === 0).length
    : id === 'favourites' ? items.filter(item => item.is_favorite).length
    : items.reduce((total, item) => total + Object.keys(item.bookmarks).length, 0);

  async function drop(event: React.DragEvent, playlist: Playlist) {
    event.preventDefault(); setDropTarget(null); setError('');
    const ids = draggedTrackIds(event.dataTransfer).filter(id => items.some(item => item.id === id));
    if (!ids.length || playlist.smart_rules || mutation.isPending) return;
    try { await mutation.mutateAsync({ path: '/' + playlist.id + '/items', method: 'POST', body: { library_item_ids: ids } }); }
    catch { setError('Could not add tracks to the playlist. Please try again.'); }
  }

  function playlistButton(playlist: Playlist) {
    return <button key={playlist.id} className={dropTarget === playlist.id ? 'source-item drop-target' : 'source-item'}
      aria-label={playlist.name} aria-current={active === 'playlist:' + playlist.id ? 'page' : undefined}
      onClick={() => onSelect('playlist:' + playlist.id)}
      onContextMenu={event => { event.preventDefault(); setMenu({ playlist, x: event.clientX, y: event.clientY }); }}
      onKeyDown={event => {
        if (event.key === 'F2') { event.preventDefault(); onEdit({ playlist, smart: !!playlist.smart_rules }); }
        if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
          event.preventDefault(); const box = event.currentTarget.getBoundingClientRect();
          setMenu({ playlist, x: box.left, y: box.bottom });
        }
      }}
      onDragOver={event => {
        if (!playlist.smart_rules && event.dataTransfer.types.includes(TRACK_DRAG_TYPE)) {
          event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; setDropTarget(playlist.id);
        }
      }}
      onDragLeave={() => setDropTarget(null)} onDrop={event => void drop(event, playlist)}>
      <span className={playlist.smart_rules ? 'source-icon smart-icon' : 'source-icon'}><MusicIcon name={playlist.smart_rules ? 'smart' : 'playlist'} size={16} /></span>
      <span className="source-name">{playlist.name}</span><span className="source-count" aria-hidden="true">{playlistItems(playlist, items, now).length}</span>
    </button>;
  }

  return <nav className="source-sidebar" aria-label="Music library">
    <div className="source-scroll">
      <section><h2>Library</h2>{collections.map(([id, label, icon]) => <button key={id} className="source-item"
        aria-label={label} aria-current={active === id ? 'page' : undefined} onClick={() => onSelect(id)}>
        <span className="source-icon"><MusicIcon name={icon} size={16} /></span><span className="source-name">{label}</span><span className="source-count" aria-hidden="true">{count(id)}</span>
      </button>)}
      <button className="source-item" aria-label="Tags" aria-pressed={tagsOpen} onClick={onTags}
        title={activeTagCount ? `${activeTagCount} tracks getting tags` : failedTagCount ? `${failedTagCount} tracks could not be tagged` : 'Browse and manage tags'}>
        <span className="source-icon"><MusicIcon name="tag" size={16} /></span><span className="source-name">Tags</span>
        {(activeTagCount > 0 || failedTagCount > 0) && <span className="source-count" aria-hidden="true">{activeTagCount || '!'}</span>}
      </button>
      <button className="source-item" aria-label="Discover" aria-current={active === 'discover' ? 'page' : undefined} onClick={() => onSelect('discover')}>
        <span className="source-icon"><MusicIcon name="discover" size={16} /></span><span className="source-name">Discover</span><span className="source-count" aria-hidden="true">{discoveryCount}</span>
      </button></section>
      <section><h2>Smart Playlists</h2>{playlists.filter(p => p.smart_rules).map(playlistButton)}</section>
      <section><h2>Playlists</h2>{playlists.filter(p => !p.smart_rules).map(playlistButton)}</section>
      {(error || playlistError) && <p className="sidebar-error" role="alert">{error || 'Could not load playlists. Retrying…'}</p>}
    </div>
    <div className="source-actions">
      <button onClick={() => onEdit({ smart: false })}><MusicIcon name="plus" size={16} /> New playlist</button>
      <button onClick={() => onEdit({ smart: true })}><MusicIcon name="smart" size={16} /> New Smart Playlist</button>
      <button onClick={onImport}><MusicIcon name="plus" size={13} /> Import music</button>
      <button aria-label="Settings" onClick={onSettings}><MusicIcon name="settings" size={13} /> Settings</button>
      <div className="player-output"><button className="output-button" onClick={onOutput} aria-label="Sonos" title="Choose playback output">
        <MusicIcon name="speaker" size={14} /><span>{outputName}</span>
      </button></div>
    </div>
    {menu && <div ref={menuRef} className="source-context-menu" role="menu" aria-label="Playlist actions" onClick={event => event.stopPropagation()}
      style={{ left: menu.x, top: menu.y }} onKeyDown={event => { if (event.key === 'Escape') setMenu(null); }}>
      <button role="menuitem" onClick={() => { onEdit({ playlist: menu.playlist, smart: !!menu.playlist.smart_rules }); setMenu(null); }}>
        {menu.playlist.smart_rules ? 'Edit Smart Playlist…' : 'Rename playlist…'}
      </button>
      <button role="menuitem" disabled={mutation.isPending} onClick={async () => {
        if (!confirm('Delete playlist "' + menu.playlist.name + '"? The tracks stay in your library.')) return;
        try {
          await mutation.mutateAsync({ path: '/' + menu.playlist.id, method: 'DELETE' });
          if (active === 'playlist:' + menu.playlist.id) onSelect('all');
          setMenu(null);
        } catch { setError('Could not delete the playlist. Please try again.'); }
      }}>Delete playlist</button>
    </div>}
  </nav>;
}
