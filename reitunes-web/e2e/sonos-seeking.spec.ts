import { expect, type Page } from '@playwright/test';
import { test, deferred, SonosSimulator } from './fixtures/sonos';

async function openPaused(page: Page) {
  await page.addInitScript(() => Object.defineProperty(HTMLMediaElement.prototype, 'duration', {
    configurable: true, get: () => 300,
  }));
  const sonos = new SonosSimulator(page);
  sonos.paused = true;
  await sonos.install();
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Play Sonos', exact: true })).toBeEnabled();
  await page.locator('audio').dispatchEvent('loadedmetadata');
  await page.locator('audio').dispatchEvent('canplay');
  await expect(page.getByRole('slider', { name: 'Sonos playback position' })).toHaveValue('50');
  return sonos;
}

for (const failed of [false, true]) {
  test(`Sonos seek bursts ${failed ? 'discard queued changes on failure' : 'accumulate immediately and coalesce'}`, async ({ page }) => {
    const sonos = await openPaused(page);
    const arrived = deferred();
    const release = deferred();
    const positions: number[] = [];
    await page.route('**/api/sonos/groups/group-1/playback/seek', async route => {
      const { positionMillis, itemId } = route.request().postDataJSON();
      expect(itemId).toBe('queue-item-1');
      positions.push(positionMillis);
      if (positions.length === 1) { arrived.resolve(); await release.promise; }
      if (failed) return route.fulfill({ status: 502, json: { error: 'Seek failed' } });
      sonos.speaker.positionMillis = positionMillis;
      await route.fulfill({ status: 204 });
    });
    try {
      const forward = page.getByRole('button', { name: 'Forward 30s on Sonos', exact: true });
      const slider = page.getByRole('slider', { name: 'Sonos playback position' });
      await forward.click();
      await arrived.promise;
      await expect(forward).toBeEnabled();
      for (let i = 0; i < 4; i++) await forward.click();
      await expect(slider).toHaveValue('200');
      // Old speaker events must not knock the pending position backwards.
      await sonos.emitPlayback();
      await expect(slider).toHaveValue('200');
      expect(positions).toEqual([80_000]);
      release.resolve();
      await expect(page.getByRole('button', { name: 'Play Sonos', exact: true })).toBeEnabled();
      await expect(slider).toHaveValue(failed ? '50' : '200');
      expect(positions).toEqual(failed ? [80_000] : [80_000, 200_000]);
      if (failed) await expect(page.getByText('Seek failed', { exact: true })).toBeVisible();
    } finally { release.resolve(); }
  });
}

test('Sonos clicks during seek readback build on the pending position and respect bounds', async ({ page }) => {
  const sonos = await openPaused(page);
  const positions: number[] = [];
  await page.route('**/api/sonos/groups/group-1/playback/seek', route => {
    sonos.speaker.positionMillis = route.request().postDataJSON().positionMillis;
    positions.push(sonos.speaker.positionMillis);
    return route.fulfill({ status: 204 });
  });
  const held = { arrived: deferred(), release: deferred() };
  sonos.delayedPoll = held;
  try {
    const slider = page.getByRole('slider', { name: 'Sonos playback position' });
    await page.getByRole('button', { name: 'Forward 30s on Sonos', exact: true }).click();
    await held.arrived.promise;
    for (let i = 0; i < 4; i++) await page.getByRole('button', { name: 'Back 30s on Sonos', exact: true }).click();
    await expect(slider).toHaveValue('0');
    for (let i = 0; i < 12; i++) await page.getByRole('button', { name: 'Forward 30s on Sonos', exact: true }).click();
    await expect(slider).toHaveValue('300'); // The range input rounds its 0.1s step.
    held.release.resolve();
    await expect(page.getByRole('button', { name: 'Play Sonos', exact: true })).toBeEnabled();
    expect(positions).toEqual([80_000, 299_999]);
  } finally { held.release.resolve(); }
});

test('Sonos changing tracks cancels queued seeks and ignores the old failure', async ({ page }) => {
  const sonos = await openPaused(page);
  const arrived = deferred();
  const release = deferred();
  const positions: number[] = [];
  await page.route('**/api/sonos/groups/group-1/playback/seek', async route => {
    positions.push(route.request().postDataJSON().positionMillis);
    arrived.resolve();
    await release.promise;
    return route.fulfill({ status: 502, json: { error: 'Old track seek failed' } });
  });
  try {
    const forward = page.getByRole('button', { name: 'Forward 30s on Sonos', exact: true });
    await forward.click();
    await arrived.promise;
    await forward.click();
    await page.evaluate(payload => window.dispatchEvent(new CustomEvent('reitunes:sonos', { detail: {
      targetId: 'group-1', namespace: 'playback', eventType: 'playbackStatus', payload,
    } })), { ...sonos.status(), itemId: 'queue-item-2', positionMillis: 10_000 });
    await expect(page.getByRole('slider', { name: 'Sonos playback position' })).toHaveValue('10');
    await expect(page.getByRole('button', { name: 'Play Sonos', exact: true })).toBeEnabled();
    const response = page.waitForResponse('**/api/sonos/groups/group-1/playback/seek');
    release.resolve();
    await (await response).finished();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    expect(positions).toEqual([80_000]);
    await expect(page.getByText('Old track seek failed')).toHaveCount(0);
    await expect(page.getByRole('slider', { name: 'Sonos playback position' })).toHaveValue('10');
  } finally { release.resolve(); }
});

