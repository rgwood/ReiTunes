import { expect, test as audioTest } from './fixtures/test';
import { test } from './fixtures/sonos';
import { SonosSimulator } from './fixtures/sonos';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';

audioTest.afterEach(async ({ page }, info) => {
  if (info.status === info.expectedStatus) return;
  console.log(await page.locator('audio').evaluate((element: HTMLAudioElement) => ({
    time: element.currentTime, duration: element.duration, src: element.currentSrc, paused: element.paused,
    ready: element.readyState, error: element.error?.message,
    seekable: Array.from({ length: element.seekable.length }, (_, index) => [element.seekable.start(index), element.seekable.end(index)]),
    player: localStorage.getItem('reitunes-player'),
  })));
  console.log(await page.evaluate(async () => {
    const path = '/src/stores/playerStore.ts';
    const module = await import(path);
    return { listenId: module.usePlayerStore.getState().listenId, pendingSeek: module.usePlayerStore.getState().pendingSeek };
  }));
});

for (const width of [1440, 390]) {
  test(`Last.fm setup and account controls work at ${width} without changing Sonos`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const sonos = new SonosSimulator(page); await sonos.install();
    let status = { configured: false, connected: false, username: null as string | null, enabled: true, pending: 0, submitted: 0, lastError: null };
    const setups: object[] = [];
    await page.route('**/api/lastfm/status', route => route.fulfill({ json: status }));
    await page.route('**/api/lastfm/setup', async route => {
      setups.push(route.request().postDataJSON()); status.configured = true;
      await route.fulfill({ status: 204 });
    });
    await page.route('**/api/lastfm/enabled', async route => {
      status.enabled = route.request().postDataJSON().enabled;
      await route.fulfill({ status: 204 });
    });
    await page.route('**/api/lastfm/connection', async route => {
      status.connected = false; status.username = null;
      await route.fulfill({ status: 204 });
    });
    await page.goto('/');
    if (width < 600) await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Browse', exact: true }).click();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const section = page.locator('.lastfm-settings');
    await expect(page.getByLabel('API key', { exact: true })).toHaveAttribute('type', 'password');
    await expect(page.getByLabel('Shared secret', { exact: true })).toHaveAttribute('type', 'password');
    await page.getByLabel('API key', { exact: true }).fill('a'.repeat(32));
    await page.getByLabel('Shared secret', { exact: true }).fill('b'.repeat(32));
    await page.getByRole('button', { name: 'Save Last.fm credentials' }).click();
    await expect(page.getByRole('button', { name: 'Connect quobobo to Last.fm' })).toBeVisible();
    expect(setups).toEqual([{ apiKey: 'a'.repeat(32), secret: 'b'.repeat(32) }]);
    expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('b'.repeat(32));
    status = { ...status, connected: true, username: 'quobobo', submitted: 5, pending: 1 };
    await page.goto('/?lastfm=connected');
    await expect(page.getByRole('dialog').filter({ hasText: 'Settings' })).toBeVisible();
    await expect(section).toContainText('Connected as quobobo');
    await expect(section).toContainText('5 scrobbles sent from ReiTunes · 1 waiting to send');
    await page.getByRole('checkbox', { name: 'Scrobbling', exact: true }).uncheck();
    await expect.poll(() => status.enabled).toBe(false);
    await page.screenshot({ path: testInfo.outputPath(`lastfm-settings-${width}.png`), fullPage: true });
    await page.getByRole('button', { name: 'Disconnect Last.fm', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Connect quobobo to Last.fm' })).toBeVisible();
    expect(sonos.commands).toEqual([]); expect(sonos.queueRequests).toEqual([]);
  });
}

audioTest('only actual browser listening is reported, with retries and separate replay IDs', async ({ page, browserName }) => {
  audioTest.skip(browserName === 'webkit', 'Linux WebKit exposes the fixture as a rolling stream with duration equal to the playhead; real-audio seek assertions run in Chromium.');
  await page.setViewportSize({ width: 390, height: 844 });
  const track = { id: '11111111-1111-4111-8111-111111111111', name: 'Chemtrails', artist: 'Beck', album: 'Modern Guilt',
    created_time_utc: '2026-09-01T00:00:00', file_path: 'song.mp3', url: '/audio/song.mp3', duration_seconds: 40, bookmarks: {}, play_count: 0 };
  // A generated 220 Hz tone, not a music recording. ffmpeg -f lavfi -i
  // sine=frequency=220:duration=40 -ac 1 -ar 22050 -b:a 16k -write_xing 1 scrobble-test.mp3
  const buffer = readFileSync(new URL('./fixtures/scrobble-test.mp3', import.meta.url));
  // Serve actual HTTP ranges, as cloud storage does.
  const server = createServer((request, response) => {
    const range = request.headers.range?.match(/bytes=(\d+)-(\d*)/);
    const start = range ? Number(range[1]) : 0;
    const end = range?.[2] ? Math.min(Number(range[2]), buffer.length - 1) : buffer.length - 1;
    response.writeHead(range ? 206 : 200, { 'Content-Type': 'audio/mpeg', 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1,
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${buffer.length}` } : {}) });
    response.end(buffer.subarray(start, end + 1));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test audio server did not start');
  track.url = `http://127.0.0.1:${address.port}/song.mp3`;
  try {
  await page.route('**/api/items', route => route.fulfill({ json: [track] }));
  await page.route('**/api/playlists', route => route.fulfill({ json: [] }));
  await page.route('**/api/tags', route => route.fulfill({ json: { enabled: false, items: {} } }));
  await page.route('**/api/discovery', route => route.fulfill({ json: { sources: [], entries: [] } }));
  await page.route('**/api/sonos/status', route => route.fulfill({ json: { configured: false, connected: false } }));
  await page.route('**/api/log', route => route.fulfill({ status: 200 }));
  await page.route('**/ui/play', route => route.fulfill({ status: 200 }));
  await page.route('**/api/lastfm/status', route => route.fulfill({ json: { connected: true, enabled: true } }));
  const reports: Array<{ listenId: string; segmentId: string; listenedSeconds: number }> = [];
  let offline = true;
  await page.route('**/api/lastfm/listen', async route => {
    reports.push(route.request().postDataJSON());
    await route.fulfill({ status: offline ? 503 : 204 });
  });
  await page.routeWebSocket('**/updates', () => {});
  await page.goto('/#browse/library');
  await page.getByRole('button', { name: 'Play Chemtrails', exact: true }).click();
  const audio = page.locator('audio');
  await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.currentTime > 1.5)).toBe(true);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect.poll(() => reports.some(report => report.listenedSeconds > 1)).toBe(true);
  const firstId = reports.at(-1)!.listenId;
  const beforeSeek = reports.at(-1)!.listenedSeconds;
  offline = false;
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Playing', exact: true }).click();
  await page.getByRole('slider', { name: 'Playback position', exact: true }).fill('30');
  await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.currentTime)).toBeGreaterThan(29);
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('reitunes-lastfm-outbox') || '[]').length)).toBe(0);
  expect(reports.at(-1)!.listenedSeconds).toBeCloseTo(beforeSeek, 1);
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.currentTime)).toBeGreaterThan(31);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect.poll(() => reports.at(-1)?.listenedSeconds ?? 0).toBeGreaterThan(beforeSeek + 0.5);
  expect(reports.at(-1)!.listenId).toBe(firstId);
  expect(reports.at(-1)!.listenedSeconds).toBeLessThan(6);
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Browse', exact: true }).click();
  await page.getByRole('button', { name: 'Play Chemtrails', exact: true }).click();
  await expect.poll(() => [...new Set(reports.map(report => report.listenId))]).toHaveLength(2);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
