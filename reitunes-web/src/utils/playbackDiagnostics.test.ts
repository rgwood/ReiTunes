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

function mediaHarness() {
  const ranges = (values: number[][]): TimeRanges => ({
    length: values.length, start: i => values[i][0], end: i => values[i][1],
  });
  return Object.assign(new EventTarget(), {
    currentTime: 70, paused: false, ended: false, seeking: true,
    readyState: 1, networkState: 2, error: null,
    buffered: ranges([[0, 30], [65, 80]]), seekable: ranges([[0, 300]]),
  }) as unknown as HTMLMediaElement;
}

it('reports buffered ranges without media URLs', async () => {
  const { audioDiagnostics } = await import('./playbackDiagnostics');
  expect(audioDiagnostics(mediaHarness())).toMatchObject({
    buffered: [[0, 30], [65, 80]], seekable: [[0, 300]], bufferedAhead: 10,
  });
});

it('records slow buffering at 3 and 10 seconds, then measures recovery', async () => {
  const { observePlaybackMedia, flushPlaybackDiagnostics } = await import('./playbackDiagnostics');
  const audio = mediaHarness();
  const dispose = observePlaybackMedia(audio, () => ({ itemId: 'track-id', target: 'browser' }));
  const entries = () => vi.mocked(fetch).mock.calls.flatMap(([, options]) =>
    JSON.parse(options!.body as string).args[0].events as Array<Record<string, unknown>>);
  audio.dispatchEvent(new Event('seeking'));
  audio.dispatchEvent(new Event('waiting'));
  // A queued playing event during seeking must not end the measurement.
  audio.dispatchEvent(new Event('playing'));
  await vi.advanceTimersByTimeAsync(12000);
  expect(entries().filter(e => e.event === 'buffering-slow')).toHaveLength(2);
  Object.assign(audio, { seeking: false, readyState: 4 });
  audio.dispatchEvent(new Event('playing'));
  flushPlaybackDiagnostics();
  expect(entries().find(e => e.event === 'buffering-end')).toMatchObject({
    itemId: 'track-id', outcome: 'playing', elapsedMs: 12000, bufferedAhead: 10,
  });
  await vi.advanceTimersByTimeAsync(30000);
  expect(entries().filter(e => e.event === 'buffering-slow')).toHaveLength(2);
  dispose();
});

it('cancels buffering timers after pause or observer removal', async () => {
  const { observePlaybackMedia, flushPlaybackDiagnostics } = await import('./playbackDiagnostics');
  const audio = mediaHarness();
  const dispose = observePlaybackMedia(audio, () => ({ itemId: 'track-id' }));
  audio.dispatchEvent(new Event('waiting'));
  Object.assign(audio, { paused: true });
  audio.dispatchEvent(new Event('pause'));
  await vi.advanceTimersByTimeAsync(12000);
  Object.assign(audio, { paused: false });
  audio.dispatchEvent(new Event('waiting'));
  dispose();
  await vi.advanceTimersByTimeAsync(12000);
  flushPlaybackDiagnostics();
  const entries = vi.mocked(fetch).mock.calls.flatMap(([, options]) => JSON.parse(options!.body as string).args[0].events);
  expect(entries.filter((e: { event: string }) => e.event === 'buffering-slow')).toHaveLength(0);
});

it('logs bounded browser error detail, redacts URLs, and marks media errors as warnings', async () => {
  const { audioDiagnostics, recordPlaybackEvent, flushPlaybackDiagnostics } = await import('./playbackDiagnostics');
  const audio = mediaHarness();
  const source = 'https://storage.example/private-song.m4a?token=secret';
  Object.assign(audio, {
    currentSrc: source, getAttribute: () => source,
    error: { code: 4, message: `DEMUXER_ERROR_COULD_NOT_OPEN: ${source}\nServer returned 503 from https://other.example/path?key=secret ${'x'.repeat(600)}` },
  });
  const details = audioDiagnostics(audio);
  expect(details.errorMessage).toContain('DEMUXER_ERROR_COULD_NOT_OPEN');
  expect(details.errorMessage).toContain('Server returned 503');
  expect(details.errorMessage).not.toMatch(/https|private-song|secret|\n/);
  expect(details.errorMessage).toHaveLength(512);
  recordPlaybackEvent('media', { mediaEvent: 'error', ...details });
  flushPlaybackDiagnostics();
  const payload = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
  expect(payload.level).toBe('warn');
  expect(payload.args[0].events[0].errorMessage).toBe(details.errorMessage);
});
