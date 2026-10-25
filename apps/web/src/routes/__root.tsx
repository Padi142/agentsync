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
import { BrandMark } from '../components/Icon';
import { loginHref } from '../login';
import { ErrorPage } from '../components/ErrorPage';
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
      { name: 'viewport', content: 'width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content' },
      // The topbar's white; the app has no dark theme.
      { name: 'theme-color', content: '#ffffff' },
      { title: 'AgentSync' },
    ],
    links: [{ rel: 'stylesheet', href: appCss }],
  }),
  shellComponent: DocumentShell,
  component: Layout,
  // The session is not known yet, or could not be fetched: keep the frame, without its nav.
  pendingComponent: () => (
    <Frame>
      <div className="loading-bar delayed" aria-hidden="true" />
      <p className="visually-hidden" role="status">Loading</p>
    </Frame>
  ),
  errorComponent: (props) => <Frame><ErrorPage {...props} /></Frame>,
});

function Frame({ children }: { children: ReactNode }) {
  return (
    <>
      <header className="topbar"><Brand /></header>
      <main>{children}</main>
    </>
  );
}

const Brand = () => (
  <Link className="brand" to="/" aria-label="AgentSync">
    <BrandMark />
    <span>AgentSync</span>
  </Link>
);

function Layout() {
  const { user, openConflicts } = Route.useRouteContext();
  const loading = useRouterState({ select: (state) => state.status === 'pending' });
  const path = useRouterState({ select: (state) => state.location.pathname });
  return (
    <>
      {loading ? <div className="loading-bar" aria-hidden="true" /> : null}
      <header className="topbar">
        <Brand />
        <nav className="nav" aria-label="Main">
          {user ? (
            <>
              <Link to="/" activeOptions={{ exact: true }}
                className={isTemplatePath(path) ? 'active' : undefined}>Template</Link>
              <Link to="/machines">Machines</Link>
            </>
          ) : null}
          <Link to="/docs">Docs</Link>
        </nav>
        <div className="topbar-end">
          {user ? (
            <>
              {/* On the Template's own views, its Conflicts tab shows the count. */}
              {openConflicts && !isTemplatePath(path) ? (
                <Link className="conflict-pill" to="/conflicts">
                  <span className="count">{openConflicts}</span>
                  {openConflicts === 1 ? 'Conflict' : 'Conflicts'}
                </Link>
              ) : null}
              <span className="account" title={user.name}>{user.email}</span>
              <form action="/logout" method="post">
                <button className="button secondary small" type="submit">Sign out</button>
              </form>
            </>
          ) : path === '/signin' ? null : (
            <a className="button small" href={loginHref(undefined)}>Sign in</a>
          )}
        </div>
      </header>
      <main aria-busy={loading}>
        <Outlet />
      </main>
    </>
  );
}

/** History and Conflicts are views of the Template, so its nav item stays lit on them. */
const isTemplatePath = (path: string) => path === '/' || path.startsWith('/history') || path.startsWith('/conflicts');

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
