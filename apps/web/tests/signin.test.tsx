// @vitest-environment jsdom
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The real router and routes, signed out.
vi.mock('../src/rpc', () => ({ rpc: { session: vi.fn(async () => null) } }));
const { routeTree } = await import('../src/routeTree.gen');

async function open(path: string) {
  const router = createRouter({ routeTree, context: { user: null }, history: createMemoryHistory({ initialEntries: [path] }) });
  await act(async () => { render(<RouterProvider router={router} />); });
  await act(() => router.load());
  return router;
}

afterEach(cleanup);

describe('signing in from a link', () => {
  it('sends a signed-out user to sign in and back to the Conflict they opened', async () => {
    const router = await open('/conflicts/c1');
    expect(router.state.location.pathname).toBe('/signin');
    expect((await screen.findByRole('link', { name: 'Sign in' })).getAttribute('href'))
      .toBe('/login?returnTo=%2Fconflicts%2Fc1');
  });

  it('signs in plainly from the home page', async () => {
    await open('/');
    expect((await screen.findByRole('link', { name: 'Sign in' })).getAttribute('href')).toBe('/login');
  });
});
