import { expect, type Page } from '@playwright/test';
import { test, SonosSimulator, trackId, deferred } from './fixtures/sonos';

async function setup(page: Page) {
  const sonos = new SonosSimulator(page);
  await sonos.install();
  const items = ['Current song', 'Library next', 'Queued song'].map((name, index) => ({
    id: index === 0 ? trackId : `track-${index}`, name, artist: '', album: '',
    created_time_utc: '2026-01-01T00:00:00', file_path: 'song.mp3', url: '/audio/song.mp3',
    play_count: 0, is_favorite: false, bookmarks: {},
  }));
  await page.route('**/api/items', route => route.fulfill({ json: items }));
  await page.route('**/api/tags', route => route.fulfill({ json: { enabled: false, items: {} } }));
  const requests: Array<{ itemId: string; itemIds: string[] }> = [];
  let gate: ReturnType<typeof deferred> | null = null;
  let fails = false;
  await page.route('**/api/sonos/groups/group-1/queue', async route => {
    requests.push(route.request().postDataJSON());
    if (gate) await gate.promise;
    await route.fulfill(fails ? { status: 502, json: { error: 'Refresh failed' } } : { status: 204 });
  });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Pause Sonos', exact: true })).toBeEnabled();
  await page.evaluate(async items => {
    const path = '/src/hooks/useQueue.ts';
    const { useQueueStore } = await import(path);
    useQueueStore.getState().setContext(items, 0, 'Library');
  }, items);
  return { sonos, items, requests, hold: () => { gate = deferred(); return gate; }, fail: (value: boolean) => { fails = value; } };
}

async function edit(page: Page, action: 'addNext' | 'addToQueue' | 'clearManualQueue', index = 2) {
  await page.evaluate(async ({ action, index }) => {
    const path = '/src/hooks/useQueue.ts';
    const { useQueueStore } = await import(path);
    const queue = useQueueStore.getState();
    queue[action](queue.contextItems[index]);
  }, { action, index });
}

test('Play Next reaches Sonos during playback and is consumed before the library resumes', async ({ page }) => {
  const { sonos, items, requests } = await setup(page);
  await page.getByText('Queued song', { exact: true }).click({ button: 'right' });
  await page.getByText('▶ Play Next', { exact: true }).click();
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0].itemIds).toEqual(['track-2', 'track-1', 'track-2']);
  expect(sonos.queueRequests).toHaveLength(0);
  expect(sonos.commands).toEqual([]);

  await page.evaluate(payload => window.dispatchEvent(new CustomEvent('reitunes:sonos', { detail: {
    type: 'sonos', namespace: 'playback', eventType: 'playbackStatus', targetId: 'group-1', payload,
  } })), { ...sonos.status(), sourceItemId: items[2].id, itemId: 'manual-occurrence' });
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('reitunes-queue')!).state.manualQueue.length)).toBe(0);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('reitunes-queue')!).state.contextIndex)).toBe(0);
  await edit(page, 'addToQueue', 0);
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[1]).toMatchObject({ itemId: 'manual-occurrence', itemIds: [trackId, 'track-1', 'track-2'] });
});

test('edits made during a queue update are sent in order, including clearing the queue', async ({ page }) => {
  const { requests, hold, sonos } = await setup(page);
  const gate = hold();
  try {
    await edit(page, 'addNext');
    await expect.poll(() => requests.length).toBe(1);
    await edit(page, 'addToQueue', 0);
    gate.resolve();
    await expect.poll(() => requests.length).toBe(2);
    expect(requests[1].itemIds).toEqual(['track-2', trackId, 'track-1', 'track-2']);
    await edit(page, 'clearManualQueue');
    await expect.poll(() => requests.length).toBe(3);
    expect(requests[2].itemIds).toEqual(['track-1', 'track-2']);
    expect(sonos.queueRequests).toHaveLength(0);
  } finally { gate.resolve(); }
});

test('a failed queue update is visible and can be retried without restarting playback', async ({ page }) => {
  const { requests, fail, sonos } = await setup(page);
  fail(true);
  await edit(page, 'addNext');
  await expect(page.getByText(/Could not update the Sonos queue/)).toBeVisible();
  fail(false);
  await page.getByRole('button', { name: 'Retry queue update' }).click();
  await expect.poll(() => requests.length).toBe(2);
  await expect(page.getByRole('button', { name: 'Retry queue update' })).toHaveCount(0);
  expect(sonos.queueRequests).toHaveLength(0);
});

test('queueing the current song twice consumes each occurrence exactly once', async ({ page }) => {
  const { sonos, requests } = await setup(page);
  await edit(page, 'addToQueue', 0);
  await edit(page, 'addToQueue', 0);
  await expect.poll(() => requests.length).toBeGreaterThan(0);
  for (let index = 1; index <= 2; index++) {
    const payload = { ...sonos.status(), itemId: `repeated-${index}` };
    for (let repeat = 0; repeat < 2; repeat++) {
      await page.evaluate(payload => window.dispatchEvent(new CustomEvent('reitunes:sonos', { detail: {
        type: 'sonos', namespace: 'playback', eventType: 'playbackStatus', targetId: 'group-1', payload,
      } })), payload);
    }
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('reitunes-queue')!).state.manualQueue.length)).toBe(2 - index);
  }
});

test('reordering and removing queued tracks updates a paused Sonos without resuming it', async ({ page }) => {
  const { sonos, requests } = await setup(page);
  sonos.paused = true;
  await sonos.emitPlayback();
  await edit(page, 'addToQueue', 2);
  await edit(page, 'addToQueue', 0);
  await expect.poll(() => requests.at(-1)?.itemIds).toEqual(['track-2', trackId, 'track-1', 'track-2']);
  await page.evaluate(async () => {
    const path = '/src/hooks/useQueue.ts';
    const { useQueueStore } = await import(path);
    useQueueStore.getState().moveManualQueueItem(1, 0);
    useQueueStore.getState().removeFromManualQueue(1);
  });
  await expect.poll(() => requests.at(-1)?.itemIds).toEqual([trackId, 'track-1', 'track-2']);
  await expect(page.getByRole('button', { name: 'Play Sonos', exact: true })).toBeEnabled();
  expect(sonos.commands).toEqual([]);
  expect(sonos.queueRequests).toHaveLength(0);
});

test('an old queue failure does not follow the user to browser playback', async ({ page }) => {
  const { hold, fail } = await setup(page);
  const gate = hold();
  fail(true);
  const received = page.waitForRequest('**/api/sonos/groups/group-1/queue');
  await edit(page, 'addNext');
  await received;
  try {
    await page.evaluate(async () => {
      const path = '/src/stores/playbackTargetStore.ts';
      const { usePlaybackTargetStore } = await import(path);
      usePlaybackTargetStore.getState().setBrowserTarget();
    });
    const response = page.waitForResponse('**/api/sonos/groups/group-1/queue');
    gate.resolve();
    await response;
    await expect(page.getByText(/Could not update the Sonos queue/)).toHaveCount(0);
  } finally { gate.resolve(); }
});
