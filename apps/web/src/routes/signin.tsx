import { createFileRoute, redirect } from '@tanstack/react-router';
import { z } from 'zod';
import { loginHref } from '../login';

export const Route = createFileRoute('/signin')({
  validateSearch: z.object({ authError: z.string().optional(), returnTo: z.string().optional() }),
  beforeLoad: ({ context }) => {
    if (context.user) throw redirect({ to: '/' });
  },
  component: SignIn,
});

function SignIn() {
  const { authError, returnTo } = Route.useSearch();
  return (
    <section className="signin">
      <h1>One Template for your agent instructions.</h1>
      <p className="lede">
        AgentSync keeps <code>AGENTS.md</code>, <code>CLAUDE.md</code> and friends in sync on every
        Machine you work on. Edit the Template here, and each Machine Renders it for its agents.
      </p>
      <a className="button" href={loginHref(returnTo)}>Sign in</a>
      {authError ? (
        <p className="notice" role="status">
          {authError === 'cancelled'
            ? 'Sign-in was cancelled. You can try again.'
            : 'Sign-in could not be completed. Please try again.'}
        </p>
      ) : null}
    </section>
  );
}
