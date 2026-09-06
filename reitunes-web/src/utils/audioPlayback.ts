/** Apply an explicit play request, including seeks to zero and same-file replays. */
export function playAudio(
  audio: HTMLAudioElement,
  url: string,
  position: number,
  onError: (message: string) => void,
): () => void {
  let cancelled = false;
  let valid = true;
  const seek = () => {
    if (cancelled) return;
    try {
      if (Number.isFinite(audio.duration) && position >= audio.duration && position > 0) {
        valid = false;
        audio.pause();
        onError('This bookmark is beyond the end of the audio. Choose another starting point.');
        return;
      }
      audio.currentTime = position;
    } catch {
      valid = false;
      audio.pause();
      onError('Could not seek to this position. Try playing from the beginning.');
    }
  };

  if (audio.getAttribute('src') !== url) audio.src = url;
  else if (audio.error) audio.load();
  if (audio.readyState >= 1) seek();
  else audio.addEventListener('loadedmetadata', seek, { once: true });

  // Explicitly play even if the URL and seek position haven't changed.
  if (valid) void audio.play().catch(error => {
    if (!cancelled && error.name !== 'AbortError') {
      onError('Playback could not start. Press Play to try again.');
    }
  });

  return () => {
    cancelled = true;
    audio.removeEventListener('loadedmetadata', seek);
    audio.pause();
  };
}
