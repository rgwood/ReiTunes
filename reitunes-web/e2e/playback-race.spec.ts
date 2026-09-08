import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  const items = ['First track', 'Bookmarked track'].map((name, index) => ({
    id: `11111111-1111-4111-8111-11111111111${index}`,
    name,
    artist: 'Test artist',
    album: '',
    file_path: `${index}.mp3`,
    url: `/audio/${index}.mp3`,
    created_time_utc: '2026-09-01T12:00:00',
    track_number: index + 1,
    play_count: 0,
    is_favorite: false,
    bookmarks:
      index === 1
        ? {
            saved: {
              position: 70,
              emoji: '🎸',
              label: 'Saved moment',
              created_time_utc: '2026-09-01T12:00:00',
            },
          }
        : {},
  }));
  await page.route('**/api/items', (route) => route.fulfill({ json: items }));
  await page.route('**/api/playlists', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/log', (route) => route.fulfill({ status: 200 }));
  await page.route('**/ui/play', (route) => route.fulfill({ status: 200 }));
  await page.routeWebSocket('**/updates', () => {});
  await page.addInitScript(() => {
    const states = new WeakMap<
      HTMLMediaElement,
      { paused: boolean; src: string; time: number }
    >();
    const state = (audio: HTMLMediaElement) => {
      let value = states.get(audio);
      if (!value) {
        value = { paused: true, src: '', time: 0 };
        states.set(audio, value);
      }
      return value;
    };
    const harness = {
      playCalls: 0,
      pauseCalls: 0,
      deferFirst: false,
      rejectFirst: () => {},
    };
    Object.assign(window, { playbackHarness: harness });
    Object.defineProperties(HTMLMediaElement.prototype, {
      src: {
        configurable: true,
        get() {
          return state(this).src;
        },
        set(src: string) {
          Object.assign(state(this), { src, paused: true, time: 0 });
        },
      },
      currentTime: {
        configurable: true,
        get() {
          return state(this).time;
        },
        set(time: number) {
          state(this).time = time;
        },
      },
      paused: {
        configurable: true,
        get() {
          return state(this).paused;
        },
      },
      readyState: {
        configurable: true,
        get() {
          return 4;
        },
      },
      duration: {
        configurable: true,
        get() {
          return 300;
        },
      },
      play: {
        configurable: true,
        value() {
          harness.playCalls += 1;
          state(this).paused = false;
          this.dispatchEvent(new Event('play'));
          if (harness.deferFirst && harness.playCalls === 1) {
            return new Promise<void>((_resolve, reject) => {
              harness.rejectFirst = () =>
                reject(new DOMException('Old request', 'AbortError'));
            });
          }
          return Promise.resolve();
        },
      },
      pause: {
        configurable: true,
        value() {
          harness.pauseCalls += 1;
          state(this).paused = true;
          this.dispatchEvent(new Event('pause'));
        },
      },
    });
  });
  await page.goto('/');
  await expect(page.locator('tbody tr')).toHaveCount(2);
});

test('queued media events cannot reverse the current playback state', async ({
  page,
}) => {
  await page.keyboard.press('Control+e');
  await expect(
    page.getByRole('button', { name: 'Pause', exact: true })
  ).toBeVisible();
  // A pause task from an earlier source can arrive after the new play task.
  await page
    .locator('audio')
    .evaluate((audio) => audio.dispatchEvent(new Event('pause')));
  await expect(
    page.getByRole('button', { name: 'Pause', exact: true })
  ).toBeVisible();
  expect(await page.locator('audio').evaluate((audio) => audio.paused)).toBe(
    false
  );

  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Play', exact: true })
  ).toBeVisible();
  await page
    .locator('audio')
    .evaluate((audio) => audio.dispatchEvent(new Event('play')));
  await expect(
    page.getByRole('button', { name: 'Play', exact: true })
  ).toBeVisible();
  expect(await page.locator('audio').evaluate((audio) => audio.paused)).toBe(
    true
  );
});

test('an old play rejection cannot stop a newer Ctrl+E bookmark request', async ({
  page,
}) => {
  await page.evaluate(() => {
    (
      window as unknown as { playbackHarness: { deferFirst: boolean } }
    ).playbackHarness.deferFirst = true;
  });
  await page.getByRole('row').filter({ hasText: 'First track' }).click();
  await page.keyboard.press('Control+e');
  await expect(page.locator('.player-now-playing')).toContainText(
    'Bookmarked track'
  );
  await expect
    .poll(() => page.locator('audio').evaluate((audio) => audio.currentTime))
    .toBe(70);
  await page.evaluate(() => {
    (
      window as unknown as { playbackHarness: { rejectFirst: () => void } }
    ).playbackHarness.rejectFirst();
  });
  await expect(
    page.getByRole('button', { name: 'Pause', exact: true })
  ).toBeVisible();
  expect(await page.locator('audio').evaluate((audio) => audio.paused)).toBe(
    false
  );
});

test('held Ctrl+E does not continually restart the bookmark and logs its origin', async ({
  page,
}) => {
  const logs: Array<{
    message: string;
    args?: Array<{
      session: string;
      events: Array<{ event: string; origin?: string }>;
    }>;
  }> = [];
  await page.route('**/api/log', (route) => {
    logs.push(route.request().postDataJSON());
    return route.fulfill({ status: 200 });
  });
  await page.keyboard.press('Control+e');
  await page.locator('audio').evaluate((audio) => {
    audio.currentTime = 80;
  });
  await page.evaluate(() =>
    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'e',
        ctrlKey: true,
        repeat: true,
        bubbles: true,
      })
    )
  );
  expect(
    await page.locator('audio').evaluate((audio) => audio.currentTime)
  ).toBe(80);
  await expect
    .poll(
      () =>
        logs
          .filter((log) => log.message === '[Playback]')
          .flatMap((log) => log.args?.[0].events ?? [])
          .filter(
            (event) => event.event === 'request' && event.origin === 'ctrl-e'
          ).length
    )
    .toBe(1);
  expect(
    logs.find((log) => log.message === '[Playback]')?.args?.[0].session
  ).toBeTruthy();
});
