import { describe, expect, it } from 'vitest';
import { withHook, withoutHook } from '../src/hooks.js';

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
