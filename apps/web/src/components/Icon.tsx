const PATHS = {
  copy: 'M5.5 5.5V3.25c0-.97.78-1.75 1.75-1.75h5.5c.97 0 1.75.78 1.75 1.75v5.5c0 .97-.78 1.75-1.75 1.75H10.5M3.25 5.5h5.5c.97 0 1.75.78 1.75 1.75v5.5c0 .97-.78 1.75-1.75 1.75h-5.5c-.97 0-1.75-.78-1.75-1.75v-5.5c0-.97.78-1.75 1.75-1.75Z',
  check: 'm3 8.5 3.25 3.25L13 5',
  chevron: 'm6 3.5 4.5 4.5L6 12.5',
  back: 'M10 3.5 5.5 8l4.5 4.5',
  plus: 'M8 3v10M3 8h10',
  user: 'M8 7.5a2.75 2.75 0 1 0 0-5.5 2.75 2.75 0 0 0 0 5.5ZM2.75 14c0-2.9 2.35-4.75 5.25-4.75s5.25 1.85 5.25 4.75',
  close: 'm4 4 8 8m0-8-8 8',
  edit: 'm9.5 3.5 3 3M2.5 13.5l.6-2.9 7.9-7.9a1.4 1.4 0 0 1 2 0l.3.3a1.4 1.4 0 0 1 0 2l-7.9 7.9-2.9.6Z',
  warning: 'M8 5.5v3.25M8 11h.01M6.86 2.5 1.6 11.6c-.5.87.12 1.9 1.13 1.9h10.54c1 0 1.63-1.03 1.13-1.9L9.14 2.5a1.3 1.3 0 0 0-2.28 0Z',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor"
      strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[name]} />
    </svg>
  );
}

export function GitHubMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82A7.65 7.65 0 0 1 8 3.86c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

/** Stacked sheets: one master, its copies offset behind it. */
export function BrandMark() {
  return (
    <svg className="brand-mark" width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
      <rect x="8" y="1.5" width="12" height="14" rx="1.5" fill="none" stroke="var(--ditto)" strokeWidth="1.5" />
      <rect x="5" y="4" width="12" height="14" rx="1.5" fill="var(--paper)" stroke="var(--ditto)" strokeWidth="1.5" />
      <rect x="2" y="6.5" width="12" height="14" rx="1.5" fill="var(--ink)" />
      <path d="M5 11.5h6M5 14.5h4" stroke="var(--paper)" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
