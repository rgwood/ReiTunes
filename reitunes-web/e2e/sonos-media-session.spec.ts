import { expect, type Page } from '@playwright/test';
import { test, deferred, SonosSimulator, trackId } from './fixtures/sonos';

type MediaTestWindow = Window & {
  mediaHandlers: Partial<Record<MediaSessionAction, MediaSessionActionHandler | null>>;
  mediaPosition?: MediaPositionState;
  localPlayCalls: number;
};

async function mediaAction(page: Page, action: MediaSessionAction, details: Partial<MediaSessionActionDetails> = {}) {
  await expect.poll(() => page.evaluate(action => !!(window as unknown as MediaTestWindow).mediaHandlers[action], action)).toBe(true);
  await page.evaluate(({ action, details }) => {
    const handler = (window as unknown as MediaTestWindow).mediaHandlers[action];
    if (!handler) throw new Error(`No media session handler for ${action}`);
    handler({ action, ...details });
  }, { action, details });
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const testWindow = window as unknown as MediaTestWindow;
    testWindow.mediaHandlers = {};
    testWindow.localPlayCalls = 0;
    // Record registration while retaining the browser's real Media Session API.
    const register = navigator.mediaSession.setActionHandler.bind(navigator.mediaSession);
    navigator.mediaSession.setActionHandler = (action, handler) => {
      register(action, handler);
      testWindow.mediaHandlers[action] = handler;
    };
    const setPosition = navigator.mediaSession.setPositionState.bind(navigator.mediaSession);
    navigator.mediaSession.setPositionState = state => {
      setPosition(state);
      testWindow.mediaPosition = state;
    };
    HTMLMediaElement.prototype.play = function () {
      testWindow.localPlayCalls += 1;
      return Promise.resolve();
    };
    Object.defineProperty(HTMLMediaElement.prototype, 'duration', { configurable: true, get: () => 300 });
  });
});

test('Sonos media actions control the speaker and report its confirmed state', async ({ page }) => {
  const sonos = new SonosSimulator(page);
  await sonos.open();
  await page.locator('audio').dispatchEvent('loadedmetadata');
  await expect.poll(() => page.evaluate(() => navigator.mediaSession.metadata?.title)).toBe('Northern Sky');
  await expect.poll(() => page.evaluate(() => navigator.mediaSession.playbackState)).toBe('playing');
  await mediaAction(page, 'pause');
  await expect.poll(() => sonos.commands).toEqual(['pause']);
  await expect.poll(() => page.evaluate(() => navigator.mediaSession.playbackState)).toBe('paused');
  await expect.poll(() => page.evaluate(() => (window as unknown as MediaTestWindow).mediaPosition?.position)).toBe(50);

  const seeks: number[] = [];
  await page.route('**/api/sonos/groups/group-1/playback/seek', route => {
    const request = route.request().postDataJSON();
    expect(request.itemId).toBe('queue-item-1');
    seeks.push(request.positionMillis);
    sonos.speaker.positionMillis = request.positionMillis;
    return route.fulfill({ status: 204 });
  });
  for (const [action, details, expected] of [
    ['seekbackward', { seekOffset: 10 }, 40_000],
    ['seekforward', {}, 70_000],
    ['seekto', { seekTime: 120.25 }, 120_250],
  ] as const) {
    await mediaAction(page, action, details);
    await expect.poll(() => seeks.at(-1)).toBe(expected);
    await expect(page.getByRole('button', { name: 'Play Sonos', exact: true })).toBeEnabled();
  }
  await mediaAction(page, 'play');
  await expect.poll(() => page.evaluate(() => navigator.mediaSession.playbackState)).toBe('playing');
  await mediaAction(page, 'stop');
  await expect.poll(() => page.evaluate(() => navigator.mediaSession.playbackState)).toBe('paused');
  expect(sonos.commands).toEqual(['pause', 'play', 'pause']);
  expect(await page.evaluate(() => (window as unknown as MediaTestWindow).localPlayCalls)).toBe(0);
  expect(sonos.queueRequests).toHaveLength(0);

  await page.evaluate(async () => {
    const modulePath = '/src/stores/playbackTargetStore.ts';
    const { usePlaybackTargetStore } = await import(modulePath);
    usePlaybackTargetStore.getState().setBrowserTarget();
  });
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
  await mediaAction(page, 'play');
  expect(await page.evaluate(() => (window as unknown as MediaTestWindow).localPlayCalls)).toBe(1);
  expect(sonos.commands).toEqual(['pause', 'play', 'pause']);
});

