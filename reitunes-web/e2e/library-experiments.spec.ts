import { writeFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import type { LibraryItem } from '../src/types';

// Deliberately varied test data: albums, repeat artists, loose mixes and saved moments.
// These fixtures never touch the real library or its import endpoints.
const albums = [
  ['Nick Drake', 'Bryter Layter', 'Northern Sky', 'Hazey Jane II'],
  ['Nick Drake', 'Pink Moon', 'Pink Moon', 'Place to Be'],
  ['Joni Mitchell', 'Blue', 'A Case of You', 'California'],
  ['Burial', 'Untrue', 'Archangel', 'Near Dark'],
  ['Boards of Canada', 'Music Has the Right to Children', 'Roygbiv', 'Turquoise Hexagon Sun'],
  ['Nala Sinephro', 'Space 1.8', 'Space 1', 'Space 2'],
  ['Radiohead', 'In Rainbows', 'Weird Fishes', 'Reckoner'],
  ['Sade', 'Love Deluxe', 'No Ordinary Love', 'Kiss of Life'],
  ['Four Tet', 'Rounds', 'She Moves She', 'My Angel Rocks Back and Forth'],
  ['Alice Coltrane', 'Journey in Satchidananda', 'Shiva-Loka', 'Stopover Bombay'],
  ['Talk Talk', 'Spirit of Eden', 'The Rainbow', 'Eden'],
  ['Nina Simone', 'Pastel Blues', 'Be My Husband', 'Sinnerman'],
  ['D’Angelo', 'Voodoo', 'Spanish Joint', 'The Root'],
  ['Portishead', 'Dummy', 'Mysterons', 'Glory Box'],
  ['Cocteau Twins', 'Heaven or Las Vegas', 'Cherry-Coloured Funk', 'Iceblink Luck'],
  ['Khruangbin', 'Con Todo El Mundo', 'Como Me Quieres', 'Friday Morning'],
] as const;

const libraryItems: LibraryItem[] = albums.flatMap(([artist, album, ...tracks], albumIndex) =>
  tracks.map((name, trackIndex) => ({
    id: `11111111-1111-4111-8111-${String(albumIndex * 2 + trackIndex + 1).padStart(12, '0')}`,
    name,
    artist,
    album,
    created_time_utc: `2026-08-${String(28 - albumIndex).padStart(2, '0')}T12:00:00`,
    file_path: `review-${albumIndex}-${trackIndex}.mp3`,
    track_number: trackIndex + 1,
    play_count: albumIndex + trackIndex + 1,
    is_favorite: albumIndex === 0 && trackIndex === 0,
    url: `/audio/review-${albumIndex}-${trackIndex}.mp3`,
    bookmarks: albumIndex === 0 && trackIndex === 0 ? {
      '22222222-2222-4222-8222-222222222222': {
        position: 70,
        emoji: '🎸',
        label: 'Guitar entrance',
        created_time_utc: '2026-08-28T13:00:00',
      },
      '22222222-2222-4222-8222-222222222223': {
        position: 130,
        emoji: '✨',
        label: 'Last chorus',
        created_time_utc: '2026-08-28T13:01:00',
      },
    } : {},
  }))
);

libraryItems.push(...['Late-night radio · September', 'Sunday morning in the kitchen'].map((name, index) => ({
  id: `33333333-3333-4333-8333-${String(index + 1).padStart(12, '0')}`,
  name,
  artist: index === 0 ? 'Floating Points' : '',
  album: '',
  created_time_utc: `2026-09-0${index + 1}T12:00:00`,
  file_path: `review-mix-${index}.mp3`,
  track_number: null,
  play_count: 0,
  is_favorite: false,
  url: `/audio/review-mix-${index}.mp3`,
  bookmarks: {},
})));

async function mockLibrary(page: Page, items = libraryItems) {
  await page.route('**/api/items', (route) => route.fulfill({ json: items }));
  await page.route('**/api/playlists', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/log', (route) => route.fulfill({ status: 200 }));
  await page.route('**/ui/play', (route) => route.fulfill({ status: 200 }));
  await page.route('**/audio/*.mp3', (route) => route.fulfill({ contentType: 'audio/mpeg', body: '' }));
  await page.routeWebSocket('**/updates', () => {});
  await page.addInitScript(() => {
    Object.defineProperty(HTMLMediaElement.prototype, 'play', {
      configurable: true,
      value() {
        const source = this.src;
        Object.defineProperty(this, 'paused', { configurable: true, get: () => this.src !== source });
        this.dispatchEvent(new Event('play'));
        return Promise.resolve();
      },
    });
    Object.defineProperty(HTMLMediaElement.prototype, 'pause', {
      configurable: true,
      value() { Object.defineProperty(this, 'paused', { configurable: true, value: true }); this.dispatchEvent(new Event('pause')); },
    });
  });
}

const densityItems: LibraryItem[] = Array.from({ length: 120 }, (_, index) => ({
  ...libraryItems[index % libraryItems.length],
  id: `55555555-5555-4555-8555-${String(index + 1).padStart(12, '0')}`,
  name: libraryItems[index % libraryItems.length].name + (index < libraryItems.length ? '' : ` · take ${Math.floor(index / libraryItems.length) + 1}`),
}));

async function queueTrack(page: Page, name: string) {
  await page.getByRole('row').filter({ hasText: name }).click({ button: 'right' });
  await page.getByText('Add to Queue', { exact: false }).click();
}

const randomJumpItems = densityItems.map((item, index) => ({
  ...item,
  created_time_utc: '2026-09-01T12:00:00',
  is_favorite: false,
  bookmarks: index === 60 ? libraryItems[0].bookmarks : {},
}));

async function playingRowIsRevealed(page: Page) {
  return page.locator('tbody tr[aria-current="true"]').evaluate(row => {
    const table = row.closest('table')!;
    const scroller = table.parentElement!;
    const bounds = row.getBoundingClientRect();
    return bounds.top >= table.tHead!.getBoundingClientRect().bottom &&
      bounds.bottom <= scroller.getBoundingClientRect().bottom;
  });
}

test('random jumps reveal the highlighted row in both directions, including the same song', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 600 });
  await mockLibrary(page, randomJumpItems);
  await page.goto('/');
  await expect(page.locator('tbody tr')).toHaveCount(120);
  await page.keyboard.press('Control+e');
  await expect(page.locator('tbody tr[aria-current="true"]')).toContainText(randomJumpItems[60].name);
  await expect.poll(() => playingRowIsRevealed(page)).toBe(true);

  // Browsing while the song plays must not continually snap back to it.
  await page.locator('table').evaluate(table => {
    table.parentElement!.scrollTop = table.parentElement!.scrollHeight;
    document.querySelector('audio')!.dispatchEvent(new Event('timeupdate'));
  });
  await expect.poll(() => playingRowIsRevealed(page)).toBe(false);
  await page.keyboard.press('Control+e');
  await expect.poll(() => playingRowIsRevealed(page)).toBe(true);
});

