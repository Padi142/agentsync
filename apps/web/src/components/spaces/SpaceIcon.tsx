/** Icons only Spaces use, drawn like `Icon`'s: 16px grid, 1.5px rounded strokes. */
const PATHS = {
  download: 'M8 2.5v7.75M4.75 7 8 10.25 11.25 7M2.75 12v1.25c0 .41.34.75.75.75h9c.41 0 .75-.34.75-.75V12',
  external: 'M9.5 2.5h4v4M13.5 2.5 7.75 8.25M12 9.5v3.75c0 .41-.34.75-.75.75h-8.5a.75.75 0 0 1-.75-.75v-8.5c0-.41.34-.75.75-.75H6.5',
  sidebar: 'M3.25 2.75h9.5c.41 0 .75.34.75.75v9c0 .41-.34.75-.75.75h-9.5a.75.75 0 0 1-.75-.75v-9c0-.41.34-.75.75-.75ZM6.5 2.75v10.5',
  folder: 'M2 4.5c0-.55.45-1 1-1h3l1.5 1.5H13c.55 0 1 .45 1 1v6c0 .55-.45 1-1 1H3c-.55 0-1-.45-1-1v-7.5Z',
  file: 'M4.5 1.75h4.25l3.5 3.5v8.25c0 .41-.34.75-.75.75h-7a.75.75 0 0 1-.75-.75v-11c0-.41.34-.75.75-.75ZM8.5 1.75v3.75h3.75',
  trash: 'M2.75 4.25h10.5M6.25 4.25v-1.5h3.5v1.5M4.25 4.25l.6 8.6c.03.38.35.65.73.65h4.84c.38 0 .7-.27.73-.65l.6-8.6',
  more: 'M3.5 8h.01M8 8h.01M12.5 8h.01',
} as const;

export function SpaceIcon({ name, size = 16 }: { name: keyof typeof PATHS; size?: number }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor"
      strokeWidth={name === 'more' ? 2.4 : 1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[name]} />
    </svg>
  );
}
