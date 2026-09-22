import { expect, test, type Page } from '@playwright/test';
import type { LibraryItem } from '../src/types';

async function setup(page: Page) {
  const items: LibraryItem[] = ['Northern Sky', 'Pink Moon'].map((name, index) => ({
    id: `11111111-1111-4111-8111-11111111111${index}`,
    name, artist: 'Nick Drake', album: 'Bryter Layter', track_number: 7,
    created_time_utc: `2026-01-0${2 - index}T00:00:00`, file_path: `${index}.mp3`,
    url: `/audio/${index}.mp3`, play_count: 0, bookmarks: {},
  }));
  const writes: { id: string; field: string; value: string }[] = [];
  const plays: string[] = [];
  await page.route('**/api/items', route => route.fulfill({ json: items }));
  await page.route('**/api/playlists', route => route.fulfill({ json: [] }));
  await page.route('**/api/log', route => route.fulfill({ status: 200 }));
  await page.route('**/ui/play', route => { plays.push(route.request().postDataJSON().id); return route.fulfill({ status: 200 }); });
  await page.route('**/audio/*.mp3', route => route.fulfill({ contentType: 'audio/mpeg', body: '' }));
  await page.routeWebSocket('**/updates', () => {});
  await page.route('**/ui/update', route => {
    const body = route.request().postDataJSON();
    writes.push(body);
    const item = items.find(item => item.id === body.id)!;
    Object.assign(item, { [body.field]: body.field === 'track_number' ? (body.value === '' ? null : Number(body.value)) : body.value });
    return route.fulfill({ status: 200 });
  });
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
  await page.goto('/');
  await expect(page.locator('tbody tr')).toHaveCount(2);
  return { items, writes, plays };
}

test('click and arrows select without playing; double-click and Enter play', async ({ page }) => {
  const { items, plays } = await setup(page);
  const first = page.getByRole('row').filter({ hasText: 'Northern Sky' });
  const second = page.getByRole('row').filter({ hasText: 'Pink Moon' });
  await first.locator('[data-column="artist"]').click();
  await expect(first).toHaveAttribute('aria-selected', 'true');
  expect(plays).toEqual([]);
  await first.press('ArrowDown');
  await expect(second).toBeFocused();
  await expect(second).toHaveAttribute('aria-selected', 'true');
  expect(plays).toEqual([]);
  await first.locator('[data-column="artist"]').dblclick();
  await expect(first).toHaveAttribute('aria-current', 'true');
  await expect.poll(() => plays).toEqual([items[0].id]);
  await expect(page.getByRole('textbox', { name: 'Edit artist' })).toHaveCount(0);
  await second.click();
  await expect(first).toHaveAttribute('aria-current', 'true');
  await expect(page.locator('audio')).toHaveJSProperty('paused', false);
  expect(plays).toEqual([items[0].id]);
  await second.locator('[data-column="artist"]').click();
  await second.press('F2');
  const artist = page.getByRole('textbox', { name: 'Edit artist' });
  await artist.fill('Updated while another song plays');
  await artist.press('Enter');
  await expect(artist).toHaveCount(0);
  await expect(first).toHaveAttribute('aria-current', 'true');
  await expect(page.locator('audio')).toHaveJSProperty('paused', false);
  expect(plays).toEqual([items[0].id]);
  await second.press('Enter');
  await expect(second).toHaveAttribute('aria-current', 'true');
  await expect.poll(() => plays).toEqual([items[0].id, items[1].id]);
});

test('F2 edits the selected field, saves once with Enter and cancels with Escape', async ({ page }) => {
  const { writes, plays } = await setup(page);
  const row = page.getByRole('row').filter({ hasText: 'Northern Sky' });
  await row.locator('[data-column="artist"]').click();
  await row.press('F2');
  const artist = page.getByRole('textbox', { name: 'Edit artist' });
  await expect(artist).toBeFocused();
  await artist.fill('Discard this');
  await artist.press('Escape');
  await expect(artist).toHaveCount(0);
  await expect(row).toBeFocused();
  expect(writes).toEqual([]);
  await row.press('F2');
  await artist.fill('Corrected artist');
  await artist.press('Enter');
  await expect(artist).toHaveCount(0);
  await expect(row.locator('[data-column="artist"]')).toHaveText('Corrected artist');
  expect(writes).toHaveLength(1);
  expect(plays).toEqual([]);
  await row.press('ArrowRight');
  await row.press('F2');
  const album = page.getByRole('textbox', { name: 'Edit album' });
  await album.fill('New album');
  const next = page.getByRole('row').filter({ hasText: 'Pink Moon' });
  await next.click();
  await expect(album).toHaveCount(0);
  await expect(next).toHaveAttribute('aria-selected', 'true');
  await expect(next).toBeFocused();
  expect(writes).toHaveLength(2);
  expect(plays).toEqual([]);
  await page.reload();
  await expect(page.getByRole('row').filter({ hasText: 'Northern Sky' })).toContainText('Corrected artist');
});

