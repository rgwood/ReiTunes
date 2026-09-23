import { useEffect, useRef, useCallback, useState, type RefObject } from 'react';
import { usePlayerStore, type PlaybackRange } from '../stores/playerStore';
import { useQueueStore } from '../hooks/useQueue';
import { getItemUrl, markPlayed, addBookmark } from '../hooks/useLibrary';
import { usePlayback } from '../hooks/usePlayback';
import { useSonosControls } from '../hooks/useSonosControls';
import { usePlaybackTargetStore } from '../stores/playbackTargetStore';
import type { LibraryItem } from '../types';
import { audioDiagnostics, observePlaybackMedia, recordPlaybackEvent } from '../utils/playbackDiagnostics';

// Minimal SVG icons - consistent 16px size, 1.5px stroke
const Icons = {
  shuffle: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M16 3h5v5M4 20L21 3M21 16v5h-5M15 15l6 6M4 4l5 5" />
    </svg>
  ),
  skipBack: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="19 20 9 12 19 4 19 20" />
      <line x1="5" y1="19" x2="5" y2="5" />
    </svg>
  ),
  play: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" stroke="none">
      <polygon points="5 3 19 12 5 21 5 3" />
    </svg>
  ),
  pause: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" stroke="none">
      <rect x="6" y="4" width="4" height="16" />
      <rect x="14" y="4" width="4" height="16" />
    </svg>
  ),
  skipForward: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="5 4 15 12 5 20 5 4" />
      <line x1="19" y1="5" x2="19" y2="19" />
    </svg>
  ),
  repeat: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 2l4 4-4 4" />
      <path d="M3 11v-1a4 4 0 0 1 4-4h14" />
      <path d="M7 22l-4-4 4-4" />
      <path d="M21 13v1a4 4 0 0 1-4 4H3" />
    </svg>
  ),
  bookmark: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
    </svg>
  ),
  volume: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
      <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
    </svg>
  ),
  volumeMute: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      <line x1="23" y1="9" x2="17" y2="15" />
      <line x1="17" y1="9" x2="23" y2="15" />
    </svg>
  ),
};

function formatTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function PlayerTrack({ item, position, duration, sonos = false, status }: {
  item: LibraryItem | null; position: number; duration: number; sonos?: boolean; status?: string;
}) {
  return <div className="player-track">
    <div className={`player-title ${sonos ? 'sonos-track-title' : 'player-now-playing'}`}
      title={status ?? (item ? [item.name, item.artist, item.album].filter(Boolean).join(' — ') : undefined)}>
      {status ? <span role="status">{status}</span>
        : item ? <><span>{item.name}</span>{item.artist && <span className="player-artist"> — {item.artist}</span>}</>
        : <span>No song selected</span>}
    </div>
    <span className="player-timing">{formatTime(position)} <span aria-hidden="true">/</span> {duration > 0 ? formatTime(duration) : '—:—'}</span>
  </div>;
}

function PlayerTransport({ playing, onPrevious, onNext, onToggle, onBack, onForward,
  skipDisabled = false, playDisabled = false, seekDisabled = false, sonos = false }: {
  playing: boolean; onPrevious: () => void; onNext: () => void; onToggle: () => void;
  onBack: () => void; onForward: () => void; skipDisabled?: boolean; playDisabled?: boolean;
  seekDisabled?: boolean; sonos?: boolean;
}) {
  const action = playing ? 'Pause' : 'Play';
  return <div className={`transport-group ${sonos ? 'sonos-transport' : 'player-transport'}`} role="group" aria-label="Playback controls">
      <button type="button" className="transport-previous" onClick={onPrevious} disabled={skipDisabled}
        aria-label={sonos ? 'Previous on Sonos' : 'Previous'} title="Previous">{Icons.skipBack}</button>
      <button type="button" className="transport-seek transport-back" onClick={onBack} disabled={seekDisabled}
        aria-label={sonos ? 'Back 30s on Sonos' : 'Back 30s'} title="Back 30s"><SeekIcon /></button>
      <button type="button" onClick={onToggle} disabled={playDisabled} className="play-toggle"
        aria-label={sonos ? `${action} Sonos` : action} title={sonos ? `${action} Sonos` : action}>{playing ? Icons.pause : Icons.play}</button>
      <button type="button" className="transport-seek transport-forward" onClick={onForward} disabled={seekDisabled}
        aria-label={sonos ? 'Forward 30s on Sonos' : 'Forward 30s'} title="Forward 30s"><SeekIcon forward /></button>
      <button type="button" className="transport-next" onClick={onNext} disabled={skipDisabled}
        aria-label={sonos ? 'Next on Sonos' : 'Next'} title="Next">{Icons.skipForward}</button>
  </div>;
}

function SeekIcon({ forward = false }: { forward?: boolean }) {
  return <svg width="30" height="30" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <g transform={forward ? 'translate(24 0) scale(-1 1)' : undefined}
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8M3 3v5h5" />
    </g>
    <text x="12" y="15.2" textAnchor="middle" fill="currentColor" fontSize="8.5" fontFamily="system-ui, sans-serif">30</text>
  </svg>;
}

function PlayerBookmark({ onClick, disabled = false, feedback, sonos = false }: {
  onClick: () => void; disabled?: boolean; feedback: 'idle' | 'success' | 'error'; sonos?: boolean;
}) {
  const label = sonos ? 'Bookmark current Sonos time' : 'Add bookmark';
  return <button type="button" className="player-bookmark" data-feedback={feedback}
    onClick={onClick} disabled={disabled} aria-label={label} title={label}>{Icons.bookmark}</button>;
}

