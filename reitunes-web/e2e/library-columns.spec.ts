import { expect, test, type Page } from '@playwright/test';

async function setup(page: Page) {
  await page.route('**/api/items', route => route.fulfill({ json: ['Northern Sky', 'Pink Moon'].map((name, index) => ({
    id: `song-${index}`, name, artist: 'Nick Drake', album: 'Bryter Layter', track_number: 7,
    created_time_utc: `2026-01-0${2 - index}T00:00:00`, file_path: `${index}.mp3`,
    url: `/audio/${index}.mp3`, play_count: 0, bookmarks: {},
  })) }));
  await page.route('**/api/playlists', route => route.fulfill({ json: [] }));
  await page.route('**/api/tags', route => route.fulfill({ json: { enabled: false, items: {} } }));
  await page.route('**/api/log', route => route.fulfill({ status: 200 }));
  await page.routeWebSocket('**/updates', () => {});
  await page.goto('/');
  await expect(page.locator('tbody tr')).toHaveCount(2);
}
const headers = (page: Page) => page.locator('thead th').evaluateAll(elements => elements.map(element => element.getAttribute('data-column')));
async function choose(page: Page) {
  await page.locator('th[data-column=name]').click({ button: 'right' });
  return page.getByRole('dialog', { name: 'Choose columns' });
}

test('choose individual columns, reorder, persist across views/reload, and restore defaults', async ({ page }, testInfo) => {
  await page.addInitScript(() => localStorage.setItem('reitunes-theme', JSON.stringify({ lightTheme: 'neutral', darkTheme: 'forest-palace', mode: 'dark' })));
  await setup(page);
  const defaults = ['is_favorite', 'name', 'artist', 'album', 'bookmarks', 'play_count', 'tags'];
  expect(await headers(page)).toEqual(defaults);
  const dialog = await choose(page);
  await expect(dialog.getByRole('checkbox', { name: /Name Always shown/ })).toBeDisabled();
  await dialog.getByRole('checkbox', { name: 'Artist', exact: true }).uncheck();
  await dialog.getByRole('checkbox', { name: 'Date added' }).check();
  await dialog.getByRole('checkbox', { name: 'Favourite' }).uncheck();
  await dialog.getByRole('button', { name: 'Move Album left' }).click();
  await dialog.getByRole('button', { name: 'Move Album left' }).click();
  await page.screenshot({ path: testInfo.outputPath('choose-columns.png') });
  await dialog.getByRole('button', { name: 'Done' }).click();
  const customized = ['album', 'name', 'bookmarks', 'play_count', 'tags', 'created_time_utc'];
  expect(await headers(page)).toEqual(customized);
  await page.getByRole('button', { name: 'Favourites', exact: true }).click();
  expect(await headers(page)).toEqual(customized);
  await page.reload();
  await expect.poll(() => headers(page)).toEqual(customized);
  await page.getByRole('button', { name: 'All music', exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath('custom-columns.png') });
  await choose(page);
  await dialog.getByRole('button', { name: 'Restore defaults' }).click();
  await dialog.getByRole('button', { name: 'Done' }).click();
  expect(await headers(page)).toEqual(defaults);
});

test('header dragging reorders without sorting or selecting songs; keyboard opens chooser', async ({ page }) => {
  await setup(page);
  await page.locator('th[data-column=album] button').dragTo(page.locator('th[data-column=name] button'));
  expect(await headers(page)).toEqual(['is_favorite', 'album', 'name', 'artist', 'bookmarks', 'play_count', 'tags']);
  await expect(page.locator('tbody tr[aria-selected=true]')).toHaveCount(0);
  await expect(page.locator('thead th[aria-sort]')).toHaveCount(0);
  const header = page.locator('th[data-column=name] button');
  await header.focus();
  await header.press('Shift+F10');
  await expect(page.getByRole('dialog', { name: 'Choose columns' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(header).toBeFocused();
});

test('resizing tracks the pointer, persists in pixels and supports keyboard/reset', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 800 });
  await setup(page);
  const header = page.locator('th[data-column=name]');
  const original = (await header.boundingBox())!.width;
  const handle = page.getByRole('separator', { name: 'Resize Name', exact: true });
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 100, box.y + box.height / 2, { steps: 10 });
  await page.mouse.up();
  expect((await header.boundingBox())!.width).toBeCloseTo(original + 100, 0);
  await page.reload();
  expect((await header.boundingBox())!.width).toBeCloseTo(original + 100, 0);
  await handle.focus();
  await handle.press('ArrowRight');
  expect((await header.boundingBox())!.width).toBeCloseTo(original + 110, 0);
  await handle.press('Home');
  expect((await header.boundingBox())!.width).toBeCloseTo(original, 0);
  await handle.press('ArrowLeft');
  await handle.dblclick();
  expect((await header.boundingBox())!.width).toBeCloseTo(original, 0);
});

