import { describe, expect, it } from 'vitest';
import { ListeningClock } from './useLastFmListening';

describe('Last.fm listening time', () => {
  it('counts real playback through pauses and background updates, excluding stalls and seeks', () => {
    const clock = new ListeningClock();
    clock.sample(0, 0, true);
    clock.sample(10, 10_000, true);
    clock.sample(15, 15_000, false);
    clock.sample(15, 60_000, true);
    clock.sample(25, 70_000, true);
    expect(clock.seconds).toBe(25);
    clock.sample(25, 80_000, true); // stalled audio
    clock.sample(180, 80_100, false, true);
    clock.sample(180, 80_200, true);
    clock.sample(190, 90_200, true);
    expect(clock.seconds).toBe(35);
    clock.sample(250, 150_200, true); // Safari in the background
    expect(clock.seconds).toBe(95);
  });

  it('rejects a discontinuous position jump even without a seeking event', () => {
    const clock = new ListeningClock();
    clock.sample(0, 0, true);
    clock.sample(200, 1000, true);
    expect(clock.seconds).toBe(0);
    clock.sample(201, 2000, true);
    clock.sample(50, 3000, true);
    expect(clock.seconds).toBe(1);
  });
});
