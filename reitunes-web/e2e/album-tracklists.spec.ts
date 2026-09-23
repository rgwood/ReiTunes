import { expect, type Page } from '@playwright/test';
import { deferred, SonosSimulator, test, trackId } from './fixtures/sonos';
import type { LibraryItem, Tracklist } from '../src/types';

const list: Tracklist = { tracks: [{ title: 'Locked', start: 0, end: 510 }, { title: 'Lion', start: 510, end: 1051 }, { title: 'Jupiters', start: 1051, end: 1400 }],
  source_url: 'https://musicbrainz.org/release/1bc9f853-0bf2-42f9-b844-df9eb278693f', source_label: 'MusicBrainz · Pink', timing: 'estimated', duration: null };
const album: LibraryItem = { id: trackId, name: 'Pink', artist: 'Four Tet', album: 'Pink', track_number: null, created_time_utc: '2026-09-01T00:00:00', file_path: 'pink.mp3', url: '/audio/pink.mp3', play_count: 0, bookmarks: {
  moment: { position: 750, emoji: '🎸', label: 'Favourite moment', created_time_utc: '2026-09-01T00:00:00' },
} };
async function open(page: Page, sonos = false, existing = false) {
  if (sonos) await new SonosSimulator(page).install();
  let item = { ...album, tracklist: existing ? list : null };
  const saves: { tracklist: Tracklist | null; expected: Tracklist | null }[] = [];
  await page.route('**/api/items', r => r.fulfill({ json: [item] }));
  await page.route('**/api/items/*/tracklist/find', r => r.fulfill({ json: { candidates: [{ id: 'pink', title: 'Pink', detail: '2012 · Digital', tracklist: list }], warnings: [] } }));
  await page.route('**/api/items/*/tracklist', async r => {
    const body = r.request().postDataJSON(); saves.push(body); item = { ...item, tracklist: body.tracklist }; await r.fulfill({ json: item });
  });
  await page.route('**/api/playlists', r => r.fulfill({ json: [] }));
  await page.route('**/api/tags', r => r.fulfill({ json: { items: {} } }));
  await page.route('**/api/discovery', r => r.fulfill({ json: { entries: [], sources: [] } }));
  await page.route('**/api/sonos/status', r => r.fulfill({ json: { configured: sonos, connected: sonos } }));
  await page.route('**/api/log', r => r.fulfill({ status: 200 }));
  await page.route('**/ui/play', r => r.fulfill({ status: 200 }));
  await page.route('**/audio/*.mp3', r => r.fulfill({ contentType: 'audio/mpeg', body: '' }));
  await page.routeWebSocket('**/updates', () => {});
  await page.addInitScript(id => {
    localStorage.setItem('reitunes-player', JSON.stringify({ version: 1, state: { currentItemId: id, resumePosition: 0, volume: .5, isMuted: false } }));
    localStorage.setItem('reitunes-theme', JSON.stringify({ lightTheme: 'neutral', darkTheme: 'forest-palace', mode: 'dark' }));
    Object.defineProperty(HTMLMediaElement.prototype, 'duration', { configurable: true, get: () => 1500 });
    Object.defineProperty(HTMLMediaElement.prototype, 'readyState', { configurable: true, get: () => 4 });
    Object.defineProperty(HTMLMediaElement.prototype, 'play', { configurable: true, value() { this.dispatchEvent(new Event('play')); return Promise.resolve(); } });
    Object.defineProperty(HTMLMediaElement.prototype, 'pause', { configurable: true, value() { this.dispatchEvent(new Event('pause')); } });
    // Metadata-only probes use Audio without inserting it into the document.
    const NativeAudio = window.Audio;
    window.Audio = function() { const audio = new NativeAudio(); setTimeout(() => audio.dispatchEvent(new Event('loadedmetadata')), 10); return audio; } as typeof Audio;
  }, trackId);
  await page.goto('/');
  await expect(page.locator(`tr[data-item-id="${trackId}"]`)).toBeVisible();
  await page.locator('audio').dispatchEvent('loadedmetadata');
  await page.locator('audio').dispatchEvent('canplay');
  return { saves };
}
async function edit(page: Page, existing = false) {
  await page.locator(`tr[data-item-id="${trackId}"]`).click({ button: 'right' });
  await page.getByRole('button', { name: existing ? 'Edit tracklist…' : 'Find tracklist…', exact: true }).click();
  await expect(page.getByRole('dialog', { name: existing ? 'Edit tracklist' : 'Find tracklist' })).toBeVisible();
}

