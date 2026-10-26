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

    // A condition wraps the selection: pick the Variable, the comparison, then click a value.
    const palette = within(screen.getByRole('region', { name: 'Insert at the caret' }));
    editor.setSelectionRange(6, 11);
    fireEvent.change(palette.getByRole('combobox', { name: 'Variable' }), { target: { value: 'agent' } });
    fireEvent.click(palette.getByRole('button', { name: 'is not' }));
    fireEvent.click(palette.getByRole('button', { name: 'codex' }));
    await act(async () => new Promise(requestAnimationFrame));
    expect(editor.value).toBe('Hello {{if agent != "codex"}}world{{end}}');

    // Your own Variables are offered too, and say where they are set.
    editor.setSelectionRange(5, 5);
    fireEvent.click(screen.getByRole('button', { name: 'Insert' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /\{\{editor\}\}.*Set on 1 of 2 Machines/ }));
    await act(async () => new Promise(requestAnimationFrame));
    expect(editor.value).toBe('Hello{{editor}} {{if agent != "codex"}}world{{end}}');
    expect(screen.queryByRole('menu')).toBeNull();

    // On an empty line, or around whole lines, a block's tags get lines of their own.
    fireEvent.change(editor, { target: { value: 'one\n\ntwo\nthree\n' } });
    editor.setSelectionRange(4, 4);
    fireEvent.change(palette.getByRole('combobox', { name: 'Variable' }), { target: { value: 'machine.os' } });
    fireEvent.click(palette.getByRole('button', { name: 'is' }));
    fireEvent.click(palette.getByRole('button', { name: 'linux' }));
    await act(async () => new Promise(requestAnimationFrame));
    expect(editor.value).toBe('one\n{{if machine.os == "linux"}}\n\n{{end}}\ntwo\nthree\n');
    const two = editor.value.indexOf('two');
    editor.setSelectionRange(two, editor.value.length);
    fireEvent.click(palette.getByRole('button', { name: 'macos' }));
    await act(async () => new Promise(requestAnimationFrame));
    expect(editor.value).toBe('one\n{{if machine.os == "linux"}}\n\n{{end}}\n{{if machine.os == "macos"}}\ntwo\nthree\n{{end}}\n');
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
