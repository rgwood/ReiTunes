import { expect, test, type Page } from './fixtures/test';
import type { LibraryItem } from '../src/types';

async function setup(page: Page) {
  let items: LibraryItem[] = ['Alpha', 'Bravo', 'Charlie', 'Delta'].map((name, index) => ({
    id: `bulk-${index}`, name, artist: 'Test artist', album: 'Test album', is_favorite: index === 1,
    file_path: `${index}.mp3`, url: `/audio/${index}.mp3`, created_time_utc: `2026-01-0${index + 1}T00:00:00`,
    play_count: 0, bookmarks: {},
  }));
  const deleted: string[] = [];
  const favourites: Array<{ id: string; favourite: boolean }> = [];
  const failures = new Set<string>();
  await page.route('**/api/items', route => route.fulfill({ json: items }));
  await page.route('**/api/playlists', route => route.fulfill({ json: [] }));
  await page.route('**/api/tags', route => route.fulfill({ json: { enabled: false, items: {} } }));
  await page.route('**/api/discovery', route => route.fulfill({ json: { sources: [], entries: [] } }));
  await page.route('**/api/sonos/status', route => route.fulfill({ json: { configured: false, connected: false } }));
  await page.route('**/api/lastfm/status', route => route.fulfill({ json: { configured: false, connected: false } }));
  await page.route('**/api/log', route => route.fulfill({ status: 200 }));
  await page.route('**/ui/delete', route => {
    const id = route.request().postDataJSON().id as string;
    deleted.push(id);
    if (failures.has(id)) return route.fulfill({ status: 500 });
    items = items.filter(item => item.id !== id);
    return route.fulfill({ status: 200 });
  });
  await page.route(/\/ui\/bulk-\d+\/(unfavorite|favorite)$/, route => {
    const match = route.request().url().match(/\/ui\/(bulk-\d+)\/(unfavorite|favorite)$/)!;
    const id = match[1], favourite = match[2] === 'favorite';
    favourites.push({ id, favourite });
    if (failures.has(id)) return route.fulfill({ status: 500 });
    items = items.map(item => item.id === id ? { ...item, is_favorite: favourite } : item);
    return route.fulfill({ status: 200 });
  });
  await page.routeWebSocket('**/updates', () => {});
  page.on('dialog', dialog => { throw new Error(`Unexpected native dialog: ${dialog.message()}`); });
  await page.goto('/');
  await expect(page.locator('tbody tr[data-item-id]')).toHaveCount(4);
  await page.locator('th[data-column=name] button').click();
  return { deleted, favourites, failures };
}

const row = (page: Page, name: string) => page.getByRole('row').filter({ hasText: name });
const toolbar = (page: Page) => page.getByRole('toolbar', { name: 'Selected song actions' });
async function select(page: Page, ...names: string[]) {
  for (let index = 0; index < names.length; index++) {
    await row(page, names[index]).locator('[data-column=name]').click({ modifiers: index ? ['Control'] : [] });
  }
}

test('bulk delete confirms the whole selection, can cancel, and updates rows without WebSocket events', async ({ page }, info) => {
  const { deleted } = await setup(page);
  await select(page, 'Alpha', 'Bravo', 'Charlie');
  await expect(toolbar(page)).toContainText('3 selected');
  await row(page, 'Bravo').click({ button: 'right' });
  await page.getByRole('button', { name: 'Delete 3 songs from Library…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Delete 3 songs?' });
  await expect(dialog.getByRole('list', { name: 'Selected songs' }).getByRole('listitem')).toHaveText([
    'Alpha — Test artist', 'Bravo — Test artist', 'Charlie — Test artist',
  ]);
  await expect(dialog).toContainText('audio files will also be permanently deleted');
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  expect(deleted).toEqual([]);
  await toolbar(page).getByRole('button', { name: 'Delete…', exact: true }).click();
  await page.screenshot({ path: info.outputPath('bulk-delete-confirmation.png') });
  await dialog.getByRole('button', { name: 'Delete 3 songs', exact: true }).click();
  await expect(page.locator('tbody tr[data-item-id]')).toHaveCount(1);
  await expect(row(page, 'Delta')).toBeVisible();
  expect(deleted).toEqual(['bulk-0', 'bulk-1', 'bulk-2']);
  await page.reload();
  await expect(page.locator('tbody tr[data-item-id]')).toHaveCount(1);
});

