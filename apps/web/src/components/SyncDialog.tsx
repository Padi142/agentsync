import type { Audits } from '@agentsync/contract';
import { safe } from '@orpc/client';
import { useEffect, useRef, useState } from 'react';
import { rpc } from '../rpc';
import { addSkills, collectionMessage, progressText, readCollection, type SkillActions, type SyncProgress } from '../skill-actions';
import { riskyVerdicts, type GitHubFound } from '../skills';

/** Several Found Skills from one repository, about to be synced. */
export interface SyncRequest {
  repo: string;
  skills: GitHubFound[];
}

/** The `audits` call takes this many names at a time. */
const AUDIT_BATCH = 100;

async function auditsOf(repo: string, names: string[]) {
  const verdicts: { name: string; audits: Audits }[] = [];
  for (let offset = 0; offset < names.length; offset += AUDIT_BATCH) {
    verdicts.push(...await rpc.skills.audits({ repo, names: names.slice(offset, offset + AUDIT_BATCH) }));
  }
  return verdicts;
}

/**
 * What the repository offers now and what the audits say. A check that fails blocks nothing: the skills
 * count as ready, so a skill that really can't sync says so when it's tried.
 */
async function checkSync({ repo, skills }: SyncRequest) {
  const [[, collection], [auditError, verdicts]] = await Promise.all([
    safe(readCollection(repo)),
    safe(auditsOf(repo, skills.map((skill) => skill.name))),
  ]);
  const offered = collection && new Set(collection.names);
  const [ready, gone] = offered
    ? [skills.filter((skill) => offered.has(skill.name)), skills.filter((skill) => !offered.has(skill.name)).map((skill) => skill.name)]
    : [skills, []];
  const isReady = (name: string) => ready.some((skill) => skill.name === name);
  return { ready, gone, verdicts: auditError ? null : verdicts!.filter(({ name }) => isReady(name)) };
}

/**
 * Confirm a bulk sync, because it sends third-party code to every Machine. Found Skills show no audits
 * in the list, so this is where High or Critical verdicts come up, along with skills the repository no
 * longer has, which are left out. Reading the repository here also lets the sync itself reuse what was read.
 */
export function SyncDialog({ request, machineCount, actions, onClose }: {
  request: SyncRequest | null;
  machineCount: number;
  actions: SkillActions;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [check, setCheck] = useState<Awaited<ReturnType<typeof checkSync>> | null>(null);
  const [progress, setProgress] = useState<SyncProgress>({ done: 0, failed: 0 });
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    if (!request) { dialog.current?.close(); return; }
    dialog.current?.showModal();
    let live = true;
    setCheck(null);
    void checkSync(request).then((result) => { if (live) setCheck(result); });
    return () => { live = false; };
  }, [request]);

  const ready = check?.ready ?? request?.skills ?? [];
  const count = ready.length;
  const flagged = (check?.verdicts ?? []).flatMap(({ name, audits }) => {
    const risky = riskyVerdicts(audits);
    return risky.length ? [{ name, risky }] : [];
  });
  const unaudited = (check?.verdicts ?? []).filter(({ audits }) => !audits.gen && !audits.socket && !audits.snyk).length;

  const sync = async () => {
    setSyncing(true);
    setProgress({ done: 0, failed: 0 });
    // Keep the version the first Machine has, so nothing reinstalls there.
    await actions.run(`sync:${request?.repo}`, () => addSkills(ready.map((skill) => ({
      repo: skill.source, name: skill.name, machineId: skill.machines[0]?.machineId,
    })), setProgress), collectionMessage);
    setSyncing(false);
    onClose();
  };

  return (
    <dialog ref={dialog} className="sk-dialog" aria-label="Confirm sync" onClose={onClose}
      onCancel={(event) => { if (syncing) event.preventDefault(); }}
      onClick={(event) => !syncing && event.target === dialog.current && onClose()}>
      <div className="sk-sync-confirm">
        <h2>{count ? `Sync ${count} ${count === 1 ? 'skill' : 'skills'} to ${machineCount} ${machineCount === 1 ? 'machine' : 'machines'}?` : 'Nothing here can sync'}</h2>
        {count ? <p className="sk-note">Each machine installs {count === 1 ? 'it' : 'them'} on its next <code>agentsync skills sync</code>.</p> : null}
        {check === null ? <p className="sk-note" role="status">Checking this repo and its security audits…</p> : <>
          {check.gone.length ? <p className="sk-note">No longer installable from this repo: {check.gone.join(', ')}.</p> : null}
          {!count ? null : !check.verdicts ? <p className="status-line" data-tone="error" role="status">Couldn’t check security audits right now.</p>
            : flagged.length ? (
              <ul className="sk-flagged" aria-label="Skills with High or Critical audits">
                {flagged.map(({ name, risky }) => <li key={name}><strong>{name}</strong><span>{risky.join(', ')}</span></li>)}
              </ul>
            ) : <p className="sk-note" role="status">No High or Critical audit ratings.</p>}
          {unaudited ? <p className="sk-note">{unaudited} {unaudited === 1 ? 'has' : 'have'} no audit yet.</p> : null}
        </>}
        <div className="sk-sync-actions">
          <button type="button" className="button small secondary" disabled={syncing} onClick={onClose}>{check && !count ? 'Close' : 'Cancel'}</button>
          {check && !count ? null : <button type="button" className={`button small${flagged.length ? ' secondary' : ''}`} disabled={syncing || check === null || !!actions.busy} onClick={sync}>
            {syncing ? progressText(progress, count) : flagged.length ? 'Sync anyway' : `Sync ${count} ${count === 1 ? 'skill' : 'skills'}`}
          </button>}
        </div>
      </div>
    </dialog>
  );
}
