import { useState } from 'react';
import type { DiscoveryEntry } from '../hooks/useDiscovery';
import { discoveryArtwork } from '../utils/discovery';

export function DiscoveryArtwork({ entry, provider }: { entry: DiscoveryEntry; provider: string }) {
  const url = discoveryArtwork(entry);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  return url && failedUrl !== url
    ? <img src={url} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailedUrl(url)} />
    : <span className="discovery-artwork-fallback" aria-hidden="true">{provider === 'YouTube' ? '▶' : provider === 'SoundCloud' ? 'SC' : provider === 'NTS' ? 'NTS' : '♫'}</span>;
}
