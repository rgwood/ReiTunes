import { expect, type Page, type SharedSessionSimulator } from './fixtures/test';
import { test, SonosSimulator, trackId, deferred } from './fixtures/sonos';
import type { SharedPlaybackState, SharedPlaybackSnapshot } from '../src/stores/sharedSessionStore';

function queue(session: SharedSessionSimulator) { return (session.snapshot.state as SharedPlaybackState).queue; }
function upcoming(session: SharedSessionSimulator) {
  const saved = queue(session);
  const order = saved.shuffleEnabled ? saved.shuffledIds : saved.contextItemIds;
  const index = order.indexOf(saved.contextItemIds[saved.contextIndex]);
  return [...saved.manualQueue.map(entry => entry.itemId), ...order.slice(index + 1)];
}

async function emitSnapshot(page: Page, session: SharedSessionSimulator, snapshot: SharedPlaybackSnapshot) {
  session.snapshot = snapshot;
  await page.evaluate(snapshot => window.dispatchEvent(new CustomEvent('reitunes:playback-session', { detail: snapshot })), snapshot);
}

async function setup(page: Page, session: SharedSessionSimulator) {
  const sonos = new SonosSimulator(page);
  await sonos.install();
  const items = ['Current song', 'Library next', 'Queued song'].map((name, index) => ({
    id: index === 0 ? trackId : `track-${index}`, name, artist: '', album: '',
    created_time_utc: '2026-01-01T00:00:00', file_path: 'song.mp3', url: '/audio/song.mp3',
    play_count: 0, is_favorite: false, bookmarks: {},
  }));
  await page.route('**/api/items', route => route.fulfill({ json: items }));
  await page.route('**/api/tags', route => route.fulfill({ json: { enabled: false, items: {} } }));
  const directQueueRequests: unknown[] = [];
  await page.route('**/api/sonos/groups/group-1/queue', route => {
    directQueueRequests.push(route.request().postDataJSON());
    return route.fulfill({ status: 204 });
  });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Pause Sonos', exact: true })).toBeEnabled();
  await page.evaluate(async items => {
    const queuePath = '/src/hooks/useQueue.ts';
    const sessionPath = '/src/hooks/useSharedPlaybackSession.ts';
    const { useQueueStore } = await import(queuePath);
    const { flushSharedSession } = await import(sessionPath);
    useQueueStore.getState().setContext(items, 0, 'Library');
    await flushSharedSession();
  }, items);
  await expect.poll(() => queue(session).contextItemIds.length).toBe(3);
  return { sonos, items, directQueueRequests };
}

async function edit(page: Page, action: 'addNext' | 'addToQueue' | 'clearManualQueue', index = 2) {
  await page.evaluate(async ({ action, index }) => {
    const path = '/src/hooks/useQueue.ts';
    const { useQueueStore } = await import(path);
    const queue = useQueueStore.getState();
    queue[action](queue.contextItems[index]);
  }, { action, index });
}

test('revealing the current Sonos song leaves playback and the queue alone', async ({ page, sharedSession }) => {
  const { sonos, directQueueRequests } = await setup(page, sharedSession);
  const queueBefore = structuredClone(queue(sharedSession));
  const search = page.getByRole('searchbox', { name: 'Search library' });
  for (const trigger of ['title', 'shortcut']) {
    await search.fill('Queued song');
    await expect(page.locator('tbody tr')).toHaveCount(1);
    if (trigger === 'title') await page.getByRole('button', { name: 'Show current song in library' }).click();
    else await page.keyboard.press('Control+l');
    await expect(search).toHaveValue('');
    const current = page.locator('tbody tr[aria-current="true"]');
    await expect(current).toContainText('Current song');
    await expect(current).toBeFocused();
    await expect(current).toHaveAttribute('aria-selected', 'true');
  }
  expect(queue(sharedSession)).toEqual(queueBefore);
  expect(directQueueRequests).toEqual([]);
  expect(sonos.queueRequests).toEqual([]);
  expect(sonos.commands).toEqual([]);
});

test('shuffle saves the upcoming shared order without restarting Sonos and restores ordinary order', async ({ page, sharedSession }) => {
  const { directQueueRequests, sonos } = await setup(page, sharedSession);
  await page.evaluate(() => { Math.random = () => 0; });
  await page.getByRole('button', { name: 'Shuffle off', exact: true }).click();
  await expect.poll(() => upcoming(sharedSession)).toEqual(['track-2', 'track-1']);
  await expect(page.getByRole('button', { name: 'Shuffle on', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Shuffle on', exact: true }).click();
  await expect.poll(() => upcoming(sharedSession)).toEqual(['track-1', 'track-2']);
  expect(directQueueRequests).toEqual([]);
  expect(sonos.queueRequests).toHaveLength(0);
  expect(sonos.commands).toEqual([]);
});

test('Play Next saves ahead of the library and the server consumes its occurrence', async ({ page, sharedSession }) => {
  const { sonos, items, directQueueRequests } = await setup(page, sharedSession);
  await page.getByText('Queued song', { exact: true }).click({ button: 'right' });
  await page.getByText('▶ Play Next', { exact: true }).click();
  await expect.poll(() => upcoming(sharedSession)).toEqual(['track-2', 'track-1', 'track-2']);
  const next = structuredClone(sharedSession.snapshot.state as SharedPlaybackState);
  next.currentItemId = items[2].id;
  next.queue.manualQueue.shift();
  await emitSnapshot(page, sharedSession, { revision: sharedSession.snapshot.revision + 1, state: next });
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('reitunes-queue')!).state.manualQueue.length)).toBe(0);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('reitunes-queue')!).state.contextIndex)).toBe(0);
  await edit(page, 'addToQueue', 0);
  await expect.poll(() => upcoming(sharedSession)).toEqual([trackId, 'track-1', 'track-2']);
  expect(directQueueRequests).toEqual([]);
  expect(sonos.queueRequests).toHaveLength(0);
  expect(sonos.commands).toEqual([]);
});

