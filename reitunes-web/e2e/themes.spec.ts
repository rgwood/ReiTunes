import { writeFile } from 'node:fs/promises';
import { expect, test, type Locator, type Page } from '@playwright/test';
import type { LibraryItem } from '../src/types';

const STORAGE_KEY = 'reitunes-theme';
const themeIds = ['neutral', 'solarized', 'catppuccin', 'gruvbox', 'nord', 'dracula', 'tokyo-night', 'rose-pine'] as const;
type ThemeId = typeof themeIds[number];
type ThemeMode = 'system' | 'light' | 'dark';
const longTitle = 'Northern Sky — live rehearsal with alternate vocals and an extended instrumental ending';
const titles = [longTitle, 'Hazey Jane II', 'Space 1', 'Archangel', 'Roygbiv', 'A Case of You', 'Weird Fishes', 'Glory Box'];
const artists = ['Nick Drake', 'Nick Drake', 'Nala Sinephro', 'Burial', 'Boards of Canada', 'Joni Mitchell', 'Radiohead', 'Portishead'];

// Explicit visual-review fixtures; requests below never reach the real library.
const fixtureItems: LibraryItem[] = Array.from({ length: 120 }, (_, index) => ({
  id: `66666666-6666-4666-8666-${String(index + 1).padStart(12, '0')}`,
  name: titles[index % titles.length] + (index < titles.length ? '' : ` · take ${Math.floor(index / titles.length) + 1}`),
  artist: artists[index % artists.length],
  album: `Review collection ${Math.floor(index / titles.length) + 1}`,
  created_time_utc: '2026-09-01T12:00:00',
  file_path: `theme-fixture-${index}.mp3`,
  track_number: index % titles.length + 1,
  play_count: index,
  is_favorite: index === 0,
  url: `/audio/theme-fixture-${index}.mp3`,
  bookmarks: index === 0 ? {
    '77777777-7777-4777-8777-777777777777': { position: 70, emoji: '🎸', label: 'Guitar entrance', created_time_utc: '2026-09-01T13:00:00' },
  } : {},
}));

async function mockLibrary(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(HTMLMediaElement.prototype, 'play', { configurable: true, value() { const source = this.src; Object.defineProperty(this, 'paused', { configurable: true, get: () => this.src !== source }); this.dispatchEvent(new Event('play')); return Promise.resolve(); } });
    Object.defineProperty(HTMLMediaElement.prototype, 'pause', { configurable: true, value() { Object.defineProperty(this, 'paused', { configurable: true, value: true }); this.dispatchEvent(new Event('pause')); } });
  });
  await page.route('**/api/items', route => route.fulfill({ json: fixtureItems }));
  await page.route('**/api/playlists', route => route.fulfill({ json: [] }));
  await page.route('**/api/log', route => route.fulfill({ status: 200 }));
  await page.route('**/api/sonos/status', route => route.fulfill({ json: { configured: false, connected: false } }));
  await page.route('**/ui/play', route => route.fulfill({ status: 200 }));
  await page.route('**/audio/*.mp3', route => route.fulfill({ contentType: 'audio/mpeg', body: '' }));
  await page.routeWebSocket('**/updates', () => {});
}

async function openSettings(page: Page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function chooseTheme(page: Page, theme: ThemeId, mode: ThemeMode) {
  const dialog = await openSettings(page);
  const resolvedMode = mode === 'system'
    ? await page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : mode;
  await dialog.getByRole('combobox', { name: resolvedMode === 'light' ? 'Light theme' : 'Dark theme', exact: true }).selectOption(theme);
  await dialog.getByRole('combobox', { name: 'Mode', exact: true }).selectOption(mode);
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  await expect(page.locator('html')).toHaveAttribute('data-theme-preference', mode);
  if (mode !== 'system') await expect(page.locator('html')).toHaveAttribute('data-theme-mode', mode);
}

async function colorContrast(locator: Locator, pseudo: string | null = null) {
  return locator.evaluate((element, pseudoElement) => {
    type Color = [number, number, number, number];
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d', { willReadFrequently: true })!;
    const parse = (value: string): Color => {
      // Let the browser normalize modern computed colors such as oklab().
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = value;
      context.fillRect(0, 0, 1, 1);
      const [red, green, blue, alpha] = context.getImageData(0, 0, 1, 1).data;
      return [red, green, blue, alpha / 255];
    };
    const composite = (front: Color, back: Color): Color => {
      const alpha = front[3] + back[3] * (1 - front[3]);
      if (alpha === 0) return [0, 0, 0, 0];
      return [
        (front[0] * front[3] + back[0] * back[3] * (1 - front[3])) / alpha,
        (front[1] * front[3] + back[1] * back[3] * (1 - front[3])) / alpha,
        (front[2] * front[3] + back[2] * back[3] * (1 - front[3])) / alpha,
        alpha,
      ];
    };
    const ancestors: Element[] = [];
    for (let current: Element | null = element; current; current = current.parentElement) ancestors.unshift(current);
    let background: Color = [255, 255, 255, 1];
    for (const ancestor of ancestors) background = composite(parse(getComputedStyle(ancestor).backgroundColor), background);
    const style = getComputedStyle(element, pseudoElement);
    const foreground = parse(style.color);
    foreground[3] *= Number(style.opacity);
    const paintedForeground = composite(foreground, background);
    const luminance = (color: Color) => {
      const channels = color.slice(0, 3).map(value => {
        const channel = value / 255;
        return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
      });
      return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
    };
    const a = luminance(paintedForeground);
    const b = luminance(background);
    return { ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05), foreground: paintedForeground, background };
  }, pseudo);
}

