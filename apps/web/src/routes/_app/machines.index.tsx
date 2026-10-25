import { createFileRoute, Link } from '@tanstack/react-router';
import { formatTime } from '../../format';
import { rpc } from '../../rpc';

export const Route = createFileRoute('/_app/machines/')({
  loader: () => rpc.machines.list(),
  component: Machines,
});

function Machines() {
  const machines = Route.useLoaderData();
  return (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <h1>Machines</h1>
          <p className="muted">Computers that Render your Template into their Targets</p>
        </div>
      </div>
      {machines.length === 0 ? (
        <p className="muted">No Machines yet. Register one with the AgentSync CLI.</p>
      ) : (
        <table className="table">
          <thead>
            <tr><th>Name</th><th>OS</th><th>Targets</th><th>Last seen</th></tr>
          </thead>
          <tbody>
            {machines.map((machine) => (
              <tr key={machine.id}>
                <td>
                  <Link to="/machines/$machineId" params={{ machineId: machine.id }}>{machine.name}</Link>
                </td>
                <td>{machine.os}</td>
                <td>
                  {machine.targets.map((t) => (
                    <div key={t.path}><code>{t.path}</code> <span className="muted">{t.agent}</span></div>
                  ))}
                </td>
                <td>{machine.lastSeenAt ? formatTime(machine.lastSeenAt) : 'never'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
