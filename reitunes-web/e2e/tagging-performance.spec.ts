import { expect, test } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

// Fixed-size library makes before/after interaction timings comparable. No live model calls.
test('tag interactions with a 365-track library', async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const items = Array.from({ length: 365 }, (_, i) => ({
    id: `11111111-1111-4111-8111-${String(i).padStart(12, '0')}`,
    name: `Track ${String(i).padStart(3, '0')}`, artist: `Artist ${i % 30}`, album: `Album ${i % 50}`,
    created_time_utc: '2026-09-17T00:00:00', file_path: `${i}.mp3`, url: '/unused.mp3',
    track_number: i % 12, play_count: i % 20, is_favorite: false, bookmarks: {},
  }));
  const tags = { enabled: true, items: Object.fromEntries(items.map((item, i) => [item.id, {
    status: 'ready', labels: {}, tags: [{ tag: i % 2 ? 'house' : 'dj-mix', confidence: .8, basis: 'metadata', evidence: 'Fixture', sourceUrls: [] }],
  }])) };
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route('**/api/items', r => r.fulfill({ json: items }));
  await page.route('**/api/tags', r => r.fulfill({ json: tags }));
  await page.route('**/api/playlists', r => r.fulfill({ json: [] }));
  await page.route('**/api/discovery', r => r.fulfill({ json: { sources: [], entries: [] } }));
  await page.route('**/api/sonos/status', r => r.fulfill({ json: { configured: false, connected: false } }));
  await page.route('**/api/log', r => r.fulfill({ status: 200 }));
  await page.routeWebSocket('**/updates', () => {});
  await page.addInitScript(() => {
    const timings: Array<{ action: string; ms: number }> = [];
    Object.assign(window, { tagInteractionTimings: timings });
    document.addEventListener('click', event => {
      const button = (event.target as Element)?.closest('button');
      const action = button?.getAttribute('aria-label') || '';
      if (!/^(Edit tags|Close tags|Browse music tagged|Clear search)/.test(action)) return;
      const start = performance.now();
      requestAnimationFrame(() => requestAnimationFrame(() => timings.push({ action, ms: performance.now() - start })));
    }, true);
  });
  await page.goto('/');
  await expect(page.getByRole('table', { name: 'Tracks' })).toHaveAttribute('aria-rowcount', '366');
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.start');
  for (let i = 0; i < 5; i++) {
    await page.getByRole('button', { name: 'Edit tags for Track 000', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Track 000', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Close tags', exact: true }).click();
    await page.getByRole('button', { name: 'Browse music tagged dj-mix', exact: true }).first().click();
    await expect(page.getByRole('table', { name: 'Tracks' })).toHaveAttribute('aria-rowcount', '184');
    await page.getByRole('button', { name: 'Clear search', exact: true }).click();
    await expect(page.getByRole('table', { name: 'Tracks' })).toHaveAttribute('aria-rowcount', '366');
  }
  await expect.poll(() => page.evaluate(() => (window as unknown as { tagInteractionTimings: unknown[] }).tagInteractionTimings.length)).toBe(20);
  const { profile } = await cdp.send('Profiler.stop');
  const timings = await page.evaluate(() => (window as unknown as { tagInteractionTimings: Array<{ action: string; ms: number }> }).tagInteractionTimings);
  const summary = Object.fromEntries(['Edit tags', 'Close tags', 'Browse music tagged', 'Clear search'].map(action => {
    const values = timings.filter(x => x.action.startsWith(action)).map(x => x.ms).sort((a, b) => a - b);
    return [action, { median: values[2], max: values[4] }];
  }));
  console.log(JSON.stringify(summary));
  await writeFile(testInfo.outputPath('profile.cpuprofile'), JSON.stringify(profile));
  await testInfo.attach('interaction-timings', { body: JSON.stringify({ summary, timings }), contentType: 'application/json' });
  if (process.env.TAG_PERF_OUTPUT) await writeFile(process.env.TAG_PERF_OUTPUT, JSON.stringify({ summary, timings, profile }));
});