async function readable(locator: Locator, label: string, minimum = 4.5, pseudo: string | null = null) {
  const result = await colorContrast(locator, pseudo);
  expect.soft(result.ratio, `${label}: ${JSON.stringify(result)}`).toBeGreaterThanOrEqual(minimum);
  return { label, ...result };
}

async function density(page: Page) {
  return page.locator('table').evaluate(table => {
    let top = table.querySelector('thead')?.getBoundingClientRect().bottom ?? 0;
    let bottom = innerHeight;
    for (let parent = table.parentElement; parent; parent = parent.parentElement) {
      if (/(auto|hidden|scroll|clip)/.test(getComputedStyle(parent).overflowY)) {
        const box = parent.getBoundingClientRect();
        top = Math.max(top, box.top);
        bottom = Math.min(bottom, box.bottom);
      }
    }
    const rows = Array.from(table.querySelectorAll('tbody tr')).map(row => row.getBoundingClientRect());
    return { top: table.getBoundingClientRect().top, rowHeight: Math.max(...rows.map(row => row.height)), visibleRows: rows.filter(row => row.top >= top - 0.5 && row.bottom <= bottom + 0.5).length };
  });
}

test.beforeEach(async ({ page }) => {
  await mockLibrary(page);
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
});

test('follows the operating system initially and when it changes live', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'neutral');
  await expect(page.locator('html')).toHaveAttribute('data-theme-preference', 'system');
  await expect(page.locator('html')).toHaveAttribute('data-theme-mode', 'dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveAttribute('data-theme-mode', 'light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme-mode', 'dark');
  await expect(page.locator('html')).toHaveAttribute('data-theme-preference', 'system');
});

test('manual mode wins over the operating system and survives reload', async ({ page }) => {
  await page.goto('/');
  await chooseTheme(page, 'solarized', 'dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveAttribute('data-theme-mode', 'dark');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'solarized');
  await expect(page.locator('html')).toHaveAttribute('data-theme-mode', 'dark');
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key) || '{}'), STORAGE_KEY)).toEqual({ lightTheme: 'neutral', darkTheme: 'solarized', mode: 'dark' });
  await chooseTheme(page, 'catppuccin', 'light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme-mode', 'light');
  await chooseTheme(page, 'catppuccin', 'system');
  await expect(page.locator('html')).toHaveAttribute('data-theme-mode', 'dark');
});

test('uses independent light and dark families in System mode and remembers both', async ({ page }) => {
  await page.goto('/');
  const settings = await openSettings(page);
  await settings.getByRole('combobox', { name: 'Light theme', exact: true }).selectOption('solarized');
  await settings.getByRole('combobox', { name: 'Dark theme', exact: true }).selectOption('catppuccin');
  await expect(page.locator('html')).toHaveAttribute('data-theme-preference', 'system');
  await expect(page.locator('html')).toHaveAttribute('data-theme-mode', 'light');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'solarized');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme-mode', 'dark');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'catppuccin');
  await expect(settings.getByRole('combobox', { name: 'Mode', exact: true })).toHaveValue('system');
  await settings.getByRole('button', { name: 'Done', exact: true }).click();
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'catppuccin');
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key) || '{}'), STORAGE_KEY)).toEqual({ lightTheme: 'solarized', darkTheme: 'catppuccin', mode: 'system' });
  await openSettings(page);
  await expect(settings.getByRole('combobox', { name: 'Light theme', exact: true })).toHaveValue('solarized');
  await expect(settings.getByRole('combobox', { name: 'Dark theme', exact: true })).toHaveValue('catppuccin');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'solarized');
  await expect(page.locator('html')).toHaveAttribute('data-theme-mode', 'light');
});

