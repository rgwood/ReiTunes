import { expect, test, type Page } from '@playwright/test';
import type { DiscoveryData, DiscoveryEntry, DiscoverySource } from '../src/hooks/useDiscovery';

const source: DiscoverySource = {
  id: 'source-1', url: 'https://soundcloud.com/test-dj/tracks', title: 'Test DJ mixes', provider: 'SoundCloud',
  minMinutes: 30, lastChecked: 1789000000, lastAttempt: 1789000000, error: null, archiveOffset: 50, archiveFinished: false,
};
const set: DiscoveryEntry = {
  id: 'set-1', mediaId: '12345', url: 'https://soundcloud.com/test-dj/late-night', title: 'Late night selections', uploader: 'Test DJ',
  duration: 6480, published: '20260901', sources: [source.id], inbox: true, status: 'new', discoveredAt: 1789000000, libraryItemId: null, error: null,
};

async function backend(page: Page, initial: DiscoveryData) {
  const data = structuredClone(initial);
  const requests: { path: string; body: unknown }[] = [];
  await page.route('**/api/items', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/playlists', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/sonos/status', (route) => route.fulfill({ json: { configured: false, connected: false } }));
  await page.route('**/api/log', (route) => route.fulfill({ status: 200 }));
  await page.routeWebSocket('**/updates', () => {});
  await page.route('**/api/discovery**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === 'GET') return route.fulfill({ json: data });
    requests.push({ path, body: request.postData() ? request.postDataJSON() : null });
    if (path.endsWith('/preview')) return route.fulfill({ json: { source, entries: [set] } });
    if (path.endsWith('/sources')) { data.sources.push(source); data.entries.push(structuredClone(set)); }
    if (request.method() === 'DELETE') { data.sources = []; data.entries = []; }
    if (path.endsWith('/dismiss')) data.entries[0].status = 'dismissed';
    if (path.endsWith('/restore')) data.entries[0].status = 'new';
    if (path.endsWith('/import')) data.entries[0].status = 'queued';
    if (path.endsWith('/archive')) data.entries.push({ ...set, id: 'older', title: 'An older set', inbox: false });
    await route.fulfill({ status: 204 });
  });
  return { data, requests };
}

test('follows a source, listens externally and imports without replacing the player', async ({ page }, testInfo) => {
  const { requests } = await backend(page, { sources: [], entries: [], refreshing: false });
  await page.goto('/');
  await page.evaluate(() => { window.sessionStorage.setItem('player-marker', 'ready'); document.querySelector('audio')?.setAttribute('data-test-marker', 'same-player'); });
  await page.getByRole('button', { name: 'Discover', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Discover', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Add your first source' }).click();
  await page.getByLabel('Source URL').fill(source.url);
  await page.getByLabel('Minimum minutes').fill('30');
  await page.getByRole('button', { name: 'Preview source' }).click();
  await expect(page.getByText('Late night selections')).toBeVisible();
  await page.getByRole('button', { name: 'Follow this source' }).click();
  const card = page.getByRole('article').filter({ hasText: set.title });
  await expect(card).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('discovery-desktop.png'), fullPage: true });
  await expect(card.getByRole('link', { name: 'Listen on SoundCloud ↗' })).toHaveAttribute('target', '_blank');
  await expect(card.getByRole('link', { name: 'Listen on SoundCloud ↗' })).toHaveAttribute('href', set.url);
  await card.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(page.getByText('You’re all caught up')).toBeVisible();
  await page.getByRole('button', { name: 'History', exact: true }).click();
  await expect(page.getByText('Sent to downloader', { exact: true })).toBeVisible();
  expect(requests.find((r) => r.path.endsWith('/preview'))?.body).toEqual({ url: source.url, minMinutes: 30 });
  expect(requests.filter((r) => r.path.endsWith('/import'))).toHaveLength(1);
  // Navigation must not remount the audio element or reset playback state.
  await expect(page.locator('audio')).toHaveAttribute('data-test-marker', 'same-player');
  await page.getByRole('button', { name: 'All music', exact: true }).click();
  await expect(page.getByRole('main', { name: 'Music library' })).toBeVisible();
  await expect(page.locator('audio')).toHaveAttribute('data-test-marker', 'same-player');
});

test('dismissal survives refresh and reload; archive browsing does not fill the inbox', async ({ page }) => {
  const { requests } = await backend(page, { sources: [source], entries: [set], refreshing: false });
  await page.goto('/');
  await page.getByRole('combobox', { name: 'Collection' }).selectOption('discover');
  await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByText('You’re all caught up')).toBeVisible();
  await page.reload();
  await page.getByRole('combobox', { name: 'Collection' }).selectOption('discover');
  await expect(page.getByText('You’re all caught up')).toBeVisible();
  await page.getByRole('button', { name: 'History', exact: true }).click();
  await page.getByRole('button', { name: 'Restore', exact: true }).click();
  await page.getByRole('button', { name: 'Inbox (1)', exact: true }).click();
  await expect(page.getByRole('article').filter({ hasText: set.title })).toBeVisible();
  await page.getByRole('button', { name: 'Sources (1)', exact: true }).click();
  await page.getByRole('button', { name: 'Browse archive' }).click();
  await page.getByRole('button', { name: 'Load 50 more entries' }).click();
  await expect(page.getByText('An older set')).toBeVisible();
  await page.getByRole('button', { name: 'Inbox (1)', exact: true }).click();
  await expect(page.getByText('An older set')).not.toBeVisible();
  expect(requests.some((r) => r.path.endsWith('/archive'))).toBe(true);
});

test('failed imports remain retryable and queued sets cannot be submitted again', async ({ page }) => {
  await backend(page, { sources: [source], entries: [set], refreshing: false });
  await page.route('**/api/discovery/entries/set-1/import', (route) => route.fulfill({ status: 502, body: 'Downloader is unavailable.' }));
  await page.goto('/');
  await page.getByRole('combobox', { name: 'Collection' }).selectOption('discover');
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Downloader is unavailable');
  await expect(page.getByRole('button', { name: 'Import', exact: true })).toBeEnabled();
});

test('source errors, filters and narrow layouts remain usable', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await backend(page, { sources: [{ ...source, error: 'Source is temporarily unavailable.' }], entries: [set], refreshing: false });
  await page.goto('/');
  await page.getByRole('combobox', { name: 'Collection' }).selectOption('discover');
  await page.getByRole('searchbox', { name: 'Search discovery' }).fill('not a match');
  await expect(page.getByText('No matching sets')).toBeVisible();
  await page.getByRole('searchbox', { name: 'Search discovery' }).fill('late night');
  await expect(page.getByRole('link', { name: set.title, exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('discovery-mobile.png'), fullPage: true });
  await page.getByRole('button', { name: 'See source errors' }).click();
  await expect(page.getByRole('alert')).toContainText('Source is temporarily unavailable.');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Unfollow', exact: true }).click();
  await expect(page.getByText('Your next favourite set starts here')).toBeVisible();
});
