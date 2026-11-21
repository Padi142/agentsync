import type { PublicSpace } from '@agentsync/contract';
import { describe, expect, it } from 'vitest';
import { spaceDigest } from '../src/spaces/digest';
import { spacesRoute } from '../src/spaces/routing';

const token = 'AbCdEfGhIjKlMnOpQrStUvWxYz012345';
const at = new Date('2026-11-20T10:00:00Z');
const file = (path: string, size: number, contentType: string) =>
  ({ path, size, contentType, sha256: '0'.repeat(64), updatedAt: at });

function space(files: PublicSpace['files'], contents: Record<string, string>) {
  const value: PublicSpace = {
    id: 'space-1', title: 'Launch report', summary: 'What shipped\nand what is next', status: 'active',
    expiresAt: new Date('2026-11-27T10:00:00Z'), shareUrl: `https://agentsync.test/s/${token}`,
    totalBytes: files.reduce((sum, f) => sum + f.size, 0), files, createdAt: at, updatedAt: at,
  };
  return spaceDigest(value, async (path) => contents[path] ?? null);
}

describe('spaceDigest', () => {
  it('outlines a small multi-file Space and inlines its text', async () => {
    const contents = {
      'README.md': '---\ntitle: Launch\ntags: [a, b]\n---\n# Launch\n\n```sh\n# not a heading\n```\n## Next steps\n',
      'site/index.html': '<html><head><title>Report &amp; notes</title><style>h1{}</style></head><body><h1>Hi <b>there</b></h1><h2>Data</h2></body></html>',
    };
    expect(await space([
      file('site/index.html', 120, 'text/html; charset=utf-8'),
      file('README.md', 80, 'text/markdown; charset=utf-8'),
    ], contents)).toBe(`# Launch report

> What shipped
> and what is next

- Status: active until 2026-11-27 10:00 UTC
- Files: 2 (200 B)
- Updated: 2026-11-20 10:00 UTC
- Share Link: https://agentsync.test/s/${token}
- JSON: https://agentsync.test/s/${token}.json
- Download all: https://agentsync.test/s/${token}/download.zip

## Files

- [\`README.md\`](https://agentsync.test/s/${token}/raw/README.md) — 80 B, text/markdown
  - title: Launch
  - tags: [a, b]
  - # Launch
  - ## Next steps
- \`site/\`
  - [\`index.html\`](https://agentsync.test/s/${token}/raw/site/index.html) — 120 B, text/html
    - title: Report & notes
    - # Hi there
    - ## Data

## Contents

### README.md

\`\`\`\`markdown
${contents['README.md'].trimEnd()}
\`\`\`\`

### site/index.html

\`\`\`html
${contents['site/index.html']}
\`\`\`
`);
  });

  it('lists but does not inline a Space with binary files', async () => {
    const digest = await space([file('chart.png', 2048, 'image/png'), file('notes.txt', 10, 'text/plain')], { 'notes.txt': 'secret-ish' });
    expect(digest).toContain(`- [\`chart.png\`](https://agentsync.test/s/${token}/raw/chart.png) — 2.0 KB, image/png`);
    expect(digest).not.toContain('## Contents');
    expect(digest).not.toContain('secret-ish');
  });
});

describe('spacesRoute', () => {
  const html = 'text/html,application/xhtml+xml,*/*;q=0.8';
  it.each([
    [`/s/${token}`, html, 'app'],
    [`/s/${token}`, 'text/markdown', 'api'],
    [`/s/${token}`, 'application/json', 'api'],
    [`/s/${token}`, '*/*', 'api'],
    [`/s/${token}`, null, 'api'],
    [`/s/${token}.md`, html, 'api'],
    [`/s/${token}.json`, html, 'api'],
    [`/s/${token}/raw/index.html`, html, 'api'],
    [`/s/${token}/download.zip`, html, 'api'],
    [`/s/${token}/ws`, null, 'api'],
    ['/api/spaces/abc/files/a.txt', null, 'api'],
    ['/spaces', html, null],
    ['/skills', null, null],
  ] as const)('%s with Accept %s goes to %s', (path, accept, expected) => {
    expect(spacesRoute(path, accept)).toBe(expected);
  });
});
