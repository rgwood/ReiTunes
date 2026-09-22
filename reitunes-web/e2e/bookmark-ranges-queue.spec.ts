import { expect, test, type Page } from '@playwright/test';
import type { LibraryItem } from '../src/types';
import { SonosSimulator, trackId } from './fixtures/sonos';

async function setup(page: Page) {
  const items: LibraryItem[] = ['Long evening mix', 'Northern Sky', 'Pink Moon'].map((name, index) => ({
    id: `track-${index}`, name, artist: index ? 'Nick Drake' : 'Four Tet', album: 'Live recordings',
    track_number: null, created_time_utc: `2026-09-2${3 - index}T00:00:00`, file_path: `${index}.mp3`, url: `/audio/${index}.mp3`, play_count: 0,
    bookmarks: index ? {} : {
      first: { position: 70, end_position: 120, emoji: '🎹', label: 'Piano entrance', created_time_utc: '2026-09-22T00:00:00' },
      second: { position: 180, end_position: 240, emoji: '🎸', label: 'Good guitar track', created_time_utc: '2026-09-21T00:00:00' },
    },
  }));
  const writes: Record<string, unknown>[] = [];
  await page.addInitScript(() => {
    localStorage.setItem('reitunes-theme', JSON.stringify({ lightTheme: 'neutral', darkTheme: 'forest-palace', mode: 'dark' }));
    const times = new WeakMap<HTMLMediaElement, number>();
    const paused = new WeakMap<HTMLMediaElement, boolean>();
    Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', { get() { return times.get(this) ?? 0; }, set(value: number) { times.set(this, value); } });
    Object.defineProperty(HTMLMediaElement.prototype, 'duration', { get() { return 3600; } });
    Object.defineProperty(HTMLMediaElement.prototype, 'readyState', { get() { return 4; } });
    Object.defineProperty(HTMLMediaElement.prototype, 'paused', { get() { return paused.get(this) ?? true; } });
    HTMLMediaElement.prototype.play = function () { paused.set(this, false); this.dispatchEvent(new Event('loadedmetadata')); this.dispatchEvent(new Event('play')); return Promise.resolve(); };
    HTMLMediaElement.prototype.pause = function () { paused.set(this, true); this.dispatchEvent(new Event('pause')); };
  });
  await page.route('**/api/items', route => route.fulfill({ json: items }));
  await page.route('**/api/playlists', route => route.fulfill({ json: [] }));
  await page.route('**/api/tags', route => route.fulfill({ json: { enabled: false, items: {} } }));
  await page.route('**/api/discovery', route => route.fulfill({ json: { sources: [], entries: [], refreshing: false } }));
  await page.route('**/api/sonos/status', route => route.fulfill({ json: { configured: false, connected: false } }));
  await page.route('**/api/log', route => route.fulfill({ status: 200 }));
  await page.route('**/ui/play', route => route.fulfill({ status: 200 }));
  await page.route('**/audio/*', route => route.fulfill({ contentType: 'audio/mpeg', body: '' }));
  await page.routeWebSocket('**/updates', () => {});
  await page.route('**/ui/track-0/bookmarks/*', route => {
    const body = route.request().postDataJSON(); writes.push(body);
    Object.assign(items[0].bookmarks[new URL(route.request().url()).pathname.split('/').at(-1)!], body);
    return route.fulfill({ status: 200 });
  });
  await page.goto('/');
  await expect(page.locator('tbody tr')).toHaveCount(3);
  return { items, writes };
}
const player = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('reitunes-player') || '{"state":{}}').state);
const queue = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('reitunes-queue')!).state);
async function bookmarkView(page: Page) { await page.getByRole('navigation', { name: 'Music library', exact: true }).getByRole('button', { name: 'Bookmarks', exact: true }).click(); }
async function time(page: Page, position: number) {
  await page.locator('audio').evaluate((audio: HTMLAudioElement, position) => { audio.currentTime = position; audio.dispatchEvent(new Event('timeupdate')); }, position);
}

