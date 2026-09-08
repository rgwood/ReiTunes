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
}

type PlaybackEvent =
  'request' | 'command' | 'state' | 'media' | 'play-rejected' | 'oscillation';
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
  if (event === 'oscillation' || event === 'play-rejected') warning = true;
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
  return {
    position: Math.round(audio.currentTime * 1000) / 1000,
    paused: audio.paused,
    ended: audio.ended,
    seeking: audio.seeking,
    readyState: audio.readyState,
    networkState: audio.networkState,
    errorCode: audio.error?.code,
  };
}
