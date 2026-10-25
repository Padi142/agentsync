// @vitest-environment jsdom
import { render as renderTemplate } from '@agentsync/template';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { routeMocks } from './route-mocks';

vi.mock('@tanstack/react-router', () => routeMocks.module);
const { copyText } = vi.hoisted(() => ({ copyText: vi.fn(async () => true) }));
vi.mock('../src/copy', () => ({ copyText }));

const { renderMarked } = await import('../src/preview');
const { Markdown } = await import('../src/components/Markdown');
const { Command } = await import('../src/components/Copy');

const context = {
  variables: { intro: '# Hello', editor: 'neovim' },
  builtins: { machine: { hostname: 'box', nickname: 'Work box', os: 'linux' }, agent: 'codex' },
};

afterEach(cleanup);

describe('renderMarked', () => {
  it('renders exactly what render does, and says where each value landed', () => {
    const template = '{{intro}}\n\n{{if agent == "codex"}}Use {{editor}}.{{end}}';
    const result = renderMarked(template, context);
    expect(result.text).toBe(renderTemplate(template, context).text);
    expect(result.ranges.map((r) => [result.text.slice(r.start, r.end), r.name]))
      .toEqual([['# Hello', 'intro'], ['neovim', 'editor']]);
  });
});

describe('Markdown preview', () => {
  it('renders Markdown, and marks values without breaking its structure', () => {
    const result = renderMarked('{{intro}}\n\n- on {{machine.nickname}}\n\n```\n{{editor}} --version\n```', context);
    const { container } = render(<Markdown ranges={result.ranges}>{result.text}</Markdown>);
    // A value at the start of a line still makes a heading.
    expect(container.querySelector('h1')?.textContent).toBe('Hello');
    expect(container.querySelector('li mark')?.textContent).toBe('Work box');
    expect(container.querySelector('pre code mark')?.textContent).toBe('neovim');
  });

  it('shows raw HTML as text instead of dropping it', () => {
    const { container } = render(<Markdown>{'<rules>\nBe brief.\n</rules>'}</Markdown>);
    expect(container.textContent).toContain('<rules>');
    expect(container.querySelector('rules')).toBeNull();
  });

  it('copies a code block without its trailing newline', async () => {
    render(<Markdown>{'```sh\nagentsync sync\n```'}</Markdown>);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Copy code' })));
    expect(copyText).toHaveBeenLastCalledWith('agentsync sync');
  });
});

describe('Command', () => {
  it('copies the command alone, never the prompt', async () => {
    render(<Command command="agentsync status" label="Status command" />);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Copy status command' })));
    expect(copyText).toHaveBeenLastCalledWith('agentsync status');
    expect(screen.getByLabelText('Status command').textContent).toBe('agentsync status');
  });
});
