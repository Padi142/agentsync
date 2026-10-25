import { Link, useRouteContext } from '@tanstack/react-router';
import type { ReactNode } from 'react';

/** The Template's views (editing it, its revisions, its Conflicts) share one sticky bar. */
export function TemplateBar({ children }: { children?: ReactNode }) {
  const { openConflicts } = useRouteContext({ from: '__root__' });
  return (
    <div className="toolbar">
      <h1>Template</h1>
      <nav className="tabs" aria-label="Template views">
        <Link to="/" activeOptions={{ exact: true }}>Editor</Link>
        <Link to="/history">History</Link>
        <Link to="/conflicts">
          Conflicts
          {openConflicts ? <span className="count" aria-label={`${openConflicts} open`}>{openConflicts}</span> : null}
        </Link>
      </nav>
      <div className="toolbar-end">{children}</div>
    </div>
  );
}
