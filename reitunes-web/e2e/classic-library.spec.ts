import { expect, test, type Page, type WebSocketRoute } from '@playwright/test';
import type { LibraryItem, Playlist } from '../src/types';

const sample: LibraryItem = {
  id: '11111111-1111-4111-8111-111111111111', name: 'Apricots', artist: 'Bicep', album: 'Isles',
  created_time_utc: new Date().toISOString(), file_path: 'apricots.mp3', url: '/audio/apricots.mp3',
  track_number: 1, play_count: 0, is_favorite: true,
  bookmarks: { moment: { emoji: '✨', label: 'Synth entrance', position: 90, created_time_utc: '2026-09-01T12:00:00' } },
};
const songs = [
  sample,
  { ...sample, id: '22222222-2222-4222-8222-222222222222', name: 'Glue', track_number: 2, play_count: 3, bookmarks: {} },
  { ...sample, id: '33333333-3333-4333-8333-333333333333', name: 'Lush', artist: 'Four Tet', track_number: 3, is_favorite: false, bookmarks: {} },
];

async function backend(page: Page) {
  const playlists: Playlist[] = [{ id: 'p1', name: 'Late nights', items: {} }];
  const mutations: { method: string; path: string; body: Record<string, unknown> }[] = [];
  await page.route('**/api/items', route => route.fulfill({ json: songs }));
  await page.route(/\/api\/playlists(?:\/|$)/, async route => {
    const request = route.request(), method = request.method(), path = new URL(request.url()).pathname;
    const body = request.postData() ? request.postDataJSON() : {};
    if (method === 'GET') { await route.fulfill({ json: playlists }); return; }
    mutations.push({ method, path, body });
    const id = path.split('/')[3], playlist = playlists.find(p => p.id === id);
    if (path === '/api/playlists') {
      const created = { id: 'p' + (playlists.length + 1), name: body.name, items: {}, smart_rules: body.smart_rules };
      playlists.push(created); await route.fulfill({ status: 201, json: created }); return;
    }
    if (!playlist) { await route.fulfill({ status: 404 }); return; }
    if (path.endsWith('/items')) {
      for (const id of body.library_item_ids as string[]) {
        if (method === 'POST' && !playlist.items[id]) playlist.items[id] = { library_item_id: id, position: Object.keys(playlist.items).length };
        if (method === 'DELETE') delete playlist.items[id];
      }
    } else if (path.endsWith('/order')) {
      (body.library_item_ids as string[]).forEach((id, position) => { playlist.items[id].position = position; });
    } else if (path.endsWith('/rules')) playlist.smart_rules = body;
    else if (method === 'PUT') playlist.name = body.name;
    await route.fulfill({ status: 200 });
  });
  await page.route('**/api/sonos/status', route => route.fulfill({ json: { configured: false, connected: false } }));
  await page.route('**/api/discovery', route => route.fulfill({ json: { sources: [], entries: [], refreshing: false } }));
  await page.route('**/api/log', route => route.fulfill({ status: 200 }));
  await page.route('**/ui/play', route => route.fulfill({ status: 200 }));
  await page.route('**/audio/*.mp3', route => route.fulfill({ body: '', contentType: 'audio/mpeg' }));
  await page.routeWebSocket('**/updates', () => {});
  await page.addInitScript(() => {
    Object.defineProperty(HTMLMediaElement.prototype, 'play', { configurable: true, value() { this.dispatchEvent(new Event('play')); return Promise.resolve(); } });
    Object.defineProperty(HTMLMediaElement.prototype, 'pause', { configurable: true, value() { this.dispatchEvent(new Event('pause')); } });
  });
  return { playlists, mutations };
}

