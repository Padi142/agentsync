// @vitest-environment jsdom
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { act, cleanup, render, screen } from '@testing-library/react';
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
const { routeTree } = await import('../src/routeTree.gen');

async function open(path: string) {
  const router = createRouter({ routeTree, context: { user: null }, history: createMemoryHistory({ initialEntries: [path] }) });
  await act(async () => { render(<RouterProvider router={router} />); });
  await act(() => router.load());
  return router;
}

afterEach(cleanup);

describe('Setup page', () => {
  it("gives the agent prompt and the install one-liner, pointed at this server", async () => {
    await open('/setup');
    const origin = window.location.origin;
    const prompt = await screen.findByLabelText('Agent setup prompt');
    expect(prompt.textContent).toContain(`agentsync init --yes --json --no-wait --server ${origin}`);
    expect(prompt.textContent).not.toContain('<SERVER_URL>');
    expect(screen.getByLabelText('Install command').textContent)
      .toBe(`npm install -g agentsync && agentsync init --server ${origin}`);
    expect(screen.getAllByRole('button', { name: /^Copy/ })).toHaveLength(2);
  });

  it('is linked from the Machines page, which also gives the install command when there are none', async () => {
    await open('/machines');
    expect((await screen.findByRole('link', { name: /More ways to add a Machine/ })).getAttribute('href')).toBe('/setup');
    expect(screen.getByLabelText('Install command').textContent)
      .toBe(`npm install -g agentsync && agentsync init --server ${window.location.origin}`);
  });
});
