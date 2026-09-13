import { expect } from '@playwright/test';
import { test, deferred, SonosSimulator } from './fixtures/sonos';

for (const failed of [false, true]) {
  test(`Sonos rapid volume clicks ${failed ? 'reconcile a failure without sending queued changes' : 'respond immediately and coalesce while a request is pending'}`, async ({ page }) => {
    const sonos = new SonosSimulator(page);
    await sonos.open();
    const arrived = deferred();
    const release = deferred();
    const values: number[] = [];
    await page.route('**/api/sonos/groups/group-1/volume', async route => {
      if (route.request().method() !== 'POST') return route.fallback();
      const value = route.request().postDataJSON().volume;
      values.push(value);
      if (values.length === 1) { arrived.resolve(); await release.promise; }
      if (failed) return route.fulfill({ status: 502, json: { error: 'Volume change failed' } });
      sonos.speaker.volume = value;
      return route.fulfill({ status: 204 });
    });
    try {
      const up = page.getByRole('button', { name: 'Volume up', exact: true });
      const volume = page.getByRole('slider', { name: 'Sonos group volume' });
      await up.click();
      await arrived.promise;
      await expect(volume).toHaveValue('51');
      await expect(up).toBeEnabled();
      for (let i = 0; i < 4; i++) await up.click();
      await expect(volume).toHaveValue('55');
      expect(values).toEqual([51]);
      release.resolve();
      if (failed) {
        await expect(page.getByText('Volume change failed', { exact: true })).toBeVisible();
        await expect(volume).toHaveValue('50');
        await expect(page.getByRole('button', { name: 'Mute Sonos', exact: true })).toBeEnabled();
        expect(values).toEqual([51]);
      } else {
        await expect.poll(() => sonos.speaker.volume).toBe(55);
        await expect(page.getByRole('button', { name: 'Mute Sonos', exact: true })).toBeEnabled();
        await expect(volume).toHaveValue('55');
        expect(values).toEqual([51, 55]);
      }
    } finally { release.resolve(); }
  });
}

test('Sonos volume clicks during readback preserve the latest requested level', async ({ page }) => {
  const sonos = new SonosSimulator(page);
  await sonos.open();
  await expect(page.getByRole('slider', { name: 'Sonos group volume' })).toHaveValue('50');
  const held = { arrived: deferred(), release: deferred() };
  sonos.delayedVolume = held;
  await page.getByRole('button', { name: 'Volume up', exact: true }).click();
  await held.arrived.promise;
  await page.getByRole('button', { name: 'Volume up', exact: true }).click();
  await page.getByRole('button', { name: 'Volume up', exact: true }).click();
  await expect(page.getByRole('slider', { name: 'Sonos group volume' })).toHaveValue('53');
  held.release.resolve();
  await expect.poll(() => sonos.speaker.volume).toBe(53);
  await expect(page.getByRole('button', { name: 'Mute Sonos', exact: true })).toBeEnabled();
  await expect(page.getByRole('slider', { name: 'Sonos group volume' })).toHaveValue('53');
});

test('Sonos rejected pause keeps the actual playing state and allows another attempt', async ({ page }) => {
  const sonos = new SonosSimulator(page);
  sonos.pauseResult = 'rejected';
  await sonos.open();
  await page.getByRole('button', { name: 'Pause Sonos', exact: true }).click();
  await expect(page.getByText('Sonos pause was not acknowledged')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Pause Sonos', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Play Sonos', exact: true })).toHaveCount(0);
  sonos.pauseResult = 'ok';
  await page.getByRole('button', { name: 'Pause Sonos', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Play Sonos', exact: true })).toBeEnabled();
  await expect(page.getByText('Sonos pause was not acknowledged')).toHaveCount(0);
  expect(sonos.commands).toEqual(['pause', 'pause']);
});

