import { createFileRoute, Link } from '@tanstack/react-router';
import { Icon } from '../../components/Icon';
import { TemplateBar } from '../../components/TemplateBar';
import { Ago } from '../../components/Time';
import { rpc } from '../../rpc';

export const Route = createFileRoute('/_app/conflicts/')({
  loader: () => rpc.conflicts.list(),
  component: Conflicts,
});

function Conflicts() {
  const conflicts = Route.useLoaderData();
  return (
    <>
      <TemplateBar />
      <div className="page">
        {conflicts.length === 0 ? (
          <div className="empty">
            <h2>No open Conflicts</h2>
            <p>
              When two edits to the Template overlap, say from this editor and from a Machine, the one saved second is
              kept here as a Conflict. You merge it, and Machines keep the current Template until you do.
            </p>
          </div>
        ) : (
          <>
            <header className="page-head">
              <div>
                <h1>Open Conflicts</h1>
                <p>Edits that were saved after a newer revision. Machines keep the current Template until you merge them.</p>
              </div>
            </header>
            <ul className="rows" aria-label="Open Conflicts">
              {conflicts.map((conflict) => (
                <li key={conflict.id}>
                  <Link className="row-link conflict-row" to="/conflicts/$conflictId" params={{ conflictId: conflict.id }}>
                    <span className="row-title">
                      <strong>
                        Edit from {conflict.baseRevision ? `revision ${conflict.baseRevision}` : 'an empty Template'}, after
                        revision {conflict.serverRevision} was saved
                      </strong>
                      <span>Kept <Ago date={conflict.createdAt} /></span>
                    </span>
                    <span className="button secondary small">Resolve</span>
                    <span className="row-chevron"><Icon name="chevron" /></span>
                  </Link>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </>
  );
}
