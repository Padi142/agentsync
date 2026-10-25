import { createRouter } from '@tanstack/react-router';
import { ErrorPage } from './components/ErrorPage';
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

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
