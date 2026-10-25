import { describe, expect, it } from 'vitest';
import { withHook, withoutHook } from '../src/hooks.js';

const ours = 'agentsync sync --hook claude';
const ourGroup = { hooks: [{ type: 'command', command: ours, timeout: 10 }] };
const otherGroup = { matcher: 'startup', hooks: [{ type: 'command', command: 'echo hello' }] };

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

  it('replaces an older AgentSync hook instead of adding a second one', () => {
    const old = withHook({}, '/old/node /old/agentsync/dist/index.js sync --hook claude');

    expect(withHook(old, ours)).toEqual({ hooks: { SessionStart: [ourGroup] } });
  });

  it('does not change its input', () => {
    const settings = { hooks: { SessionStart: [otherGroup] } };

    withHook(settings, ours);

    expect(settings).toEqual({ hooks: { SessionStart: [otherGroup] } });
  });
});

describe('withoutHook', () => {
  it('removes only the AgentSync hook and drops what it leaves empty', () => {
    const settings = withHook({ model: 'opus', hooks: { SessionStart: [otherGroup] } }, ours);

    expect(withoutHook(settings)).toEqual({ model: 'opus', hooks: { SessionStart: [otherGroup] } });
    expect(withoutHook(withHook({ model: 'opus' }, ours))).toEqual({ model: 'opus' });
  });

  it('keeps hooks a person put in the same group as ours', () => {
    const shared = { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: ours }, otherGroup.hooks[0]] }] } };

    expect(withoutHook(shared)).toEqual({ hooks: { SessionStart: [{ hooks: [otherGroup.hooks[0]] }] } });
  });

  it('leaves settings without our hook unchanged', () => {
    const settings = { hooks: { SessionStart: [otherGroup] } };

    expect(withoutHook(settings)).toEqual(settings);
    expect(withoutHook({})).toEqual({});
  });
});
