import { test, expect } from '@playwright/test';
import type { Experiment } from '../src/tagging/review';

const experiment: Experiment = {
  schema_version: 1, id: 'fixture-v1', created_at: '2026-09-17', evidence_mode: 'metadata-only', sample_method: 'Test fixture',
  items: [
    { id: 'song-a', name: 'Original Mix', artist: 'Test artist', album: '', is_favorite: true, created_time_utc: '2026-09-17', play_count: 2 },
    { id: 'song-b', name: 'DJ Set', artist: 'Another artist', album: '', is_favorite: false, created_time_utc: '2026-09-16', play_count: 1 },
  ],
  runs: [{ id: 'run-a', model: 'test/model-a', prompt_version: 'v1', harness_version: 'v1', repeat: 1, latency_seconds: 1, cost_usd: 0.01,
    predictions: [{ id: 'song-a', uncertainty: 'Listen to confirm vocals', tags: [
      { tag: 'house', basis: 'inference', evidence: 'A genre guess', confidence: 0.8 },
      { tag: 'instrumental', basis: 'inference', evidence: 'An uncertain guess', confidence: 0.5 },
    ] }, { id: 'song-b', uncertainty: 'Unknown genre', tags: [] }] }],
};

test.beforeEach(async ({ page }) => {
  await page.route('**/tagging-experiment.json', route => route.fulfill({ json: experiment }));
});

test('review, correct, persist, export and safely merge human labels', async ({ page }) => {
  const mutations: string[] = [];
  page.on('request', request => { if (request.method() !== 'GET') mutations.push(request.url()); });
  await page.goto('/tagging.html');
  await expect(page.getByRole('heading', { name: 'Original Mix', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Accept house', exact: true }).click();
  await page.getByRole('button', { name: 'Reject instrumental', exact: true }).click();
  await page.getByRole('textbox', { name: 'Reason for instrumental', exact: true }).fill('There are vocals after the intro.\nConfirmed by listening.');
  await page.getByRole('textbox', { name: 'Reason for house', exact: true }).fill('Steady four-on-the-floor beat');
  await page.getByRole('button', { name: 'Uncertain house', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Reason for house', exact: true })).toHaveValue('Steady four-on-the-floor beat');
  await page.getByRole('button', { name: 'Accept house', exact: true }).click();
  await page.getByRole('textbox', { name: 'Add or correct tag' }).fill('Has Vocals');
  await page.getByRole('button', { name: 'Add tag', exact: true }).click();
  await page.getByRole('textbox', { name: 'Reason for has-vocals', exact: true }).fill('Singer enters halfway through');
  await page.getByRole('textbox', { name: 'Review notes' }).fill('Vocal arrives halfway through');
  await page.getByRole('checkbox', { name: 'Needs another listen' }).check();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Accept house', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'Reject instrumental', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('textbox', { name: 'Reason for instrumental', exact: true })).toHaveValue('There are vocals after the intro.\nConfirmed by listening.');
  await expect(page.getByRole('textbox', { name: 'Reason for house', exact: true })).toHaveValue('Steady four-on-the-floor beat');
  await expect(page.getByRole('textbox', { name: 'Review notes' })).toHaveValue('Vocal arrives halfway through');
  await expect(page.getByRole('checkbox', { name: 'Needs another listen' })).toBeChecked();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export review' }).click();
  const download = await downloadPromise;
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  const exported = JSON.parse(Buffer.concat(chunks).toString());
  expect(exported.human_review.items['song-a'].labels['has-vocals'].verdict).toBe('accepted');
  expect(exported.human_review.items['song-a'].labels['has-vocals'].reason).toBe('Singer enters halfway through');
  expect(exported.human_review.items['song-a'].labels.instrumental.reason).toBe('There are vocals after the intro.\nConfirmed by listening.');
  expect(exported.scores[0].precision).toBe(0.5);
  expect(exported.experiment.runs[0].id).toBe('run-a');
  exported.human_review.items['song-a'].labels.house.verdict = 'rejected';
  exported.human_review.items['song-a'].labels.house.reason = 'Old reason should not overwrite my edit';
  exported.human_review.items['song-a'].labels.dance = { ...exported.human_review.items['song-a'].labels.house, tag: 'dance', reason: 'Imported reason for a new tag' };
  await page.locator('input[type=file]').setInputFiles({ name: 'review.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(exported)) });
  await expect(page.getByRole('status')).toContainText('existing edits take precedence');
  await expect(page.getByRole('button', { name: 'Accept house', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('textbox', { name: 'Reason for house', exact: true })).toHaveValue('Steady four-on-the-floor beat');
  await expect(page.getByRole('textbox', { name: 'Reason for dance', exact: true })).toHaveValue('Imported reason for a new tag');
  await page.locator('input[type=file]').setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{"human_review":{}}') });
  await expect(page.getByRole('alert')).toContainText('Import rejected');
  await expect(page.getByRole('button', { name: 'Accept house', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect(mutations).toEqual([]);
});

test('uncertainty, keyboard navigation, filters and model reruns preserve labels', async ({ page }) => {
  await page.goto('/tagging.html');
  await page.getByRole('button', { name: 'Uncertain house', exact: true }).click();
  await page.getByRole('textbox', { name: 'Reason for house', exact: true }).fill('Need to hear more than the intro');
  await page.getByRole('textbox', { name: 'Reason for house', exact: true }).blur();
  await page.keyboard.press('j');
  await expect(page.getByRole('heading', { name: 'DJ Set', exact: true })).toBeVisible();
  await page.keyboard.press('k');
  await page.keyboard.press('a');
  await expect(page.getByRole('textbox', { name: 'Add or correct tag' })).toBeFocused();
  await page.getByRole('combobox', { name: 'Filter sample' }).selectOption('uncertain');
  await expect(page.locator('.item-list .item')).toHaveCount(1);
  await page.route('**/tagging-experiment.json', route => route.fulfill({ json: { ...experiment, id: 'fixture-v2', runs: [] } }));
  await page.reload();
  await expect(page.locator('.human-tag')).toContainText('house');
  await expect(page.getByRole('textbox', { name: 'Reason for house', exact: true })).toHaveValue('Need to hear more than the intro');
  await expect(page.getByText('Sample ready. Model runs are pending;')).toBeVisible();
});

test('existing labels without reasons remain editable and reasons can be cleared', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('reitunes-tagging-human-labels-v1', JSON.stringify({
    schema_version: 1, items: { 'song-a': { notes: 'Existing notes', uncertain: false, labels: {
      house: { tag: 'house', verdict: 'accepted', origin: 'human', updated_at: '2026-09-17T00:00:00Z' },
    } } },
  })));
  await page.goto('/tagging.html');
  const reason = page.getByRole('textbox', { name: 'Reason for house', exact: true });
  await expect(reason).toHaveValue('');
  await reason.fill('A new explanation');
  await reason.fill('');
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('reitunes-tagging-human-labels-v1')!));
  expect(saved.items['song-a'].labels.house).toMatchObject({ verdict: 'accepted', reason: '' });
  expect(saved.items['song-a'].notes).toBe('Existing notes');
});

test('corrupt saved data is not overwritten and storage failure is visible', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('reitunes-tagging-human-labels-v1', 'broken'));
  await page.goto('/tagging.html');
  await expect(page.getByRole('alert')).toContainText('could not be loaded');
  await page.getByRole('button', { name: 'Accept house', exact: true }).click();
  expect(await page.evaluate(() => localStorage.getItem('reitunes-tagging-human-labels-v1'))).toBe('broken');
  await expect(page.getByRole('status')).toContainText('this tab only');
});
