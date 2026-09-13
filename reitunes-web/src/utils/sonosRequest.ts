export class SonosRequestError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'SonosRequestError';
    this.status = status;
  }
}

// Include reading the response body in the deadline. A connection can stall
// after its headers arrive, too. Commands are never retried by the browser.
export async function sonosRequest<T = void>(
  url: string,
  options: Omit<RequestInit, 'signal'> = {},
  timeoutMillis = 35_000,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMillis);
  try {
    const response = await fetch(url, {
      ...options, credentials: 'include', signal: controller.signal,
    });
    const text = await response.text();
    let body: unknown;
    try { body = text ? JSON.parse(text) : undefined; } catch { /* Handle non-JSON errors below. */ }
    if (!response.ok) {
      const message = body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
        ? body.error : `Sonos request failed (${response.status}). Try again.`;
      throw new SonosRequestError(
        response.status === 401 ? 'Your ReiTunes session expired. Reload and sign in again.' : message,
        response.status,
      );
    }
    if (text && body === undefined) throw new SonosRequestError('ReiTunes returned an unexpected response. Reload and try again.');
    return body as T;
  } catch (error) {
    if (controller.signal.aborted) {
      throw new SonosRequestError('Sonos did not confirm the request. Check the speakers before retrying.');
    }
    if (error instanceof SonosRequestError) throw error;
    throw new SonosRequestError('Could not reach ReiTunes. Check your connection and try again.');
  } finally {
    clearTimeout(timer);
  }
}
