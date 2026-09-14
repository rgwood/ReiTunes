import { expect, test, type Page } from '@playwright/test';
import type { DiscoveryData, DiscoveryEntry, DiscoverySource } from '../src/hooks/useDiscovery';

const source: DiscoverySource = {
  id: 'browsing-source', url: 'https://soundcloud.com/test-dj/tracks', title: 'Test DJ mixes', provider: 'SoundCloud',
  minMinutes: 30, lastChecked: 1789000000, lastAttempt: 1789000000, error: null, archiveOffset: 50, archiveFinished: false,
};
const episode = (id: string, duration: number | null, extra: Partial<DiscoveryEntry> = {}): DiscoveryEntry => ({
  id, mediaId: id, url: `https://soundcloud.com/test-dj/${id}`, title: `Set ${id}`, uploader: 'Test DJ',
  duration, published: '20260901', sources: [source.id], inbox: true, status: 'new', discoveredAt: 1789000000,
  libraryItemId: null, error: null, ...extra,
});

async function backend(page: Page, initial: Partial<DiscoveryData> = {}) {
  const data: DiscoveryData = structuredClone({ sources: [source], entries: [episode('A', 5400)], refreshing: false, ...initial });
  const requests: { path: string; body: unknown }[] = [];
  await page.route('**/api/items', route => route.fulfill({ json: [] }));
  await page.route('**/api/playlists', route => route.fulfill({ json: [] }));
  await page.route('**/api/sonos/status', route => route.fulfill({ json: { configured: false, connected: false } }));
  await page.route('**/api/log', route => route.fulfill({ status: 200 }));
  await page.routeWebSocket('**/updates', () => {});
  await page.route('**/api/discovery**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === 'GET') return route.fulfill({ json: data });
    const body = request.postData() ? request.postDataJSON() : null;
    requests.push({ path, body });
    if (request.method() === 'DELETE' && path.includes('/sources/')) {
      const id = path.split('/').at(-1);
      data.sources = data.sources.filter(source => source.id !== id);
      data.entries.forEach(entry => { entry.sources = entry.sources.filter(sourceId => sourceId !== id); });
    }
    const entry = data.entries.find(entry => path.includes(`/entries/${entry.id}/`));
    if (entry) {
      if (path.endsWith('/save')) entry.saved = body.saved;
      if (path.endsWith('/dismiss')) entry.status = 'dismissed';
      if (path.endsWith('/restore')) { entry.status = 'new'; entry.inbox = true; entry.downloadJobId = null; }
      if (path.endsWith('/import')) { entry.status = 'queued'; entry.downloadJobId = 7; }
    }
    await route.fulfill({ status: 204 });
  });
  return { data, requests };
}

async function discover(page: Page) {
  await page.goto('/');
  await page.getByRole('combobox', { name: 'Collection' }).selectOption('discover');
}

const titles = (page: Page) => page.locator('.discovery-entries article h2').allTextContents();

test('a listening shortlist survives reload without submitting a download', async ({ page }) => {
  const { requests } = await backend(page);
  await discover(page);
  await page.getByRole('button', { name: 'Save for later', exact: true }).click();
  await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'You’re all caught up' })).toBeVisible();
  await page.getByRole('button', { name: 'Saved (1)', exact: true }).click();
  await expect(page.getByRole('article').filter({ hasText: 'Set A' })).toBeVisible();
  await page.reload();
  await page.getByRole('combobox', { name: 'Collection' }).selectOption('discover');
  await page.getByRole('button', { name: 'Saved (1)', exact: true }).click();
  await page.getByRole('button', { name: 'Saved for later', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Make a little listening list' })).toBeVisible();
  expect(requests.filter(request => request.path.endsWith('/save')).map(request => request.body)).toEqual([{ saved: true }, { saved: false }]);
  expect(requests.some(request => request.path.endsWith('/import'))).toBe(false);
});

