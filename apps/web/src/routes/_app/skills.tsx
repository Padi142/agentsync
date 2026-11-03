import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { AddSkillDialog } from '../../components/AddSkillDialog';
import { CollectionDialog } from '../../components/CollectionDialog';
import { Icon } from '../../components/Icon';
import { SkillCollections } from '../../components/SkillCollections';
import { rpc } from '../../rpc';
import { useSkillActions } from '../../skill-actions';

export const Route = createFileRoute('/_app/skills')({
  loader: () => rpc.skills.overview(),
  component: SkillsPage,
});

function SkillsPage() {
  const overview = Route.useLoaderData();
  const actions = useSkillActions();
  const { run, busy, status } = actions;
  const [adding, setAdding] = useState(false);
  const [browsing, setBrowsing] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const hasAny = overview.skills.length > 0 || overview.found.length > 0 || overview.ignored.length > 0;
  const autoApprove = overview.settings.autoUpdate;

  return (
    <div className="page sk-page">
      <header className="page-head sk-page-head">
        <h1>Skills</h1>
        {hasAny ? <label className="sk-search"><Icon name="search" /><input type="search" aria-label="Search skills and repositories" placeholder="Find a skill or repo…" value={query} onChange={(event) => setQuery(event.target.value)} /></label> : null}
        <button type="button" className="button" onClick={() => setAdding(true)}><Icon name="plus" />Add skills</button>
      </header>
      <div className="sk-status" role="status">
        {status ? <span key={status.at} className="status-line" data-tone={status.tone}>{status.text}</span> : null}
      </div>
      {hasAny ? <SkillCollections overview={overview} actions={actions} query={query} onClearQuery={() => setQuery('')} onBrowse={setBrowsing} /> : (
        <div className="empty">
          <Icon name="collection" size={32} />
          <h2>Your skills, together</h2>
          <p>Find skills and sync them across your machines.</p>
          <button type="button" className="button" onClick={() => setAdding(true)}><Icon name="plus" />Add skills</button>
        </div>
      )}
      {overview.skills.length ? (
        <label className="sk-auto-approve">
          <input type="checkbox" role="switch" className="sk-switch" checked={autoApprove} disabled={!!busy}
            onChange={() => run('settings', () => rpc.skills.settings({ autoUpdate: !autoApprove }),
              () => autoApprove ? 'New versions wait for your approval.' : 'Safe updates are approved automatically. Machines install them on their next skills sync.')} />
          <span>
            <strong>Auto-approve safe updates</strong>
            <small>New versions all three scanners cleared are approved for you. Anything flagged waits here. Machines still install only when you run <code>agentsync skills sync</code>.</small>
          </span>
        </label>
      ) : null}
      <AddSkillDialog open={adding} onClose={() => setAdding(false)} taken={new Set(overview.skills.map((skill) => skill.name))} actions={actions}
        onCollection={(repo) => { setAdding(false); setBrowsing(repo); }} />
      <CollectionDialog repo={browsing} onClose={() => setBrowsing(null)} overview={overview} actions={actions} />
    </div>
  );
}
