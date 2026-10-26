import type { Template } from '@agentsync/contract';
import { hasConflictMarkers, suspectedConflictMarkers, validate, BUILTIN_VARIABLES } from '@agentsync/template';
import { isDefinedError, safe } from '@orpc/client';
import { createFileRoute, Link, useBlocker } from '@tanstack/react-router';
import { useRef, useState } from 'react';
import { CodeEditor, type EditorHandle, type LineMark } from '../../components/CodeEditor';
import { Command, CopyButton } from '../../components/Copy';
import { Icon } from '../../components/Icon';
import { InsertMenu, insertables } from '../../components/Insert';
import { TemplateBar } from '../../components/TemplateBar';
import { Ago } from '../../components/Time';
import { conflictHunks, pickSide, remerge, type ConflictHunk, type Side } from '../../conflict-text';
import { useDraft } from '../../draft';
import { useOwnNavigate } from '../../navigation';
import { rpc } from '../../rpc';
import { conditionValues } from '../../suggestions';

export const Route = createFileRoute('/_app/conflicts/$conflictId')({
  loader: async ({ params: { conflictId } }) => {
    const [conflict, template] = await Promise.all([rpc.conflicts.get({ conflictId }), rpc.template.get()]);
    return { conflict, template };
  },
  component: ConflictPage,
});

function ConflictPage() {
  const { conflict, template } = Route.useLoaderData();
  if (conflict.status !== 'open') {
    return (
      <>
        <TemplateBar />
        <div className="page">
          <div className="empty">
            <h2>This Conflict was {conflict.status}</h2>
            <p>
              It was {conflict.status}{conflict.closedAt ? <> <Ago date={conflict.closedAt} /></> : null}. The Template is
              at revision {template.revision}.
            </p>
            <p><Link to="/">Open the Template</Link> or see <Link to="/conflicts">other Conflicts</Link>.</p>
          </div>
        </div>
      </>
    );
  }
  return <Resolver key={conflict.id} />;
}