test('duration filters have clear boundaries and unknown durations sort last', async ({ page }) => {
  await backend(page, { entries: [episode('A', 3599), episode('B', 3600), episode('C', 7199), episode('D', 7200), episode('E', null)] });
  await discover(page);
  await page.getByRole('button', { name: '30–60 min', exact: true }).click();
  await expect.poll(() => titles(page)).toEqual(['Set A']);
  await page.getByRole('button', { name: '1–2 hours', exact: true }).click();
  await expect.poll(() => titles(page)).toEqual(['Set B', 'Set C']);
  await page.getByRole('button', { name: '2+ hours', exact: true }).click();
  await expect.poll(() => titles(page)).toEqual(['Set D']);
  await page.getByRole('button', { name: 'Any length', exact: true }).click();
  await page.getByRole('combobox', { name: 'Sort sets' }).selectOption('longest');
  await expect.poll(() => titles(page)).toEqual(['Set D', 'Set C', 'Set B', 'Set A', 'Set E']);
  await page.getByRole('combobox', { name: 'Sort sets' }).selectOption('shortest');
  await expect.poll(() => titles(page)).toEqual(['Set A', 'Set B', 'Set C', 'Set D', 'Set E']);
});

test('shuffle stays put across refresh and changes only when requested again', async ({ page }) => {
  await backend(page, { entries: ['A', 'B', 'C', 'D', 'E', 'F'].map(id => episode(id, 3600)) });
  await discover(page);
  await page.getByRole('button', { name: 'Shuffle', exact: true }).click();
  const shuffled = await titles(page);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Discover sets' }).getByRole('status')).toContainText('Refresh requested');
  expect(await titles(page)).toEqual(shuffled);
  await page.getByRole('button', { name: 'Shuffle again', exact: true }).click();
  await expect.poll(() => titles(page)).not.toEqual(shuffled);
});

