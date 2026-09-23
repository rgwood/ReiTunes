import { describe, it, expect } from 'vitest';
import { parseTracklist, tracklistError } from './tracklists';

describe('tracklist edits', () => {
  it('parses pasted timestamps without guessing missing times', () => {
    expect(parseTracklist('0:00 Locked\n8:30.25 — Lion\n1:02:03 Finale')[1]).toEqual({ title: 'Lion', start: 510.25, end: null });
    expect(() => parseTracklist('Locked\nLion')).toThrow();
    expect(() => parseTracklist('0:00 One\n8:99 Two')).toThrow();
    expect(() => parseTracklist('0:00 One\n0:00 Two')).toThrow();
  });
  it('rejects overlap, invalid times and timings outside the actual file', () => {
    const tracks = [{ title: 'One', start: 0, end: 10 }, { title: 'Two', start: 10, end: 20 }];
    expect(tracklistError(tracks, 20)).toBeNull();
    expect(tracklistError(tracks, 19)).toMatch(/past/);
    expect(tracklistError([{ ...tracks[0], start: NaN }], null)).toMatch(/valid start/);
    expect(tracklistError([{ ...tracks[0], end: 11 }, tracks[1]], null)).toMatch(/overlaps/);
    expect(tracklistError([{ ...tracks[0], start: -1 }], null)).toMatch(/valid start/);
  });
});
