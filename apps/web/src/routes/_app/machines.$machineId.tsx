import type { VariableMap } from '@agentsync/contract';
import { isSettableVariableName, referencedVariables, validate } from '@agentsync/template';
import { isDefinedError, safe } from '@orpc/client';
import { createFileRoute, useBlocker, useRouter } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { Diff } from '../../components/Diff';
import { useDraft } from '../../draft';
import { formatTime } from '../../format';
import { useOwnNavigate } from '../../navigation';
import { rpc } from '../../rpc';

export const Route = createFileRoute('/_app/machines/$machineId')({
  loader: async ({ params: { machineId } }) => {
    const [machine, variables, history, template] = await Promise.all([
      rpc.machines.get({ machineId }),
      rpc.variables.get({ machineId }),
      rpc.variables.history({ machineId }),
      rpc.template.get(),
    ]);
    return { machine, variables, history, template };
  },
  component: MachineRoute,
});

/**
 * One page per Machine: moving to another Machine (once the unsaved-changes prompt allows it)
 * starts its forms afresh, while newer revisions of the same Machine keep the page mounted.
 */
function MachineRoute() {
  const { machineId } = Route.useParams();
  return <MachinePage key={machineId} />;
}

function MachinePage() {
  const { machine, variables } = Route.useLoaderData();
  const router = useRouter();
  const navigate = useOwnNavigate();
  const [name, setName] = useState(machine.name);
  const [notice, setNotice] = useState('');
  const [machineNotice, setMachineNotice] = useState('');

  const rename = async (event: FormEvent) => {
    event.preventDefault();
    const [error] = await safe(rpc.machines.update({ machineId: machine.id, name: name.trim() }));
    if (error) return setMachineNotice('Renaming failed. Please try again.');
    await router.invalidate();
  };
  const revoke = async () => {
    if (!window.confirm(`Revoke ${machine.name}? It stops syncing, and its Variables are deleted.`)) return;
    const [error] = await safe(rpc.machines.revoke({ machineId: machine.id }));
    if (error) return setMachineNotice('Revoking failed. Please try again.');
    await navigate({ to: '/machines', ignoreBlocker: true });
  };

  return (
    <div className="stack">
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h1>{machine.name}</h1>
            <p className="muted">
              {machine.os} · registered {formatTime(machine.createdAt)} · last seen{' '}
              {machine.lastSeenAt ? formatTime(machine.lastSeenAt) : 'never'}
            </p>
          </div>
          <button className="button danger" type="button" onClick={revoke}>Revoke</button>
        </div>
        <form className="inline-form" onSubmit={rename}>
          <label>
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} required />
          </label>
          <button className="button secondary" type="submit" disabled={!name.trim() || name.trim() === machine.name}>
            Rename
          </button>
        </form>
        <h3>Targets</h3>
        <ul className="plain">
          {machine.targets.map((t) => (
            <li key={t.path}><code>{t.path}</code> <span className="muted">Rendered for {t.agent}</span></li>
          ))}
        </ul>
        {machineNotice ? <p className="notice" role="status">{machineNotice}</p> : null}
      </section>
      <VariablesEditor notice={notice} setNotice={setNotice} />
      <VariablesHistory setNotice={setNotice} />
    </div>
  );
}

type Row = { name: string; value: string };
const toRows = (map: VariableMap): Row[] => Object.entries(map).map(([name, value]) => ({ name, value }));
const toMap = (rows: Row[]): VariableMap => Object.fromEntries(rows.map((r) => [r.name.trim(), r.value]));
const sameRows = (a: Row[], b: Row[]) => JSON.stringify(a) === JSON.stringify(b);

