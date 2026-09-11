import { expect, test, type Page } from '@playwright/test';

const TRACK_ID = '11111111-1111-4111-8111-111111111111';
const BOOKMARK_ID = '22222222-2222-4222-8222-222222222222';
const UNLABELLED_BOOKMARK_ID = '33333333-3333-4333-8333-333333333333';

const libraryItems = [
  {
    id: TRACK_ID,
    name: 'Northern Sky',
    artist: 'Nick Drake',
    album: 'Bryter Layter',
    created_time_utc: '2026-01-01T00:00:00',
    file_path: 'northern-sky.mp3',
    track_number: 7,
    play_count: 12,
    is_favorite: true,
    url: '/audio/northern-sky.mp3',
    bookmarks: {
      [BOOKMARK_ID]: {
        position: 70,
        emoji: '🎸',
        label: 'Guitar entrance',
        created_time_utc: '2026-08-01T12:00:00',
      },
      [UNLABELLED_BOOKMARK_ID]: {
        position: 145,
        emoji: '🎵',
        label: null,
        created_time_utc: '2026-07-01T12:00:00',
      },
    },
  },
];

async function mockBackend(page: Page) {
  await page.route('**/api/items', (route) => route.fulfill({ json: libraryItems }));
  await page.route('**/api/playlists', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/log', (route) => route.fulfill({ status: 200 }));
  await page.route('**/audio/*.mp3', (route) =>
    route.fulfill({ contentType: 'audio/mpeg', body: '' })
  );
  await page.route('**/ui/play', (route) => route.fulfill({ status: 200 }));
  await page.routeWebSocket('**/updates', () => {});
}

test('shows, filters, edits and deletes bookmarks', async ({ page }) => {
  await mockBackend(page);

  let updateBody: unknown;
  let deleteRequested = false;
  await page.route(`**/ui/${TRACK_ID}/bookmarks/${BOOKMARK_ID}`, async (route) => {
    if (route.request().method() === 'PUT') {
      updateBody = route.request().postDataJSON();
      await route.fulfill({ status: 200 });
    } else if (route.request().method() === 'DELETE') {
      deleteRequested = true;
      await route.fulfill({ status: 204 });
    } else {
      await route.fallback();
    }
  });

  await page.goto('/');
  await page.locator('.library-toolbar').getByRole('button', { name: 'Bookmarks' }).click();

  await expect(page.getByRole('heading', { name: 'Bookmarks' })).toBeVisible();
  await expect(page.getByText('Guitar entrance')).toBeVisible();
  await expect(page.getByText('Unlabelled bookmark')).toBeVisible();

  await page.getByRole('searchbox', { name: 'Filter bookmarks' }).fill('Bryter');
  await expect(page.getByText('Guitar entrance')).toBeVisible();
  await page.getByRole('searchbox', { name: 'Filter bookmarks' }).fill('missing');
  await expect(page.getByText('No matching bookmarks')).toBeVisible();
  await page.getByRole('searchbox', { name: 'Filter bookmarks' }).fill('');

  const editButton = page.getByRole('button', { name: 'Edit bookmark for Northern Sky' }).first();
  await editButton.hover();
  await editButton.click();
  await page.getByRole('textbox', { name: 'Bookmark label for Northern Sky' }).fill('First chorus');
  await page.getByRole('textbox', { name: 'Bookmark emoji for Northern Sky' }).fill('🔥');
  await page.getByRole('button', { name: 'Save', exact: true }).click();

  await expect.poll(() => updateBody).toEqual({ label: 'First chorus', emoji: '🔥' });

  page.once('dialog', (dialog) => dialog.accept());
  const deleteButton = page.getByRole('button', { name: 'Delete bookmark for Northern Sky' }).first();
  await deleteButton.hover();
  await deleteButton.click();
  await expect.poll(() => deleteRequested).toBe(true);
});

test('restores a saved track paused and registers media controls', async ({ page }) => {
  await page.addInitScript(
    ({ storageKey, storedTrackId }) => {
      localStorage.setItem(
        storageKey,
        JSON.stringify({
          state: {
            currentItemId: storedTrackId,
            resumePosition: 73,
            volume: 0.4,
            isMuted: true,
          },
          version: 1,
        })
      );

      const testWindow = window as typeof window & {
        __playCalls: number;
        __mediaHandlers: Record<string, unknown>;
      };
      testWindow.__playCalls = 0;
      testWindow.__mediaHandlers = {};

      Object.defineProperty(HTMLMediaElement.prototype, 'play', {
        configurable: true,
        value() {
          testWindow.__playCalls += 1;
          const source = this.src;
          Object.defineProperty(this, 'paused', { configurable: true, get: () => this.src !== source });
          this.dispatchEvent(new Event('play'));
          return Promise.resolve();
        },
      });
      Object.defineProperty(HTMLMediaElement.prototype, 'pause', {
        configurable: true,
        value() { Object.defineProperty(this, 'paused', { configurable: true, value: true }); this.dispatchEvent(new Event('pause')); },
      });

      class TestMediaMetadata {
        title = '';
        artist = '';
        album = '';

        constructor(init: MediaMetadataInit) {
          Object.assign(this, init);
        }
      }

      Object.defineProperty(window, 'MediaMetadata', {
        configurable: true,
        value: TestMediaMetadata,
      });
      Object.defineProperty(navigator, 'mediaSession', {
        configurable: true,
        value: {
          metadata: null,
          playbackState: 'none',
          setActionHandler(action: string, handler: unknown) {
            testWindow.__mediaHandlers[action] = handler;
          },
          setPositionState() {},
        },
      });
    },
    { storageKey: 'reitunes-player', storedTrackId: TRACK_ID }
  );
  await mockBackend(page);

  await page.goto('/');
  await expect(page.getByText('Northern Sky').first()).toBeVisible();
  const playButton = page.getByRole('button', { name: 'Play', exact: true });
  await expect(playButton).toBeVisible();

  const restoredState = await page.evaluate(() => {
    const testWindow = window as typeof window & {
      __playCalls: number;
      __mediaHandlers: Record<string, unknown>;
    };
    return {
      playCalls: testWindow.__playCalls,
      playbackState: navigator.mediaSession.playbackState,
      title: navigator.mediaSession.metadata?.title,
      actions: Object.keys(testWindow.__mediaHandlers).sort(),
      volume: document.querySelector('audio')?.volume,
    };
  });

  expect(restoredState).toEqual({
    playCalls: 0,
    playbackState: 'paused',
    title: 'Northern Sky',
    actions: [
      'nexttrack',
      'pause',
      'play',
      'previoustrack',
      'seekbackward',
      'seekforward',
      'seekto',
    ],
    volume: 0,
  });

  await playButton.click();
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __playCalls: number }).__playCalls)).toBeGreaterThan(0);
});

