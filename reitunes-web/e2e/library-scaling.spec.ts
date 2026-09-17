import { expect, test } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

for (const size of (process.env.SCALING_SIZES || '365,3000,10000').split(',').map(Number)) {
  test(`clearing tag search with ${size} tracks`, async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    const items = Array.from({ length: size }, (_, i) => ({
      id: `11111111-1111-4111-8111-${String(i).padStart(12, '0')}`,
      name: `Track ${String(i).padStart(5, '0')}`, artist: `Artist ${i % 30}`, album: `Album ${i % 50}`,
      created_time_utc: '2026-09-17T00:00:00', file_path: `${i}.mp3`, url: '/unused.mp3',
      track_number: i % 12, play_count: i % 20, bookmarks: {},
    }));
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.route('**/api/items', r => r.fulfill({ json: items }));
    await page.route('**/api/tags', r => r.fulfill({ json: { enabled: true, items: Object.fromEntries(items.map((item, i) => [item.id, {
      status: 'ready', labels: {}, tags: [{ tag: i < 6 ? 'house' : 'dj-mix', confidence: .8, basis: 'metadata', evidence: 'Fixture', sourceUrls: [] }],
    }])) } }));
    await page.route('**/api/playlists', r => r.fulfill({ json: [] }));
    await page.route('**/api/discovery', r => r.fulfill({ json: { sources: [], entries: [] } }));
    await page.route('**/api/sonos/status', r => r.fulfill({ json: { configured: false, connected: false } }));
    await page.route('**/api/log', r => r.fulfill({ status: 200 }));
    await page.routeWebSocket('**/updates', () => {});
    await page.addInitScript(size => {
      const timings: number[] = [];
      Object.assign(window, { clearTagTimings: timings });
      document.addEventListener('input', event => {
        const input = event.target as HTMLInputElement;
        if (input.getAttribute('aria-label') !== 'Search library' || input.value) return;
        const start = performance.now();
        const check = () => {
          const table = document.querySelector('table[aria-label="Tracks"]');
          // Wait for the complete result model and mounted viewport, not the deferred input paint.
          if (table?.getAttribute('aria-rowcount') === String(size + 1) && table.querySelector('tbody tr[tabindex]')) {
            requestAnimationFrame(() => timings.push(performance.now() - start));
          } else requestAnimationFrame(check);
        };
        requestAnimationFrame(check);
      }, true);
    }, size);
    await page.goto('/');
    const table = page.getByRole('table', { name: 'Tracks' });
    const search = page.getByRole('searchbox', { name: 'Search library' });
    await expect(table).toHaveAttribute('aria-rowcount', String(size + 1), { timeout: 60_000 });
    for (let i = 0; i < 3; i++) {
      await search.fill('tag:house');
      await expect(table).toHaveAttribute('aria-rowcount', '7');
      await search.press('ControlOrMeta+a');
      await search.press('Backspace');
      await expect(table).toHaveAttribute('aria-rowcount', String(size + 1), { timeout: 60_000 });
      await expect.poll(() => page.evaluate(() => (window as unknown as { clearTagTimings: number[] }).clearTagTimings.length)).toBe(i + 1);
    }
    const timings = await page.evaluate(() => (window as unknown as { clearTagTimings: number[] }).clearTagTimings);
    const renderedRows = await table.locator('tbody tr[tabindex]').count();
    const result = { size, renderedRows, medianMs: [...timings].sort((a, b) => a - b)[1], timings };
    console.log(JSON.stringify(result));
    await testInfo.attach('scaling', { body: JSON.stringify(result), contentType: 'application/json' });
    if (process.env.SCALING_OUTPUT) await writeFile(`${process.env.SCALING_OUTPUT}-${size}.json`, JSON.stringify(result));
    if (!process.env.SCALING_BASELINE) expect(renderedRows).toBeLessThan(100);
  });
}
