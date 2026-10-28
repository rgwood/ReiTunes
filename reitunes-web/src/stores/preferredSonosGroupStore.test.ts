import { describe, expect, it } from 'vitest';
import { isPreferredGroup, missingPreferredSpeakers, type PreferredSonosGroup } from './preferredSonosGroupStore';
import type { SonosPlaybackTarget } from './playbackTargetStore';

const preferred: PreferredSonosGroup = {
  householdId: 'home', name: 'Whole house',
  playerIds: ['A', 'B', 'C'], playerNames: ['Kitchen', 'Den', 'Porch'],
};

function target(overrides: Partial<SonosPlaybackTarget> = {}): SonosPlaybackTarget {
  return {
    kind: 'sonos', householdId: 'home', groupId: 'A:1', groupName: 'Kitchen + 1',
    playerNames: ['Kitchen', 'Den'], playerIds: ['A', 'B'], preferredGroup: true, ...overrides,
  };
}

describe('preferred Sonos group', () => {
  it('names speakers that drifted out of the preferred group', () => {
    expect(missingPreferredSpeakers(target(), preferred)).toEqual(['Porch']);
    expect(missingPreferredSpeakers(target({ playerIds: ['A', 'B', 'C'] }), preferred)).toEqual([]);
  });

  it('stays quiet for groups chosen on their own or saved before membership was tracked', () => {
    expect(missingPreferredSpeakers(target({ preferredGroup: undefined }), preferred)).toEqual([]);
    expect(missingPreferredSpeakers(target({ playerIds: undefined }), preferred)).toEqual([]);
    expect(missingPreferredSpeakers(target({ householdId: 'cabin' }), preferred)).toEqual([]);
    expect(missingPreferredSpeakers({ kind: 'browser' }, preferred)).toEqual([]);
  });

  it('treats any group holding every preferred speaker as the preferred group', () => {
    expect(isPreferredGroup('home', ['C', 'B', 'A', 'Z'], preferred)).toBe(true);
    expect(isPreferredGroup('home', ['A', 'B'], preferred)).toBe(false);
    expect(isPreferredGroup('home', ['A', 'B', 'C'], null)).toBe(false);
  });
});
