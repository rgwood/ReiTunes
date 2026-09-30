import { expect, test, type Page } from './fixtures/test';
import type { SharedPlaybackState } from '../src/stores/sharedSessionStore';
import type { LibraryItem, Playlist } from '../src/types';

const tracks: LibraryItem[] = ['Chemtrails', 'Cosmia', 'Zulu', 'Delta', 'Bravo', 'Echo', 'Alpha'].map((name, index) => ({
  id: `11111111-1111-4111-8111-11111111111${index}`, name,
  artist: ['Zulu', 'Delta', 'Echo', 'Alpha'].includes(name) ? 'Visible artist' : 'Other artist',
  album: 'Queue edits', track_number: index + 1, created_time_utc: '2026-01-01T00:00:00',
  file_path: `${index}.mp3`, url: `/audio/${index}.mp3`, play_count: 0, bookmarks: {}, duration_seconds: 280,
  is_favorite: name === 'Alpha',
}));
const ids = (...names: string[]) => names.map(name => tracks.find(track => track.name === name)!.id);
const playlistIds = ids('Delta', 'Chemtrails', 'Alpha', 'Echo');
const playlist: Playlist = { id: 'evening', name: 'Evening songs', items: Object.fromEntries(playlistIds.map((id, position) => [id, {
  library_item_id: id, position,
}])) };

function initialState(): SharedPlaybackState {
  return {
    target: { kind: 'sonos', householdId: 'household', groupId: 'living-room', groupName: 'Living room', playerNames: ['Living room'] },
    currentItemId: ids('Chemtrails')[0], position: 42, playbackRange: null,
    queue: {
      manualQueue: ids('Cosmia', 'Cosmia').map((itemId, index) => ({ id: `copy-${index}`, itemId })),
      contextItemIds: ids('Chemtrails', 'Cosmia', 'Zulu'), contextIndex: 0, contextName: 'Housewarming',
      shuffleEnabled: false, shuffledIds: [], repeatMode: 'off',
    },
  };
}

async function install(page: Page) {
  const commands: string[] = [];
  await page.route('**/api/items', route => route.fulfill({ json: tracks }));
  await page.route('**/api/items/*/duration', route => route.fulfill({ status: 204 }));
  await page.route('**/api/playlists', route => route.fulfill({ json: [playlist] }));
  await page.route('**/api/tags', route => route.fulfill({ json: { enabled: false, items: {} } }));
  await page.route('**/api/discovery', route => route.fulfill({ json: { sources: [], entries: [] } }));
  await page.route('**/api/log', route => route.fulfill({ status: 200 }));
  await page.route('**/ui/play', route => { commands.push('/ui/play'); return route.fulfill({ status: 200 }); });
  await page.route('**/audio/*.mp3', route => route.fulfill({ contentType: 'audio/mpeg', body: '' }));
  await page.routeWebSocket('**/updates', () => {});
  await page.route('**/api/sonos/**', route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() !== 'GET') { commands.push(path); return route.fulfill({ status: 204 }); }
    if (path.endsWith('/volume')) return route.fulfill({ json: { volume: 35, muted: false, fixed: false } });
    return route.fulfill({ json: {
      playbackState: 'PLAYBACK_STATE_PLAYING', positionMillis: 42_000, itemId: 'current-occurrence',
      queueVersion: 'cloud-v1', sourceItemId: ids('Chemtrails')[0], reitunesSessionActive: true,
      availablePlaybackActions: { canPause: true },
    } });
  });
  return commands;
}

const panel = (page: Page) => page.getByRole('region', { name: 'Up Next', exact: true });
const added = (page: Page) => panel(page).getByRole('region', { name: 'Added to queue', exact: true });
const automatic = (page: Page, name = 'Housewarming') => panel(page).getByRole('region', { name: `From ${name}`, exact: true });
const songNames = (section: ReturnType<typeof panel>) => section.locator('.queue-row .queue-track-text > span');
const visibleIds = (page: Page) => page.locator('tbody tr[data-item-id]').evaluateAll(rows => rows.map(row => row.getAttribute('data-item-id')!));

