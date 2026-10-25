import type { Machine } from '@agentsync/contract';
import { render, validate } from '@agentsync/template';
import { isDefinedError, safe } from '@orpc/client';
import { createFileRoute, Link, useBlocker, useRouter } from '@tanstack/react-router';
import { useState } from 'react';
import { CodeEditor, type LineMark } from '../../components/CodeEditor';
import { useDraft } from '../../draft';
import { rpc } from '../../rpc';

export const Route = createFileRoute('/_app/')({
  loader: async () => {
    const [template, machines] = await Promise.all([rpc.template.get(), rpc.machines.list()]);
    const variables = await Promise.all(machines.map((m) => rpc.variables.get({ machineId: m.id })));
    return { template, machines, variables: variables.map((v) => v.variables) };
  },
  component: TemplateEditor,
});

function TemplateEditor() {
  const { template, machines, variables } = Route.useLoaderData();
  const router = useRouter();
  const navigate = Route.useNavigate();
  // The draft saves against its own base revision, never the loader's, so a revision saved
  // elsewhere can't be overwritten by text that was never merged with it.
  const draft = useDraft({ revision: template.revision, value: template.text });
  const text = draft.value;
  const [notice, setNotice] = useState('');
  useBlocker({
    shouldBlockFn: () => draft.dirty && !window.confirm('Leave without saving your Template changes?'),
    enableBeforeUnload: () => draft.dirty,
  });

  const error = validate(text);
  const [machineIndex, setMachineIndex] = useState(0);
  const [pickedAgent, setAgent] = useState('');
  const machine = machines[machineIndex] as Machine | undefined;
  const agents = [...new Set(machine?.targets.map((t) => t.agent))];
  const agent = agents.includes(pickedAgent) ? pickedAgent : agents[0] ?? '';
  const preview = machine && !error
    ? render(text, {
        variables: variables[machineIndex],
        builtins: { machine: { name: machine.name, os: machine.os }, agent },
      })
    : null;

  const marks: LineMark[] = [
    ...(error ? [{ line: error.line, kind: 'error' as const, message: error.message }] : []),
    ...(preview?.warnings.map((w) => ({ line: w.line, kind: 'warning' as const, message: w.message })) ?? []),
  ];

  const save = () => draft.run(async (text, revision) => {
    setNotice('');
    const [failure, saved] = await safe(rpc.template.put({ text, expectedRevision: revision }));
    if (!failure) {
      draft.saved(saved.revision);
      setNotice(`Saved revision ${saved.revision}.`);
      await router.invalidate();
    } else if (isDefinedError(failure) && failure.code === 'CONFLICT') {
      // Someone saved first. Keep this edit as a Conflict and merge it on the resolver.
      const [error, conflict] = await safe(rpc.conflicts.create({ baseRevision: revision, text }));
      if (error) {
        setNotice('The Template changed since you opened it, and keeping your edit as a Conflict failed. Copy your text before reloading.');
        return;
      }
      // Editing was paused during the save, so the Conflict holds every edit and leaving is safe.
      await navigate({ to: '/conflicts/$conflictId', params: { conflictId: conflict.id }, ignoreBlocker: true });
    } else if (isDefinedError(failure) && failure.code === 'INVALID_TEMPLATE') {
      setNotice(failure.data.issues.map((i) => `Line ${i.line}: ${i.message}`).join(' '));
    } else {
      setNotice('Saving failed. Please try again.');
    }
  });

  return (
    <div className="split">
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h1>Template</h1>
            <p className="muted">
              {draft.revision ? `Revision ${draft.revision}` : 'Not saved yet'}
              {draft.dirty ? ' · unsaved changes' : ''}
            </p>
          </div>
          <button className="button" type="button" onClick={save} disabled={!draft.dirty || !!error || draft.busy}>
            {draft.busy ? 'Saving…' : 'Save'}
          </button>
        </div>
        {draft.newer ? (
          <p className="issue warning">
            Revision {draft.newer.revision} was saved while you were editing. Saving keeps your edit
            as a Conflict to merge.{' '}
            <button className="link-button" type="button" onClick={() => draft.newer && window.confirm('Discard your edits?') && draft.load(draft.newer)}>
              Discard my edits and load revision {draft.newer.revision}
            </button>
          </p>
        ) : null}
        <CodeEditor label="Template" value={text} onChange={draft.set} marks={marks} rows={24} readOnly={draft.busy} />
        {error ? (
          <p className="issue error" role="alert">Line {error.line}, column {error.column}: {error.message}</p>
        ) : null}
        {notice ? <p className="notice" role="status">{notice}</p> : null}
        <details className="help">
          <summary>Expression syntax</summary>
          <ul>
            <li><code>{'{{editor}}'}</code> a Machine Variable</li>
            <li><code>{'{{machine.name}}'}</code>, <code>{'{{machine.os}}'}</code>, <code>{'{{agent}}'}</code> Built-in Variables</li>
            <li><code>{'{{if agent == "codex"}} … {{else}} … {{end}}'}</code> a conditional (<code>!=</code> works too)</li>
            <li><code>{'\\{{'}</code> a literal <code>{'{{'}</code></li>
          </ul>
        </details>
      </section>

      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Preview</h2>
            <p className="muted">What a Machine writes to one Target</p>
          </div>
        </div>
        {machines.length === 0 ? (
          <p className="muted">
            No Machines yet. Register one with the AgentSync CLI to preview how it Renders.
          </p>
        ) : (
          <>
            <div className="controls">
              <label>
                Machine
                <select value={machineIndex} onChange={(e) => setMachineIndex(Number(e.target.value))}>
                  {machines.map((m, i) => <option key={m.id} value={i}>{m.name}</option>)}
                </select>
              </label>
              <label>
                Agent
                <select value={agent} onChange={(e) => setAgent(e.target.value)} disabled={!agents.length}>
                  {agents.map((a) => <option key={a} value={a}>{a}</option>)}
                </select>
              </label>
            </div>
            {error ? (
              <p className="muted">Fix the syntax error to see the preview.</p>
            ) : preview ? (
              <>
                {preview.warnings.length ? (
                  <ul className="issues">
                    {preview.warnings.map((w, i) => (
                      <li key={i} className="issue warning">
                        Line {w.line}: {w.message}.{' '}
                        <Link to="/machines/$machineId" params={{ machineId: machine!.id }}>Set it</Link>
                      </li>
                    ))}
                  </ul>
                ) : null}
                <pre className="rendered">{preview.text || <span className="muted">(empty)</span>}</pre>
              </>
            ) : null}
          </>
        )}
      </section>
    </div>
  );
}