test('bookmark grid selects without playing, sorts, and edits start/end without losing precision', async ({ page }, testInfo) => {
  const { writes } = await setup(page); await bookmarkView(page);
  const table = page.getByRole('table', { name: 'Bookmarks' });
  await expect(table.getByRole('columnheader', { name: 'End', exact: true })).toBeVisible();
  const row = table.locator('tr[data-bookmark-id=first]');
  expect((await row.boundingBox())!.height).toBe(24);
  await row.getByText('Piano entrance').click();
  await expect(row).toHaveAttribute('aria-selected', 'true');
  expect((await player(page))?.currentItemId ?? null).toBeNull();
  await table.getByRole('columnheader', { name: 'Start', exact: true }).getByRole('button').click();
  await table.getByRole('columnheader', { name: /Start/ }).getByRole('button').click();
  await expect(table.locator('tbody tr').first()).toContainText('Good guitar track');
  await row.focus(); await row.press('F2');
  const start = page.getByRole('textbox', { name: 'Bookmark time for Long evening mix', exact: true });
  const end = page.getByRole('textbox', { name: 'Bookmark end time for Long evening mix' });
  await start.fill('1:01.125'); await end.fill('0:30');
  await page.getByRole('button', { name: 'Save bookmark', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('end must be after'); expect(writes).toHaveLength(0);
  await end.fill('1:40.5');
  await page.getByRole('button', { name: 'Move start back 5 seconds' }).click();
  await expect(start).toHaveValue('0:56.125');
  await page.screenshot({ path: testInfo.outputPath('bookmark-grid-and-timing-editor.png'), fullPage: true });
  await page.getByRole('button', { name: 'Save bookmark', exact: true }).click();
  expect(writes).toEqual([{ label: 'Piano entrance', emoji: '🎹', position: 56.125, end_position: 100.5 }]);
  await page.reload(); await bookmarkView(page);
  await page.getByRole('button', { name: 'Edit Piano entrance bookmark for Long evening mix' }).click();
  await expect(end).toHaveValue('1:40.5');
  await page.getByRole('button', { name: 'Clear bookmark end time' }).click();
  await page.getByRole('button', { name: 'Save bookmark', exact: true }).click();
  expect(writes.at(-1)?.end_position).toBeNull();
});

test('bookmark playback skips the unwanted gap, stops after the last range, and previews never skip', async ({ page }) => {
  await setup(page); await bookmarkView(page);
  await page.getByRole('button', { name: 'Play Long evening mix from Piano entrance', exact: true }).click();
  await expect.poll(async () => (await player(page)).resumePosition).toBe(70);
  await time(page, 120.2);
  await expect.poll(async () => (await player(page)).resumePosition).toBe(180);
  await time(page, 240.1);
  await expect.poll(() => page.locator('audio').evaluate((audio: HTMLAudioElement) => audio.paused)).toBe(true);
  expect((await player(page)).resumePosition).toBe(240);
  await time(page, 210);
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await time(page, 240.1);
  await expect.poll(() => page.locator('audio').evaluate((audio: HTMLAudioElement) => audio.paused)).toBe(true);
  await page.getByRole('button', { name: 'Edit Piano entrance bookmark for Long evening mix' }).click();
  await page.getByRole('button', { name: 'Preview end', exact: true }).click();
  await expect.poll(async () => (await player(page)).resumePosition).toBe(115);
  await time(page, 120.1);
  await expect.poll(() => page.locator('audio').evaluate((audio: HTMLAudioElement) => audio.paused)).toBe(true);
  expect((await player(page)).resumePosition).toBe(120);
  await page.getByRole('button', { name: 'Preview start', exact: true }).click();
  await time(page, 82.25);
  await page.getByRole('button', { name: 'Set bookmark start to current playback time' }).click();
  await expect(page.getByRole('textbox', { name: 'Bookmark time for Long evening mix', exact: true })).toHaveValue('1:22.25');
});

test('bookmark editor fits a phone and keeps playback controls reachable', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 }); await setup(page); await bookmarkView(page);
  await page.getByRole('button', { name: 'Edit Piano entrance bookmark for Long evening mix' }).click();
  const editor = page.getByRole('form', { name: 'Edit bookmark for Long evening mix' });
  const bounds = (await editor.boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
  await expect(page.getByRole('button', { name: 'Preview end', exact: true })).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath('bookmark-timing-phone.png'), fullPage: true });
});

