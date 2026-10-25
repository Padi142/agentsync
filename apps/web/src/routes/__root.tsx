import type { User } from '@agentsync/contract';
import {
  createRootRouteWithContext,
  HeadContent,
  Link,
  Outlet,
  Scripts,
  useRouterState,
} from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { rpc } from '../rpc';
import appCss from '../styles.css?url';

export interface RouterContext {
  user: User | null;
}

/**
 * The signed-in user, fetched once per page load. Signing out reloads the page, and an
 * expired session makes RPC calls fail with `UNAUTHORIZED`, which the error page handles.
 */
let session: Promise<User | null> | undefined;

export const Route = createRootRouteWithContext<RouterContext>()({
  // Every route loads in the browser, where same-origin RPC calls carry the session cookie.
  ssr: false,
  // Runs on every navigation, which keeps the open Conflicts count current.
  beforeLoad: async () => {
    const user = await (session ??= rpc.session().catch((error: unknown) => {
      session = undefined; // Ask again next time.
      throw error;
    }));
    return { user, openConflicts: user ? (await rpc.conflicts.list()).length : 0 };
  },
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'AgentSync' },
    ],
    links: [{ rel: 'stylesheet', href: appCss }],
  }),
  shellComponent: DocumentShell,
  component: Layout,
  pendingComponent: () => <p className="muted page">Loading…</p>,
});

function Layout() {
  const { user, openConflicts } = Route.useRouteContext();
  const loading = useRouterState({ select: (state) => state.status === 'pending' });
  return (
    <>
      <header className="topbar">
        <Link className="brand" to="/">
          <span className="brand-mark" aria-hidden="true">/</span>
          AgentSync
        </Link>
        {user ? (
          <nav className="nav">
            <Link to="/" activeOptions={{ exact: true }}>Template</Link>
            <Link to="/machines">Machines</Link>
            <Link to="/history">History</Link>
            <Link to="/conflicts">
              Conflicts
              {openConflicts ? <span className="badge">{openConflicts}</span> : null}
            </Link>
            <Link to="/setup">Setup</Link>
            <form action="/logout" method="post">
              <button className="link-button" type="submit" title={user.email}>Sign out</button>
            </form>
          </nav>
        ) : null}
      </header>
      <main className="page" aria-busy={loading}>
        <Outlet />
      </main>
    </>
  );
}

function DocumentShell({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
