import type { Audits } from '@agentsync/contract';
import { safe } from '@orpc/client';
import { useEffect, useRef, useState } from 'react';
import { rpc } from '../rpc';
import { addSkills, collectionMessage, type SkillActions } from '../skill-actions';
import { riskyVerdicts, type GitHubFound } from '../skills';

/** Several Found Skills from one repository, about to be synced. */
export interface SyncRequest {
  repo: string;
  skills: GitHubFound[];
}

/** The `audits` call takes this many names at a time. */
const AUDIT_BATCH = 100;

async function auditsOf({ repo, skills }: SyncRequest) {
  const verdicts: { name: string; audits: Audits }[] = [];
  for (let offset = 0; offset < skills.length; offset += AUDIT_BATCH) {
    const names = skills.slice(offset, offset + AUDIT_BATCH).map((skill) => skill.name);
    verdicts.push(...await rpc.skills.audits({ repo, names }));
  }
  return verdicts;
}

/**
 * Confirm a bulk sync, because it sends third-party code to every Machine. Found Skills show no audits
 * in the list, so this is where High or Critical verdicts come up. A failed audit check is said, not a block.
 */
export function SyncDialog({ request, machineCount, actions, onClose }: {
  request: SyncRequest | null;
  machineCount: number;
  actions: SkillActions;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [verdicts, setVerdicts] = useState<Awaited<ReturnType<typeof auditsOf>> | 'failed' | null>(null);
  const [progress, setProgress] = useState(0);
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    if (!request) { dialog.current?.close(); return; }
    dialog.current?.showModal();
    let live = true;
    setVerdicts(null);
    void safe(auditsOf(request)).then(([error, found]) => live && setVerdicts(error ? 'failed' : found));
    return () => { live = false; };
  }, [request]);

  const count = request?.skills.length ?? 0;
  const flagged = Array.isArray(verdicts) ? verdicts.flatMap(({ name, audits }) => {
    const risky = riskyVerdicts(audits);
    return risky.length ? [{ name, risky }] : [];
  }) : [];
  const unaudited = Array.isArray(verdicts) ? verdicts.filter(({ audits }) => !audits.gen && !audits.socket && !audits.snyk).length : 0;

  const sync = async () => {
    if (!request) return;
    setSyncing(true);
    setProgress(0);
    // Each add has its own Worker budget. Keep the version the first Machine has, so nothing reinstalls there.
    await actions.run(`sync:${request.repo}`, () => addSkills(request.skills.map((skill) => ({
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
        <h2>Sync {count} skills to {machineCount} {machineCount === 1 ? 'machine' : 'machines'}?</h2>
        <p className="sk-note">Each machine installs them on its next <code>agentsync skills sync</code>.</p>
        {verdicts === null ? <p className="sk-note" role="status">Checking security audits…</p>
          : verdicts === 'failed' ? <p className="status-line" data-tone="error" role="status">Couldn’t check security audits right now.</p>
            : flagged.length ? (
              <ul className="sk-flagged" aria-label="Skills with High or Critical audits">
                {flagged.map(({ name, risky }) => <li key={name}><strong>{name}</strong><span>{risky.join(', ')}</span></li>)}
              </ul>
            ) : <p className="sk-note" role="status">No High or Critical audit ratings.</p>}
        {unaudited ? <p className="sk-note">{unaudited} {unaudited === 1 ? 'has' : 'have'} no audit yet.</p> : null}
        <div className="sk-sync-actions">
          <button type="button" className="button small secondary" disabled={syncing} onClick={onClose}>Cancel</button>
          <button type="button" className={`button small${flagged.length ? ' secondary' : ''}`} disabled={syncing || verdicts === null || !!actions.busy} onClick={sync}>
            {syncing ? `Syncing ${progress} of ${count}…` : flagged.length ? 'Sync anyway' : `Sync ${count} skills`}
          </button>
        </div>
      </div>
    </dialog>
  );
}
