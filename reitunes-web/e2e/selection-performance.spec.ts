import { test, expect } from './fixtures/test';
import type { LibraryItem } from '../src/types';
import { writeFileSync } from 'node:fs';

declare global {
  interface Window { selectionDateFormats: number }
}

const songs: LibraryItem[] = Array.from({ length: 1500 }, (_, index) => ({
  id: `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`,
  name: `Song ${String(index).padStart(4, '0')}`, artist: `Artist ${index % 150}`,
  album: `Album ${index % 300}`, track_number: index % 12 + 1,
  created_time_utc: '2026-01-01T00:00:00', file_path: `${index}.mp3`,
  url: `/audio/${index}.mp3`, play_count: index % 10, bookmarks: {}, duration_seconds: 220,
}));

test('selection in a large tagged library leaves unchanged cell content alone', async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const library = songs.map(song => ({ ...song }));
  const additions: string[][] = [];
  await page.addInitScript(() => {
    window.selectionDateFormats = 0;
    for (const method of ['toLocaleString', 'toLocaleDateString'] as const) {
      const format = Date.prototype[method];
      Date.prototype[method] = function (this: Date, locales?: Intl.LocalesArgument, options?: Intl.DateTimeFormatOptions) {
        window.selectionDateFormats++;
        return format.call(this, locales, options);
      };
    }
  });
  const tags = Object.fromEntries(songs.map(song => [song.id, {
    status: 'ready', labels: {}, tags: ['indie-rock', 'alternative', 'energetic'].map(tag => ({
      tag, basis: 'metadata', confidence: 0.9, evidence: '', sourceUrls: [],
    })),
  }]));
  await page.route('**/api/items', route => route.fulfill({ json: library }));
  await page.route('**/api/tags', route => route.fulfill({ json: { enabled: true, items: tags } }));
  await page.route('**/api/playlists', route => route.fulfill({ json: [{ id: 'selection-destination', name: 'Selection destination', items: {} }] }));
  await page.route('**/api/playlists/selection-destination/items', route => {
    additions.push(route.request().postDataJSON().library_item_ids);
    return route.fulfill({ status: 200 });
  });
  await page.route('**/ui/update', route => {
    const { id, value } = route.request().postDataJSON();
    library.find(song => song.id === id)!.name = value;
    return route.fulfill({ status: 200 });
  });
  await page.route('**/api/sonos/status', route => route.fulfill({ json: { configured: false, connected: false } }));
  await page.route('**/api/discovery', route => route.fulfill({ json: { sources: [], entries: [], refreshing: false } }));
  await page.route('**/api/log', route => route.fulfill({ status: 200 }));
  await page.routeWebSocket('**/updates', () => {});
  await page.goto('/');
  await expect(page.locator('tbody tr[data-item-id]')).toHaveCount(songs.length, { timeout: 20_000 });
  await page.waitForTimeout(1500);
  // Set REITUNES_PROFILE_SELECTION=1 to save a Chrome CPU profile alongside the
  // timings. The regression assertion below counts work rather than wall time.
  const cdp = process.env.REITUNES_PROFILE_SELECTION ? await page.context().newCDPSession(page) : null;
  if (cdp) {
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 100 });
    await cdp.send('Profiler.start');
  }
  const latencies = [];
  for (let index = 0; index < 6; index++) {
    const sample = await page.evaluate(async ({ index, id }) => {
      const cell = document.querySelector(`[data-item-id="${id}"] [data-column="name"]`)!;
      const start = performance.now();
      cell.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, ctrlKey: true, button: 0 }));
      cell.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, ctrlKey: true, button: 0 }));
      cell.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true, button: 0 }));
      let highlighted = 0;
      while (!cell.closest('tr')?.matches('[aria-selected="true"]') ||
        !document.querySelector('.library-selection-count')?.textContent?.includes(`${index + 1} selected`)) {
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      }
      highlighted = performance.now() - start;
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      return { highlighted, painted: performance.now() - start };
    }, { index, id: songs[index].id });
    latencies.push(sample);
  }
  if (cdp) {
    const { profile } = await cdp.send('Profiler.stop');
    writeFileSync(testInfo.outputPath('selection-profile.json'), JSON.stringify(profile));
    await testInfo.attach('selection-profile.json', { path: testInfo.outputPath('selection-profile.json'), contentType: 'application/json' });
  }
  await testInfo.attach('selection-latency.json', { body: JSON.stringify(latencies), contentType: 'application/json' });
  console.log('SELECTION_LATENCY', JSON.stringify(latencies));
  await expect(page.locator('tbody tr[aria-selected=true]')).toHaveCount(6);

  if (cdp) await cdp.send('Profiler.start');
  const searchLatencies = [];
  for (const query of ['Artist 1', 'Artist 14', 'Artist 149', 'Artist 1', '']) {
    const count = songs.filter(song => query.toLowerCase().split(' ').every(term =>
      `${song.name} ${song.artist} ${song.album}`.toLowerCase().includes(term))).length;
    const sample = await page.evaluate(async ({ query, count }) => {
      const input = document.querySelector('input[type="search"]') as HTMLInputElement;
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      const start = performance.now();
      setValue.call(input, query);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      while (document.querySelectorAll('tbody tr[data-item-id]').length !== count) {
        if (performance.now() - start > 10_000) throw new Error(`Search ${query}: expected ${count} rows, got ${document.querySelectorAll('tbody tr[data-item-id]').length}`);
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      }
      const matching = performance.now() - start;
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      return { query, count, matching, painted: performance.now() - start };
    }, { query, count });
    searchLatencies.push(sample);
  }
  if (cdp) {
    const { profile } = await cdp.send('Profiler.stop');
    writeFileSync(testInfo.outputPath('search-profile.json'), JSON.stringify(profile));
    await testInfo.attach('search-profile.json', { path: testInfo.outputPath('search-profile.json'), contentType: 'application/json' });
  }
  await testInfo.attach('search-latency.json', { body: JSON.stringify(searchLatencies), contentType: 'application/json' });
  console.log('SEARCH_LATENCY', JSON.stringify(searchLatencies));

  await page.evaluate(() => localStorage.setItem('reitunes-library-preferences', JSON.stringify({
    state: { columnVisibility: { created_time_utc: true } }, version: 0,
  })));
  await page.reload();
  await expect(page.locator('tbody tr[data-item-id]')).toHaveCount(songs.length, { timeout: 20_000 });
  await expect(page.locator('tbody [data-column=created_time_utc]').first()).toBeVisible();
  // Allow the shared viewport observer to finish its initial mount batch before
  // counting the formatting work caused by selection.
  await page.waitForTimeout(200);
  expect(await page.locator('tbody [data-column=created_time_utc]').count()).toBeLessThan(120);
  const formatsBefore = await page.evaluate(() => window.selectionDateFormats);
  expect(formatsBefore).toBeGreaterThan(0);
  await page.locator(`tr[data-item-id="${songs[0].id}"] [data-column=name]`).click();
  await page.locator(`tr[data-item-id="${songs[2].id}"] [data-column=name]`).click({ modifiers: ['Control'] });
  await page.locator(`tr[data-item-id="${songs[4].id}"] [data-column=name]`).click({ modifiers: ['Shift'] });
  await expect(page.locator('.library-selection-count')).toContainText('3 selected');
  const formatsAfter = await page.evaluate(() => window.selectionDateFormats);
  // Allow a little work for the few selected rows, but never format 1,500
  // unchanged dates on every Ctrl/Shift click again.
  expect(formatsAfter - formatsBefore).toBeLessThan(30);

  const first = page.locator(`tr[data-item-id="${songs[0].id}"]`);
  const last = page.locator(`tr[data-item-id="${songs.at(-1)!.id}"]`);
  const scrollHeight = await page.locator('table').evaluate(table => table.parentElement!.scrollHeight);
  const rowHeight = (await first.boundingBox())!.height;
  expect((await last.boundingBox())!.height).toBeCloseTo(rowHeight, 0);
  await first.locator('[data-column=name]').click();
  const resize = page.getByRole('separator', { name: 'Resize Name', exact: true });
  await resize.press('ArrowRight');
  const nameWidth = (await page.locator('th[data-column=name]').boundingBox())!.width;
  await last.scrollIntoViewIfNeeded();
  await expect(last.locator('[data-column=name]')).toHaveText(songs.at(-1)!.name);
  await expect(last.locator('[data-column=artist]')).toHaveText(songs.at(-1)!.artist);
  expect((await last.boundingBox())!.height).toBeCloseTo(rowHeight, 0);
  expect(await page.locator('table').evaluate(table => table.parentElement!.scrollHeight)).toBe(scrollHeight);
  expect((await last.locator('[data-column=name]').boundingBox())!.width).toBeCloseTo(nameWidth, 0);
  await page.screenshot({ path: testInfo.outputPath('scrolled-large-library.png') });
  await last.locator('[data-column=name]').click({ modifiers: ['Shift'] });
  await expect(page.locator('.library-selection-count')).toContainText('1,500 selected');
  await last.locator('[data-column=name]').dragTo(page.getByRole('button', { name: 'Selection destination', exact: true }));
  await expect.poll(() => additions).toEqual([songs.map(song => song.id)]);

  await last.locator('[data-column=name]').click();
  await last.press('F2');
  const editor = last.getByRole('textbox', { name: 'Edit name' });
  await editor.fill('Renamed after scrolling');
  await first.scrollIntoViewIfNeeded();
  await expect(editor).toHaveValue('Renamed after scrolling');
  await last.scrollIntoViewIfNeeded();
  await editor.press('Enter');
  await expect(last.locator('[data-column=name]')).toHaveText('Renamed after scrolling');
  await first.scrollIntoViewIfNeeded();
  await last.scrollIntoViewIfNeeded();
  await expect(last.locator('[data-column=name]')).toHaveText('Renamed after scrolling');

  await first.scrollIntoViewIfNeeded();
  await first.locator('[data-column=name]').click();
  for (let index = 0; index < 70; index++) await page.keyboard.press('ArrowDown');
  const keyboardTarget = page.locator(`tr[data-item-id="${songs[70].id}"]`);
  await expect(keyboardTarget).toBeFocused();
  await expect(keyboardTarget.locator('[data-column=name]')).toHaveText(songs[70].name);
  await expect(keyboardTarget).toBeInViewport();
});

