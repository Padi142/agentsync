import type { Machine } from '@agentsync/contract';
import { BUILTIN_VARIABLES, validate, type TemplateError } from '@agentsync/template';
import { isDefinedError, safe } from '@orpc/client';
import { createFileRoute, Link, useBlocker, useRouter } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { track } from '../../analytics';
import { CodeEditor, type EditorHandle, type LineMark } from '../../components/CodeEditor';
import { Command, CopyButton } from '../../components/Copy';
import { Icon } from '../../components/Icon';
import { InsertMenu, InsertPalette, insertables } from '../../components/Insert';
import { Select } from '../../components/Select';
import { Markdown, MarkedText } from '../../components/Markdown';
import { TemplateBar } from '../../components/TemplateBar';
import { Ago } from '../../components/Time';
import { installCommand } from '../../commands';
import { useDraft } from '../../draft';
import { useOwnNavigate } from '../../navigation';
import { renderMarked, type MarkedRender } from '../../preview';
import { rpc } from '../../rpc';
import { conditionValues, ownVariables } from '../../suggestions';

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
  const navigate = useOwnNavigate();
  // The draft saves against its own base revision, never the loader's, so a revision saved
  // elsewhere can't be overwritten by text that was never merged with it.
  const draft = useDraft({ revision: template.revision, value: template.text });
  const text = draft.value;
  const [notice, setNotice] = useState('');
  const [view, setView] = useState<'edit' | 'preview'>('edit');
  useBlocker({
    shouldBlockFn: () => draft.dirty && !window.confirm('Leave without saving your Template changes?'),
    enableBeforeUnload: () => draft.dirty,
  });

  const error = validate(text);
  const [machineId, setMachineId] = useState(machines[0]?.id ?? '');
  const [pickedAgent, setAgent] = useState('');
  const example = machines.length === 0;
  const index = Math.max(0, machines.findIndex((m) => m.id === machineId));
  const machine = machines[index] ?? EXAMPLE;
  const agents = [...new Set(machine.targets.map((t) => t.agent))];
  const agent = agents.includes(pickedAgent) ? pickedAgent : agents[0] ?? '';
  // While an Expression is half-typed, keep previewing the last text that parsed.
  const lastValid = useRef('');
  if (!error) lastValid.current = text;
  const result = renderMarked(error ? lastValid.current : text, {
    variables: example ? {} : variables[index] ?? {},
    builtins: { machine: { hostname: machine.hostname, nickname: machine.nickname, os: machine.os }, agent },
  });
  const warnings = example || error ? [] : result.warnings;
  const marks: LineMark[] = [
    ...(error ? [{ line: error.line, kind: 'error' as const, message: error.message }] : []),
    ...warnings.map((w) => ({ line: w.line, kind: 'warning' as const, message: w.message })),
  ];
  const canSave = draft.dirty && !error && !draft.busy;
  const own = ownVariables(variables, machines.length);
  const items = insertables(own);
  const editor = useRef<EditorHandle>(null);
  const values = conditionValues(machines, variables);
  const insert = ({ before, after }: { before: string; after?: string }) => editor.current?.wrap(before, after);

  const save = () => draft.run(async (text, revision) => {
    setNotice('');
    const [failure, saved] = await safe(rpc.template.put({ text, expectedRevision: revision }));
    if (!failure) {
      track('template_saved');
      draft.saved(saved.revision);
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
      setNotice('Saving failed. Check your connection and try again.');
    }
  });

  // Cmd/Ctrl+S saves, as in any editor.
  const saveRef = useRef(save);
  saveRef.current = canSave ? save : async () => undefined;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void saveRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <>
      <TemplateBar>
        <div className="segmented view-switch" role="group" aria-label="View">
          <button type="button" aria-pressed={view === 'edit'} onClick={() => setView('edit')}>Edit</button>
          <button type="button" aria-pressed={view === 'preview'} onClick={() => setView('preview')}>Preview</button>
        </div>
        <span className="save-state" role="status">
          {draft.busy ? 'Saving…' : draft.dirty ? (
            <><span className="dirty-dot" aria-hidden="true" /><span className="save-text">Unsaved changes</span></>
          ) : draft.revision ? (
            <span className="save-text">
              Revision {draft.revision}{template.updatedAt && draft.revision === template.revision ? <>, saved <Ago date={template.updatedAt} /></> : null}
            </span>
          ) : <span className="save-text">Not saved yet</span>}
        </span>
        <button className="button" type="button" onClick={save} disabled={!canSave}
          title={`Save (${navigator.platform?.startsWith('Mac') ? '⌘' : 'Ctrl+'}S)`}>
          Save
        </button>
      </TemplateBar>

      <div className="workspace" data-view={view}>
        <section className="workspace-main" aria-label="Edit">
          {draft.newer || notice ? (
            <div className="workspace-notices">
              {draft.newer ? (
                <div className="callout warning">
                  <Icon name="warning" />
                  <div>
                    <p>
                      Revision {draft.newer.revision} was saved somewhere else while you were editing. Saving keeps your
                      edit as a Conflict, so you can merge the two.
                    </p>
                    <p>
                      <button className="link-button" type="button" disabled={draft.busy}
                        onClick={() => draft.newer && window.confirm('Discard your edits?') && draft.load(draft.newer)}>
                        Discard my edits and load revision {draft.newer.revision}
                      </button>
                    </p>
                  </div>
                </div>
              ) : null}
              {notice ? <p className="callout error appear" role="alert">{notice}</p> : null}
            </div>
          ) : null}
          <CodeEditor ref={editor} label="Template" value={text} onChange={draft.set} marks={marks} readOnly={draft.busy}
            suggestions={[...BUILTIN_VARIABLES, ...own]} values={values}
            placeholder={'# Global instructions\n\nWrite what every agent should know. Type {{ for Variables.'}
            toolbar={<span>Type <code>{'{{'}</code> for Variables</span>}
            actions={<InsertMenu items={items} values={values} onInsert={insert} disabled={draft.busy} />} />
          {error ? (
            <p className="callout error" role="alert">Line {error.line}, column {error.column}: {error.message}</p>
          ) : null}
          <InsertPalette items={items} values={values} onInsert={insert} disabled={draft.busy} />
          <p className="example-note"><Link to="/docs/$page" params={{ page: 'templates' }}>Read the Template guide</Link></p>
        </section>

        <Preview machines={machines} machine={machine} example={example} onMachine={setMachineId}
          agents={agents} agent={agent} onAgent={setAgent} result={result} error={error}
          missing={[...new Set(warnings.map((w) => w.variable))]} />
      </div>
    </>
  );
}

