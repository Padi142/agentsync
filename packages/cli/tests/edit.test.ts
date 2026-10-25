import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { setup } from './harness.js';

const append = (text: string) => (file: string) => writeFileSync(file, readFileSync(file, 'utf8') + text);

describe('edit', () => {
  it('opens the Template in the editor and saves the result as the next revision', async () => {
    const t = setup();
    t.registered();
    t.server.putTemplate('one\n');
    t.onEdit(append('two\n'));

    const result = await t.cli('edit');

    expect(result.code).toBe(0);
    expect(t.server.state.template).toMatchObject({ revision: 2, text: 'one\ntwo\n' });
  });

  it('saves nothing when the Template was not changed', async () => {
    const t = setup();
    t.registered();
    t.server.putTemplate('one\n');
    t.onEdit(() => {});

    const result = await t.cli('edit');

    expect(result.code).toBe(0);
    expect(t.server.state.template.revision).toBe(1);
  });

  it('offers to edit again when the Template does not parse', async () => {
    const t = setup();
    t.registered();
    t.server.putTemplate('one\n');
    t.onEdit(append('{{if x}}\n'));
    t.answer('e');
    t.onEdit((file) => writeFileSync(file, 'fixed\n'));

    const result = await t.cli('edit');

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('line 2');
    expect(t.server.state.template.text).toBe('fixed\n');
  });

  describe('when the Template changed meanwhile', () => {
    const conflicted = () => {
      const t = setup();
      t.registered();
      t.server.putTemplate('one\n');
      t.onEdit((file) => {
        append('mine\n')(file);
        t.server.putTemplate('one\ntheirs\n');
      });
      return t;
    };

    it('keeps the edit as a Conflict and can point to the web resolver', async () => {
      const t = conflicted();
      t.answer('w');

      const result = await t.cli('edit');

      expect(result.code).toBe(4);
      const [conflict] = t.server.state.conflicts;
      expect(conflict).toMatchObject({ baseRevision: 1, status: 'open' });
      expect(conflict!.text).toContain('mine');
      expect(result.stdout).toContain(conflict!.url);
    });

    it('can fix the Conflict here in the editor', async () => {
      const t = conflicted();
      t.answer('f');
      t.onEdit((file) => {
        expect(readFileSync(file, 'utf8')).toContain('<<<<<<<');
        writeFileSync(file, 'one\ntheirs\nmine\n');
      });

      const result = await t.cli('edit');

      expect(result.code).toBe(0);
      expect(t.server.state.template).toMatchObject({ revision: 3, text: 'one\ntheirs\nmine\n' });
      expect(t.server.state.conflicts[0]!.status).toBe('resolved');
    });

    it('can hand the Conflict to the agent this Machine uses', async () => {
      const t = conflicted();
      t.answer('a', 'codex');

      const result = await t.cli('edit');

      expect(result.code).toBe(4);
      const [conflict] = t.server.state.conflicts;
      expect(t.launched).toMatchObject([{ agent: 'codex', prompt: expect.stringContaining(conflict!.id) }]);
    });
  });

  describe('with --file', () => {
    it('saves the file as the revision after --base', async () => {
      const t = setup();
      t.registered();
      t.server.putTemplate('one\n');
      t.write('draft.md', 'two\n');

      const result = await t.cli('edit', '--json', '--file', t.path('draft.md'), '--base', '1');

      expect(result.code).toBe(0);
      expect(result.json()).toMatchObject({ ok: true, revision: 2 });
    });

    it('creates a Conflict and exits 4 when --base is not the current revision', async () => {
      const t = setup();
      t.registered();
      t.server.putTemplate('one\n');
      t.server.putTemplate('two\n');
      t.write('draft.md', 'mine\n');

      const result = await t.cli('edit', '--json', '--file', t.path('draft.md'), '--base', '1');

      expect(result.code).toBe(4);
      const [conflict] = t.server.state.conflicts;
      expect(result.json()).toMatchObject({ ok: false, conflict: { id: conflict!.id, url: conflict!.url } });
    });

    it('needs --base', async () => {
      const t = setup();
      t.registered();
      t.write('draft.md', 'mine\n');

      expect((await t.cli('edit', '--file', t.path('draft.md'))).code).toBe(2);
    });
  });

  describe('keeps the edited file when saving it fails', () => {
    it('when the Template cannot be saved, printing its path and base revision', async () => {
      const t = setup();
      t.registered();
      t.server.putTemplate('one\n');
      let draft = '';
      t.onEdit((file) => {
        draft = file;
        append('my edit\n')(file);
        t.server.state.down.add('/template/put');
      });

      const result = await t.cli('edit');

      expect(result.code).toBe(1);
      expect(readFileSync(draft, 'utf8')).toBe('one\nmy edit\n');
      expect(result.stderr).toContain(draft);
      expect(result.stderr).toContain(`agentsync edit --file ${draft} --base 1`);
    });

    it('when the Conflict cannot be created', async () => {
      const t = setup();
      t.registered();
      t.server.putTemplate('one\n');
      let draft = '';
      t.onEdit((file) => {
        draft = file;
        append('mine\n')(file);
        t.server.putTemplate('one\ntheirs\n');
        t.server.state.down.add('/conflicts/create');
      });

      const result = await t.cli('edit');

      expect(result.code).toBe(1);
      expect(readFileSync(draft, 'utf8')).toBe('one\nmine\n');
      expect(result.stderr).toContain(draft);
    });

    it('when fixing a Conflict here cannot be saved', async () => {
      const t = setup();
      t.registered();
      t.server.putTemplate('one\n');
      t.onEdit((file) => {
        append('mine\n')(file);
        t.server.putTemplate('one\ntheirs\n');
      });
      t.answer('f');
      let draft = '';
      t.onEdit((file) => {
        draft = file;
        writeFileSync(file, 'one\ntheirs\nmine\n');
        t.server.state.down.add('/conflicts/resolve');
      });

      const result = await t.cli('edit');

      expect(result.code).toBe(1);
      expect(readFileSync(draft, 'utf8')).toBe('one\ntheirs\nmine\n');
      const [conflict] = t.server.state.conflicts;
      expect(result.stderr).toContain(`agentsync conflict resolve ${conflict!.id} ${draft}`);
    });
  });

  it('deletes the edited file after saving it, or when the edit is given up', async () => {
    const t = setup();
    t.registered();
    t.server.putTemplate('one\n');
    const drafts: string[] = [];
    t.onEdit((file) => {
      drafts.push(file);
      append('two\n')(file);
    });
    await t.cli('edit');
    t.onEdit((file) => {
      drafts.push(file);
      append('{{if x}}\n')(file);
    });
    t.answer('q');

    const cancelled = await t.cli('edit');

    expect(cancelled.code).toBe(0);
    expect(drafts.map((file) => existsSync(file))).toEqual([false, false]);
  });
});
