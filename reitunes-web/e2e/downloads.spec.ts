import { expect, test, type Page } from '@playwright/test';
import type { DownloadJob } from '../src/hooks/useDownloads';

const initial: DownloadJob = { id: 1, url: 'https://soundcloud.com/dj/long-set', dl_type: 'Audio', stage: 'queued', download_percent: null, error: null };

async function backend(page: Page) {
  const state = { job: { ...initial }, posts: 0, reads: 0, unavailable: 0, libraryReads: 0 };
  await page.route('**/api/items', route => { state.libraryReads++; return route.fulfill({ json: [] }); });
  await page.route('**/api/playlists', route => route.fulfill({ json: [] }));
  await page.route('**/api/discovery', route => route.fulfill({ json: { sources: [], entries: [], refreshing: false } }));
  await page.route('**/api/sonos/status', route => route.fulfill({ json: { configured: false, connected: false } }));
  await page.route('**/api/log', route => route.fulfill({ status: 200 }));
  await page.routeWebSocket('**/updates', () => {});
  await page.route('**/api/download', route => {
    state.posts++;
    state.job = { ...initial, id: state.posts, ...route.request().postDataJSON() };
    return route.fulfill({ status: 202, json: state.job });
  });
  await page.route('**/api/downloads/*', route => {
    state.reads++;
    return state.unavailable ? route.fulfill({ status: state.unavailable, body: 'Status unavailable.' }) : route.fulfill({ json: state.job });
  });
  return state;
}

async function openImports(page: Page) {
  await page.getByRole('button', { name: 'Import music', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Import music', exact: true });
  await dialog.getByRole('tab', { name: 'Link', exact: true }).click();
  return dialog;
}

test('download progress follows every stage, survives reload and stops on completion', async ({ page }, testInfo) => {
  const state = await backend(page);
  await page.goto('/');
  let dialog = await openImports(page);
  await dialog.getByLabel('Music or video link').fill(initial.url);
  await dialog.getByRole('button', { name: 'Queue download', exact: true }).click();
  await expect(dialog.getByText('Queued', { exact: true })).toBeVisible();
  state.job.stage = 'downloading'; state.job.download_percent = 42.5;
  await expect(dialog.getByText('Downloading 43%', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('progressbar')).toHaveAttribute('value', '42.5');
  await dialog.getByRole('button', { name: 'Close import music' }).click();
  await page.reload();
  dialog = await openImports(page);
  await expect(dialog.getByText('Downloading 43%', { exact: true })).toBeVisible();
  expect(state.posts).toBe(1);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath('download-progress-mobile.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  for (const [stage, label] of [['processing', 'Converting…'], ['uploading', 'Uploading…'], ['importing', 'Adding to library…']] as const) {
    state.job.stage = stage; state.job.download_percent = null;
    await expect(dialog.getByText(label, { exact: true })).toBeVisible();
    await expect(dialog.getByRole('progressbar')).not.toHaveAttribute('value');
  }
  const before = state.libraryReads;
  state.job.stage = 'completed';
  await expect(dialog.getByText('Added to library', { exact: true })).toBeVisible();
  await expect.poll(() => state.libraryReads).toBeGreaterThan(before);
  await expect(dialog.getByRole('progressbar')).toHaveCount(0);
  const reads = state.reads;
  await page.clock.install();
  await page.clock.runFor(6_000);
  expect(state.reads).toBe(reads);
  await dialog.getByRole('button', { name: 'View recent imports', exact: true }).click();
  await expect(dialog).not.toBeVisible();
});

test('download status errors preserve the job and only explicit retry submits failed work', async ({ page }) => {
  const state = await backend(page);
  await page.goto('/');
  const dialog = await openImports(page);
  await dialog.getByLabel('Music or video link').fill(initial.url);
  await dialog.getByRole('button', { name: 'Queue download', exact: true }).click();
  await expect(dialog.getByText('Queued', { exact: true })).toBeVisible();
  state.unavailable = 502;
  await expect(dialog.getByRole('alert')).toContainText('Progress unavailable');
  expect(state.posts).toBe(1);
  await expect(dialog.getByRole('button', { name: 'Retry import' })).toHaveCount(0);
  state.unavailable = 0; state.job.stage = 'failed'; state.job.error = 'Worker restarted; check the library before retrying';
  await dialog.getByRole('button', { name: 'Check again' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Worker restarted');
  await expect(dialog.getByText('Import failed', { exact: true })).toBeVisible();
  expect(state.posts).toBe(1);
  await dialog.getByRole('button', { name: 'Retry import' }).click();
  await expect(dialog.getByText('Queued', { exact: true })).toBeVisible();
  expect(state.posts).toBe(2);
  await expect(dialog.getByText('Import failed', { exact: true })).toHaveCount(0);
});

test('download without a size stays indeterminate and completed video does not claim a library import', async ({ page }) => {
  const state = await backend(page);
  await page.goto('/');
  const dialog = await openImports(page);
  await dialog.getByLabel('Music or video link').fill(initial.url);
  await dialog.getByLabel('Video', { exact: true }).check();
  await dialog.getByRole('button', { name: 'Queue download', exact: true }).click();
  await expect(dialog.getByText('Queued', { exact: true })).toBeVisible();
  state.job.stage = 'downloading';
  await expect(dialog.getByText('Downloading…', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('progressbar')).not.toHaveAttribute('value');
  state.job.stage = 'completed';
  await expect(dialog.getByText('Download complete', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'View recent imports' })).toHaveCount(0);
});