test('random jumps escape hiding filters but preserve a search that includes the song', async ({ page }) => {
  await mockLibrary(page, randomJumpItems);
  await page.route('**/api/playlists', route => route.fulfill({ json: [{
    id: 'random-test-playlist', name: 'Other songs',
    items: { first: { library_item_id: randomJumpItems[0].id, position: 0 } },
  }] }));
  await page.goto('/');
  const search = page.getByRole('searchbox', { name: 'Search library' });
  const collection = page.getByRole('combobox', { name: 'Collection', exact: true });
  await page.getByRole('button', { name: 'Playlists', exact: true }).click();
  await page.getByText('Other songs', { exact: true }).click();
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await search.fill('no matching music');
  await search.blur();
  await expect(page.locator('tbody tr')).toHaveCount(0);
  await page.keyboard.press('Control+e');
  await expect(search).toHaveValue('');
  await expect(page.locator('tbody tr')).toHaveCount(120);
  await expect.poll(() => playingRowIsRevealed(page)).toBe(true);

  await collection.selectOption('favourites');
  await collection.blur();
  await expect(page.locator('tbody tr')).toHaveCount(0);
  await page.keyboard.press('Control+e');
  await expect(collection).toHaveValue('all');
  await expect.poll(() => playingRowIsRevealed(page)).toBe(true);

  await search.fill(randomJumpItems[60].name);
  await search.blur();
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await page.keyboard.press('Control+e');
  await expect(search).toHaveValue(randomJumpItems[60].name);
  await expect.poll(() => playingRowIsRevealed(page)).toBe(true);
});

test('searches artists, albums and bookmark labels in one grid', async ({ page }) => {
  await mockLibrary(page);
  await page.goto('/');
  const rows = page.locator('tbody tr');
  await expect(rows).toHaveCount(34);
  const search = page.getByRole('searchbox', { name: 'Search library' });
  await search.fill('artist:"Nick Drake"');
  await expect(rows).toHaveCount(4);
  await expect(page.getByRole('row').filter({ hasText: 'Archangel' })).toHaveCount(0);
  await search.fill('album:"Pink Moon"');
  await expect(rows).toHaveCount(2);
  await expect(page.getByRole('row').filter({ hasText: 'Place to Be' })).toBeVisible();
  await search.fill('Guitar entrance');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('Northern Sky');
  await search.fill('');

  const collection = page.getByRole('combobox', { name: 'Collection', exact: true });
  await collection.selectOption({ label: 'Favourites' });
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('Northern Sky');
  await collection.selectOption({ label: 'Unplayed' });
  await expect(rows).toHaveCount(2);
  await expect(page.getByRole('row').filter({ hasText: 'Late-night radio' })).toBeVisible();
  await collection.selectOption({ label: 'All music' });
  await expect(rows).toHaveCount(34);
});

