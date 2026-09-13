import { afterEach, expect, it, vi } from 'vitest';
import { sonosRequest, SonosRequestError } from './sonosRequest';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it.each(['headers', 'body'])('ends a request stalled while reading %s without retrying', async stage => {
  vi.useFakeTimers();
  const fetchMock = vi.fn((_url: string, options: RequestInit) => {
    const stalled = new Promise<never>((_resolve, reject) => {
      options.signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    });
    return stage === 'headers' ? stalled : Promise.resolve({ ok: true, text: () => stalled });
  });
  vi.stubGlobal('fetch', fetchMock);
  const result = expect(sonosRequest('/api/sonos/play', { method: 'POST' }, 1000))
    .rejects.toThrow('did not confirm');
  await vi.advanceTimersByTimeAsync(1000);
  await result;
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it('preserves explicit takeover conflicts but does not infer one from a network failure', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'Confirm takeover' }), { status: 409 })));
  await expect(sonosRequest('/api/sonos/play')).rejects.toMatchObject({ status: 409 });
  vi.mocked(fetch).mockRejectedValue(new TypeError('Failed to fetch'));
  await expect(sonosRequest('/api/sonos/play')).rejects.toMatchObject({ status: undefined });
});

it('handles an expired login and a proxy HTML error without showing HTML to the user', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>Sign in</html>', { status: 401 })));
  await expect(sonosRequest('/api/sonos/play')).rejects.toThrow('Reload and sign in');
  vi.mocked(fetch).mockResolvedValue(new Response('<html>Bad gateway</html>', { status: 502 }));
  await expect(sonosRequest('/api/sonos/play')).rejects.toThrow('Sonos request failed (502)');
});

it('accepts an empty command response and rejects a successful HTML login redirect', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
  await expect(sonosRequest('/api/sonos/pause')).resolves.toBeUndefined();
  vi.mocked(fetch).mockResolvedValue(new Response('<html>Sign in</html>'));
  await expect(sonosRequest('/api/sonos/play')).rejects.toBeInstanceOf(SonosRequestError);
});
