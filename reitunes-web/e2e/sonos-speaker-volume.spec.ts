import { expect } from './fixtures/test';
import { test, SonosSimulator } from './fixtures/sonos';
import type { Page } from '@playwright/test';

// A two-speaker group plus a speaker with fixed (line-out) volume. Sonos
// reports group volume as the average of the adjustable speakers, and spreads
// a group change across all of them.
async function openGroup(page: Page) {
  const speakers: Record<string, { volume: number; muted: boolean; fixed: boolean }> = {
    kitchen: { volume: 60, muted: false, fixed: false },
    den: { volume: 40, muted: false, fixed: false },
    patio: { volume: 100, muted: false, fixed: true },
  };
  const commands: string[] = [];
  const adjustable = () => Object.values(speakers).filter(speaker => !speaker.fixed);
  const groupVolume = () => Math.round(adjustable().reduce((sum, speaker) => sum + speaker.volume, 0) / adjustable().length);

  const sonos = new SonosSimulator(page);
  await sonos.install();
  await page.addInitScript(() => {
    localStorage.setItem('reitunes-playback-target', JSON.stringify({ version: 1, state: {
      target: { kind: 'sonos', householdId: 'household', groupId: 'group-1', groupName: 'Downstairs',
        playerIds: ['kitchen', 'den', 'patio'], playerNames: ['Kitchen', 'Den', 'Patio'] },
      takeoverRequired: true,
    } }));
  });
  await page.route('**/api/sonos/groups/group-1/volume', async route => {
    if (route.request().method() === 'POST') {
      const delta = route.request().postDataJSON().volume - groupVolume();
      adjustable().forEach(speaker => { speaker.volume = Math.min(100, Math.max(0, speaker.volume + delta)); });
      commands.push(`group volume ${route.request().postDataJSON().volume}`);
      return route.fulfill({ status: 204 });
    }
    return route.fulfill({ json: { volume: groupVolume(), muted: false, fixed: false } });
  });
  await page.route('**/api/sonos/players/*/volume', async route => {
    const id = new URL(route.request().url()).pathname.split('/')[4];
    if (route.request().method() === 'POST') {
      speakers[id].volume = route.request().postDataJSON().volume;
      commands.push(`${id} volume ${speakers[id].volume}`);
      return route.fulfill({ status: 204 });
    }
    return route.fulfill({ json: speakers[id] });
  });
  await page.route('**/api/sonos/players/*/mute', async route => {
    const id = new URL(route.request().url()).pathname.split('/')[4];
    speakers[id].muted = route.request().postDataJSON().muted;
    commands.push(`${id} muted ${speakers[id].muted}`);
    return route.fulfill({ status: 204 });
  });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Pause Sonos', exact: true })).toBeEnabled();
  return { speakers, commands };
}

test('a single Sonos speaker has no separate speaker volumes', async ({ page }) => {
  await new SonosSimulator(page).open();
  await expect(page.getByRole('slider', { name: 'Sonos group volume' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Speaker volumes' })).toHaveCount(0);
});

test('speaker volumes adjust one speaker and follow group changes', async ({ page }) => {
  const { speakers, commands } = await openGroup(page);
  await page.getByRole('button', { name: 'Speaker volumes' }).click();
  const popover = page.getByRole('dialog', { name: 'Downstairs speakers' });
  const kitchen = popover.getByRole('slider', { name: 'Kitchen volume' });
  const den = popover.getByRole('slider', { name: 'Den volume' });
  await expect(kitchen).toHaveValue('60');
  await expect(den).toHaveValue('40');
  await expect(popover.getByText('Fixed volume')).toBeVisible();
  await expect(popover.getByRole('slider', { name: 'Patio volume' })).toHaveCount(0);
  await expect(popover.getByRole('button', { name: 'Mute Patio' })).toBeDisabled();

  // Moving one speaker also moves the group's average.
  await kitchen.focus();
  await page.keyboard.press('ArrowRight');
  await expect(kitchen).toHaveValue('61');
  await expect(page.getByRole('slider', { name: 'Sonos group volume' })).toHaveValue('51');
  expect(commands).toEqual(['kitchen volume 61']);

  // A group change rescales every speaker, so the open list rereads them.
  await page.getByRole('button', { name: 'Volume up' }).click();
  await expect(page.getByRole('slider', { name: 'Sonos group volume' })).toHaveValue('52');
  await expect(kitchen).toHaveValue('62');
  await expect(den).toHaveValue('41');

  await popover.getByRole('button', { name: 'Mute Den' }).click();
  await expect(popover.getByRole('button', { name: 'Unmute Den' })).toBeEnabled();
  expect(speakers.den.muted).toBe(true);

  await page.keyboard.press('Escape');
  await expect(popover).toHaveCount(0);
});

test('speaker volume failures stay with that speaker', async ({ page }) => {
  await openGroup(page);
  await page.route('**/api/sonos/players/den/volume', route => route.request().method() === 'POST'
    ? route.fulfill({ status: 502, json: { error: 'Den did not respond' } }) : route.fallback());
  await page.getByRole('button', { name: 'Speaker volumes' }).click();
  const popover = page.getByRole('dialog', { name: 'Downstairs speakers' });
  const den = popover.getByRole('slider', { name: 'Den volume' });
  await expect(den).toHaveValue('40');
  await den.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(popover.getByRole('alert')).toHaveText('Den did not respond');
  await expect(den).toHaveValue('40');
  await expect(popover.getByRole('slider', { name: 'Kitchen volume' })).toBeEnabled();
});

test('the phone player tucks speaker volumes under the group volume', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { commands } = await openGroup(page);
  await expect(page.getByRole('heading', { name: 'Now playing' })).toBeVisible();
  await expect(page.getByRole('slider', { name: 'Kitchen volume' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Adjust speakers' }).click();
  const kitchen = page.getByRole('slider', { name: 'Kitchen volume' });
  await expect(kitchen).toHaveValue('60');
  await kitchen.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(kitchen).toHaveValue('59');
  expect(commands).toEqual(['kitchen volume 59']);
});
