// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const { reload } = vi.hoisted(() => ({ reload: { resolve: () => {} } }));
vi.mock('@tanstack/react-router', () => ({
  useRouter: () => ({ invalidate: () => new Promise<void>((resolve) => { reload.resolve = resolve; }) }),
}));
const { useSkillActions } = await import('../src/skill-actions');

describe('Skills changes', () => {
  it('start the next change only once the page shows the last one, so it never works from stale data', async () => {
    const { result } = renderHook(() => useSkillActions());
    let first!: Promise<boolean>;
    await act(async () => { first = result.current.run('a', async () => 'ok', () => 'done'); });
    // The change is saved, but the page is still reloading.
    const second = vi.fn(async () => 'ok');
    let started!: boolean;
    await act(async () => { started = await result.current.run('b', second, () => 'done'); });
    expect(started).toBe(false);
    expect(second).not.toHaveBeenCalled();

    await act(async () => { reload.resolve(); await first; });
    expect(result.current.busy).toBeNull();
  });
});
