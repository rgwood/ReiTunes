import { expect, test, type Page } from '@playwright/test';
import type { LibraryItem } from '../src/types';
import type { TagSnapshot, TagLabel } from '../src/hooks/useTags';

const tracks: LibraryItem[] = ['Evening set', 'Morning piano'].map((name, index) => ({
  id: `11111111-1111-4111-8111-00000000000${index + 1}`, name, artist: 'Test artist', album: '',
  created_time_utc: '2026-09-17T00:00:00', file_path: `${index}.mp3`, track_number: null,
  play_count: 0, bookmarks: {}, url: '/test.mp3',
}));
async function backend(page: Page, enabled = true) {
  const data: TagSnapshot = { enabled, items: Object.fromEntries(tracks.map((track, index) => [track.id, {
    status: 'ready', provider: 'Z.AI', tags: (index ? ['piano'] : ['house', 'instrumental']).map(tag => ({ tag, confidence: .7, basis: 'metadata', evidence: 'Description names the genre.', sourceUrls: [] })), labels: {},
  }])) };
  const writes: string[] = [];
  await page.route('**/api/items', route => route.fulfill({ json: tracks }));
  await page.route('**/api/playlists', route => route.fulfill({ json: [] }));
  await page.route('**/api/discovery', route => route.fulfill({ json: { sources: [], entries: [], refreshing: false } }));
  await page.route('**/api/sonos/status', route => route.fulfill({ json: { configured: false, connected: false } }));
  await page.routeWebSocket('**/updates', () => {});
  await page.route('**/api/tags**', async route => {
    const request = route.request(); const path = new URL(request.url()).pathname;
    if (request.method() === 'GET') return route.fulfill({ json: data });
    writes.push(path);
    const parts = path.split('/'); const item = data.items[parts[4]];
    if (request.method() === 'PUT') { const label: TagLabel = request.postDataJSON(); item.labels[label.tag] = label; }
    if (request.method() === 'DELETE') delete item.labels[decodeURIComponent(parts[6])];
    if (path.endsWith('/classify')) {
      data.items[parts[4]] = { ...(item || { tags: [], labels: {} }), status: 'queued' };
      return route.fulfill({ json: { queued: true } });
    }
    if (path.endsWith('/queue')) {
      const ids: string[] = request.postDataJSON().itemIds;
      const queued = ids.filter(id => !data.items[id] || data.items[id].status === 'stale');
      for (const id of queued) data.items[id] = { tags: [], labels: data.items[id]?.labels || {}, status: 'queued' };
      return route.fulfill({ json: { queued: queued.length, itemIds: queued } });
    }
    return route.fulfill({ status: 204 });
  });
  return { data, writes };
}

test('automatic tags are searchable without review and removals with reasons survive reload and regeneration', async ({ page }) => {
  const { data, writes } = await backend(page);
  await page.goto('/');
  await expect(page.getByLabel('Filter by tags')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Review results' })).toHaveCount(0);
  await page.getByRole('searchbox', { name: 'Search library' }).fill('tag:house tag:instrumental artist:"Test artist"');
  await expect(page.getByRole('row').filter({ hasText: 'Evening set' })).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: 'Morning piano' })).toHaveCount(0);
  expect(writes).toEqual([]);
  await page.getByRole('button', { name: 'Edit tags for Evening set', exact: true }).click();
  const house = page.getByRole('article', { name: 'Tag house', exact: true });
  await expect(house.getByRole('button', { name: 'Accept', exact: true })).toHaveCount(0);
  await house.getByRole('button', { name: 'Remove tag house' }).click();
  await expect(page.getByRole('row').filter({ hasText: 'Evening set' })).toHaveCount(0);
  await house.getByLabel('Reason for house').fill('No house rhythm in this recording.');
  await house.getByRole('button', { name: 'Save reason' }).click();
  expect(data.items[tracks[0].id].labels.house.reason).toBe('No house rhythm in this recording.');
  await page.reload();
  await page.getByRole('button', { name: 'Edit tags for Evening set', exact: true }).click();
  await expect(house.getByLabel('Reason for house')).toHaveValue('No house rhythm in this recording.');
  await page.getByRole('button', { name: 'Regenerate tags', exact: true }).click();
  await expect(page.getByRole('button', { name: 'In progress', exact: true })).toBeDisabled();
  data.items[tracks[0].id].status = 'ready';
  await expect(page.getByRole('button', { name: 'Regenerate tags', exact: true })).toBeEnabled({ timeout: 10000 });
  await page.getByRole('searchbox', { name: 'Search library' }).fill('tag:house');
  await expect(page.getByRole('row').filter({ hasText: 'Evening set' })).toHaveCount(0);
  await house.getByRole('button', { name: 'Restore tag house' }).click();
  await expect(page.getByRole('row').filter({ hasText: 'Evening set' })).toBeVisible();
});

