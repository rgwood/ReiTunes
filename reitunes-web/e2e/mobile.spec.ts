import { expect, type Page } from './fixtures/test';
import { test, SonosSimulator, trackId } from './fixtures/sonos';
import type { LibraryItem, Playlist } from '../src/types';

const items: LibraryItem[] = [
  { id: trackId, name: 'Northern Sky', artist: 'Nick Drake', album: 'Bryter Layter', duration_seconds: 225,
    created_time_utc: '2026-09-01T00:00:00', file_path: 'Northern Sky.mp3', url: '/audio/song.mp3', track_number: 10, play_count: 3, is_favorite: true, bookmarks: {} },
  { id: '22222222-2222-4222-8222-222222222222', name: 'Chemtrails', artist: 'Beck', album: 'Modern Guilt', duration_seconds: 280,
    created_time_utc: '2026-09-01T00:00:00', file_path: 'Chemtrails.mp3', url: '/audio/beck.mp3', track_number: 3, play_count: 1, bookmarks: {} },
  { id: '33333333-3333-4333-8333-333333333333', name: 'Cosmia', artist: 'Joanna Newsom', album: 'Ys', duration_seconds: 436,
    created_time_utc: '2026-09-01T00:00:00', file_path: 'Cosmia.mp3', url: '/audio/cosmia.mp3', track_number: 5, play_count: 0, bookmarks: {} },
];
const playlists: Playlist[] = [{ id: 'housewarming', name: 'Housewarming', items: {
  a: { library_item_id: items[0].id, position: 0 }, b: { library_item_id: items[1].id, position: 1 },
} }];

async function installMobile(page: Page) {
  const sonos = new SonosSimulator(page);
  sonos.paused = true;
  await sonos.install();
  // A first visit must attach from the shared session, without a local output or queue.
  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem('reitunes-theme', JSON.stringify({ lightTheme: 'neutral', darkTheme: 'forest-palace', mode: 'dark' }));
  });
  await page.route('**/api/items', route => route.fulfill({ json: items }));
  await page.route('**/api/playlists', route => route.fulfill({ json: playlists }));
  await page.route('**/api/tags', route => route.fulfill({ json: { enabled: false, items: {} } }));
  await page.route('**/api/sonos/status', route => route.fulfill({ json: { configured: true, connected: true } }));
  await page.route('**/api/sonos/groups/group-1/queue', route => route.fulfill({ status: 204 }));
  await page.route('**/api/items/*/file-info', route => route.fulfill({ json: {
    file_path: items[1].file_path, size_bytes: 4_000_000, format: 'MP3', codec: 'MP3', bitrate_kbps: 192,
    duration_seconds: 280, sample_rate_hz: 44100, channels: 2, bit_depth: null, error: null,
  } }));
  return sonos;
}

function snapshot() {
  return { revision: 8, state: {
    target: { kind: 'sonos', householdId: 'household', groupId: 'group-1', groupName: 'Kitchen', playerNames: ['Kitchen'] },
    currentItemId: trackId, position: 50, playbackRange: null,
    queue: { manualQueue: [], contextItemIds: items.map(item => item.id), contextIndex: 0,
      contextName: 'Housewarming', shuffleEnabled: false, shuffledIds: [], repeatMode: 'off' },
  } };
}

async function nav(page: Page, name: 'Playing' | 'Queue' | 'Browse') {
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name, exact: true }).click();
}

