import { expect } from '@playwright/test';
import { test, deferred, speakerState, SonosSimulator } from './fixtures/sonos';

test.use({ trace: 'retain-on-failure' });

test('Sonos two controllers settle on speaker state after conflicting commands and reordered replies', async ({ page, browser }) => {
  const shared = speakerState();
  const first = new SonosSimulator(page, shared, 'phone');
  await first.open();
  const secondContext = await browser.newContext({ baseURL: new URL(page.url()).origin });
  try {
    const otherPage = await secondContext.newPage();
    const second = new SonosSimulator(otherPage, shared, 'laptop');
    await second.open();
    await page.getByRole('button', { name: 'Pause Sonos', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Play Sonos', exact: true })).toBeEnabled();
    await second.emitPlayback();
    const gate = { arrived: deferred(), release: deferred() };
    second.delayedPoll = gate;
    await second.refresh();
    await gate.arrived.promise; // Captures paused, before the laptop requests play.
    await otherPage.getByRole('button', { name: 'Play Sonos', exact: true }).click();
    await expect(otherPage.getByRole('button', { name: 'Pause Sonos', exact: true })).toBeEnabled();
    const oldReply = otherPage.waitForResponse('**/api/sonos/groups/group-1/playback');
    gate.release.resolve();
    await (await oldReply).finished();
    await first.refresh(); // No event delivery: polling still converges.
    await expect(page.getByRole('button', { name: 'Pause Sonos', exact: true })).toBeEnabled();
    await expect(otherPage.getByRole('button', { name: 'Pause Sonos', exact: true })).toBeEnabled();
    expect(shared.transcript.filter(entry => entry.phase === 'applied').map(entry => [entry.controller, entry.operation]))
      .toEqual([['phone', 'pause'], ['laptop', 'play']]);
    expect(first.queueRequests).toHaveLength(0);
    expect(second.queueRequests).toHaveLength(0);
  } finally {
    await secondContext.close();
  }
});

test('Sonos polls completing in reverse order preserve the newer playback and allow later updates', async ({ page }) => {
  const sonos = new SonosSimulator(page);
  await sonos.open();
  const gate = { arrived: deferred(), release: deferred() };
  sonos.delayedPoll = gate;
  await sonos.refresh();
  await gate.arrived.promise;
  await page.getByRole('button', { name: 'Pause Sonos', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Play Sonos', exact: true })).toBeEnabled();
  const response = page.waitForResponse('**/api/sonos/groups/group-1/playback');
  gate.release.resolve();
  await (await response).finished();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(page.getByRole('button', { name: 'Play Sonos', exact: true })).toBeEnabled();
  sonos.paused = false;
  await sonos.refresh();
  await expect(page.getByRole('button', { name: 'Pause Sonos', exact: true })).toBeEnabled();
  expect(sonos.commands).toEqual(['pause']);
});

test('Sonos volume polls completing in reverse order preserve the confirmed new volume', async ({ page }) => {
  const sonos = new SonosSimulator(page);
  await sonos.open();
  const slider = page.getByRole('slider', { name: 'Sonos group volume' });
  await expect(slider).toHaveValue('50');
  const gate = { arrived: deferred(), release: deferred() };
  sonos.delayedVolume = gate;
  await sonos.refresh();
  await gate.arrived.promise;
  await slider.fill('70');
  await slider.dispatchEvent('pointerup');
  await expect.poll(() => sonos.commands).toEqual(['volume']);
  await expect(slider).toBeEnabled();
  const response = page.waitForResponse('**/api/sonos/groups/group-1/volume');
  gate.release.resolve();
  await (await response).finished();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(slider).toHaveValue('70');
  sonos.speaker.volume = 60;
  await sonos.refresh();
  await expect(slider).toHaveValue('60');
});

for (const fails of [false, true]) {
  test(`Sonos late queue ${fails ? 'failure' : 'success'} leaves another group's pending command alone`, async ({ page }) => {
    const sonos = new SonosSimulator(page);
    await sonos.open();
    await page.route('**/api/sonos/groups/group-2/playback', route => route.fulfill({ json: sonos.status() }));
    await page.route('**/api/sonos/groups/group-2/volume', route => route.fulfill({ json: { volume: 20, muted: false, fixed: false } }));
    const gate = deferred();
    sonos.delayedQueue = gate;
    sonos.queueFails = fails;
    await page.getByRole('row').filter({ hasText: 'Northern Sky' }).dblclick();
    await expect.poll(() => sonos.queueRequests.length).toBe(1);
    await page.evaluate(async () => {
      const modulePath = '/src/stores/playbackTargetStore.ts';
      const { usePlaybackTargetStore } = await import(modulePath);
      usePlaybackTargetStore.getState().setSonosTarget({ householdId: 'household', groupId: 'group-2', groupName: 'Office', playerNames: [] });
      usePlaybackTargetStore.getState().beginSending();
    });
    const response = page.waitForResponse('**/api/sonos/play');
    gate.resolve();
    await (await response).finished();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const state = await page.evaluate(async () => {
      const modulePath = '/src/stores/playbackTargetStore.ts';
      const { usePlaybackTargetStore } = await import(modulePath);
      const { target, isSending, error } = usePlaybackTargetStore.getState();
      return { groupId: target.groupId, isSending, error };
    });
    expect(state).toEqual({ groupId: 'group-2', isSending: true, error: null });
  });
}

for (const message of [
  'Sonos authorization expired. Open the output picker and reconnect to Sonos.',
  'This Sonos group is no longer available. Open the output picker and choose a current group.',
]) {
  test(`Sonos recovery message: ${message}`, async ({ page }) => {
    const sonos = new SonosSimulator(page);
    await sonos.open();
    let recovered = false;
    const requests: Array<{ allowTakeover: boolean }> = [];
    await page.route('**/api/sonos/play', route => {
      requests.push(route.request().postDataJSON());
      return route.fulfill(recovered ? { json: { groupId: 'group-1' } } : { status: 502, json: { error: message } });
    });
    await page.getByRole('row').filter({ hasText: 'Northern Sky' }).dblclick();
    await expect(page.getByText(message)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Replace Sonos playback and retry' })).toHaveCount(0);
    recovered = true;
    await page.getByRole('button', { name: 'Retry sending to Sonos', exact: true }).click();
    await expect(page.getByText(message)).toHaveCount(0);
    expect(requests.map(request => request.allowTakeover)).toEqual([true, false]);
  });
}