test('offers Sonos authorization when the server is not connected', async ({ page }) => {
  await mockBackend(page);
  await page.route('**/api/sonos/status', (route) =>
    route.fulfill({ json: { configured: true, connected: false } })
  );

  await page.goto('/');
  await page.getByRole('button', { name: 'Sonos', exact: true }).click();

  await expect(page.getByRole('heading', { name: 'Sonos' })).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Sonos' }).getByText('This browser', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Connect Sonos' })).toHaveAttribute(
    'href',
    '/api/sonos/authorize'
  );
});

test('opens Sonos after the OAuth callback without sending the marker to the server', async ({ page }) => {
  await mockBackend(page);
  await page.route('**/api/sonos/status', (route) =>
    route.fulfill({ json: { configured: true, connected: false } })
  );

  await page.goto('/#sonos=connected');

  await expect(page.getByRole('dialog', { name: 'Sonos' })).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
});

test('switches between Sonos and browser playback without playing twice', async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    const testWindow = window as typeof window & { __playCalls: number };
    testWindow.__playCalls = 0;
    Object.defineProperty(HTMLMediaElement.prototype, 'play', {
      configurable: true,
      value() {
        testWindow.__playCalls += 1;
        const source = this.src;
        Object.defineProperty(this, 'paused', { configurable: true, get: () => this.src !== source });
        this.dispatchEvent(new Event('play'));
        return Promise.resolve();
      },
    });
    Object.defineProperty(HTMLMediaElement.prototype, 'pause', {
      configurable: true,
      value() {
        Object.defineProperty(this, 'paused', { configurable: true, value: true });
        this.dispatchEvent(new Event('pause'));
      },
    });
  });
  await mockBackend(page);
  await page.route('**/api/sonos/status', (route) =>
    route.fulfill({ json: { configured: true, connected: true } })
  );
  await page.route('**/api/sonos/households', (route) =>
    route.fulfill({ json: { households: [{ id: 'Sonos_household' }] } })
  );
  await page.route('**/api/sonos/households/Sonos_household/groups', (route) =>
    route.fulfill({
      json: {
        groups: [
          {
            id: 'group-1',
            name: 'Downstairs',
            coordinatorId: 'player-1',
            playerIds: ['player-1', 'player-2'],
            playbackState: 'PLAYBACK_STATE_IDLE',
          },
        ],
        players: [
          { id: 'player-1', name: 'Kitchen', capabilities: ['PLAYBACK'] },
          { id: 'player-2', name: 'Dining Room', capabilities: ['PLAYBACK'] },
        ],
      },
    })
  );
  const sonosPlayRequests: Array<Record<string, unknown>> = [];
  let sonosSessionActive = false;
  let sonosPlaybackState = 'PLAYBACK_STATE_PLAYING';
  let sonosVolume = 37;
  let sonosMuted = false;
  let rejectNextPlay = false;
  const transportRequests: string[] = [];
  let rejectPause = false;
  let pauseGate: Promise<void> | null = null;
  const volumeRequests: Array<Record<string, unknown>> = [];
  await page.route('**/api/sonos/play', async (route) => {
    const request = route.request().postDataJSON() as Record<string, unknown>;
    sonosPlayRequests.push(request);
    if (rejectNextPlay && request.allowTakeover === false) {
      rejectNextPlay = false;
      sonosSessionActive = false;
      await route.fulfill({
        status: 409,
        json: {
          error: "ReiTunes needs confirmation before replacing this Sonos group's playback",
        },
      });
      return;
    }
    sonosSessionActive = true;
    sonosPlaybackState = 'PLAYBACK_STATE_PLAYING';
    await route.fulfill({
      json: { groupId: 'group-1', sessionCreated: sonosPlayRequests.length === 1 },
    });
  });
  await page.route('**/api/sonos/groups/group-1/playback', (route) =>
    route.fulfill({
      json: {
        playbackState: sonosPlaybackState,
        positionMillis: 42_000,
        itemId: 'queue-item-1',
        queueVersion: 'queue-version-1',
        sourceItemId: sonosSessionActive ? TRACK_ID : null,
        reitunesSessionActive: sonosSessionActive,
        availablePlaybackActions: { canPause: true },
      },
    })
  );
  await page.route('**/api/sonos/groups/group-1/playback/*', async (route) => {
    const command = route.request().url().split('/').at(-1) || '';
    transportRequests.push(command);
    if (command === 'pause' && rejectPause) {
      rejectPause = false;
      await route.fulfill({ status: 503, json: { error: 'Speaker unavailable' } });
      return;
    }
    if (command === 'pause' && pauseGate) await pauseGate;
    sonosPlaybackState =
      command === 'pause' ? 'PLAYBACK_STATE_PAUSED' : 'PLAYBACK_STATE_PLAYING';
    await route.fulfill({ status: 204 });
  });
  await page.route('**/api/sonos/groups/group-1/volume', async (route) => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      volumeRequests.push(body);
      sonosVolume = body.volume as number;
      sonosMuted = false;
      await route.fulfill({ status: 204 });
      return;
    }
    await route.fulfill({
      json: { volume: sonosVolume, muted: sonosMuted, fixed: false },
    });
  });
  await page.route('**/api/sonos/groups/group-1/mute', async (route) => {
    const body = route.request().postDataJSON() as { muted: boolean };
    sonosMuted = body.muted;
    await route.fulfill({ status: 204 });
  });

  await page.goto('/');
  const trackRow = page.getByRole('row').filter({ hasText: 'Northern Sky' });
  await page.getByRole('button', { name: 'Sonos', exact: true }).click();

  const dialog = page.getByRole('dialog', { name: 'Sonos' });
  await expect(dialog.getByText('Downstairs')).toBeVisible();
  await expect(dialog.getByText('Kitchen + Dining Room')).toBeVisible();
  await dialog.getByRole('button', { name: 'Use this group' }).click();
  await expect(dialog.getByRole('button', { name: 'Selected' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();

  await trackRow.click();
  await expect.poll(() => sonosPlayRequests.length).toBe(1);
  expect(sonosPlayRequests[0]).toEqual({
    groupId: 'group-1',
    itemIds: [TRACK_ID],
    startItemId: TRACK_ID,
    positionMillis: 0,
    allowTakeover: true,
  });
  await expect(page.getByText('Sonos · Downstairs · Playing')).toBeVisible();
  await expect(page.getByText(/^0:4[2-9]$/)).toBeVisible();
  expect(
    await page.evaluate(() => (window as typeof window & { __playCalls: number }).__playCalls)
  ).toBe(0);

  await page.evaluate((trackId) => {
    window.dispatchEvent(
      new CustomEvent('reitunes:sonos', {
        detail: {
          type: 'sonos',
          namespace: 'playback',
          eventType: 'playbackStatus',
          targetId: 'group-1',
          payload: {
            playbackState: 'PLAYBACK_STATE_PAUSED',
            positionMillis: 55_000,
            itemId: 'queue-item-1',
            queueVersion: 'queue-version-1',
            sourceItemId: trackId,
            reitunesSessionActive: true,
            availablePlaybackActions: { canPause: true },
          },
        },
      })
    );
    window.dispatchEvent(
      new CustomEvent('reitunes:sonos', {
        detail: {
          type: 'sonos',
          namespace: 'groupVolume',
          eventType: 'groupVolume',
          targetId: 'group-1',
          payload: { volume: 51, muted: false, fixed: false },
        },
      })
    );
  }, TRACK_ID);
  await expect(page.getByRole('button', { name: 'Play Sonos' })).toBeVisible();
  await expect(page.getByText('0:55')).toBeVisible();

  const sonosVolumeSlider = page.getByRole('slider', { name: 'Sonos group volume' });
  await expect(sonosVolumeSlider).toHaveValue('51');
  await page.evaluate((trackId) => {
    window.dispatchEvent(
      new CustomEvent('reitunes:sonos', {
        detail: {
          type: 'sonos',
          namespace: 'playback',
          eventType: 'playbackStatus',
          targetId: 'group-1',
          payload: {
            playbackState: 'PLAYBACK_STATE_PLAYING',
            positionMillis: 55_000,
            itemId: 'queue-item-1',
            queueVersion: 'queue-version-1',
            sourceItemId: trackId,
            reitunesSessionActive: true,
            availablePlaybackActions: { canPause: true },
          },
        },
      })
    );
  }, TRACK_ID);
  await expect(page.getByRole('button', { name: 'Pause Sonos' })).toBeVisible();

  await page.getByRole('button', { name: 'Pause Sonos' }).click();
  await expect.poll(() => transportRequests).toContain('pause');
  await expect(page.getByRole('button', { name: 'Play Sonos' })).toBeVisible();
  await page.getByRole('button', { name: 'Play Sonos' }).click();
  await expect.poll(() => transportRequests).toEqual(['pause', 'play']);

  await sonosVolumeSlider.fill('63');
  await sonosVolumeSlider.dispatchEvent('pointerup');
  await expect.poll(() => volumeRequests).toContainEqual({ volume: 63 });
  await page.getByRole('button', { name: 'Mute Sonos' }).click();
  await expect(page.getByRole('button', { name: 'Unmute Sonos' })).toBeVisible();

  rejectNextPlay = true;
  await trackRow.click();
  await expect.poll(() => sonosPlayRequests.length).toBe(2);
  expect(sonosPlayRequests[1].allowTakeover).toBe(false);
  await page.getByRole('button', { name: 'Replace Sonos playback and retry' }).click();
  await expect.poll(() => sonosPlayRequests.length).toBe(3);
  expect(sonosPlayRequests[2].allowTakeover).toBe(true);
  await expect(page.getByText('Sonos · Downstairs · Playing')).toBeVisible();

  for (const width of [1440, 2560, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const dimensions = await page.evaluate(() => {
      const rect = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
      const transport = rect('.sonos-transport');
      const title = rect('.sonos-track-title');
      const progress = rect('.sonos-progress');
      return {
        height: rect('.player-bar').height,
        volumeWidth: rect('.sonos-volume input').width,
        transportBeforeTitle: transport.right <= title.left,
        progressBelowTitle: progress.top >= title.bottom,
        fits: document.documentElement.scrollWidth <= window.innerWidth,
      };
    });
    expect(dimensions.height).toBeLessThanOrEqual(width > 650 ? 44 : 68);
    expect(dimensions.volumeWidth).toBe(110);
    expect(dimensions.transportBeforeTitle).toBe(true);
    expect(dimensions.progressBelowTitle).toBe(true);
    expect(dimensions.fits).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`sonos-${width}.png`) });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByRole('button', { name: 'Change output', exact: true })).toHaveCount(0);

  // A failed pause must not start the browser or claim that output switched.
  rejectPause = true;
  await page.getByRole('button', { name: 'Sonos', exact: true }).click();
  await dialog.getByRole('button', { name: 'Use browser' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Speaker unavailable');
  expect(sonosPlaybackState).toBe('PLAYBACK_STATE_PLAYING');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('reitunes-playback-target')!).state.target.kind)).toBe('sonos');
  expect(await page.evaluate(() => (window as typeof window & { __playCalls: number }).__playCalls)).toBe(0);

  // Hold the acknowledgement to verify ordering and block duplicate handoffs.
  let releasePause!: () => void;
  pauseGate = new Promise<void>(resolve => { releasePause = resolve; });
  await dialog.getByRole('button', { name: 'Use browser' }).click();
  await expect(dialog.getByRole('button', { name: 'Switching…' })).toBeDisabled();
  await expect.poll(() => transportRequests).toEqual(['pause', 'play', 'pause', 'pause']);
  expect(await page.evaluate(() => (window as typeof window & { __playCalls: number }).__playCalls)).toBe(0);
  releasePause();
  pauseGate = null;
  await expect(dialog.getByRole('button', { name: 'Use browser' })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() => (window as typeof window & { __playCalls: number }).__playCalls)
    )
    .toBeGreaterThan(0);
  expect(sonosPlaybackState).toBe('PLAYBACK_STATE_PAUSED');
  await page.locator('audio').evaluate(audio => audio.dispatchEvent(new Event('canplay')));
  await expect.poll(() => page.locator('audio').evaluate(audio => audio.currentTime)).toBe(42);
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('reitunes:sonos', {
    detail: { targetId: 'group-1', namespace: 'playback', eventType: 'playbackStatus',
      payload: { playbackState: 'PLAYBACK_STATE_PAUSED', positionMillis: 42_000, reitunesSessionActive: true } },
  })));
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();

  // Moving an already-paused Sonos session back must not autoplay locally.
  const playCalls = await page.evaluate(() => (window as typeof window & { __playCalls: number }).__playCalls);
  await page.getByRole('button', { name: 'Sonos', exact: true }).click();
  await dialog.getByRole('button', { name: 'Use this group' }).click();
  await dialog.getByRole('button', { name: 'Use browser' }).click();
  await expect(dialog.getByRole('button', { name: 'Use browser' })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as typeof window & { __playCalls: number }).__playCalls)).toBe(playCalls);
  expect(sonosPlayRequests).toHaveLength(3);
});