test('lazy tooltips handle truncated cells, scrolling, and filtered-out rows', async ({ page }) => {
  const longTitle = 'A song title long enough to overflow the grid cell and need a tooltip';
  const tooltipSongs = songs.slice(0, 60).map((song, index) => ({ ...song,
    name: index === 0 ? longTitle : index === 1 ? 'Short' : song.name,
  }));
  await page.route('**/api/items', route => route.fulfill({ json: tooltipSongs }));
  await page.route('**/api/tags', route => route.fulfill({ json: { enabled: false, items: {} } }));
  await page.route('**/api/playlists', route => route.fulfill({ json: [] }));
  await page.route('**/api/sonos/status', route => route.fulfill({ json: { configured: false, connected: false } }));
  await page.route('**/api/discovery', route => route.fulfill({ json: { sources: [], entries: [], refreshing: false } }));
  await page.route('**/api/log', route => route.fulfill({ status: 200 }));
  await page.routeWebSocket('**/updates', () => {});
  await page.goto('/');
  await expect(page.locator('tbody tr[data-item-id]')).toHaveCount(tooltipSongs.length);
  const short = page.locator(`tr[data-item-id="${songs[1].id}"] [data-column=name] .truncate`);
  const long = page.locator(`tr[data-item-id="${songs[0].id}"] [data-column=name] .truncate`);
  const tooltip = page.getByRole('tooltip');
  const search = page.getByRole('searchbox', { name: 'Search library' });
  await short.hover();
  await page.waitForTimeout(300);
  await expect(tooltip).toHaveCount(0);
  await long.hover();
  await expect(tooltip).toHaveText(longTitle);
  expect(await tooltip.evaluate(element => !element.closest('.music-app'))).toBe(true);
  await page.locator('table').evaluate(table => { table.parentElement!.scrollTop = 2; });
  await expect(tooltip).toHaveCount(0);

  await page.mouse.move(0, 0);
  await long.hover();
  await page.locator('table').evaluate(table => { table.parentElement!.scrollTop = 4; });
  await page.waitForTimeout(300);
  await expect(tooltip).toHaveCount(0);

  await page.mouse.move(0, 0);
  await long.hover();
  await search.fill('Short');
  await expect(page.locator('tbody tr[data-item-id]')).toHaveCount(1);
  await page.waitForTimeout(300);
  await expect(tooltip).toHaveCount(0);
  await search.clear();
  await expect(page.locator('tbody tr[data-item-id]')).toHaveCount(tooltipSongs.length);
  await long.hover();
  await expect(tooltip).toHaveText(longTitle);
  await search.fill('Short');
  await expect(tooltip).toHaveCount(0);
});

