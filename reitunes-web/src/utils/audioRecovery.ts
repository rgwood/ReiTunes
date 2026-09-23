export type AudioRecoveryStatus = 'idle' | 'buffering' | 'retrying' | 'failed';

interface RecoveryOptions {
  canAct: () => boolean;
  shouldPlay: () => boolean;
  position: () => number;
  reload: (position: number) => void;
  onStatus: (status: AudioRecoveryStatus) => void;
}

// One automatic reload per selected recording. Further attempts are explicit,
// so a broken connection cannot become an endless reload/download loop.
export function createAudioRecovery(audio: HTMLMediaElement, options: RecoveryOptions) {
  let automaticUsed = false;
  let disposed = false;
  let reloading = false;
  let waiting = false;
  let lastPosition = audio.currentTime;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let notice: ReturnType<typeof setTimeout> | undefined;
  const clear = () => { clearTimeout(timer); clearTimeout(notice); timer = notice = undefined; };
  const settle = () => {
    clear(); waiting = reloading = false;
    options.onStatus('idle');
  };
  const failed = () => {
    clear(); waiting = false;
    options.onStatus('failed');
  };
  const retry = (manual = true) => {
    if (disposed || !options.canAct()) return;
    if (!manual && (!options.shouldPlay() || automaticUsed)) return;
    clear();
    automaticUsed = true;
    waiting = reloading = true;
    lastPosition = options.position();
    options.onStatus('retrying');
    // Arm before load(), which can synchronously emit media events in tests.
    timer = setTimeout(() => {
      if (!disposed && options.canAct()) {
        if (options.shouldPlay()) failed();
        else settle();
      }
    }, 8000);
    options.reload(lastPosition);
  };
  const begin = () => {
    if (disposed || waiting || !options.canAct() || !options.shouldPlay()) return;
    waiting = true;
    lastPosition = audio.currentTime;
    notice = setTimeout(() => options.onStatus('buffering'), 2000);
    timer = setTimeout(() => {
      if (!options.canAct() || !options.shouldPlay()) { settle(); return; }
      if (automaticUsed) failed();
      else retry(false);
    }, 8000);
  };
  const observe = (event: Event) => {
    if (!options.canAct()) return;
    if (['waiting', 'stalled', 'seeking'].includes(event.type)) begin();
    if (event.type === 'seeking') lastPosition = audio.currentTime;
    if (event.type === 'playing' && !audio.seeking && audio.readyState >= 3) settle();
    if (event.type === 'seeked' && audio.paused && !options.shouldPlay()) settle();
    // A load() pause is not a user pause. Consult the current app intent.
    if (event.type === 'pause' && !options.shouldPlay()) settle();
    if (event.type === 'ended') settle();
    if (event.type === 'error') failed();
  };
  const progress = () => {
    if (waiting && !audio.seeking && !audio.paused && audio.readyState >= 3 && audio.currentTime > lastPosition) settle();
  };
  const names = ['waiting', 'stalled', 'seeking', 'playing', 'seeked', 'pause', 'ended', 'error'];
  names.forEach(name => audio.addEventListener(name, observe));
  audio.addEventListener('timeupdate', progress);
  return {
    retry,
    isReloading: () => reloading,
    dispose: () => {
      disposed = true; clear();
      names.forEach(name => audio.removeEventListener(name, observe));
      audio.removeEventListener('timeupdate', progress);
    },
  };
}
