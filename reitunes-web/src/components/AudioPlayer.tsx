import { useEffect, useRef, useCallback } from 'react';
import { usePlayerStore } from '../stores/playerStore';
import { useQueueStore } from '../hooks/useQueue';
import { getItemUrl, markPlayed, addBookmark } from '../hooks/useLibrary';

export function AudioPlayer() {
  const audioRef = useRef<HTMLAudioElement>(null);
  const lastPlayedIdRef = useRef<string | null>(null);
  const lastItemIdRef = useRef<string | null>(null);

  const { currentItem, pendingSeek, setCurrentTime, setDuration, clearPendingSeek, play } = usePlayerStore();
  const { playNext, playPrevious, shuffleEnabled, repeatMode, toggleShuffle, cycleRepeatMode } = useQueueStore();

  // Handle song changes - load new source and play
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !currentItem) return;

    const isNewSong = currentItem.id !== lastItemIdRef.current;

    if (isNewSong) {
      lastItemIdRef.current = currentItem.id;
      const url = getItemUrl(currentItem);
      audio.src = url;
      // autoPlay attribute handles playing
    }
  }, [currentItem]);

  // Handle pending seek - only triggered when an explicit seek is requested
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || pendingSeek === null) return;

    const doSeek = () => {
      if (pendingSeek > 0) {
        audio.currentTime = pendingSeek;
      }
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

  // Mark as played when song changes
  useEffect(() => {
    if (currentItem && currentItem.id !== lastPlayedIdRef.current) {
      lastPlayedIdRef.current = currentItem.id;
      markPlayed(currentItem.id).catch(console.error);
    }
  }, [currentItem]);

  const handleTimeUpdate = useCallback(() => {
    if (audioRef.current) {
      setCurrentTime(audioRef.current.currentTime);
    }
  }, [setCurrentTime]);

  const handleLoadedMetadata = useCallback(() => {
    if (audioRef.current) {
      setDuration(audioRef.current.duration);
    }
  }, [setDuration]);

  const handleEnded = useCallback(() => {
    // If repeat one, just replay current track
    if (repeatMode === 'one' && audioRef.current) {
      audioRef.current.currentTime = 0;
      audioRef.current.play();
      return;
    }

    const nextItem = playNext();
    if (nextItem) {
      play(nextItem);
    }
  }, [playNext, play, repeatMode]);

  const seekBack = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.currentTime = Math.max(0, audioRef.current.currentTime - 30);
    }
  }, []);

  const seekForward = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.currentTime = Math.min(
        audioRef.current.duration,
        audioRef.current.currentTime + 30
      );
    }
  }, []);

  const handleAddBookmark = useCallback(() => {
    if (currentItem && audioRef.current) {
      addBookmark(currentItem.id, audioRef.current.currentTime)
        .catch((err) => {
          console.error('Failed to add bookmark:', err);
          alert('Failed to add bookmark');
        });
    }
  }, [currentItem]);

  const handlePrevious = useCallback(() => {
    const prevItem = playPrevious();
    if (prevItem) {
      play(prevItem);
    }
  }, [playPrevious, play]);

  const handleNext = useCallback(() => {
    const nextItem = playNext();
    if (nextItem) {
      play(nextItem);
    }
  }, [playNext, play]);

  const displayName = currentItem
    ? `${currentItem.name}${currentItem.artist ? ` - ${currentItem.artist}` : ''}`
    : 'No song selected';

  return (
    <div className="sticky top-0 bg-solarized-base03 pt-5 px-5 pb-3 z-10">
      <div className="flex justify-between items-center mb-3">
        <div className="text-2xl flex-grow">
          <span className="text-solarized-blue text-shadow-solarized">
            {displayName}
          </span>
        </div>
      </div>

      <div className="flex items-center space-x-2 mb-3">
        <button
          onClick={toggleShuffle}
          className={`px-3 py-2 bg-solarized-base03 border border-solarized-blue rounded-sm hover:bg-solarized-blue hover:bg-opacity-30 ${
            shuffleEnabled ? 'text-solarized-green' : 'text-solarized-base01'
          }`}
          title={shuffleEnabled ? 'Shuffle on' : 'Shuffle off'}
        >
          &#128256;
        </button>
        <button
          onClick={handlePrevious}
          className="px-3 py-2 bg-solarized-base03 text-solarized-base2 border border-solarized-blue rounded-sm hover:bg-solarized-blue hover:bg-opacity-30"
          title="Previous"
        >
          &#9198;
        </button>
        <button
          onClick={seekBack}
          className="px-3 py-2 bg-solarized-base03 text-solarized-base2 border border-solarized-blue rounded-sm hover:bg-solarized-blue hover:bg-opacity-30"
          title="Back 30s"
        >
          &#9194;
        </button>
        <audio
          ref={audioRef}
          autoPlay
          controls
          className="flex-grow bg-solarized-base02 border border-solarized-blue"
          onTimeUpdate={handleTimeUpdate}
          onLoadedMetadata={handleLoadedMetadata}
          onEnded={handleEnded}
        >
          Your browser does not support the audio element.
        </audio>
        <button
          onClick={seekForward}
          className="px-3 py-2 bg-solarized-base03 text-solarized-base3 border border-solarized-blue rounded-sm hover:bg-solarized-blue hover:bg-opacity-30"
          title="Forward 30s"
        >
          &#9193;
        </button>
        <button
          onClick={handleNext}
          className="px-3 py-2 bg-solarized-base03 text-solarized-base2 border border-solarized-blue rounded-sm hover:bg-solarized-blue hover:bg-opacity-30"
          title="Next"
        >
          &#9197;
        </button>
        <button
          onClick={cycleRepeatMode}
          className={`px-3 py-2 bg-solarized-base03 border border-solarized-blue rounded-sm hover:bg-solarized-blue hover:bg-opacity-30 relative ${
            repeatMode !== 'off' ? 'text-solarized-green' : 'text-solarized-base01'
          }`}
          title={repeatMode === 'off' ? 'Repeat off' : repeatMode === 'all' ? 'Repeat all' : 'Repeat one'}
        >
          &#128257;
          {repeatMode === 'one' && (
            <span className="absolute -top-1 -right-1 text-xs bg-solarized-green text-solarized-base03 rounded-full w-4 h-4 flex items-center justify-center">
              1
            </span>
          )}
        </button>
        <button
          onClick={handleAddBookmark}
          className="px-3 py-1 bg-solarized-blue text-solarized-base03 rounded hover:bg-solarized-cyan transition-colors duration-300"
          title="Add bookmark at current position"
        >
          &#128278;
        </button>
      </div>
    </div>
  );
}