test('comfortable rows keep their height and scroll range when cells mount', async ({ page }) => {
  const library = songs.slice(0, 300);
  await page.addInitScript(() => localStorage.setItem('reitunes-library-preferences', JSON.stringify({
    state: { density: 'comfortable' }, version: 0,
  })));
  await page.route('**/api/items', route => route.fulfill({ json: library }));
  await page.route('**/api/tags', route => route.fulfill({ json: { enabled: false, items: {} } }));
  await page.route('**/api/playlists', route => route.fulfill({ json: [] }));
  await page.route('**/api/sonos/status', route => route.fulfill({ json: { configured: false, connected: false } }));
  await page.route('**/api/discovery', route => route.fulfill({ json: { sources: [], entries: [], refreshing: false } }));
  await page.route('**/api/log', route => route.fulfill({ status: 200 }));
  await page.routeWebSocket('**/updates', () => {});
  await page.goto('/');
  await expect(page.locator('tbody tr[data-item-id]')).toHaveCount(library.length);
  const first = page.locator(`tr[data-item-id="${library[0].id}"]`);
  const last = page.locator(`tr[data-item-id="${library.at(-1)!.id}"]`);
  await expect(first.locator('[data-column=name]')).toHaveText(library[0].name);
  expect((await first.boundingBox())!.height).toBe(34);
  expect((await last.boundingBox())!.height).toBe(34);
  const scrollHeight = await page.locator('table').evaluate(table => table.parentElement!.scrollHeight);
  await last.scrollIntoViewIfNeeded();
  await expect(last.locator('[data-column=name]')).toHaveText(library.at(-1)!.name);
  expect((await last.boundingBox())!.height).toBe(34);
  expect(await page.locator('table').evaluate(table => table.parentElement!.scrollHeight)).toBe(scrollHeight);
  await first.scrollIntoViewIfNeeded();
  await expect(first.locator('[data-column=name]')).toHaveText(library[0].name);
  expect(await page.locator('table').evaluate(table => table.parentElement!.scrollHeight)).toBe(scrollHeight);
});

