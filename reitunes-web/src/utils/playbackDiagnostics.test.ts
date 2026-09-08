import { afterEach, beforeEach, expect, it, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('document', { visibilityState: 'visible' });
  vi.stubGlobal('navigator', { onLine: true });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('batches playback events with a stable session and ordered timestamps', async () => {
  const { recordPlaybackEvent } = await import('./playbackDiagnostics');
  recordPlaybackEvent('request', {
    itemId: 'track-id',
    origin: 'ctrl-e',
    position: 70,
  });
  recordPlaybackEvent('state', { itemId: 'track-id', isPlaying: true });
  expect(fetch).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(2000);
  expect(fetch).toHaveBeenCalledTimes(1);
  const [url, options] = vi.mocked(fetch).mock.calls[0];
  expect(url).toBe('/api/log');
  const payload = JSON.parse(options!.body as string);
  expect(payload.message).toBe('[Playback]');
  expect(payload.args[0].session).toMatch(/^[\da-f-]{36}$/);
  expect(
    payload.args[0].events.map((event: { sequence: number }) => event.sequence)
  ).toEqual([1, 2]);
  expect(payload.args[0].events[0]).toMatchObject({
    origin: 'ctrl-e',
    position: 70,
    itemId: 'track-id',
  });
  expect(options!.keepalive).toBe(true);
  await vi.advanceTimersByTimeAsync(20000);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('bounds a burst, reports dropped events and never retries failed requests', async () => {
  vi.mocked(fetch).mockRejectedValue(new Error('offline'));
  const { recordPlaybackEvent } = await import('./playbackDiagnostics');
  for (let i = 0; i < 100; i++)
    recordPlaybackEvent('media', { mediaEvent: 'waiting' });
  await vi.advanceTimersByTimeAsync(2000);
  const payload = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
  expect(payload.args[0].events).toHaveLength(40);
  expect(payload.args[0].droppedEvents).toBe(60);
  await vi.advanceTimersByTimeAsync(20000);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('flags oscillation once per cooldown and flushes pending evidence on pagehide', async () => {
  const { recordPlaybackEvent } = await import('./playbackDiagnostics');
  for (let i = 0; i < 16; i++)
    recordPlaybackEvent('state', { isPlaying: i % 2 === 0 });
  window.dispatchEvent(new Event('pagehide'));
  const payload = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
  expect(payload.level).toBe('warn');
  expect(
    payload.args[0].events.filter(
      (event: { event: string }) => event.event === 'oscillation'
    )
  ).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(10000);
  expect(fetch).toHaveBeenCalledTimes(1);
});
