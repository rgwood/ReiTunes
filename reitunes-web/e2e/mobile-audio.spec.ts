import { test, expect } from './fixtures/test';
import { writeFile } from 'node:fs/promises';

test.afterEach(async ({ page }, info) => {
  if (info.status === info.expectedStatus) return;
  const state = await page.evaluate(() => {
    const audio = document.querySelector('audio');
    return { time: audio?.currentTime, paused: audio?.paused, ended: audio?.ended, duration: audio?.duration,
      ready: audio?.readyState, src: audio?.currentSrc, error: audio?.error?.message,
      player: localStorage.getItem('reitunes-player'), queue: localStorage.getItem('reitunes-queue') };
  });
  const path = info.outputPath('audio-state.json');
  await writeFile(path, JSON.stringify(state, null, 2));
  await info.attach('audio-state', { path, contentType: 'application/json' });
});

// A real decoded stream catches play(), source replacement and ended-event
// regressions which the transport simulators deliberately don't model.
function wave(seconds: number) {
  const sampleRate = 8000;
  const sampleCount = seconds * sampleRate;
  const buffer = Buffer.alloc(44 + sampleCount * 2);
  buffer.write('RIFF', 0); buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write('WAVEfmt ', 8); buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24); buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36); buffer.writeUInt32LE(sampleCount * 2, 40);
  for (let index = 0; index < sampleCount; index++) {
    buffer.writeInt16LE(Math.round(Math.sin(index * Math.PI * 2 * 220 / sampleRate) * 500), 44 + index * 2);
  }
  return buffer;
}

test('phone audio survives navigation and automatically starts the next real track', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const tracks = ['Northern Sky', 'Chemtrails'].map((name, index) => ({
    id: `${index + 1}1111111-1111-4111-8111-111111111111`, name,
    artist: index ? 'Beck' : 'Nick Drake', album: index ? 'Modern Guilt' : 'Bryter Layter',
    created_time_utc: `2026-09-0${2 - index}T00:00:00`, file_path: `${index}.wav`,
    url: `/audio/${index}.wav`, duration_seconds: index ? 30 : 4, bookmarks: {}, play_count: 0,
  }));
  await page.route('**/api/items', route => route.fulfill({ json: tracks }));
  await page.route('**/api/playlists', route => route.fulfill({ json: [] }));
  await page.route('**/api/tags', route => route.fulfill({ json: { enabled: false, items: {} } }));
  await page.route('**/api/discovery', route => route.fulfill({ json: { sources: [], entries: [] } }));
  await page.route('**/api/sonos/status', route => route.fulfill({ json: { configured: false, connected: false } }));
  await page.route('**/api/log', route => route.fulfill({ status: 200 }));
  await page.route('**/ui/play', route => route.fulfill({ status: 200 }));
  await page.route('**/audio/*.wav', route => route.fulfill({ contentType: 'audio/wav', body: wave(route.request().url().endsWith('/0.wav') ? 4 : 30) }));
  await page.routeWebSocket('**/updates', () => {});
  await page.goto('/#browse/library');
  await page.getByRole('button', { name: 'Play Northern Sky', exact: true }).click();
  const audio = page.locator('audio');
  await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => !element.paused && element.currentTime > 0)).toBe(true);
  await audio.evaluate(element => { (window as Window & { originalAudio?: Element }).originalAudio = element; });
  const navigation = page.getByRole('navigation', { name: 'Main navigation' });
  await navigation.getByRole('button', { name: 'Queue', exact: true }).click();
  await navigation.getByRole('button', { name: 'Playing', exact: true }).click();
  expect(await audio.evaluate(element => element === (window as Window & { originalAudio?: Element }).originalAudio)).toBe(true);
  await expect(page.locator('.mobile-playing-track h2')).toHaveText('Northern Sky');
  await expect(page.locator('.mobile-playing-track h2')).toHaveText('Chemtrails', { timeout: 10_000 });
  await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => !element.paused && element.currentTime > 0 && element.currentSrc.endsWith('/1.wav'))).toBe(true);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.paused)).toBe(true);
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => !element.paused)).toBe(true);
});
