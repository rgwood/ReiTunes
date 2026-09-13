import { expect, test as base, type Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

export const trackId = '11111111-1111-4111-8111-111111111111';
export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

export function speakerState() {
  return { paused: false, volume: 50, positionMillis: 50_000, transcript: [] as Array<{
    sequence: number; controller: string; operation: string; phase: string;
    paused: boolean; volume: number; positionMillis: number;
  }> };
}

const simulators: SonosSimulator[] = [];
export const test = base.extend<{ sonosDiagnostics: void }>({
  // Playwright requires destructuring here, even for a fixture with no dependencies.
  // eslint-disable-next-line no-empty-pattern
  sonosDiagnostics: [async ({}, runTest, testInfo) => {
    simulators.length = 0;
    try {
      await runTest();
    } finally {
      try {
        if (testInfo.status !== testInfo.expectedStatus) {
          const speakers = [...new Set(simulators.map(simulator => simulator.speaker))];
          const transcriptPath = testInfo.outputPath('sonos-transcript.json');
          await writeFile(transcriptPath, JSON.stringify(speakers.map(speaker => speaker.transcript), null, 2));
          await testInfo.attach('sonos-transcript', {
            path: transcriptPath, contentType: 'application/json',
          });
        }
      } finally {
        simulators.forEach(simulator => simulator.releasePending());
        simulators.length = 0;
      }
    }
  }, { auto: true }],
});

// A controllable speaker/API boundary: no account, cloud access or real audio.
// Gates let tests choose response ordering without relying on arbitrary sleeps.
export class SonosSimulator {
  get paused() { return this.speaker.paused; }
  set paused(value: boolean) { this.speaker.paused = value; }
  pauseResult: 'ok' | 'rejected' | 'lost-reply' = 'ok';
  statusFails = false;
  queueFails = false;
  commands: string[] = [];
  queueRequests: Array<{ allowTakeover: boolean }> = [];
  delayedPoll: { arrived: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> } | null = null;
  delayedQueue: ReturnType<typeof deferred> | null = null;
  delayedVolume: { arrived: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> } | null = null;
  private pending = new Set<ReturnType<typeof deferred>>();

  constructor(readonly page: Page, readonly speaker = speakerState(), readonly controller = 'controller-1') {
    simulators.push(this);
  }

  record(operation: string, phase: string, observed: Partial<{ paused: boolean; volume: number; positionMillis: number }> = {}) {
    const { paused, volume, positionMillis, transcript } = this.speaker;
    transcript.push({ sequence: transcript.length + 1, controller: this.controller, operation, phase, paused, volume, positionMillis, ...observed });
    return transcript.length;
  }

  releasePending() { this.pending.forEach(gate => gate.resolve()); }

  private async hold(gate: ReturnType<typeof deferred>) {
    this.pending.add(gate);
    try { await gate.promise; } finally { this.pending.delete(gate); }
  }

  status() {
    return {
      playbackState: this.paused ? 'PLAYBACK_STATE_PAUSED' : 'PLAYBACK_STATE_PLAYING',
      positionMillis: this.speaker.positionMillis, itemId: 'queue-item-1', queueVersion: 'queue-version-1',
      sourceItemId: trackId, reitunesSessionActive: true, availablePlaybackActions: { canPause: true },
    };
  }

  async install() {
    await this.page.addInitScript(id => {
      localStorage.setItem('reitunes-playback-target', JSON.stringify({ version: 1, state: {
        target: { kind: 'sonos', householdId: 'household', groupId: 'group-1', groupName: 'Kitchen', playerNames: [] }, takeoverRequired: true,
      } }));
      localStorage.setItem('reitunes-player', JSON.stringify({ version: 1, state: {
        currentItemId: id, resumePosition: 50, volume: 0.5, isMuted: false,
      } }));
    }, trackId);
    await this.page.route('**/api/items', route => route.fulfill({ json: [{
      id: trackId, name: 'Northern Sky', artist: 'Nick Drake', album: 'Bryter Layter',
      created_time_utc: '2026-01-01T00:00:00', file_path: 'song.mp3', url: '/audio/song.mp3',
      play_count: 0, is_favorite: false, bookmarks: {},
    }] }));
    await this.page.route('**/api/playlists', route => route.fulfill({ json: [] }));
    await this.page.route('**/api/discovery', route => route.fulfill({ json: { sources: [], entries: [] } }));
    await this.page.route('**/api/log', route => route.fulfill({ status: 200 }));
    await this.page.route('**/ui/play', route => route.fulfill({ status: 200 }));
    await this.page.route('**/audio/*.mp3', route => route.fulfill({ contentType: 'audio/mpeg', body: '' }));
    await this.page.routeWebSocket('**/updates', () => {});
    await this.page.route('**/api/sonos/groups/group-1/volume', async route => {
      if (route.request().method() === 'POST') {
        this.speaker.volume = route.request().postDataJSON().volume;
        this.commands.push('volume');
        this.record('volume', 'applied');
        await route.fulfill({ status: 204 });
        return;
      }
      const read = this.record('volume', 'read');
      const volume = this.speaker.volume;
      const delayed = this.delayedVolume;
      this.delayedVolume = null;
      if (delayed) {
        delayed.arrived.resolve();
        await this.hold(delayed.release);
      }
      this.record('volume', `reply to ${read}`, { volume });
      await route.fulfill({ json: { volume, muted: false, fixed: false } });
    });
    await this.page.route('**/api/sonos/groups/group-1/playback', async route => {
      const read = this.record('playback', 'read');
      const snapshot = this.status();
      const fails = this.statusFails;
      const delayed = this.delayedPoll;
      this.delayedPoll = null;
      if (delayed) {
        delayed.arrived.resolve();
        await this.hold(delayed.release);
      }
      this.record('playback', `${fails ? 'rejected' : 'reply'} to ${read}`, {
        paused: snapshot.playbackState === 'PLAYBACK_STATE_PAUSED', positionMillis: snapshot.positionMillis,
      });
      await route.fulfill(fails ? { status: 503, json: { error: 'Speaker status unavailable' } } : { json: snapshot });
    });
    await this.page.route('**/api/sonos/groups/group-1/playback/pause', route => {
      this.commands.push('pause');
      if (this.pauseResult !== 'rejected') this.paused = true;
      this.record('pause', this.pauseResult === 'rejected' ? 'rejected' : 'applied');
      return route.fulfill(this.pauseResult === 'ok' ? { status: 204 } : {
        status: 504, json: { error: 'Sonos pause was not acknowledged' },
      });
    });
    await this.page.route('**/api/sonos/groups/group-1/playback/play', route => {
      this.commands.push('play');
      this.paused = false;
      this.record('play', 'applied');
      return route.fulfill({ status: 204 });
    });
    await this.page.route('**/api/sonos/play', async route => {
      this.queueRequests.push(route.request().postDataJSON());
      this.record('queue', 'received');
      const delayed = this.delayedQueue;
      const fails = this.queueFails;
      this.delayedQueue = null;
      if (delayed) await this.hold(delayed);
      this.record('queue', fails ? 'rejected' : 'reply');
      await route.fulfill(fails ? { status: 502, json: { error: 'Old queue failed' } } : { json: { groupId: 'group-1', sessionCreated: false } });
    });
  }

  async open() {
    await this.install();
    await this.page.goto('/');
    await expect(this.page.getByRole('button', { name: 'Pause Sonos', exact: true })).toBeEnabled();
  }

  async emitPlayback() {
    this.record('playback', 'event');
    await this.page.evaluate(payload => window.dispatchEvent(new CustomEvent('reitunes:sonos', { detail: {
      type: 'sonos', namespace: 'playback', eventType: 'playbackStatus', targetId: 'group-1', payload,
    } })), this.status());
  }

  async refresh() {
    await this.page.evaluate(() => window.dispatchEvent(new Event('online')));
  }
}
