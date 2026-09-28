import { expect, test, type Locator, type Page } from './fixtures/test';
import type { LibraryItem, Playlist } from '../src/types';

const songs: LibraryItem[] = ['Zulu', 'Delta', 'Bravo', 'Echo', 'Alpha'].map((name, index) => ({
  id: `11111111-1111-4111-8111-11111111111${index}`,
  name, artist: name === 'Bravo' ? 'Hidden artist' : 'Visible artist', album: 'Selection tests',
  track_number: index + 1, created_time_utc: '2026-01-01T00:00:00',
  file_path: `${index}.mp3`, url: `/audio/${index}.mp3`, play_count: 0, bookmarks: {},
}));
const ids = (...names: string[]) => names.map(name => songs.find(song => song.name === name)!.id);
const row = (page: Page, name: string) => page.locator(`tr[data-item-id="${ids(name)[0]}"]`);
const cell = (page: Page, name: string) => row(page, name).locator('[data-column=name]');
const selected = (page: Page) => page.locator('tbody tr[aria-selected=true] [data-column=name]');

async function setup(page: Page) {
  const playlist: Playlist = { id: 'p1', name: 'Selected songs', items: {} };
  const additions: string[][] = [];
  const plays: unknown[] = [];
  await page.route('**/api/items', route => route.fulfill({ json: songs }));
  await page.route('**/api/tags', route => route.fulfill({ json: { enabled: false, items: {} } }));
  await page.route('**/api/playlists', route => route.fulfill({ json: [playlist] }));
  await page.route('**/api/playlists/p1/items', route => {
    const added = route.request().postDataJSON().library_item_ids as string[];
    additions.push(added);
    for (const id of added) {
      if (!playlist.items[id]) playlist.items[id] = { library_item_id: id, position: Object.keys(playlist.items).length };
    }
    return route.fulfill({ status: 200 });
  });
  await page.route('**/api/sonos/status', route => route.fulfill({ json: { configured: false, connected: false } }));
  await page.route('**/api/discovery', route => route.fulfill({ json: { sources: [], entries: [], refreshing: false } }));
  await page.route('**/api/log', route => route.fulfill({ status: 200 }));
  await page.route('**/ui/play', route => {
    plays.push(route.request().postDataJSON());
    return route.fulfill({ status: 200 });
  });
  await page.routeWebSocket('**/updates', () => {});
  await page.goto('/');
  await expect(page.locator('tbody tr[data-item-id]')).toHaveCount(songs.length);
  await page.locator('th[data-column=name] button').click();
  await expect(page.locator('tbody tr[data-item-id] [data-column=name]')).toHaveText(['Alpha', 'Bravo', 'Delta', 'Echo', 'Zulu']);
  return { additions, plays };
}

async function pointerDrag(page: Page, source: Locator, target: Locator, selectedNames: string[]) {
  const origin = await source.boundingBox();
  const destination = await target.boundingBox();
  expect(origin).not.toBeNull();
  expect(destination).not.toBeNull();
  await page.mouse.move(origin!.x + 25, origin!.y + origin!.height / 2);
  await page.mouse.down();
  // A drag begins with an ordinary pointer down on a selected row. That must
  // retain the group until we know whether the gesture is a click or a drag.
  if (selectedNames.length > 1) await expect(selected(page)).toHaveText(selectedNames);
  await page.mouse.move(origin!.x + 40, origin!.y + origin!.height / 2, { steps: 5 });
  await expect(page.locator('.library-drag-count')).toHaveText(selectedNames.length > 1 ? `${selectedNames.length} tracks` : '1 track');
  await expect(page.locator('.library-drag-track span')).toHaveText(selectedNames.slice(0, 3));
  await expect(page.locator('.library-drag-track small')).toHaveText(selectedNames.slice(0, 3).map(name => songs.find(song => song.name === name)!.artist));
  if (selectedNames.length > 3) await expect(page.locator('.library-drag-more')).toHaveText(`+${selectedNames.length - 3} more`);
  else await expect(page.locator('.library-drag-more')).toHaveCount(0);
  await page.mouse.move(destination!.x + destination!.width / 2, destination!.y + destination!.height / 2, { steps: 15 });
  await page.mouse.up();
}

for (const modifier of ['Control', 'Meta'] as const) {
  test(`${modifier}-selected songs drag together to a playlist in grid order`, async ({ page }) => {
    const { additions, plays } = await setup(page);
    await cell(page, 'Echo').click();
    await cell(page, 'Alpha').click({ modifiers: [modifier] });
    await cell(page, 'Delta').click({ modifiers: [modifier] });
    await cell(page, 'Alpha').click({ modifiers: [modifier] });
    await expect(selected(page)).toHaveText(['Delta', 'Echo']);
    await cell(page, 'Alpha').click({ modifiers: [modifier] });
    await expect(selected(page)).toHaveText(['Alpha', 'Delta', 'Echo']);
    await expect(page.locator('.library-selection-count')).toContainText('3 selected');
    await page.mouse.move(0, 0);
    expect(await row(page, 'Alpha').evaluate(element => getComputedStyle(element).backgroundColor))
      .not.toBe(await row(page, 'Bravo').evaluate(element => getComputedStyle(element).backgroundColor));

    const target = page.getByRole('button', { name: 'Selected songs', exact: true });
    await pointerDrag(page, cell(page, 'Delta'), target, ['Alpha', 'Delta', 'Echo']);
    await expect.poll(() => additions).toEqual([ids('Alpha', 'Delta', 'Echo')]);
    await expect(selected(page)).toHaveText(['Alpha', 'Delta', 'Echo']);
    await expect(page.getByRole('textbox', { name: /^Edit / })).toHaveCount(0);
    await target.click();
    await expect(page.locator('tbody tr[data-item-id] [data-column=name]')).toHaveText(['Alpha', 'Delta', 'Echo']);
    expect(plays).toEqual([]);
  });
}

