// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ComponentType } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { routeMocks } from './route-mocks';

const { put } = vi.hoisted(() => ({ put: vi.fn() }));
vi.mock('@tanstack/react-router', () => routeMocks.module);
vi.mock('../src/rpc', () => ({ rpc: { variables: { put } } }));

const { Route } = await import('../src/routes/_app/machines.$machineId');
const MachineRoute = (Route as unknown as { options: { component: ComponentType } }).options.component;

/** A Machine at Variables revision 1, as the route's loader returns it. */
const machine = (id: string, name: string, editor: string) => ({
  machine: { id, name, os: 'linux', targets: [], createdAt: new Date(0), lastSeenAt: null },
  variables: { machineId: id, variables: { editor }, revision: 1 },
  history: [],
  template: { revision: 0, text: '', updatedAt: null },
});

afterEach(cleanup);

describe('Machine page', () => {
  it("shows the next Machine's own name and Variables, and saves them to that Machine", async () => {
    routeMocks.params = { machineId: 'a' };
    routeMocks.loaderData = machine('a', 'laptop-a', 'helix');
    const { rerender } = render(<MachineRoute />);

    // The router reuses the route component for another Machine at the same revision.
    routeMocks.params = { machineId: 'b' };
    routeMocks.loaderData = machine('b', 'server-b', 'vim');
    rerender(<MachineRoute />);

    expect(screen.getByLabelText<HTMLInputElement>('Name').value).toBe('server-b');
    const value = screen.getByLabelText<HTMLTextAreaElement>('Value of editor');
    expect(value.value).toBe('vim');

    put.mockResolvedValue({ machineId: 'b', variables: { editor: 'nano' }, revision: 2 });
    fireEvent.change(value, { target: { value: 'nano' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save Variables' })));
    expect(put).toHaveBeenCalledWith({ machineId: 'b', variables: { editor: 'nano' }, expectedRevision: 1 });
  });

  it('keeps unsaved Variable edits when the same Machine loads a newer revision', () => {
    routeMocks.params = { machineId: 'a' };
    routeMocks.loaderData = machine('a', 'laptop-a', 'helix');
    const { rerender } = render(<MachineRoute />);
    fireEvent.change(screen.getByLabelText('Value of editor'), { target: { value: 'emacs' } });

    const newer = machine('a', 'laptop-a', 'vim');
    routeMocks.loaderData = { ...newer, variables: { ...newer.variables, revision: 2 } };
    rerender(<MachineRoute />);

    expect(screen.getByLabelText<HTMLTextAreaElement>('Value of editor').value).toBe('emacs');
    expect(screen.getByText(/Revision 2 was saved while you were editing/)).toBeTruthy();
  });
});