test('F2 and Tab follow visible column order and skip hidden cells', async ({ page }) => {
  await setup(page);
  const first = page.locator('tbody tr').first();
  await first.locator('[data-column=artist]').click();
  const dialog = await choose(page);
  await dialog.getByRole('checkbox', { name: 'Artist', exact: true }).uncheck();
  await dialog.getByRole('button', { name: 'Move Album left' }).click();
  await dialog.getByRole('button', { name: 'Move Album left' }).click();
  await dialog.getByRole('button', { name: 'Done' }).click();
  await first.focus();
  await first.press('F2');
  const name = first.getByRole('textbox', { name: 'Edit name' });
  await expect(name).toBeFocused();
  await name.press('Shift+Tab');
  const album = first.getByRole('textbox', { name: 'Edit album' });
  await expect(album).toBeFocused();
  await album.press('Tab');
  await expect(name).toBeFocused();
  await name.press('Tab');
  await expect(page.locator('tbody tr').nth(1).getByRole('textbox', { name: 'Edit album' })).toBeFocused();
  await page.keyboard.press('Escape');
  await choose(page);
  await dialog.getByRole('checkbox', { name: 'Album', exact: true }).uncheck();
  await dialog.getByRole('button', { name: 'Done' }).click();
  await first.focus(); await first.press('F2'); await name.press('Tab');
  await expect(page.locator('tbody tr').nth(1).getByRole('textbox', { name: 'Edit name' })).toBeFocused();
});

test('resizing the last column leaves preceding widths alone and does not sort', async ({ page }) => {
  await setup(page);
  const widths = await page.locator('thead th').evaluateAll(headers => headers.map(header => header.getBoundingClientRect().width));
  const handle = page.getByRole('separator', { name: 'Resize Tags', exact: true });
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 80, box.y + box.height / 2, { steps: 10 });
  await page.mouse.up();
  const resized = await page.locator('thead th').evaluateAll(headers => headers.map(header => header.getBoundingClientRect().width));
  widths.slice(0, -1).forEach((width, index) => expect(resized[index]).toBeCloseTo(width, 0));
  expect(resized.at(-1)).toBeCloseTo(widths.at(-1)! - 80, 0);
  await expect(page.locator('thead th[aria-sort]')).toHaveCount(0);
});

test('old details preference migrates and Settings opens the chooser on a narrow screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 700 });
  await page.addInitScript(() => localStorage.setItem('reitunes-library-preferences', JSON.stringify({ state: { showDetails: true, density: 'comfortable' }, version: 0 })));
  await setup(page);
  expect(await headers(page)).toContain('track_number');
  expect(await headers(page)).toContain('created_time_utc');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Choose columns…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Choose columns' });
  await expect(dialog).toBeVisible();
  const box = (await dialog.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Choose columns…' })).toBeFocused();
});

test('a narrow grid with only Name has no leftover column width or positional styling', async ({ page }) => {
  await page.setViewportSize({ width: 600, height: 800 });
  await setup(page);
  const dialog = await choose(page);
  for (const name of ['Favourite', 'Artist', 'Album', 'Bookmarks', 'Plays', 'Tags']) {
    await dialog.getByRole('checkbox', { name, exact: true }).uncheck();
  }
  await dialog.getByRole('button', { name: 'Done' }).click();
  const dimensions = await page.getByRole('table', { name: 'Tracks' }).evaluate(table => ({
    width: table.getBoundingClientRect().width, available: table.parentElement!.clientWidth,
    align: getComputedStyle(table.querySelector('td')!).textAlign,
  }));
  expect(dimensions.width).toBeCloseTo(dimensions.available, 0);
  expect(dimensions.align).not.toBe('center');
  expect(await headers(page)).toEqual(['name']);
});
