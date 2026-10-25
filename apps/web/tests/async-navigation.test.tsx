// @vitest-environment jsdom
import { ORPCError } from '@orpc/client';
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The real router, routes and useBlocker; only the API is faked.
const { rpc } = vi.hoisted(() => {
  const machine = { id: 'b', name: 'server-b', os: 'linux', targets: [], createdAt: new Date(0), lastSeenAt: null };
  const conflict = (id: string, text: string) => ({
    id, text, baseRevision: 1, serverRevision: 1, status: 'open', url: `http://x/conflicts/${id}`,
    createdAt: new Date(0), closedAt: null,
  });
  return {
    rpc: {
      session: vi.fn(async () => ({ id: 'u', name: 'U', email: 'u@example.com' })),
      template: {
        get: vi.fn(async () => ({ revision: 1, text: 'base', updatedAt: null })),
        put: vi.fn(),
        history: vi.fn(async () => []),
        revision: vi.fn(async ({ revision }: { revision: number }) =>
          ({ revision, text: `text ${revision}`, createdAt: new Date(0) })),
        rollback: vi.fn(),
      },
      machines: { list: vi.fn(async () => [machine]), get: vi.fn(async () => machine) },
      variables: {
        get: vi.fn(async () => ({ machineId: 'b', variables: { editor: 'vim' }, revision: 1 })),
        history: vi.fn(async () => []),
      },
      conflicts: {
        list: vi.fn(async () => []),
        get: vi.fn(async ({ conflictId }: { conflictId: string }) =>
          conflict(conflictId, conflictId === 'c1' ? 'merged one' : 'merged two')),
        create: vi.fn(),
        resolve: vi.fn(),
      },
    },
  };
});
vi.mock('../src/rpc', () => ({ rpc }));

const { routeTree } = await import('../src/routeTree.gen');

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function open(path: string) {
  const router = createRouter({ routeTree, context: { user: null }, history: createMemoryHistory({ initialEntries: [path] }) });
  await act(async () => { render(<RouterProvider router={router} />); });
  await act(() => router.load());
  return router;
}

let confirm: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  confirm = vi.spyOn(window, 'confirm').mockReturnValue(true); // "Leave without saving?" → yes
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('an operation that finishes after its page was left', () => {
  it("doesn't take the user away from another page's unsaved edits (Template save → CONFLICT)", async () => {
    const router = await open('/');
    fireEvent.change(await screen.findByLabelText('Template'), { target: { value: 'mine' } });
    const put = deferred<never>();
    rpc.template.put.mockReturnValue(put.promise);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await act(() => router.navigate({ to: '/machines/$machineId', params: { machineId: 'b' } }));
    const value = await screen.findByLabelText<HTMLTextAreaElement>('Value of editor');
    fireEvent.change(value, { target: { value: 'emacs' } });
    const prompts = confirm.mock.calls.length;

    rpc.conflicts.create.mockResolvedValue({ id: 'c9' });
    await act(async () => put.reject(new ORPCError('CONFLICT', { defined: true, data: { currentRevision: 2 } })));

    expect(rpc.conflicts.create).toHaveBeenCalledWith({ baseRevision: 1, text: 'mine' }); // The edit is kept.
    expect(router.state.location.pathname).toBe('/machines/b');
    expect(screen.getByLabelText<HTMLTextAreaElement>('Value of editor').value).toBe('emacs');
    expect(confirm.mock.calls.length).toBe(prompts);
  });

  it("doesn't take the user away from another Conflict's merge (resolve succeeds late)", async () => {
    const router = await open('/conflicts/c1');
    const resolve = deferred<unknown>();
    rpc.conflicts.resolve.mockReturnValue(resolve.promise);
    fireEvent.click(await screen.findByRole('button', { name: 'Save and resolve' }));

    await act(() => router.navigate({ to: '/conflicts/$conflictId', params: { conflictId: 'c2' } }));
    await screen.findByText('merged two', { exact: false });
    const merge = screen.getByLabelText<HTMLTextAreaElement>('Merged Template');
    fireEvent.change(merge, { target: { value: 'merged two, edited' } });

    await act(async () => resolve.resolve({ conflict: {}, template: { revision: 5, text: 'merged one', updatedAt: null } }));

    expect(router.state.location.pathname).toBe('/conflicts/c2');
    expect(screen.getByLabelText<HTMLTextAreaElement>('Merged Template').value).toBe('merged two, edited');
  });

  it('still opens the new Conflict when the user stayed on the page', async () => {
    const router = await open('/');
    fireEvent.change(await screen.findByLabelText('Template'), { target: { value: 'mine' } });
    rpc.template.put.mockRejectedValue(new ORPCError('CONFLICT', { defined: true, data: { currentRevision: 2 } }));
    rpc.conflicts.create.mockResolvedValue({ id: 'c1' });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save' })));
    await act(() => router.load());

    expect(router.state.location.pathname).toBe('/conflicts/c1');
    expect(confirm).not.toHaveBeenCalled(); // The edit lives in the Conflict, so leaving needs no prompt.
  });
});

describe('a rollback that finishes after another revision was selected', () => {
  it('keeps the newer selection instead of jumping to the rolled-back revision', async () => {
    rpc.template.get.mockResolvedValue({ revision: 3, text: 'text 3', updatedAt: null });
    rpc.template.history.mockResolvedValue([3, 2, 1].map((revision) => ({ revision, createdAt: new Date(0) })));
    const router = await open('/history?revision=1');
    const rollback = deferred<unknown>();
    rpc.template.rollback.mockReturnValue(rollback.promise);
    fireEvent.click(await screen.findByRole('button', { name: 'Roll back to this revision' }));

    await act(() => router.navigate({ to: '/history', search: { revision: 2 } }));
    await act(async () => rollback.resolve({ revision: 4, text: 'text 1', updatedAt: null }));

    expect(router.state.location.search).toEqual({ revision: 2 });
    expect(screen.getByText('Restored revision 1 as revision 4.')).toBeTruthy();
  });
});
