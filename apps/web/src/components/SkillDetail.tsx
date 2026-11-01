import type { Audits, PinMove, Skill, SkillDiff, SkillsOverview } from '@agentsync/contract';
import { safe } from '@orpc/client';
import { useEffect, useState } from 'react';
import { rpc } from '../rpc';
import type { SkillActions } from '../skill-actions';
import { describeState, isAssigned, RISK_NAMES, riskyVerdicts, SCANNERS, shortCommit, shortDate } from '../skills';
import { Command } from './Copy';
import { Ago } from './Time';

const MOVES = { added: 'Added', manual: 'Updated', automatic: 'Updated automatically' } as const;

/** The three skills.sh verdicts, toned by risk. */
export function Verdicts({ audits }: { audits: Audits }) {
  return (
    <div className="sk-verdicts">
      {SCANNERS.map(([key, label]) => {
        const audit = audits[key];
        return (
          <span key={key} className="sk-verdict" data-risk={audit?.risk ?? 'none'}
            title={audit ? `Analyzed ${audit.analyzedAt.toLocaleString()}` : 'Not audited'}>
            {label} <b>{audit ? RISK_NAMES[audit.risk] : 'None'}</b>
          </span>
        );
      })}
    </div>
  );
}

/** A Skill opened in the list: where it is on each Machine with its fix, its update, its history, and Remove. */
export function SkillDetail({ skill, overview, actions }: { skill: Skill; overview: SkillsOverview; actions: SkillActions }) {
  const { run, busy } = actions;
  const chosen = skill.assignment.to === 'chosen';
  const [history, setHistory] = useState<PinMove[] | null>(null);
  const [diff, setDiff] = useState<SkillDiff | 'failed' | null>(null);
  const updateCommit = skill.update?.pin.commit;
  useEffect(() => {
    let live = true;
    void safe(rpc.skills.history({ skillId: skill.id })).then(([error, moves]) => live && setHistory(error ? [] : moves));
    return () => { live = false; };
  }, [skill.id, skill.pin.commit]);
  useEffect(() => {
    if (!updateCommit) return;
    let live = true;
    setDiff(null);
    void safe(rpc.skills.diff({ skillId: skill.id })).then(([error, result]) => live && setDiff(error ? 'failed' : result));
    return () => { live = false; };
  }, [skill.id, updateCommit]);

  const nickname = (id: string) => overview.machines.find((machine) => machine.id === id)?.nickname ?? 'a Machine';
  // Chosen stays chosen even with every Machine ticked: only "All Machines" also covers Machines registered later.
  const assign = (machineIds: string[], message: string) =>
    run(`assign:${skill.id}`, () => rpc.skills.assign({ skillId: skill.id, assignment: { to: 'chosen', machineIds } }), () => message);
  const chosenIds = overview.machines.filter((machine) => isAssigned(skill, machine.id)).map((machine) => machine.id);
  const notOn = (machineId: string) => assign(chosenIds.filter((id) => id !== machineId), `${skill.name} comes off ${nickname(machineId)} on its next skills sync`);
  const risky = skill.update ? riskyVerdicts(skill.update.audits) : [];

  return (
    <div className="sk-detail appear">
      <div>
        <div className="section-head sk-detail-head">
          <h3>Machines</h3>
          <div className="segmented" role="group" aria-label={`Machines for ${skill.name}`}>
            <button type="button" aria-pressed={!chosen} disabled={!!busy}
              onClick={() => chosen && run(`assign:${skill.id}`, () => rpc.skills.assign({ skillId: skill.id, assignment: { to: 'all' } }), () => `${skill.name} goes to every Machine`)}>
              All Machines
            </button>
            <button type="button" aria-pressed={chosen} disabled={!!busy}
              onClick={() => !chosen && run(`assign:${skill.id}`, () => rpc.skills.assign({ skillId: skill.id, assignment: { to: 'chosen', machineIds: chosenIds } }), () => `Choose the Machines for ${skill.name}`)}>
              Chosen
            </button>
          </div>
        </div>
        <ul className="sk-machines">
          {skill.machines.map((state) => {
            const machine = overview.machines.find((m) => m.id === state.machineId);
            const shown = describeState(skill, state);
            const assigned = isAssigned(skill, state.machineId);
            return (
              <li key={state.machineId} data-check={chosen || undefined}>
                {chosen ? (
                  <input type="checkbox" checked={assigned} disabled={!!busy} aria-label={`Set for ${machine?.nickname}`}
                    onChange={() => assign(
                      assigned ? chosenIds.filter((id) => id !== state.machineId) : [...chosenIds, state.machineId],
                      assigned ? `${skill.name} comes off ${machine?.nickname} on its next skills sync` : `${skill.name} set for ${machine?.nickname}`,
                    )} />
                ) : null}
                <span className="sk-dot" data-state={shown.dot} aria-hidden="true" />
                <span className="sk-machine-label">
                  <span>{machine?.nickname} <span className="muted">· {shown.label}</span></span>
                  {shown.detail ? <small>{shown.detail}</small> : null}
                </span>
                <span className="sk-machine-fix">
                  {state.status === 'newer' ? (
                    <button type="button" className="button small secondary" disabled={!!busy}
                      onClick={() => run(`update:${skill.id}`, () => rpc.skills.update({ skillId: skill.id, commit: state.commit }),
                        () => `${skill.name} pinned to ${shortCommit(state.commit)} on every Machine`)}>
                      Use everywhere
                    </button>
                  ) : state.status === 'blocked' ? (
                    <button type="button" className="button small secondary" disabled={!!busy} onClick={() => notOn(state.machineId)}>
                      Not on {machine?.nickname}
                    </button>
                  ) : state.status === 'failed' ? (
                    <Command command="agentsync skills sync" />
                  ) : state.status === 'drifted' ? (
                    <Command command="agentsync skills sync --overwrite" />
                  ) : null}
                </span>
              </li>
            );
          })}
        </ul>
        {!overview.machines.length ? <p className="muted">No Machines yet.</p> : null}
      </div>

      <div className="sk-side">
        {skill.update ? (
          <section className="sk-update" aria-label="Update">
            <div className="sk-update-head">
              <strong><code>{shortCommit(skill.pin.commit)}</code> → <code>{shortCommit(skill.update.pin.commit)}</code></strong>
              <span className="muted">{shortDate(skill.update.pin.committedAt)}</span>
            </div>
            <Verdicts audits={skill.update.audits} />
            {!skill.update.audited ? <p className="sk-note">Not audited since this version was pushed</p> : null}
            {diff === null ? <p className="sk-note">Loading changes…</p> : diff === 'failed' ? (
              <p className="sk-note">GitHub didn’t send the changes.</p>
            ) : (
              <ul className="sk-files" aria-label="Changed files">
                {diff.files.map((file) => (
                  <li key={file.path}>
                    <code>{file.path}</code>
                    <span>+{file.additions} −{file.deletions}</span>
                  </li>
                ))}
                {diff.truncated ? <li className="sk-note">GitHub lists only the first 300 changed files.</li> : null}
              </ul>
            )}
            <div>
              <button type="button" className={`button small${risky.length ? ' secondary' : ''}`} disabled={!!busy}
                onClick={() => run(`update:${skill.id}`, () => rpc.skills.update({ skillId: skill.id, commit: skill.update!.pin.commit }),
                  () => `${skill.name} pinned to ${shortCommit(skill.update!.pin.commit)}`)}>
                {busy === `update:${skill.id}` ? 'Updating…' : risky.length ? 'Update anyway' : 'Update'}
              </button>
            </div>
          </section>
        ) : null}

        <label className="sk-check">
          <input type="checkbox" checked={!skill.autoUpdate} disabled={!!busy}
            onChange={(event) => run(`auto:${skill.id}`, () => rpc.skills.setAutoUpdate({ skillId: skill.id, autoUpdate: !event.target.checked }),
              () => (event.target.checked ? `${skill.name} never updates automatically` : `${skill.name} updates automatically again`))} />
          Never update automatically
        </label>

        <section>
          <h3>History</h3>
          {history === null ? <p className="sk-note">Loading…</p> : (
            <ul className="sk-history">
              {history.map((move) => (
                <li key={`${move.at.getTime()}:${move.to}`}>
                  {move.from ? <><code>{shortCommit(move.from)}</code> → </> : null}<code>{shortCommit(move.to)}</code>
                  {' · '}<Ago date={move.at} />{' · '}{MOVES[move.kind]}
                </li>
              ))}
            </ul>
          )}
          <p className="sk-note sk-source">
            <a href={`https://github.com/${skill.repo.fullName}/tree/${skill.pin.commit}/${skill.path}`} target="_blank" rel="noopener noreferrer">
              View on GitHub
            </a>
          </p>
        </section>

        <div>
          <button type="button" className="button small danger" disabled={!!busy}
            onClick={() => {
              if (!window.confirm(`Remove ${skill.name}?\n\nEach Machine deletes AgentSync's copy on its next skills sync. Copies edited by hand stay.`)) return;
              void run(`remove:${skill.id}`, () => rpc.skills.remove({ skillId: skill.id }), () => `${skill.name} removed. Machines delete their copy on the next skills sync.`);
            }}>
            Remove
          </button>
        </div>
      </div>
    </div>
  );
}
