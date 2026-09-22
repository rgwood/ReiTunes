import type { DiscoveryEntry } from '../hooks/useDiscovery';

function mediaUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port ? url : null;
  } catch { return null; }
}

export function youtubeId(value: string) {
  const url = mediaUrl(value);
  if (!url) return null;
  const id = url.hostname === 'youtu.be' ? url.pathname.slice(1)
    : ['www.youtube.com', 'youtube.com', 'm.youtube.com'].includes(url.hostname) ? url.searchParams.get('v') : null;
  return id && /^[\w-]{11}$/.test(id) ? id : null;
}

export function discoveryEmbed(entry: DiscoveryEntry): { provider: string; url: string } | null {
  const id = youtubeId(entry.url);
  if (id) return { provider: 'YouTube', url: `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&playsinline=1&rel=0` };
  for (const value of [entry.downloadUrl, entry.url]) {
    const url = value && mediaUrl(value);
    if (url && ['soundcloud.com', 'www.soundcloud.com'].includes(url.hostname) && /^\/[^/]+\/[^/]+\/?$/.test(url.pathname)) {
      return { provider: 'SoundCloud', url: `https://w.soundcloud.com/player/?url=${encodeURIComponent(url.href)}&auto_play=true&show_artwork=true&visual=false` };
    }
  }
  return null;
}

export function discoveryArtwork(entry: DiscoveryEntry) {
  if (entry.artworkUrl && mediaUrl(entry.artworkUrl)) return entry.artworkUrl;
  const id = youtubeId(entry.url);
  return id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : null;
}

const newest = (a: DiscoveryEntry, b: DiscoveryEntry) => (b.published ?? '').localeCompare(a.published ?? '')
  || b.discoveredAt - a.discoveredAt || a.title.localeCompare(b.title) || a.id.localeCompare(b.id);

/** Round-robin each source's newest sets without changing order on routine polling. */
export function mixDiscoverySources(entries: DiscoveryEntry[]) {
  const groups = new Map<string, DiscoveryEntry[]>();
  for (const entry of [...entries].sort(newest)) {
    const key = [...entry.sources].sort()[0] ?? entry.uploader;
    const group = groups.get(key) ?? [];
    group.push(entry); groups.set(key, group);
  }
  const queues = [...groups.values()].sort((a, b) => newest(a[0], b[0]));
  const result: DiscoveryEntry[] = [];
  for (let index = 0; result.length < entries.length; index++) {
    for (const group of queues) if (group[index]) result.push(group[index]);
  }
  return result;
}
