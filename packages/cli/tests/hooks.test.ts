import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { piExtension, withHook, withoutHook } from '../src/hooks.js';

const ours = { type: 'command', command: 'agentsync sync --hook claude', timeout: 10 } as const;
const ourGroup = { hooks: [ours] };
const otherGroup = { matcher: 'startup', hooks: [{ type: 'command', command: 'echo hello' }] };
/** A person's own handler that happens to mention the AgentSync command. */
const wrapper = { hooks: [{ type: 'command', command: 'audit-wrapper agentsync sync --hook claude; run-other-setup' }] };

describe('withHook', () => {
  it('adds a SessionStart hook to empty settings', () => {
    expect(withHook({}, ours)).toEqual({ hooks: { SessionStart: [ourGroup] } });
  });

  it('keeps other settings, other events and other SessionStart hooks', () => {
    const settings = {
      model: 'opus',
      hooks: { SessionStart: [otherGroup], Stop: [{ hooks: [{ type: 'command', command: 'bell' }] }] },
    };

    expect(withHook(settings, ours)).toEqual({
      model: 'opus',
      hooks: { SessionStart: [otherGroup, ourGroup], Stop: settings.hooks.Stop },
    });
  });

  it('is idempotent', () => {
    const once = withHook({ hooks: { SessionStart: [otherGroup] } }, ours);

    expect(withHook(once, ours)).toEqual(once);
  });

  it('replaces the hook it installed before instead of adding a second one', () => {
    const previous = { type: 'command', command: "'/old/node' '/old/agentsync/dist/index.js' sync --hook claude", timeout: 10 } as const;

    expect(withHook(withHook({}, previous), ours, previous)).toEqual({ hooks: { SessionStart: [ourGroup] } });
  });

  it('leaves a handler of the person’s own that mentions the AgentSync command', () => {
    expect(withHook({ hooks: { SessionStart: [wrapper] } }, ours)).toEqual({
      hooks: { SessionStart: [wrapper, ourGroup] },
    });
  });

  it('does not change its input', () => {
    const settings = { hooks: { SessionStart: [otherGroup] } };

    withHook(settings, ours);

    expect(settings).toEqual({ hooks: { SessionStart: [otherGroup] } });
  });
});

describe('withoutHook', () => {
  it('removes only the hook AgentSync installed and drops what it leaves empty', () => {
    const settings = withHook({ model: 'opus', hooks: { SessionStart: [otherGroup] } }, ours);

    expect(withoutHook(settings, ours)).toEqual({ model: 'opus', hooks: { SessionStart: [otherGroup] } });
    expect(withoutHook(withHook({ model: 'opus' }, ours), ours)).toEqual({ model: 'opus' });
  });

  it('keeps hooks a person put in the same group as ours', () => {
    const shared = { hooks: { SessionStart: [{ hooks: [ours, otherGroup.hooks[0]] }] } };

    expect(withoutHook(shared, ours)).toEqual({ hooks: { SessionStart: [{ hooks: [otherGroup.hooks[0]] }] } });
  });

  it('keeps a handler of the person’s own that mentions the AgentSync command', () => {
    const settings = { hooks: { SessionStart: [wrapper] } };

    expect(withoutHook(settings, ours)).toEqual(settings);
  });

  it('keeps our handler once the person has changed it', () => {
    const changed = { hooks: { SessionStart: [{ hooks: [{ ...ours, timeout: 30 }] }] } };

    expect(withoutHook(changed, ours)).toEqual(changed);
  });

  it('leaves settings without our hook unchanged', () => {
    const settings = { hooks: { SessionStart: [otherGroup] } };

    expect(withoutHook(settings, ours)).toEqual(settings);
    expect(withoutHook({}, ours)).toEqual({});
  });
});

