import { expect, test, type Locator, type Page } from '@playwright/test';
import type { LibraryItem } from '../src/types';

type EditableField = 'name' | 'artist' | 'album';

async function setup(page: Page, overrides: Partial<LibraryItem> = {}) {
  const items: LibraryItem[] = ['Northern Sky', 'Pink Moon'].map((name, index) => ({
    id: `11111111-1111-4111-8111-11111111111${index}`,
    name, artist: index ? 'Nina Simone' : 'Nick Drake', album: index ? 'Pastel Blues' : 'Bryter Layter',
    track_number: 7, created_time_utc: `2026-01-0${2 - index}T00:00:00`, file_path: `${index}.mp3`,
    url: `/audio/${index}.mp3`, play_count: 0, bookmarks: {},
  }));
  Object.assign(items[0], overrides);
  const writes: { id: string; field: string; value: string }[] = [];
  const plays: string[] = [];
  await page.route('**/api/items', route => route.fulfill({ json: items }));
  await page.route('**/api/playlists', route => route.fulfill({ json: [] }));
  await page.route('**/api/tags', route => route.fulfill({ json: { enabled: false, items: {} } }));
  await page.route('**/api/log', route => route.fulfill({ status: 200 }));
  await page.route('**/ui/play', route => {
    plays.push(route.request().postDataJSON().id);
    return route.fulfill({ status: 200 });
  });
  await page.route('**/audio/*.mp3', route => route.fulfill({ contentType: 'audio/mpeg', body: '' }));
  await page.routeWebSocket('**/updates', () => {});
  await page.route('**/ui/update', route => {
    const body = route.request().postDataJSON();
    writes.push(body);
    Object.assign(items.find(item => item.id === body.id)!, { [body.field]: body.value });
    return route.fulfill({ status: 200 });
  });
  await page.goto('/');
  await expect(page.locator('tbody tr')).toHaveCount(2);
  const row = page.locator(`tr[data-item-id="${items[0].id}"]`);
  const second = page.locator(`tr[data-item-id="${items[1].id}"]`);
  return { items, row, second, writes, plays };
}

async function edit(row: Locator, field: EditableField) {
  await row.locator(`[data-column="${field}"]`).click();
  await row.press('F2');
  const input = row.getByRole('textbox', { name: `Edit ${field}` });
  await expect(input).toBeFocused();
  return input;
}

async function expectSelection(input: Locator, start: number, end = start) {
  await expect.poll(() => input.evaluate((element: HTMLInputElement) => [element.selectionStart, element.selectionEnd]))
    .toEqual([start, end]);
}

async function insertText(input: Locator, text: string, inputType: string, isComposing = false) {
  // Match a browser edit (including React's native value tracking), then deliver
  // the input event that distinguishes typing, paste, drop and IME composition.
  await input.evaluate((element: HTMLInputElement, edit) => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setValue.call(element, edit.text);
    element.setSelectionRange(edit.text.length, edit.text.length);
    element.dispatchEvent(new InputEvent('input', {
      bubbles: true, data: edit.text, inputType: edit.inputType, isComposing: edit.isComposing,
    }));
  }, { text, inputType, isComposing });
}

const fields: EditableField[] = ['name', 'artist', 'album'];
for (const field of fields) {
  for (const direction of ['Left', 'Right'] as const) {
    test(`F2 in ${field}: first ${direction} arrow places the caret, second navigates only if there is a next cell`, async ({ page }) => {
      const { row, items, writes, plays } = await setup(page);
      const input = await edit(row, field);
      const length = items[0][field].length;
      await expectSelection(input, 0, length);
      await input.press(`Arrow${direction}`);
      await expect(input).toBeFocused();
      await expectSelection(input, direction === 'Left' ? 0 : length);
      expect(writes).toEqual([]);
      const destination = fields[fields.indexOf(field) + (direction === 'Left' ? -1 : 1)];
      await input.press(`Arrow${direction}`);
      await expect(row.getByRole('textbox', { name: `Edit ${destination ?? field}` })).toBeFocused();
      expect(writes).toEqual([]);
      expect(plays).toEqual([]);
    });
  }
}

