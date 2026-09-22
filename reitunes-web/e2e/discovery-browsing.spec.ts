import { writeFile } from 'node:fs/promises';
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
  await page.route('**/api/tags', route => route.fulfill({ json: [] }));
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
  await page.getByRole('button', { name: 'Discover', exact: true }).click();
}

const titles = (page: Page) => page.locator('.discovery-entries article h2').allTextContents();

test('a listening shortlist survives reload without submitting a download', async ({ page }) => {
  const { requests } = await backend(page);
  await discover(page);
  await page.getByRole('article').getByRole('button', { name: 'Listen later', exact: true }).click();
  await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'You’re all caught up' })).toBeVisible();
  await page.getByRole('button', { name: 'Listen later (1)', exact: true }).click();
  await expect(page.getByText('Your listening shortlist. Nothing downloads until you choose Add to library.')).toBeVisible();
  await expect(page.getByRole('article').filter({ hasText: 'Set A' })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Discover', exact: true }).click();
  await page.getByRole('button', { name: 'Listen later (1)', exact: true }).click();
  await page.getByRole('button', { name: 'Remove from Listen later', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Nothing saved for later' })).toBeVisible();
  expect(requests.filter(request => request.path.endsWith('/save')).map(request => request.body)).toEqual([{ saved: true }, { saved: false }]);
  expect(requests.some(request => request.path.endsWith('/import'))).toBe(false);
});

test('duration filters have clear boundaries and unknown durations sort last', async ({ page }) => {
  await backend(page, { entries: [episode('A', 3599), episode('B', 3600), episode('C', 7199), episode('D', 7200), episode('E', null), episode('F', 1799), episode('G', 1800)] });
  await discover(page);
  const duration = page.getByRole('combobox', { name: 'Filter by duration' });
  await duration.selectOption('hour');
  await expect.poll(() => titles(page)).toEqual(['Set A', 'Set G']);
  await duration.selectOption('two-hours');
  await expect.poll(() => titles(page)).toEqual(['Set B', 'Set C']);
  await duration.selectOption('long');
  await expect.poll(() => titles(page)).toEqual(['Set D']);
  await duration.selectOption('short');
  await expect.poll(() => titles(page)).toEqual(['Set F']);
  await duration.selectOption('any');
  await page.getByRole('combobox', { name: 'Sort sets' }).selectOption('longest');
  await expect.poll(() => titles(page)).toEqual(['Set D', 'Set C', 'Set B', 'Set A', 'Set G', 'Set F', 'Set E']);
  await page.getByRole('combobox', { name: 'Sort sets' }).selectOption('shortest');
  await expect.poll(() => titles(page)).toEqual(['Set F', 'Set G', 'Set A', 'Set B', 'Set C', 'Set D', 'Set E']);
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

test('import activity stays compact and leads to progress and failure recovery in History', async ({ page }, testInfo) => {
  const { requests } = await backend(page);
  let failed = false;
  await page.route('**/api/downloads/7', route => route.fulfill({ json: {
    id: 7, url: episode('A', 5400).url, dl_type: 'Audio', stage: failed ? 'failed' : 'downloading',
    download_percent: failed ? null : 28, error: failed ? 'The download failed.' : null,
  } }));
  await discover(page);
  await page.getByRole('button', { name: 'Add to library', exact: true }).click();
  const activity = page.getByRole('region', { name: 'Import activity', exact: true });
  await expect(activity).toContainText('1 adding to library');
  await expect(page.getByRole('button', { name: 'Inbox', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('heading', { name: 'You’re all caught up' })).toBeVisible();
  await activity.getByRole('button', { name: 'View progress', exact: true }).click();
  await expect(page.getByRole('button', { name: 'History', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('Downloading 28%', { exact: true })).toBeVisible();
  await expect(activity).toHaveCount(0);
  await page.getByRole('button', { name: 'Inbox', exact: true }).click();
  failed = true;
  await expect(activity).toContainText('1 need attention');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath('discovery-imports-mobile.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await activity.getByRole('button', { name: 'View progress', exact: true }).click();
  await expect(page.getByText('Import failed', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Return to inbox', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Add to library', exact: true })).toBeVisible();
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

test('finished imports disappear from activity while completion remains in History', async ({ page }) => {
  await backend(page, { entries: [episode('A', 5400, { status: 'queued', downloadJobId: 7 })] });
  let completed = false;
  await page.route('**/api/downloads/7', route => route.fulfill({ json: {
    id: 7, url: episode('A', 5400).url, dl_type: 'Audio', stage: completed ? 'completed' : 'downloading',
    download_percent: completed ? 100 : 28, error: null,
  } }));
  await discover(page);
  const activity = page.getByRole('region', { name: 'Import activity', exact: true });
  await expect(activity).toContainText('1 adding to library');
  completed = true;
  await expect(activity).toHaveCount(0);
  await page.getByRole('button', { name: 'History', exact: true }).click();
  await expect(page.getByRole('article').filter({ hasText: 'Set A' })).toContainText('Added to library');
  await expect(page.getByRole('button', { name: 'Retry import' })).toHaveCount(0);
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
  await expect(page.getByRole('button', { name: 'Add to library', exact: true })).toHaveCount(0);
  await expect(page.getByText('No downloadable audio available for this episode.')).toBeVisible();
  await expect(page.getByText('About this set', { exact: true })).toHaveCount(0);
  await expect(page.getByText('A patient journey through Brazilian records.')).toBeVisible();
  await page.getByRole('button', { name: 'Set A', exact: true }).click();
  const details = page.getByRole('complementary', { name: 'Set details' });
  await expect(details.getByRole('link', { name: 'Open on NTS ↗' })).toHaveAttribute('target', '_blank');
  await expect(details.getByRole('heading', { name: 'About this set' })).toBeVisible();
  await expect(details.getByText('A patient journey through Brazilian records.')).toBeVisible();
  await details.getByRole('button', { name: 'Tracklist', exact: true }).click();
  await expect(details.getByRole('list', { name: 'Episode tracklist' })).toContainText('Arthur Verocai');
  expect(tracklistRequests).toBe(1);
  await details.getByRole('button', { name: 'Hide tracklist (1)', exact: true }).click();
  await details.getByRole('button', { name: 'Tracklist (1)', exact: true }).click();
  expect(tracklistRequests).toBe(1);
  await page.getByRole('article').getByRole('button', { name: 'Listen later', exact: true }).click();
  await page.getByRole('button', { name: 'Listen later (1)', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Set A', exact: true }).click();
  await expect(details.getByRole('link', { name: 'Open on NTS ↗' })).toBeVisible();
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
  await expect(page.getByRole('heading', { name: 'No sources yet' })).toBeVisible();
  await expect(page.locator('.discovery-entries article')).toHaveCount(0);
  await page.getByRole('button', { name: 'Listen later (1)', exact: true }).click();
  await expect.poll(() => titles(page)).toEqual(['Set A']);
  await page.getByRole('button', { name: 'Set A', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Open on NTS ↗' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Dismiss', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Remove from Listen later', exact: true })).toBeVisible();
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
  await page.getByRole('button', { name: 'Discover', exact: true }).click();
  await page.getByRole('button', { name: 'Listen later (1)', exact: true }).click();
  await expect.poll(() => titles(page)).toEqual(['Set A']);
  await page.getByRole('button', { name: 'Set A', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Open on NTS ↗' })).toBeVisible();
});

// Representative show notes, not copies of actual NTS episode listings.
const compactDescriptions = [
  'Summer dub, hazy electronics and a few records brought home from the road.',
  'A slow start with Japanese folk, followed by warm basslines and spacious house.',
  'Field recordings, percussion and unhurried dance music for a rainy afternoon.',
  'Soft rhythms, strange pop and leftfield selections from the record bag.',
  'A guest selection of ambient pieces, low-slung dub and late-night favourites.',
  'Loose drums and deep grooves, with a short detour through Brazilian records.',
  'New finds and old favourites: synths, strings, voices and a little disco.',
  'Music for travelling home after a long night, from quiet textures to slow acid.',
  'An hour of dreamlike electronics and patient, rolling basslines.',
  'A personal selection of overlooked records, handmade sounds and dub versions.',
  'Distant voices, broken rhythms and warm records for the changing seasons.',
  'Percussion-heavy tracks meet melodic house and some unexpected guitar music.',
  'A gentle mix of cosmic sounds, jazz and records found while touring.',
  'Taking the scenic route through folk, oddball dance music and deep listening.',
];
const longShowNotes = 'This month starts with a stack of records collected while travelling, moving between softly played strings, handmade percussion and patient electronic music. '
  + 'The first half leaves room for field recordings and unfamiliar voices, with a few rough edges kept intact. '
  + 'After that, the tempo gradually rises through a sequence of dub versions, warm basslines and loose drums. '
  + 'There is no rush to get anywhere: several long tracks are played all the way through, and the closing stretch returns to quieter sounds. '
  + 'The final selection is an unhurried favourite saved for the journey home.';
const showIntroduction = 'A monthly selection moving between electronic music, dub and sounds from further afield, assembled from new discoveries and records collected along the way.';

test('Discovery keeps rows compact and full show notes readable in details across screen sizes and themes', async ({ page }, testInfo) => {
  const ntsSource = { ...source, provider: 'NTS', title: 'Yu Su', url: 'https://www.nts.live/shows/yu-su' };
  const entries = [...compactDescriptions.map(notes => `${showIntroduction} ${notes}`), longShowNotes].map((description, index) => episode(`yu-su-${index}`, 7200, {
    title: 'Yu Su', uploader: 'Yu Su', description, genres: ['Leftfield', 'Electronic'],
    url: `https://www.nts.live/shows/yu-su/episodes/yu-su-${index}`, canImport: true,
    downloadUrl: `https://soundcloud.com/nts-latest/yu-su-${index}`,
    discoveredAt: 1789000000 - index,
    published: new Date(Date.UTC(2026, 8, 14 - index)).toISOString().slice(0, 10).replaceAll('-', ''),
  }));
  await page.setViewportSize({ width: 1440, height: 900 });
  await backend(page, { sources: [ntsSource], entries });
  await discover(page);
  const rows = page.locator('.discovery-entries article');
  await expect(rows).toHaveCount(15);
  await expect(rows.first().getByText(entries[0].description!, { exact: true })).toBeVisible();
  await expect(page.getByText('About this set', { exact: true })).toHaveCount(0);
  const showNamesPerRow = await rows.evaluateAll(elements => elements.map(element => ((element as HTMLElement).innerText.match(/Yu Su/g) ?? []).length));
  expect(showNamesPerRow).toEqual(Array(15).fill(1));

  const measurements = await rows.evaluateAll(elements => {
    const bounds = elements.map(element => element.getBoundingClientRect());
    let clipTop = 0;
    let clipBottom = window.innerHeight;
    for (let parent = elements[0].parentElement; parent; parent = parent.parentElement) {
      if (/(auto|hidden|scroll|clip)/.test(getComputedStyle(parent).overflowY)) {
        const box = parent.getBoundingClientRect();
        clipTop = Math.max(clipTop, box.top);
        clipBottom = Math.min(clipBottom, box.bottom);
      }
    }
    return {
      firstRowTop: bounds[0].top,
      maxRowHeight: Math.max(...bounds.map(box => box.height)),
      visibleRows: bounds.filter(box => box.top >= clipTop - 0.5 && box.bottom <= clipBottom + 0.5).length,
    };
  });
  expect(measurements.firstRowTop).toBeLessThanOrEqual(170);
  expect(measurements.maxRowHeight).toBeLessThanOrEqual(68);
  expect(measurements.visibleRows).toBeGreaterThan(10);
  await testInfo.attach('Discovery density', { body: JSON.stringify(measurements, null, 2), contentType: 'application/json' });
  await writeFile(testInfo.outputPath('discovery-density.json'), JSON.stringify(measurements, null, 2));
  await page.screenshot({ path: testInfo.outputPath('discovery-dense-desktop.png'), fullPage: true });

  const search = page.getByRole('searchbox', { name: 'Search discovery', exact: true });
  await search.fill('rough edges kept intact');
  await expect(rows).toHaveCount(1);
  expect(await rows.first().evaluate(element => element.getBoundingClientRect().height)).toBeLessThanOrEqual(68);
  expect(await rows.first().locator('.discovery-description').evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
  await rows.first().getByRole('button', { name: 'Yu Su', exact: true }).click();
  const details = page.getByRole('complementary', { name: 'Set details' });
  const longDescription = details.getByText(longShowNotes, { exact: true });
  const expectReadableNotes = async () => {
    await longDescription.scrollIntoViewIfNeeded();
    await expect(longDescription).toBeVisible();
    expect(await longDescription.evaluate(element => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const textRects = Array.from(range.getClientRects());
      const notes = element.getBoundingClientRect();
      return textRects.length > 1 && textRects[0].top >= notes.top - 1
        && textRects.at(-1)!.bottom <= notes.bottom + 1
        && textRects.every(rect => rect.right <= notes.right + 1)
        && element.scrollHeight <= element.clientHeight + 1;
    })).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  };
  await expectReadableNotes();
  await page.screenshot({ path: testInfo.outputPath('discovery-details-desktop.png'), fullPage: true });
  await details.getByRole('button', { name: 'Close details' }).click();
  await search.fill('');
  await expect(rows).toHaveCount(15);

  await page.setViewportSize({ width: 390, height: 844 });
  await rows.first().scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(await rows.evaluateAll(elements => elements.every(element => {
    const box = element.getBoundingClientRect();
    return box.left >= 0 && box.right <= window.innerWidth && box.height <= 90;
  }))).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('discovery-dense-mobile.png'), fullPage: true });
  await rows.last().getByRole('button', { name: 'Yu Su', exact: true }).click();
  await expectReadableNotes();
  await page.screenshot({ path: testInfo.outputPath('discovery-details-mobile.png'), fullPage: true });
  await details.getByRole('button', { name: 'Close details' }).click();

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await settings.getByRole('combobox', { name: 'Dark theme', exact: true }).selectOption('catppuccin');
  await settings.getByRole('combobox', { name: 'Mode', exact: true }).selectOption('dark');
  await settings.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'catppuccin');
  await expect(page.locator('html')).toHaveAttribute('data-theme-mode', 'dark');
  await page.setViewportSize({ width: 1440, height: 900 });
  await rows.first().scrollIntoViewIfNeeded();
  await expect(rows.first().getByText(entries[0].description!, { exact: true })).toBeVisible();
  expect(await rows.first().evaluate(element => element.getBoundingClientRect().top)).toBe(measurements.firstRowTop);
  expect(await rows.evaluateAll(elements => Math.max(...elements.map(element => element.getBoundingClientRect().height)))).toBeLessThanOrEqual(68);
  await page.screenshot({ path: testInfo.outputPath('discovery-dense-dark-desktop.png'), fullPage: true });
  await rows.last().getByRole('button', { name: 'Yu Su', exact: true }).click();
  await expectReadableNotes();
  await page.screenshot({ path: testInfo.outputPath('discovery-details-dark-desktop.png'), fullPage: true });
  await details.getByRole('button', { name: 'Close details' }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await rows.first().scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('discovery-dense-dark-mobile.png'), fullPage: true });
  await rows.last().getByRole('button', { name: 'Yu Su', exact: true }).click();
  await expectReadableNotes();
  await page.screenshot({ path: testInfo.outputPath('discovery-details-dark-mobile.png'), fullPage: true });
});