test('Sonos status messages keep controls aligned and timeouts offer a normal retry', async ({ page }, testInfo) => {
  await mockBackend(page);
  await page.addInitScript(() => localStorage.setItem('reitunes-playback-target', JSON.stringify({
    version: 1, state: { target: { kind: 'sonos', householdId: 'household', groupId: 'group-1', groupName: 'Kitchen + 3', playerNames: [] }, takeoverRequired: true },
  })));
  await page.route('**/api/sonos/groups/group-1/playback', route => route.fulfill({ json: {
    playbackState: 'PLAYBACK_STATE_PLAYING', positionMillis: 0, sourceItemId: TRACK_ID,
    reitunesSessionActive: true, availablePlaybackActions: { canPause: true },
  } }));
  await page.route('**/api/sonos/groups/group-1/volume', route => route.fulfill({ json: { volume: 50, muted: false, fixed: false } }));
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const requests: Array<{ allowTakeover: boolean }> = [];
  await page.route('**/api/sonos/play', async route => {
    requests.push(route.request().postDataJSON());
    if (requests.length === 1) {
      await gate;
      await route.fulfill({ status: 502, json: { error: 'Sonos took too long to respond. Try again.' } });
    } else {
      await route.fulfill({ json: { groupId: 'group-1', sessionCreated: false } });
    }
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await expect(page.locator('tbody tr')).toHaveCount(1);
  const controls = () => page.evaluate(() => {
    const center = (selector: string) => {
      const box = document.querySelector(selector)!.getBoundingClientRect();
      return box.top + box.height / 2;
    };
    return [center('.sonos-transport'), center('.output-button'), center('.settings-button')];
  });
  const initial = await controls();
  expect(Math.max(...initial) - Math.min(...initial)).toBeLessThanOrEqual(1);
  await page.getByRole('row').filter({ hasText: 'Northern Sky' }).click();
  await expect(page.getByText('Sending to Kitchen + 3…')).toBeVisible();
  expect(await controls()).toEqual(initial);
  await page.screenshot({ path: testInfo.outputPath('sonos-sending.png') });
  release();
  await expect(page.getByRole('button', { name: 'Retry sending to Sonos', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Replace Sonos playback and retry' })).toHaveCount(0);
  expect(await controls()).toEqual(initial);
  await page.screenshot({ path: testInfo.outputPath('sonos-timeout.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  const mobile = await controls();
  expect(Math.max(...mobile) - Math.min(...mobile)).toBeLessThanOrEqual(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('sonos-timeout-mobile.png') });
  await page.getByRole('button', { name: 'Retry sending to Sonos', exact: true }).click();
  await expect.poll(() => requests.length).toBe(2);
  expect(requests.map(request => request.allowTakeover)).toEqual([true, false]);
  await expect(page.getByRole('button', { name: 'Retry sending to Sonos', exact: true })).toHaveCount(0);
});