interface AudioPlayerProps {
  audioRef: RefObject<HTMLAudioElement | null>;
  items: LibraryItem[];
  onPlaybackPosition?: (itemId: string, position: number) => void;
  previewPauseRef?: RefObject<(() => Promise<boolean>) | null>;
}

export function AudioPlayer({ audioRef: sharedAudioRef, items, onPlaybackPosition, previewPauseRef }: AudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const attachAudio = useCallback((audio: HTMLAudioElement | null) => {
    audioRef.current = audio;
    sharedAudioRef.current = audio;
  }, [sharedAudioRef]);
  const progressRef = useRef<HTMLDivElement>(null);
  const lastPlayedIdRef = useRef<string | null>(null);
  const lastItemIdRef = useRef<string | null>(null);
  const lastCheckpointRef = useRef(-1);
  const isChangingSourceRef = useRef(false);
  const wasSonosSendingRef = useRef(false);
  const sonosPositionReadyAfterRef = useRef(0);

  const [currentTime, setCurrentTimeLocal] = useState(0);
  const [duration, setDurationLocal] = useState(0);
  const [sonosVolumeDraft, setSonosVolumeDraft] = useState<number | null>(null);
  const [sonosSeekDraft, setSonosSeekDraft] = useState<number | null>(null);
  const [bookmarkFeedback, setBookmarkFeedback] = useState<'idle' | 'success' | 'error'>('idle');

  const {
    currentItem,
    currentItemId,
    playbackRange,
    isPlaying,
    pendingSeek,
    volume,
    isMuted,
    setIsPlaying,
    clearPendingSeek,
    resumePosition,
    setResumePosition,
    setVolume,
    setMuted,
    selectRemoteItem,
  } = usePlayerStore();
  const play = usePlayback();
  const { target, isSending, isSwitchingOutput, error: playbackError, takeoverRequired } =
    usePlaybackTargetStore();
  const sonos = useSonosControls(target.kind === 'sonos' ? target.groupId : null);
  const { play: playSonos, pause: pauseSonos, seek: seekOnSonos, playback: sonosPlayback } = sonos;
  useEffect(() => {
    setSonosSeekDraft(null);
  }, [target, sonosPlayback?.itemId, sonosPlayback?.sourceItemId]);
  const sonosSessionActive = sonosPlayback?.reitunesSessionActive === true;
  const sonosIsPlaying =
    sonosPlayback?.playbackState === 'PLAYBACK_STATE_PLAYING' ||
    sonosPlayback?.playbackState === 'PLAYBACK_STATE_BUFFERING';
  const mediaSessionActive = !!currentItem && (target.kind === 'browser' ||
    (sonosSessionActive && sonosPlayback?.sourceItemId === currentItem.id));
  const mediaPosition = target.kind === 'sonos' ? (sonos.requestedSeekMillis ?? sonos.positionMillis) / 1000 : currentTime;
  const refreshSonosPlayback = sonos.refreshPlayback;
  useEffect(() => {
    if (!previewPauseRef) return;
    const pauseForPreview = async () => {
      const output = usePlaybackTargetStore.getState();
      if (output.target !== target || output.isSending || output.isSwitchingOutput || output.isTransportPending) return false;
      if (target.kind === 'sonos') {
        if (!sonosPlayback) return false;
        const paused = ['PLAYBACK_STATE_PAUSED', 'PLAYBACK_STATE_IDLE'].includes(sonosPlayback.playbackState);
        if (!paused && (!sonosSessionActive || sonosPlayback.availablePlaybackActions?.canPause === false || !await pauseSonos())) return false;
      } else {
        audioRef.current?.pause();
        setIsPlaying(false);
      }
      const latest = usePlaybackTargetStore.getState();
      return latest.target === target && !latest.isSending && !latest.isSwitchingOutput && !latest.isTransportPending;
    };
    previewPauseRef.current = pauseForPreview;
    return () => { if (previewPauseRef.current === pauseForPreview) previewPauseRef.current = null; };
  }, [previewPauseRef, target, sonosPlayback, sonosSessionActive, pauseSonos, setIsPlaying]);
  const { playNext, playPrevious, shuffleEnabled, repeatMode, toggleShuffle, cycleRepeatMode } = useQueueStore();
  const finishingRange = useRef<PlaybackRange | null>(null);
  const finishRange = useCallback(async (range: PlaybackRange) => {
    const player = usePlayerStore.getState();
    if (!player.currentItem || range.end === null || finishingRange.current === range) return;
    finishingRange.current = range;
    const output = usePlaybackTargetStore.getState().target;
    const remote = output.kind === 'sonos';
    if (remote) { if (!await pauseSonos()) return; }
    else if (audioRef.current) { audioRef.current.pause(); audioRef.current.currentTime = range.end; }
    const next = range.afterEnd === 'pause' ? undefined : Object.entries(player.currentItem.bookmarks)
      .filter(([, bookmark]) => bookmark.position >= range.end! && bookmark.position > range.start)
      .sort((a, b) => a[1].position - b[1].position)[0];
    if (usePlayerStore.getState().playbackRange !== range || usePlaybackTargetStore.getState().target !== output) {
      finishingRange.current = null; return;
    }
    if (next) {
      const [bookmarkId, bookmark] = next;
      await play(player.currentItem, bookmark.position, 'bookmark-end', { start: bookmark.position, end: bookmark.end_position ?? null, bookmarkId });
    } else {
      player.setResumePosition(range.end);
      player.setIsPlaying(false);
      // Keep the completed range through a possible native ended event.
      // An explicit Play resumes the full recording.
    }
  }, [pauseSonos, play]);

  useEffect(() => {
    if (target.kind !== 'sonos' || !sonosIsPlaying || !sonosSessionActive || isSending || isSwitchingOutput || playbackError ||
      sonos.isTransportPending || sonos.playback?.sourceItemId !== currentItemId ||
      (sonos.playback?.observedAt ?? 0) < sonosPositionReadyAfterRef.current || !playbackRange || playbackRange.end === null) return;
    if (sonos.positionMillis / 1000 >= playbackRange.end) void finishRange(playbackRange);
    else if (finishingRange.current === playbackRange) finishingRange.current = null;
  }, [target.kind, sonosIsPlaying, sonosSessionActive, isSending, isSwitchingOutput, playbackError, sonos.isTransportPending, sonos.playback, sonos.positionMillis, currentItemId, playbackRange, finishRange]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    return observePlaybackMedia(audio, () => ({
      itemId: usePlayerStore.getState().currentItemId,
      target: usePlaybackTargetStore.getState().target.kind,
    }));
  }, [target.kind]);

  useEffect(() => {
    recordPlaybackEvent('state', {
      itemId: currentItem?.id, target: target.kind, isPlaying, pendingSeek,
      ...(audioRef.current ? audioDiagnostics(audioRef.current) : {}),
    });
  }, [currentItem?.id, isPlaying, pendingSeek, target.kind]);

  useEffect(() => {
    const wasSending = wasSonosSendingRef.current;
    wasSonosSendingRef.current = isSending;
    if (target.kind === 'sonos' && wasSending && !isSending && !playbackError) {
      // Wait for a fresh observation after a seek, even within the same track.
      sonosPositionReadyAfterRef.current = Date.now();
      void refreshSonosPlayback().catch(() => undefined);
    }
  }, [isSending, playbackError, refreshSonosPlayback, target.kind]);

  useEffect(() => {
    if (target.kind === 'sonos' && isSending && currentItem) {
      onPlaybackPosition?.(currentItem.id, resumePosition);
      return;
    }
    if (
      target.kind !== 'sonos' || isSending || playbackError || !currentItem ||
      !sonos.playback?.reitunesSessionActive ||
      sonos.playback.sourceItemId !== currentItem.id ||
      sonos.playback.observedAt < sonosPositionReadyAfterRef.current
    ) return;
    onPlaybackPosition?.(currentItem.id, sonos.positionMillis / 1000);
  }, [currentItem, isSending, onPlaybackPosition, playbackError, resumePosition, sonos.playback, sonos.positionMillis, target.kind]);

  // Handle song changes
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !currentItem) return;

    const isNewSong = currentItem.id !== lastItemIdRef.current;
    if (isNewSong || !audio.getAttribute('src')) {
      lastItemIdRef.current = currentItem.id;
      lastCheckpointRef.current = -1;
      isChangingSourceRef.current = target.kind === 'browser';
      audio.src = getItemUrl(currentItem);
    }
  }, [currentItem, target.kind]);

  useEffect(() => {
    if (
      target.kind !== 'sonos' ||
      isSending || playbackError ||
      !sonos.playback?.reitunesSessionActive ||
      sonos.playback.observedAt < sonosPositionReadyAfterRef.current ||
      !sonos.playback.sourceItemId ||
      sonos.playback.sourceItemId === currentItem?.id
    ) {
      return;
    }
    const contextIndex = useQueueStore.getState().contextItems.findIndex(
      (candidate) => candidate.id === sonos.playback?.sourceItemId
    );
    if (contextIndex >= 0) useQueueStore.setState({ contextIndex });
    const item = items.find((candidate) => candidate.id === sonos.playback?.sourceItemId);
    if (item) selectRemoteItem(item, sonos.positionMillis / 1000);
  }, [
    currentItem?.id,
    isSending,
    playbackError,
    items,
    selectRemoteItem,
    sonos.playback?.reitunesSessionActive,
    sonos.playback?.sourceItemId,
    sonos.playback?.observedAt,
    sonos.positionMillis,
    target.kind,
  ]);

  // Restored tracks remain paused. Tracks selected by the user set isPlaying
  // and start through this effect.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !currentItemId) return;

    if (target.kind === 'sonos') {
      if (!audio.paused) audio.pause();
      return;
    }

    let superseded = false;
    if (isPlaying && audio.paused) {
      recordPlaybackEvent('command', { origin: 'sync-play', itemId: currentItemId, ...audioDiagnostics(audio) });
      audio.play().catch((error) => {
        // A source switch or newer play/pause intent can settle an older promise.
        const player = usePlayerStore.getState();
        const stale = superseded || !audio.paused || !player.isPlaying || player.currentItemId !== currentItemId || usePlaybackTargetStore.getState().target.kind !== 'browser';
        recordPlaybackEvent('play-rejected', { stale, itemId: currentItemId, errorName: error instanceof Error ? error.name : 'UnknownError', ...audioDiagnostics(audio) });
        if (!stale) {
          console.error('Failed to start playback:', error);
          setIsPlaying(false);
        }
      });
    } else if (!isPlaying && !audio.paused) {
      recordPlaybackEvent('command', { origin: 'sync-pause', itemId: currentItemId, ...audioDiagnostics(audio) });
      audio.pause();
    }
    return () => { superseded = true; };
  }, [currentItemId, isPlaying, setIsPlaying, target.kind]);

  // Handle pending seek
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || pendingSeek === null || target.kind !== 'browser') return;

    const doSeek = () => {
      recordPlaybackEvent('command', {
        origin: 'apply-seek', itemId: currentItem?.id, target: 'browser',
        targetPosition: pendingSeek, ...audioDiagnostics(audio),
      });
      audio.currentTime = pendingSeek;
      setCurrentTimeLocal(pendingSeek);
      clearPendingSeek();
      const itemId = usePlayerStore.getState().currentItemId;
      if (itemId && itemId === lastItemIdRef.current) {
        onPlaybackPosition?.(itemId, audio.currentTime);
      }
    };

    // Seeking only needs metadata. Waiting for canplay here makes a new
    // bookmark wait for buffering at the position the user is leaving.
    if (audio.readyState >= HTMLMediaElement.HAVE_METADATA) {
      doSeek();
    } else {
      recordPlaybackEvent('command', {
        origin: 'seek-awaiting-metadata', itemId: currentItem?.id, target: 'browser',
        targetPosition: pendingSeek, ...audioDiagnostics(audio),
      });
      const handleMetadata = () => doSeek();
      audio.addEventListener('loadedmetadata', handleMetadata, { once: true });
      return () => audio.removeEventListener('loadedmetadata', handleMetadata);
    }
  }, [pendingSeek, clearPendingSeek, currentItem?.id, onPlaybackPosition, target.kind]);

  // Sync volume
  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.volume = isMuted ? 0 : volume;
    }
  }, [volume, isMuted, target.kind]);

  const handleTimeUpdate = useCallback(() => {
    const audio = audioRef.current;
    const player = usePlayerStore.getState();
    // Ignore the old source while a new track/bookmark seek is still pending.
    if (
      !audio || usePlaybackTargetStore.getState().target.kind !== 'browser' ||
      isChangingSourceRef.current || player.pendingSeek !== null ||
      !player.currentItemId || player.currentItemId !== lastItemIdRef.current
    ) return;

    const position = audio.currentTime;
    if (player.playbackRange?.end != null && position < player.playbackRange.end && finishingRange.current === player.playbackRange) finishingRange.current = null;
    if (player.isPlaying && player.playbackRange?.end != null && position >= player.playbackRange.end) {
      void finishRange(player.playbackRange); return;
    }
    setCurrentTimeLocal(position);
    onPlaybackPosition?.(player.currentItemId, position);

    // The live callback does not increase the persistence frequency.
    const checkpoint = Math.floor(position / 5);
    if (checkpoint !== lastCheckpointRef.current) {
      lastCheckpointRef.current = checkpoint;
      setResumePosition(position);
    }
  }, [onPlaybackPosition, setResumePosition, finishRange]);

  const handleLoadedMetadata = useCallback(() => {
    if (audioRef.current) {
      isChangingSourceRef.current = false;
      setDurationLocal(audioRef.current.duration);
    }
  }, []);

  const handleLoadStart = useCallback(() => {
    setDurationLocal(0);
  }, []);

  const handleEnded = useCallback(() => {
    const range = usePlayerStore.getState().playbackRange;
    if (range?.end != null) { void finishRange(range); return; }
    setResumePosition(0);
    if (repeatMode === 'one' && audioRef.current) {
      audioRef.current.currentTime = 0;
      audioRef.current.play();
      return;
    }
    const nextItem = playNext();
    if (nextItem) void play(nextItem);
  }, [playNext, play, repeatMode, setResumePosition, finishRange]);

  const handlePlayPause = useCallback(() => {
    if (!audioRef.current) return;
    recordPlaybackEvent('command', { origin: isPlaying ? 'button-pause' : 'button-play', ...audioDiagnostics(audioRef.current) });
    if (isPlaying) {
      audioRef.current.pause();
    } else {
      audioRef.current.play().catch((error) => {
        recordPlaybackEvent('play-rejected', { origin: 'button-play', errorName: error instanceof Error ? error.name : 'UnknownError' });
        console.error('Failed to resume playback:', error);
      });
    }
  }, [isPlaying]);

  const handleProgressClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!progressRef.current || !audioRef.current || !duration) return;
    const rect = progressRef.current.getBoundingClientRect();
    const percent = (e.clientX - rect.left) / rect.width;
    const position = percent * duration;
    usePlayerStore.getState().setPlaybackRange(null);
    audioRef.current.currentTime = position;
    setResumePosition(position);
  }, [duration, setResumePosition]);

  const seekBack = useCallback(() => {
    if (audioRef.current) {
      const position = Math.max(0, audioRef.current.currentTime - 30);
      audioRef.current.currentTime = position;
      setResumePosition(position);
    }
  }, [setResumePosition]);

  const seekForward = useCallback(() => {
    if (audioRef.current) {
      const position = Math.min(audioRef.current.duration, audioRef.current.currentTime + 30);
      audioRef.current.currentTime = position;
      setResumePosition(position);
    }
  }, [setResumePosition]);

  const handleAddBookmark = useCallback(async () => {
    if (!currentItem) {
      console.warn('No current item to bookmark');
      return;
    }
    if (!audioRef.current) {
      console.warn('No audio element');
      return;
    }

    const position = audioRef.current.currentTime;
    console.log(`Adding bookmark at ${position}s for item ${currentItem.id}`);

    try {
      await addBookmark(currentItem.id, position);
      setBookmarkFeedback('success');
      setTimeout(() => setBookmarkFeedback('idle'), 1500);
    } catch (err) {
      console.error('Failed to add bookmark:', err);
      setBookmarkFeedback('error');
      setTimeout(() => setBookmarkFeedback('idle'), 1500);
    }
  }, [currentItem]);

  const handleAddSonosBookmark = useCallback(async () => {
    if (!currentItem || !sonos.playback?.reitunesSessionActive) return;
    try {
      await addBookmark(currentItem.id, sonos.positionMillis / 1000);
      setBookmarkFeedback('success');
      setTimeout(() => setBookmarkFeedback('idle'), 1500);
    } catch (err) {
      console.error('Failed to add Sonos bookmark:', err);
      setBookmarkFeedback('error');
      setTimeout(() => setBookmarkFeedback('idle'), 1500);
    }
  }, [currentItem, sonos.playback?.reitunesSessionActive, sonos.positionMillis]);

  const handlePrevious = useCallback(() => {
    const output = usePlaybackTargetStore.getState();
    if (output.isSending || output.isSwitchingOutput || output.isTransportPending) return;
    const prevItem = playPrevious();
    if (prevItem) void play(prevItem);
  }, [playPrevious, play]);

  const handleNext = useCallback(() => {
    const output = usePlaybackTargetStore.getState();
    if (output.isSending || output.isSwitchingOutput || output.isTransportPending) return;
    const nextItem = playNext();
    if (nextItem) void play(nextItem);
  }, [playNext, play]);

  const handleAudioPause = useCallback(() => {
    // Media events are queued tasks. An old pause can arrive after play() has
    // already made the element play again; feeding it back would pause that play.
    if (usePlaybackTargetStore.getState().target.kind !== 'browser' ||
      usePlaybackTargetStore.getState().isSwitchingOutput ||
      isChangingSourceRef.current || !audioRef.current?.paused) return;
    setIsPlaying(false);
    if (audioRef.current) setResumePosition(audioRef.current.currentTime);
  }, [setIsPlaying, setResumePosition]);

  const handleAudioPlay = useCallback(() => {
    if (!audioRef.current || audioRef.current.paused || usePlaybackTargetStore.getState().target.kind !== 'browser') return;
    isChangingSourceRef.current = false;
    const player = usePlayerStore.getState();
    if (player.pendingSeek === null && player.playbackRange?.end != null && audioRef.current.currentTime >= player.playbackRange.end) player.setPlaybackRange(null);
    setIsPlaying(true);
    if (currentItem && currentItem.id !== lastPlayedIdRef.current) {
      lastPlayedIdRef.current = currentItem.id;
      markPlayed(currentItem.id).catch(console.error);
    }
  }, [currentItem, setIsPlaying]);

  useEffect(() => {
    const checkpoint = () => {
      if (audioRef.current) setResumePosition(audioRef.current.currentTime);
    };
    window.addEventListener('pagehide', checkpoint);
    return () => window.removeEventListener('pagehide', checkpoint);
  }, [setResumePosition]);

  useEffect(() => {
    if (!('mediaSession' in navigator)) return;

    navigator.mediaSession.metadata = currentItem && mediaSessionActive
      ? new MediaMetadata({
          title: currentItem.name,
          artist: currentItem.artist,
          album: currentItem.album,
        })
      : null;

    return () => {
      navigator.mediaSession.metadata = null;
    };
  }, [currentItem, mediaSessionActive]);

  useEffect(() => {
    if (!('mediaSession' in navigator)) return;
    navigator.mediaSession.playbackState = mediaSessionActive
      ? (target.kind === 'sonos' ? sonosIsPlaying : isPlaying) ? 'playing' : 'paused'
      : 'none';
  }, [mediaSessionActive, isPlaying, sonosIsPlaying, target.kind]);

  useEffect(() => {
    if (!('mediaSession' in navigator)) return;

    try {
      if (!mediaSessionActive || !duration || !Number.isFinite(duration)) {
        navigator.mediaSession.setPositionState();
        return;
      }
      navigator.mediaSession.setPositionState({
        duration,
        playbackRate: target.kind === 'sonos' ? 1 : audioRef.current?.playbackRate ?? 1,
        position: Math.min(duration, Math.max(0, mediaPosition)),
      });
    } catch (error) {
      console.debug('Could not update media session position:', error);
    }
  }, [mediaPosition, duration, mediaSessionActive, target.kind]);

  useEffect(() => {
    if (!('mediaSession' in navigator)) return;

    const canControl = (seeking = false) => {
      const output = usePlaybackTargetStore.getState();
      // Keep guarded handlers even without a Sonos session: removing them lets
      // the browser's default media-key behavior start the local audio element.
      return mediaSessionActive && output.target === target && !output.isSending &&
        !output.isSwitchingOutput && (seeking || !output.isTransportPending);
    };
    const seek = (position: number, relative = false) => {
      if (!canControl(target.kind === 'sonos') || !Number.isFinite(position)) return;
      if (target.kind === 'sonos') {
        const limit = duration > 0 ? Math.max(0, duration - 0.001) : Infinity;
        void seekOnSonos(position * 1000, { relative, maxPositionMillis: limit * 1000 });
      } else if (audioRef.current) {
        const limit = Number.isFinite(audioRef.current.duration) ? audioRef.current.duration : Infinity;
        const clamped = Math.min(limit, Math.max(0, relative ? audioRef.current.currentTime + position : position));
        audioRef.current.currentTime = clamped;
        setResumePosition(clamped);
      }
    };
    const pause = () => {
      if (!canControl()) return;
      recordPlaybackEvent('command', { origin: 'media-session-pause', target: target.kind });
      if (target.kind === 'sonos') {
        if (sonosPlayback?.availablePlaybackActions?.canPause !== false) void pauseSonos();
      } else {
        audioRef.current?.pause();
      }
    };

    const handlers: Array<[MediaSessionAction, MediaSessionActionHandler]> = [
      ['play', () => {
        if (!canControl()) return;
        recordPlaybackEvent('command', { origin: 'media-session-play', target: target.kind });
        if (target.kind === 'sonos') {
          void playSonos();
          return;
        }
        audioRef.current?.play().catch((error) => {
          recordPlaybackEvent('play-rejected', { origin: 'media-session-play', errorName: error instanceof Error ? error.name : 'UnknownError' });
          console.error('Failed to resume from media controls:', error);
        });
      }],
      ['pause', pause],
      ['stop', pause],
      ['seekbackward', (details) => seek(-(details.seekOffset ?? 30), true)],
      ['seekforward', (details) => seek(details.seekOffset ?? 30, true)],
      ['seekto', (details) => {
        if (details.seekTime !== undefined) seek(details.seekTime);
      }],
      ['previoustrack', () => { if (canControl()) handlePrevious(); }],
      ['nexttrack', () => { if (canControl()) handleNext(); }],
    ];

    for (const [action, handler] of handlers) {
      try {
        navigator.mediaSession.setActionHandler(action, handler);
      } catch (error) {
        console.debug(`Media session action ${action} is unavailable:`, error);
      }
    }

    return () => {
      for (const [action] of handlers) {
        try {
          navigator.mediaSession.setActionHandler(action, null);
        } catch {
          // Unsupported handlers did not register and need no cleanup.
        }
      }
    };
  }, [duration, handleNext, handlePrevious, mediaSessionActive, pauseSonos, playSonos, seekOnSonos, setResumePosition, sonosPlayback, target]);

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;
  const bookmarks = currentItem?.bookmarks ? Object.entries(currentItem.bookmarks).map(([id, bookmark]) => ({ ...bookmark, id })) : [];
  const bookmarkRanges = bookmarks.filter(bookmark => bookmark.end_position != null && duration > 0).map(bookmark =>
    <span key={bookmark.id} className="timeline-bookmark-range" aria-hidden="true" style={{ left: `${100 * bookmark.position / duration}%`, width: `${100 * (bookmark.end_position! - bookmark.position) / duration}%` }} />);
  const sonosPosition = sonosSessionActive ? sonos.positionMillis / 1000 : 0;
  const displayedSonosPosition = sonosSeekDraft ?? (sonos.requestedSeekMillis === null ? sonosPosition : sonos.requestedSeekMillis / 1000);
  const sonosProgress = duration > 0 ? Math.min(100, (displayedSonosPosition / duration) * 100) : 0;
  const sonosSeekDisabled = isSending || isSwitchingOutput || (sonos.isTransportPending && sonos.requestedSeekMillis === null) ||
    !sonosSessionActive || !sonos.playback?.itemId || !currentItem || duration <= 0;
  const seekSonos = (position: number, relative = false) => {
    if (sonosSeekDisabled) return;
    // Drafts are only for dragging; pending commands are owned by the hook so
    // an older completion cannot clear a newer drag or a different output.
    setSonosSeekDraft(null);
    return sonos.seek(position * 1000, { relative, maxPositionMillis: Math.max(0, duration - 0.001) * 1000 });
  };
  const displayedSonosVolume = sonosVolumeDraft ?? sonos.requestedVolume ?? sonos.volume?.volume ?? 0;
  const sonosVolumeDisabled = !sonos.volume || sonos.volume.fixed || (sonos.isVolumePending && sonos.requestedVolume === null) || isSending || isSwitchingOutput;
  const adjustBrowserVolume = (step: number) => {
    setVolume(Math.min(100, Math.max(0, Math.round((isMuted ? 0 : volume) * 100) + step)) / 100);
    setMuted(false);
  };
  const sonosTransportDisabled =
    isSending || isSwitchingOutput ||
    !sonosSessionActive ||
    !currentItem ||
    sonos.isTransportPending ||
    (sonosIsPlaying && sonos.playback?.availablePlaybackActions?.canPause === false);

  if (target.kind === 'sonos') {
    // Transient speaker state shares the title's fixed line instead of adding a grid row.
    const connectionStatus = isSwitchingOutput ? 'Moving playback to this browser…'
      : isSending ? `Sending to ${target.groupName}…`
      : playbackError || sonos.error ? undefined
      : !sonos.playback ? `Reading ${target.groupName}…`
      : !sonosSessionActive ? `Choose a song to play on ${target.groupName}.` : undefined;
    return (
      <div className="player-chrome sonos-player-layout" aria-busy={isSwitchingOutput}>
        <audio
          ref={attachAudio}
          preload="metadata"
          onLoadStart={handleLoadStart}
          onLoadedMetadata={handleLoadedMetadata}
        />
        <PlayerTrack item={currentItem} position={displayedSonosPosition} duration={duration} status={connectionStatus} sonos />
        {!connectionStatus && <div role="status" className={`sonos-status ${!playbackError && !sonos.error ? 'sr-only' : ''}`}>
          {playbackError ? (
            <span className="text-solarized-red">
              {playbackError}
              {currentItem && (
                <button
                  type="button"
                  className="ml-2 text-solarized-cyan hover:underline"
                  onClick={() => void play(currentItem, resumePosition)}
                >
                  {takeoverRequired ? 'Replace Sonos playback and retry' : 'Retry sending to Sonos'}
                </button>
              )}
            </span>
          ) : sonos.error ? (
            <span className="text-solarized-red">{sonos.error}</span>
          ) : (
            <span className="text-solarized-base0">
              Sonos · {target.groupName} · {sonosIsPlaying ? 'Playing' : 'Paused'}
            </span>
          )}
        </div>}

        <div className="sonos-progress player-timeline">
          <div className="playback-scrubber flex-grow relative">
            <div
              className="playback-fill bg-solarized-cyan rounded-full"
              style={{ width: `${sonosProgress}%` }}
            >
            </div>
            <input
              type="range"
              className="timeline-slider"
              aria-label="Sonos playback position"
              min="0"
              max={duration || 1}
              step="0.1"
              value={Math.min(duration || 1, displayedSonosPosition)}
              disabled={sonosSeekDisabled}
              onChange={event => { usePlayerStore.getState().setPlaybackRange(null); setSonosSeekDraft(Number(event.target.value)); }}
              onPointerUp={event => void seekSonos(Number(event.currentTarget.value))}
              onPointerCancel={() => setSonosSeekDraft(null)}
              onKeyUp={event => {
                if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) {
                  void seekSonos(Number(event.currentTarget.value));
                }
              }}
            />
            {bookmarkRanges}
            {currentItem?.tracklist?.tracks.filter(track => duration > 0 && track.start > 0 && track.start < duration).map((track, index) => <button type="button" key={`track-${index}`}
              className="timeline-chapter" style={{ left: `${100 * track.start / duration}%` }} title={`${track.title} · ${formatTime(track.start)}`} aria-label={`Jump to ${track.title}`}
              disabled={sonosSeekDisabled} onClick={() => { usePlayerStore.getState().setPlaybackRange(null); void seekSonos(track.start); }} />)}
            {bookmarks.map((bookmark, idx) => {
              const position = duration > 0 ? (bookmark.position / duration) * 100 : 0;
              return (
                <button
                  type="button"
                  key={idx}
                  onClick={() => {
                    usePlayerStore.getState().setPlaybackRange({ start: bookmark.position, end: bookmark.end_position ?? null, bookmarkId: bookmark.id });
                    void seekSonos(bookmark.position);
                  }}
                  disabled={sonosSeekDisabled}
                  className="timeline-bookmark absolute top-1/2 -translate-y-1/2 w-1 h-3 bg-solarized-blue/70 rounded-sm"
                  style={{ left: `${position}%` }}
                  title={`${bookmark.emoji || '🔖'} ${bookmark.label ? `${bookmark.label} · ` : ''}${formatTime(bookmark.position)}${bookmark.end_position == null ? '' : ` – ${formatTime(bookmark.end_position)}`}`}
                />
              );
            })}
          </div>
          <PlayerBookmark onClick={() => void handleAddSonosBookmark()}
            disabled={!sonosSessionActive || !currentItem || isSwitchingOutput} feedback={bookmarkFeedback} sonos />
        </div>
        <PlayerTransport playing={sonosIsPlaying} sonos onPrevious={handlePrevious} onNext={handleNext}
          onToggle={() => void (sonosIsPlaying ? sonos.pause() : sonos.play())}
          onBack={() => void seekSonos(-30, true)} onForward={() => void seekSonos(30, true)}
          skipDisabled={isSending || isSwitchingOutput || sonos.isTransportPending || !sonosSessionActive}
          playDisabled={sonosTransportDisabled} seekDisabled={sonosSeekDisabled} />
        <div className="sonos-controls">
          <div className="sonos-volume player-volume">
            <button
              type="button"
              onClick={() => void sonos.setMuted(!sonos.volume?.muted)}
              disabled={sonosVolumeDisabled || sonos.isVolumePending}
              className="p-1.5 text-solarized-base0 hover:text-solarized-cyan disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              aria-label={sonos.volume?.muted ? 'Unmute Sonos' : 'Mute Sonos'}
              title={sonos.volume?.muted ? 'Unmute Sonos' : 'Mute Sonos'}
            >
              {sonos.volume?.muted ? Icons.volumeMute : Icons.volume}
            </button>
            <button type="button" className="volume-step" aria-label="Volume down" title="Volume down by 1%"
              disabled={sonosVolumeDisabled || displayedSonosVolume <= 0}
              onClick={() => { setSonosVolumeDraft(null); void sonos.setGroupVolume(displayedSonosVolume - 1); }}>−</button>
            <input
              type="range"
              min="0"
              max="100"
              value={displayedSonosVolume}
              onChange={(event) => setSonosVolumeDraft(Number(event.target.value))}
              onPointerUp={() => { setSonosVolumeDraft(null); void sonos.setGroupVolume(displayedSonosVolume); }}
              onKeyUp={() => { setSonosVolumeDraft(null); void sonos.setGroupVolume(displayedSonosVolume); }}
              disabled={sonosVolumeDisabled}
              className="volume-slider disabled:opacity-40"
              aria-label="Sonos group volume"
            />
            <button type="button" className="volume-step" aria-label="Volume up" title="Volume up by 1%"
              disabled={sonosVolumeDisabled || displayedSonosVolume >= 100}
              onClick={() => { setSonosVolumeDraft(null); void sonos.setGroupVolume(displayedSonosVolume + 1); }}>+</button>
            <span className="text-xs text-solarized-base0 w-8 text-right tabular-nums" title={sonos.requestedVolume !== null ? "Updating Sonos volume…" : undefined}>
              {sonos.volume ? displayedSonosVolume : '—'}
            </span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="player-chrome player-layout">
      {/* Hidden audio element */}
      <audio
        ref={attachAudio}
        onLoadStart={handleLoadStart}
        onTimeUpdate={handleTimeUpdate}
        onLoadedMetadata={handleLoadedMetadata}
        onEnded={handleEnded}
        onPlay={handleAudioPlay}
        onPause={handleAudioPause}
      />

      <PlayerTrack item={currentItem} position={currentTime} duration={duration} />
      <div className="player-progress player-timeline">
        <div
          ref={progressRef}
          onClick={handleProgressClick}
          className="playback-scrubber flex-grow cursor-pointer relative"
        >
          <div
            className="playback-fill bg-solarized-blue rounded-full"
            style={{ width: `${progress}%` }}
          >
            <div className="playback-head absolute right-0 top-1/2 translate-x-1/2 -translate-y-1/2 w-2.5 h-2.5 bg-solarized-blue rounded-full" />
          </div>
          {/* Bookmark markers */}
          {bookmarkRanges}
          {currentItem?.tracklist?.tracks.filter(track => duration > 0 && track.start > 0 && track.start < duration).map((track, index) => <button type="button" key={`track-${index}`}
            className="timeline-chapter" style={{ left: `${100 * track.start / duration}%` }} title={`${track.title} · ${formatTime(track.start)}`} aria-label={`Jump to ${track.title}`}
            onClick={event => { event.stopPropagation(); if (audioRef.current) { usePlayerStore.getState().setPlaybackRange(null); audioRef.current.currentTime = track.start; setResumePosition(track.start); } }} />)}
          {bookmarks.map((bookmark, idx) => {
            const position = duration > 0 ? (bookmark.position / duration) * 100 : 0;
            return (
              <button
                key={idx}
                onClick={(e) => {
                  e.stopPropagation();
                  if (audioRef.current) {
                    usePlayerStore.getState().setPlaybackRange({ start: bookmark.position, end: bookmark.end_position ?? null, bookmarkId: bookmark.id });
                    audioRef.current.currentTime = bookmark.position;
                    setResumePosition(bookmark.position);
                  }
                }}
                className="timeline-bookmark absolute top-1/2 -translate-y-1/2 w-1 h-3 bg-solarized-cyan/60 hover:bg-solarized-cyan hover:w-2 hover:h-5 transition-all cursor-pointer rounded-sm"
                style={{ left: `${position}%` }}
                title={`${bookmark.emoji || '🔖'} ${bookmark.label ? `${bookmark.label} · ` : ''}${formatTime(bookmark.position)}${bookmark.end_position == null ? '' : ` – ${formatTime(bookmark.end_position)}`}`}
              />
            );
          })}
        </div>
        <PlayerBookmark onClick={handleAddBookmark} disabled={!currentItem} feedback={bookmarkFeedback} />
      </div>
      <PlayerTransport playing={isPlaying} onPrevious={handlePrevious} onNext={handleNext}
        onToggle={handlePlayPause} onBack={seekBack} onForward={seekForward}
        playDisabled={!currentItem} seekDisabled={!currentItem} />
      <div className="player-controls">
        <div className="player-options player-volume">
          <button
            onClick={toggleShuffle}
            className={`p-1.5 rounded transition-colors ${
              shuffleEnabled ? 'text-solarized-green bg-solarized-base02' : 'text-solarized-base0 hover:text-solarized-base1 hover:bg-solarized-base02'
            }`}
            title={shuffleEnabled ? 'Shuffle on' : 'Shuffle off'}
            aria-pressed={shuffleEnabled}
          >
            {Icons.shuffle}
          </button>
          <button
            onClick={cycleRepeatMode}
            className={`p-1.5 rounded transition-colors relative ${
              repeatMode !== 'off' ? 'text-solarized-green bg-solarized-base02' : 'text-solarized-base0 hover:text-solarized-base1 hover:bg-solarized-base02'
            }`}
            title={repeatMode === 'off' ? 'Repeat off' : repeatMode === 'all' ? 'Repeat all' : 'Repeat one'}
            aria-pressed={repeatMode !== 'off'}
          >
            {Icons.repeat}
            {repeatMode === 'one' && (
              <span className="absolute -top-0.5 -right-0.5 text-[8px] font-bold text-solarized-green">1</span>
            )}
          </button>
          <button
            onClick={() => setMuted(!isMuted)}
            className="p-1.5 text-solarized-base0 hover:text-solarized-base1 hover:bg-solarized-base02 rounded transition-colors"
            title={isMuted ? 'Unmute' : 'Mute'}
          >
            {isMuted ? Icons.volumeMute : Icons.volume}
          </button>
          <button type="button" className="volume-step" aria-label="Volume down" title="Volume down by 1%"
            disabled={isMuted || volume <= 0} onClick={() => adjustBrowserVolume(-1)}>−</button>
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={isMuted ? 0 : volume}
            onChange={(e) => {
              setVolume(parseFloat(e.target.value));
              setMuted(false);
            }}
            className="volume-slider"
            title="Volume"
          />
          <button type="button" className="volume-step" aria-label="Volume up" title="Volume up by 1%"
            disabled={!isMuted && volume >= 1} onClick={() => adjustBrowserVolume(1)}>+</button>
        </div>
      </div>
    </div>
  );
}