test('edits made during a session save are serialized, including clearing the queue', async ({ page, sharedSession }) => {
  const { directQueueRequests, sonos } = await setup(page, sharedSession);
  const arrived = deferred();
  const release = deferred();
  let held = false;
  await page.route('**/api/playback-session', async route => {
    if (route.request().method() === 'POST' && !held) { held = true; arrived.resolve(); await release.promise; }
    await route.fallback();
  });
  try {
    await edit(page, 'addNext');
    await arrived.promise;
    await edit(page, 'addToQueue', 0);
    release.resolve();
    await expect.poll(() => upcoming(sharedSession)).toEqual(['track-2', trackId, 'track-1', 'track-2']);
    await edit(page, 'clearManualQueue');
    await expect.poll(() => upcoming(sharedSession)).toEqual(['track-1', 'track-2']);
    expect(directQueueRequests).toEqual([]);
    expect(sonos.queueRequests).toHaveLength(0);
  } finally { release.resolve(); }
});

test('a server queue projection failure is visible and retry only wakes its worker', async ({ page, sharedSession }) => {
  const { directQueueRequests, sonos } = await setup(page, sharedSession);
  await edit(page, 'addNext');
  await expect.poll(() => queue(sharedSession).manualQueue.length).toBe(1);
  await emitSnapshot(page, sharedSession, { ...sharedSession.snapshot as SharedPlaybackSnapshot,
    queueSyncPending: true, queueSyncError: 'Could not update the Sonos queue. Refresh failed.' });
  await expect(page.getByText(/Could not update the Sonos queue/).first()).toBeVisible();
  let retries = 0;
  await page.route('**/api/playback-session/queue-sync', async route => {
    retries += 1;
    sharedSession.snapshot = { revision: sharedSession.snapshot.revision, state: sharedSession.snapshot.state };
    await route.fulfill({ status: 202 });
  });
  await page.getByRole('button', { name: 'Retry queue update' }).click();
  await expect.poll(() => retries).toBe(1);
  await expect(page.getByRole('button', { name: 'Retry queue update' })).toHaveCount(0);
  expect(directQueueRequests).toEqual([]);
  expect(sonos.queueRequests).toHaveLength(0);
  expect(sonos.commands).toEqual([]);
});

test('repeated speaker events never double-consume shared queue occurrences', async ({ page, sharedSession }) => {
  const { sonos, directQueueRequests } = await setup(page, sharedSession);
  await edit(page, 'addToQueue', 0);
  await edit(page, 'addToQueue', 0);
  await expect.poll(() => queue(sharedSession).manualQueue.length).toBe(2);
  expect(new Set(queue(sharedSession).manualQueue.map(entry => entry.id)).size).toBe(2);
  for (let index = 1; index <= 2; index++) {
    const next = structuredClone(sharedSession.snapshot.state as SharedPlaybackState);
    next.queue.manualQueue.shift();
    const snapshot = { revision: sharedSession.snapshot.revision + 1, state: next };
    await emitSnapshot(page, sharedSession, snapshot);
    for (let repeat = 0; repeat < 2; repeat++) {
      await sonos.emitPlayback();
      await emitSnapshot(page, sharedSession, snapshot);
    }
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('reitunes-queue')!).state.manualQueue.length)).toBe(2 - index);
  }
  expect(directQueueRequests).toEqual([]);
});

test('reordering and removing queued tracks saves without resuming a paused Sonos', async ({ page, sharedSession }) => {
  const { sonos, directQueueRequests } = await setup(page, sharedSession);
  sonos.paused = true;
  await sonos.emitPlayback();
  await edit(page, 'addToQueue', 2);
  await edit(page, 'addToQueue', 0);
  await expect.poll(() => upcoming(sharedSession)).toEqual(['track-2', trackId, 'track-1', 'track-2']);
  await page.evaluate(async () => {
    const path = '/src/hooks/useQueue.ts';
    const { useQueueStore } = await import(path);
    useQueueStore.getState().moveManualQueueItem(1, 0);
    useQueueStore.getState().removeFromManualQueue(1);
  });
  await expect.poll(() => upcoming(sharedSession)).toEqual([trackId, 'track-1', 'track-2']);
  await expect(page.getByRole('button', { name: 'Play Sonos', exact: true })).toBeEnabled();
  expect(directQueueRequests).toEqual([]);
  expect(sonos.commands).toEqual([]);
  expect(sonos.queueRequests).toHaveLength(0);
});

test('an old queue error cannot follow a newer browser output selection', async ({ page, sharedSession }) => {
  await setup(page, sharedSession);
  const old = structuredClone(sharedSession.snapshot as SharedPlaybackSnapshot);
  await page.evaluate(async () => {
    const targetPath = '/src/stores/playbackTargetStore.ts';
    const sessionPath = '/src/hooks/useSharedPlaybackSession.ts';
    const { usePlaybackTargetStore } = await import(targetPath);
    const { stageSharedPlayback, flushSharedSession } = await import(sessionPath);
    usePlaybackTargetStore.getState().setBrowserTarget();
    stageSharedPlayback();
    await flushSharedSession();
  });
  await page.evaluate(snapshot => window.dispatchEvent(new CustomEvent('reitunes:playback-session', { detail: snapshot })), {
    ...old, queueSyncPending: true, queueSyncError: 'Could not update the Sonos queue. Old failure.',
  });
  await expect(page.getByText(/Could not update the Sonos queue/)).toHaveCount(0);
});
