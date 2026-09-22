import { expect, type Page } from '@playwright/test';
import type { DiscoveryData, DiscoveryEntry, DiscoverySource } from '../src/hooks/useDiscovery';
import type { DownloadJob } from '../src/hooks/useDownloads';
import { test, SonosSimulator } from './fixtures/sonos';

const sources: DiscoverySource[] = ['Late Night Radio', 'Record Room', 'Sunday Selections'].map((title, index) => ({
  id: `source-${index}`, title, provider: 'SoundCloud', url: `https://soundcloud.com/source-${index}/tracks`,
  minMinutes: 0, lastChecked: 1789000000, lastAttempt: 1789000000, error: null, archiveOffset: 50, archiveFinished: false,
}));

type Entry = DiscoveryEntry & { artworkUrl?: string | null; importCompleted?: boolean };
const entry = (id: string, sourceIndex = 0, extra: Partial<Entry> = {}): Entry => ({
  id, mediaId: id, url: `https://soundcloud.com/source-${sourceIndex}/${id}`, title: `Selection ${id}`, uploader: `DJ ${sourceIndex}`,
  duration: 5400, published: '20260920', sources: [sources[sourceIndex].id], inbox: true, status: 'new',
  discoveredAt: 1789000000, libraryItemId: null, error: null, ...extra,
});

const notes = 'Opening with patient strings and a little tape hiss, this set gradually moves into warm dub and loose percussion. '
  + 'There are field recordings from a rainy station platform, a long stretch of slow electronics, and some records borrowed from friends. '
  + 'The second half picks up with heavy basslines and unfamiliar voices before returning to quieter music for the journey home. '
  + 'These closing notes should remain readable in the details pane without turning one browsing row into an entire screen.';