test('manual tags work without an API key and paid work needs an explicit action', async ({ page }) => {
  const { writes, data } = await backend(page, false);
  await page.goto('/');
  await page.getByRole('button', { name: 'Edit tags for Evening set', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Regenerate tags' })).toBeDisabled();
  expect(writes).toEqual([]);
  await page.getByLabel('New library tag').fill('Late night');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByRole('article', { name: 'Tag late-night', exact: true })).toBeVisible();
  expect(data.items[tracks[0].id].labels['late-night'].verdict).toBe('accepted');
});

for (const width of [1200, 968, 640, 390]) {
  test(`tag editor stays separate from the grid at ${width}px and follows row selection`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    const { writes } = await backend(page);
    await page.goto('/');
    const first = page.getByRole('button', { name: 'Edit tags for Evening set', exact: true });
    await expect(first).toHaveText('…');
    await first.click();
    await expect(first).toBeFocused();
    await expect(page.getByRole('heading', { name: 'Evening set', exact: true })).toBeVisible();
    await expect(page.getByLabel('Track to tag')).toHaveCount(0);
    await expect(first).toHaveAttribute('aria-pressed', 'true');
    const selectionColor = await page.locator('tr[data-tag-selected="true"]').evaluate(row => ({
      actual: getComputedStyle(row).backgroundColor,
      expected: getComputedStyle(row).getPropertyValue('--accent-soft').trim(),
    }));
    const selectedRgb = selectionColor.expected.match(/[a-f\d]{2}/gi)!.map(channel => parseInt(channel, 16));
    expect(selectionColor.actual).toBe(`rgb(${selectedRgb.join(', ')})`);
    const layout = await page.evaluate(() => {
      const panel = document.querySelector('.tag-sidepanel')!;
      const p = panel.getBoundingClientRect();
      const g = document.querySelector('.library-results')!.getBoundingClientRect();
      return {
        separate: p.left >= g.right - 1 || p.top >= g.bottom - 1,
        gridHeight: g.height,
        panelHeight: p.height,
        inside: p.right <= innerWidth && p.bottom <= innerHeight,
        background: getComputedStyle(panel).backgroundColor,
      };
    });
    expect(layout.separate).toBe(true);
    expect(layout.inside).toBe(true);
    expect(layout.gridHeight).toBeGreaterThan(150);
    expect(layout.panelHeight).toBeGreaterThan(150);
    expect(layout.background).not.toBe('rgba(0, 0, 0, 0)');
    await page.getByRole('button', { name: 'Edit tags for Morning piano', exact: true }).press('Enter');
    await expect(page.getByRole('heading', { name: 'Morning piano', exact: true })).toBeVisible();
    await expect(page.getByRole('article', { name: 'Tag piano', exact: true })).toBeVisible();
    await expect(first).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByText('No song selected', { exact: true })).toBeVisible();
    expect(writes).toEqual([]);
    await page.getByRole('button', { name: 'Close tags' }).click();
    await expect(page.getByRole('region', { name: 'Library tags' })).toHaveCount(0);
  });
}

test('tag chips browse the whole library, while Edit opens corrections without playback', async ({ page }) => {
  await backend(page);
  await page.goto('/');
  await expect(page.getByRole('columnheader', { name: 'Tags', exact: true })).toBeVisible();
  const headers = (await page.getByRole('columnheader').allTextContents()).map(header => header.trim());
  expect(headers.indexOf('Tags')).toBeGreaterThan(headers.indexOf('Album'));
  expect(headers.indexOf('Tags')).toBeGreaterThan(headers.indexOf('Plays'));
  await page.getByLabel('Collection', { exact: true }).selectOption('unplayed');
  await page.getByRole('searchbox', { name: 'Search library' }).fill('Evening');
  await page.getByRole('button', { name: 'Browse music tagged house', exact: true }).click();
  await expect(page.getByRole('searchbox', { name: 'Search library' })).toHaveValue('tag:house');
  await expect(page.getByLabel('Collection', { exact: true })).toHaveValue('all');
  await expect(page.getByRole('searchbox', { name: 'Search library' })).toHaveValue('tag:house');
  await expect(page.getByRole('region', { name: 'Library tags' })).toHaveCount(0);
  await expect(page.getByText('No song selected', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Tags', exact: true }).first().click();
  await expect(page.getByRole('region', { name: 'Browse tags' })).toBeVisible();
  await page.getByLabel('Find a tag').fill('piano');
  await page.getByRole('button', { name: 'Browse music tagged piano', exact: true }).click();
  await expect(page.getByRole('row').filter({ hasText: 'Morning piano' })).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: 'Evening set' })).toHaveCount(0);
  await expect(page.getByRole('searchbox', { name: 'Search library' })).toHaveValue('tag:piano');
  await page.getByRole('button', { name: 'Edit tags for Morning piano' }).click();
  await page.getByRole('article', { name: 'Tag piano', exact: true }).getByRole('button', { name: 'Browse music tagged piano' }).click();
  await expect(page.getByRole('region', { name: 'Library tags' })).toHaveCount(0);
  await expect(page.getByRole('searchbox', { name: 'Search library' })).toHaveValue('tag:piano');
});