test('Sonos lost pause reply is confirmed by reading the speaker without sending pause twice', async ({ page }) => {
  const sonos = new SonosSimulator(page);
  sonos.pauseResult = 'lost-reply';
  await sonos.open();
  await page.getByRole('button', { name: 'Pause Sonos', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Play Sonos', exact: true })).toBeEnabled();
  await expect(page.getByText('Sonos pause was not acknowledged')).toHaveCount(0);
  expect(sonos.commands).toEqual(['pause']);
});

for (const fails of [false, true]) {
  test(`Sonos late ${fails ? 'failed' : 'successful'} poll cannot overwrite a newer speaker event`, async ({ page }) => {
    const sonos = new SonosSimulator(page);
    await sonos.open();
    const gate = { arrived: deferred(), release: deferred() };
    sonos.delayedPoll = gate;
    sonos.statusFails = fails;
    await sonos.refresh();
    await gate.arrived.promise;
    sonos.paused = true;
    await sonos.emitPlayback();
    await expect(page.getByRole('button', { name: 'Play Sonos', exact: true })).toBeEnabled();
    const response = page.waitForResponse('**/api/sonos/groups/group-1/playback');
    gate.release.resolve();
    await (await response).finished();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(page.getByRole('button', { name: 'Play Sonos', exact: true })).toBeEnabled();
    await expect(page.getByText('Speaker status unavailable')).toHaveCount(0);
  });
}

test('Sonos stalled queue request releases controls and retry does not retain takeover permission', async ({ page }) => {
  await page.clock.install();
  const sonos = new SonosSimulator(page);
  await sonos.open();
  const gate = deferred();
  sonos.delayedQueue = gate;
  await page.getByRole('row').filter({ hasText: 'Northern Sky' }).click();
  await expect(page.getByText('Sending to Kitchen…')).toBeVisible();
  await expect.poll(() => sonos.queueRequests.length).toBe(1);
  await page.clock.fastForward(50_001);
  const retry = page.getByRole('button', { name: 'Retry sending to Sonos', exact: true });
  await expect(retry).toBeVisible();
  await expect(page.getByText('Sonos did not confirm the request. Check the speakers before retrying.')).toBeVisible();
  await retry.click();
  await expect.poll(() => sonos.queueRequests.length).toBe(2);
  await expect(retry).toHaveCount(0);
  expect(sonos.queueRequests.map(request => request.allowTakeover)).toEqual([true, false]);
  gate.resolve();
});

test('Sonos refreshes promptly when the connection returns', async ({ page }) => {
  const sonos = new SonosSimulator(page);
  await sonos.open();
  sonos.statusFails = true;
  await sonos.refresh();
  await expect(page.getByText('Speaker status unavailable')).toBeVisible();
  sonos.statusFails = false;
  sonos.paused = true;
  await sonos.refresh();
  await expect(page.getByRole('button', { name: 'Play Sonos', exact: true })).toBeEnabled();
  await expect(page.getByText('Speaker status unavailable')).toHaveCount(0);
});

test('Sonos stale volume poll cannot overwrite a newer volume event', async ({ page }) => {
  const sonos = new SonosSimulator(page);
  await sonos.open();
  const volume = page.getByRole('slider', { name: 'Sonos group volume' });
  await expect(volume).toHaveValue('50');
  const gate = { arrived: deferred(), release: deferred() };
  sonos.delayedVolume = gate;
  await sonos.refresh();
  await gate.arrived.promise;
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('reitunes:sonos', { detail: {
    type: 'sonos', namespace: 'groupVolume', eventType: 'groupVolume', targetId: 'group-1',
    payload: { volume: 80, muted: false, fixed: false },
  } })));
  await expect(volume).toHaveValue('80');
  const response = page.waitForResponse('**/api/sonos/groups/group-1/volume');
  gate.release.resolve();
  await (await response).finished();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(volume).toHaveValue('80');
});

for (const fails of [false, true]) {
  test(`Sonos old queue ${fails ? 'failure' : 'success'} cannot change a newly selected output`, async ({ page }) => {
    const sonos = new SonosSimulator(page);
    await sonos.open();
    const gate = deferred();
    sonos.delayedQueue = gate;
    sonos.queueFails = fails;
    await page.getByRole('row').filter({ hasText: 'Northern Sky' }).click();
    await expect.poll(() => sonos.queueRequests.length).toBe(1);
    // Inject an output change while the request is outstanding. The normal
    // picker disables this path, but async completion must still be harmless.
    await page.evaluate(async () => {
      const modulePath = '/src/stores/playbackTargetStore.ts';
      const { usePlaybackTargetStore } = await import(modulePath);
      usePlaybackTargetStore.getState().setBrowserTarget();
    });
    const response = page.waitForResponse('**/api/sonos/play');
    gate.resolve();
    await (await response).finished();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const result = await page.evaluate(async () => {
      const modulePath = '/src/stores/playbackTargetStore.ts';
      const { usePlaybackTargetStore } = await import(modulePath);
      const { target, isSending, takeoverRequired, error } = usePlaybackTargetStore.getState();
      return { target, isSending, takeoverRequired, error, paused: document.querySelector('audio')?.paused };
    });
    expect(result).toEqual({ target: { kind: 'browser' }, isSending: false, takeoverRequired: false, error: null, paused: true });
  });
}
