import { describe, expect, it } from 'vitest';
import type { LibraryItem } from '../types';
import { totalDurationLabel } from './duration';

const track = (duration_seconds: number | null) => ({ duration_seconds } as LibraryItem);

describe('totalDurationLabel', () => {
  it('returns null when no durations are known', () => {
    expect(totalDurationLabel([])).toBeNull();
    expect(totalDurationLabel([track(null)])).toBeNull();
  });
  it('formats minutes, hours and exact hours', () => {
    expect(totalDurationLabel([track(30)])).toBe('1 min');
    expect(totalDurationLabel([track(2700), track(1500)])).toBe('1 hr 10 min');
    expect(totalDurationLabel([track(3600), track(3600)])).toBe('2 hr');
  });
});
