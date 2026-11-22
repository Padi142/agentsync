import type { ProposedSkill, SkillAssignment, SkillRequest, SkillsOverview } from '@agentsync/contract';
import { safe } from '@orpc/client';
import { useEffect, useRef, useState } from 'react';
import { rpc } from '../rpc';
import type { SkillActions } from '../skill-actions';
import { riskyVerdicts, shortCommit } from '../skills';
import { Icon } from './Icon';
import { Verdicts } from './SkillDetail';
import { Ago } from './Time';

const unaudited = ({ audits }: ProposedSkill) => !audits.gen && !audits.socket && !audits.snyk;

/** Ticked to begin with: what can be approved, audited, and rated below High by every scanner. */
const startsTicked = (skill: ProposedSkill) => !skill.conflict && !unaudited(skill) && !riskyVerdicts(skill.audits).length;

/** Why a proposed skill isn't ticked, or can't be. */
function note(skill: ProposedSkill) {
  if (skill.conflict === 'added') return 'Already added';
  if (skill.conflict === 'taken') return 'Name in use';
  if (unaudited(skill)) return 'Not audited';
  return '';
}

const DECIDED = { approved: 'This request was approved.', rejected: 'This request was rejected.', expired: 'This request expired.' } as const;

/**
 * Review a Machine's Skill Request: which Machine asked and when, each proposed skill with its commit
 * and audits, which to add and where. Approving adds exactly the versions shown, even if the repository
 * moved on since; the waiting `skills add` then installs them on the Machine that asked.
 */
export function RequestDialog({ requestId, overview, actions, onClose }: {
  requestId: string | null;
  overview: SkillsOverview;
  actions: SkillActions;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [request, setRequest] = useState<SkillRequest | 'missing' | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [assignment, setAssignment] = useState<SkillAssignment>({ to: 'all' });

  useEffect(() => {
    if (!requestId) { dialog.current?.close(); return; }
    dialog.current?.showModal();
    let live = true;
    setRequest(null);
    void safe(rpc.skills.getRequest({ requestId })).then(([error, found]) => {
      if (!live) return;
      if (error) return setRequest('missing');
      setRequest(found);
      setSelected(new Set(found.skills.filter(startsTicked).map((skill) => skill.name)));
      setAssignment({ to: 'all' });
    });
    return () => { live = false; };
  }, [requestId]);

  const busy = !!actions.busy;
  const open = request && request !== 'missing' && request.status === 'open' ? request : null;
  const picked = open?.skills.filter((skill) => selected.has(skill.name)) ?? [];
  const chosen = assignment.to === 'chosen' ? assignment.machineIds : [];
  const toggle = (name: string) => setSelected((current) => {
    const next = new Set(current);
    if (next.has(name)) next.delete(name); else next.add(name);
    return next;
  });

  const decide = async (approve: boolean) => {
    if (!open) return;
    const ok = await actions.run(`request:${open.id}`,
      () => approve
        ? rpc.skills.approveRequest({ requestId: open.id, names: picked.map((skill) => skill.name), assignment })
        : rpc.skills.rejectRequest({ requestId: open.id }),
      (decided) => decided.status === 'approved'
        ? `${decided.added.length} ${decided.added.length === 1 ? 'skill' : 'skills'} added. ${open.machine.nickname} installs ${decided.added.length === 1 ? 'it' : 'them'} now if it’s still waiting.`
        : `Request from ${open.machine.nickname} rejected.`);
    if (ok) onClose();
  };

  return <dialog ref={dialog} className="sk-dialog sk-collection-dialog" aria-label="Skill Request" onClose={onClose}
    onCancel={(event) => { if (busy) event.preventDefault(); }} onClick={(event) => !busy && event.target === dialog.current && onClose()}>
    <div className="sk-dialog-head"><Icon name="collection" size={20} />
      <strong>{request && request !== 'missing' ? request.repo.fullName : 'Skill Request'}</strong>
      <button type="button" className="icon-button" aria-label="Close request" disabled={busy} onClick={onClose}><Icon name="close" /></button>
    </div>
    {request === null ? <div className="sk-collection-loading" role="status">Loading…</div>
      : request === 'missing' ? <p className="sk-collection-loading">This request is no longer open.</p>
        : request.status !== 'open' ? <p className="sk-collection-loading">{DECIDED[request.status]}</p> : <>
          <div className="sk-dialog-selection"><span><strong>{request.machine.nickname}</strong> asked <Ago date={request.createdAt} /></span></div>
          {request.moved ? <p className="sk-note sk-request-note">The repo has changed since. Approving adds the versions shown.</p> : null}
          <ul className="sk-collection-options">{request.skills.map((skill) => {
            const blocked = !!skill.conflict;
            return <li key={skill.name}><label>
              <input type="checkbox" className="sk-checkbox" checked={!blocked && selected.has(skill.name)} disabled={busy || blocked} onChange={() => toggle(skill.name)} />
              <span><strong>{skill.name} <code className="sk-src">{shortCommit(skill.pin.commit)}</code></strong><Verdicts audits={skill.audits} /></span>
              <span className="sk-option-state" data-added={skill.conflict === 'added' || undefined}>{note(skill)}</span>
            </label></li>;
          })}</ul>
          <div className="sk-request-machines">
            <div className="segmented" role="group" aria-label="Machines">
              <button type="button" aria-pressed={assignment.to === 'all'} disabled={busy} onClick={() => setAssignment({ to: 'all' })}>All Machines</button>
              <button type="button" aria-pressed={assignment.to === 'chosen'} disabled={busy}
                onClick={() => assignment.to === 'all' && setAssignment({ to: 'chosen', machineIds: [request.machine.id] })}>Chosen</button>
            </div>
            {assignment.to === 'chosen' ? <ul>{overview.machines.map((machine) => <li key={machine.id}><label>
              <input type="checkbox" className="sk-checkbox" checked={chosen.includes(machine.id)} disabled={busy}
                onChange={() => setAssignment({ to: 'chosen', machineIds: chosen.includes(machine.id) ? chosen.filter((id) => id !== machine.id) : [...chosen, machine.id] })} />
              {machine.nickname}
            </label></li>)}</ul> : null}
          </div>
        </>}
    <div className="sk-collection-dialog-footer">
      {open ? <>
        <button type="button" className="sk-text-button" disabled={busy} onClick={() => decide(false)}>Reject</button>
        <button type="button" className={`button${picked.some((skill) => riskyVerdicts(skill.audits).length || unaudited(skill)) ? ' secondary' : ''}`}
          disabled={busy || !picked.length} onClick={() => decide(true)}>
          {actions.busy === `request:${open.id}` ? 'Saving…' : `Approve ${picked.length} ${picked.length === 1 ? 'skill' : 'skills'}`}
        </button>
      </> : <><span /><button type="button" className="button secondary" onClick={onClose}>Close</button></>}
    </div>
  </dialog>;
}
