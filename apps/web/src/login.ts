export type LoginProvider = 'google' | 'github';

/** Where a provider's button goes. The server checks `returnTo` and comes back to it after sign-in. */
export function loginHref(provider: LoginProvider, returnTo?: string) {
  const query = new URLSearchParams({ provider });
  if (returnTo && returnTo !== '/') query.set('returnTo', returnTo);
  return `/login?${query}`;
}

/** Why an email sign-in step failed; the dialog has a sentence for each. */
export type EmailLoginError = 'invalid_email' | 'invalid_code' | 'too_many' | 'unavailable';
