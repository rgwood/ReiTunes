import { test, expect, type Page, type WebSocketRoute } from './fixtures/test';
import type { SharedPlaybackState } from '../src/stores/sharedSessionStore';

const firstId = '11111111-1111-4111-8111-111111111111';
const secondId = '22222222-2222-4222-8222-222222222222';
const tracks = [
  { id: firstId, name: 'Chemtrails', artist: 'Beck', album: 'Modern Guilt' },
  { id: secondId, name: 'Cosmia', artist: 'Joanna Newsom', album: 'Ys' },
].map(item => ({ ...item, created_time_utc: '2026-01-01T00:00:00', file_path: `${item.id}.mp3`,
  url: `/audio/${item.id}.mp3`, track_number: null, play_count: 0, bookmarks: {}, duration_seconds: 280 }));

function state(): SharedPlaybackState {
  return {
    target: { kind: 'sonos', householdId: 'household', groupId: 'living-room', groupName: 'Living room', playerNames: ['Living room'] },
    currentItemId: firstId, position: 42, playbackRange: null,
    queue: { manualQueue: [{ id: 'copy-a', itemId: secondId }, { id: 'copy-b', itemId: secondId }],
      contextItemIds: [firstId, secondId], contextIndex: 0, contextName: 'Housewarming',
      shuffleEnabled: false, shuffledIds: [], repeatMode: 'off' },
  };
}

async function install(page: Page, onSocket: (socket: WebSocketRoute) => void = () => {}) {
  const requests: Array<{ path: string; body?: unknown }> = [];
  let paused = false;
  let volume = 35;
  await page.route('**/api/items', route => route.fulfill({ json: tracks }));
  await page.route('**/api/playlists', route => route.fulfill({ json: [] }));
  await page.route('**/api/tags', route => route.fulfill({ json: { items: {}, tags: [], jobs: [] } }));
  await page.route('**/api/discovery', route => route.fulfill({ json: { sources: [], entries: [] } }));
  await page.route('**/api/log', route => route.fulfill({ status: 200 }));
  await page.route('**/ui/play', route => route.fulfill({ status: 200 }));
  await page.route('**/audio/*.mp3', route => route.fulfill({ contentType: 'audio/mpeg', body: '' }));
  await page.routeWebSocket('**/updates', onSocket);
  await page.route('**/api/sonos/**', route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() !== 'GET') {
      requests.push({ path, body: request.postData() ? request.postDataJSON() : undefined });
      if (path.endsWith('/pause')) paused = true;
      if (path.endsWith('/play')) paused = false;
      if (path.endsWith('/volume')) volume = request.postDataJSON().volume;
      return route.fulfill({ status: 204 });
    }
    if (path.endsWith('/volume')) return route.fulfill({ json: { volume, muted: false, fixed: false } });
    return route.fulfill({ json: {
      playbackState: paused ? 'PLAYBACK_STATE_PAUSED' : 'PLAYBACK_STATE_PLAYING',
      positionMillis: 42_000, itemId: 'cloud-occurrence', queueVersion: 'cloud-v1', sourceItemId: firstId,
      reitunesSessionActive: true, availablePlaybackActions: { canPause: true },
    } });
  });
  return requests;
}

async function queueState(page: Page) {
  return page.evaluate(async () => {
    const path = '/src/hooks/useQueue.ts';
    const { useQueueStore } = await import(path);
    const state = useQueueStore.getState();
    return { ids: state.manualQueueIds, songs: state.manualQueue.map((item: { id: string }) => item.id), context: state.contextName };
  });
}