test('Shift selects the visible sorted range and appends it to the queue once', async ({ page }, testInfo) => {
  const { plays } = await setup(page);
  await page.getByRole('searchbox', { name: 'Search library' }).fill('Visible artist');
  await expect(page.locator('tbody tr[data-item-id]')).toHaveCount(4);
  await cell(page, 'Echo').click();
  await cell(page, 'Alpha').click({ modifiers: ['Shift'] });
  await expect(selected(page)).toHaveText(['Alpha', 'Delta', 'Echo']);
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('');
  await pointerDrag(page, cell(page, 'Delta'), page.getByRole('button', { name: 'Queue', exact: true }), ['Alpha', 'Delta', 'Echo']);
  const panel = page.getByRole('region', { name: 'Up Next', exact: true });
  const added = panel.getByRole('region', { name: 'Added to queue' });
  await expect(added.locator('.queue-track-text > span')).toHaveText(['Alpha', 'Delta', 'Echo']);
  await expect(selected(page)).toHaveText(['Alpha', 'Delta', 'Echo']);
  await expect(page.locator('.library-selection-count')).toContainText('3 selected');
  await page.screenshot({ path: testInfo.outputPath('selected-tracks-and-queue.png') });
  expect(plays).toEqual([]);
});

test('plain click collapses a group while dragging a deselected row adds only that row', async ({ page }) => {
  const { additions, plays } = await setup(page);
  await cell(page, 'Alpha').click();
  await cell(page, 'Echo').click({ modifiers: ['Shift'] });
  await expect(selected(page)).toHaveText(['Alpha', 'Bravo', 'Delta', 'Echo']);
  await cell(page, 'Delta').click();
  await expect(selected(page)).toHaveText(['Delta']);
  await expect(page.locator('.library-selection-count')).toContainText('1 selected');
  await cell(page, 'Echo').click({ modifiers: ['Control'] });
  await expect(selected(page)).toHaveText(['Delta', 'Echo']);
  await pointerDrag(page, cell(page, 'Zulu'), page.getByRole('button', { name: 'Selected songs', exact: true }), ['Zulu']);
  await expect.poll(() => additions).toEqual([ids('Zulu')]);
  await expect(selected(page)).toHaveText(['Zulu']);
  // Starting a new drag also moves the Shift anchor to that row.
  await cell(page, 'Echo').click({ modifiers: ['Shift'] });
  await expect(selected(page)).toHaveText(['Echo', 'Zulu']);
  expect(plays).toEqual([]);
});

test('filtering an existing selection excludes hidden rows when dragging to the open queue', async ({ page }) => {
  const { plays } = await setup(page);
  await cell(page, 'Bravo').click();
  await cell(page, 'Echo').click({ modifiers: ['Control'] });
  await cell(page, 'Alpha').click({ modifiers: ['Control'] });
  await page.getByRole('searchbox', { name: 'Search library' }).fill('Visible artist');
  await expect(page.locator('tbody tr[data-item-id]')).toHaveCount(4);
  await expect(selected(page)).toHaveText(['Alpha', 'Echo']);
  await page.getByRole('button', { name: 'Queue', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Up Next', exact: true });
  await pointerDrag(page, cell(page, 'Echo'), panel.locator('h2'), ['Alpha', 'Echo']);
  await expect(panel.getByRole('region', { name: 'Added to queue' }).locator('.queue-track-text > span'))
    .toHaveText(['Alpha', 'Echo']);
  expect(plays).toEqual([]);
});

for (const modifier of ['Control', 'Meta', 'Shift'] as const) {
  test(`rapid ${modifier}-clicks select without playing a song or selecting its text`, async ({ page }) => {
    const { plays } = await setup(page);
    await cell(page, 'Alpha').click();
    await cell(page, 'Echo').dblclick({ modifiers: [modifier] });
    await expect(selected(page)).toHaveText(modifier === 'Shift' ? ['Alpha', 'Bravo', 'Delta', 'Echo'] : ['Alpha']);
    await expect(page.locator('audio')).not.toHaveAttribute('src');
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('');
    expect(plays).toEqual([]);
  });
}

test('Ctrl+Shift extends a range while retaining a separate selection', async ({ page }) => {
  const { additions, plays } = await setup(page);
  await cell(page, 'Zulu').click();
  await cell(page, 'Alpha').click({ modifiers: ['Control'] });
  await cell(page, 'Delta').click({ modifiers: ['Control', 'Shift'] });
  await expect(selected(page)).toHaveText(['Alpha', 'Bravo', 'Delta', 'Zulu']);
  await pointerDrag(page, cell(page, 'Bravo'), page.getByRole('button', { name: 'Selected songs', exact: true }), ['Alpha', 'Bravo', 'Delta', 'Zulu']);
  await expect.poll(() => additions).toEqual([ids('Alpha', 'Bravo', 'Delta', 'Zulu')]);
  expect(plays).toEqual([]);
});