for (const selection of [
  { label: 'selection touching the beginning', start: 0, end: 3, direction: 'Left', destination: 'name' },
  { label: 'selection touching the end', start: 7, end: 10, direction: 'Right', destination: 'album' },
  { label: 'selection inside the text', start: 3, end: 7, direction: 'Left', destination: null },
  { label: 'selection inside the text', start: 3, end: 7, direction: 'Right', destination: null },
] as const) {
  test(`${selection.direction} collapses a ${selection.label} before cell navigation`, async ({ page }) => {
    const { row, writes, plays } = await setup(page);
    const input = await edit(row, 'artist');
    await input.press('Home');
    for (let i = 0; i < selection.start; i++) await input.press('ArrowRight');
    for (let i = selection.start; i < selection.end; i++) await input.press('Shift+ArrowRight');
    await expectSelection(input, selection.start, selection.end);
    await input.press(`Arrow${selection.direction}`);
    await expect(input).toBeFocused();
    await expectSelection(input, selection.direction === 'Left' ? selection.start : selection.end);
    if (selection.destination) {
      await input.press(`Arrow${selection.direction}`);
      await expect(row.getByRole('textbox', { name: `Edit ${selection.destination}` })).toBeFocused();
    }
    expect(writes).toEqual([]);
    expect(plays).toEqual([]);
  });
}

test('Home, End, text selection and modified arrows never turn into cell navigation', async ({ page }) => {
  const { row, writes, plays } = await setup(page);
  const input = await edit(row, 'artist');
  await input.press('End');
  await expectSelection(input, 10);
  await input.press('Home');
  await expectSelection(input, 0);
  for (const modifier of ['Shift', 'Control', 'Meta', 'Alt']) {
    for (const direction of ['Left', 'Right']) {
      await input.press(direction === 'Left' ? 'Home' : 'End');
      await input.press(`${modifier}+Arrow${direction}`);
      await expect(input).toBeFocused();
    }
  }
  await input.press('Home');
  await input.press('Shift+End');
  await expectSelection(input, 0, 10);
  await input.press('End');
  await input.press('Shift+Home');
  await expectSelection(input, 0, 10);
  expect(writes).toEqual([]);
  expect(plays).toEqual([]);
});

test('long metadata scrolls to the caret at either end without leaving the editor', async ({ page }, testInfo) => {
  const text = 'A very long live recording title, with an equally long artist and album description — '.repeat(5);
  const { row, writes } = await setup(page, { name: text, artist: text, album: text });
  for (const field of fields) {
    const input = await edit(row, field);
    await input.press('ArrowRight');
    await expect(input).toBeFocused();
    await expectSelection(input, text.length);
    await expect.poll(() => input.evaluate((element: HTMLInputElement) => element.scrollLeft)).toBeGreaterThan(0);
    const end = await input.evaluate((element: HTMLInputElement) => ({
      scrollLeft: element.scrollLeft, clientWidth: element.clientWidth, scrollWidth: element.scrollWidth,
    }));
    expect(end.scrollLeft + end.clientWidth).toBeGreaterThanOrEqual(end.scrollWidth - 4);
    await input.press('Home');
    await expectSelection(input, 0);
    await expect.poll(() => input.evaluate((element: HTMLInputElement) => element.scrollLeft)).toBeLessThanOrEqual(2);
    await input.press('End');
    await expectSelection(input, text.length);
    await expect(input).toBeFocused();
    if (field === 'album') await page.screenshot({ path: testInfo.outputPath('long-album-caret-at-end.png') });
    await input.press('Escape');
  }
  expect(writes).toEqual([]);
});

test('holding an arrow to reach an edge does not keep jumping between cells', async ({ page }) => {
  const { row, writes, plays } = await setup(page);
  const input = await edit(row, 'artist');
  // Repeated keyboard.down calls reproduce a held key, including event.repeat.
  await page.keyboard.down('ArrowRight');
  await expectSelection(input, 10);
  for (let i = 0; i < 12; i++) await page.keyboard.down('ArrowRight');
  await page.keyboard.up('ArrowRight');
  await expect(input).toBeFocused();
  await expectSelection(input, 10);
  await input.press('ArrowRight');
  const album = row.getByRole('textbox', { name: 'Edit album' });
  await expect(album).toBeFocused();
  await page.keyboard.down('ArrowLeft');
  for (let i = 0; i < 15; i++) await page.keyboard.down('ArrowLeft');
  await page.keyboard.up('ArrowLeft');
  await expect(album).toBeFocused();
  await expectSelection(album, 0);
  await album.press('ArrowLeft');
  await expect(input).toBeFocused();
  expect(writes).toEqual([]);
  expect(plays).toEqual([]);
});

