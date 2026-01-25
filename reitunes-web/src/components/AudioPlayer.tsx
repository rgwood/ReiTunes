import { useEffect, useRef, useCallback, useState } from 'react';
import { usePlayerStore } from '../stores/playerStore';
import { useQueueStore } from '../hooks/useQueue';
import { getItemUrl, markPlayed, addBookmark } from '../hooks/useLibrary';

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

export function AudioPlayer() {
  const audioRef = useRef<HTMLAudioElement>(null);
  const progressRef = useRef<HTMLDivElement>(null);
  const lastPlayedIdRef = useRef<string | null>(null);
  const lastItemIdRef = useRef<string | null>(null);

  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTimeLocal] = useState(0);
  const [duration, setDurationLocal] = useState(0);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const [bookmarkFeedback, setBookmarkFeedback] = useState<'idle' | 'success' | 'error'>('idle');

  const { currentItem, pendingSeek, setCurrentTime, setDuration, clearPendingSeek, play } = usePlayerStore();
  const { playNext, playPrevious, shuffleEnabled, repeatMode, toggleShuffle, cycleRepeatMode } = useQueueStore();

  // Handle song changes
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !currentItem) return;

    const isNewSong = currentItem.id !== lastItemIdRef.current;
    if (isNewSong) {
      lastItemIdRef.current = currentItem.id;
      audio.src = getItemUrl(currentItem);
    }
  }, [currentItem]);

  // Handle pending seek
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || pendingSeek === null) return;

    const doSeek = () => {
      if (pendingSeek > 0) audio.currentTime = pendingSeek;
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
  }, [pendingSeek, clearPendingSeek]);

  // Mark as played
  useEffect(() => {
    if (currentItem && currentItem.id !== lastPlayedIdRef.current) {
      lastPlayedIdRef.current = currentItem.id;
      markPlayed(currentItem.id).catch(console.error);
    }
  }, [currentItem]);

  // Sync volume
  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.volume = isMuted ? 0 : volume;
    }
  }, [volume, isMuted]);

  const handleTimeUpdate = useCallback(() => {
    if (audioRef.current) {
      setCurrentTimeLocal(audioRef.current.currentTime);
      setCurrentTime(audioRef.current.currentTime);
    }
  }, [setCurrentTime]);

  const handleLoadedMetadata = useCallback(() => {
    if (audioRef.current) {
      setDurationLocal(audioRef.current.duration);
      setDuration(audioRef.current.duration);
    }
  }, [setDuration]);

  const handleEnded = useCallback(() => {
    if (repeatMode === 'one' && audioRef.current) {
      audioRef.current.currentTime = 0;
      audioRef.current.play();
      return;
    }
    const nextItem = playNext();
    if (nextItem) play(nextItem);
  }, [playNext, play, repeatMode]);

  const handlePlayPause = useCallback(() => {
    if (!audioRef.current) return;
    if (isPlaying) {
      audioRef.current.pause();
    } else {
      audioRef.current.play();
    }
  }, [isPlaying]);

  const handleProgressClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!progressRef.current || !audioRef.current || !duration) return;
    const rect = progressRef.current.getBoundingClientRect();
    const percent = (e.clientX - rect.left) / rect.width;
    audioRef.current.currentTime = percent * duration;
  }, [duration]);

  const seekBack = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.currentTime = Math.max(0, audioRef.current.currentTime - 30);
    }
  }, []);

  const seekForward = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.currentTime = Math.min(audioRef.current.duration, audioRef.current.currentTime + 30);
    }
  }, []);

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

  const handlePrevious = useCallback(() => {
    const prevItem = playPrevious();
    if (prevItem) play(prevItem);
  }, [playPrevious, play]);

  const handleNext = useCallback(() => {
    const nextItem = playNext();
    if (nextItem) play(nextItem);
  }, [playNext, play]);

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;
  const bookmarks = currentItem?.bookmarks ? Object.values(currentItem.bookmarks) : [];

  return (
    <div className="px-4 pt-3 pb-2">
      {/* Hidden audio element */}
      <audio
        ref={audioRef}
        autoPlay
        onTimeUpdate={handleTimeUpdate}
        onLoadedMetadata={handleLoadedMetadata}
        onEnded={handleEnded}
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
      />

      {/* Now playing info - compact */}
      <div className="text-sm text-solarized-base1 mb-2 truncate">
        {currentItem ? (
          <>
            <span className="text-solarized-blue">{currentItem.name}</span>
            {currentItem.artist && (
              <span className="text-solarized-base01 ml-2">— {currentItem.artist}</span>
            )}
          </>
        ) : (
          <span className="text-solarized-base01">No song selected</span>
        )}
      </div>

      {/* Progress bar */}
      <div className="flex items-center gap-3 mb-2">
        <span className="text-xs text-solarized-base01 w-10 text-right tabular-nums">
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
                  }
                }}
                className="absolute top-1/2 -translate-y-1/2 w-1 h-3 bg-solarized-cyan/60 hover:bg-solarized-cyan hover:w-2 hover:h-5 transition-all cursor-pointer rounded-sm"
                style={{ left: `${position}%` }}
                title={`${bookmark.emoji || '🔖'} ${formatTime(bookmark.position)}`}
              />
            );
          })}
        </div>
        <span className="text-xs text-solarized-base01 w-10 tabular-nums">
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
              shuffleEnabled ? 'text-solarized-green' : 'text-solarized-base01 hover:text-solarized-base1'
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
            className="p-1.5 text-solarized-base1 hover:text-solarized-base2 rounded transition-colors"
            title="Previous"
          >
            {Icons.skipBack}
          </button>
          <button
            onClick={seekBack}
            className="p-1.5 text-solarized-base1 hover:text-solarized-base2 rounded transition-colors"
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
            className="p-1.5 text-solarized-base1 hover:text-solarized-base2 rounded transition-colors"
            title="Forward 30s"
          >
            {Icons.fastForward}
          </button>
          <button
            onClick={handleNext}
            className="p-1.5 text-solarized-base1 hover:text-solarized-base2 rounded transition-colors"
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
              repeatMode !== 'off' ? 'text-solarized-green' : 'text-solarized-base01 hover:text-solarized-base1'
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
                ? 'text-solarized-green'
                : bookmarkFeedback === 'error'
                ? 'text-solarized-red'
                : 'text-solarized-base01 hover:text-solarized-cyan'
            }`}
            title="Add bookmark"
          >
            {Icons.bookmark}
          </button>
          <button
            onClick={() => setIsMuted(!isMuted)}
            className="p-1.5 text-solarized-base01 hover:text-solarized-base1 rounded transition-colors"
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
              setIsMuted(false);
            }}
            className="w-16 h-1 accent-solarized-blue bg-solarized-base02 rounded-full cursor-pointer"
            title="Volume"
          />
        </div>
      </div>
    </div>
  );
}
