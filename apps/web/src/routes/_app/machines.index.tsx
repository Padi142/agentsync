import { createFileRoute, Link } from '@tanstack/react-router';
import { z } from 'zod';
import { Command } from '../../components/Copy';
import { Icon } from '../../components/Icon';
import { Ago } from '../../components/Time';
import { installCommand } from '../../commands';
import { OS_NAMES } from '../../format';
import { rpc } from '../../rpc';

export const Route = createFileRoute('/_app/machines/')({
  validateSearch: z.object({ notice: z.enum(['deleted', 'already-deleted']).optional() }),
  loader: () => rpc.machines.list(),
  component: Machines,
});

/** Seen within the last day: its hooks are running. */
const FRESH = 24 * 60 * 60 * 1000;

function Machines() {
  const machines = Route.useLoaderData();
  const { notice } = Route.useSearch();
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Machines</h1>
          <p>Each computer here writes your Template into its agents' instruction files when an agent session starts.</p>
        </div>
        {machines.length ? <Link className="button" to="/setup"><Icon name="plus" />Add a Machine</Link> : null}
      </header>
      {notice ? (
        <p className="callout success appear" role="status" style={{ marginBottom: 20 }}>
          {notice === 'deleted' ? 'Machine deleted.' : 'That Machine was already deleted.'}
        </p>
      ) : null}
      {machines.length === 0 ? (
        <div className="empty">
          <h2>No Machines yet</h2>
          <p>Run this on a computer you use with Claude Code or Codex. It opens a sign-in link to approve the computer.</p>
          <div style={{ width: '100%' }}><Command command={installCommand()} label="Install command" /></div>
          <Link to="/setup">More ways to add a Machine, including a prompt for your agent</Link>
        </div>
      ) : (
        <ul className="rows" aria-label="Machines">
          {machines.map((machine) => (
            <li key={machine.id}>
              <Link className="row-link machine-row" to="/machines/$machineId" params={{ machineId: machine.id }}>
                <span className="row-title">
                  <strong>{machine.nickname}</strong>
                  <span>
                    {OS_NAMES[machine.os] ?? machine.os}
                    {machine.hostname !== machine.nickname ? <>, <code>{machine.hostname}</code></> : null}
                  </span>
                </span>
                <span className="row-paths">
                  {machine.targets.map((t) => <code key={t.path} className="path-chip" title={`Rendered for ${t.agent}`}>{t.path}</code>)}
                </span>
                <span className="row-meta seen">
                  <span className="seen-dot" aria-hidden="true"
                    data-fresh={machine.lastSeenAt && Date.now() - machine.lastSeenAt.getTime() < FRESH ? '' : undefined} />
                  {machine.lastSeenAt ? <span>Seen <Ago date={machine.lastSeenAt} /></span> : 'Never synced'}
                </span>
                <span className="row-chevron"><Icon name="chevron" /></span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
