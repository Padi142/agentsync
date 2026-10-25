import { isDefinedError, safe } from '@orpc/client';
import { createFileRoute, Link, useRouter } from '@tanstack/react-router';
import { useState } from 'react';
import { z } from 'zod';
import { Diff } from '../../components/Diff';
import { TemplateBar } from '../../components/TemplateBar';
import { Ago } from '../../components/Time';
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
  const rollback = async () => {
    if (!revision) return;
    // History stays mounted while the selection changes. The router's latest location moves as
    // soon as a navigation starts, before its page loads, so it shows whether the user went
    // elsewhere while the rollback was running.
    const startedAt = router.latestLocation.href;
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
    if (router.latestLocation.href === startedAt) {
      await navigate({ to: '/history', search: { revision: saved.revision } });
    } else {
      await router.invalidate(); // Show the new revision in the list, but keep the selection.
    }
    setNotice(`Restored revision ${revision.revision} as revision ${saved.revision}.`);
  };

  if (!revision) {
    return (
      <>
        <TemplateBar />
        <div className="page">
          <div className="empty">
            <h2>No revisions yet</h2>
            <p>Each time the Template is saved, from here or from a Machine, a revision appears here. You can compare any two and roll back.</p>
            <Link className="button" to="/">Open the editor</Link>
          </div>
        </div>
      </>
    );
  }
  const isCurrent = revision.revision === template.revision;
  return (
    <>
      <TemplateBar />
      <div className="history-layout">
        <nav aria-label="Revisions">
          <ul className="revision-list">
            {history.map((entry) => (
              <li key={entry.revision}>
                <Link
                  to="/history"
                  search={{ revision: entry.revision }}
                  className={entry.revision === revision.revision ? 'revision-link active' : 'revision-link'}
                  onClick={() => setNotice('')}
                >
                  <strong>
                    Revision {entry.revision}
                    {entry.revision === template.revision ? <span className="tag">Current</span> : null}
                  </strong>
                  <span><Ago date={entry.createdAt} /></span>
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <section className="history-main" aria-label={`Revision ${revision.revision}`}>
          <div className="history-head">
            <div>
              <h2>Revision {revision.revision}</h2>
              <p>Saved {formatTime(revision.createdAt)}</p>
            </div>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <div className="segmented" role="group" aria-label="Compare">
                <button type="button" aria-pressed={compare === 'previous'} onClick={() => setCompare('previous')}>
                  What it changed
                </button>
                <button type="button" aria-pressed={compare === 'current'} onClick={() => setCompare('current')} disabled={isCurrent}>
                  Compared to current
                </button>
              </div>
              {isCurrent ? null : (
                <button className="button small" type="button" onClick={rollback}>Roll back to this revision</button>
              )}
            </div>
          </div>
          {notice ? (
            <p className={/failed|nothing was rolled back/.test(notice) ? 'callout error' : 'callout success'} role="status">{notice}</p>
          ) : null}
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
    </>
  );
}
