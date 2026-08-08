import { useEffect, useRef, useCallback, useState } from 'react';
import { usePlayerStore } from '../stores/playerStore';
import { useQueueStore } from '../hooks/useQueue';
import { getItemUrl, markPlayed, addBookmark } from '../hooks/useLibrary';
import { usePlayback } from '../hooks/usePlayback';
import { useSonosControls } from '../hooks/useSonosControls';
import { usePlaybackTargetStore } from '../stores/playbackTargetStore';
import type { LibraryItem } from '../types';

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
  rewind: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="11 19 2 12 11 5 11 19" />
      <polygon points="22 19 13 12 22 5 22 19" />
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
  fastForward: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="13 19 22 12 13 5 13 19" />
      <polygon points="2 19 11 12 2 5 2 19" />
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

interface AudioPlayerProps {
  onChooseOutput: () => void;
  items: LibraryItem[];
}

export function AudioPlayer({ onChooseOutput, items }: AudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const progressRef = useRef<HTMLDivElement>(null);
  const lastPlayedIdRef = useRef<string | null>(null);
  const lastItemIdRef = useRef<string | null>(null);
  const lastCheckpointRef = useRef(-1);
  const isChangingSourceRef = useRef(false);

  const [currentTime, setCurrentTimeLocal] = useState(0);
  const [duration, setDurationLocal] = useState(0);
  const [sonosVolumeDraft, setSonosVolumeDraft] = useState<number | null>(null);
  const [bookmarkFeedback, setBookmarkFeedback] = useState<'idle' | 'success' | 'error'>('idle');

  const {
    currentItem,
    isPlaying,
    pendingSeek,
    volume,
    isMuted,
    setIsPlaying,
    clearPendingSeek,
    setResumePosition,
    setVolume,
    setMuted,
    selectRemoteItem,
  } = usePlayerStore();
  const play = usePlayback();
  const { target, isSending, error: playbackError, takeoverRequired } =
    usePlaybackTargetStore();
  const sonos = useSonosControls(target.kind === 'sonos' ? target.groupId : null);
  const { playNext, playPrevious, shuffleEnabled, repeatMode, toggleShuffle, cycleRepeatMode } = useQueueStore();

  // Handle song changes
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !currentItem) return;

    const isNewSong = currentItem.id !== lastItemIdRef.current;
    if (isNewSong) {
      lastItemIdRef.current = currentItem.id;
      lastCheckpointRef.current = -1;
      isChangingSourceRef.current = target.kind === 'browser';
      audio.src = getItemUrl(currentItem);
    }
  }, [currentItem, target.kind]);

  useEffect(() => {
    if (
      target.kind !== 'sonos' ||
      !sonos.playback?.reitunesSessionActive ||
      !sonos.playback.sourceItemId ||
      sonos.playback.sourceItemId === currentItem?.id
    ) {
      return;
    }
    const item = items.find((candidate) => candidate.id === sonos.playback?.sourceItemId);
    if (item) selectRemoteItem(item, sonos.positionMillis / 1000);
  }, [
    currentItem?.id,
    items,
    selectRemoteItem,
    sonos.playback?.reitunesSessionActive,
    sonos.playback?.sourceItemId,
    sonos.positionMillis,
    target.kind,
  ]);

  // Restored tracks remain paused. Tracks selected by the user set isPlaying
  // and start through this effect.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !currentItem) return;

    if (target.kind === 'sonos') {
      if (!audio.paused) audio.pause();
      return;
    }

    if (isPlaying && audio.paused) {
      audio.play().catch((error) => {
        console.error('Failed to start playback:', error);
        setIsPlaying(false);
      });
    } else if (!isPlaying && !audio.paused) {
      audio.pause();
    }
  }, [currentItem, isPlaying, setIsPlaying, target.kind]);

  // Handle pending seek
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || pendingSeek === null || target.kind !== 'browser') return;

    const doSeek = () => {
      audio.currentTime = pendingSeek;
      setCurrentTimeLocal(pendingSeek);
      clearPendingSeek();
    };

    if (audio.readyState >= 2) {
      doSeek();
    } else {
      const handleCanPlay = () => {
        doSeek();
        audio.removeEventListener('canplay', handleCanPlay);
      };
      audio.addEventListener('canplay', handleCanPlay);
      return () => audio.removeEventListener('canplay', handleCanPlay);
    }
  }, [pendingSeek, clearPendingSeek, target.kind]);

  // Sync volume
  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.volume = isMuted ? 0 : volume;
    }
  }, [volume, isMuted]);

  const handleTimeUpdate = useCallback(() => {
    if (audioRef.current) {
      const position = audioRef.current.currentTime;
      setCurrentTimeLocal(position);

      const checkpoint = Math.floor(position / 5);
      if (checkpoint !== lastCheckpointRef.current) {
        lastCheckpointRef.current = checkpoint;
        setResumePosition(position);
      }
    }
  }, [setResumePosition]);

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
    setResumePosition(0);
    if (repeatMode === 'one' && audioRef.current) {
      audioRef.current.currentTime = 0;
      audioRef.current.play();
      return;
    }
    const nextItem = playNext();
    if (nextItem) void play(nextItem);
  }, [playNext, play, repeatMode, setResumePosition]);

  const handlePlayPause = useCallback(() => {
    if (!audioRef.current) return;
    if (isPlaying) {
      audioRef.current.pause();
    } else {
      audioRef.current.play().catch((error) => {
        console.error('Failed to resume playback:', error);
      });
    }
  }, [isPlaying]);

  const handleProgressClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!progressRef.current || !audioRef.current || !duration) return;
    const rect = progressRef.current.getBoundingClientRect();
    const percent = (e.clientX - rect.left) / rect.width;
    const position = percent * duration;
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
    const prevItem = playPrevious();
    if (prevItem) void play(prevItem);
  }, [playPrevious, play]);

  const handleNext = useCallback(() => {
    const nextItem = playNext();
    if (nextItem) void play(nextItem);
  }, [playNext, play]);

  const handleAudioPause = useCallback(() => {
    if (isChangingSourceRef.current) return;
    setIsPlaying(false);
    if (audioRef.current) setResumePosition(audioRef.current.currentTime);
  }, [setIsPlaying, setResumePosition]);

  const handleAudioPlay = useCallback(() => {
    isChangingSourceRef.current = false;
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

    navigator.mediaSession.metadata = currentItem && target.kind === 'browser'
      ? new MediaMetadata({
          title: currentItem.name,
          artist: currentItem.artist,
          album: currentItem.album,
        })
      : null;

    return () => {
      navigator.mediaSession.metadata = null;
    };
  }, [currentItem, target.kind]);

  useEffect(() => {
    if (!('mediaSession' in navigator)) return;
    navigator.mediaSession.playbackState = currentItem && target.kind === 'browser'
      ? isPlaying ? 'playing' : 'paused'
      : 'none';
  }, [currentItem, isPlaying, target.kind]);

  useEffect(() => {
    if (
      !('mediaSession' in navigator) ||
      target.kind !== 'browser' ||
      !duration ||
      !Number.isFinite(duration)
    ) return;

    try {
      navigator.mediaSession.setPositionState({
        duration,
        playbackRate: audioRef.current?.playbackRate ?? 1,
        position: Math.min(duration, Math.max(0, currentTime)),
      });
    } catch (error) {
      console.debug('Could not update media session position:', error);
    }
  }, [currentTime, duration, target.kind]);

  useEffect(() => {
    if (!('mediaSession' in navigator) || target.kind !== 'browser') return;

    const handlers: Array<[MediaSessionAction, MediaSessionActionHandler]> = [
      ['play', () => {
        audioRef.current?.play().catch((error) => {
          console.error('Failed to resume from media controls:', error);
        });
      }],
      ['pause', () => audioRef.current?.pause()],
      ['seekbackward', (details) => {
        if (!audioRef.current) return;
        const position = Math.max(0, audioRef.current.currentTime - (details.seekOffset ?? 30));
        audioRef.current.currentTime = position;
        setResumePosition(position);
      }],
      ['seekforward', (details) => {
        if (!audioRef.current) return;
        const position = Math.min(
          audioRef.current.duration,
          audioRef.current.currentTime + (details.seekOffset ?? 30)
        );
        audioRef.current.currentTime = position;
        setResumePosition(position);
      }],
      ['seekto', (details) => {
        if (!audioRef.current || details.seekTime === undefined) return;
        audioRef.current.currentTime = details.seekTime;
        setResumePosition(details.seekTime);
      }],
      ['previoustrack', handlePrevious],
      ['nexttrack', handleNext],
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
  }, [handleNext, handlePrevious, setResumePosition, target.kind]);

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;
  const bookmarks = currentItem?.bookmarks ? Object.values(currentItem.bookmarks) : [];
  const sonosSessionActive = sonos.playback?.reitunesSessionActive === true;
  const sonosIsPlaying =
    sonos.playback?.playbackState === 'PLAYBACK_STATE_PLAYING' ||
    sonos.playback?.playbackState === 'PLAYBACK_STATE_BUFFERING';
  const sonosPosition = sonosSessionActive ? sonos.positionMillis / 1000 : 0;
  const sonosProgress = duration > 0 ? Math.min(100, (sonosPosition / duration) * 100) : 0;
  const displayedSonosVolume = sonosVolumeDraft ?? sonos.volume?.volume ?? 0;
  const sonosTransportDisabled =
    !sonosSessionActive ||
    !currentItem ||
    sonos.isTransportPending ||
    (sonosIsPlaying && sonos.playback?.availablePlaybackActions?.canPause === false);

  if (target.kind === 'sonos') {
    return (
      <div className="px-4 pt-3 pb-2">
        <audio
          ref={audioRef}
          preload="metadata"
          onLoadStart={handleLoadStart}
          onLoadedMetadata={handleLoadedMetadata}
        />
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="text-sm text-solarized-base1 truncate">
              {currentItem ? (
                <>
                  <span className="text-solarized-cyan">{currentItem.name}</span>
                  {currentItem.artist && (
                    <span className="text-solarized-base0 ml-2">— {currentItem.artist}</span>
                  )}
                </>
              ) : (
                <span className="text-solarized-base0">No song selected</span>
              )}
            </div>
            <div className="text-xs mt-1">
              {isSending ? (
                <span className="text-solarized-yellow">Sending to {target.groupName}…</span>
              ) : playbackError ? (
                <span className="text-solarized-red">
                  {playbackError}
                  {takeoverRequired && ' Open Sonos output and choose the group again.'}
                </span>
              ) : sonos.error ? (
                <span className="text-solarized-red">{sonos.error}</span>
              ) : !sonos.playback ? (
                <span className="text-solarized-yellow">Reading {target.groupName}…</span>
              ) : !sonosSessionActive ? (
                <span className="text-solarized-base0">
                  Sonos · {target.groupName}. Choose a song to start a ReiTunes session.
                </span>
              ) : (
                <span className="text-solarized-base0">
                  Sonos · {target.groupName} · {sonosIsPlaying ? 'Playing' : 'Paused'}
                </span>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={onChooseOutput}
            className="shrink-0 px-3 py-1.5 text-xs border border-solarized-cyan text-solarized-cyan rounded hover:bg-solarized-base02 transition-colors"
          >
            Change output
          </button>
        </div>

        <div className="flex items-center gap-3 mt-3 mb-2">
          <span className="text-xs text-solarized-base0 w-10 text-right tabular-nums">
            {formatTime(sonosPosition)}
          </span>
          <div className="flex-grow h-1 bg-solarized-base02 rounded-full relative">
            <div
              className="h-full bg-solarized-cyan rounded-full relative transition-[width] duration-200"
              style={{ width: `${sonosProgress}%` }}
            >
              <div className="absolute right-0 top-1/2 -translate-y-1/2 w-2.5 h-2.5 bg-solarized-cyan rounded-full" />
            </div>
            {bookmarks.map((bookmark, idx) => {
              const position = duration > 0 ? (bookmark.position / duration) * 100 : 0;
              return (
                <div
                  key={idx}
                  className="absolute top-1/2 -translate-y-1/2 w-1 h-3 bg-solarized-blue/70 rounded-sm"
                  style={{ left: `${position}%` }}
                  title={`${bookmark.emoji || '🔖'} ${bookmark.label ? `${bookmark.label} · ` : ''}${formatTime(bookmark.position)}`}
                />
              );
            })}
          </div>
          <span className="text-xs text-solarized-base0 w-10 tabular-nums">
            {duration > 0 ? formatTime(duration) : '—:—'}
          </span>
        </div>

        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void (sonosIsPlaying ? sonos.pause() : sonos.play())}
              disabled={sonosTransportDisabled}
              className="w-9 h-9 flex items-center justify-center rounded-full bg-solarized-cyan text-solarized-base03 hover:bg-solarized-blue disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              aria-label={sonosIsPlaying ? 'Pause Sonos' : 'Play Sonos'}
              title={sonosIsPlaying ? 'Pause Sonos' : 'Play Sonos'}
            >
              {sonosIsPlaying ? Icons.pause : Icons.play}
            </button>
            <button
              type="button"
              onClick={() => void handleAddSonosBookmark()}
              disabled={!sonosSessionActive || !currentItem}
              className={`p-2 rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                bookmarkFeedback === 'success'
                  ? 'text-solarized-green bg-solarized-base02'
                  : bookmarkFeedback === 'error'
                    ? 'text-solarized-red bg-solarized-base02'
                    : 'text-solarized-base0 hover:text-solarized-cyan hover:bg-solarized-base02'
              }`}
              aria-label="Bookmark current Sonos time"
              title="Bookmark current Sonos time"
            >
              {Icons.bookmark}
            </button>
          </div>

          <div className="flex items-center gap-2 min-w-0 max-w-64 flex-1 justify-end">
            <button
              type="button"
              onClick={() => void sonos.setMuted(!sonos.volume?.muted)}
              disabled={!sonos.volume || sonos.volume.fixed || sonos.isVolumePending}
              className="p-1.5 text-solarized-base0 hover:text-solarized-cyan disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              aria-label={sonos.volume?.muted ? 'Unmute Sonos' : 'Mute Sonos'}
              title={sonos.volume?.muted ? 'Unmute Sonos' : 'Mute Sonos'}
            >
              {sonos.volume?.muted ? Icons.volumeMute : Icons.volume}
            </button>
            <input
              type="range"
              min="0"
              max="100"
              value={displayedSonosVolume}
              onChange={(event) => setSonosVolumeDraft(Number(event.target.value))}
              onPointerUp={() =>
                void sonos
                  .setGroupVolume(displayedSonosVolume)
                  .then(() => setSonosVolumeDraft(null))
              }
              onKeyUp={() =>
                void sonos
                  .setGroupVolume(displayedSonosVolume)
                  .then(() => setSonosVolumeDraft(null))
              }
              disabled={!sonos.volume || sonos.volume.fixed || sonos.isVolumePending}
              className="w-full min-w-20 accent-solarized-cyan disabled:opacity-40"
              aria-label="Sonos group volume"
            />
            <span className="text-xs text-solarized-base0 w-8 text-right tabular-nums">
              {sonos.volume ? displayedSonosVolume : '—'}
            </span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="px-4 pt-3 pb-2">
      {/* Hidden audio element */}
      <audio
        ref={audioRef}
        onLoadStart={handleLoadStart}
        onTimeUpdate={handleTimeUpdate}
        onLoadedMetadata={handleLoadedMetadata}
        onEnded={handleEnded}
        onPlay={handleAudioPlay}
        onPause={handleAudioPause}
      />

      {/* Now playing info - compact */}
      <div className="text-sm text-solarized-base1 mb-2 truncate">
        {currentItem ? (
          <>
            <span className="text-solarized-blue">{currentItem.name}</span>
            {currentItem.artist && (
              <span className="text-solarized-base0 ml-2">— {currentItem.artist}</span>
            )}
          </>
        ) : (
          <span className="text-solarized-base0">No song selected</span>
        )}
      </div>

      {/* Progress bar */}
      <div className="flex items-center gap-3 mb-2">
        <span className="text-xs text-solarized-base0 w-10 text-right tabular-nums">
          {formatTime(currentTime)}
        </span>
        <div
          ref={progressRef}
          onClick={handleProgressClick}
          className="flex-grow h-1 bg-solarized-base02 rounded-full cursor-pointer group relative"
        >
          <div
            className="h-full bg-solarized-blue rounded-full relative"
            style={{ width: `${progress}%` }}
          >
            <div className="absolute right-0 top-1/2 -translate-y-1/2 w-2.5 h-2.5 bg-solarized-blue rounded-full opacity-0 group-hover:opacity-100 transition-opacity" />
          </div>
          {/* Bookmark markers */}
          {bookmarks.map((bookmark, idx) => {
            const position = duration > 0 ? (bookmark.position / duration) * 100 : 0;
            return (
              <button
                key={idx}
                onClick={(e) => {
                  e.stopPropagation();
                  if (audioRef.current) {
                    audioRef.current.currentTime = bookmark.position;
                    setResumePosition(bookmark.position);
                  }
                }}
                className="absolute top-1/2 -translate-y-1/2 w-1 h-3 bg-solarized-cyan/60 hover:bg-solarized-cyan hover:w-2 hover:h-5 transition-all cursor-pointer rounded-sm"
                style={{ left: `${position}%` }}
                title={`${bookmark.emoji || '🔖'} ${bookmark.label ? `${bookmark.label} · ` : ''}${formatTime(bookmark.position)}`}
              />
            );
          })}
        </div>
        <span className="text-xs text-solarized-base0 w-10 tabular-nums">
          {formatTime(duration)}
        </span>
      </div>

      {/* Controls row - compact, inline */}
      <div className="flex items-center justify-between">
        {/* Left: shuffle */}
        <div className="flex items-center">
          <button
            onClick={toggleShuffle}
            className={`p-1.5 rounded transition-colors ${
              shuffleEnabled ? 'text-solarized-green bg-solarized-base02' : 'text-solarized-base0 hover:text-solarized-base1 hover:bg-solarized-base02'
            }`}
            title={shuffleEnabled ? 'Shuffle on' : 'Shuffle off'}
          >
            {Icons.shuffle}
          </button>
        </div>

        {/* Center: transport controls */}
        <div className="flex items-center gap-1">
          <button
            onClick={handlePrevious}
            className="p-1.5 text-solarized-base1 hover:text-solarized-base2 hover:bg-solarized-base02 rounded transition-colors"
            title="Previous"
          >
            {Icons.skipBack}
          </button>
          <button
            onClick={seekBack}
            className="p-1.5 text-solarized-base1 hover:text-solarized-base2 hover:bg-solarized-base02 rounded transition-colors"
            title="Back 30s"
          >
            {Icons.rewind}
          </button>
          <button
            onClick={handlePlayPause}
            className="p-2 mx-1 text-solarized-base2 hover:text-solarized-base3 bg-solarized-base02 hover:bg-solarized-base01 rounded-full transition-colors"
            title={isPlaying ? 'Pause' : 'Play'}
          >
            {isPlaying ? Icons.pause : Icons.play}
          </button>
          <button
            onClick={seekForward}
            className="p-1.5 text-solarized-base1 hover:text-solarized-base2 hover:bg-solarized-base02 rounded transition-colors"
            title="Forward 30s"
          >
            {Icons.fastForward}
          </button>
          <button
            onClick={handleNext}
            className="p-1.5 text-solarized-base1 hover:text-solarized-base2 hover:bg-solarized-base02 rounded transition-colors"
            title="Next"
          >
            {Icons.skipForward}
          </button>
        </div>

        {/* Right: repeat, bookmark, volume */}
        <div className="flex items-center gap-1">
          <button
            onClick={cycleRepeatMode}
            className={`p-1.5 rounded transition-colors relative ${
              repeatMode !== 'off' ? 'text-solarized-green bg-solarized-base02' : 'text-solarized-base0 hover:text-solarized-base1 hover:bg-solarized-base02'
            }`}
            title={repeatMode === 'off' ? 'Repeat off' : repeatMode === 'all' ? 'Repeat all' : 'Repeat one'}
          >
            {Icons.repeat}
            {repeatMode === 'one' && (
              <span className="absolute -top-0.5 -right-0.5 text-[8px] font-bold text-solarized-green">1</span>
            )}
          </button>
          <button
            onClick={handleAddBookmark}
            className={`p-1.5 rounded transition-colors ${
              bookmarkFeedback === 'success'
                ? 'text-solarized-green bg-solarized-base02'
                : bookmarkFeedback === 'error'
                ? 'text-solarized-red bg-solarized-base02'
                : 'text-solarized-base0 hover:text-solarized-cyan hover:bg-solarized-base02'
            }`}
            title="Add bookmark"
          >
            {Icons.bookmark}
          </button>
          <button
            onClick={() => setMuted(!isMuted)}
            className="p-1.5 text-solarized-base0 hover:text-solarized-base1 hover:bg-solarized-base02 rounded transition-colors"
            title={isMuted ? 'Unmute' : 'Mute'}
          >
            {isMuted ? Icons.volumeMute : Icons.volume}
          </button>
          <input
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={isMuted ? 0 : volume}
            onChange={(e) => {
              setVolume(parseFloat(e.target.value));
              setMuted(false);
            }}
            className="w-16 h-1 accent-solarized-blue bg-solarized-base02 rounded-full cursor-pointer"
            title="Volume"
          />
        </div>
      </div>
    </div>
  );
}