test('Up Next plays a clicked track and preserves manually queued entries and duplicates', async ({ page }, testInfo) => {
  const { items } = await setup(page);
  await page.evaluate(items => localStorage.setItem('reitunes-queue', JSON.stringify({ state: {
    manualQueue: [items[1], items[2], items[1]], contextItems: items, contextIndex: 0, contextName: 'All music', shuffleEnabled: false, repeatMode: 'off',
  }, version: 1 })), items);
  await page.reload();
  await page.getByRole('button', { name: 'Queue', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Up Next', exact: true });
  const added = panel.getByRole('region', { name: 'Added to queue' });
  await added.getByRole('button', { name: 'Play Northern Sky now' }).last().click();
  await expect.poll(async () => (await player(page)).currentItemId).toBe(items[1].id);
  expect((await queue(page)).manualQueue.map((item: LibraryItem) => item.id)).toEqual([items[1].id, items[2].id]);
  await panel.getByRole('region', { name: 'From All music' }).getByRole('button', { name: 'Play Pink Moon now' }).click();
  await expect.poll(async () => (await player(page)).currentItemId).toBe(items[2].id);
  expect((await queue(page)).contextIndex).toBe(2);
  expect((await queue(page)).manualQueue).toHaveLength(2);
  await page.screenshot({ path: testInfo.outputPath('up-next-playable.png'), fullPage: true });
  await added.getByRole('button', { name: 'Remove Northern Sky from queue' }).click();
  expect((await queue(page)).manualQueue.map((item: LibraryItem) => item.id)).toEqual([items[2].id]);
  expect((await player(page)).currentItemId).toBe(items[2].id);
});

test('a rejected Sonos queue selection keeps the queued track available to retry', async ({ page }) => {
  const sim = new SonosSimulator(page);
  await sim.install(); sim.queueFails = true;
  await page.goto('/');
  await page.locator('tbody tr').first().click({ button: 'right' });
  await page.getByText('Add to Queue', { exact: false }).click();
  await page.getByRole('button', { name: 'Queue', exact: true }).click();
  const added = page.getByRole('region', { name: 'Added to queue' });
  await added.getByRole('button', { name: 'Play Northern Sky now' }).click();
  await expect(page.getByText('Old queue failed')).toBeVisible();
  await expect(added.getByRole('button', { name: 'Play Northern Sky now' })).toBeEnabled();
  expect((await queue(page)).manualQueue.map((item: LibraryItem) => item.id)).toEqual([trackId]);
});

test('Sonos range playback pauses before advancing and never advances after a rejected pause', async ({ page }) => {
  const sim = new SonosSimulator(page);
  await sim.install();
  await page.route('**/api/items', route => route.fulfill({ json: [{ id: trackId, name: 'Long mix', artist: 'Four Tet', album: '', track_number: null,
    created_time_utc: '', file_path: 'mix.mp3', url: '/audio/mix.mp3', play_count: 0,
    bookmarks: { first: { position: 70, end_position: 120, label: 'First', emoji: '🎹', created_time_utc: '' },
      second: { position: 180, end_position: 240, label: 'Second', emoji: '🎸', created_time_utc: '' } },
  }] }));
  await page.goto('/'); await bookmarkView(page);
  await page.getByRole('button', { name: 'Play Long mix from First', exact: true }).click();
  await expect.poll(() => sim.queueRequests.length).toBe(1);
  await expect(page.getByRole('button', { name: 'Pause Sonos', exact: true })).toBeEnabled();
  sim.speaker.positionMillis = 120_100; await sim.emitPlayback();
  await expect.poll(() => sim.queueRequests.length).toBe(2);
  expect(sim.commands).toContain('pause');
  expect((sim.queueRequests[1] as unknown as { positionMillis: number }).positionMillis).toBe(180000);
  await expect.poll(async () => (await player(page)).playbackRange.start).toBe(180);
  sim.pauseResult = 'rejected'; sim.paused = false; sim.speaker.positionMillis = 240_100; await sim.emitPlayback();
  await expect(page.getByText('Sonos pause was not acknowledged')).toBeVisible();
  expect(sim.queueRequests).toHaveLength(2);
});
