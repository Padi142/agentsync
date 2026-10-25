import { createFileRoute, Link, Outlet } from '@tanstack/react-router';
import { DOCS } from '../docs';

/** The docs are public: they read the same signed in or out. */
export const Route = createFileRoute('/docs')({
  head: () => ({ meta: [{ title: 'Docs – AgentSync' }] }),
  component: DocsLayout,
});

function DocsLayout() {
  return (
    <div className="docs-layout">
      <nav className="docs-nav" aria-label="Docs">
        {DOCS.map((doc) => (
          <Link key={doc.slug} to="/docs/$page" params={{ page: doc.slug }}>{doc.title}</Link>
        ))}
      </nav>
      <Outlet />
    </div>
  );
}