test('failed inline saves retain the draft for retry without playing', async ({ page }) => {
  const { writes, plays } = await setup(page);
  let fail = true;
  await page.route('**/ui/update', route => fail ? route.fulfill({ status: 500 }) : route.fallback());
  const row = page.getByRole('row').filter({ hasText: 'Northern Sky' });
  await row.locator('[data-column="album"]').click();
  await row.press('F2');
  const input = page.getByRole('textbox', { name: 'Edit album' });
  await input.fill('New album');
  await input.press('Enter');
  await expect(page.getByRole('alert')).toContainText('Could not save');
  await expect(input).toHaveValue('New album');
  await expect(input).toBeFocused();
  fail = false;
  await input.press('Enter');
  await expect(input).toHaveCount(0);
  expect(writes).toHaveLength(1);
  expect(plays).toEqual([]);
});

test('Get Info and Ctrl+I edit multiple fields with cancellation and partial-save retry', async ({ page }) => {
  const { writes, plays } = await setup(page);
  let failArtist = true;
  await page.route('**/ui/update', route => {
    if (failArtist && route.request().postDataJSON().field === 'artist') return route.fulfill({ status: 500 });
    return route.fallback();
  });
  const row = page.getByRole('row').filter({ hasText: 'Northern Sky' });
  await row.click({ button: 'right' });
  await page.getByRole('button', { name: /Get Info/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Song info' });
  await dialog.getByRole('textbox', { name: 'Artist', exact: true }).fill('Discard this');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(row).toBeFocused();
  expect(writes).toEqual([]);
  await row.press('Control+i');
  await expect(dialog.getByRole('textbox', { name: 'Artist', exact: true })).toHaveValue('Nick Drake');
  await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('New name');
  await dialog.getByRole('textbox', { name: 'Artist', exact: true }).fill('New artist');
  await dialog.getByRole('textbox', { name: 'Album', exact: true }).fill('');
  await dialog.getByRole('spinbutton', { name: 'Track number' }).fill('');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Could not save all changes');
  await expect(dialog.getByRole('textbox', { name: 'Artist', exact: true })).toHaveValue('New artist');
  failArtist = false;
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(writes.map(write => write.field)).toEqual(['name', 'artist', 'album', 'track_number']);
  expect(plays).toEqual([]);
  await page.reload();
  const renamed = page.getByRole('row').filter({ hasText: 'New name' });
  await renamed.click();
  await renamed.press('Control+i');
  await expect(dialog.getByRole('textbox', { name: 'Artist', exact: true })).toHaveValue('New artist');
  await expect(dialog.getByRole('textbox', { name: 'Album', exact: true })).toHaveValue('');
  await expect(dialog.getByRole('spinbutton', { name: 'Track number' })).toHaveValue('');
  await dialog.press('Escape');
  await expect(dialog).toHaveCount(0);
});

test('song info fits a phone and rejects invalid fields without touching playback', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { writes, plays } = await setup(page);
  await page.getByRole('row').filter({ hasText: 'Northern Sky' }).click({ button: 'right' });
  await page.getByRole('button', { name: /Get Info/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Song info' });
  await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('   ');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog.getByRole('alert')).toHaveText('Enter a song name.');
  await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('Northern Sky');
  await dialog.getByRole('spinbutton', { name: 'Track number' }).fill('-1');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).toBeVisible();
  expect(writes).toEqual([]);
  expect(plays).toEqual([]);
  await dialog.getByRole('spinbutton', { name: 'Track number' }).fill('7');
  await page.screenshot({ path: testInfo.outputPath('song-info-mobile.png') });
  const bounds = await dialog.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
});