describe('piExtension', () => {
  type Handler = (event: Record<string, unknown>, ctx: unknown) => unknown;

  /** Write the extension for `command` and import it the way pi does. */
  async function importExtension(command: string, timeoutMs?: number) {
    const file = join(mkdtempSync(join(tmpdir(), 'agentsync-pi-')), 'agentsync.ts');
    writeFileSync(file, piExtension(command, timeoutMs));
    return (await import(pathToFileURL(file).href)).default;
  }

  /** Load the extension for `command` and return the handlers it registered. */
  async function load(command: string, timeoutMs?: number) {
    const factory = await importExtension(command, timeoutMs);
    const handlers: Record<string, Handler> = {};
    await factory({ on: (event: string, handler: Handler) => void (handlers[event] = handler) });
    return handlers;
  }

  it('runs the hook before pi goes on, then tells the person and the model its line', async () => {
    const handlers = await load(`node -e "console.log('AgentSync: updated it')"`);
    const notices: string[] = [];

    handlers.session_start!({}, { hasUI: true, ui: { notify: (text: string) => notices.push(text) } });

    expect(notices).toEqual(['AgentSync: updated it']);
    expect(handlers.before_agent_start!({ systemPrompt: 'You are pi.' }, {})).toEqual({
      systemPrompt: 'You are pi.\n\nAgentSync: updated it',
    });
  });

  it('registers nothing when the hook prints nothing or cannot run', async () => {
    expect(await load('node -e ""')).toEqual({});
    expect(await load('agentsync-command-that-does-not-exist')).toEqual({});
  });

  it('lets pi go on at the deadline, and stops a hook that ignores SIGTERM', async () => {
    const pidFile = join(mkdtempSync(join(tmpdir(), 'agentsync-pi-')), 'pid');
    const stuck = `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)`;
    const started = Date.now();

    // Through a shell, so the stuck process is the shell's child, as \`agentsync\` is in real use.
    const handlers = await load(`sh -c ${JSON.stringify(`node -e ${JSON.stringify(stuck)}`)}`, 500);

    expect(handlers).toEqual({});
    expect(Date.now() - started).toBeLessThan(3000);
    const pid = Number(readFileSync(pidFile, 'utf8'));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
  });

  it('keeps pi running when it cannot start taskkill on Windows', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentsync-pi-'));
    const pidFile = join(dir, 'pid');
    const stuck = `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`;
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    const systemRoot = process.env.SystemRoot;
    // The extension takes the Windows branch, but the command itself still runs here.
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const factory = await importExtension(`node -e ${JSON.stringify(stuck)}`, 300).finally(() =>
      Object.defineProperty(process, 'platform', platform),
    );
    process.env.SystemRoot = join(dir, 'no-windows-here');
    try {
      const handlers: Record<string, Handler> = {};
      await factory({ on: (event: string, handler: Handler) => void (handlers[event] = handler) });
      // Give taskkill's failed launch time to report its error, which must not be thrown.
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(handlers).toEqual({});
    } finally {
      if (systemRoot === undefined) delete process.env.SystemRoot;
      else process.env.SystemRoot = systemRoot;
      process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL');
    }
  });

  it('keeps a character that arrives split across two chunks whole', async () => {
    const euro = [...Buffer.from('€')];
    const split = `process.stdout.write(Buffer.from('AgentSync: ')); process.stdout.write(Buffer.from([${euro[0]}]));`
      + ` setTimeout(() => process.stdout.write(Buffer.from([${euro.slice(1).join(', ')}])), 100)`;
    const handlers = await load(`node -e ${JSON.stringify(split)}`);

    expect(handlers.before_agent_start!({ systemPrompt: 'pi' }, {})).toEqual({ systemPrompt: 'pi\n\nAgentSync: €' });
  });

  it('keeps a command with quotes intact', () => {
    expect(piExtension(`'/opt/node' "/my dir/index.js" sync --hook pi`)).toContain(
      `const COMMAND = "'/opt/node' \\"/my dir/index.js\\" sync --hook pi";`,
    );
  });
});