test('selected track generation shows phases, survives closing the editor, and offers retry on failure', async ({ page }) => {
  const { data, writes } = await backend(page);
  delete data.items[tracks[0].id];
  await page.goto('/');
  await page.getByRole('button', { name: 'Edit tags for Evening set' }).click();
  await expect(page.getByRole('button', { name: /Suggest for \d+ tracks/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Generate tags for this track' }).click();
  await expect(page.getByText('Waiting to start', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'In progress', exact: true })).toBeDisabled();
  expect(writes).toEqual([`/api/tags/items/${tracks[0].id}/classify`]);
  data.items[tracks[0].id].status = 'running';
  data.items[tracks[0].id].phase = 'researching';
  await expect(page.getByText('Looking up music metadata…', { exact: true })).toBeVisible({ timeout: 10000 });
  await page.getByRole('button', { name: 'Close tags' }).click();
  await expect(page.locator('.library-toolbar').getByRole('button', { name: 'Tags (1)', exact: true })).toBeVisible();
  await page.locator('.library-toolbar').getByRole('button', { name: 'Tags (1)', exact: true }).click();
  await page.getByRole('button', { name: 'Automatic tags (1)', exact: true }).click();
  await expect(page.getByRole('list', { name: 'Suggestion progress' })).toContainText('Evening set');
  data.items[tracks[0].id].phase = 'classifying';
  await expect(page.getByText('GLM is generating suggestions…', { exact: true })).toBeVisible({ timeout: 10000 });
  data.items[tracks[0].id].status = 'failed';
  data.items[tracks[0].id].error = 'Provider unavailable';
  await expect(page.getByText('Could not generate tags — retry available', { exact: true })).toBeVisible({ timeout: 10000 });
  await page.getByRole('list', { name: 'Suggestion progress' }).getByRole('button', { name: /Evening set/ }).click();
  await expect(page.getByText('Provider unavailable', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Retry automatic tags' }).click();
  expect(writes).toHaveLength(2);
});

test('bulk generation names its tracks, reports completion and handles an empty queue response', async ({ page }) => {
  const { data, writes } = await backend(page);
  delete data.items[tracks[0].id];
  await page.goto('/');
  await page.getByRole('button', { name: 'Tags', exact: true }).first().click();
  await page.getByRole('button', { name: 'Automatic tags', exact: true }).click();
  await page.getByText('Tracks included in the next batch (1)').click();
  await expect(page.locator('details')).toContainText('Evening set');
  await expect(page.locator('details')).not.toContainText('Morning piano');
  await page.getByRole('button', { name: 'Generate for 1 track', exact: true }).click();
  await expect(page.getByText('0 of 1 tracks ready.', { exact: true })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Suggestion progress' })).toContainText('Waiting to start');
  expect(writes).toEqual(['/api/tags/queue']);
  data.items[tracks[0].id].status = 'ready';
  data.items[tracks[0].id].updatedAt = Date.now() / 1000;
  await expect(page.getByText('1 of 1 tracks ready.', { exact: true })).toBeVisible({ timeout: 10000 });
  await expect(page.getByText('No tags found. You can add your own.')).toBeVisible();
  await page.getByRole('button', { name: 'Close tags' }).click();
  await expect(page.getByRole('button', { name: 'Review results' })).toHaveCount(0);
  await expect(page.locator('.tag-activity')).toHaveCount(0);
  // Simulate another client queueing the candidate after the preview was shown.
  delete data.items[tracks[0].id];
  await page.reload();
  await page.getByRole('button', { name: 'Tags', exact: true }).first().click();
  await page.getByRole('button', { name: 'Automatic tags', exact: true }).click();
  await page.route('**/api/tags/queue', route => route.fulfill({ json: { queued: 0, itemIds: [] } }));
  await page.getByRole('button', { name: 'Generate for 1 track', exact: true }).click();
  await expect(page.getByText('No tracks added; these tracks are already queued or have current results.')).toBeVisible();
});