test('multi-selection, context menus and drag-and-drop update playlists without starting playback', async ({ page }) => {
  const { mutations } = await backend(page);
  await page.goto('/');
  const rows = page.locator('tbody tr');
  await expect(rows).toHaveCount(3);
  await expect(page.locator('.song-table input[type=checkbox]')).toHaveCount(0);
  const apricots = page.getByRole('row').filter({ hasText: 'Apricots' });
  const glue = page.getByRole('row').filter({ hasText: 'Glue' });
  await apricots.locator('[data-column=name]').click();
  await glue.locator('[data-column=name]').click({ modifiers: ['Control'] });
  await expect(page.locator('tr[aria-selected=true]')).toHaveCount(2);
  await glue.locator('[data-column=name]').click({ modifiers: ['Control'] });
  await glue.locator('[data-column=name]').click({ modifiers: ['Control'] });
  // Let the delayed click-to-edit timer elapse: modifier clicks must only select.
  await page.waitForTimeout(600);
  await expect(page.locator('.song-table input')).toHaveCount(0);
  await expect(page.locator('tr[aria-selected=true]')).toHaveCount(2);
  await expect(page.locator('audio')).not.toHaveAttribute('src', /apricots/);
  await apricots.click({ button: 'right' });
  await page.getByRole('button', { name: 'Add to Playlist', exact: false }).click();
  await page.locator('.playlist-submenu').getByRole('button', { name: 'Late nights', exact: true }).click();
  await expect.poll(() => mutations.filter(m => m.method === 'POST').length).toBe(1);
  expect(mutations[0].body.library_item_ids).toEqual([songs[0].id, songs[1].id]);
  await page.getByRole('row').filter({ hasText: 'Lush' }).dragTo(page.getByRole('button', { name: 'Late nights', exact: true }));
  await page.getByRole('button', { name: 'Late nights', exact: true }).click();
  await expect(rows).toHaveCount(3);
  await rows.last().dragTo(rows.first(), { targetPosition: { x: 50, y: 3 } });
  await expect(rows.first()).toContainText('Lush');
  await rows.first().dragTo(rows.last(), { targetPosition: { x: 50, y: 20 } });
  await expect(rows.last()).toContainText('Lush');
  await rows.last().dragTo(rows.first(), { targetPosition: { x: 50, y: 3 } });
  await expect(rows.first()).toContainText('Lush');
  await rows.first().click({ button: 'right' });
  await page.getByRole('button', { name: 'Remove from playlist', exact: true }).click();
  await expect(rows).toHaveCount(2);
  await page.getByRole('button', { name: 'All music', exact: true }).click();
  await expect(rows).toHaveCount(3);
  await rows.first().click();
  await page.keyboard.press('Control+a');
  await expect(page.locator('tr[aria-selected=true]')).toHaveCount(3);
  await rows.last().click({ button: 'right' });
  await page.getByRole('button', { name: 'New playlist from selection…', exact: true }).click();
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('All three');
  await page.getByRole('button', { name: 'Create playlist', exact: true }).click();
  await expect(page.getByRole('button', { name: 'All three', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(rows).toHaveCount(3);
});

test('Smart Playlists save rules, survive reload and can be edited', async ({ page }) => {
  const { playlists } = await backend(page);
  await page.goto('/');
  await page.getByRole('button', { name: /New Smart Playlist/ }).click();
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Fresh favourites');
  await page.getByRole('combobox', { name: 'Date added rule' }).selectOption('recent');
  await page.getByRole('combobox', { name: 'Play count', exact: true }).selectOption('unplayed');
  await page.getByRole('checkbox', { name: 'Favourites only' }).check();
  await page.getByRole('button', { name: 'Create playlist', exact: true }).click();
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await expect(page.locator('tbody tr')).toContainText('Apricots');
  expect(playlists[1].smart_rules).toEqual({ added_within_days: 30, play_state: 'unplayed', favourites_only: true, bookmark_state: 'any' });
  await page.reload();
  await page.getByRole('button', { name: 'Fresh favourites', exact: true }).click();
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await page.getByRole('button', { name: 'Edit rules…', exact: true }).click();
  await page.getByRole('combobox', { name: 'Play count', exact: true }).selectOption('played');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.locator('tbody tr')).toContainText('Glue');
  await page.getByRole('button', { name: 'Fresh favourites', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Edit Smart Playlist…' }).click();
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Played favourites');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Played favourites', exact: true })).toHaveAttribute('aria-current', 'page');
});

test('a bookmark Smart Playlist includes old played songs and updates live as bookmarks change', async ({ page }, testInfo) => {
  const { playlists } = await backend(page);
  const oldBookmarked = { ...sample, created_time_utc: '2020-01-01T00:00:00', play_count: 12, is_favorite: false };
  await page.route('**/api/items', route => route.fulfill({ json: [oldBookmarked, ...songs.slice(1)] }));
  let updates: WebSocketRoute | undefined;
  await page.routeWebSocket('**/updates', socket => { updates = socket; });
  await page.goto('/');
  await page.getByRole('button', { name: /New Smart Playlist/ }).click();
  const dialog = page.getByRole('dialog', { name: 'New Smart Playlist', exact: true });
  await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('Bookmarked tracks');
  await dialog.getByRole('combobox', { name: 'Bookmarks', exact: true }).selectOption('with');
  await expect(dialog.getByText('1 matching tracks · updates automatically')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('bookmark-smart-playlist.png') });
  await dialog.getByRole('button', { name: 'Create playlist', exact: true }).click();
  const rows = page.locator('tbody tr');
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText('Apricots');
  expect(playlists[1].smart_rules).toEqual({ added_within_days: null, play_state: 'any', favourites_only: false, bookmark_state: 'with' });

  updates = undefined;
  await page.reload();
  const source = page.getByRole('button', { name: 'Bookmarked tracks', exact: true });
  await source.click();
  await expect(rows).toHaveCount(1);
  await expect.poll(() => !!updates).toBe(true);
  updates!.send(JSON.stringify({ type: 'update', item: { ...songs[1], bookmarks: sample.bookmarks } }));
  await expect(rows).toHaveCount(2);
  await expect(source.locator('.source-count')).toHaveText('2');
  updates!.send(JSON.stringify({ type: 'update', item: { ...oldBookmarked, bookmarks: {} } }));
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText('Glue');
  await expect(source.locator('.source-count')).toHaveText('1');

  await page.getByRole('button', { name: 'Edit rules…', exact: true }).click();
  const bookmarks = page.getByRole('combobox', { name: 'Bookmarks', exact: true });
  await expect(bookmarks).toHaveValue('with');
  await bookmarks.selectOption('without');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(rows).toHaveCount(2);
  await expect(page.getByRole('row').filter({ hasText: 'Glue' })).toHaveCount(0);
});