function VariablesEditor({ notice, setNotice }: { notice: string; setNotice: (notice: string) => void }) {
  const { machine, variables, template } = Route.useLoaderData();
  const router = useRouter();
  // Saved here, restored from history or changed elsewhere: a newer revision replaces the
  // form only while it has no unsaved edits.
  const draft = useDraft({ revision: variables.revision, value: toRows(variables.variables) }, sameRows);
  const rows = draft.value;
  const setRows = draft.set;
  useBlocker({
    shouldBlockFn: () => draft.dirty && !window.confirm('Leave without saving your Variable changes?'),
    enableBeforeUnload: () => draft.dirty,
  });

  const names = rows.map((r) => r.name.trim());
  const problem = (name: string, i: number) =>
    !name ? 'Give this Variable a name.'
      : !isSettableVariableName(name) ? 'Use letters, digits and _, not starting with a digit. agent, machine, if, else and end are reserved.'
      : names.indexOf(name) !== i ? 'This name is used twice.'
      : null;
  const invalid = names.some((name, i) => problem(name, i));
  const used = validate(template.text) ? [] : referencedVariables(template.text);
  const missing = used.filter((name) => !names.includes(name));

  const update = (i: number, patch: Partial<Row>) =>
    setRows(rows.map((row, j) => (j === i ? { ...row, ...patch } : row)));

  const save = (event: FormEvent) => {
    event.preventDefault();
    return draft.run(async (rows, revision) => {
      setNotice('');
      const [error, saved] = await safe(rpc.variables.put({
        machineId: machine.id, variables: toMap(rows), expectedRevision: revision,
      }));
      if (!error) {
        draft.saved(saved.revision);
        setNotice(`Saved revision ${saved.revision}.`);
        await router.invalidate();
      } else if (isDefinedError(error) && error.code === 'CONFLICT') {
        setNotice('These Variables were changed elsewhere. Your edits are kept below.');
        await router.invalidate(); // Learn the newer revision, so the form can offer to load it.
      } else if (isDefinedError(error) && error.code === 'INVALID_VARIABLE_NAME') {
      setNotice(`Invalid names: ${error.data.names.join(', ')}.`);
      } else {
        setNotice('Saving failed. Please try again.');
      }
    });
  };

  return (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <h2>Variables</h2>
          <p className="muted">
            {draft.revision ? `Revision ${draft.revision}` : 'None saved yet'} · substituted for{' '}
            <code>{'{{name}}'}</code> when Rendering on this Machine
          </p>
        </div>
      </div>
      {missing.length ? (
        <p className="issue warning">
          The Template uses {missing.length === 1 ? 'a Variable' : 'Variables'} this Machine doesn't set:{' '}
          {missing.map((name) => (
            <button key={name} className="chip" type="button" disabled={draft.busy}
              onClick={() => setRows([...rows, { name, value: '' }])}>
              + {name}
            </button>
          ))}
        </p>
      ) : null}
      {draft.newer ? (
        <p className="issue warning">
          Revision {draft.newer.revision} was saved while you were editing. Saving now would fail.{' '}
          <button className="link-button" type="button" disabled={draft.busy}
            onClick={() => draft.newer && window.confirm('Discard your edits?') && draft.load(draft.newer)}>
            Discard my edits and load revision {draft.newer.revision}
          </button>
        </p>
      ) : null}
      <form onSubmit={save}>
        <fieldset className="variables" disabled={draft.busy}>
          {rows.map((row, i) => {
            const issue = row.name || row.value ? problem(names[i], i) : null;
            return (
              <div className="variable-row" key={i}>
                <input
                  aria-label="Variable name" placeholder="name" value={row.name}
                  aria-invalid={!!issue} onChange={(e) => update(i, { name: e.target.value })}
                />
                <textarea
                  aria-label={`Value of ${row.name || 'new Variable'}`} placeholder="value" value={row.value}
                  rows={Math.min(6, row.value.split('\n').length)} onChange={(e) => update(i, { value: e.target.value })}
                />
                <button className="link-button" type="button" onClick={() => setRows(rows.filter((_, j) => j !== i))}>
                  Remove
                </button>
                {issue ? <p className="field-issue">{issue}</p> : null}
              </div>
            );
          })}
          <div className="actions">
            <button className="button secondary" type="button" onClick={() => setRows([...rows, { name: '', value: '' }])}>
              Add Variable
            </button>
            <button className="button" type="submit" disabled={!draft.dirty || invalid}>
              {draft.busy ? 'Saving…' : 'Save Variables'}
            </button>
          </div>
        </fieldset>
      </form>
      {notice ? <p className="notice" role="status">{notice}</p> : null}
    </section>
  );
}

const asText = (map: VariableMap) =>
  Object.keys(map).sort().map((name) => `${name} = ${map[name]}`).join('\n');

function VariablesHistory({ setNotice }: { setNotice: (notice: string) => void }) {
  const { machine, variables, history } = Route.useLoaderData();
  const router = useRouter();
  const [open, setOpen] = useState<number | null>(null);

  const restore = async (map: VariableMap, from: number) => {
    const [error, saved] = await safe(rpc.variables.put({
      machineId: machine.id, variables: map, expectedRevision: variables.revision,
    }));
    if (error) {
      setNotice(isDefinedError(error) && error.code === 'CONFLICT'
        ? 'These Variables were changed elsewhere. Reload them and try again.'
        : 'Restoring failed. Please try again.');
      return;
    }
    setNotice(`Restored revision ${from} as revision ${saved.revision}.`);
    setOpen(null);
    await router.invalidate();
  };

  return (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <h2>Variables history</h2>
          <p className="muted">Restoring saves an old revision as a new one</p>
        </div>
      </div>
      {history.length === 0 ? <p className="muted">No revisions yet.</p> : (
        <ul className="revisions">
          {history.map((entry) => (
            <li key={entry.revision}>
              <button className="revision-toggle" type="button" aria-expanded={open === entry.revision}
                onClick={() => setOpen(open === entry.revision ? null : entry.revision)}>
                <span>Revision {entry.revision}{entry.revision === variables.revision ? ' · current' : ''}</span>
                <span className="muted">{formatTime(entry.createdAt)}</span>
              </button>
              {open === entry.revision ? (
                <div className="revision-body">
                  {entry.revision === variables.revision ? <Diff before="" after={asText(entry.variables)} /> : (
                    <>
                      <p className="muted">Restoring it would make these changes:</p>
                      <Diff before={asText(variables.variables)} after={asText(entry.variables)} />
                    </>
                  )}
                  {entry.revision !== variables.revision ? (
                    <button className="button secondary" type="button" onClick={() => restore(entry.variables, entry.revision)}>
                      Restore revision {entry.revision}
                    </button>
                  ) : null}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
