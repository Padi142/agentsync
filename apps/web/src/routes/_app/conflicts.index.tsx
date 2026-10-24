import { createFileRoute, Link } from '@tanstack/react-router';
import { formatTime } from '../../format';
import { rpc } from '../../rpc';

export const Route = createFileRoute('/_app/conflicts/')({
  loader: () => rpc.conflicts.list(),
  component: Conflicts,
});

function Conflicts() {
  const conflicts = Route.useLoaderData();
  return (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <h1>Conflicts</h1>
          <p className="muted">
            Template edits that lost to a newer save. Machines keep the current Template until you merge them.
          </p>
        </div>
      </div>
      {conflicts.length === 0 ? <p className="muted">No open Conflicts.</p> : (
        <table className="table">
          <thead>
            <tr><th>Created</th><th>Edit started from</th><th>Saved first</th><th /></tr>
          </thead>
          <tbody>
            {conflicts.map((conflict) => (
              <tr key={conflict.id}>
                <td>{formatTime(conflict.createdAt)}</td>
                <td>{conflict.baseRevision ? `revision ${conflict.baseRevision}` : 'an empty Template'}</td>
                <td>revision {conflict.serverRevision}</td>
                <td>
                  <Link to="/conflicts/$conflictId" params={{ conflictId: conflict.id }}>Resolve</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