test('research previews before saving; expanded tracks select first, play on double-click and remain searchable', async ({ page }, testInfo) => {
  const { saves } = await open(page);
  await edit(page);
  await page.getByRole('button', { name: 'Find tracklist', exact: true }).click();
  await expect(page.getByLabel('Track 2 title', { exact: true })).toHaveValue('Lion');
  await expect(page.getByText(/Your recording is 1:40 longer/)).toBeVisible();
  expect(saves).toHaveLength(0);
  await page.getByRole('button', { name: 'Preview track 2 boundary' }).click();
  await expect.poll(() => page.locator('audio').evaluate(e => (e as HTMLAudioElement).currentTime)).toBe(507);
  await page.screenshot({ path: testInfo.outputPath('tracklist-preview.png') });
  await page.getByRole('button', { name: 'Apply tracklist' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(saves).toHaveLength(1);
  expect(saves[0].expected).toBeNull();
  expect((await page.locator(`tr[data-item-id="${trackId}"]`).boundingBox())?.height).toBe(24);
  const chapter = page.getByRole('option', { name: /Lion/ });
  await chapter.click();
  expect(await page.locator('audio').evaluate(e => (e as HTMLAudioElement).currentTime)).toBe(507);
  await chapter.dblclick();
  await expect.poll(() => page.locator('audio').evaluate(e => (e as HTMLAudioElement).currentTime)).toBe(510);
  await page.getByRole('button', { name: 'Jump to Jupiters', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => page.locator('audio').evaluate(e => (e as HTMLAudioElement).currentTime)).toBe(1051);
  await expect(page.locator('.timeline-bookmark')).toHaveCount(1);
  await page.getByRole('searchbox', { name: 'Search library' }).fill('Jupiters');
  await expect(page.locator(`tr[data-item-id="${trackId}"]`)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('expanded-album.png') });
});

test('editing supports offsets, invalid bounds, save failures and reload', async ({ page }) => {
  await open(page, false, true);
  await edit(page, true);
  await page.getByRole('spinbutton').fill('2');
  await page.getByRole('button', { name: 'Shift', exact: true }).click();
  await expect(page.getByLabel('Track 2 start', { exact: true })).toHaveValue('8:32');
  await page.getByLabel('Track 2 start', { exact: true }).fill('0:00');
  await expect(page.getByRole('button', { name: 'Apply tracklist' })).toBeDisabled();
  await page.getByLabel('Track 2 start', { exact: true }).fill('8:32');
  await page.route('**/api/items/*/tracklist', r => r.fulfill({ status: 409, body: 'Tracklist changed in another window.' }));
  await page.getByRole('button', { name: 'Apply tracklist' }).click();
  await expect(page.getByRole('alert')).toContainText('another window');
  await expect(page.getByLabel('Track 2 start', { exact: true })).toHaveValue('8:32');
  await page.keyboard.press('Escape');
  await page.reload();
  await page.getByRole('button', { name: 'Tracklist for Pink' }).click();
  await expect(page.getByRole('option', { name: /Lion/ })).toContainText('8:30');
});

test('a late research response preserves a pasted draft', async ({ page }) => {
  const { saves } = await open(page);
  const arrived = deferred(), release = deferred();
  await page.route('**/api/items/*/tracklist/find', async r => {
    arrived.resolve(); await release.promise;
    await r.fulfill({ json: { candidates: [{ id: 'pink', title: 'Pink', detail: '', tracklist: list }], warnings: [] } });
  });
  await edit(page);
  await page.getByRole('button', { name: 'Find tracklist', exact: true }).click();
  await arrived.promise;
  await page.getByText('Paste a timestamped tracklist', { exact: true }).click();
  await page.getByLabel('Timestamped tracklist').fill('0:00 My first track\n5:00 My second track');
  await page.getByRole('button', { name: 'Preview pasted tracklist' }).click();
  release.resolve();
  await expect(page.getByRole('button', { name: 'Apply tracklist' })).toBeEnabled();
  await expect(page.getByLabel('Track 1 title', { exact: true })).toHaveValue('My first track');
  expect(saves).toHaveLength(0);
});

test('removing a tracklist leaves bookmarks and the recording intact', async ({ page }) => {
  const { saves } = await open(page, false, true);
  await edit(page, true);
  await page.getByRole('button', { name: 'Remove tracklist', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Tracklist for Pink' })).toHaveCount(0);
  await expect(page.locator(`tr[data-item-id="${trackId}"]`)).toBeVisible();
  await expect(page.locator('.timeline-bookmark')).toHaveCount(1);
  expect(saves[0].tracklist).toBeNull();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Tracklist for Pink' })).toHaveCount(0);
});

test('Sonos chapter rows play from the selected time, and scrubber markers seek', async ({ page }) => {
  await open(page, true, true);
  const positions: number[] = [];
  await page.route('**/api/sonos/play', async r => { positions.push(r.request().postDataJSON().positionMillis); await r.fulfill({ status: 204 }); });
  await page.getByRole('button', { name: 'Tracklist for Pink' }).click();
  const chapter = page.getByRole('option', { name: /Lion/ });
  await chapter.click(); expect(positions).toEqual([]);
  await chapter.dblclick(); await expect.poll(() => positions).toEqual([510000]);
  const seeks: number[] = [];
  await page.route('**/api/sonos/groups/group-1/playback/seek', r => { seeks.push(r.request().postDataJSON().positionMillis); return r.fulfill({ status: 204 }); });
  await page.getByRole('button', { name: 'Jump to Jupiters' }).click();
  await expect.poll(() => seeks).toEqual([1051000]);
});

test('paste fallback works on a narrow screen and rejects negative offsets', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  await edit(page);
  await page.getByText('Paste a timestamped tracklist', { exact: true }).click();
  await page.getByLabel('Timestamped tracklist').fill('0:00 Locked\n8:30 Lion\n17:31 Jupiters');
  await page.getByRole('button', { name: 'Preview pasted tracklist' }).click();
  await page.getByRole('spinbutton').fill('-5');
  await page.getByRole('button', { name: 'Shift', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('negative start');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await page.screenshot({ path: testInfo.outputPath('tracklist-mobile.png') });
  await page.getByRole('button', { name: 'Apply tracklist' }).click();
  await expect(page.getByRole('option', { name: /Lion/ })).toBeVisible();
});
