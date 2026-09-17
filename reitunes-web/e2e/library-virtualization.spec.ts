import { expect, test, type Page } from '@playwright/test';

async function library(page: Page) {
  const items = Array.from({ length: 3000 }, (_, index) => ({
    id: `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`,
    name: `Track ${String(index).padStart(5, '0')}`, artist: 'Artist', album: 'Album',
    created_time_utc: '2026-09-17T00:00:00', file_path: `${index}.mp3`, url: '/unused.mp3',
    track_number: index, play_count: 0, bookmarks: {},
  }));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route('**/api/items', r => r.fulfill({ json: items }));
  await page.route('**/api/tags', r => r.fulfill({ json: { enabled: false, items: {} } }));
  await page.route('**/api/playlists', r => r.fulfill({ json: [] }));
  await page.route('**/api/discovery', r => r.fulfill({ json: { sources: [], entries: [] } }));
  await page.route('**/api/sonos/status', r => r.fulfill({ json: { configured: false, connected: false } }));
  await page.route('**/api/log', r => r.fulfill({ status: 200 }));
  await page.route('**/ui/play', r => r.fulfill({ status: 200 }));
  await page.route('**/unused.mp3', r => r.fulfill({ contentType: 'audio/mpeg', body: '' }));
  await page.routeWebSocket('**/updates', () => {});
  await page.addInitScript(() => {
    HTMLMediaElement.prototype.play = function() { return Promise.resolve(); };
  });
  await page.goto('/');
  await expect(page.getByRole('table', { name: 'Tracks' })).toHaveAttribute('aria-rowcount', '3001');
}

test('virtual scrolling reaches the end, resets for search and sort, and keeps the complete playback order', async ({ page }) => {
  await library(page);
  const table = page.getByRole('table', { name: 'Tracks' });
  const tracks = table.locator('tbody tr[data-item-id]');
  expect(await tracks.count()).toBeLessThan(100);
  await table.evaluate(table => { table.parentElement!.scrollTop = table.parentElement!.scrollHeight; });
  await expect(tracks.last()).toContainText('Track 02999');
  await expect.poll(() => tracks.last().evaluate(row => {
    const bounds = row.getBoundingClientRect();
    const scroller = row.closest('table')!.parentElement!.getBoundingClientRect();
    return bounds.bottom <= scroller.bottom + 1 && bounds.top >= scroller.top;
  })).toBe(true);
  await page.getByRole('searchbox', { name: 'Search library' }).fill('Track 00010');
  await expect(tracks).toHaveCount(1);
  await expect(tracks.first()).toContainText('Track 00010');
  await page.getByRole('button', { name: 'Clear search', exact: true }).click();
  await expect(tracks.first()).toContainText('Track 00000');
  await table.getByRole('columnheader', { name: /^Name/ }).getByRole('button').click();
  await table.getByRole('columnheader', { name: /^Name/ }).getByRole('button').click();
  await expect(tracks.first()).toContainText('Track 02999');
  await tracks.first().press('Enter');
  await expect(page.locator('tbody tr[aria-current="true"]')).toContainText('Track 02999');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.locator('tbody tr[aria-current="true"]')).toContainText('Track 02998');
  expect(await tracks.count()).toBeLessThan(100);
});

test('keyboard navigation crosses virtual windows and an inline edit survives scrolling away', async ({ page }) => {
  await library(page);
  const table = page.getByRole('table', { name: 'Tracks' });
  await table.locator('tbody tr[data-item-id]').first().focus();
  await page.keyboard.press('End');
  await expect(table.locator('tr:focus')).toContainText('Track 02999');
  await expect(table.locator('tr:focus')).toHaveAttribute('aria-rowindex', '3001');
  await page.keyboard.press('ArrowUp');
  await expect(table.locator('tr:focus')).toContainText('Track 02998');
  await page.keyboard.press('Home');
  await expect(table.locator('tr:focus')).toContainText('Track 00000');
  for (let index = 0; index < 60; index++) await page.keyboard.press('ArrowDown');
  await expect(table.locator('tr:focus')).toHaveAttribute('aria-rowindex', '62');
  await table.locator('tr:focus td[data-column="name"]').dblclick();
  const editor = table.getByRole('textbox');
  await editor.fill('Unsaved title');
  await table.evaluate(table => { table.parentElement!.scrollTop = table.parentElement!.scrollHeight; });
  await expect(editor).toHaveValue('Unsaved title');
  await expect(editor).toBeFocused();
  expect(await table.locator('tbody tr[data-item-id]').count()).toBeLessThan(100);
  await editor.press('Escape');
  await expect(editor).toHaveCount(0);
});
