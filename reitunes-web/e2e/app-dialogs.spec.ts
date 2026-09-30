import { expect, test } from './fixtures/test';

test.beforeEach(async ({ page }) => {
  // Any browser popup is a regression, including paths reached after an error.
  page.on('dialog', dialog => { throw new Error(`Unexpected native popup: ${dialog.message()}`); });
  await page.route('**/api/items', route => route.fulfill({ json: [{
    id: 'song', name: 'Northern Sky', artist: 'Nick Drake', album: 'Bryter Layter',
    created_time_utc: '2026-09-01T00:00:00', file_path: 'song.mp3', play_count: 0, bookmarks: {},
  }] }));
  await page.route('**/api/playlists', route => route.fulfill({ json: [{ id: 'party', name: 'Housewarming', items: {} }] }));
  await page.route('**/api/tags', route => route.fulfill({ json: { enabled: false, items: {} } }));
  await page.route('**/api/discovery', route => route.fulfill({ json: { sources: [], entries: [] } }));
  await page.route('**/api/log', route => route.fulfill({ status: 200 }));
  await page.routeWebSocket('**/updates', () => {});
});

test('song deletion can be cancelled and a failed deletion shows a themed message', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  let deletes = 0;
  await page.route('**/ui/delete', route => { deletes++; return route.fulfill({ status: 500 }); });
  await page.goto('/');
  const row = page.getByRole('row').filter({ hasText: 'Northern Sky' });
  await row.click({ button: 'right' });
  await page.getByText('Delete from Library', { exact: false }).click();
  const confirmation = page.getByRole('dialog', { name: 'Delete song?' });
  await expect(confirmation).toContainText('Its audio file will also be permanently deleted');
  await expect(confirmation.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await confirmation.press('Escape');
  await expect(row).toBeFocused();
  expect(deletes).toBe(0);
  await row.click({ button: 'right' });
  await page.getByText('Delete from Library', { exact: false }).click();
  await page.screenshot({ path: testInfo.outputPath('delete-confirmation.png') });
  await confirmation.getByRole('button', { name: 'Delete song', exact: true }).click();
  const error = page.getByRole('dialog', { name: 'Could not delete song' });
  await expect(error).toContainText('Northern Sky');
  await expect(error.getByRole('button', { name: 'Close' })).toBeFocused();
  expect(deletes).toBe(1);
  await error.getByRole('button', { name: 'Close' }).click();
  await expect(error).toHaveCount(0);
  await expect(row).toBeFocused();
});

test('desktop playlist deletion uses an explicit confirmation', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  let deletes = 0;
  await page.route('**/api/playlists/party', route => { deletes++; return route.fulfill({ status: 500 }); });
  await page.goto('/');
  await page.getByRole('button', { name: 'Housewarming', exact: false }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Delete playlist' }).click();
  const dialog = page.getByRole('dialog', { name: 'Delete playlist?' });
  await expect(dialog).toContainText('The songs stay in your library.');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('button', { name: 'Housewarming', exact: true })).toBeFocused();
  expect(deletes).toBe(0);
  await page.getByRole('button', { name: 'Housewarming', exact: false }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Delete playlist' }).click();
  await dialog.getByRole('button', { name: 'Delete playlist', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Could not delete the playlist');
  expect(deletes).toBe(1);
});

test('mobile Sonos confirmation fits narrow screens and returns to the output picker', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.route('**/api/sonos/status', route => route.fulfill({ json: { configured: true, connected: true } }));
  await page.route('**/api/sonos/households', route => route.fulfill({ json: { households: [{ id: 'home' }] } }));
  await page.route('**/api/sonos/households/home/groups', route => route.fulfill({ json: {
    groups: [{ id: 'kitchen', name: 'Kitchen + 3', playerIds: [], playbackState: 'PLAYBACK_STATE_PLAYING' }], players: [],
  } }));
  await page.goto('/#playing');
  await page.getByRole('button', { name: 'Choose playback output' }).click();
  const output = page.getByRole('dialog', { name: 'Sonos', exact: true });
  await output.getByRole('button', { name: 'Use this group' }).click();
  const confirmation = page.getByRole('dialog', { name: 'Replace Sonos queue?' });
  await expect(confirmation).toContainText('Kitchen + 3');
  const bounds = (await confirmation.boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(320);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(568);
  await page.screenshot({ path: testInfo.outputPath('sonos-confirmation-mobile.png') });
  await confirmation.getByRole('button', { name: 'Cancel' }).click();
  await expect(output.getByRole('button', { name: 'Use this group' })).toBeFocused();
  await expect(output).toBeVisible();
});
