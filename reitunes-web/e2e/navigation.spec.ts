import { expect, test, type Page } from '@playwright/test';
import type { LibraryItem } from '../src/types';
import type { DiscoveryData } from '../src/hooks/useDiscovery';

const favourite: LibraryItem = {
  id: '11111111-1111-4111-8111-111111111111', name: 'Northern Sky', artist: 'Nick Drake', album: 'Bryter Layter',
  created_time_utc: '2026-09-01T12:00:00', file_path: 'northern-sky.mp3', track_number: 7, play_count: 12,
  is_favorite: true, url: '/audio/northern-sky.mp3', bookmarks: {},
};
const library = [favourite, { ...favourite, id: '22222222-2222-4222-8222-222222222222', name: 'Pink Moon', is_favorite: false }];
const discovery: DiscoveryData = {
  sources: [{ id: 'source-1', title: 'Late night radio', url: 'https://soundcloud.com/night-radio/tracks', provider: 'SoundCloud',
    minMinutes: 30, lastChecked: 1789000000, lastAttempt: 1789000000, error: null, archiveOffset: 50, archiveFinished: false }],
  entries: [{ id: 'set-1', mediaId: '123', title: 'A late night mix', uploader: 'Night radio', url: 'https://soundcloud.com/night-radio/late-night',
    duration: 7200, published: '20260901', sources: ['source-1'], inbox: true, status: 'new', discoveredAt: 1789000000,
    libraryItemId: null, error: null }],
  refreshing: false,
};

async function backend(page: Page) {
  await page.route('**/api/items', route => route.fulfill({ json: library }));
  await page.route('**/api/playlists', route => route.fulfill({ json: [{
    id: 'playlist-1', name: 'Evening favourites', items: { first: { library_item_id: favourite.id, position: 0 } },
  }] }));
  await page.route('**/api/sonos/status', route => route.fulfill({ json: { configured: false, connected: false } }));
  await page.route('**/api/discovery', route => route.fulfill({ json: discovery }));
  await page.route('**/api/log', route => route.fulfill({ status: 200 }));
  await page.route('**/ui/play', route => route.fulfill({ status: 200 }));
  await page.route('**/audio/*.mp3', route => route.fulfill({ contentType: 'audio/mpeg', body: '' }));
  await page.routeWebSocket('**/updates', () => {});
  await page.addInitScript(() => {
    Object.defineProperty(HTMLMediaElement.prototype, 'play', {
      configurable: true,
      value() {
        this.dataset.playCalls = String(Number(this.dataset.playCalls ?? 0) + 1);
        Object.defineProperty(this, 'paused', { configurable: true, get: () => false });
        this.dispatchEvent(new Event('play'));
        return Promise.resolve();
      },
    });
    Object.defineProperty(HTMLMediaElement.prototype, 'pause', {
      configurable: true,
      value() {
        this.dataset.pauseCalls = String(Number(this.dataset.pauseCalls ?? 0) + 1);
        Object.defineProperty(this, 'paused', { configurable: true, get: () => true });
        this.dispatchEvent(new Event('pause'));
      },
    });
  });
}

for (const viewport of [{ name: 'desktop', width: 1440, height: 900 }, { name: 'mobile', width: 390, height: 844 }]) {
  test(`Library and Discover stay distinct and preserve browsing and playback on ${viewport.name}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await backend(page);
    await page.goto('/');
    const nav = page.getByRole('navigation', { name: 'Main views', exact: true });
    const libraryButton = nav.getByRole('button', { name: 'Library', exact: true });
    const discoverButton = nav.getByRole('button', { name: 'Discover', exact: true });
    await expect(libraryButton).toBeVisible();
    await expect(discoverButton).toBeVisible();
    await expect(libraryButton).toHaveAttribute('aria-current', 'page');
    await expect(discoverButton).not.toHaveAttribute('aria-current', 'page');
    await expect(page.locator('select[aria-label="Collection"] option[value="discover"]')).toHaveCount(0);

    const collection = page.getByRole('combobox', { name: 'Collection', exact: true });
    await collection.selectOption('favourites');
    await page.getByRole('searchbox', { name: 'Search library', exact: true }).fill('Northern');
    await expect(page.locator('tbody tr')).toHaveCount(1);
    await page.getByRole('row').filter({ hasText: 'Northern Sky' }).click();
    const audio = page.locator('audio');
    await expect.poll(() => audio.evaluate(element => (element as HTMLAudioElement).paused)).toBe(false);
    await audio.evaluate(element => { (element as HTMLAudioElement).dataset.navigationMarker = 'same-player'; });
    const playback = await audio.evaluate(element => {
      const audio = element as HTMLAudioElement;
      return { src: audio.src, playCalls: audio.dataset.playCalls, pauseCalls: audio.dataset.pauseCalls, paused: audio.paused };
    });
    await page.screenshot({ path: testInfo.outputPath(`library-navigation-${viewport.name}.png`), fullPage: true });

    await discoverButton.click();
    await expect(libraryButton).toBeVisible();
    await expect(discoverButton).toBeVisible();
    await expect(discoverButton).toHaveAttribute('aria-current', 'page');
    await expect(libraryButton).not.toHaveAttribute('aria-current', 'page');
    await expect(collection).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'All music', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Playlists', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Bookmarks', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Next saved moment', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Queue', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Import music', exact: true })).toBeVisible();
    const discoverySearch = page.getByRole('searchbox', { name: 'Search discovery', exact: true });
    await expect(discoverySearch).toHaveValue('');
    await discoverySearch.fill('late night');
    await expect(page.getByRole('article').filter({ hasText: 'A late night mix' })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`discover-navigation-${viewport.name}.png`), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expect(audio).toHaveAttribute('data-navigation-marker', 'same-player');
    expect(await audio.evaluate(element => {
      const audio = element as HTMLAudioElement;
      return { src: audio.src, playCalls: audio.dataset.playCalls, pauseCalls: audio.dataset.pauseCalls, paused: audio.paused };
    })).toEqual(playback);

    await libraryButton.click();
    await expect(libraryButton).toHaveAttribute('aria-current', 'page');
    await expect(discoverButton).not.toHaveAttribute('aria-current', 'page');
    await expect(collection).toHaveValue('favourites');
    await expect(page.getByRole('searchbox', { name: 'Search library', exact: true })).toHaveValue('Northern');
    await expect(page.locator('tbody tr')).toHaveCount(1);
    await expect(page.locator('tbody tr')).toContainText('Northern Sky');
    await discoverButton.click();
    await expect(discoverySearch).toHaveValue('late night');
    await expect(audio).toHaveAttribute('data-navigation-marker', 'same-player');
    expect(await audio.evaluate(element => (element as HTMLAudioElement).paused)).toBe(false);
  });
}

test('visiting Discover preserves the selected library playlist', async ({ page }) => {
  await backend(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Playlists', exact: true }).click();
  await page.getByText('Evening favourites', { exact: true }).click();
  await expect(page.locator('tbody tr')).toHaveCount(1);
  const nav = page.getByRole('navigation', { name: 'Main views', exact: true });
  await nav.getByRole('button', { name: 'Discover', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Discover', exact: true })).toBeVisible();
  await nav.getByRole('button', { name: 'Library', exact: true }).click();
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await expect(page.locator('tbody tr')).toContainText('Northern Sky');
  await expect(page.getByRole('combobox', { name: 'Collection', exact: true })).toHaveValue('playlist:playlist-1');
});
