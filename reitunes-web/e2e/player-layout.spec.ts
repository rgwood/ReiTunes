import { expect, type Locator, type Page } from '@playwright/test';
import { SonosSimulator, test, trackId } from './fixtures/sonos';
import type { LibraryItem } from '../src/types';

const duration = 15_861;
const bookmarkPosition = 1_380;
const items: LibraryItem[] = Array.from({ length: 45 }, (_, index) => ({
  id: index === 0 ? trackId : `layout-track-${index}`,
  name: index === 0 ? 'Alexandra Palace 22nd November 2025' : ['Sub Club, Glasgow - 29 Nov 2025', 'Radio 1 Dance Presents', 'Tycho Burning Man Sunrise 2025', 'london deep house mix'][index % 4],
  artist: ['Four Tet', 'Quantic', 'Joie De Vivre', 'Chris Luno'][index % 4],
  album: index % 2 === 0 ? 'Live recordings' : '',
  created_time_utc: '2026-09-01T00:00:00',
  file_path: `track-${index}.mp3`, url: `/audio/track-${index}.mp3`,
  play_count: index % 6, is_favorite: index % 3 === 0,
  bookmarks: index % 2 === 0 ? {
    entrance: { position: bookmarkPosition, emoji: '🎸', label: 'Guitar entrance', created_time_utc: '2026-09-01T00:00:00' },
    vocals: { position: 7_400, emoji: '🎤', label: 'Vocals', created_time_utc: '2026-09-01T00:00:00' },
    finale: { position: 12_400, emoji: '✨', label: 'Finale', created_time_utc: '2026-09-01T00:00:00' },
  } : {},
}));

async function openPlayer(page: Page, output: 'browser' | 'sonos') {
  const seeks: number[] = [];
  if (output === 'sonos') {
    const simulator = new SonosSimulator(page);
    simulator.paused = true;
    simulator.speaker.positionMillis = 1_370_000;
    await simulator.install();
    await page.route('**/api/sonos/groups/group-1/playback/seek', async route => {
      const { positionMillis } = route.request().postDataJSON();
      seeks.push(positionMillis / 1000);
      simulator.speaker.positionMillis = positionMillis;
      await route.fulfill({ status: 204 });
    });
  } else {
    await page.route('**/api/playlists', route => route.fulfill({ json: [] }));
    await page.route('**/api/discovery', route => route.fulfill({ json: { sources: [], entries: [] } }));
    await page.route('**/api/log', route => route.fulfill({ status: 200 }));
    await page.route('**/ui/play', route => route.fulfill({ status: 200 }));
    await page.route('**/audio/*.mp3', route => route.fulfill({ contentType: 'audio/mpeg', body: '' }));
    await page.routeWebSocket('**/updates', () => {});
  }
  await page.route('**/api/items', route => route.fulfill({ json: items }));
  await page.route('**/api/sonos/status', route => route.fulfill({ json: { configured: true, connected: true } }));
  await page.addInitScript(({ id, duration }) => {
    localStorage.setItem('reitunes-theme', JSON.stringify({ lightTheme: 'neutral', darkTheme: 'forest-palace', mode: 'dark' }));
    localStorage.setItem('reitunes-player', JSON.stringify({ version: 1, state: {
      currentItemId: id, resumePosition: 1_370, volume: 0.5, isMuted: false,
    } }));
    Object.defineProperty(HTMLMediaElement.prototype, 'duration', { configurable: true, get: () => duration });
    Object.defineProperty(HTMLMediaElement.prototype, 'play', { configurable: true, value() { this.dispatchEvent(new Event('play')); return Promise.resolve(); } });
    Object.defineProperty(HTMLMediaElement.prototype, 'pause', { configurable: true, value() { this.dispatchEvent(new Event('pause')); } });
  }, { id: trackId, duration });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await expect(page.locator('tbody tr')).toHaveCount(items.length);
  await page.locator('audio').dispatchEvent('loadedmetadata');
  await page.locator('audio').dispatchEvent('canplay');
  await expect(page.locator('.player-title')).toContainText(items[0].name);
  await expect(page.locator('.playback-scrubber button')).toHaveCount(3);
  return { seeks };
}

async function box(locator: Locator) {
  await expect(locator).toBeVisible();
  return (await locator.boundingBox())!;
}

async function paint(locator: Locator) {
  return locator.evaluate(element => {
    const style = getComputedStyle(element);
    return { background: style.backgroundColor, color: style.color, shadow: style.boxShadow, outline: style.outline };
  });
}

