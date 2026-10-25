import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { setup } from './harness.js';

/** A Machine whose `edit --file` lost to another edit, leaving one open Conflict. */
async function withConflict() {
  const t = setup();
  t.registered();
  t.server.putTemplate('one\n');
  t.server.putTemplate('one\ntheirs\n');
  t.write('draft.md', 'one\nmine\n');
  await t.cli('edit', '--file', t.path('draft.md'), '--base', '1');
  return { t, conflict: t.server.state.conflicts[0]! };
}

describe('conflict', () => {
  it('lists open Conflicts', async () => {
    const { t, conflict } = await withConflict();

    const result = await t.cli('conflict', 'list', '--json');

    expect(result.json()).toMatchObject({ ok: true, conflicts: [{ id: conflict.id, url: conflict.url }] });
  });

  it('downloads the marked text', async () => {
    const { t, conflict } = await withConflict();

    const result = await t.cli('conflict', 'get', conflict.id, '--out', '~/conflict.md');

    expect(result.code).toBe(0);
    expect(readFileSync(t.path('conflict.md'), 'utf8')).toBe(conflict.text);
  });

  it('resolves it from a fixed file as the next Template revision', async () => {
    const { t, conflict } = await withConflict();
    t.write('fixed.md', 'one\ntheirs\nmine\n');

    const result = await t.cli('conflict', 'resolve', conflict.id, t.path('fixed.md'), '--json');

    expect(result.code).toBe(0);
    expect(result.json()).toMatchObject({ ok: true, revision: 3 });
    expect(t.server.state.template.text).toBe('one\ntheirs\nmine\n');
  });

  it('refuses a file that still has Conflict markers, before uploading', async () => {
    const { t, conflict } = await withConflict();
    t.write('fixed.md', conflict.text);

    const result = await t.cli('conflict', 'resolve', conflict.id, t.path('fixed.md'));

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('markers');
    expect(t.server.state.conflicts[0]!.status).toBe('open');
  });

  it('warns about a lone ======= line but still resolves', async () => {
    const { t, conflict } = await withConflict();
    t.write('fixed.md', 'Title\n=======\none\ntheirs\nmine\n');

    const result = await t.cli('conflict', 'resolve', conflict.id, t.path('fixed.md'));

    expect(result.code).toBe(0);
    expect(result.stderr).toContain('line 2');
    expect(t.server.state.conflicts[0]!.status).toBe('resolved');
  });

  it('exits 4 when the Template moved on after the Conflict was created', async () => {
    const { t, conflict } = await withConflict();
    t.server.putTemplate('one\ntheirs\nlater\n');
    t.write('fixed.md', 'one\ntheirs\nmine\n');

    const result = await t.cli('conflict', 'resolve', conflict.id, t.path('fixed.md'), '--json');

    expect(result.code).toBe(4);
    expect(result.json()).toMatchObject({ ok: false, error: { currentRevision: 3 } });

    const retried = await t.cli('conflict', 'resolve', conflict.id, t.path('fixed.md'), '--base', '3');
    expect(retried.code).toBe(0);
  });

  it('reports where the server found a problem when it rejects a resolution', async () => {
    const { t, conflict } = await withConflict();
    t.write('fixed.md', 'one\n');
    // A resolution the server rejects although the CLI's own checks pass, e.g. from a newer grammar.
    const fetch = t.server.fetch;
    t.server.fetch = async (input, init) => {
      const request = new Request(input, init);
      if (!request.url.endsWith('/conflicts/resolve')) return fetch(request);
      return Response.json(
        { json: { defined: true, code: 'INVALID_TEMPLATE', status: 422, message: 'The Template does not parse.', data: { issues: [{ message: 'Unknown tag', line: 4, column: 2 }] } } },
        { status: 422 },
      );
    };

    const result = await t.cli('conflict', 'resolve', conflict.id, t.path('fixed.md'));

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('line 4, column 2: Unknown tag');
  });
});