async function setup(page: Page, entries: Entry[], initialJobs: DownloadJob[] = []) {
  const data: DiscoveryData & { entries: Entry[] } = { sources: structuredClone(sources), entries: structuredClone(entries), refreshing: false };
  const jobs = new Map(initialJobs.map(job => [job.id, structuredClone(job)]));
  const writes: { path: string; body: unknown }[] = [];
  await page.route('**/api/items', route => route.fulfill({ json: [] }));
  await page.route('**/api/playlists', route => route.fulfill({ json: [] }));
  await page.route('**/api/tags', route => route.fulfill({ json: { enabled: false, items: {} } }));
  await page.route('**/api/sonos/status', route => route.fulfill({ json: { configured: false, connected: false } }));
  await page.route('**/api/log', route => route.fulfill({ status: 200 }));
  await page.routeWebSocket('**/updates', () => {});
  await page.route(/https:\/\/(?:www\.youtube(?:-nocookie)?\.com|w\.soundcloud\.com)\/(?:embed|player)/, route =>
    route.fulfill({ contentType: 'text/html', body: '<html><body>Provider preview fixture</body></html>' }));
  await page.route('**/api/downloads/*', route => {
    const job = jobs.get(Number(new URL(route.request().url()).pathname.split('/').at(-1)));
    return job ? route.fulfill({ json: job }) : route.fulfill({ status: 404, body: 'Job no longer available.' });
  });
  await page.route('**/api/discovery**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const selected = data.entries.find(item => path.includes(`/entries/${item.id}/`));
    if (request.method() === 'GET') {
      if (path.endsWith('/details')) return route.fulfill({ json: { description: selected?.description ?? '', genres: [], tracks: [], artworkUrl: selected?.artworkUrl ?? null } });
      return route.fulfill({ json: data });
    }
    const body = request.postData() ? request.postDataJSON() : null;
    writes.push({ path, body });
    if (selected) {
      if (path.endsWith('/save')) selected.saved = body.saved;
      if (path.endsWith('/dismiss')) selected.status = 'dismissed';
      if (path.endsWith('/restore')) { selected.status = 'new'; selected.downloadJobId = null; }
      if (path.endsWith('/import')) {
        selected.status = 'queued'; selected.downloadJobId = 41;
        jobs.set(41, { id: 41, url: selected.url, dl_type: 'Audio', stage: 'downloading', download_percent: 28, error: null });
      }
    }
    await route.fulfill({ status: 204 });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Discover', exact: true }).click();
  return { data, jobs, writes };
}

const row = (page: Page, id: string) => page.locator(`.discovery-entry[data-entry-id="${id}"]`);
const orderedIds = (page: Page) => page.locator('.discovery-entry[data-entry-id]').evaluateAll(elements => elements.map(element => element.getAttribute('data-entry-id')));
const details = (page: Page) => page.getByRole('complementary', { name: 'Set details' });

test('long and missing notes keep browsing compact while selected details show the full description', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await setup(page, [entry('long', 0, { description: notes }), entry('missing', 1), entry('short', 2, { description: 'Slow rhythms for an early morning.' })]);
  const rows = page.locator('.discovery-entry[data-entry-id]');
  await expect(rows).toHaveCount(3);
  const heights = await rows.evaluateAll(elements => elements.map(element => element.getBoundingClientRect().height));
  expect(Math.max(...heights)).toBeLessThanOrEqual(76);
  expect(Math.max(...heights) - Math.min(...heights)).toBeLessThanOrEqual(4);
  await expect(page.locator('iframe')).toHaveCount(0);
  await row(page, 'long').getByRole('button', { name: 'Selection long', exact: true }).click();
  await expect(details(page)).toContainText(notes);
  await expect(page.locator('iframe')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('discover-compact-with-details.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(details(page)).toBeVisible();
  await expect(details(page)).toContainText(notes);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await details(page).getByRole('button', { name: 'Close details', exact: true }).click();
  await expect(details(page)).toHaveCount(0);
  await expect(row(page, 'long')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('discover-compact-mobile.png'), fullPage: true });
});

test('artwork loads without changing row height and failed artwork leaves a useful fallback', async ({ page }) => {
  const artwork = 'https://i1.sndcdn.com/artworks-discovery-fixture.jpg';
  const broken = 'https://i1.sndcdn.com/artworks-discovery-broken.jpg';
  await page.route(artwork, route => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#247a78"/></svg>' }));
  await page.route(broken, route => route.fulfill({ status: 404 }));
  await setup(page, [entry('art', 0, { artworkUrl: artwork }), entry('broken', 1, { artworkUrl: broken }), entry('absent', 2)]);
  const loadedImage = row(page, 'art').locator('.discovery-artwork img');
  await expect(loadedImage).toBeVisible();
  await expect.poll(() => loadedImage.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
  await expect.poll(() => row(page, 'broken').locator('.discovery-artwork').evaluate(element => {
    const image = element.querySelector('img');
    return !image || getComputedStyle(image).display === 'none' || getComputedStyle(image).visibility === 'hidden';
  })).toBe(true);
  const boxes = await page.locator('.discovery-entry[data-entry-id]').evaluateAll(elements => elements.map(element => element.getBoundingClientRect().height));
  expect(Math.max(...boxes) - Math.min(...boxes)).toBeLessThanOrEqual(1);
  for (const id of ['art', 'broken', 'absent']) {
    await expect(row(page, id).getByRole('button', { name: `Listen to Selection ${id}`, exact: true })).toBeVisible();
    const box = await row(page, id).locator('.discovery-artwork').boundingBox();
    expect(box!.width).toBeGreaterThanOrEqual(40);
    expect(box!.height).toBeGreaterThanOrEqual(40);
  }
});

test('previews are explicit, switch one player at a time, and never import a set', async ({ page }) => {
  const { writes } = await setup(page, [entry('first'), entry('second', 1)]);
  await page.locator('audio').evaluate((audio: HTMLAudioElement) => {
    const pause = audio.pause.bind(audio);
    audio.dataset.previewPauseCalls = '0';
    audio.pause = () => { audio.dataset.previewPauseCalls = String(Number(audio.dataset.previewPauseCalls) + 1); pause(); };
  });
  await row(page, 'first').getByRole('button', { name: 'Selection first', exact: true }).click();
  await expect(details(page)).toBeVisible();
  await expect(page.locator('iframe')).toHaveCount(0);
  await expect(page.locator('audio')).toHaveAttribute('data-preview-pause-calls', '0');
  await details(page).getByRole('button', { name: 'Listen here', exact: true }).click();
  await expect(page.locator('iframe[title="Listen to Selection first"]')).toBeVisible();
  await expect(page.locator('iframe')).toHaveCount(1);
  await expect.poll(() => page.locator('audio').evaluate(audio => Number((audio as HTMLElement).dataset.previewPauseCalls))).toBeGreaterThan(0);
  await row(page, 'second').getByRole('button', { name: 'Selection second', exact: true }).click();
  await expect(page.locator('iframe')).toHaveCount(0);
  await row(page, 'second').getByRole('button', { name: 'Listen to Selection second', exact: true }).click();
  await expect(page.locator('iframe[title="Listen to Selection second"]')).toBeVisible();
  await expect(page.locator('iframe')).toHaveCount(1);
  const views = page.getByRole('navigation', { name: 'Discovery views' });
  await views.getByRole('button', { name: /^Sources/ }).click();
  await expect(page.locator('iframe')).toHaveCount(0);
  await views.getByRole('button', { name: /^(Inbox|New)/ }).click();
  await expect(page.locator('iframe')).toHaveCount(0);
  await row(page, 'second').getByRole('button', { name: 'Listen to Selection second', exact: true }).click();
  await expect(page.locator('iframe')).toHaveCount(1);
  await details(page).getByRole('button', { name: 'Close details', exact: true }).click();
  await expect(page.locator('iframe')).toHaveCount(0);
  expect(writes.filter(request => request.path.endsWith('/import'))).toEqual([]);
});

test('the default ordering mixes sources, survives refresh, and filters without duplicates', async ({ page }) => {
  const entries = sources.flatMap((source, index) => [
    entry(`${index}-new`, index, { sources: [source.id], published: '20260920', discoveredAt: 1789000300 - index * 100 }),
    entry(`${index}-old`, index, { published: '20260801', discoveredAt: 1789000300 - index * 100, duration: 7200 }),
  ]);
  // An item discovered through two followed sources still belongs to the list once.
  entries[0].sources.push(sources[1].id);
  await setup(page, entries);
  await expect(page.getByRole('combobox', { name: 'Sort sets' })).toHaveValue('mixed');
  const before = await orderedIds(page);
  expect(before).toHaveLength(6);
  expect(new Set(before).size).toBe(6);
  expect(new Set(before.slice(0, 3).map(id => id!.split('-')[0]))).toEqual(new Set(['0', '1', '2']));
  expect(before.slice(0, 3).every(id => id!.endsWith('-new'))).toBe(true);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled();
  expect(await orderedIds(page)).toEqual(before);
  await page.getByRole('combobox', { name: 'Filter by duration' }).selectOption('long');
  await expect.poll(() => orderedIds(page)).toHaveLength(3);
  expect((await orderedIds(page)).every(id => id!.endsWith('-old'))).toBe(true);
});

test('Listen later keeps a shortlist without downloading and explains the distinction', async ({ page }) => {
  const { writes } = await setup(page, [entry('shortlist')]);
  const save = row(page, 'shortlist').getByRole('button', { name: 'Listen later', exact: true });
  await expect(save).toHaveAttribute('title', /without downloading|no download/i);
  await save.click();
  await expect(row(page, 'shortlist').locator('button[aria-pressed="true"]')).toBeVisible();
  await page.getByRole('navigation', { name: 'Discovery views' }).getByRole('button', { name: /^Listen later/ }).click();
  await expect(row(page, 'shortlist')).toBeVisible();
  expect(writes.filter(request => request.path.endsWith('/save'))).toHaveLength(1);
  expect(writes.filter(request => request.path.endsWith('/import'))).toEqual([]);
});

test('completed imports leave active activity even when the library item has not been matched', async ({ page }) => {
  const { data, jobs } = await setup(page, [entry('downloading', 0, { status: 'queued', downloadJobId: 7 }), entry('browse', 1)], [
    { id: 7, url: entry('downloading').url, dl_type: 'Audio', stage: 'downloading', download_percent: 35, error: null },
  ]);
  await expect(page.locator('.discovery-activity')).toBeVisible();
  jobs.get(7)!.stage = 'completed';
  data.entries[0].importCompleted = true;
  await expect(page.locator('.discovery-activity')).toHaveCount(0);
  await expect(row(page, 'browse')).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Discover', exact: true }).click();
  await expect(page.locator('.discovery-activity')).toHaveCount(0);
  await page.getByRole('button', { name: 'History', exact: true }).click();
  await expect(row(page, 'downloading')).toBeVisible();
  await expect(row(page, 'downloading')).toContainText(/Added to library|In library|Imported/);
  await expect(row(page, 'downloading').getByRole('button', { name: 'Add to library', exact: true })).toHaveCount(0);
});

for (const pauseResult of ['ok', 'rejected'] as const) {
  test(`Sonos preview ${pauseResult === 'ok' ? 'pauses speakers first and stops when library playback resumes' : 'does not start when speakers reject pause'}`, async ({ page }) => {
    const { data, writes } = await setup(page, [entry('speaker-preview')]);
    const sonos = new SonosSimulator(page);
    sonos.pauseResult = pauseResult;
    await sonos.install();
    await page.route('**/api/discovery', route => route.fulfill({ json: data }));
    await page.route('**/api/sonos/status', route => route.fulfill({ json: { configured: true, connected: true } }));
    await page.reload();
    await expect(page.getByRole('button', { name: 'Pause Sonos', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Discover', exact: true }).click();
    await row(page, 'speaker-preview').getByRole('button', { name: 'Selection speaker-preview', exact: true }).click();
    expect(sonos.commands).toEqual([]);
    await details(page).getByRole('button', { name: 'Listen here', exact: true }).click();
    await expect.poll(() => sonos.commands.filter(command => command === 'pause').length).toBe(1);
    if (pauseResult === 'ok') {
      await expect(page.locator('iframe[title="Listen to Selection speaker-preview"]')).toBeVisible();
      expect(sonos.paused).toBe(true);
      await expect(page.getByRole('button', { name: 'Play Sonos', exact: true })).toBeEnabled();
      await page.getByRole('button', { name: 'Play Sonos', exact: true }).click();
      await expect(page.locator('iframe')).toHaveCount(0);
      await expect.poll(() => sonos.paused).toBe(false);
      await details(page).getByRole('button', { name: 'Listen here', exact: true }).click();
      await expect(page.locator('iframe')).toHaveCount(1);
      await details(page).getByRole('button', { name: 'Close details', exact: true }).click();
      await expect(page.locator('iframe')).toHaveCount(0);
      expect(sonos.paused).toBe(true);
      expect(sonos.commands.filter(command => command === 'play')).toHaveLength(1);
    } else {
      await expect(page.getByRole('region', { name: 'Discover sets' }).getByRole('alert')).toContainText('Could not pause the current player');
      await expect(page.locator('iframe')).toHaveCount(0);
      expect(sonos.paused).toBe(false);
      await expect(details(page).getByRole('button', { name: 'Listen here', exact: true })).toBeEnabled();
    }
    expect(sonos.queueRequests).toEqual([]);
    expect(writes.filter(request => request.path.endsWith('/import'))).toEqual([]);
  });
}
