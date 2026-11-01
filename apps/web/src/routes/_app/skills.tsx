import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { AddSkillDialog } from '../../components/AddSkillDialog';
import { CollectionDialog } from '../../components/CollectionDialog';
import { Icon } from '../../components/Icon';
import { SkillCollections } from '../../components/SkillCollections';
import { rpc } from '../../rpc';
import { useSkillActions } from '../../skill-actions';
import { collectionsOf } from '../../skills';

export const Route = createFileRoute('/_app/skills')({
  loader: () => rpc.skills.overview(),
  component: SkillsPage,
});

function SkillsPage() {
  const overview = Route.useLoaderData();
  const actions = useSkillActions();
  const { run, busy, status } = actions;
  const [adding, setAdding] = useState(false);
  const [collection, setCollection] = useState<string | null>(null);
  const collections = collectionsOf(overview);
  const updates = overview.skills.filter((skill) => skill.update).length;
  const local = overview.found.flatMap((found) => found.kind === 'local' ? [found] : []);
  const nickname = (id: string) => overview.machines.find((machine) => machine.id === id)?.nickname ?? 'a Machine';

  return (
    <div className="page sk-page">
      <header className="page-head sk-page-head">
        <div className="sk-heading"><h1>Skills</h1><span>{collections.length} collections</span></div>
        <div className="sk-head-end">
          <div className="sk-update-control">
            <span className="muted">Updates</span>
            <div className="segmented" role="group" aria-label="Updates">
              {([false, true] as const).map((automatic) => (
                <button key={String(automatic)} type="button" aria-pressed={overview.settings.autoUpdate === automatic} disabled={!!busy}
                  onClick={() => overview.settings.autoUpdate !== automatic && run('settings', () => rpc.skills.settings({ autoUpdate: automatic }),
                    () => automatic ? 'Automatic updates on. Audited versions rated below High install from the next daily check.' : 'Updates are manual')}>
                  {automatic ? 'Automatic' : 'Manual'}
                </button>
              ))}
            </div>
          </div>
          {updates >= 2 ? <button type="button" className="button secondary" disabled={!!busy}
            onClick={() => run('update-all', () => rpc.skills.updateAll(), ({ updated }) => `${updated} skills updated`)}>Update all</button> : null}
          <button type="button" className="button" onClick={() => setAdding(true)}><Icon name="plus" />Add skills</button>
        </div>
      </header>
      <div className="sk-status" role="status">
        {status ? <span key={status.at} className="status-line" data-tone={status.tone}>{status.text}</span> : null}
      </div>
      {collections.length ? <SkillCollections overview={overview} actions={actions} onAddCollection={setCollection} /> : (
        <div className="empty">
          <Icon name="collection" size={32} />
          <h2>Your skills, together</h2>
          <p>Add a collection or pick individual skills. Sync them across your machines.</p>
          <button type="button" className="button" onClick={() => setAdding(true)}><Icon name="plus" />Add skills</button>
        </div>
      )}
      {local.length ? <p className="sk-note sk-local">Local skills:{' '}
        {local.map((found, i) => <span key={found.name}>{i ? ', ' : ''}<code>{found.name}</code> ({found.machineIds.map(nickname).join(', ')})</span>)}
      </p> : null}
      <AddSkillDialog open={adding} onClose={() => setAdding(false)} taken={new Set(overview.skills.map((skill) => skill.name))} actions={actions}
        onCollection={(repo) => { setAdding(false); setCollection(repo); }} />
      <CollectionDialog repo={collection} onClose={() => setCollection(null)} overview={overview} actions={actions} />
    </div>
  );
}
