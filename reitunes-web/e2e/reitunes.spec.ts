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
  await page.getByRole('button', { name: 'Bookmarks' }).click();

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
  await page.getByRole('button', { name: 'Save' }).click();

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
          this.dispatchEvent(new Event('play'));
          return Promise.resolve();
        },
      });
      Object.defineProperty(HTMLMediaElement.prototype, 'pause', {
        configurable: true,
        value() {},
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
  await page.getByRole('button', { name: 'Sonos' }).click();

  await expect(page.getByRole('heading', { name: 'Sonos' })).toBeVisible();
  await expect(page.getByText('Speaker discovery only')).toBeVisible();
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

test('shows Sonos households and groups without playback controls', async ({ page }) => {
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

  await page.goto('/');
  await page.getByRole('button', { name: 'Sonos' }).click();

  const dialog = page.getByRole('dialog', { name: 'Sonos' });
  await expect(dialog.getByText('Downstairs')).toBeVisible();
  await expect(dialog.getByText('Kitchen + Dining Room')).toBeVisible();
  await expect(dialog.getByRole('button', { name: /play/i })).toHaveCount(0);
});