test('modest scrolls expose populated rows before the viewport observer catches up', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const tags = Object.fromEntries(songs.map(song => [song.id, {
    status: 'ready', labels: {}, tags: ['indie-rock', 'alternative', 'energetic'].map(tag => ({
      tag, basis: 'metadata', confidence: 0.9, evidence: '', sourceUrls: [],
    })),
  }]));
  await page.route('**/api/items', route => route.fulfill({ json: songs }));
  await page.route('**/api/tags', route => route.fulfill({ json: { enabled: true, items: tags } }));
  await page.route('**/api/playlists', route => route.fulfill({ json: [] }));
  await page.route('**/api/sonos/status', route => route.fulfill({ json: { configured: false, connected: false } }));
  await page.route('**/api/discovery', route => route.fulfill({ json: { sources: [], entries: [], refreshing: false } }));
  await page.route('**/api/log', route => route.fulfill({ status: 200 }));
  await page.routeWebSocket('**/updates', () => {});
  await page.goto('/');
  await expect(page.locator('tbody tr[data-item-id]')).toHaveCount(songs.length);
  // Settle the initial observer batch, then inspect each new viewport in the
  // same task as its scroll. Waiting for cell text would conceal blank frames.
  await page.waitForTimeout(300);
  const sampleScrolls = (positions: number[]) => page.evaluate(positions => {
    const scroller = document.querySelector('[data-library-scroll]') as HTMLElement;
    const rows = Array.from(scroller.querySelectorAll<HTMLTableRowElement>('tbody tr[data-item-id]'));
    const bounds = scroller.getBoundingClientRect();
    const top = bounds.top + scroller.querySelector('thead')!.getBoundingClientRect().height;
    const height = rows[0].getBoundingClientRect().height;
    return positions.map(scrollTop => {
      scroller.scrollTop = scrollTop;
      const start = Math.max(0, Math.floor(scrollTop / height) - 1);
      const candidates = rows.slice(start, start + Math.ceil(bounds.height / height) + 3);
      const visible = candidates.filter(row => {
        const rowBounds = row.getBoundingClientRect();
        return rowBounds.bottom > top && rowBounds.top < bounds.bottom;
      });
      return { scrollTop, visible: visible.length,
        blank: visible.filter(row => !row.querySelector('[data-column=name]')?.textContent?.trim()).map(row => row.dataset.itemId),
      };
    });
  }, positions);
  const samples = await sampleScrolls([200, 400, 900, 1200]);
  await page.locator('[data-library-scroll]').evaluate(scroller => { scroller.scrollTop = 6000; });
  await page.waitForTimeout(300);
  samples.push(...await sampleScrolls([7200]));
  await page.waitForTimeout(300);
  samples.push(...await sampleScrolls([6000]));
  writeFileSync(testInfo.outputPath('scroll-readiness.json'), JSON.stringify(samples));
  await testInfo.attach('scroll-readiness.json', { path: testInfo.outputPath('scroll-readiness.json'), contentType: 'application/json' });
  console.log('SCROLL_READINESS', JSON.stringify(samples.map(({ scrollTop, visible, blank }) => ({ scrollTop, visible, blank: blank.length }))));
  expect(samples.every(sample => sample.visible > 0)).toBe(true);
  expect(samples.map(sample => ({ scrollTop: sample.scrollTop, blank: sample.blank.length }))).toEqual(
    samples.map(sample => ({ scrollTop: sample.scrollTop, blank: 0 })),
  );
});
