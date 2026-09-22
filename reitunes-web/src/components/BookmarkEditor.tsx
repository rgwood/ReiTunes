import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { updateBookmark } from '../hooks/useLibrary';
import { usePlayerStore, type PlaybackRange } from '../stores/playerStore';
import { usePlaybackTargetStore } from '../stores/playbackTargetStore';
import { formatBookmarkPosition as format, parseBookmarkPosition as parse, type BookmarkEntry } from '../utils/bookmarks';
import type { LibraryItem } from '../types';

export interface BookmarkPlaybackProps {
  onPlay: (item: LibraryItem, position: number, range?: PlaybackRange) => void;
  getPlaybackTime?: (itemId: string) => { position: number; duration: number } | null;
}

export function BookmarkEditor({ entry, onClose, onPlay, getPlaybackTime }: BookmarkPlaybackProps & { entry: BookmarkEntry; onClose: () => void }) {
  const { item, bookmark, bookmarkId } = entry;
  const queryClient = useQueryClient();
  const currentItemId = usePlayerStore(state => state.currentItemId);
  const output = usePlaybackTargetStore(state => state.target.kind);
  const [label, setLabel] = useState(bookmark.label || '');
  const [emoji, setEmoji] = useState(bookmark.emoji || '🔖');
  const [start, setStart] = useState(format(bookmark.position, true));
  const [end, setEnd] = useState(bookmark.end_position == null ? '' : format(bookmark.end_position, true));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const startTime = parse(start), endTime = end.trim() ? parse(end) : null;
  const valid = startTime !== null && (!end.trim() || endTime !== null && endTime > startTime);
  function preview(atEnd: boolean) {
    if (!valid || startTime === null) return;
    onPlay(item, atEnd && endTime !== null ? Math.max(startTime, endTime - 5) : startTime,
      { start: startTime, end: endTime, afterEnd: 'pause' });
  }
  async function save() {
    if (pending) return;
    if (!valid || startTime === null) { setError('Enter a time in seconds, m:ss or h:mm:ss. The end must be after the start, or left blank.'); return; }
    const duration = getPlaybackTime?.(item.id)?.duration;
    if (duration && Number.isFinite(duration) && (startTime >= duration || endTime !== null && endTime > duration)) {
      setError('The start and end must be within this recording.'); return;
    }
    setPending(true); setError('');
    try {
      await updateBookmark(item.id, bookmarkId, label, emoji,
        start === format(bookmark.position, true) ? undefined : startTime, endTime);
      await queryClient.invalidateQueries({ queryKey: ['library'] });
      onClose();
    } catch { setError('Could not save the bookmark. Your changes are still here; try again.'); }
    finally { setPending(false); }
  }
  return <form className="bookmark-range-editor" aria-label={`Edit bookmark for ${item.name}`} onSubmit={event => { event.preventDefault(); void save(); }}
    onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); if (!pending) onClose(); } }}>
    <h3>Edit bookmark</h3><p className="bookmark-editor-track" title={item.name}>{item.name}</p>
    <div className="bookmark-identity"><input value={emoji} onChange={event => setEmoji(event.target.value)} disabled={pending} className="bookmark-emoji-input" aria-label={`Bookmark emoji for ${item.name}`} />
      <input value={label} onChange={event => setLabel(event.target.value)} disabled={pending} className="bookmark-label-input" aria-label={`Bookmark label for ${item.name}`} placeholder="Name this moment…" autoFocus onFocus={event => event.target.select()} /></div>
    {(['start', 'end'] as const).map(edge => {
      const value = edge === 'start' ? start : end, setValue = edge === 'start' ? setStart : setEnd;
      const time = parse(value);
      return <fieldset key={edge} disabled={pending}><legend>{edge === 'start' ? 'Start' : 'End (optional)'}</legend>
        <div className="bookmark-time-field"><input value={value} onChange={event => { setValue(event.target.value); setError(''); }} spellCheck={false}
          aria-label={edge === 'start' ? `Bookmark time for ${item.name}` : `Bookmark end time for ${item.name}`}
          aria-invalid={edge === 'start' ? time === null : !!value.trim() && (time === null || startTime !== null && time <= startTime)}
          placeholder={edge === 'start' ? '0:00' : 'No end time'} />
          <button type="button" disabled={currentItemId !== item.id || !getPlaybackTime} onClick={() => {
            const live = getPlaybackTime?.(item.id); if (live) { setValue(format(live.position, true)); setError(''); }
          }} aria-label={`Set bookmark ${edge} to current playback time`} title="Use the current playback position">Use current</button>
          {edge === 'end' && end && <button type="button" onClick={() => setEnd('')} aria-label="Clear bookmark end time">×</button>}
        </div>
        <div className="bookmark-nudges">{[-5, -1, 1, 5].map(offset => <button key={offset} type="button" disabled={time === null}
          aria-label={edge === 'start' && Math.abs(offset) === 1 ? `Move bookmark ${offset < 0 ? 'back' : 'forward'} one second` : `Move ${edge} ${offset < 0 ? 'back' : 'forward'} ${Math.abs(offset)} seconds`}
          onClick={() => { if (time !== null) { setValue(format(Math.max(0, time + offset), true)); setError(''); } }}>{offset < 0 ? '−' : '+'}{Math.abs(offset)}s</button>)}
          <button type="button" disabled={!valid || edge === 'end' && endTime === null} onClick={() => preview(edge === 'end')}>{edge === 'start' ? 'Preview start' : 'Preview end'}</button>
        </div>
      </fieldset>;
    })}
    <p className="bookmark-editor-help">Use seconds, m:ss or h:mm:ss. Preview end plays the last five seconds and pauses.</p>
    {endTime !== null && <p className="bookmark-editor-help">At the end: play the next bookmark in this mix, or pause if there isn’t one.{output === 'sonos' && ' Keep ReiTunes open to apply end times on Sonos.'}</p>}
    {error && <p role="alert" className="bookmark-error">{error}</p>}
    <footer><button type="button" onClick={onClose} disabled={pending} aria-label="Cancel editing bookmark">Cancel</button><button type="submit" disabled={pending} aria-label="Save bookmark">{pending ? 'Saving…' : 'Save'}</button></footer>
  </form>;
}
