// @vitest-environment jsdom
import { ORPCError } from '@orpc/client';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ComponentType } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { routeMocks } from './route-mocks';

const { put, create } = vi.hoisted(() => ({ put: vi.fn(), create: vi.fn() }));
vi.mock('@tanstack/react-router', () => routeMocks.module);
vi.mock('../src/rpc', () => ({ rpc: { template: { put }, conflicts: { create } } }));

const { Route } = await import('../src/routes/_app/index');
const Editor = (Route as unknown as { options: { component: ComponentType } }).options.component;

const data = (revision: number, text: string) => ({ template: { revision, text, updatedAt: null }, machines: [], variables: [] });

beforeEach(() => {
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  put.mockReset();
  create.mockReset();
});
afterEach(cleanup);

describe('Template editor', () => {
  it('keeps a stale save in charge: "discard and load" waits until the save is done', async () => {
    routeMocks.loaderData = data(1, 'base');
    const { rerender } = render(<Editor />);
    const editor = screen.getByLabelText<HTMLTextAreaElement>('Template');
    fireEvent.change(editor, { target: { value: 'mine' } });

    routeMocks.loaderData = data(2, 'theirs'); // Saved elsewhere while editing.
    rerender(<Editor />);
    let fail!: (error: unknown) => void;
    put.mockReturnValue(new Promise((_, reject) => { fail = reject; }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    const discard = screen.getByRole('button', { name: /Discard my edits/ });
    expect(discard).toHaveProperty('disabled', true);
    fireEvent.click(discard);
    fireEvent.change(editor, { target: { value: 'typed during the save' } });
    expect(editor.value).toBe('mine');

    create.mockResolvedValue({ id: 'c1' });
    await act(async () => fail(new ORPCError('CONFLICT', { defined: true, data: { currentRevision: 2 } })));
    expect(create).toHaveBeenCalledWith({ baseRevision: 1, text: 'mine' });
  });
});
