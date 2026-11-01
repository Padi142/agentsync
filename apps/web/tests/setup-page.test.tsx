// @vitest-environment jsdom
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The real router and routes, signed in.
vi.mock('../src/rpc', () => ({
  rpc: {
    session: vi.fn(async () => ({ id: 'u', name: 'U', email: 'u@example.com' })),
    conflicts: { list: vi.fn(async () => []) },
    template: { get: vi.fn(async () => ({ revision: 0, text: '', updatedAt: null })) },
    machines: { list: vi.fn(async () => []) },
  },
}));
const copied = vi.hoisted(() => [] as string[]);
vi.mock('../src/copy', () => ({ copyText: vi.fn(async (text: string) => { copied.push(text); return true; }) }));
const { routeTree } = await import('../src/routeTree.gen');
const { defaultInstallDir, setInstallDir } = await import('../src/commands');

async function open(path: string) {
  const router = createRouter({ routeTree, context: { user: null }, history: createMemoryHistory({ initialEntries: [path] }) });
  await act(async () => { render(<RouterProvider router={router} />); });
  await act(() => router.load());
  return router;
}

afterEach(() => {
  cleanup();
  setInstallDir(defaultInstallDir);
});

describe('Setup page', () => {
  it("gives the agent prompt and the clone-and-build one-liner, pointed at this server", async () => {
    await open('/setup');
    const origin = window.location.origin;
    const prompt = await screen.findByLabelText('Agent setup prompt');
    expect(prompt.textContent).toContain(`agentsync init --yes --json --no-wait --server ${origin}`);
    expect(prompt.textContent).not.toContain('<SERVER_URL>');
    expect(screen.getAllByRole('button', { name: /^Copy/ })).toHaveLength(2);

    fireEvent.click(screen.getByRole('button', { name: 'Copy install command' }));
    expect(copied.at(-1)).toBe(`git clone https://github.com/Padi142/agentsync.git ~/agentsync && cd ~/agentsync && pnpm install && pnpm build && (cd packages/cli && npm link) && agentsync init --server ${origin}`);
  });

  it('lets the reader pick the install folder, and quotes it for the shell', async () => {
    await open('/setup');
    const [clone, cd] = await screen.findAllByLabelText('Install folder');
    fireEvent.change(clone!, { target: { value: "~/code/Bob's tools" } });
    expect((cd as HTMLInputElement).value).toBe("~/code/Bob's tools");

    fireEvent.click(screen.getByRole('button', { name: 'Copy install command' }));
    expect(copied.at(-1)).toMatch(/^git clone \S+ ~\/'code\/Bob'\\''s tools' && cd ~\/'code\/Bob'\\''s tools' && /);
    expect(screen.getByLabelText('Agent setup prompt').textContent).toContain(`~/'code/Bob'\\''s tools'`);
    expect(screen.getByLabelText('Agent setup prompt').textContent).not.toContain('<INSTALL_DIR>');
  });

  it('is linked from the Machines page, which also gives the install command when there are none', async () => {
    await open('/machines');
    expect((await screen.findByRole('link', { name: /More ways to add a Machine/ })).getAttribute('href')).toBe('/setup');
    expect(screen.getByLabelText('Install command').textContent)
      .toMatch(new RegExp(`^git clone .* && agentsync init --server ${window.location.origin}$`));
  });
});