test('plays a filtered album and queues another track from the grid', async ({ page }) => {
  await mockLibrary(page);
  await page.goto('/');
  await page.getByRole('searchbox', { name: 'Search library' }).fill('album:"Bryter Layter"');
  await page.getByRole('row').filter({ hasText: 'Northern Sky' }).click();
  await expect.poll(() => page.evaluate(() => {
    const player = JSON.parse(localStorage.getItem('reitunes-player') || '{}');
    const queue = JSON.parse(localStorage.getItem('reitunes-queue') || '{}');
    return { currentItemId: player.state?.currentItemId, context: queue.state?.contextItems?.map((item: { name: string }) => item.name) };
  })).toEqual({ currentItemId: libraryItems[0].id, context: ['Northern Sky', 'Hazey Jane II'] });
  await queueTrack(page, 'Hazey Jane II');
  await expect.poll(() => page.evaluate(() =>
    JSON.parse(localStorage.getItem('reitunes-queue') || '{}').state?.manualQueue?.map((item: { name: string }) => item.name)
  )).toEqual(['Hazey Jane II']);
  await page.getByRole('button', { name: 'Queue', exact: true }).click();
  await expect(page.getByText('Hazey Jane II', { exact: true }).last()).toBeVisible();
});

test('moves to the next saved moment from the live position and keeps queued music', async ({ page }) => {
  await mockLibrary(page);
  await page.goto('/');
  await page.getByRole('row').filter({ hasText: 'Northern Sky' }).click();
  await queueTrack(page, 'Hazey Jane II');
  await page.evaluate(() => {
    const audio = document.querySelector('audio');
    if (!audio) throw new Error('Expected a browser audio player');
    audio.dispatchEvent(new Event('canplay'));
    audio.currentTime = 95;
    audio.dispatchEvent(new Event('timeupdate'));
  });
  await page.getByRole('button', { name: 'Next saved moment', exact: true }).click();
  await expect.poll(() => page.evaluate(() => {
    const player = JSON.parse(localStorage.getItem('reitunes-player') || '{}');
    const queue = JSON.parse(localStorage.getItem('reitunes-queue') || '{}');
    return {
      currentItemId: player.state?.currentItemId,
      position: player.state?.resumePosition,
      manualQueue: queue.state?.manualQueue?.map((item: { name: string }) => item.name),
    };
  })).toEqual({ currentItemId: libraryItems[0].id, position: 130, manualQueue: ['Hazey Jane II'] });
});

test('opens a playlist in its saved order and uses its name for playback', async ({ page }) => {
  await mockLibrary(page);
  const orderedItems = [libraryItems[6], libraryItems[2], libraryItems[0]];
  await page.route('**/api/playlists', (route) => route.fulfill({ json: [{
    id: '44444444-4444-4444-8444-444444444444',
    name: 'Evening rotation',
    created_time_utc: '2026-09-01T12:00:00',
    items: Object.fromEntries(orderedItems.map((item, position) => [item.id, { library_item_id: item.id, position }])),
  }] }));
  await page.goto('/');
  await page.getByRole('button', { name: 'Playlists', exact: true }).click();
  await page.getByText('Evening rotation', { exact: true }).click();
  const rows = page.locator('tbody tr');
  await expect(rows).toHaveCount(3);
  for (const [index, item] of orderedItems.entries()) {
    await expect(rows.nth(index)).toContainText(item.name);
  }
  await rows.first().click();
  await expect.poll(() => page.evaluate(() => {
    const queue = JSON.parse(localStorage.getItem('reitunes-queue') || '{}');
    return { name: queue.state?.contextName, items: queue.state?.contextItems?.map((item: { name: string }) => item.name) };
  })).toEqual({ name: 'Evening rotation', items: orderedItems.map(item => item.name) });
});

