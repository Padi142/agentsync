import type { VariableMap } from '@agentsync/contract';
import { isSettableVariableName, referencedVariables, validate } from '@agentsync/template';
import { isDefinedError, safe } from '@orpc/client';
import { createFileRoute, Link, useBlocker, useRouter } from '@tanstack/react-router';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Command, CopyButton } from '../../components/Copy';
import { Diff } from '../../components/Diff';
import { Icon } from '../../components/Icon';
import { Ago } from '../../components/Time';
import { useDraft } from '../../draft';
import { OS_NAMES } from '../../format';
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
  const [base, setBase] = useState(machine.nickname);
  const [name, setName] = useState(machine.nickname);
  const [changedElsewhere, setChangedElsewhere] = useState(false);
  if (machine.nickname !== base) {
    if (name === base) setName(machine.nickname);
    else if (name.trim() !== machine.nickname) setChangedElsewhere(true);
    setBase(machine.nickname);
  }
  const trimmed = name.trim();
  const nameProblem = !trimmed ? 'Give this Machine a nickname.' : trimmed.length > 100 ? 'Use at most 100 characters.' : null;

  const rename = async (event: FormEvent) => {
    event.preventDefault();
    if (pending || nameProblem) return;
    setPending('rename');
    const [error, saved] = await safe(rpc.machines.update({ machineId: machine.id, nickname: trimmed }));
    setPending(null);
    if (error) return setMachineNotice('Saving the nickname failed. Please try again.');
    // The loader still holds the old nickname until it refreshes; the input already shows the new one.
    setName(saved.nickname);
    setChangedElsewhere(false);
    setMachineNotice('Nickname saved.');
    await router.invalidate();
  };
  const remove = async () => {
    if (pending) return;
    const discard = variablesDirty ? '\n\nYour unsaved Variable changes on this page will be discarded.' : '';
    const confirmed = window.confirm(
      `Delete ${machine.nickname}?\n\nIt stops syncing, and its registration, token, Variables and Variable history are permanently removed. ` +
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

  const dirtyName = trimmed !== machine.nickname;
  const nicknameInput = useRef<HTMLInputElement>(null);
  return (
    <div className="page">
      <Link className="back-link" to="/machines"><Icon name="back" size={14} />Machines</Link>
      <form className="nickname-form" onSubmit={rename}>
        <input ref={nicknameInput} className="nickname-input" aria-label="Nickname" value={name} onChange={(e) => setName(e.target.value)}
          maxLength={100} required aria-invalid={!!nameProblem} disabled={pending !== null} title="Rename this Machine" />
        {!dirtyName && pending === null ? (
          <button className="icon-button" type="button" aria-label="Rename" title="Rename"
            onClick={() => nicknameInput.current?.select()}>
            <Icon name="edit" />
          </button>
        ) : null}
        {dirtyName || pending === 'rename' ? (
          <>
            <button className="button small" type="submit" disabled={pending !== null || !!nameProblem || !dirtyName}>
              {pending === 'rename' ? 'Saving…' : 'Save nickname'}
            </button>
            {pending === null ? (
              <button className="button secondary small" type="button" onClick={() => setName(machine.nickname)}>Cancel</button>
            ) : null}
          </>
        ) : null}
      </form>
      <div style={{ display: 'grid', gap: 8, margin: '8px 0 32px' }}>
        {nameProblem && name ? <p className="field-issue">{nameProblem}</p> : null}
        {changedElsewhere && trimmed !== machine.nickname ? (
          <p className="callout warning">The saved nickname changed to “{machine.nickname}” while you were editing.</p>
        ) : null}
        {machineNotice ? <p className="status-line" data-tone={/failed/.test(machineNotice) ? 'error' : 'success'} role="status">{machineNotice}</p> : null}
      </div>

      <div className="machine-layout">
        <div>
          <VariablesEditor notice={notice} setNotice={setNotice} setDirty={setVariablesDirty} />
          <section className="section">
            <div className="section-head">
              <h2>Targets</h2>
              <p>Files this Machine writes the Template into</p>
            </div>
            {machine.targets.length ? (
              <ul className="target-list">
                {machine.targets.map((t) => (
                  <li key={t.path}>
                    <code>{t.path}</code>
                    <span className="agent-tag">for {t.agent}</span>
                    <CopyButton text={t.path} label={`Copy ${t.path}`} />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">No Targets. Run <code>agentsync init</code> on {machine.nickname} to detect its agents.</p>
            )}
          </section>
          <VariablesHistory setNotice={setNotice} />
        </div>

        <aside className="aside">
          <section>
            <h2>About this Machine</h2>
            <dl className="facts">
              <dt>System</dt><dd>{OS_NAMES[machine.os] ?? machine.os}</dd>
              <dt>Hostname</dt><dd><code>{machine.hostname}</code></dd>
              <dt>Registered</dt><dd><Ago date={machine.createdAt} /></dd>
              <dt>Last seen</dt><dd>{machine.lastSeenAt ? <Ago date={machine.lastSeenAt} /> : 'Never'}</dd>
            </dl>
          </section>
          <section>
            <h2>Run on {machine.nickname}</h2>
            <Command command="agentsync sync" note="Write the latest Template now, instead of at the next agent session." />
            <Command command="agentsync status" note="Show each file's state and any open Conflicts." />
            <Command command="agentsync vars" note={<>List this Machine's Variables. Add <code>--var NAME=value</code> to set one.</>} />
          </section>
          <section className="danger-zone">
            <h2>Delete Machine</h2>
            <p>It stops syncing right away. Its files stay as they are.</p>
            <button className="button danger small" type="button" onClick={remove} disabled={pending !== null}>
              {pending === 'delete' ? 'Deleting…' : 'Delete Machine'}
            </button>
          </section>
        </aside>
      </div>
    </div>
  );
}

type Row = { name: string; value: string };
const toRows = (map: VariableMap): Row[] => Object.entries(map).map(([name, value]) => ({ name, value }));
/** A row with neither a name nor a value is a blank one the user added, not a Variable yet. */
const isBlank = (row: Row) => !row.name.trim() && !row.value;
const toMap = (rows: Row[]): VariableMap =>
  Object.fromEntries(rows.filter((r) => !isBlank(r)).map((r) => [r.name.trim(), r.value]));
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
  const invalid = rows.some((row, i) => !isBlank(row) && problem(names[i]!, i));
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
        setNotice('Saving failed. Check your connection and try again.');
      }
    });
  };

  return (
    <section className="section" id="variables">
      <div className="section-head">
        <h2>Variables</h2>
        <p>
          Values for <code>{'{{name}}'}</code> in the Template on this Machine
          {draft.revision ? `, revision ${draft.revision}` : ''}
        </p>
      </div>
      {missing.length ? (
        <div className="callout warning">
          <Icon name="warning" />
          <div>
            <p>The Template uses {missing.length === 1 ? 'a Variable' : 'Variables'} this Machine doesn't set. Add {missing.length === 1 ? 'it' : 'them'}:</p>
            <div className="chips">
              {missing.map((name) => (
                <button key={name} className="chip" type="button" disabled={draft.busy}
                  onClick={() => setRows([...rows, { name, value: '' }])}>
                  <Icon name="plus" size={12} />{name}
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : null}
      {draft.newer ? (
        <div className="callout warning">
          <Icon name="warning" />
          <div>
            <p>Revision {draft.newer.revision} was saved while you were editing. Saving now would fail.</p>
            <p>
              <button className="link-button" type="button" disabled={draft.busy}
                onClick={() => draft.newer && window.confirm('Discard your edits?') && draft.load(draft.newer)}>
                Discard my edits and load revision {draft.newer.revision}
              </button>
            </p>
          </div>
        </div>
      ) : null}
      <form onSubmit={save}>
        <fieldset className="variables-table" disabled={draft.busy}>
          {rows.length ? (
            <div className="variable-row head" aria-hidden="true"><span>Name</span><span>Value</span></div>
          ) : (
            <p className="variables-empty">No Variables yet. Add one, then use it in the Template as <code>{'{{name}}'}</code>.</p>
          )}
          {rows.map((row, i) => {
            const issue = row.name || row.value ? problem(names[i], i) : null;
            return (
              <div className="variable-row" key={i}>
                <input
                  className="input" aria-label="Variable name" placeholder="name" value={row.name}
                  aria-invalid={!!issue} onChange={(e) => update(i, { name: e.target.value })}
                  spellCheck={false} autoCapitalize="off"
                />
                <textarea
                  className="textarea" aria-label={`Value of ${row.name || 'new Variable'}`} placeholder="value" value={row.value}
                  rows={Math.min(6, row.value.split('\n').length)} onChange={(e) => update(i, { value: e.target.value })} spellCheck={false}
                />
                <button className="icon-button" type="button" aria-label={`Remove ${row.name || 'this Variable'}`} title="Remove"
                  onClick={() => setRows(rows.filter((_, j) => j !== i))}>
                  <Icon name="close" />
                </button>
                {issue ? <p className="field-issue">{issue}</p> : null}
              </div>
            );
          })}
          <div className="variables-foot">
            <button className="button secondary small" type="button" onClick={() => setRows([...rows, { name: '', value: '' }])}>
              <Icon name="plus" size={14} />Add Variable
            </button>
            <span style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              {notice ? <span className="status-line" data-tone={/fail|changed elsewhere|Invalid/.test(notice) ? 'error' : 'success'} role="status">{notice}</span> : null}
              <button className="button small" type="submit" disabled={!draft.dirty || invalid}>
                {draft.busy ? 'Saving…' : 'Save Variables'}
              </button>
            </span>
          </div>
        </fieldset>
      </form>
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

  if (history.length === 0) return null;
  return (
    <section className="section">
      <div className="section-head">
        <h2>Variable history</h2>
        <p>Restoring saves an old revision as a new one</p>
      </div>
      <ul className="rows disclosure">
        {history.map((entry) => {
          const isCurrent = entry.revision === variables.revision;
          return (
            <li key={entry.revision}>
              <button className="disclosure-toggle" type="button" aria-expanded={open === entry.revision}
                onClick={() => setOpen(open === entry.revision ? null : entry.revision)}>
                <Icon name="chevron" />
                <strong>Revision {entry.revision}</strong>
                {isCurrent ? <span className="tag" style={{ marginLeft: 0 }}>Current</span> : null}
                <span><Ago date={entry.createdAt} /></span>
              </button>
              {open === entry.revision ? (
                <div className="disclosure-body">
                  {isCurrent ? <Diff before="" after={asText(entry.variables)} /> : (
                    <>
                      <p className="muted">Restoring it would make these changes:</p>
                      <Diff before={asText(variables.variables)} after={asText(entry.variables)} />
                      <button className="button secondary small" type="button" onClick={() => restore(entry.variables, entry.revision)}>
                        Restore revision {entry.revision}
                      </button>
                    </>
                  )}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