for (const width of [1440, 1024, 390]) {
  test('density and playback bookmark markers remain available at ' + width, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await backend(page);
    await page.goto('/');
    const first = page.getByRole('row').filter({ hasText: 'Apricots' });
    await first.dblclick();
    await page.locator('audio').evaluate(audio => {
      Object.defineProperty(audio, 'duration', { configurable: true, value: 300 });
      audio.dispatchEvent(new Event('loadedmetadata')); audio.dispatchEvent(new Event('canplay'));
    });
    const marker = page.locator('.playback-scrubber button');
    await expect(marker).toHaveCount(1);
    await expect(marker).toBeVisible();
    await expect.poll(async () => {
      const scrubber = (await page.locator('.playback-scrubber').boundingBox())!;
      const mark = (await marker.boundingBox())!;
      return Math.abs(mark.x - scrubber.x - scrubber.width * .3);
    }).toBeLessThan(2);
    await marker.click();
    await expect.poll(() => page.locator('audio').evaluate(el => (el as HTMLAudioElement).currentTime)).toBe(90);
    await page.screenshot({ path: testInfo.outputPath('sidebar-' + width + '.png'), fullPage: true });
    await page.getByRole('button', { name: 'Queue', exact: true }).click();
    await expect(page.getByRole('navigation', { name: 'Music library', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Queue', exact: true }).click();
    await expect(page.getByRole('combobox', { name: 'Grid density', exact: true })).toHaveCount(0);
    const compact = (await first.boundingBox())!.height;
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('combobox', { name: 'Grid density', exact: true }).selectOption('comfortable');
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    expect((await first.boundingBox())!.height).toBeGreaterThan(compact);
    await page.reload();
    await expect(page.locator('.music-app')).toHaveAttribute('data-density', 'comfortable');
    await page.getByRole('navigation', { name: 'Music library', exact: true }).getByRole('button', { name: 'Bookmarks', exact: true }).click();
    await expect(page.getByText('Synth entrance', { exact: true })).toBeVisible();
    await page.getByRole('searchbox', { name: 'Filter bookmarks', exact: true }).fill('Synth');
    await expect(page.getByRole('button', { name: 'Play Apricots from Synth entrance', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

for (const mode of ['light', 'dark']) {
  test('matches the approved compact layout in Solarized ' + mode, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1024, height: 740 });
    const { playlists } = await backend(page);
    const tracks = [
      ['Apricots', 'Bicep', 'Isles'], ['Two Thousand and Seventeen', 'Four Tet', 'New Energy'],
      ['Glue', 'Bicep', 'Bicep'], ['LesAlpx', 'Floating Points', 'Crush'],
      ['NTS · September session', 'Carista', 'Radio sets'], ['NTS · Sunday listening', 'Nala Sinephro', 'Radio sets'],
      ['Nude', 'Radiohead', 'In Rainbows'], ['Open Eye Signal', 'Jon Hopkins', 'Immunity'],
      ['A Walk', 'Tycho', 'Dive'], ['Kerala', 'Bonobo', 'Migration'],
      ['NTS · Late-night selections', 'Skee Mask', 'Radio sets'], ['Space 1', 'Nala Sinephro', 'Space 1.8'],
      ['Lush', 'Four Tet', 'New Energy'], ['Says', 'Nils Frahm', 'Spaces'], ['Archangel', 'Burial', 'Untrue'],
      ['Looped', 'Kiasmos', 'Kiasmos'], ['Rose Rouge', 'St Germain', 'Tourist'], ['NTS · Morning selections', 'Moxie', 'Radio sets'],
    ].map(([name, artist, album], index) => ({ ...sample, id: 'track-' + index, name, artist, album,
      is_favorite: false, play_count: index % 4 === 0 ? 0 : 24 - index,
      bookmarks: index % 4 === 0 ? sample.bookmarks : {},
    }));
    await page.route('**/api/items', route => route.fulfill({ json: tracks }));
    playlists[0].items = Object.fromEntries(tracks.slice(0, 5).map((track, position) => [track.id, { library_item_id: track.id, position }]));
    playlists.push(
      { id: 'p2', name: 'On the train', items: {} }, { id: 'p3', name: 'Long-form listening', items: {} },
      { id: 's1', name: 'Fresh & unheard', items: {}, smart_rules: { added_within_days: 30, play_state: 'unplayed', favourites_only: false } },
      { id: 's2', name: 'Recent favourites', items: {}, smart_rules: { added_within_days: 90, play_state: 'any', favourites_only: true } },
    );
    await page.addInitScript(mode => localStorage.setItem('reitunes-theme', JSON.stringify({ lightTheme: 'solarized', darkTheme: 'solarized', mode })), mode);
    await page.goto('/');
    await page.getByRole('row').filter({ hasText: 'Apricots' }).dblclick();
    await page.locator('audio').evaluate(audio => {
      Object.defineProperty(audio, 'duration', { configurable: true, value: 246 });
      audio.dispatchEvent(new Event('loadedmetadata')); audio.dispatchEvent(new Event('canplay'));
      (audio as HTMLAudioElement).currentTime = 78;
      audio.dispatchEvent(new Event('timeupdate'));
    });
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'All music', exact: true }).click();
    await page.getByRole('button', { name: 'All music', exact: true }).blur();
    await expect(page.locator('tbody tr')).toHaveCount(18);
    await expect(page.getByRole('columnheader', { name: 'Created' })).toHaveCount(0);
    const dimensions = await page.locator('tbody tr').first().evaluate(row => ({
      height: row.getBoundingClientRect().height,
      border: getComputedStyle(row.querySelector('td')!).borderRightWidth,
    }));
    expect(dimensions).toEqual({ height: 24, border: '0px' });
    await expect(page.locator('.playback-scrubber button')).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('compact-' + mode + '.png'), fullPage: true });
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Choose columns…' }).click();
    await page.getByRole('checkbox', { name: 'Date added' }).check();
    await page.getByRole('checkbox', { name: 'Track number' }).check();
    await page.getByRole('dialog', { name: 'Choose columns' }).getByRole('button', { name: 'Done', exact: true }).click();
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(page.getByRole('columnheader', { name: /Created/ })).toBeVisible();
  });
}
