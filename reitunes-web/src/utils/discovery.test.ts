import { describe, expect, it } from 'vitest';
import type { DiscoveryEntry } from '../hooks/useDiscovery';
import { discoveryArtwork, discoveryEmbed, mixDiscoverySources } from './discovery';

const entry = (id: string, source = 'source', overrides: Partial<DiscoveryEntry> = {}): DiscoveryEntry => ({
  id, mediaId: id, title: id, url: `https://soundcloud.com/artist/${id}`, uploader: 'Artist', sources: [source],
  duration: 3600, published: null, discoveredAt: 100, inbox: true, status: 'new', libraryItemId: null, error: null, ...overrides,
});

describe('discovery previews', () => {
  it('uses provider players for YouTube and NTS-hosted SoundCloud recordings', () => {
    const video = entry('video', 'youtube', { url: 'https://www.youtube.com/watch?v=abcdefghijk' });
    expect(discoveryEmbed(video)?.url).toContain('https://www.youtube-nocookie.com/embed/abcdefghijk?');
    expect(discoveryArtwork(video)).toBe('https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg');
    const nts = entry('nts', 'nts', { url: 'https://www.nts.live/shows/show/episodes/set', downloadUrl: 'https://soundcloud.com/nts/recording' });
    expect(discoveryEmbed(nts)?.provider).toBe('SoundCloud');
    expect(new URL(discoveryEmbed(nts)!.url).searchParams.get('url')).toBe(nts.downloadUrl);
    expect(discoveryEmbed({ ...nts, downloadUrl: null })).toBeNull();
  });

  it('does not embed arbitrary hosts, credentials, or malformed video identities', () => {
    for (const url of ['javascript:alert(1)', 'https://soundcloud.com.example.org/artist/set', 'https://user@soundcloud.com/artist/set',
      'https://www.youtube.com/watch?v=bad/id', 'https://www.youtube.com/watch?v=short', 'https://soundcloud.com:8443/artist/set']) {
      expect(discoveryEmbed(entry('bad', 'source', { url }))).toBeNull();
    }
    expect(discoveryArtwork(entry('bad', 'source', { artworkUrl: 'http://example.com/art.jpg' }))).toBeNull();
  });
});

it('mixes each source’s newest releases without mutating or duplicating entries', () => {
  const entries = [entry('a-old', 'a', { published: '20200101' }), entry('a-new', 'a', { published: '20260101', sources: ['a', 'b'] }),
    entry('b-new', 'b', { published: '20260102' }), entry('c-unknown', 'c'), entry('a-unknown', 'a')];
  const input = entries.map(item => item.id);
  expect(mixDiscoverySources(entries).map(item => item.id)).toEqual(['b-new', 'a-new', 'c-unknown', 'a-old', 'a-unknown']);
  expect(entries.map(item => item.id)).toEqual(input);
  expect(mixDiscoverySources([])).toEqual([]);
});
