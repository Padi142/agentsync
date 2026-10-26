import { identify, track } from '@databuddy/sdk';
import { Databuddy } from '@databuddy/sdk/react';
import type { User } from '@agentsync/contract';
import { useEffect } from 'react';
import { SIGNUP_COOKIE } from './signup';

const clientId = import.meta.env.VITE_DATABUDDY_CLIENT_ID as string | undefined;

/** The Databuddy tracker. Page views, sessions, Web Vitals, errors and session replay need nothing else. */
export function Analytics() {
  if (!clientId) return null;
  return <Databuddy clientId={clientId} trackWebVitals trackErrors trackOutgoingLinks replay />;
}

/** Links this browser's sessions to the signed-in user, and reports a fresh sign-up once. */
export function useIdentify(user: User | null) {
  const id = user?.id;
  useEffect(() => {
    if (!user) return;
    identify(user.id, { email: user.email, name: user.name });
    if (document.cookie.split('; ').includes(`${SIGNUP_COOKIE}=1`)) {
      document.cookie = `${SIGNUP_COOKIE}=; Max-Age=0; Path=/`;
      track('signup_completed');
    }
    // Only a different user needs a new identify.
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
}

export { track };
