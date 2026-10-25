import { isDefinedError, safe } from '@orpc/client';
import { createFileRoute, Link, useRouter } from '@tanstack/react-router';
import { useRef, useState } from 'react';
import { z } from 'zod';
import { Diff } from '../../components/Diff';
import { formatTime } from '../../format';
import { useOwnNavigate } from '../../navigation';
import { rpc } from '../../rpc';

export const Route = createFileRoute('/_app/history')({
  validateSearch: z.object({ revision: z.number().int().min(1).optional() }),
  loaderDeps: ({ search }) => ({ revision: search.revision }),
  loader: async ({ deps }) => {
    const [template, history] = await Promise.all([rpc.template.get(), rpc.template.history()]);
    const selected = deps.revision ?? history[0]?.revision;
    // The selected revision and the one before it, to show what it changed.
    const [revision, previous] = selected
      ? await Promise.all([
          rpc.template.revision({ revision: selected }),
          selected > 1 ? rpc.template.revision({ revision: selected - 1 }) : null,
        ])
      : [null, null];
    return { template, history, revision, previous };
  },
  component: History,
});

function History() {
  const { template, history, revision, previous } = Route.useLoaderData();
  const router = useRouter();
  const navigate = useOwnNavigate();
  const [compare, setCompare] = useState<'previous' | 'current'>('previous');
  const [notice, setNotice] = useState('');
  // History stays mounted while the selection changes, so a rollback that finishes late
  // checks that its revision is still the one on screen before showing the result.
  const selected = useRef(revision?.revision);
  selected.current = revision?.revision;

  const rollback = async () => {
    if (!revision) return;
    const [error, saved] = await safe(rpc.template.rollback({
      revision: revision.revision, expectedRevision: template.revision,
    }));
    if (error) {
      setNotice(isDefinedError(error) && error.code === 'CONFLICT'
        ? 'The Template changed meanwhile, so nothing was rolled back. Check the newest revision and try again.'
        : 'Rolling back failed. Please try again.');
      await router.invalidate();
      return;
    }
    if (selected.current === revision.revision) {
      await navigate({ to: '/history', search: { revision: saved.revision } });
    } else {
      await router.invalidate(); // Show the new revision in the list, but keep the selection.
    }
    setNotice(`Restored revision ${revision.revision} as revision ${saved.revision}.`);
  };

  if (!revision) {
    return <section className="panel"><h1>History</h1><p className="muted">The Template has no revisions yet.</p></section>;
  }
  const isCurrent = revision.revision === template.revision;
  return (
    <div className="split narrow-left">
      <section className="panel">
        <h1>History</h1>
        <p className="muted">Template revisions, newest first</p>
        <ul className="revision-list">
          {history.map((entry) => (
            <li key={entry.revision}>
              <Link
                to="/history"
                search={{ revision: entry.revision }}
                className={entry.revision === revision.revision ? 'revision-link active' : 'revision-link'}
                onClick={() => setNotice('')}
              >
                <span>Revision {entry.revision}{entry.revision === template.revision ? ' · current' : ''}</span>
                <span className="muted">{formatTime(entry.createdAt)}</span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Revision {revision.revision}</h2>
            <p className="muted">Saved {formatTime(revision.createdAt)}</p>
          </div>
          {isCurrent ? null : (
            <button className="button" type="button" onClick={rollback}>Roll back to this revision</button>
          )}
        </div>
        <div className="segmented" role="group" aria-label="Compare">
          <button type="button" aria-pressed={compare === 'previous'} onClick={() => setCompare('previous')}>
            What it changed
          </button>
          <button type="button" aria-pressed={compare === 'current'} onClick={() => setCompare('current')} disabled={isCurrent}>
            Compared to current
          </button>
        </div>
        {notice ? <p className="notice" role="status">{notice}</p> : null}
        {compare === 'current' && !isCurrent ? (
          <>
            <p className="muted">Rolling back would make these changes to revision {template.revision}:</p>
            <Diff before={template.text} after={revision.text} />
          </>
        ) : (
          <Diff before={previous?.text ?? ''} after={revision.text} />
        )}
      </section>
    </div>
  );
}
