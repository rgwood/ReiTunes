import { expect, type Page } from '@playwright/test';
import { test, deferred, SonosSimulator } from './fixtures/sonos';

async function playerGeometry(page: Page) {
  return page.evaluate(() => {
    const rect = (selector: string) => {
      const { x, y, width, height } = document.querySelector(selector)!.getBoundingClientRect();
      return { x, y, width, height };
    };
    return {
      player: rect('.player-bar'),
      timeline: rect('.player-timeline'),
      controls: rect('.transport-group'),
      library: rect('.library-results'),
      overflow: document.documentElement.scrollWidth > innerWidth,
    };
  });
}

for (const width of [1440, 390]) {
  test(`Sonos initial loading keeps the player and library fixed at ${width}px`, async ({ page }) => {
    const sonos = new SonosSimulator(page);
    const firstRead = { arrived: deferred(), release: deferred() };
    await sonos.install();
    await page.route('**/api/tags', route => route.fulfill({ json: [] }));
    // Strict Mode can mount the polling hook twice. Hold every initial read.
    await page.route('**/api/sonos/groups/group-1/playback', async route => {
      firstRead.arrived.resolve();
      await firstRead.release.promise;
      await route.fulfill({ json: sonos.status() });
    });
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    await firstRead.arrived.promise;
    await expect(page.getByRole('status').filter({ hasText: 'Reading Kitchen…' })).toBeVisible();

    const initial = await playerGeometry(page);
    const groupName = 'Kitchen, dining room, living room, upstairs bedroom and garden speakers';
    await page.evaluate(async name => {
      // @ts-expect-error Vite serves the store module for this integration test.
      const { usePlaybackTargetStore } = await import('/src/stores/playbackTargetStore.ts');
      const state = usePlaybackTargetStore.getState();
      usePlaybackTargetStore.setState({ target: { ...state.target, groupName: name } });
    }, groupName);
    await expect(page.locator('.sonos-track-title')).toHaveAttribute('title', `Reading ${groupName}…`);
    expect(await playerGeometry(page)).toEqual(initial);

    firstRead.release.resolve();
    await expect(page.getByRole('button', { name: 'Pause Sonos', exact: true })).toBeEnabled();
    await expect(page.locator('.sonos-track-title')).toContainText('Northern Sky');
    expect(await playerGeometry(page)).toEqual(initial);
    expect(initial.overflow).toBe(false);

    const sending = deferred();
    sonos.delayedQueue = sending;
    await page.getByRole('row').filter({ hasText: 'Northern Sky' }).dblclick();
    await expect(page.getByRole('status').filter({ hasText: `Sending to ${groupName}…` })).toBeVisible();
    expect(await playerGeometry(page)).toEqual(initial);
    sending.resolve();
    await expect(page.locator('.sonos-track-title')).toContainText('Northern Sky');
    expect(await playerGeometry(page)).toEqual(initial);
  });
}
