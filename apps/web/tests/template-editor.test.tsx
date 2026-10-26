// @vitest-environment jsdom
import { ORPCError } from '@orpc/client';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ComponentType } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { routeMocks } from './route-mocks';

const { put, create } = vi.hoisted(() => ({ put: vi.fn(), create: vi.fn() }));
vi.mock('@tanstack/react-router', () => routeMocks.module);
vi.mock('../src/rpc', () => ({ rpc: { template: { put }, conflicts: { create } } }));

const { Route } = await import('../src/routes/_app/index');
const Editor = (Route as unknown as { options: { component: ComponentType } }).options.component;

const data = (revision: number, text: string) => ({ template: { revision, text, updatedAt: null }, machines: [], variables: [] });
const machine = (id: string) => ({ id, nickname: id, hostname: id, os: 'linux', createdAt: new Date(0), lastSeenAt: null, targets: [] });

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

  it('inserts from the palette and the Insert menu where the caret was', async () => {
    routeMocks.loaderData = { ...data(1, 'Hello world'), machines: [machine('a'), machine('b')], variables: [{ editor: 'vim' }, {}] };
    // jsdom has no execCommand, so this takes the editor's fallback path.
    document.execCommand = () => false;
    render(<Editor />);
    const editor = screen.getByLabelText<HTMLTextAreaElement>('Template');

    // A Block wraps the selection.
    editor.setSelectionRange(6, 11);
    fireEvent.click(screen.getByRole('button', { name: /^\{\{if agent == "codex"\}\}/ }));
    await act(async () => new Promise(requestAnimationFrame));
    expect(editor.value).toBe('Hello {{if agent == "codex"}}world{{end}}');

    // Your own Variables are offered too, and say where they are set.
    editor.setSelectionRange(5, 5);
    fireEvent.click(screen.getByRole('button', { name: 'Insert' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /\{\{editor\}\}.*Set on 1 of 2 Machines/ }));
    await act(async () => new Promise(requestAnimationFrame));
    expect(editor.value).toBe('Hello{{editor}} {{if agent == "codex"}}world{{end}}');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('offers the values a condition can compare with, and completes the quote', async () => {
    routeMocks.loaderData = { ...data(1, ''), machines: [machine('alpha'), machine('beta')], variables: [{}, {}] };
    document.execCommand = () => false;
    render(<Editor />);
    const editor = screen.getByLabelText<HTMLTextAreaElement>('Template');

    // Inside an existing value: replace it and keep the closing quote.
    fireEvent.change(editor, { target: { value: '{{if machine.nickname == "zzz" }}' } });
    editor.setSelectionRange(26, 26);
    fireEvent.select(editor);
    const values = screen.getByRole('listbox', { name: 'Values of machine.nickname' });
    expect(within(values).getAllByRole('option').map((o) => o.querySelector('code')?.textContent)).toEqual(['alpha', 'beta']);
    fireEvent.click(within(values).getByRole('option', { name: /beta/ }));
    await act(async () => new Promise(requestAnimationFrame));
    expect(editor.value).toBe('{{if machine.nickname == "beta" }}');

    // A fresh value gets its quote and braces; every OS is offered, used or not.
    fireEvent.change(editor, { target: { value: '{{if machine.os != "w' } });
    const os = screen.getByRole('listbox', { name: 'Values of machine.os' });
    expect(within(os).getByRole('option', { name: /windows.*No Machine yet/ })).toBeTruthy();
    fireEvent.keyDown(editor, { key: 'Enter' });
    await act(async () => new Promise(requestAnimationFrame));
    expect(editor.value).toBe('{{if machine.os != "windows"}}');
  });
});
