import type { ReactNode } from 'react';

/**
 * A stand-in for `@tanstack/react-router` that renders a route's real component with
 * whatever loader data and params a test sets, so a test can switch them between renders.
 */
export const routeMocks = {
  loaderData: undefined as unknown,
  params: {} as Record<string, string>,
  navigate: async (_options: unknown) => {},
  module: {
    createFileRoute: () => (options: object) => ({
      options,
      useLoaderData: () => routeMocks.loaderData,
      useParams: () => routeMocks.params,
      useNavigate: () => (options: unknown) => routeMocks.navigate(options),
    }),
    useBlocker: () => {},
    useNavigate: () => (options: unknown) => routeMocks.navigate(options),
    useRouter: () => ({ invalidate: async () => {} }),
    useRouteContext: () => ({ openConflicts: 0 }),
    Link: ({ children }: { children: ReactNode }) => <a href="#">{children}</a>,
  },
};
