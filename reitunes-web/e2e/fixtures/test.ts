import { test as base, type BrowserContext } from '@playwright/test';

export * from '@playwright/test';

// The production session API has its own Rust tests. Keep browser tests at the
// API boundary, with an actual shared revision rather than localStorage seeds.
export class SharedSessionSimulator {
  snapshot: { revision: number; state: unknown } = { revision: 0, state: null };
  requests: Array<{ method: string; body?: Record<string, unknown> }> = [];
  private operations = new Map<string, typeof this.snapshot>();
  private contexts = new Set<BrowserContext>();

  async install(context: BrowserContext) {
    this.contexts.add(context);
    await context.route('**/api/playback-session', async route => {
      const request = route.request();
      if (request.method() === 'GET') {
        this.requests.push({ method: 'GET' });
        return route.fulfill({ json: this.snapshot });
      }
      const body = request.postDataJSON();
      this.requests.push({ method: request.method(), body });
      const previous = this.operations.get(body.operationId);
      if (previous) return route.fulfill({ json: previous });
      if (body.expectedRevision !== this.snapshot.revision) {
        return route.fulfill({ status: 409, json: this.snapshot });
      }
      this.snapshot = { revision: this.snapshot.revision + 1, state: body.state };
      this.operations.set(body.operationId, this.snapshot);
      await route.fulfill({ json: this.snapshot });
      await Promise.allSettled([...this.contexts].flatMap(context => context.pages()).map(page => page.evaluate(snapshot => {
        window.dispatchEvent(new CustomEvent('reitunes:playback-session', { detail: snapshot }));
      }, this.snapshot)));
    });
  }
}

export const test = base.extend<{ sharedSession: SharedSessionSimulator }>({
  sharedSession: [async ({ context }, use) => {
    const session = new SharedSessionSimulator();
    await session.install(context);
    await use(session);
  }, { auto: true }],
});
