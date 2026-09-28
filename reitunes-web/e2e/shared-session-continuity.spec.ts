import { test, expect } from './fixtures/test';
import type { SharedPlaybackSnapshot, SharedPlaybackState } from '../src/stores/sharedSessionStore';

test.beforeEach(async ({ page }) => { await page.setViewportSize({ width: 390, height: 844 }); });

const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
const tracks = ids.map((id, index) => ({ id, name: index ? 'Cosmia' : 'Chemtrails', artist: 'Artist', album: '',
  created_time_utc: '2026-01-01T00:00:00', file_path: `${id}.mp3`, url: `/audio/${id}.mp3`,
  track_number: null, play_count: 0, bookmarks: {}, duration_seconds: 280 }));

for (const differentOwner of [false, true]) {
  test(`owned browser audio survives a failed refresh and ${differentOwner ? 'pauses when a different owner reconnects' : 'keeps its advanced song after reconnect'}`, async ({ page, sharedSession }) => {
    await page.addInitScript(() => {
      const paused = new WeakMap<HTMLMediaElement, boolean>();
      const times = new WeakMap<HTMLMediaElement, number>();
      Object.defineProperty(HTMLMediaElement.prototype, 'paused', { get() { return paused.get(this) ?? true; } });
      Object.defineProperty(HTMLMediaElement.prototype, 'readyState', { get() { return 4; } });
      Object.defineProperty(HTMLMediaElement.prototype, 'duration', { get() { return 280; } });
      Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', { get() { return times.get(this) ?? 0; }, set(value) { times.set(this, value); } });
      HTMLMediaElement.prototype.play = function () { paused.set(this, false); this.dispatchEvent(new Event('loadedmetadata')); this.dispatchEvent(new Event('play')); return Promise.resolve(); };
      HTMLMediaElement.prototype.pause = function () { paused.set(this, true); this.dispatchEvent(new Event('pause')); };
    });
    await page.route('**/api/items', route => route.fulfill({ json: tracks }));
    await page.route('**/api/items/*/duration', route => route.fulfill({ status: 204 }));
    await page.route('**/api/playlists', route => route.fulfill({ json: [] }));
    await page.route('**/api/tags', route => route.fulfill({ json: { enabled: false, items: {} } }));
    await page.route('**/api/discovery', route => route.fulfill({ json: { sources: [], entries: [] } }));
    await page.route('**/api/log', route => route.fulfill({ status: 200 }));
    await page.route('**/ui/play', route => route.fulfill({ status: 200 }));
    await page.route('**/audio/*.mp3', route => route.fulfill({ contentType: 'audio/mpeg', body: '' }));
    await page.routeWebSocket('**/updates', () => {});
    await page.goto('/#browse/library');
    await page.getByRole('button', { name: 'Play Chemtrails', exact: true }).click();
    await expect.poll(() => (sharedSession.snapshot.state as SharedPlaybackState)?.currentItemId).toBe(ids[0]);
    const playing = () => page.evaluate(() => document.querySelector('audio')?.paused === false);
    await expect.poll(playing).toBe(true);

    let unreachable = true;
    await page.route('**/api/playback-session', route => unreachable
      ? route.fulfill({ status: 503, json: { error: 'Temporarily unavailable' } }) : route.fallback());
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect(page.getByRole('alert').filter({ hasText: 'Could not load' })).toBeVisible();
    expect(await playing()).toBe(true);
    await page.evaluate(() => document.querySelector('audio')!.dispatchEvent(new Event('ended')));
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('reitunes-player')!).state.currentItemId)).toBe(ids[1]);
    expect(await playing()).toBe(true);

    if (differentOwner) {
      const next = structuredClone(sharedSession.snapshot.state as SharedPlaybackState);
      next.target = { kind: 'browser', ownerId: 'another-screen' };
      sharedSession.snapshot = { revision: sharedSession.snapshot.revision + 1, state: next };
      await page.evaluate(snapshot => window.dispatchEvent(new CustomEvent('reitunes:playback-session', { detail: snapshot })), sharedSession.snapshot);
      await expect.poll(playing).toBe(false); // A working websocket relinquishes ownership even while HTTP is unavailable.
    }
    unreachable = false;
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect(page.getByRole('alert').filter({ hasText: 'Could not load' })).toHaveCount(0);
    await expect.poll(playing).toBe(!differentOwner);
    if (!differentOwner) {
      await expect.poll(() => (sharedSession.snapshot.state as SharedPlaybackState).currentItemId).toBe(ids[1]);
      expect((sharedSession.snapshot.state as SharedPlaybackState).queue.contextIndex).toBe(1);
    }
  });
}

test('a worker completion before its CAS reply keeps the latest same-revision sync status', async ({ page, sharedSession }) => {
  await page.route('**/api/items', route => route.fulfill({ json: tracks }));
  await page.route('**/api/playlists', route => route.fulfill({ json: [] }));
  await page.route('**/api/tags', route => route.fulfill({ json: { enabled: false, items: {} } }));
  await page.route('**/api/discovery', route => route.fulfill({ json: { sources: [], entries: [] } }));
  await page.route('**/api/log', route => route.fulfill({ status: 200 }));
  await page.routeWebSocket('**/updates', () => {});
  await page.goto('/#browse/library');
  await expect(page.getByRole('button', { name: 'Play Chemtrails', exact: true })).toBeEnabled();
  await page.route('**/api/playback-session', async route => {
    if (route.request().method() !== 'POST') return route.fallback();
    const body = route.request().postDataJSON();
    const completed: SharedPlaybackSnapshot = { revision: body.expectedRevision + 1, state: body.state, queueSyncPending: false };
    sharedSession.snapshot = completed;
    await page.evaluate(snapshot => window.dispatchEvent(new CustomEvent('reitunes:playback-session', { detail: snapshot })), completed);
    await route.fulfill({ json: { ...completed, queueSyncPending: true } });
  });
  await page.evaluate(async () => {
    const queuePath = '/src/hooks/useQueue.ts';
    const sessionPath = '/src/hooks/useSharedPlaybackSession.ts';
    const { useQueueStore } = await import(queuePath);
    const { flushSharedSession } = await import(sessionPath);
    useQueueStore.getState().toggleShuffle();
    await flushSharedSession();
  });
  expect(await page.evaluate(async () => {
    const path = '/src/stores/sharedSessionStore.ts';
    const { useSharedSessionStore } = await import(path);
    return useSharedSessionStore.getState().queueSyncPending;
  })).toBe(false);
});