function Resolver() {
  const { conflict, template } = Route.useLoaderData();
  const navigate = useOwnNavigate();
  // The draft's revision is the Template revision this text is merged against. It moves on
  // when someone saves meanwhile. Unsaved means "differs from the Conflict's own text".
  const draft = useDraft({ revision: conflict.serverRevision, value: conflict.text });
  const editor = useRef<EditorHandle>(null);
  const text = draft.value;
  const [newer, setNewer] = useState<Template | null>(null);
  const [notice, setNotice] = useState('');
  const [closedElsewhere, setClosedElsewhere] = useState(false);
  useBlocker({
    shouldBlockFn: () => draft.dirty && !window.confirm('Leave without saving your merge?'),
    enableBeforeUnload: () => draft.dirty,
  });

  const hunks = conflictHunks(text);
  const markers = hasConflictMarkers(text);
  const error = validate(text);
  const suspected = suspectedConflictMarkers(text).filter((line) => !hunks.some((h) => inside(h, line)));
  const marks: LineMark[] = [
    ...hunks.flatMap((h) => [h.firstLine, h.firstLine + h.current.lines.length + 1, h.lastLine]
      .map((line) => ({ line, kind: 'error' as const, message: 'Conflict marker' }))),
    ...text.split('\n').flatMap((line, i) => hasConflictMarkers(line) && !hunks.some((h) => inside(h, i + 1))
      ? [{ line: i + 1, kind: 'error' as const, message: 'Conflict marker' }] : []),
    ...(error ? [{ line: error.line, kind: 'error' as const, message: error.message }] : []),
    ...suspected.map((line) => ({ line, kind: 'warning' as const, message: 'Possibly a leftover separator' })),
  ];
  const noMarkers = conflictHunks(conflict.text).length === 0 && !hasConflictMarkers(conflict.text);
  const moved = !newer && template.revision !== conflict.serverRevision;

  // Editing is paused while these run, so the text they send is the text on screen.
  const resolve = () => draft.run(async (text, mergedAgainst) => {
    setNotice('');
    const [failure, result] = await safe(rpc.conflicts.resolve({
      conflictId: conflict.id, text, expectedRevision: mergedAgainst,
    }));
    if (!failure) {
      await navigate({ to: '/history', search: { revision: result.template.revision }, ignoreBlocker: true });
    } else if (isDefinedError(failure) && failure.code === 'CONFLICT') {
      // Someone saved again while this was being merged: merge this resolution into the newer Template.
      const [error, fetched] = await safe(Promise.all([
        rpc.template.revision({ revision: mergedAgainst }),
        rpc.template.get(),
      ]));
      if (error) return setNotice('The Template changed meanwhile, and loading the newer revision failed. Please try again.');
      const [base, latest] = fetched;
      draft.rebase(latest.revision, remerge(base, latest, text));
      setNewer(latest);
      setNotice(`Template revision ${latest.revision} was saved while you were merging. Its changes are merged in below; lines you both changed are marked again.`);
    } else if (isDefinedError(failure) && failure.code === 'INVALID_TEMPLATE') {
      setNotice(failure.data.issues.map((i) => `Line ${i.line}: ${i.message}`).join(' '));
    } else if (isDefinedError(failure) && failure.code === 'NOT_FOUND') {
      setClosedElsewhere(true);
    } else {
      setNotice('Saving failed. Please try again.');
    }
  });

  const discard = () => {
    if (!window.confirm('Discard this edit? The Template stays as it is.')) return;
    return draft.run(async () => {
      const [error] = await safe(rpc.conflicts.discard({ conflictId: conflict.id }));
      if (isDefinedError(error) && error.code === 'NOT_FOUND') return setClosedElsewhere(true);
      if (error) return setNotice('Discarding failed. Please try again.');
      await navigate({ to: '/conflicts', ignoreBlocker: true });
    });
  };

  const blocked = markers || !!error || closedElsewhere;
  return (
    <>
      <TemplateBar>
        <button className="button secondary" type="button" onClick={discard} disabled={draft.busy || closedElsewhere}>
          Discard edit
        </button>
        <button className="button" type="button" onClick={resolve} disabled={blocked || draft.busy}>
          {draft.busy ? 'Saving…' : 'Save and resolve'}
        </button>
      </TemplateBar>
      <div className="workspace">
        <section className="workspace-main" aria-label="Merge">
          <div className="resolver-head">
            <div>
              <h1>Resolve Conflict</h1>
              <p>
                This edit started from {conflict.baseRevision ? `revision ${conflict.baseRevision}` : 'an empty Template'}, but
                revision {conflict.serverRevision} was saved first. Kept <Ago date={conflict.createdAt} />.
                Saving makes the merged text below the next Template revision.
              </p>
            </div>
          </div>
          {closedElsewhere ? (
            <div className="callout error appear" role="alert">
              <Icon name="warning" />
              <div>
                <p>
                  This Conflict was resolved or discarded somewhere else, so your merge was not saved. Copy it and apply it
                  in the <Link to="/">Template editor</Link> if you still need it.
                </p>
                <p><CopyButton text={text} label="Copy merge" className="button secondary small">Copy merge</CopyButton></p>
              </div>
            </div>
          ) : null}
          {noMarkers && !newer ? (
            <p className="callout info">
              The two edits changed different lines, so they were merged automatically. Nothing is saved yet: check the
              merged Template below, then save it to resolve this Conflict.
            </p>
          ) : null}
          {moved ? (
            <p className="callout warning">
              The Template has moved on to revision {template.revision} since this Conflict was kept. When you save, those
              newer changes are merged in, and any lines you both changed are marked for you.
            </p>
          ) : null}
          {notice ? <p className="callout warning" role="status">{notice}</p> : null}
          <CodeEditor ref={editor} label="Merged Template" value={text} onChange={draft.set} marks={marks} readOnly={draft.busy}
            suggestions={BUILTIN_VARIABLES} values={VALUES} toolbar={<span>Merged Template</span>}
            actions={<InsertMenu items={INSERTABLES} disabled={draft.busy} onInsert={(item) => editor.current?.wrap(item.before, item.after)} />} />
          {markers || error || suspected.length ? (
            <ul className="issues">
              {markers ? <li className="callout error">Remove every Conflict marker (<code>{'<<<<<<<'}</code>, <code>=======</code>, <code>{'>>>>>>>'}</code>) before saving.</li> : null}
              {error ? <li className="callout error">Line {error.line}, column {error.column}: {error.message}</li> : null}
              {suspected.map((line) => (
                <li key={line} className="callout warning">
                  Line {line} is exactly <code>=======</code>. If it's a leftover Conflict separator, remove it. If it
                  underlines a Markdown heading, you can save as is.
                </li>
              ))}
            </ul>
          ) : null}
        </section>

        <section className="workspace-side" aria-label="Unresolved regions">
          <div className="preview-body resolver">
            {hunks.length ? (
              <div className="hunks">
                <h2>{hunks.length} unresolved {hunks.length === 1 ? 'region' : 'regions'}</h2>
                <p className="muted">Both edits changed these lines. Pick a side, or edit the text on the left.</p>
                {hunks.map((hunk) => (
                  <Hunk key={hunk.firstLine} hunk={hunk} disabled={draft.busy}
                    onPick={(side) => draft.set(pickSide(text, hunk, side))} />
                ))}
              </div>
            ) : (
              <div className="preview-empty">
                <h2 style={{ color: 'var(--ink)' }}>Nothing left to pick</h2>
                <p>{blocked ? 'Fix the issues listed under the editor, then save.' : 'Check the merged Template, then save and resolve.'}</p>
              </div>
            )}
            {newer ? (
              <details className="syntax">
                <summary>Show Template revision {newer.revision}</summary>
                <pre className="rendered-text" style={{ marginTop: 12 }}>{newer.text}</pre>
              </details>
            ) : null}
            <div className="resolver-alt">
              <h2>Prefer your terminal?</h2>
              <p>Fetch the marked text, merge it in your editor, then resolve it from the file:</p>
              <Command command={`agentsync conflict get ${conflict.id} --out merge.md`} label="Get command" />
              <Command command={`agentsync conflict resolve ${conflict.id} merge.md`} label="Resolve command" />
            </div>
          </div>
        </section>
      </div>
    </>
  );
}

function Hunk({ hunk, onPick, disabled }: { hunk: ConflictHunk; onPick: (side: Side) => void; disabled: boolean }) {
  return (
    <div className="hunk">
      <div className="hunk-head">
        <span>Lines {hunk.firstLine}–{hunk.lastLine}</span>
        <button className="button secondary small" type="button" onClick={() => onPick('both')} disabled={disabled}>
          Use both, current first
        </button>
      </div>
      <div className="hunk-sides">
        {(['current', 'edit'] as const).map((side) => (
          <div key={side} className={`hunk-side ${side}`}>
            <div className="hunk-label">{hunk[side].label}</div>
            <pre>{hunk[side].lines.join('\n') || <span className="muted">(no lines)</span>}</pre>
            <button className="button secondary small" type="button" onClick={() => onPick(side)} disabled={disabled}>
              Use this
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

const INSERTABLES = insertables();
const VALUES = conditionValues([]);

const inside = (hunk: ConflictHunk, line: number) => line >= hunk.firstLine && line <= hunk.lastLine;
