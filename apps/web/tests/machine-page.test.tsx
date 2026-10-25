// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ComponentType } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { routeMocks } from './route-mocks';

const { put, update, revoke } = vi.hoisted(() => ({ put: vi.fn(), update: vi.fn(), revoke: vi.fn() }));
vi.mock('@tanstack/react-router', () => routeMocks.module);
vi.mock('../src/rpc', () => ({ rpc: { variables: { put }, machines: { update, revoke } } }));

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

    expect(screen.getByLabelText<HTMLInputElement>('Nickname').value).toBe('server-b');
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

  it('saves a trimmed nickname for this Machine by its ID, and keeps the input when saving fails', async () => {
    routeMocks.params = { machineId: 'a' };
    routeMocks.loaderData = machine('a', 'laptop-a', 'helix');
    render(<MachineRoute />);
    const input = screen.getByLabelText<HTMLInputElement>('Nickname');
    const save = screen.getByRole<HTMLButtonElement>('button', { name: 'Save nickname' });
    expect(save.disabled).toBe(true);

    update.mockRejectedValueOnce(new Error('offline'));
    fireEvent.change(input, { target: { value: '  Work laptop ' } });
    await act(async () => fireEvent.click(save));
    expect(update).toHaveBeenCalledWith({ machineId: 'a', name: 'Work laptop' });
    expect(input.value).toBe('  Work laptop ');
    expect(screen.getByText(/Saving the nickname failed/)).toBeTruthy();

    update.mockResolvedValueOnce({ ...routeMocks.loaderData.machine, name: 'Work laptop' });
    await act(async () => fireEvent.click(save));
    expect(input.value).toBe('Work laptop');
    expect(screen.getByText('Nickname saved.')).toBeTruthy();
  });

  it('deletes the Machine by its ID only once confirmed', async () => {
    routeMocks.params = { machineId: 'a' };
    routeMocks.loaderData = machine('a', 'laptop-a', 'helix');
    const navigate = vi.spyOn(routeMocks, 'navigate');
    render(<MachineRoute />);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false);

    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Delete Machine' })));
    expect(confirm.mock.calls[0]![0]).toMatch(/^Delete laptop-a\?/);
    expect(revoke).not.toHaveBeenCalled();

    confirm.mockReturnValueOnce(true);
    revoke.mockResolvedValueOnce(undefined);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Delete Machine' })));
    expect(revoke).toHaveBeenCalledWith({ machineId: 'a' });
    expect(navigate).toHaveBeenCalledWith(expect.objectContaining({ to: '/machines', search: { notice: 'deleted' } }));
  });
});