test('Sonos output changes discard old seeks without releasing the new output lock', async ({ page }) => {
  const sonos = await openPaused(page);
  const arrived = deferred();
  const release = deferred();
  const positions: number[] = [];
  await page.route('**/api/sonos/groups/group-1/playback/seek', async route => {
    positions.push(route.request().postDataJSON().positionMillis);
    arrived.resolve();
    await release.promise;
    return route.fulfill({ status: 204 });
  });
  await page.route('**/api/sonos/groups/group-2/playback', route => route.fulfill({ json: sonos.status() }));
  await page.route('**/api/sonos/groups/group-2/volume', route => route.fulfill({ json: { volume: 20, muted: false, fixed: false } }));
  try {
    const forward = page.getByRole('button', { name: 'Forward 30s on Sonos', exact: true });
    await forward.click();
    await arrived.promise;
    await forward.click();
    await page.evaluate(async () => {
      const path = '/src/stores/playbackTargetStore.ts';
      const { usePlaybackTargetStore } = await import(path);
      usePlaybackTargetStore.getState().setSonosTarget({ householdId: 'household', groupId: 'group-2', groupName: 'Office', playerNames: [] });
      usePlaybackTargetStore.getState().setTransportPending(true);
    });
    const response = page.waitForResponse('**/api/sonos/groups/group-1/playback/seek');
    release.resolve();
    await (await response).finished();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    expect(positions).toEqual([80_000]);
    await expect(forward).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Play Sonos', exact: true })).toBeDisabled();
  } finally { release.resolve(); }
});

test('Sonos absolute scrubbing replaces queued skips without clearing a newer drag', async ({ page }) => {
  const sonos = await openPaused(page);
  const arrived = deferred();
  const release = deferred();
  const positions: number[] = [];
  await page.route('**/api/sonos/groups/group-1/playback/seek', async route => {
    const { positionMillis } = route.request().postDataJSON();
    positions.push(positionMillis);
    if (positions.length === 1) { arrived.resolve(); await release.promise; }
    sonos.speaker.positionMillis = positionMillis;
    return route.fulfill({ status: 204 });
  });
  try {
    const forward = page.getByRole('button', { name: 'Forward 30s on Sonos', exact: true });
    const slider = page.getByRole('slider', { name: 'Sonos playback position' });
    await forward.click();
    await arrived.promise;
    await forward.click();
    await slider.fill('150');
    await slider.dispatchEvent('pointerup');
    await forward.click();
    await expect(slider).toHaveValue('180');
    // A second drag has not been committed when the previous work completes.
    await slider.fill('220');
    release.resolve();
    await expect(page.getByRole('button', { name: 'Play Sonos', exact: true })).toBeEnabled();
    expect(positions).toEqual([80_000, 180_000]);
    await expect(slider).toHaveValue('220');
    await slider.dispatchEvent('pointerup');
    await expect.poll(() => positions).toEqual([80_000, 180_000, 220_000]);
  } finally { release.resolve(); }
});

for (const settles of [true, false]) {
  test(`Sonos seek readback ${settles ? 'waits for the final position' : 'accepts an external change after a bounded wait'}`, async ({ page }) => {
    const sonos = await openPaused(page);
    let commands = 0;
    let reads = 0;
    await page.route('**/api/sonos/groups/group-1/playback/seek', route => {
      commands++;
      sonos.speaker.positionMillis = route.request().postDataJSON().positionMillis;
      return route.fulfill({ status: 204 });
    });
    await page.route('**/api/sonos/groups/group-1/playback', route => {
      reads++;
      return route.fulfill({ json: { ...sonos.status(),
        positionMillis: settles && reads > 2 ? sonos.speaker.positionMillis : 50_000,
      } });
    });
    await page.getByRole('button', { name: 'Forward 30s on Sonos', exact: true }).click();
    const slider = page.getByRole('slider', { name: 'Sonos playback position' });
    await expect(slider).toHaveValue('80');
    await expect(page.getByRole('button', { name: 'Play Sonos', exact: true })).toBeEnabled();
    await expect(slider).toHaveValue(settles ? '80' : '50');
    expect(commands).toBe(1);
    expect(reads).toBeGreaterThan(1);
    expect(reads).toBeLessThanOrEqual(7);
  });
}
