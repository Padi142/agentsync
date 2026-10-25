import type { Template } from '@agentsync/contract';
import { hasConflictMarkers, suspectedConflictMarkers, validate } from '@agentsync/template';
import { isDefinedError, safe } from '@orpc/client';
import { createFileRoute, Link, useBlocker } from '@tanstack/react-router';
import { useState } from 'react';
import { CodeEditor, type LineMark } from '../../components/CodeEditor';
import { conflictHunks, pickSide, remerge, type ConflictHunk, type Side } from '../../conflict-text';
import { copyText } from '../../copy';
import { useDraft } from '../../draft';
import { formatTime } from '../../format';
import { useOwnNavigate } from '../../navigation';
import { rpc } from '../../rpc';

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
      <section className="panel">
        <h1>Conflict {conflict.status}</h1>
        <p className="muted">
          This Conflict was {conflict.status}
          {conflict.closedAt ? ` on ${formatTime(conflict.closedAt)}` : ''}. The Template is at revision {template.revision}.
        </p>
        <p><Link to="/">Open the Template</Link> · <Link to="/conflicts">Other Conflicts</Link></p>
      </section>
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
  const text = draft.value;
  const [newer, setNewer] = useState<Template | null>(null);
  const [notice, setNotice] = useState('');
  const [closedElsewhere, setClosedElsewhere] = useState(false);
  const [copied, setCopied] = useState(false);
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

  const copy = async () => setCopied(await copyText(text));

  const blocked = markers || !!error || closedElsewhere;
  return (
    <div className="stack">
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h1>Resolve Conflict</h1>
            <p className="muted">
              An edit that started from {conflict.baseRevision ? `revision ${conflict.baseRevision}` : 'an empty Template'} lost
              to revision {conflict.serverRevision}, saved first. Created {formatTime(conflict.createdAt)}.
            </p>
          </div>
          <button className="button secondary" type="button" onClick={discard} disabled={draft.busy || closedElsewhere}>
            Discard edit
          </button>
        </div>
        {closedElsewhere ? (
          <p className="issue error" role="alert">
            This Conflict was resolved or discarded elsewhere, so your merge was not saved. It is still below: copy
            it and apply it in the <Link to="/">Template editor</Link> if you need it.{' '}
            <button className="link-button" type="button" onClick={copy}>{copied ? 'Copied' : 'Copy merge'}</button>
          </p>
        ) : null}
        {noMarkers && !newer ? (
          <p className="issue warning">
            No unresolved regions: the two edits changed different lines, so they were merged automatically.
            Nothing is saved yet. Check the merged Template below, then save it to resolve this Conflict.
          </p>
        ) : null}
        {moved ? (
          <p className="issue warning">
            The Template has moved on to revision {template.revision} since this Conflict was created. When you save,
            those newer changes are merged in and any lines you both changed are marked for you.
          </p>
        ) : null}
        {notice ? <p className="notice" role="status">{notice}</p> : null}
        {newer ? (
          <details className="help">
            <summary>Show Template revision {newer.revision}</summary>
            <pre className="rendered">{newer.text}</pre>
          </details>
        ) : null}
      </section>

      {hunks.length ? (
        <section className="panel">
          <h2>{hunks.length} unresolved {hunks.length === 1 ? 'region' : 'regions'} left</h2>
          <p className="muted">Both edits changed these lines. Pick a side, or edit the text below.</p>
          {hunks.map((hunk) => (
            <Hunk key={hunk.firstLine} hunk={hunk} disabled={draft.busy}
              onPick={(side) => draft.set(pickSide(text, hunk, side))} />
          ))}
        </section>
      ) : null}

      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Merged Template</h2>
            <p className="muted">Saving makes this the next Template revision</p>
          </div>
          <button className="button" type="button" onClick={resolve} disabled={blocked || draft.busy}>
            {draft.busy ? 'Saving…' : 'Save and resolve'}
          </button>
        </div>
        <CodeEditor label="Merged Template" value={text} onChange={draft.set} marks={marks} rows={24} readOnly={draft.busy} />
        <ul className="issues">
          {markers ? <li className="issue error">Remove every Conflict marker (<code>{'<<<<<<<'}</code>, <code>=======</code>, <code>{'>>>>>>>'}</code>) before saving.</li> : null}
          {error ? <li className="issue error">Line {error.line}, column {error.column}: {error.message}</li> : null}
          {suspected.map((line) => (
            <li key={line} className="issue warning">
              Line {line} is exactly <code>=======</code>. If it's a leftover Conflict separator, remove it. If it
              underlines a Markdown heading, you can save as is.
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function Hunk({ hunk, onPick, disabled }: { hunk: ConflictHunk; onPick: (side: Side) => void; disabled: boolean }) {
  return (
    <div className="hunk">
      <p className="muted">Lines {hunk.firstLine}–{hunk.lastLine}</p>
      <div className="hunk-sides">
        {(['current', 'edit'] as const).map((side) => (
          <div key={side} className={`hunk-side ${side}`}>
            <div className="hunk-label">{hunk[side].label}</div>
            <pre>{hunk[side].lines.join('\n') || <span className="muted">(no lines)</span>}</pre>
            <button className="button secondary" type="button" onClick={() => onPick(side)} disabled={disabled}>
              Use this
            </button>
          </div>
        ))}
      </div>
      <button className="link-button" type="button" onClick={() => onPick('both')} disabled={disabled}>Use both, current first</button>
    </div>
  );
}

const inside = (hunk: ConflictHunk, line: number) => line >= hunk.firstLine && line <= hunk.lastLine;
