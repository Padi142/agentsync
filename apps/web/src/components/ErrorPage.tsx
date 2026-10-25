import { ORPCError } from '@orpc/client';
import type { ErrorComponentProps } from '@tanstack/react-router';
import { loginHref } from '../login';

export function ErrorPage({ error, reset }: ErrorComponentProps) {
  const signedOut = error instanceof ORPCError && error.code === 'UNAUTHORIZED';
  return (
    <div className="page">
      <section className="empty" role="alert">
        <h1>{signedOut ? 'You are signed out' : 'Something went wrong'}</h1>
        <p>{signedOut ? 'Your session has ended.' : error instanceof Error ? error.message : String(error)}</p>
        {signedOut
          ? <a className="button" href={loginHref(window.location.pathname + window.location.search)}>Sign in</a>
          : <button className="button" type="button" onClick={reset}>Try again</button>}
      </section>
    </div>
  );
}