async function openQueue(page: Page) {
  await expect(page.getByRole('button', { name: 'Pause Sonos', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Queue', exact: true }).click();
  await expect(panel(page)).toBeVisible();
}

test('Use current view snapshots the playlist without restarting Sonos or changing manual occurrences', async ({ page, sharedSession }, testInfo) => {
  sharedSession.snapshot = { revision: 7, state: initialState() };
  await page.setViewportSize({ width: 1440, height: 900 });
  const commands = await install(page);
  await page.goto('/');
  await openQueue(page);
  await page.getByRole('button', { name: playlist.name, exact: true }).click();
  await expect(page.locator('tbody tr[data-item-id]')).toHaveCount(4);
  const expected = (await visibleIds(page)).filter(id => id !== ids('Chemtrails')[0]);
  // Browsing alone must not replace the automatic continuation.
  expect(sharedSession.snapshot.revision).toBe(7);
  await panel(page).getByRole('button', { name: 'Use current view', exact: true }).click();
  await expect.poll(() => (sharedSession.snapshot.state as SharedPlaybackState).queue.contextItemIds).toEqual(expected);
  expect(sharedSession.snapshot.state).toMatchObject({
    currentItemId: ids('Chemtrails')[0], position: 42, target: initialState().target,
    queue: { manualQueue: initialState().queue.manualQueue, contextIndex: -1, contextName: playlist.name },
  });
  await expect(songNames(automatic(page, playlist.name))).toHaveText(expected.map(id => tracks.find(track => track.id === id)!.name));
  await expect(songNames(added(page))).toHaveText(['Cosmia', 'Cosmia']);
  await page.screenshot({ path: testInfo.outputPath('playlist-replaces-automatic-queue.png') });
  await page.getByRole('searchbox', { name: 'Search library', exact: true }).fill('Alpha');
  await expect(page.locator('tbody tr[data-item-id]')).toHaveCount(1);
  expect((sharedSession.snapshot.state as SharedPlaybackState).queue.contextItemIds).toEqual(expected);
  expect(commands).toEqual([]);
});

test('Use current view captures filtered rows in their current sort order', async ({ page, sharedSession }) => {
  sharedSession.snapshot = { revision: 7, state: initialState() };
  await install(page);
  await page.goto('/');
  await openQueue(page);
  await page.getByRole('searchbox', { name: 'Search library', exact: true }).fill('Visible artist');
  await expect(page.locator('tbody tr[data-item-id]')).toHaveCount(4);
  await page.locator('th[data-column=name] button').click();
  await expect(page.locator('tbody tr[data-item-id] [data-column=name]')).toHaveText(['Alpha', 'Delta', 'Echo', 'Zulu']);
  await page.locator('th[data-column=name] button').click();
  await expect(page.locator('tbody tr[data-item-id] [data-column=name]')).toHaveText(['Zulu', 'Echo', 'Delta', 'Alpha']);
  await panel(page).getByRole('button', { name: 'Use current view', exact: true }).click();
  await expect.poll(() => (sharedSession.snapshot.state as SharedPlaybackState).queue.contextItemIds).toEqual(ids('Zulu', 'Echo', 'Delta', 'Alpha'));
  expect((sharedSession.snapshot.state as SharedPlaybackState).queue.contextName).toContain('Visible artist');
  expect((sharedSession.snapshot.state as SharedPlaybackState).queue.manualQueue).toEqual(initialState().queue.manualQueue);
  expect((sharedSession.snapshot.state as SharedPlaybackState).currentItemId).toBe(ids('Chemtrails')[0]);
});

test('removing a duplicate affects only that manual occurrence and Undo restores its position', async ({ page, sharedSession }) => {
  sharedSession.snapshot = { revision: 7, state: initialState() };
  await install(page);
  await page.goto('/');
  await openQueue(page);
  await added(page).getByRole('button', { name: 'Remove Cosmia from Up Next', exact: true }).nth(1).click();
  await expect.poll(() => (sharedSession.snapshot.state as SharedPlaybackState).queue.manualQueue).toEqual([initialState().queue.manualQueue[0]]);
  await expect(songNames(automatic(page))).toHaveText(['Cosmia', 'Zulu']);
  await panel(page).getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(() => (sharedSession.snapshot.state as SharedPlaybackState).queue.manualQueue).toEqual(initialState().queue.manualQueue);
  await expect(songNames(added(page))).toHaveText(['Cosmia', 'Cosmia']);
});

test('an automatic removal can be undone and stays removed after refresh', async ({ page, sharedSession }) => {
  sharedSession.snapshot = { revision: 7, state: initialState() };
  const commands = await install(page);
  await page.goto('/');
  await openQueue(page);
  await automatic(page).getByRole('button', { name: 'Remove Cosmia from Up Next', exact: true }).click();
  await expect.poll(() => (sharedSession.snapshot.state as SharedPlaybackState).queue.contextItemIds).toEqual(ids('Chemtrails', 'Zulu'));
  await expect(songNames(added(page))).toHaveText(['Cosmia', 'Cosmia']);
  await panel(page).getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(() => (sharedSession.snapshot.state as SharedPlaybackState).queue.contextItemIds).toEqual(initialState().queue.contextItemIds);
  await expect(songNames(automatic(page))).toHaveText(['Cosmia', 'Zulu']);
  await automatic(page).getByRole('button', { name: 'Remove Cosmia from Up Next', exact: true }).click();
  await expect.poll(() => (sharedSession.snapshot.state as SharedPlaybackState).queue.contextItemIds).toEqual(ids('Chemtrails', 'Zulu'));
  await page.reload();
  await openQueue(page);
  await expect(songNames(automatic(page))).toHaveText(['Zulu']);
  await expect(songNames(added(page))).toHaveText(['Cosmia', 'Cosmia']);
  expect((sharedSession.snapshot.state as SharedPlaybackState).currentItemId).toBe(ids('Chemtrails')[0]);
  expect(commands).toEqual([]);
});

test('another controller sees the new source before it starts and can remove a future automatic song', async ({ page, browser, sharedSession }) => {
  sharedSession.snapshot = { revision: 7, state: initialState() };
  const commands = await install(page);
  await page.goto('/');
  await openQueue(page);
  const phoneContext = await browser.newContext({ baseURL: new URL(page.url()).origin, viewport: { width: 390, height: 844 } });
  try {
    await sharedSession.install(phoneContext);
    const phone = await phoneContext.newPage();
    const phoneCommands = await install(phone);
    await phone.goto('/#queue');
    await expect(songNames(automatic(phone))).toHaveText(['Cosmia', 'Zulu']);
    await page.getByRole('button', { name: playlist.name, exact: true }).click();
    await expect(page.locator('tbody tr[data-item-id]')).toHaveCount(4);
    await panel(page).getByRole('button', { name: 'Use current view', exact: true }).click();
    await expect(songNames(automatic(phone, playlist.name))).toHaveCount(3);
    await expect(songNames(added(phone))).toHaveText(['Cosmia', 'Cosmia']);
    await expect(phone.getByRole('button', { name: 'Open now playing', exact: true })).toContainText('Chemtrails');
    await automatic(phone, playlist.name).getByRole('button', { name: 'Remove Delta from Up Next', exact: true }).click();
    await expect(songNames(automatic(page, playlist.name))).not.toContainText(['Delta']);
    await expect(panel(page).getByRole('button', { name: 'Undo', exact: true })).toHaveCount(0);
    await expect.poll(() => (sharedSession.snapshot.state as SharedPlaybackState).queue.contextItemIds.length).toBe(2);
    const saved = sharedSession.snapshot.state as SharedPlaybackState;
    expect(saved.queue.contextItemIds).not.toContain(ids('Delta')[0]);
    expect(saved.queue.contextIndex).toBe(-1);
    expect(saved.queue.manualQueue).toEqual(initialState().queue.manualQueue);
    expect(saved.currentItemId).toBe(ids('Chemtrails')[0]);
    expect(saved.position).toBe(42);
    expect(commands).toEqual([]);
    expect(phoneCommands).toEqual([]);
  } finally { await phoneContext.close(); }
});

test('Undo restores only the replaced source after a newer manual addition has been saved', async ({ page, sharedSession }) => {
  sharedSession.snapshot = { revision: 7, state: initialState() };
  await install(page);
  await page.goto('/');
  await openQueue(page);
  await page.getByRole('button', { name: playlist.name, exact: true }).click();
  await expect(page.locator('tbody tr[data-item-id]')).toHaveCount(4);
  await panel(page).getByRole('button', { name: 'Use current view', exact: true }).click();
  await expect.poll(() => (sharedSession.snapshot.state as SharedPlaybackState).queue.contextName).toBe(playlist.name);
  await page.locator(`tr[data-item-id="${ids('Delta')[0]}"] [data-column=name]`).click({ button: 'right' });
  await page.getByText(/Add to Queue$/).click();
  await expect.poll(() => (sharedSession.snapshot.state as SharedPlaybackState).queue.manualQueue.length).toBe(3);
  const manual = structuredClone((sharedSession.snapshot.state as SharedPlaybackState).queue.manualQueue);
  await panel(page).getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(() => (sharedSession.snapshot.state as SharedPlaybackState).queue.contextItemIds).toEqual(initialState().queue.contextItemIds);
  expect(sharedSession.snapshot.state).toMatchObject({
    currentItemId: ids('Chemtrails')[0], position: 42,
    queue: { manualQueue: manual, contextIndex: 0, contextName: 'Housewarming' },
  });
  await expect(songNames(added(page))).toHaveText(['Cosmia', 'Cosmia', 'Delta']);
  await expect(songNames(automatic(page))).toHaveText(['Cosmia', 'Zulu']);
});

test('browser audio keeps playing and drains manual duplicates before the new automatic source', async ({ page, sharedSession }) => {
  await page.addInitScript(() => {
    const paused = new WeakMap<HTMLMediaElement, boolean>();
    const times = new WeakMap<HTMLMediaElement, number>();
    Object.defineProperty(HTMLMediaElement.prototype, 'paused', { get() { return paused.get(this) ?? true; } });
    Object.defineProperty(HTMLMediaElement.prototype, 'readyState', { get() { return 4; } });
    Object.defineProperty(HTMLMediaElement.prototype, 'duration', { get() { return 280; } });
    Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', { get() { return times.get(this) ?? 0; }, set(value) { times.set(this, value); } });
    HTMLMediaElement.prototype.play = function () {
      paused.set(this, false); this.dispatchEvent(new Event('loadedmetadata')); this.dispatchEvent(new Event('play')); return Promise.resolve();
    };
    HTMLMediaElement.prototype.pause = function () { paused.set(this, true); this.dispatchEvent(new Event('pause')); };
  });
  await install(page);
  await page.goto('/');
  await page.locator(`tr[data-item-id="${ids('Chemtrails')[0]}"] [data-column=name]`).dblclick();
  await expect.poll(() => (sharedSession.snapshot.state as SharedPlaybackState)?.currentItemId).toBe(ids('Chemtrails')[0]);
  for (let index = 0; index < 2; index++) {
    await page.locator(`tr[data-item-id="${ids('Cosmia')[0]}"] [data-column=name]`).click({ button: 'right' });
    await page.getByText(/Add to Queue$/).click();
  }
  await expect.poll(() => (sharedSession.snapshot.state as SharedPlaybackState).queue.manualQueue.length).toBe(2);
  const manual = structuredClone((sharedSession.snapshot.state as SharedPlaybackState).queue.manualQueue);
  await page.evaluate(() => { const audio = document.querySelector('audio')!; audio.currentTime = 42; audio.dispatchEvent(new Event('timeupdate')); });
  await page.getByRole('button', { name: 'Queue', exact: true }).click();
  await page.getByRole('button', { name: playlist.name, exact: true }).click();
  await expect(page.locator('tbody tr[data-item-id]')).toHaveCount(4);
  await panel(page).getByRole('button', { name: 'Use current view', exact: true }).click();
  await expect.poll(() => (sharedSession.snapshot.state as SharedPlaybackState).queue.contextIndex).toBe(-1);
  expect((sharedSession.snapshot.state as SharedPlaybackState).queue.manualQueue).toEqual(manual);
  expect(await page.evaluate(() => ({ paused: document.querySelector('audio')!.paused, position: document.querySelector('audio')!.currentTime })))
    .toEqual({ paused: false, position: 42 });
  for (const remaining of [1, 0]) {
    await page.evaluate(() => document.querySelector('audio')!.dispatchEvent(new Event('ended')));
    await expect.poll(() => (sharedSession.snapshot.state as SharedPlaybackState).queue.manualQueue.length).toBe(remaining);
    expect((sharedSession.snapshot.state as SharedPlaybackState).currentItemId).toBe(ids('Cosmia')[0]);
    expect((sharedSession.snapshot.state as SharedPlaybackState).queue.contextIndex).toBe(-1);
  }
  await page.evaluate(() => document.querySelector('audio')!.dispatchEvent(new Event('ended')));
  await expect.poll(() => (sharedSession.snapshot.state as SharedPlaybackState).currentItemId).toBe(ids('Delta')[0]);
  expect((sharedSession.snapshot.state as SharedPlaybackState).queue.contextIndex).toBe(0);
  expect(await page.evaluate(() => document.querySelector('audio')!.paused)).toBe(false);
});

for (const source of ['manual', 'automatic'] as const) {
  test(`a failed ${source} play does not roll back a newer source from another controller`, async ({ page, sharedSession }) => {
    sharedSession.snapshot = { revision: 7, state: initialState() };
    await install(page);
    let release!: () => void;
    let arrived!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const waiting = new Promise<void>(resolve => { arrived = resolve; });
    await page.route('**/api/sonos/play', async route => {
      arrived(); await gate;
      await route.fulfill({ status: 503, json: { error: 'Song request failed' } });
    });
    await page.goto('/');
    await openQueue(page);
    await (source === 'manual' ? added(page) : automatic(page)).getByRole('button', { name: 'Play Cosmia now', exact: true }).first().click();
    await waiting;
    const remote = structuredClone(sharedSession.snapshot.state as SharedPlaybackState);
    remote.currentItemId = ids('Alpha')[0];
    remote.position = 12;
    remote.queue.contextItemIds = ids('Delta', 'Alpha', 'Echo');
    // Match the pending selection's cursor: index equality alone is not enough
    // to prove that rolling back still changes the same automatic source.
    remote.queue.contextIndex = source === 'automatic' ? 1 : 0;
    remote.queue.contextName = 'Another screen';
    remote.queue.contextId = 'another-controller-source';
    sharedSession.snapshot = { revision: sharedSession.snapshot.revision + 1, state: remote };
    await page.evaluate(snapshot => window.dispatchEvent(new CustomEvent('reitunes:playback-session', { detail: snapshot })), sharedSession.snapshot);
    const failed = page.waitForResponse(response => response.url().endsWith('/api/sonos/play') && response.status() === 503);
    release();
    await failed;
    await expect(automatic(page, 'Another screen').getByRole('button', { name: 'Remove Echo from Up Next', exact: true })).toBeEnabled();
    await expect(songNames(automatic(page, 'Another screen'))).toHaveText(source === 'automatic' ? ['Echo'] : ['Alpha', 'Echo']);
    await expect(songNames(added(page))).toHaveText(source === 'automatic' ? ['Cosmia', 'Cosmia'] : ['Cosmia']);
    expect(sharedSession.snapshot.state).toEqual(remote);
  });
}