test('keeps search and browsing reachable at a phone width', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockLibrary(page);
  await page.goto('/');
  await expect(page.getByRole('searchbox', { name: 'Search library' })).toBeVisible();
  await page.getByRole('searchbox', { name: 'Search library' }).fill('Nick Drake');
  await expect(page.getByRole('row').filter({ hasText: 'Northern Sky' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Import music', exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('reviews file imports, skips non-audio files and retries only failures', async ({ page }) => {
  await mockLibrary(page);
  let uploadCount = 0;
  await page.route('**/api/upload', async (route) => {
    uploadCount += 1;
    if (uploadCount === 2) {
      await route.fulfill({ status: 503, body: 'Storage is temporarily unavailable.' });
      return;
    }
    await route.fulfill({ json: {
      id: `uploaded-${uploadCount}`,
      name: uploadCount === 1 ? 'First imported song' : 'Second imported song',
      artist: 'Review artist', album: 'Review album', file_path: 'review.mp3',
    } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Import music', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Import music', exact: true });
  const fileChooser = page.waitForEvent('filechooser');
  await dialog.getByRole('button', { name: 'Choose files', exact: true }).click();
  await (await fileChooser).setFiles([
    { name: 'first.mp3', mimeType: 'audio/mpeg', buffer: Buffer.from('review fixture 1') },
    { name: 'second.flac', mimeType: 'audio/flac', buffer: Buffer.from('review fixture 2') },
    { name: 'readme.txt', mimeType: 'text/plain', buffer: Buffer.from('not music') },
  ]);
  await expect(dialog.getByRole('list', { name: 'Selected audio files' }).getByRole('listitem')).toHaveCount(2);
  await expect(dialog.getByText(/Skipped 1 non-audio file/)).toBeVisible();
  expect(uploadCount).toBe(0);
  await dialog.getByRole('button', { name: 'Import 2 tracks', exact: true }).click();
  await expect(dialog.getByText('Storage is temporarily unavailable.')).toBeVisible();
  await expect(dialog.getByText('First imported song', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Retry 1 failed', exact: true }).click();
  await expect(dialog.getByText('Second imported song', { exact: true })).toBeVisible();
  expect(uploadCount).toBe(3);
  await dialog.getByRole('button', { name: 'View recent imports' }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Collection', exact: true })).toHaveValue('recent');
});

test('queues a link and distinguishes acceptance from completed import', async ({ page }) => {
  await mockLibrary(page);
  let downloadBody: unknown;
  await page.route('**/api/download', async (route) => {
    downloadBody = route.request().postDataJSON();
    await route.fulfill({ status: 200, body: 'Download queued.' });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Import music', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Import music', exact: true });
  await dialog.getByRole('tab', { name: 'Link', exact: true }).click();
  await dialog.getByRole('textbox', { name: 'Music or video link', exact: true }).fill('https://example.com/a-review-mix');
  await dialog.getByRole('button', { name: 'Queue download' }).click();
  await expect(dialog.getByText('Added to the download queue', { exact: true })).toBeVisible();
  expect(downloadBody).toEqual({ url: 'https://example.com/a-review-mix', dl_type: 'Audio' });
  await expect(dialog.getByText('The track will appear in your library after processing.', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Queued', exact: true })).toBeDisabled();
});

test('shows at least thirty compact rows even with an old visual-view preference', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockLibrary(page, densityItems);
  await page.addInitScript(() => localStorage.setItem('reitunes-library-view', 'sleeves'));
  await page.goto('/?view=sleeves');
  await expect(page.locator('tbody tr')).toHaveCount(120);
  await expect(page.getByRole('heading')).toHaveCount(0);
  await expect(page.getByRole('complementary')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^(Gallery|Columns|Sleeves|Songs)$/ })).toHaveCount(0);
  const measurements = await page.evaluate(() => {
    const table = document.querySelector('table');
    if (!table) throw new Error('Expected a music grid');
    let clipTop = table.tHead?.getBoundingClientRect().bottom ?? 0;
    let clipBottom = window.innerHeight;
    for (let parent = table.parentElement; parent; parent = parent.parentElement) {
      if (/(auto|hidden|scroll|clip)/.test(getComputedStyle(parent).overflowY)) {
        const box = parent.getBoundingClientRect();
        clipTop = Math.max(clipTop, box.top);
        clipBottom = Math.min(clipBottom, box.bottom);
      }
    }
    const rows = Array.from(table.querySelectorAll('tbody tr')).map(row => row.getBoundingClientRect());
    return {
      tableTop: table.getBoundingClientRect().top,
      tableLeft: table.getBoundingClientRect().left,
      rowHeight: Math.max(...rows.map(row => row.height)),
      visibleRows: rows.filter(row => row.top >= clipTop - 0.5 && row.bottom <= clipBottom + 0.5).length,
      totalRows: rows.length,
    };
  });
  await writeFile(testInfo.outputPath('density-library.json'), JSON.stringify(densityItems));
  await writeFile(testInfo.outputPath('density.json'), JSON.stringify(measurements, null, 2));
  await page.screenshot({ path: testInfo.outputPath('density-after.png'), animations: 'disabled' });
  expect(measurements.tableTop).toBeLessThanOrEqual(90);
  expect(measurements.tableLeft).toBeLessThanOrEqual(8);
  expect(measurements.rowHeight).toBeLessThanOrEqual(25);
  expect(measurements.visibleRows).toBeGreaterThanOrEqual(30);
});
