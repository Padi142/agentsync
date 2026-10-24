import type { Machine } from '@agentsync/contract';
import { render, validate } from '@agentsync/template';
import { isDefinedError, safe } from '@orpc/client';
import { createFileRoute, Link, useBlocker, useRouter } from '@tanstack/react-router';
import { useState } from 'react';
import { CodeEditor, type LineMark } from '../../components/CodeEditor';
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
  const [text, setText] = useState(template.text);
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);
  const dirty = text !== template.text;
  useBlocker({
    shouldBlockFn: () => dirty && !window.confirm('Leave without saving your Template changes?'),
    enableBeforeUnload: () => dirty,
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

  const save = async () => {
    setSaving(true);
    setNotice('');
    const [failure, saved] = await safe(rpc.template.put({ text, expectedRevision: template.revision }));
    if (!failure) {
      await router.invalidate();
      setNotice(`Saved revision ${saved.revision}.`);
    } else if (isDefinedError(failure) && failure.code === 'CONFLICT') {
      // Someone saved first. Keep this edit as a Conflict and merge it on the resolver.
      const [error, conflict] = await safe(rpc.conflicts.create({ baseRevision: template.revision, text }));
      if (!error) {
        // The edit now lives in the Conflict, so leaving is safe.
        await navigate({ to: '/conflicts/$conflictId', params: { conflictId: conflict.id }, ignoreBlocker: true });
        return;
      }
      setNotice('The Template changed since you opened it, and keeping your edit as a Conflict failed. Copy your text before reloading.');
    } else if (isDefinedError(failure) && failure.code === 'INVALID_TEMPLATE') {
      setNotice(failure.data.issues.map((i) => `Line ${i.line}: ${i.message}`).join(' '));
    } else {
      setNotice('Saving failed. Please try again.');
    }
    setSaving(false);
  };

  return (
    <div className="split">
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h1>Template</h1>
            <p className="muted">
              {template.revision ? `Revision ${template.revision}` : 'Not saved yet'}
              {dirty ? ' · unsaved changes' : ''}
            </p>
          </div>
          <button className="button" type="button" onClick={save} disabled={!dirty || !!error || saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
        <CodeEditor label="Template" value={text} onChange={setText} marks={marks} rows={24} />
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
