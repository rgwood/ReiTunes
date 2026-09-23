// Production playback traces go to the existing authenticated server log endpoint.
// Keep IDs and media state, never track URLs, titles, cookies or error messages.
interface PlaybackDetails {
  itemId?: string | null;
  target?: 'browser' | 'sonos';
  origin?: string;
  mediaEvent?: string;
  isPlaying?: boolean;
  pendingSeek?: number | null;
  position?: number;
  paused?: boolean;
  ended?: boolean;
  seeking?: boolean;
  readyState?: number;
  networkState?: number;
  errorCode?: number;
  errorName?: string;
  stale?: boolean;
  targetPosition?: number;
  buffered?: number[][];
  seekable?: number[][];
  bufferedAhead?: number;
  elapsedMs?: number;
  outcome?: string;
}

type PlaybackEvent =
  'request' | 'command' | 'state' | 'media' | 'play-rejected' | 'oscillation' | 'buffering-slow' | 'buffering-end';
const MAX_EVENTS = 40;
const FLUSH_MS = 2000;
const session = crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
const build = new URL(import.meta.url).pathname.split('/').pop();
let sequence = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let dropped = 0;
let warning = false;
let installed = false;
let lastPlaying: boolean | undefined;
let flips: number[] = [];
let lastOscillation = -Infinity;
let events: Array<
  PlaybackDetails & { event: PlaybackEvent; sequence: number; at: string }
> = [];

export function flushPlaybackDiagnostics() {
  clearTimeout(timer);
  timer = undefined;
  if (!events.length) return;
  const batch = events;
  const droppedEvents = dropped;
  const level = warning ? 'warn' : 'info';
  events = [];
  dropped = 0;
  warning = false;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  // No retries and no console forwarding: failures must not create another loop.
  void fetch('/api/log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    keepalive: true,
    signal: controller.signal,
    body: JSON.stringify({
      level,
      message: '[Playback]',
      args: [
        {
          session,
          build,
          visibility: document.visibilityState,
          online: navigator.onLine,
          droppedEvents,
          events: batch,
        },
      ],
    }),
  })
    .catch(() => {})
    .finally(() => clearTimeout(timeout));
}

export function recordPlaybackEvent(
  event: PlaybackEvent,
  details: PlaybackDetails = {}
) {
  if (event === 'oscillation' || event === 'play-rejected' || event === 'buffering-slow') warning = true;
  if (!installed) {
    installed = true;
    window.addEventListener('pagehide', flushPlaybackDiagnostics);
  }
  if (events.length < MAX_EVENTS) {
    events.push({
      ...details,
      event,
      sequence: ++sequence,
      at: new Date().toISOString(),
    });
  } else {
    sequence += 1;
    dropped += 1;
  }
  if (timer === undefined)
    timer = setTimeout(flushPlaybackDiagnostics, FLUSH_MS);

  if (event === 'state' && details.isPlaying !== undefined) {
    const now = Date.now();
    if (lastPlaying !== undefined && lastPlaying !== details.isPlaying) {
      flips = [...flips.filter((at) => now - at < 2000), now].slice(-6);
      if (flips.length >= 6 && now - lastOscillation >= 10000) {
        lastOscillation = now;
        recordPlaybackEvent('oscillation', details);
      }
    }
    lastPlaying = details.isPlaying;
  }
}

export function audioDiagnostics(audio: HTMLMediaElement): PlaybackDetails {
  const buffered = audio.buffered;
  let bufferedAhead = 0;
  for (let i = 0; i < buffered.length; i++) {
    if (buffered.start(i) <= audio.currentTime && buffered.end(i) >= audio.currentTime) {
      bufferedAhead = Math.round((buffered.end(i) - audio.currentTime) * 1000) / 1000;
      break;
    }
  }
  return {
    position: Math.round(audio.currentTime * 1000) / 1000,
    paused: audio.paused,
    ended: audio.ended,
    seeking: audio.seeking,
    readyState: audio.readyState,
    networkState: audio.networkState,
    errorCode: audio.error?.code,
    buffered: mediaRanges(buffered),
    seekable: mediaRanges(audio.seekable),
    bufferedAhead,
  };
}

function mediaRanges(ranges: TimeRanges): number[][] {
  // Long mixes can have many disjoint downloaded ranges after lots of seeking.
  return Array.from({ length: Math.min(ranges.length, 8) }, (_, i) => [
    Math.round(ranges.start(i) * 1000) / 1000,
    Math.round(ranges.end(i) * 1000) / 1000,
  ]);
}

export function observePlaybackMedia(audio: HTMLMediaElement, context: () => PlaybackDetails) {
  let wait: { started: number; position: number; context: PlaybackDetails } | undefined;
  let timers: Array<ReturnType<typeof setTimeout>> = [];
  const finish = (outcome: string) => {
    timers.forEach(clearTimeout);
    timers = [];
    if (wait) recordPlaybackEvent('buffering-end', {
      ...wait.context, ...audioDiagnostics(audio), outcome,
      elapsedMs: Math.round(performance.now() - wait.started),
    });
    wait = undefined;
  };
  const observe = (event: Event) => {
    recordPlaybackEvent('media', { ...context(), mediaEvent: event.type, ...audioDiagnostics(audio) });
    if (['waiting', 'seeking', 'stalled'].includes(event.type) && (!audio.paused || audio.seeking) && !wait) {
      wait = { started: performance.now(), position: audio.currentTime, context: context() };
      timers = [3000, 10000].map(delay => setTimeout(() => {
        if (wait) recordPlaybackEvent('buffering-slow', {
          ...wait.context, ...audioDiagnostics(audio),
          elapsedMs: Math.round(performance.now() - wait.started),
        });
      }, delay));
    }
    if (event.type === 'seeking' && wait) wait.position = audio.currentTime;
    if (event.type === 'playing' && !audio.seeking && audio.readyState >= 3) finish('playing');
    if (event.type === 'seeked' && audio.paused) finish('seeked-paused');
    if (['pause', 'ended', 'error', 'abort', 'emptied'].includes(event.type)) finish(event.type);
  };
  const onTimeUpdate = () => {
    // Some engines omit a second playing event after a seek. Actual forward
    // progress is stronger evidence than canplay that the stall is over.
    if (wait && !audio.paused && !audio.seeking && audio.readyState >= 3 && audio.currentTime > wait.position) finish('progress');
  };
  const names = ['loadstart', 'loadedmetadata', 'canplay', 'play', 'playing', 'pause', 'waiting', 'stalled', 'seeking', 'seeked', 'ended', 'error', 'abort', 'emptied'];
  names.forEach(name => audio.addEventListener(name, observe));
  audio.addEventListener('timeupdate', onTimeUpdate);
  return () => {
    timers.forEach(clearTimeout);
    names.forEach(name => audio.removeEventListener(name, observe));
    audio.removeEventListener('timeupdate', onTimeUpdate);
  };
}
