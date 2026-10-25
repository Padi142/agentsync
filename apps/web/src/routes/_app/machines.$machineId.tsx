import type { VariableMap } from '@agentsync/contract';
import { isSettableVariableName, referencedVariables, validate } from '@agentsync/template';
import { isDefinedError, safe } from '@orpc/client';
import { createFileRoute, useBlocker, useRouter } from '@tanstack/react-router';
import { useEffect, useState, type FormEvent } from 'react';
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
  const { machine } = Route.useLoaderData();
  const router = useRouter();
  const navigate = useOwnNavigate();
  const [notice, setNotice] = useState('');
  const [machineNotice, setMachineNotice] = useState('');
  const [pending, setPending] = useState<'rename' | 'delete' | null>(null);
  const [variablesDirty, setVariablesDirty] = useState(false);
  // The nickname the input last took from the server: a newer one replaces a clean input only.
  const [base, setBase] = useState(machine.name);
  const [name, setName] = useState(machine.name);
  const [changedElsewhere, setChangedElsewhere] = useState(false);
  if (machine.name !== base) {
    if (name === base) setName(machine.name);
    else if (name.trim() !== machine.name) setChangedElsewhere(true);
    setBase(machine.name);
  }
  const trimmed = name.trim();
  const nameProblem = !trimmed ? 'Give this Machine a nickname.' : trimmed.length > 100 ? 'Use at most 100 characters.' : null;

  const rename = async (event: FormEvent) => {
    event.preventDefault();
    if (pending || nameProblem) return;
    setPending('rename');
    const [error, saved] = await safe(rpc.machines.update({ machineId: machine.id, name: trimmed }));
    setPending(null);
    if (error) return setMachineNotice('Saving the nickname failed. Please try again.');
    // The loader still holds the old nickname until it refreshes; the input already shows the new one.
    setName(saved.name);
    setChangedElsewhere(false);
    setMachineNotice('Nickname saved.');
    await router.invalidate();
  };
  const remove = async () => {
    if (pending) return;
    const discard = variablesDirty ? '\n\nYour unsaved Variable changes on this page will be discarded.' : '';
    const confirmed = window.confirm(
      `Delete ${machine.name}?\n\nIt stops syncing, and its registration, token, Variables and Variable history are permanently removed. ` +
        `Its local instruction files and the shared Template stay. To use it again, run \`agentsync logout\` and then \`agentsync init\` on it.${discard}`,
    );
    if (!confirmed) return;
    setPending('delete');
    // The UUID, never the nickname: nicknames need not be unique.
    const [error] = await safe(rpc.machines.revoke({ machineId: machine.id }));
    if (error && !(isDefinedError(error) && error.code === 'NOT_FOUND')) {
      setPending(null);
      return setMachineNotice('Deleting the Machine failed. Please try again.');
    }
    await navigate({ to: '/machines', search: { notice: error ? 'already-deleted' : 'deleted' }, ignoreBlocker: true });
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
        </div>
        <form className="inline-form" onSubmit={rename}>
          <label>
            Nickname
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} required
              aria-invalid={!!nameProblem} disabled={pending !== null} />
          </label>
          <button className="button secondary" type="submit"
            disabled={pending !== null || !!nameProblem || trimmed === machine.name}>
            {pending === 'rename' ? 'Saving…' : 'Save nickname'}
          </button>
        </form>
        {nameProblem && name ? <p className="field-issue">{nameProblem}</p> : null}
        {changedElsewhere && trimmed !== machine.name ? (
          <p className="issue warning">The saved nickname changed to “{machine.name}” while you were editing.</p>
        ) : null}
        <p className="muted">
          Use <code>{'{{machine.nickname}}'}</code> in your Template. <code>{'{{machine.name}}'}</code> is a supported
          alias. Changes apply to Targets on the next sync.
        </p>
        <h3>Targets</h3>
        <ul className="plain">
          {machine.targets.map((t) => (
            <li key={t.path}><code>{t.path}</code> <span className="muted">Rendered for {t.agent}</span></li>
          ))}
        </ul>
        {machineNotice ? <p className="notice" role="status">{machineNotice}</p> : null}
      </section>
      <VariablesEditor notice={notice} setNotice={setNotice} setDirty={setVariablesDirty} />
      <VariablesHistory setNotice={setNotice} />
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Delete Machine</h2>
            <p className="muted">Stops syncing and permanently removes its registration, token and Variables.</p>
          </div>
          <button className="button danger" type="button" onClick={remove} disabled={pending !== null}>
            {pending === 'delete' ? 'Deleting…' : 'Delete Machine'}
          </button>
        </div>
      </section>
    </div>
  );
}

type Row = { name: string; value: string };
const toRows = (map: VariableMap): Row[] => Object.entries(map).map(([name, value]) => ({ name, value }));
const toMap = (rows: Row[]): VariableMap => Object.fromEntries(rows.map((r) => [r.name.trim(), r.value]));
const sameRows = (a: Row[], b: Row[]) => JSON.stringify(a) === JSON.stringify(b);

function VariablesEditor({ notice, setNotice, setDirty }: {
  notice: string;
  setNotice: (notice: string) => void;
  setDirty: (dirty: boolean) => void;
}) {
  const { machine, variables, template } = Route.useLoaderData();
  const router = useRouter();
  // Saved here, restored from history or changed elsewhere: a newer revision replaces the
  // form only while it has no unsaved edits.
  const draft = useDraft({ revision: variables.revision, value: toRows(variables.variables) }, sameRows);
  const rows = draft.value;
  const setRows = draft.set;
  useEffect(() => setDirty(draft.dirty), [draft.dirty, setDirty]);
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