/** Shown when there is no Machine yet, so the Template still previews. */
const EXAMPLE: Machine = {
  id: 'example', nickname: 'example-laptop', hostname: 'example-laptop', os: 'macos', createdAt: new Date(0), lastSeenAt: null,
  targets: [{ path: '~/.claude/CLAUDE.md', agent: 'claude' }, { path: '~/.codex/AGENTS.md', agent: 'codex' }],
};

function Preview({ machines, machine, example, onMachine, agents, agent, onAgent, result, error, missing }: {
  machines: Machine[];
  machine: Machine;
  example: boolean;
  onMachine: (id: string) => void;
  agents: string[];
  agent: string;
  onAgent: (agent: string) => void;
  result: MarkedRender;
  error: TemplateError | null;
  missing: string[];
}) {
  const [mode, setMode] = useState<'rendered' | 'text'>('rendered');
  const paths = machine.targets.filter((t) => t.agent === agent).map((t) => t.path);
  return (
    <section className="workspace-side" aria-label="Preview">
      <div className="preview-head">
        <div className="preview-picks">
          <span className="preview-label">Preview</span>
          {example ? (
            <span className="example-note">Example Machine</span>
          ) : (
            <Select label="Machine" value={machine.id} onChange={onMachine}
              options={machines.map((m) => ({ value: m.id, label: m.nickname, description: `${m.hostname}, ${m.os}` }))} />
          )}
          {agents.length > 1 ? (
            <div className="segmented" role="group" aria-label="Agent">
              {agents.map((a) => (
                <button key={a} type="button" aria-pressed={a === agent} onClick={() => onAgent(a)}>{a}</button>
              ))}
            </div>
          ) : agent ? <span className="example-note">for {agent}</span> : null}
        </div>
        <div className="preview-file">
          <code className="target-path" title={paths.join('\n')}>
            {paths[0] ? <TargetPath path={paths[0]} /> : 'No Target for this agent'}
            {paths.length > 1 ? <span className="muted"> +{paths.length - 1}</span> : null}
          </code>
          <div className="segmented" role="group" aria-label="Preview format">
            <button type="button" aria-pressed={mode === 'rendered'} onClick={() => setMode('rendered')}>Rendered</button>
            <button type="button" aria-pressed={mode === 'text'} onClick={() => setMode('text')}>Text</button>
          </div>
          <CopyButton text={result.text} label="Copy the Rendered file" />
        </div>
      </div>
      <div className="preview-body">
        {example ? (
          <div className="preview-warnings">
            <p className="example-note">
              Built-in Variables use example values here. <Link to="/setup">Add a Machine</Link> to preview its own.
            </p>
          </div>
        ) : null}
        {missing.length ? (
          <div className="preview-warnings">
            <div className="callout warning">
              <Icon name="warning" />
              <div>
                <p>
                  {machine.nickname} doesn't set {missing.map((name, i) => (
                    <span key={name}>{i ? ', ' : ''}<code>{name}</code></span>
                  ))}, so {missing.length === 1 ? 'it renders' : 'they render'} empty.{' '}
                  <Link to="/machines/$machineId" params={{ machineId: machine.id }} hash="variables">Set {missing.length === 1 ? 'it' : 'them'}</Link>
                </p>
              </div>
            </div>
          </div>
        ) : null}
        {error ? (
          <div className="preview-warnings">
            <p className="callout info">
              Showing the last version that parsed. Line {error.line}: {error.message}
            </p>
          </div>
        ) : null}
        {!result.text.trim() ? (
          <div className="preview-empty">
            <p>Nothing to preview yet. Write your instructions on the left; they show up here as {machine.nickname} gets them.</p>
            {example ? (
              <Command command={installCommand()} label="Install command"
                note="Already have instructions on a computer? Run this there: on your first Machine, its existing file becomes the Template." />
            ) : null}
          </div>
        ) : mode === 'rendered' ? (
          <Markdown ranges={result.ranges}>{result.text}</Markdown>
        ) : (
          <MarkedText text={result.text} ranges={result.ranges} />
        )}
      </div>
    </section>
  );
}

/** `~/.claude/CLAUDE.md` with the home part quieter than the file. */
function TargetPath({ path }: { path: string }) {
  const slash = path.lastIndexOf('/');
  return <><span className="home">{path.slice(0, slash + 1)}</span>{path.slice(slash + 1)}</>;
}