test('a fresh arrow navigates empty optional metadata without requiring a nonexistent selection to collapse', async ({ page }) => {
  const { row, writes, plays } = await setup(page, { artist: '', album: '' });
  const input = await edit(row, 'artist');
  await expectSelection(input, 0);
  await input.press('ArrowRight');
  const album = row.getByRole('textbox', { name: 'Edit album' });
  await expect(album).toBeFocused();
  await album.press('ArrowLeft');
  await expect(input).toBeFocused();
  await input.press('ArrowLeft');
  await expect(row.getByRole('textbox', { name: 'Edit name' })).toBeFocused();
  expect(writes).toEqual([]);
  expect(plays).toEqual([]);
});

test('an autocomplete suffix takes one arrow to accept before a second arrow saves and changes cells', async ({ page }) => {
  const { row, writes, plays } = await setup(page);
  const input = await edit(row, 'artist');
  await input.pressSequentially('Nina');
  await expect(input).toHaveValue('Nina Simone');
  await expectSelection(input, 4, 11);
  await input.press('ArrowRight');
  await expect(input).toBeFocused();
  await expectSelection(input, 11);
  expect(writes).toEqual([]);
  await input.press('ArrowRight');
  const album = row.getByRole('textbox', { name: 'Edit album' });
  await expect(album).toBeFocused();
  expect(writes.map(write => [write.field, write.value])).toEqual([['artist', 'Nina Simone']]);
  await album.pressSequentially('Past');
  await expectSelection(album, 4, 12);
  await album.press('ArrowLeft');
  await expect(album).toBeFocused();
  await expectSelection(album, 4);
  await album.press('Escape');
  expect(writes).toHaveLength(1);
  expect(plays).toEqual([]);
});

test('a failed save preserves the draft, caret and text selection for retry', async ({ page }) => {
  const { row, writes, plays } = await setup(page);
  let fail = true;
  await page.route('**/ui/update', route => fail ? route.fulfill({ status: 500 }) : route.fallback());
  const input = await edit(row, 'artist');
  await input.fill('Keep this draft');
  await input.press('Home');
  for (let i = 0; i < 4; i++) await input.press('ArrowRight');
  await input.press('ArrowDown');
  await expect(page.getByRole('alert')).toContainText('Could not save');
  await expect(input).toHaveValue('Keep this draft');
  await expect(input).toBeFocused();
  await expectSelection(input, 4);
  await input.press('Shift+ArrowRight');
  await input.press('Shift+ArrowRight');
  await input.press('Enter');
  await expect(page.getByRole('alert')).toContainText('Could not save');
  await expectSelection(input, 4, 6);
  await expect(input).toBeFocused();
  fail = false;
  await input.press('Enter');
  await expect(input).toHaveCount(0);
  await expect(row).toBeFocused();
  expect(writes.map(write => [write.field, write.value])).toEqual([['artist', 'Keep this draft']]);
  expect(plays).toEqual([]);
});

test('a pending save keeps keyboard focus and cannot duplicate writes or trigger playback and dialogs', async ({ page }) => {
  const { row, second, writes, plays } = await setup(page);
  let releaseSave: (() => void) | undefined;
  const pendingSave = new Promise<void>(resolve => { releaseSave = resolve; });
  let requests = 0;
  await page.route('**/ui/update', async route => {
    requests++;
    await pendingSave;
    await route.fallback();
  });
  const input = await edit(row, 'artist');
  await input.fill('Saved exactly once');
  try {
    await input.press('Tab');
    await expect.poll(() => requests).toBe(1);
    await expect(input).toBeFocused();
    for (const key of ['Space', 'Enter', 'ArrowDown', 'ArrowRight', 'Tab', 'Control+i', 'Delete', 'Escape']) {
      await page.keyboard.press(key);
      await expect(input).toBeFocused();
    }
    await expect(input).toHaveValue('Saved exactly once');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(second).not.toHaveAttribute('aria-selected', 'true');
    expect(requests).toBe(1);
    expect(plays).toEqual([]);
  } finally {
    releaseSave?.();
  }
  await expect(row.getByRole('textbox', { name: 'Edit album' })).toBeFocused();
  expect(writes.map(write => [write.field, write.value])).toEqual([['artist', 'Saved exactly once']]);
  expect(requests).toBe(1);
  expect(plays).toEqual([]);
});

