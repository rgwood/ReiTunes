const paths = {
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