test('Sonos media seek bursts accumulate synchronously and send only the latest queued position', async ({ page }) => {
  const sonos = new SonosSimulator(page);
  sonos.paused = true;
  await sonos.install();
  const firstSeek = { arrived: deferred(), release: deferred() };
  const seeks: number[] = [];
  await page.route('**/api/sonos/groups/group-1/playback/seek', async route => {
    const request = route.request().postDataJSON();
    expect(request.itemId).toBe('queue-item-1');
    seeks.push(request.positionMillis);
    if (seeks.length === 1) {
      firstSeek.arrived.resolve();
      await firstSeek.release.promise;
    }
    sonos.speaker.positionMillis = request.positionMillis;
    await route.fulfill({ status: 204 });
  });
  try {
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Play Sonos', exact: true })).toBeEnabled();
    await page.locator('audio').dispatchEvent('loadedmetadata');
    const timeline = page.getByRole('slider', { name: 'Sonos playback position' });
    await expect(timeline).toHaveValue('50');

    await mediaAction(page, 'seekforward');
    await firstSeek.arrived.promise;
    await expect(timeline).toHaveValue('80');
    // No render can occur between these actions: relative seeks must read the
    // latest intent directly instead of adding to a stale callback's position.
    await page.evaluate(() => {
      const handlers = (window as unknown as MediaTestWindow).mediaHandlers;
      for (const details of [
        { action: 'seekforward' },
        { action: 'seekforward' },
        { action: 'seekbackward', seekOffset: 10 },
        { action: 'seekforward', seekOffset: 15 },
      ] satisfies MediaSessionActionDetails[]) {
        const handler = handlers[details.action];
        if (!handler) throw new Error(`No media session handler for ${details.action}`);
        handler(details);
      }
    });
    await expect(timeline).toHaveValue('145');
    expect(seeks).toEqual([80_000]);
    expect(sonos.speaker.positionMillis).toBe(50_000);

    firstSeek.release.resolve();
    await expect.poll(() => seeks).toEqual([80_000, 145_000]);
    await expect.poll(() => sonos.speaker.positionMillis).toBe(145_000);
    await expect(page.getByRole('button', { name: 'Play Sonos', exact: true })).toBeEnabled();
    await expect(timeline).toHaveValue('145');
    expect(await page.evaluate(() => navigator.mediaSession.playbackState)).toBe('paused');
    expect(await page.evaluate(() => (window as unknown as MediaTestWindow).localPlayCalls)).toBe(0);
    expect(sonos.queueRequests).toHaveLength(0);
  } finally {
    firstSeek.release.resolve();
  }
});

test('Sonos media keys keep playback state on failure and cannot control a lost session', async ({ page }) => {
  const sonos = new SonosSimulator(page);
  await sonos.open();
  sonos.pauseResult = 'rejected';
  await mediaAction(page, 'pause');
  await expect(page.getByText('Sonos pause was not acknowledged')).toBeVisible();
  expect(await page.evaluate(() => navigator.mediaSession.playbackState)).toBe('playing');
  await page.evaluate(id => window.dispatchEvent(new CustomEvent('reitunes:sonos', { detail: {
    targetId: 'group-1', namespace: 'playback', eventType: 'playbackStatus',
    payload: { playbackState: 'PLAYBACK_STATE_PLAYING', positionMillis: 0, sourceItemId: id, reitunesSessionActive: false },
  } })), trackId);
  await expect.poll(() => page.evaluate(() => navigator.mediaSession.playbackState)).toBe('none');
  expect(await page.evaluate(() => navigator.mediaSession.metadata)).toBeNull();
  await mediaAction(page, 'play');
  await mediaAction(page, 'pause');
  await mediaAction(page, 'nexttrack');
  expect(await page.evaluate(() => (window as unknown as MediaTestWindow).localPlayCalls)).toBe(0);
  expect(sonos.commands).toEqual(['pause']);
});

test('media track keys use the Sonos queue and handoff blocks media commands', async ({ page }) => {
  const sonos = new SonosSimulator(page);
  await sonos.install();
  const items = [trackId, '22222222-2222-4222-8222-222222222222'].map((id, index) => ({
    id, name: index ? 'Second track' : 'Northern Sky', artist: 'Nick Drake', album: '',
    created_time_utc: '2026-01-01T00:00:00', file_path: 'song.mp3', url: '/audio/song.mp3',
    play_count: 0, is_favorite: false, bookmarks: {},
  }));
  await page.route('**/api/items', route => route.fulfill({ json: items }));
  let sourceItemId = trackId;
  await page.route('**/api/sonos/groups/group-1/playback', route => route.fulfill({ json: { ...sonos.status(), sourceItemId } }));
  await page.route('**/api/sonos/play', route => {
    const request = route.request().postDataJSON();
    sonos.queueRequests.push(request);
    sourceItemId = request.startItemId;
    return route.fulfill({ json: { groupId: 'group-1' } });
  });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Pause Sonos', exact: true })).toBeEnabled();
  await page.evaluate(async items => {
    const queuePath = '/src/hooks/useQueue.ts';
    const { useQueueStore } = await import(queuePath);
    useQueueStore.getState().setContext(items, 0, 'Library');
  }, items);
  await mediaAction(page, 'nexttrack');
  await expect.poll(() => sonos.queueRequests.length).toBe(1);
  await expect.poll(() => page.evaluate(() => navigator.mediaSession.metadata?.title)).toBe('Second track');
  await expect(page.getByRole('button', { name: 'Pause Sonos', exact: true })).toBeEnabled();
  await mediaAction(page, 'previoustrack');
  await expect.poll(() => sonos.queueRequests.length).toBe(2);
  await expect.poll(() => page.evaluate(() => navigator.mediaSession.metadata?.title)).toBe('Northern Sky');
  await expect(page.getByRole('button', { name: 'Pause Sonos', exact: true })).toBeEnabled();

  await page.evaluate(async () => {
    const modulePath = '/src/stores/playbackTargetStore.ts';
    const { usePlaybackTargetStore } = await import(modulePath);
    usePlaybackTargetStore.getState().setSwitchingOutput(true);
  });
  await mediaAction(page, 'play');
  await mediaAction(page, 'pause');
  await mediaAction(page, 'nexttrack');
  expect(sonos.commands).toHaveLength(0);
  expect(sonos.queueRequests).toHaveLength(2);
  expect(await page.evaluate(() => (window as unknown as MediaTestWindow).localPlayCalls)).toBe(0);
});
