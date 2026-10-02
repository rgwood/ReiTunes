import { useEffect, type RefObject } from 'react';
import { usePlayerStore } from '../stores/playerStore';
import { usePlaybackTargetStore } from '../stores/playbackTargetStore';
import { getPlaybackClientId, ownsBrowserPlayback } from '../stores/sharedSessionStore';
import { stageSharedPlayback } from './useSharedPlaybackSession';

// Counting movement bounded by elapsed time excludes seeks, pauses and stalls.
export class ListeningClock {
  seconds = 0;
  private previous: { position: number; at: number; playing: boolean } | null = null;
  sample(position: number, at: number, playing: boolean, seeking = false) {
    const previous = this.previous;
    if (previous?.playing && !seeking) {
      const elapsed = Math.max(0, (at - previous.at) / 1000);
      const movement = position - previous.position;
      if (movement >= 0 && movement <= elapsed + 1) this.seconds += Math.min(movement, elapsed);
    }
    this.previous = { position, at, playing: playing && !seeking };
  }
}

interface Report {
  listenId: string; segmentId: string; itemId: string; ownerId: string;
  startedAt: number; listenedSeconds: number; duration: number;
}
const storageKey = 'reitunes-lastfm-outbox';
let memoryOutbox: Report[] = [];
function readOutbox(): Report[] {
  try { memoryOutbox = JSON.parse(localStorage.getItem(storageKey) || '[]') as Report[]; } catch { /* Use memory when storage is unavailable. */ }
  return memoryOutbox;
}
function writeOutbox(reports: Report[]) {
  memoryOutbox = reports;
  try { localStorage.setItem(storageKey, JSON.stringify(reports)); } catch { /* In-memory retries still work. */ }
}
export function clearLastFmOutbox() {
  writeOutbox([]);
}

export function useLastFmListening(audioRef: RefObject<HTMLAudioElement | null>) {
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    let enabled = false;
    let current: { report: Report; clock: ListeningClock } | null = null;
    let writing = false;
    let disposed = false;
    const save = (report: Report) => {
      const cached = readOutbox().filter(entry => entry.segmentId !== report.segmentId);
      writeOutbox([...cached, { ...report }].slice(-100));
    };
    const flush = async () => {
      if (writing) return;
      writing = true;
      try {
        for (;;) {
          const report = readOutbox()[0];
          if (!report) break;
          const response = await fetch('/api/lastfm/listen', { method: 'POST', credentials: 'include', keepalive: true,
            headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(report), signal: AbortSignal.timeout(15_000) });
          if (!response.ok && response.status !== 400) break;
          const cached = readOutbox().filter(entry => entry.segmentId !== report.segmentId || entry.listenedSeconds > report.listenedSeconds);
          writeOutbox(cached);
        }
      } catch { /* The saved cumulative report is retried on the next heartbeat. */ }
      finally { writing = false; }
    };
    const report = () => {
      if (!current) return;
      current.report.listenedSeconds = current.clock.seconds;
      save(current.report); void flush();
    };
    const sample = (event?: Event) => {
      let started = false;
      let player = usePlayerStore.getState();
      const ownsAudio = ownsBrowserPlayback(usePlaybackTargetStore.getState().target);
      const playing = ownsAudio && !audio.paused && !audio.ended && !audio.seeking && player.pendingSeek === null;
      if (!enabled) { current = null; return; }
      if (playing && player.currentItem && !player.listenId) {
        usePlayerStore.setState({ listenId: crypto.randomUUID() });
        stageSharedPlayback();
        player = usePlayerStore.getState();
      }
      if (current?.report.listenId !== player.listenId) { report(); current = null; }
      if (!current && playing && player.currentItem && player.listenId) {
        const knownDuration = player.currentItem.duration_seconds;
        const duration = knownDuration && Number.isFinite(knownDuration) ? knownDuration : Number.isFinite(audio.duration) ? audio.duration : 0;
        if (duration <= 30 || !player.currentItem.artist.trim()) return;
        current = { clock: new ListeningClock(), report: { listenId: player.listenId, segmentId: crypto.randomUUID(),
          ownerId: getPlaybackClientId(), itemId: player.currentItem.id, startedAt: Math.floor(Date.now() / 1000), listenedSeconds: 0, duration } };
        started = true;
      }
      current?.clock.sample(audio.currentTime, performance.now(), playing, audio.seeking || event?.type === 'seeking');
      if (started || event?.type !== 'timeupdate') report();
    };
    const refresh = async () => {
      try {
        const response = await fetch('/api/lastfm/status', { credentials: 'include', signal: AbortSignal.timeout(10_000) });
        if (!response.ok) return;
        const status = await response.json() as { connected: boolean; enabled: boolean };
        if (!disposed) {
          enabled = status.connected && status.enabled;
          sample();
          if (enabled) void flush();
        }
      } catch { /* Scrobbling status never prevents playback. */ }
    };
    const events = ['playing', 'pause', 'timeupdate', 'seeking', 'seeked', 'ended'];
    events.forEach(event => audio.addEventListener(event, sample));
    const heartbeat = window.setInterval(() => { sample(); }, 10_000);
    const statusTimer = window.setInterval(() => { void refresh(); }, 60_000);
    window.addEventListener('reitunes:lastfm', refresh);
    window.addEventListener('pagehide', report);
    void refresh();
    return () => {
      disposed = true; report();
      window.clearInterval(heartbeat); window.clearInterval(statusTimer);
      events.forEach(event => audio.removeEventListener(event, sample));
      window.removeEventListener('reitunes:lastfm', refresh); window.removeEventListener('pagehide', report);
    };
  }, [audioRef]);
}
