const paths = {
  music: 'M9 18V5l12-2v13M9 8l12-2M9 18a3 3 0 1 1-3-3c1.7 0 3 1.3 3 3ZM21 16a3 3 0 1 1-3-3c1.7 0 3 1.3 3 3Z',
  clock: 'M12 8v4l3 2M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z',
  play: 'm10 8 6 4-6 4V8ZM22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z',
  heart: 'M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z',
  bookmark: 'M6 3h12v18l-6-4-6 4V3Z',
  tag: 'M3 3h8l10 10-8 8L3 11V3ZM7 7h.01',
  discover: 'm16 8-3 5-5 3 3-5 5-3ZM22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z',
  playlist: 'M3 5h12M3 10h12M3 15h7M17 19V9l4 1M17 19a3 3 0 1 1-3-3c1.7 0 3 1.3 3 3Z',
  queue: 'M3 5h18M3 10h18M3 15h8M3 20h8M16 14l5 4-5 4v-8Z',
  smart: 'M3 5h18M6 10h12M9 15h6M12 20h0',
  search: 'M21 21l-5-5M18 10.5a7.5 7.5 0 1 1-15 0 7.5 7.5 0 0 1 15 0Z',
  plus: 'M12 5v14M5 12h14',
  close: 'M6 6l12 12M18 6 6 18',
  settings:
    'M9.5 3h5l.5 2.5 2 .9 2.2-1.3 2.5 4.3-2.1 1.5v2.2l2.1 1.5-2.5 4.3-2.2-1.3-2 .9-.5 2.5h-5L9 18.5l-2-.9-2.2 1.3-2.5-4.3 2.1-1.5v-2.2L2.3 9.4l2.5-4.3L7 6.4l2-.9.5-2.5ZM15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z',
  speaker:
    'M4 4h16v16H4zM14 8a2 2 0 1 1-4 0 2 2 0 0 1 4 0ZM15 15a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z',
};

export function MusicIcon({
  name,
  size = 18,
}: {
  name: keyof typeof paths;
  size?: number;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}