for (const width of [320, 390]) {
  test(`mobile ${width} joins Sonos and keeps its audio element through navigation and resizing`, async ({ page, sharedSession }, testInfo) => {
    sharedSession.snapshot = snapshot();
    await page.setViewportSize({ width, height: 844 });
    const sonos = await installMobile(page);
    await page.goto('/');
    await expect(page.locator('.mobile-playing-track h2')).toHaveText('Northern Sky');
    await expect(page.getByRole('button', { name: 'Play Sonos', exact: true })).toBeEnabled();
    expect(sonos.queueRequests).toHaveLength(0);
    expect(sonos.commands).toEqual([]);
    await page.evaluate(() => { (window as Window & { mobileAudio?: Element }).mobileAudio = document.querySelector('audio')!; });
    await page.screenshot({ path: testInfo.outputPath(`playing-${width}.png`), fullPage: true });
    await nav(page, 'Browse');
    await expect(page.getByRole('button', { name: 'Play Chemtrails', exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`browse-${width}.png`), fullPage: true });
    await nav(page, 'Queue');
    await expect(page.getByRole('region', { name: 'Up Next', exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`queue-${width}.png`), fullPage: true });
    await nav(page, 'Playing');
    await page.setViewportSize({ width: 1280, height: 844 });
    await expect(page.locator('.source-sidebar')).toBeVisible();
    await page.setViewportSize({ width, height: 844 });
    expect(await page.evaluate(() => document.querySelector('audio') === (window as Window & { mobileAudio?: Element }).mobileAudio)).toBe(true);
    expect(await page.locator('audio').count()).toBe(1);
    expect(sonos.paused).toBe(true);
    expect(sonos.queueRequests).toHaveLength(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    const smallControls = await page.locator('.mobile-player button, .mobile-bottom-nav button').evaluateAll(buttons => buttons
      .filter(button => button.getBoundingClientRect().width > 0)
      .filter(button => button.getBoundingClientRect().width < 44 || button.getBoundingClientRect().height < 44)
      .map(button => button.getAttribute('aria-label') || button.textContent));
    expect(smallControls).toEqual([]);
  });
}

test('mobile song actions and touch queue controls update the shared queue without restarting Sonos', async ({ page, sharedSession }) => {
  sharedSession.snapshot = snapshot();
  await page.setViewportSize({ width: 390, height: 844 });
  const sonos = await installMobile(page);
  await page.goto('/#browse/library');
  await page.getByRole('button', { name: 'Actions for Chemtrails', exact: true }).click();
  await page.getByRole('button', { name: 'Play next', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Chemtrails will play next');
  await page.getByRole('button', { name: 'Actions for Cosmia', exact: true }).click();
  await page.getByRole('button', { name: 'Add to queue', exact: true }).click();
  await nav(page, 'Queue');
  const added = page.getByRole('region', { name: 'Added to queue', exact: true });
  await expect(added.locator('.queue-track-text > span')).toHaveText(['Chemtrails', 'Cosmia']);
  const moveUp = added.getByRole('button', { name: 'Move Cosmia up', exact: true });
  const box = await moveUp.boundingBox();
  expect(box!.width).toBeGreaterThanOrEqual(44);
  expect(box!.height).toBeGreaterThanOrEqual(44);
  await moveUp.click();
  await expect(added.locator('.queue-track-text > span')).toHaveText(['Cosmia', 'Chemtrails']);
  await added.getByRole('button', { name: 'Remove Chemtrails from queue', exact: true }).click();
  await expect(added.locator('.queue-track-text > span')).toHaveText(['Cosmia']);
  expect(sonos.queueRequests).toHaveLength(0);
  expect(sonos.paused).toBe(true);
  await expect.poll(() => (sharedSession.snapshot.state as ReturnType<typeof snapshot>['state']).queue.manualQueue.length).toBe(1);
});

test('mobile search, song info, playlists and browser Back remain usable', async ({ page, sharedSession }) => {
  sharedSession.snapshot = snapshot();
  await page.setViewportSize({ width: 390, height: 844 });
  await installMobile(page);
  await page.goto('/#browse/library');
  await page.getByRole('searchbox', { name: 'Search library', exact: true }).fill('beck');
  await expect(page.locator('.mobile-song-list > li')).toHaveCount(1);
  await page.getByRole('button', { name: 'Actions for Chemtrails', exact: true }).click();
  await page.getByRole('button', { name: 'Song info', exact: true }).click();
  const info = page.getByRole('dialog', { name: 'Song info', exact: true });
  await expect(info.getByText('Chemtrails.mp3', { exact: true })).toBeVisible();
  await expect(info.getByText('192 kbps (average)', { exact: true })).toBeVisible();
  await info.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Clear search', exact: true }).click();
  await page.getByRole('navigation', { name: 'Browse collections' }).getByRole('button', { name: 'Playlists', exact: true }).click();
  await page.getByRole('button', { name: 'Housewarming 2 songs', exact: true }).click();
  await expect(page.locator('.mobile-song-list > li')).toHaveCount(2);
  await expect(page).toHaveURL(/#browse\/playlist\/housewarming$/);
  await page.goBack();
  await expect(page.getByRole('button', { name: 'Housewarming 2 songs', exact: true })).toBeVisible();
  await page.getByRole('navigation', { name: 'Browse collections' }).getByRole('button', { name: 'Discover', exact: true }).click();
  await expect(page.getByRole('searchbox', { name: 'Search discovery', exact: true })).toBeVisible();
});

test('mobile install metadata uses a standalone manifest and a real touch icon', async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installMobile(page);
  await page.goto('/');
  const manifest = await (await request.get('/manifest.webmanifest')).json();
  expect(manifest.display).toBe('standalone');
  expect(manifest.start_url).toBe('/#playing');
  await expect(page.locator('meta[name="viewport"]')).toHaveAttribute('content', /viewport-fit=cover/);
  const icon = await request.get('/apple-touch-icon.png');
  expect(icon.status()).toBe(200);
  expect(icon.headers()['content-type']).toContain('image/png');
});

test('mobile song menu changes favourites and adds to regular playlists', async ({ page, sharedSession }) => {
  sharedSession.snapshot = snapshot();
  await page.setViewportSize({ width: 390, height: 844 });
  await installMobile(page);
  const writes: string[] = [];
  await page.route('**/ui/*/favorite', route => { writes.push(route.request().url()); return route.fulfill({ status: 204 }); });
  await page.route('**/ui/*/unfavorite', route => { writes.push(route.request().url()); return route.fulfill({ status: 204 }); });
  let added: unknown;
  await page.route('**/api/playlists/housewarming/items', route => { added = route.request().postDataJSON(); return route.fulfill({ status: 204 }); });
  await page.goto('/#browse/library');
  await page.getByRole('button', { name: 'Actions for Northern Sky', exact: true }).click();
  await page.getByRole('button', { name: 'Remove favourite', exact: true }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toContain(`/ui/${items[0].id}/unfavorite`);
  await page.getByRole('button', { name: 'Actions for Cosmia', exact: true }).click();
  await page.getByRole('button', { name: 'Favourite', exact: true }).click();
  await expect.poll(() => writes.length).toBe(2);
  expect(writes[1]).toContain(`/ui/${items[2].id}/favorite`);
  await page.getByRole('button', { name: 'Actions for Cosmia', exact: true }).click();
  await page.getByRole('button', { name: 'Add to playlist…', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Housewarming', exact: true }).click();
  await expect.poll(() => added).toEqual({ library_item_ids: [items[2].id] });
  await expect(page.getByRole('status')).toContainText('Added to Housewarming');
});

test('mobile can delete regular and smart playlists without deleting songs', async ({ page, sharedSession }) => {
  sharedSession.snapshot = snapshot();
  await page.setViewportSize({ width: 320, height: 844 });
  await installMobile(page);
  let saved: Playlist[] = [...playlists, { id: 'short-songs', name: 'Short songs', items: {}, smart_rules: {
    added_within_days: null, play_state: 'any', favourites_only: false,
    expression: { type: 'duration', comparison: 'lt', seconds: 300 },
  } }];
  await page.route('**/api/playlists', route => route.fulfill({ json: saved }));
  const deleted: string[] = [];
  await page.route('**/api/playlists/*', route => {
    expect(route.request().method()).toBe('DELETE');
    const id = new URL(route.request().url()).pathname.split('/').at(-1)!;
    deleted.push(id); saved = saved.filter(playlist => playlist.id !== id);
    return route.fulfill({ status: 204 });
  });
  await page.goto('/#browse/playlists');
  await page.getByRole('button', { name: 'Housewarming 2 songs', exact: true }).click();
  page.once('dialog', dialog => dialog.dismiss());
  await page.getByRole('button', { name: 'Delete playlist', exact: true }).click();
  expect(deleted).toEqual([]);
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Delete playlist', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Short songs 2 songs · Smart playlist', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Short songs 2 songs · Smart playlist', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Edit rules', exact: true })).toBeVisible();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Delete playlist', exact: true }).click();
  await expect(page.getByText('No playlists yet. Create one to collect your songs.')).toBeVisible();
  expect(deleted).toEqual(['housewarming', 'short-songs']);
  await page.getByRole('navigation', { name: 'Browse collections' }).getByRole('button', { name: 'Library', exact: true }).click();
  await expect(page.locator('.mobile-song-list > li')).toHaveCount(3);
});