test('a live library deletion removes the song from the shared shuffle order', async ({ page, sharedSession }) => {
  const saved = state();
  saved.queue.shuffleEnabled = true;
  saved.queue.shuffledIds = [firstId, secondId];
  sharedSession.snapshot = { revision: 7, state: saved };
  let socket: WebSocketRoute | undefined;
  await install(page, connected => { socket = connected; });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Pause Sonos', exact: true })).toBeEnabled();
  await expect.poll(() => Boolean(socket)).toBe(true);
  socket!.send(JSON.stringify({ type: 'delete', id: secondId }));
  await expect.poll(() => sharedSession.snapshot.revision).toBe(8);
  expect((sharedSession.snapshot.state as SharedPlaybackState).queue).toMatchObject({
    contextItemIds: [firstId], contextIndex: 0, shuffledIds: [firstId], manualQueue: [],
  });
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('a session containing a deleted shuffled song can be edited after hydration', async ({ page, sharedSession }) => {
  const saved = state();
  const deletedId = '33333333-3333-4333-8333-333333333333';
  saved.queue.contextItemIds = [firstId, deletedId, secondId];
  saved.queue.shuffleEnabled = true;
  saved.queue.shuffledIds = [firstId, deletedId, secondId];
  sharedSession.snapshot = { revision: 7, state: saved };
  await install(page);
  await page.route('**/api/playback-session', route => {
    if (route.request().method() === 'POST') {
      const queue = route.request().postDataJSON().state.queue;
      if (queue.shuffledIds.some((id: string) => !queue.contextItemIds.includes(id))) {
        return route.fulfill({ status: 400, json: { error: 'Shuffle order must contain distinct songs from the context' } });
      }
    }
    return route.fallback();
  });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Pause Sonos', exact: true })).toBeEnabled();
  await page.evaluate(async () => {
    const path = '/src/hooks/useQueue.ts';
    const { useQueueStore } = await import(path);
    useQueueStore.getState().removeFromManualQueue(0);
  });
  await expect.poll(() => sharedSession.snapshot.revision).toBeGreaterThan(7);
  const updated = sharedSession.snapshot.state as SharedPlaybackState;
  expect(updated.queue.contextItemIds).toEqual([firstId, secondId]);
  expect(updated.queue.shuffledIds).toEqual([firstId, secondId]);
  expect(updated.queue.manualQueue).toEqual([{ id: 'copy-b', itemId: secondId }]);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

for (const jsonError of [true, false]) {
  test(`failed session saves report HTTP status and ${jsonError ? 'server detail' : 'omit proxy HTML'}, then Retry recovers`, async ({ page, sharedSession }) => {
    sharedSession.snapshot = { revision: 7, state: state() };
    await install(page);
    const logs: Array<{ level: string; args: Array<{ events: Array<Record<string, unknown>> }> }> = [];
    await page.route('**/api/log', route => {
      logs.push(route.request().postDataJSON());
      return route.fulfill({ status: 200 });
    });
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Pause Sonos', exact: true })).toBeEnabled();
    let failedOperation: { operationId: string; expectedRevision: number } | undefined;
    await page.route('**/api/playback-session', route => {
      if (route.request().method() !== 'POST') return route.fallback();
      failedOperation = route.request().postDataJSON();
      return route.fulfill(jsonError
        ? { status: 400, json: { error: 'Shuffle order must contain distinct songs from the context' } }
        : { status: 503, contentType: 'text/html', body: '<h1>Private proxy detail</h1>' });
    });
    await page.evaluate(async () => {
      const queuePath = '/src/hooks/useQueue.ts';
      const sessionPath = '/src/hooks/useSharedPlaybackSession.ts';
      const { useQueueStore } = await import(queuePath);
      const { flushSharedSession } = await import(sessionPath);
      useQueueStore.getState().toggleShuffle();
      await flushSharedSession();
    });
    const alert = page.getByRole('alert').filter({ hasText: 'Could not save' });
    await expect(alert).toContainText(`HTTP ${jsonError ? 400 : 503}`);
    if (jsonError) await expect(alert).toContainText('Shuffle order must contain distinct songs from the context');
    await expect(alert).not.toContainText('Private proxy detail');
    const failures = () => logs.flatMap(log => log.args?.flatMap(batch => batch.events ?? []) ?? [])
      .filter(event => event.event === 'session-save-failed');
    await expect.poll(() => failures().length).toBe(1);
    expect(failures()[0]).toMatchObject({
      operationId: failedOperation!.operationId, expectedRevision: failedOperation!.expectedRevision,
      httpStatus: jsonError ? 400 : 503, target: 'sonos',
      contextCount: 2, manualQueueCount: 2, shuffleEnabled: true, shuffledCount: 2,
      staleShuffleCount: 0, duplicateShuffleCount: 0,
    });
    expect(JSON.stringify(logs)).not.toContain('Private proxy detail');
    expect(logs.find(log => log.args?.some(batch => batch.events?.some(event => event.event === 'session-save-failed')))?.level).toBe('warn');
    await alert.getByRole('button', { name: 'Retry' }).click();
    await expect(alert).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Pause Sonos', exact: true })).toBeEnabled();
  });
}

test('a fresh phone attaches to the desktop Sonos session without playing or replacing its queue', async ({ page, sharedSession }) => {
  sharedSession.snapshot = { revision: 7, state: state() };
  await page.setViewportSize({ width: 390, height: 844 });
  const requests = await install(page);
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Pause Sonos', exact: true })).toBeEnabled();
  await expect(page.getByRole('slider', { name: 'Sonos group volume' })).toHaveValue('35');
  expect(await queueState(page)).toEqual({ ids: ['copy-a', 'copy-b'], songs: [secondId, secondId], context: 'Housewarming' });
  expect(requests).toEqual([]);
  expect(sharedSession.requests.filter(request => request.method === 'POST')).toEqual([]);
  await page.getByRole('button', { name: 'Pause Sonos', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Play Sonos', exact: true })).toBeEnabled();
  await page.getByRole('slider', { name: 'Sonos group volume' }).fill('27');
  await page.getByRole('slider', { name: 'Sonos group volume' }).dispatchEvent('pointerup');
  await expect.poll(() => requests.map(request => request.path)).toEqual([
    '/api/sonos/groups/living-room/playback/pause', '/api/sonos/groups/living-room/volume',
  ]);
});

test('a phone removes exactly one duplicate queue occurrence and the desktop follows without sending a second queue', async ({ page, browser, sharedSession }) => {
  sharedSession.snapshot = { revision: 7, state: state() };
  const desktopRequests = await install(page);
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Pause Sonos', exact: true })).toBeEnabled();
  const phoneContext = await browser.newContext({ baseURL: new URL(page.url()).origin, viewport: { width: 390, height: 844 } });
  try {
    await sharedSession.install(phoneContext);
    const phone = await phoneContext.newPage();
    const phoneRequests = await install(phone);
    await phone.goto('/');
    await expect(phone.getByRole('button', { name: 'Pause Sonos', exact: true })).toBeEnabled();
    await phone.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Queue' }).click();
    await phone.getByRole('button', { name: 'Remove Cosmia from queue' }).first().click();
    await expect.poll(() => queueState(phone)).toEqual({ ids: ['copy-b'], songs: [secondId], context: 'Housewarming' });
    await expect.poll(() => queueState(page)).toEqual({ ids: ['copy-b'], songs: [secondId], context: 'Housewarming' });
    // Durable projection belongs to the server, so both controllers can close
    // after saving without leaving Sonos with an older queue.
    expect(phoneRequests).toEqual([]);
    expect(desktopRequests).toEqual([]);
    expect(sharedSession.snapshot.revision).toBe(8);
    expect((sharedSession.snapshot.state as SharedPlaybackState).queue.manualQueue).toEqual([{ id: 'copy-b', itemId: secondId }]);
  } finally { await phoneContext.close(); }
});

test('a stale concurrent queue edit is rejected visibly instead of overwriting another controller', async ({ page, context, sharedSession }) => {
  sharedSession.snapshot = { revision: 7, state: state() };
  await install(page);
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Pause Sonos', exact: true })).toBeEnabled();
  const other = await context.newPage();
  await install(other);
  await other.goto('/');
  await expect(other.getByRole('button', { name: 'Pause Sonos', exact: true })).toBeEnabled();
  let release!: () => void;
  let arrived!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const waiting = new Promise<void>(resolve => { arrived = resolve; });
  await page.route('**/api/playback-session', async route => {
    if (route.request().method() === 'POST') { arrived(); await gate; }
    await route.fallback();
  });
  await page.evaluate(async () => {
    const path = '/src/hooks/useQueue.ts';
    const { useQueueStore } = await import(path);
    useQueueStore.getState().removeFromManualQueue(0);
  });
  await waiting;
  await other.evaluate(async () => {
    const path = '/src/hooks/useQueue.ts';
    const { useQueueStore } = await import(path);
    useQueueStore.getState().removeFromManualQueue(1);
  });
  await expect.poll(() => sharedSession.snapshot.revision).toBe(8);
  release();
  await expect(page.getByRole('alert').filter({ hasText: 'Playback changed on another screen' })).toBeVisible();
  expect(await queueState(page)).toEqual({ ids: ['copy-a'], songs: [secondId], context: 'Housewarming' });
  expect((sharedSession.snapshot.state as SharedPlaybackState).queue.manualQueue).toEqual([{ id: 'copy-a', itemId: secondId }]);
});

test('waking refreshes the shared queue before accepting edits', async ({ page, sharedSession }) => {
  sharedSession.snapshot = { revision: 7, state: state() };
  const requests = await install(page);
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Pause Sonos', exact: true })).toBeEnabled();
  const advanced = state();
  advanced.queue.manualQueue = [{ id: 'copy-b', itemId: secondId }];
  sharedSession.snapshot = { revision: 8, state: advanced };
  let release!: () => void;
  let arrived!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const waiting = new Promise<void>(resolve => { arrived = resolve; });
  await page.route('**/api/playback-session', async route => {
    if (route.request().method() === 'GET') { arrived(); await gate; }
    await route.fallback();
  });
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await waiting;
  await page.evaluate(async () => {
    const path = '/src/hooks/useQueue.ts';
    const { useQueueStore } = await import(path);
    useQueueStore.getState().clearManualQueue();
  });
  expect((await queueState(page)).ids).toEqual(['copy-a', 'copy-b']);
  release();
  await expect.poll(() => queueState(page)).toEqual({ ids: ['copy-b'], songs: [secondId], context: 'Housewarming' });
  expect(requests).toEqual([]);
  expect(sharedSession.requests.filter(request => request.method === 'POST')).toEqual([]);
});

test('a fresh observer transfers the shared browser position to Sonos instead of its silent audio element position', async ({ page, sharedSession }) => {
  const saved = state();
  saved.target = { kind: 'browser', ownerId: 'desktop-screen' };
  sharedSession.snapshot = { revision: 7, state: saved };
  await page.setViewportSize({ width: 390, height: 844 });
  const requests = await install(page);
  await page.route('**/api/sonos/status', route => route.fulfill({ json: { configured: true, connected: true } }));
  await page.route('**/api/sonos/households', route => route.fulfill({ json: { households: [{ id: 'household' }] } }));
  await page.route('**/api/sonos/households/household/groups', route => route.fulfill({ json: {
    groups: [{ id: 'living-room', name: 'Living room', playerIds: [] }], players: [],
  } }));
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Choose playback output' })).toBeVisible();
  await page.getByRole('button', { name: 'Choose playback output' }).click();
  await page.getByRole('dialog', { name: 'Sonos' }).getByRole('button', { name: 'Use this group' }).click();
  await expect.poll(() => requests.filter(request => request.path === '/api/sonos/play').length).toBe(1);
  expect(requests.find(request => request.path === '/api/sonos/play')?.body).toMatchObject({
    startItemId: firstId, positionMillis: 42_000, playOnCompletion: false,
  });
});