test('finishing a slow navigation save does not steal focus back after clicking Search', async ({ page }) => {
  const { row, writes, plays } = await setup(page);
  let releaseSave: (() => void) | undefined;
  const pendingSave = new Promise<void>(resolve => { releaseSave = resolve; });
  let requests = 0;
  await page.route('**/ui/update', async route => {
    requests++;
    await pendingSave;
    await route.fallback();
  });
  const input = await edit(row, 'artist');
  await input.fill('Updated artist');
  const search = page.getByRole('searchbox', { name: 'Search library' });
  try {
    await input.press('Tab');
    await expect.poll(() => requests).toBe(1);
    await search.click();
    await expect(search).toBeFocused();
  } finally {
    releaseSave?.();
  }
  await expect(input).toHaveCount(0);
  await expect(row.locator('[data-column="artist"]')).toHaveText('Updated artist');
  await expect(search).toBeFocused();
  await expect(page.getByRole('textbox', { name: /^Edit / })).toHaveCount(0);
  expect(writes).toHaveLength(1);
  expect(requests).toBe(1);
  expect(plays).toEqual([]);
});

for (const inputType of ['insertFromPaste', 'insertFromDrop']) {
  test(`${inputType} keeps an exact metadata prefix instead of silently extending it`, async ({ page }) => {
    const { row, writes } = await setup(page);
    const artist = await edit(row, 'artist');
    await insertText(artist, 'Nina', inputType);
    await expect(artist).toHaveValue('Nina');
    await expectSelection(artist, 4);
    await artist.press('Enter');
    await expect(artist).toHaveCount(0);
    expect(writes.map(write => [write.field, write.value])).toEqual([['artist', 'Nina']]);
    await row.press('Control+i');
    const dialog = page.getByRole('dialog', { name: 'Song info' });
    const album = dialog.getByRole('textbox', { name: 'Album', exact: true });
    await album.focus();
    await insertText(album, 'Past', inputType);
    await expect(album).toHaveValue('Past');
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(writes.map(write => [write.field, write.value])).toEqual([['artist', 'Nina'], ['album', 'Past']]);
  });
}

test('IME composition keys cannot navigate, save or cancel an inline edit', async ({ page }) => {
  const { row, writes, plays } = await setup(page);
  const input = await edit(row, 'artist');
  await input.dispatchEvent('compositionstart', { data: '' });
  await insertText(input, 'Nina', 'insertCompositionText', true);
  await expect(input).toHaveValue('Nina');
  for (const key of ['ArrowRight', 'ArrowDown', 'Tab', 'Enter', 'Escape']) {
    await input.dispatchEvent('keydown', { key, code: key, isComposing: true });
    await expect(input).toBeFocused();
    await expect(input).toHaveValue('Nina');
    expect(writes).toEqual([]);
  }
  await input.dispatchEvent('compositionend', { data: 'Nina' });
  await insertText(input, 'Nina', 'insertFromComposition');
  await expect(input).toHaveValue('Nina');
  // Some engines end composition before the commit keydown and only mark 229.
  // Check this separately from the active-composition and isComposing guards.
  await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229, isComposing: false });
  await expect(input).toBeFocused();
  expect(writes).toEqual([]);
  await input.press('Enter');
  await expect(input).toHaveCount(0);
  expect(writes.map(write => [write.field, write.value])).toEqual([['artist', 'Nina']]);
  expect(plays).toEqual([]);
});

test('IME commit in Get Info leaves the form open until an ordinary Enter or Save', async ({ page }) => {
  const { row, writes, plays } = await setup(page);
  await row.click();
  await row.press('Control+i');
  const dialog = page.getByRole('dialog', { name: 'Song info' });
  const input = dialog.getByRole('textbox', { name: 'Artist', exact: true });
  await input.focus();
  await input.dispatchEvent('compositionstart', { data: '' });
  await insertText(input, 'Nina', 'insertCompositionText', true);
  await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true });
  await expect(dialog).toBeVisible();
  await expect(input).toHaveValue('Nina');
  expect(writes).toEqual([]);
  // Real browser key presses exercise implicit form submission and dialog
  // cancellation, which dispatching an untrusted keydown cannot trigger.
  await input.press('Enter');
  await expect(dialog).toBeVisible();
  expect(writes).toEqual([]);
  await input.press('Escape');
  await expect(dialog).toBeVisible();
  expect(writes).toEqual([]);
  await input.dispatchEvent('compositionend', { data: 'Nina' });
  await insertText(input, 'Nina', 'insertFromComposition');
  const legacyCommitPrevented = await input.evaluate(element => {
    const event = new KeyboardEvent('keydown', {
      key: 'Enter', code: 'Enter', keyCode: 229, isComposing: false, bubbles: true, cancelable: true,
    });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(legacyCommitPrevented).toBe(true);
  await expect(dialog).toBeVisible();
  expect(writes).toEqual([]);
  await input.press('Enter');
  await expect(dialog).toHaveCount(0);
  expect(writes.map(write => [write.field, write.value])).toEqual([['artist', 'Nina']]);
  expect(plays).toEqual([]);
});
