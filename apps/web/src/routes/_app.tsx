import { createFileRoute, redirect } from '@tanstack/react-router';

/** Every page under here needs a signed-in user. */
export const Route = createFileRoute('/_app')({
  beforeLoad: ({ context, location }) => {
    // The sign-in callback reports failures as `/?authError=…`.
    const { authError } = location.search as { authError?: string };
    // Come back here after signing in, e.g. to a Conflict linked from the CLI.
    const returnTo = authError || location.pathname === '/' ? undefined : location.href;
    if (!context.user) throw redirect({ to: '/signin', search: { authError, returnTo } });
    return { user: context.user };
  },
});
