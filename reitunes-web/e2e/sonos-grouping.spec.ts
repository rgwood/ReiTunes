import { expect, test } from './fixtures/test';

const players = ['A', 'B', 'C'].map(id => ({ id, name: { A: 'Kitchen', B: 'Den', C: 'Porch' }[id], capabilities: [] }));
const split = {
  groups: [
    { id: 'A:1', name: 'Kitchen', coordinatorId: 'A', playerIds: ['A'], playbackState: 'PLAYBACK_STATE_IDLE' },
    { id: 'B:2', name: 'Den', coordinatorId: 'B', playerIds: ['B'], playbackState: 'PLAYBACK_STATE_IDLE' },
  ],
  // Porch is offline, so Sonos doesn't list it.
  players: players.slice(0, 2),
};
const regrouped = {
  groups: [{ id: 'A:1', name: 'Kitchen + 1', coordinatorId: 'A', playerIds: ['A', 'B'], playbackState: 'PLAYBACK_STATE_IDLE' }],
  players: players.slice(0, 2),
};

test.beforeEach(async ({ page }) => {
  await page.route('**/api/items', route => route.fulfill({ json: [] }));
  await page.route('**/api/playlists', route => route.fulfill({ json: [] }));
  await page.route('**/api/tags', route => route.fulfill({ json: { enabled: false, items: {} } }));
  await page.route('**/api/discovery', route => route.fulfill({ json: { sources: [], entries: [] } }));
  await page.route('**/api/log', route => route.fulfill({ status: 200 }));
  await page.routeWebSocket('**/updates', () => {});
  await page.route('**/api/sonos/status', route => route.fulfill({ json: { configured: true, connected: true } }));
  await page.route('**/api/sonos/households', route => route.fulfill({ json: { households: [{ id: 'home' }] } }));
});

test('a split preferred group is regrouped and chosen in one click', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  let household = split;
  const requests: string[] = [];
  await page.route('**/api/sonos/households/home/groups', route => route.fulfill({ json: household }));
  await page.route('**/api/sonos/preferred-group', route => route.fulfill({ json: {
    householdId: 'home', name: 'Whole house', playerIds: ['A', 'B', 'C'], playerNames: ['Kitchen', 'Den', 'Porch'],
  } }));
  await page.route('**/api/sonos/preferred-group/regroup', route => {
    requests.push(route.request().method());
    household = regrouped;
    return route.fulfill({ json: { group: regrouped.groups[0], missingPlayerIds: ['C'] } });
  });
  await page.goto('/');
  await page.getByTitle('Choose playback output').click();
  const output = page.getByRole('dialog', { name: 'Sonos', exact: true });
  const card = output.getByTestId('preferred-sonos-group');
  await expect(card).toContainText('Split across 2 groups · Porch offline');
  await page.screenshot({ path: testInfo.outputPath('preferred-group-split.png') });
  await card.getByRole('button', { name: 'Regroup and use' }).click();
  await expect(output).toBeHidden();
  expect(requests).toEqual(['POST']);
  const target = await page.evaluate(() => JSON.parse(localStorage.getItem('reitunes-playback-target')!).state.target);
  expect(target).toEqual({
    kind: 'sonos', householdId: 'home', groupId: 'A:1', groupName: 'Kitchen + 1',
    playerNames: ['Kitchen', 'Den'], playerIds: ['A', 'B'], preferredGroup: true,
  });
});

test('a group can be saved as the preferred group', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  let saved: unknown = null;
  await page.route('**/api/sonos/households/home/groups', route => route.fulfill({ json: regrouped }));
  await page.route('**/api/sonos/preferred-group', route => {
    if (route.request().method() === 'PUT') {
      saved = route.request().postDataJSON();
      return route.fulfill({ status: 204 });
    }
    return route.fulfill({ json: null });
  });
  await page.goto('/');
  await page.getByTitle('Choose playback output').click();
  const output = page.getByRole('dialog', { name: 'Sonos', exact: true });
  await output.getByRole('button', { name: 'Save as Whole house' }).click();
  await expect(output.getByTestId('preferred-sonos-group')).toContainText('2 of 2 speakers grouped');
  expect(saved).toEqual({ householdId: 'home', name: 'Whole house', playerIds: ['A', 'B'], playerNames: ['Kitchen', 'Den'] });
});
