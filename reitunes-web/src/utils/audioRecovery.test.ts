import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createAudioRecovery } from './audioRecovery';

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

function harness() {
  const audio = Object.assign(new EventTarget(), {
    currentTime: 100, paused: false, seeking: true, readyState: 1,
  }) as unknown as HTMLMediaElement;
  const intent = { playing: true, current: true, position: 100 };
  const reload = vi.fn();
  const onStatus = vi.fn();
  const controller = createAudioRecovery(audio, {
    canAct: () => intent.current, shouldPlay: () => intent.playing,
    position: () => intent.position, reload, onStatus,
  });
  return { audio, intent, reload, onStatus, controller };
}

it('retries a prolonged stall once at the latest requested position', () => {
  const h = harness();
  h.audio.dispatchEvent(new Event('waiting'));
  vi.advanceTimersByTime(2000);
  expect(h.onStatus).toHaveBeenLastCalledWith('buffering');
  h.intent.position = 240;
  vi.advanceTimersByTime(6000);
  expect(h.reload).toHaveBeenCalledExactlyOnceWith(240);
  expect(h.onStatus).toHaveBeenLastCalledWith('retrying');
  h.audio.dispatchEvent(new Event('waiting'));
  vi.advanceTimersByTime(60000);
  expect(h.reload).toHaveBeenCalledTimes(1);
  expect(h.onStatus).toHaveBeenLastCalledWith('failed');
  h.intent.position = 250;
  h.controller.retry();
  expect(h.reload).toHaveBeenLastCalledWith(250);
  expect(h.reload).toHaveBeenCalledTimes(2);
  h.controller.dispose();
});

it('does not reload normal seeks, or mistake a queued playing event for recovery', () => {
  const h = harness();
  h.audio.dispatchEvent(new Event('seeking'));
  h.audio.dispatchEvent(new Event('playing'));
  vi.advanceTimersByTime(1000);
  Object.assign(h.audio, { seeking: false, readyState: 4, currentTime: 101 });
  h.audio.dispatchEvent(new Event('timeupdate'));
  vi.advanceTimersByTime(10000);
  expect(h.reload).not.toHaveBeenCalled();
  expect(h.onStatus).toHaveBeenLastCalledWith('idle');
  h.controller.dispose();
});

it('cancels automatic recovery when paused or the output/track changes', () => {
  for (const change of ['pause', 'target', 'dispose']) {
    const h = harness();
    h.audio.dispatchEvent(new Event('waiting'));
    vi.advanceTimersByTime(3000);
    if (change === 'pause') {
      h.intent.playing = false;
      Object.assign(h.audio, { paused: true });
      h.audio.dispatchEvent(new Event('pause'));
    } else if (change === 'target') h.intent.current = false;
    else h.controller.dispose();
    vi.advanceTimersByTime(20000);
    expect(h.reload).not.toHaveBeenCalled();
    h.controller.dispose();
  }
});

it('does not replenish automatic retries after briefly reporting playback', () => {
  const h = harness();
  h.audio.dispatchEvent(new Event('waiting'));
  vi.advanceTimersByTime(8000);
  Object.assign(h.audio, { readyState: 4, seeking: false });
  h.audio.dispatchEvent(new Event('playing'));
  Object.assign(h.audio, { readyState: 1, seeking: true });
  h.audio.dispatchEvent(new Event('waiting'));
  vi.advanceTimersByTime(60000);
  expect(h.reload).toHaveBeenCalledTimes(1);
  expect(h.onStatus).toHaveBeenLastCalledWith('failed');
  h.controller.dispose();
});
