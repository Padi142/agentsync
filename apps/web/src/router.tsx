import { ORPCError } from '@orpc/client';
import { createRouter, type ErrorComponentProps } from '@tanstack/react-router';
import { routeTree } from './routeTree.gen';

export function getRouter() {
  return createRouter({
    routeTree,
    context: { user: null },
    defaultPreload: 'intent',
    scrollRestoration: true,
    defaultErrorComponent: ErrorPage,
  });
}

function ErrorPage({ error, reset }: ErrorComponentProps) {
  const signedOut = error instanceof ORPCError && error.code === 'UNAUTHORIZED';
  return (
    <section className="panel">
      <h1>{signedOut ? 'You are signed out' : 'Something went wrong'}</h1>
      <p className="muted">{signedOut ? 'Your session has ended.' : error instanceof Error ? error.message : String(error)}</p>
      {signedOut
        ? <a className="button" href="/login">Sign in</a>
        : <button className="button" type="button" onClick={reset}>Try again</button>}
    </section>
  );
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