for (const output of ['browser', 'sonos'] as const) {
  for (const width of [1440, 1920, 390]) {
    test(`${output} player remains compact and usable in Forest Palace at ${width}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      const { seeks } = await openPlayer(page, output);
      await page.screenshot({ path: testInfo.outputPath(`${output}-forest-palace-${width}.png`), fullPage: true, animations: 'disabled' });
      const header = page.locator('.player-bar');
      const title = page.locator('.player-title');
      const scrubber = page.locator('.playback-scrubber');
      const transport = page.locator('.transport-main');
      const seekControls = page.locator('.transport-seek');
      const bookmark = page.locator('.player-bookmark');
      const play = page.locator('.play-toggle');
      const suffix = output === 'sonos' ? ' on Sonos' : '';

      await expect(transport.getByRole('button')).toHaveCount(3);
      await expect(transport.getByRole('button', { name: 'Previous' + suffix, exact: true })).toBeVisible();
      await expect(transport.getByRole('button', { name: 'Next' + suffix, exact: true })).toBeVisible();
      await expect(seekControls.getByRole('button')).toHaveCount(2);
      await expect(bookmark).toBeVisible();
      expect(await bookmark.evaluate(element => element.closest('.transport-main'))).toBeNull();
      await expect(page.getByRole('navigation', { name: 'Music library', exact: true })).toBeVisible();

      // Bookmark emoji and the favourite control must not silently inflate rows.
      expect.soft(await page.locator('tbody tr').evaluateAll(rows => [...new Set(rows.map(row => row.getBoundingClientRect().height))])).toEqual([24]);
      const headerBox = await box(header);
      const titleBox = await box(title);
      const scrubberBox = await box(scrubber);
      const bookmarkBox = await box(bookmark);
      if (width >= 1440) {
        expect(headerBox.height).toBeLessThanOrEqual(64);
        expect(Math.abs(titleBox.x - scrubberBox.x)).toBeLessThanOrEqual(1);
        expect(scrubberBox.width).toBeGreaterThan(width * .4);
      }
      expect(bookmarkBox.x).toBeGreaterThanOrEqual(scrubberBox.x + scrubberBox.width);
      expect(bookmarkBox.x - scrubberBox.x - scrubberBox.width).toBeLessThanOrEqual(20);
      expect(Math.abs(bookmarkBox.y + bookmarkBox.height / 2 - scrubberBox.y - scrubberBox.height / 2)).toBeLessThanOrEqual(3);

      const parts = [transport, seekControls, title, scrubber, bookmark, page.locator('.player-tools')];
      const bounds = await Promise.all(parts.map(box));
      for (const part of bounds) {
        expect(part.x).toBeGreaterThanOrEqual(0);
        expect(part.x + part.width).toBeLessThanOrEqual(width);
        expect(part.y).toBeGreaterThanOrEqual(headerBox.y);
        expect(part.y + part.height).toBeLessThanOrEqual(headerBox.y + headerBox.height);
      }
      for (let a = 0; a < bounds.length; a++) for (let b = a + 1; b < bounds.length; b++) {
        const overlapWidth = Math.min(bounds[a].x + bounds[a].width, bounds[b].x + bounds[b].width) - Math.max(bounds[a].x, bounds[b].x);
        const overlapHeight = Math.min(bounds[a].y + bounds[a].height, bounds[b].y + bounds[b].height) - Math.max(bounds[a].y, bounds[b].y);
        expect(overlapWidth > 1 && overlapHeight > 1, `Header parts ${a} and ${b} overlap`).toBe(false);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);

      await page.mouse.move(width - 1, 899);
      await play.blur();
      const idle = await paint(play);
      expect(idle.background).toBe('rgba(0, 0, 0, 0)');
      await play.hover();
      await expect.poll(() => paint(play)).not.toEqual(idle);
      await page.mouse.move(width - 1, 899);
      await page.keyboard.press('Tab');
      await play.focus();
      await expect(play).toBeFocused();
      expect(await play.evaluate(element => {
        const style = getComputedStyle(element);
        return (style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0) || style.boxShadow !== 'none';
      })).toBe(true);
      await play.blur();

      await scrubber.getByTitle('🎸 Guitar entrance · 23:00', { exact: true }).click();
      const position = () => output === 'sonos'
        ? Promise.resolve(seeks.at(-1))
        : page.locator('audio').evaluate(element => (element as HTMLAudioElement).currentTime);
      await expect.poll(position).toBe(bookmarkPosition);
      await page.getByRole('button', { name: 'Forward 30s' + suffix, exact: true }).click();
      await expect.poll(position).toBe(bookmarkPosition + 30);
      await page.getByRole('button', { name: 'Back 30s' + suffix, exact: true }).click();
      await expect.poll(position).toBe(bookmarkPosition);
      if (output === 'browser') await page.locator('audio').dispatchEvent('timeupdate');
      await page.mouse.move(width - 1, 899);
      await page.screenshot({ path: testInfo.outputPath(`${output}-forest-palace-${width}.png`), fullPage: true, animations: 'disabled' });

      if (width === 1440) {
        if (output === 'browser') {
          const repeat = page.locator('.player-volume button[title^="Repeat"]');
          await expect(repeat).toHaveAttribute('aria-pressed', 'false');
          const off = await paint(repeat);
          await repeat.click();
          await page.mouse.move(width - 1, 899);
          await expect(repeat).toHaveAttribute('title', 'Repeat all');
          await expect(repeat).toHaveAttribute('aria-pressed', 'true');
          await expect.poll(async () => (await paint(repeat)).color).not.toBe(off.color);
          await repeat.click();
          await expect(repeat).toHaveAttribute('title', 'Repeat one');
          await expect(repeat).toHaveAttribute('aria-pressed', 'true');
          await expect(repeat).toHaveText('1');
          await repeat.click();
          await expect(repeat).toHaveAttribute('aria-pressed', 'false');
        }
        await page.mouse.move(width - 1, 899);
        const idleColor = (await paint(bookmark)).color;
        let addedPosition: number | undefined;
        await page.route(`**/ui/${trackId}/bookmarks`, route => {
          addedPosition = route.request().postDataJSON().position;
          return route.fulfill({ status: 201 });
        });
        await bookmark.click();
        await expect(bookmark).toHaveAttribute('data-feedback', 'success');
        await expect.poll(() => addedPosition).toBe(bookmarkPosition);
        const hoveredSuccess = (await paint(bookmark)).color;
        expect(hoveredSuccess).not.toBe(idleColor);
        await page.mouse.move(width - 1, 899);
        expect((await paint(bookmark)).color).toBe(hoveredSuccess);
      }
    });
  }
}
