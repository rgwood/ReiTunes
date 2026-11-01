import { expect, test } from './fixtures/test';

const song = '11111111-1111-4111-8111-111111111111';
const page1 = {
  total: 3, matching: 3,
  type_counts: { LibraryItemPlayedEvent: 2, LibraryItemNameChangedEvent: 1 },
  replay: { elapsed_ms: 41.2, matches_live: true, drifted: [] },
  events: [
    { id: 'e3', aggregate_id: song, aggregate_type: 'LibraryItem', aggregate_name: 'New name', created_time_utc: '2026-10-03T12:00:00.5', machine_name: 'spudnik',
      event_type: 'LibraryItemPlayedEvent', payload: { $type: 'LibraryItemPlayedEvent' }, changes: [{ field: 'play_count', before: 1, after: 2 }] },
    { id: 'e2', aggregate_id: song, aggregate_type: 'LibraryItem', aggregate_name: 'New name', created_time_utc: '2026-10-02T12:00:00', machine_name: 'TATERTOT',
      event_type: 'LibraryItemNameChangedEvent', payload: { $type: 'LibraryItemNameChangedEvent', NewName: 'New name' }, changes: [{ field: 'name', before: 'Old name', after: 'New name' }] },
  ],
  next_before: 'e2',
};
const page2 = {
  ...page1,
  events: [{ id: 'e1', aggregate_id: song, aggregate_type: 'LibraryItem', aggregate_name: 'Old name', created_time_utc: '2026-10-01T12:00:00', machine_name: 'spudnik',
    event_type: 'LibraryItemPlayedEvent', payload: { $type: 'LibraryItemPlayedEvent' }, changes: [] }],
  next_before: null,
};

test('event history shows what changed, filters, and pages back', async ({ page }) => {
  const requests: URLSearchParams[] = [];
  await page.route('**/api/items', route => route.fulfill({ json: [] }));
  await page.route('**/api/playlists', route => route.fulfill({ json: [] }));
  await page.route('**/api/sonos/status', route => route.fulfill({ json: { configured: false, connected: false } }));
  await page.route('**/api/log', route => route.fulfill({ status: 200 }));
  await page.routeWebSocket('**/updates', () => {});
  await page.route('**/api/events?*', route => {
    const params = new URL(route.request().url()).searchParams;
    requests.push(params);
    return route.fulfill({ json: params.get('before') ? page2 : page1 });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Event history' }).click();
  const renamed = page.getByRole('row').filter({ hasText: 'TATERTOT' });
  await expect(renamed).toContainText('Name Changed');
  await expect(renamed).toContainText('name Old name → New name');
  await expect(page.getByRole('status').filter({ hasText: 'matches live state' })).toContainText('3 events');

  await page.getByRole('button', { name: 'Load older events' }).click();
  await expect(page.getByText('no change')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Load older events' })).toBeHidden();

  await renamed.click();
  await expect(page.locator('.event-detail')).toContainText('"NewName": "New name"');

  await page.getByRole('combobox', { name: 'Event type' }).selectOption('LibraryItemPlayedEvent');
  await expect.poll(() => requests.at(-1)?.get('event_type')).toBe('LibraryItemPlayedEvent');
  await page.getByRole('combobox', { name: 'Event type' }).selectOption('');

  await page.getByRole('row').filter({ hasText: 'spudnik' }).first().getByRole('button', { name: 'New name' }).click();
  await expect.poll(() => requests.at(-1)?.get('aggregate')).toBe(song);

  await page.getByRole('searchbox', { name: 'Search events' }).fill('moon');
  await expect.poll(() => requests.at(-1)?.get('q')).toBe('moon');
});