test('partial deletion retains failed rows and retries only those songs', async ({ page }) => {
  const { deleted, failures } = await setup(page);
  failures.add('bulk-1');
  await select(page, 'Alpha', 'Bravo', 'Charlie');
  await row(page, 'Charlie').press('Delete');
  await page.getByRole('dialog', { name: 'Delete 3 songs?' }).getByRole('button', { name: 'Delete 3 songs', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('2 of 3 songs deleted. 1 failed');
  await expect(page.locator('tbody tr[aria-selected=true]')).toHaveCount(1);
  await expect(row(page, 'Bravo')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('tbody tr[data-item-id]')).toHaveCount(2);
  failures.clear();
  await page.getByRole('button', { name: 'Retry failed changes', exact: true }).click();
  await page.getByRole('dialog', { name: 'Delete song?' }).getByRole('button', { name: 'Delete song', exact: true }).click();
  await expect(page.locator('tbody tr[data-item-id]')).toHaveCount(1);
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(deleted).toEqual(['bulk-0', 'bulk-1', 'bulk-2', 'bulk-1']);
});

test('pending deletion shows progress and cannot be submitted again', async ({ page }) => {
  const { deleted } = await setup(page);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let started = 0;
  await page.route('**/ui/delete', async route => {
    started++;
    if (started === 1) await gate;
    await route.fallback();
  });
  try {
    await select(page, 'Alpha', 'Charlie');
    await toolbar(page).getByRole('button', { name: 'Delete…', exact: true }).click();
    await page.getByRole('dialog', { name: 'Delete 2 songs?' }).getByRole('button', { name: 'Delete 2 songs', exact: true }).click();
    await expect(toolbar(page).getByRole('status')).toContainText('Deleting… 0 of 2');
    await expect(toolbar(page).getByRole('button', { name: 'Delete…', exact: true })).toBeDisabled();
    await row(page, 'Charlie').press('Delete');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(started).toBe(1);
    release();
    await expect(page.locator('tbody tr[data-item-id]')).toHaveCount(2);
    expect(deleted).toEqual(['bulk-0', 'bulk-2']);
  } finally { release(); }
});

test('favourites set the desired state for mixed selections without toggling existing favourites', async ({ page }, info) => {
  const { favourites } = await setup(page);
  await select(page, 'Alpha', 'Bravo', 'Charlie');
  await page.screenshot({ path: info.outputPath('bulk-selection-toolbar.png') });
  await toolbar(page).getByRole('button', { name: 'Add to favourites', exact: true }).click();
  await expect(toolbar(page)).toHaveAttribute('aria-busy', 'false');
  await expect(toolbar(page).getByRole('button', { name: 'Add to favourites', exact: true })).toBeDisabled();
  expect(favourites).toEqual([{ id: 'bulk-0', favourite: true }, { id: 'bulk-2', favourite: true }]);
  await expect(row(page, 'Bravo').getByRole('button', { name: '♥', exact: true })).toBeVisible();
  await expect(row(page, 'Delta').getByRole('button', { name: '♡', exact: true })).toBeVisible();
  await row(page, 'Bravo').click({ button: 'right' });
  await page.locator('.library-context-menu').getByRole('button', { name: 'Remove from favourites', exact: true }).click();
  await expect(toolbar(page)).toHaveAttribute('aria-busy', 'false');
  await expect(toolbar(page).getByRole('button', { name: 'Remove from favourites', exact: true })).toBeDisabled();
  expect(favourites.slice(2)).toEqual(['bulk-0', 'bulk-1', 'bulk-2'].map(id => ({ id, favourite: false })));
  await page.reload();
  await expect(page.getByRole('button', { name: '♥', exact: true })).toHaveCount(0);
});

test('failed favourite changes can retry without repeating successful writes', async ({ page }) => {
  const { favourites, failures } = await setup(page);
  failures.add('bulk-2');
  await select(page, 'Alpha', 'Bravo', 'Charlie');
  await toolbar(page).getByRole('button', { name: 'Add to favourites', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('2 of 3 songs updated. 1 failed');
  await expect(row(page, 'Charlie')).toHaveAttribute('aria-selected', 'true');
  failures.clear();
  await page.getByRole('button', { name: 'Retry failed changes', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(row(page, 'Charlie').getByRole('button', { name: '♥', exact: true })).toBeVisible();
  expect(favourites).toEqual([{ id: 'bulk-0', favourite: true }, { id: 'bulk-2', favourite: true }, { id: 'bulk-2', favourite: true }]);
});

test('Ctrl+A deletes only the filtered view, and right-clicking an unselected row acts on that row', async ({ page }) => {
  const { deleted } = await setup(page);
  await select(page, 'Alpha', 'Bravo');
  await page.getByRole('searchbox', { name: 'Search library' }).fill('Charlie');
  await expect(page.locator('tbody tr[data-item-id]')).toHaveCount(1);
  await row(page, 'Charlie').click();
  await row(page, 'Charlie').press('Control+a');
  await row(page, 'Charlie').press('Delete');
  await page.getByRole('dialog', { name: 'Delete song?' }).getByRole('button', { name: 'Delete song', exact: true }).click();
  await expect(page.locator('tbody tr[data-item-id]')).toHaveCount(0);
  expect(deleted).toEqual(['bulk-2']);
  await page.getByRole('searchbox', { name: 'Search library' }).fill('');
  await expect(page.locator('tbody tr[data-item-id]')).toHaveCount(3);
  await select(page, 'Alpha', 'Bravo');
  await row(page, 'Delta').click({ button: 'right' });
  await page.getByRole('button', { name: 'Delete from Library', exact: false }).click();
  await page.getByRole('dialog', { name: 'Delete song?' }).getByRole('button', { name: 'Delete song', exact: true }).click();
  await expect(page.locator('tbody tr[data-item-id]')).toHaveCount(2);
  expect(deleted).toEqual(['bulk-2', 'bulk-3']);
});