test('imports show progress and failure recovery without leaving the inbox', async ({ page }, testInfo) => {
  const { requests } = await backend(page);
  let failed = false;
  await page.route('**/api/downloads/7', route => route.fulfill({ json: {
    id: 7, url: episode('A', 5400).url, dl_type: 'Audio', stage: failed ? 'failed' : 'downloading',
    download_percent: failed ? null : 28, error: failed ? 'The download failed.' : null,
  } }));
  await discover(page);
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  const activity = page.getByRole('region', { name: 'Imports', exact: true });
  await expect(activity.getByText('Downloading 28%', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Inbox', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('heading', { name: 'You’re all caught up' })).toBeVisible();
  await activity.getByRole('button', { name: 'Imports (1)', exact: true }).click();
  await expect(activity.getByText('Downloading 28%', { exact: true })).toHaveCount(0);
  await activity.getByRole('button', { name: 'Imports (1)', exact: true }).click();
  failed = true;
  await expect(activity.getByText('Import failed', { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath('discovery-imports-mobile.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await activity.getByRole('button', { name: 'Return to inbox', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Import', exact: true })).toBeVisible();
  await expect(activity).toHaveCount(0);
  expect(requests.filter(request => request.path.endsWith('/import'))).toHaveLength(1);
});

test('dismissal can be undone and source chips filter the complete collection', async ({ page }) => {
  const secondSource = { ...source, id: 'second', title: 'Another source' };
  await backend(page, { sources: [source, secondSource], entries: [episode('A', 3600), episode('B', 3600, { sources: [secondSource.id] })] });
  await discover(page);
  await page.getByRole('article').filter({ hasText: 'Set A' }).getByRole('button', { name: 'Dismiss', exact: true }).click();
  await expect.poll(() => titles(page)).toEqual(['Set B']);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(() => titles(page)).toEqual(['Set A', 'Set B']);
  await page.getByRole('button', { name: `Browse ${source.title}`, exact: true }).click();
  await expect(page.getByRole('button', { name: 'All sets', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('combobox', { name: 'Filter by source' })).toHaveValue(source.id);
  await expect.poll(() => titles(page)).toEqual(['Set A']);
  await page.getByRole('button', { name: 'Sources (2)', exact: true }).click();
  await expect(page.getByRole('article').filter({ hasText: source.title })).toContainText('1 in inbox · 1 set found');
});

test('NTS episodes expose descriptions and lazy tracklists without a false import promise', async ({ page }, testInfo) => {
  const ntsSource = { ...source, provider: 'NTS', title: 'NTS selections', url: 'https://www.nts.live/shows/test-show' };
  const { requests } = await backend(page, { sources: [ntsSource], entries: [episode('A', 7200, {
    url: 'https://www.nts.live/shows/test-show/episodes/episode-a', canImport: false, downloadUrl: null,
    description: 'A patient journey through Brazilian records.', genres: ['Brazilian', 'Jazz'],
  })] });
  let tracklistRequests = 0;
  await page.route('**/api/discovery/entries/A/details', route => {
    tracklistRequests += 1;
    return route.fulfill({ json: { description: '', genres: [], tracks: [{ artist: 'Arthur Verocai', title: 'Na Boca Do Sol' }] } });
  });
  await discover(page);
  expect(tracklistRequests).toBe(0);
  await expect(page.getByRole('button', { name: 'Import', exact: true })).toHaveCount(0);
  await expect(page.getByText('No downloadable audio available for this episode.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Listen on NTS ↗' })).toHaveAttribute('target', '_blank');
  await page.getByText('About this set', { exact: true }).click();
  await expect(page.getByText('A patient journey through Brazilian records.')).toBeVisible();
  await page.getByRole('button', { name: 'Tracklist', exact: true }).click();
  await expect(page.getByRole('list', { name: 'Episode tracklist' })).toContainText('Arthur Verocai');
  expect(tracklistRequests).toBe(1);
  await page.getByRole('button', { name: 'Hide tracklist (1)', exact: true }).click();
  await page.getByRole('button', { name: 'Tracklist (1)', exact: true }).click();
  expect(tracklistRequests).toBe(1);
  await page.getByRole('button', { name: 'Save for later', exact: true }).click();
  await page.getByRole('button', { name: 'Saved (1)', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath('discovery-nts-mobile.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(requests.some(request => request.path.endsWith('/import'))).toBe(false);
});

test('saved NTS episodes and history remain accessible after unfollowing the last source', async ({ page }) => {
  const ntsSource = { ...source, provider: 'NTS', title: 'NTS selections', url: 'https://www.nts.live/shows/test-show' };
  await backend(page, { sources: [ntsSource], entries: [
    episode('A', 7200, { saved: true, url: 'https://www.nts.live/shows/test-show/episodes/episode-a', canImport: false }),
    episode('B', 3600, { status: 'queued', libraryItemId: 'already-imported' }),
    episode('C', 3600, { status: 'dismissed' }),
    episode('D', 3600),
    episode('E', 3600, { status: 'queued', downloadJobId: 9 }),
  ] });
  await page.route('**/api/downloads/9', route => route.fulfill({ status: 404, body: 'This older job is no longer available.' }));
  await page.route('**/api/discovery/entries/A/details', route => route.fulfill({ json: {
    description: '', genres: [], tracks: [{ artist: 'Arthur Verocai', title: 'Na Boca Do Sol' }],
  } }));
  await discover(page);
  await page.getByRole('button', { name: 'Sources (1)', exact: true }).click();
  await page.getByRole('button', { name: 'Unfollow', exact: true }).click();
  await page.getByRole('button', { name: 'Inbox', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your next favourite set starts here' })).toBeVisible();
  await expect(page.locator('.discovery-entries article')).toHaveCount(0);
  await page.getByRole('button', { name: 'Saved (1)', exact: true }).click();
  await expect.poll(() => titles(page)).toEqual(['Set A']);
  await expect(page.getByRole('link', { name: 'Listen on NTS ↗' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Dismiss', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Saved for later', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Tracklist', exact: true }).click();
  await expect(page.getByRole('list', { name: 'Episode tracklist' })).toContainText('Arthur Verocai');
  await page.getByRole('button', { name: 'History', exact: true }).click();
  await expect.poll(() => titles(page)).toEqual(['Set B', 'Set C', 'Set E']);
  await expect(page.getByRole('button', { name: 'In library', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Restore', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Return to inbox', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Retry import', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'All sets', exact: true }).click();
  await expect.poll(() => titles(page)).toEqual(['Set A', 'Set B', 'Set C']);
  await page.reload();
  await page.getByRole('combobox', { name: 'Collection' }).selectOption('discover');
  await page.getByRole('button', { name: 'Saved (1)', exact: true }).click();
  await expect.poll(() => titles(page)).toEqual(['Set A']);
  await expect(page.getByRole('link', { name: 'Listen on NTS ↗' })).toBeVisible();
});