test('migrates the previous shared theme into both appearance choices', async ({ page }) => {
  await page.addInitScript(key => {
    if (localStorage.getItem(key) === null) localStorage.setItem(key, JSON.stringify({ theme: 'gruvbox', mode: 'system' }));
  }, STORAGE_KEY);
  await page.goto('/');
  const settings = await openSettings(page);
  await expect(settings.getByRole('combobox', { name: 'Light theme', exact: true })).toHaveValue('gruvbox');
  await expect(settings.getByRole('combobox', { name: 'Dark theme', exact: true })).toHaveValue('gruvbox');
  await expect(settings.getByRole('combobox', { name: 'Mode', exact: true })).toHaveValue('system');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'gruvbox');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme-mode', 'dark');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'gruvbox');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'gruvbox');
  await expect(page.locator('html')).toHaveAttribute('data-theme-preference', 'system');
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key) || '{}'), STORAGE_KEY)).toEqual({ lightTheme: 'gruvbox', darkTheme: 'gruvbox', mode: 'system' });
});

test('closes settings with Escape, restores focus and opens output settings', async ({ page }) => {
  await page.goto('/');
  const settingsButton = page.getByRole('button', { name: 'Settings', exact: true });
  await expect(settingsButton).toHaveAttribute('title', 'Settings');
  await expect(settingsButton).toHaveText('');
  await expect(settingsButton.locator('svg')).toBeVisible();
  const dialog = await openSettings(page);
  await expect(dialog.getByRole('combobox', { name: 'Mode', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeFocused();
  await openSettings(page);
  await dialog.getByRole('button', { name: 'Choose output', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const output = page.getByRole('dialog', { name: 'Sonos', exact: true });
  await expect(output).toBeVisible();
  await expect(output.getByRole('button', { name: 'Close Sonos', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(output).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeFocused();
});

for (const [label, stored] of [
  ['malformed JSON', '{broken'],
  ['unknown light theme', JSON.stringify({ lightTheme: 'missing-theme', darkTheme: 'catppuccin', mode: 'dark' })],
  ['unknown dark theme', JSON.stringify({ lightTheme: 'solarized', darkTheme: 'missing-theme', mode: 'light' })],
  ['unknown mode', JSON.stringify({ lightTheme: 'solarized', darkTheme: 'catppuccin', mode: 'auto' })],
]) {
  test(`safely defaults when storage contains ${label}`, async ({ page }) => {
    await page.addInitScript(({ key, value }) => localStorage.setItem(key, value), { key: STORAGE_KEY, value: stored });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'neutral');
    await expect(page.locator('html')).toHaveAttribute('data-theme-preference', 'system');
    await expect(page.locator('html')).toHaveAttribute('data-theme-mode', 'dark');
    await expect(page.locator('tbody tr')).toHaveCount(120);
  });
}

test('keeps appearance usable when theme storage is blocked', async ({ page }) => {
  await page.addInitScript(key => {
    const originalGet = Storage.prototype.getItem;
    const originalSet = Storage.prototype.setItem;
    Storage.prototype.getItem = function (name) {
      if (name === key) throw new DOMException('Blocked for test', 'SecurityError');
      return originalGet.call(this, name);
    };
    Storage.prototype.setItem = function (name, value) {
      if (name === key) throw new DOMException('Blocked for test', 'SecurityError');
      return originalSet.call(this, name, value);
    };
  }, STORAGE_KEY);
  await page.goto('/');
  await chooseTheme(page, 'catppuccin', 'dark');
  await expect(page.locator('tbody tr')).toHaveCount(120);
});

for (const theme of themeIds) for (const mode of ['light', 'dark'] as const) {
  test(`${theme} ${mode} keeps compact surfaces and overlays readable`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    await expect(page.locator('tbody tr')).toHaveCount(120);
    const originalDensity = await density(page);
    await chooseTheme(page, theme, mode);
    expect(await density(page)).toEqual(originalDensity);
    expect(originalDensity).toEqual({ top: 90, rowHeight: 24, visibleRows: 31 });
    const samples = [];
    const row = page.locator('tbody tr').first();
    const nameCell = row.locator('td').nth(1);
    samples.push(await readable(nameCell, 'track text'));
    samples.push(await readable(page.getByRole('button', { name: 'Name', exact: true }), 'column heading'));
    samples.push(await readable(page.locator('.library-status'), 'muted status text'));
    samples.push(await readable(page.getByRole('searchbox', { name: 'Search library' }), 'search text'));
    samples.push(await readable(page.getByRole('searchbox', { name: 'Search library' }), 'search placeholder', 4.5, '::placeholder'));
    samples.push(await readable(page.getByRole('combobox', { name: 'Collection', exact: true }), 'collection dropdown'));
    samples.push(await readable(row.getByRole('button', { name: '♥', exact: true }), 'favourite icon', 3));
    await row.click();
    await expect(row).toHaveAttribute('aria-current', 'true');
    samples.push(await readable(nameCell, 'playing track text'));
    samples.push(await readable(row.locator('td').nth(2), 'playing artist text'));
    samples.push(await readable(row.locator('td').last(), 'playing created time'));
    await nameCell.hover();
    const tooltip = page.locator('[data-floating-ui-portal] > div').filter({ hasText: longTitle });
    await expect(tooltip).toBeVisible();
    expect(await tooltip.evaluate(element => element.closest('.music-app') === null)).toBe(true);
    samples.push(await readable(tooltip, 'portalled tooltip'));
    await row.click({ button: 'right' });
    samples.push(await readable(page.getByText('Add to Queue', { exact: false }), 'context menu'));
    await page.keyboard.press('Escape');
    const settings = await openSettings(page);
    samples.push(await readable(settings.getByRole('heading', { name: 'Appearance', exact: true }), 'settings heading'));
    samples.push(await readable(settings.getByRole('combobox', { name: 'Light theme', exact: true }), 'light theme dropdown'));
    samples.push(await readable(settings.getByRole('combobox', { name: 'Dark theme', exact: true }), 'dark theme dropdown'));
    samples.push(await readable(settings.getByRole('combobox', { name: 'Mode', exact: true }), 'mode dropdown'));
    await settings.getByRole('button', { name: 'Done', exact: true }).click();

    let uploads = 0;
    await page.route('**/api/upload', route => {
      uploads += 1;
      return uploads === 1
        ? route.fulfill({ json: { id: 'review-import', name: 'Imported fixture track', artist: 'Review artist', album: 'Review album', file_path: 'fixture.mp3' } })
        : route.fulfill({ status: 503, body: 'Fixture storage error.' });
    });
    await page.getByRole('button', { name: 'Import music', exact: true }).click();
    const imports = page.getByRole('dialog', { name: 'Import music', exact: true });
    samples.push(await readable(imports.getByRole('heading', { name: 'Import music', exact: true }), 'import heading'));
    samples.push(await readable(imports.locator('.import-music__dropzone p'), 'import muted text'));
    const chooser = page.waitForEvent('filechooser');
    await imports.getByRole('button', { name: 'Choose files', exact: true }).click();
    await (await chooser).setFiles([
      { name: 'first.mp3', mimeType: 'audio/mpeg', buffer: Buffer.from('fixture one') },
      { name: 'second.flac', mimeType: 'audio/flac', buffer: Buffer.from('fixture two') },
      { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('not audio') },
    ]);
    samples.push(await readable(imports.locator('.import-music__notice'), 'import warning'));
    const importButton = imports.getByRole('button', { name: 'Import 2 tracks', exact: true });
    samples.push(await readable(importButton, 'primary import button'));
    await importButton.click();
    await expect(imports.getByText('Fixture storage error.', { exact: true })).toBeVisible();
    samples.push(await readable(imports.locator('.is-imported .import-music__file-status'), 'import success status'));
    samples.push(await readable(imports.locator('.is-error .import-music__file-status'), 'import error status'));
    await testInfo.attach('contrast samples', { body: Buffer.from(JSON.stringify(samples, null, 2)), contentType: 'application/json' });
  });
}

test('keeps settings inside a phone viewport', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const settings = await openSettings(page);
  await settings.getByRole('combobox', { name: 'Dark theme', exact: true }).selectOption('solarized');
  await settings.getByRole('combobox', { name: 'Mode', exact: true }).selectOption('dark');
  const bounds = await settings.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(844);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await page.screenshot({ path: testInfo.outputPath('settings-mobile.png'), animations: 'disabled' });
});

test('captures theme comparisons with the same explicit review library', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await expect(page.locator('tbody tr')).toHaveCount(120);
  await writeFile(testInfo.outputPath('theme-library.json'), JSON.stringify(fixtureItems));
  for (const [theme, mode] of [['solarized', 'dark'], ['catppuccin', 'dark'], ['catppuccin', 'light']] as const) {
    await chooseTheme(page, theme, mode);
    await page.screenshot({ path: testInfo.outputPath(`${theme}-${mode}.png`), animations: 'disabled' });
  }
  await openSettings(page);
  await page.screenshot({ path: testInfo.outputPath('settings.png'), animations: 'disabled' });
});
