/** Where "Sign in" goes. The server checks `returnTo` and comes back to it after sign-in. */
export const loginHref = (returnTo?: string) =>
  returnTo && returnTo !== '/' ? `/login?returnTo=${encodeURIComponent(returnTo)}` : '/login';
