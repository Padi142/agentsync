import type { Skill, SkillsOverview } from '@agentsync/contract';
import { rpc } from '../rpc';
import type { SkillActions } from '../skill-actions';
import { askText, describeState, isAssigned, shortCommit, type Entry } from '../skills';
import { Icon } from './Icon';
import { SkillDetail } from './SkillDetail';

/** One dot per Machine, then "k of n" Machines that have it installed. */
function MachineDots({ skill, overview }: { skill: Skill; overview: SkillsOverview }) {
  const set = skill.machines.filter((state) => isAssigned(skill, state.machineId));
  const installed = set.filter((state) => state.status === 'installed').length;
  return (
    <span className="sk-dots">
      <span className="sk-dot-group">
        {skill.machines.map((state) => {
          const shown = describeState(skill, state);
          const name = overview.machines.find((machine) => machine.id === state.machineId)?.nickname;
          return <span key={state.machineId} className="sk-dot" data-state={shown.dot} title={`${name}: ${shown.label}`} />;
        })}
      </span>
      {installed} of {set.length}
    </span>
  );
}

/**
 * A row of the list. A Skill opens to its detail; its most pressing ask is the reason on the right and,
 * where one click fixes it, the action beside the row. A Found Skill is a static row with Add.
 */
export function EntryRow({ entry, overview, actions, open, onToggle, onIgnore, selected, onSelect }: {
  entry: Entry;
  overview: SkillsOverview;
  actions: SkillActions;
  onIgnore: () => void;
  selected: boolean;
  onSelect: () => void;
  open: boolean;
  onToggle: () => void;
}) {
  const { busy } = actions;
  const act = actions.run;
  const [first, ...more] = entry.asks;
  const skill = entry.type === 'skill' ? entry.skill : null;

  const nickname = (id: string) => overview.machines.find((machine) => machine.id === id)?.nickname ?? 'a Machine';

  let action = null;
  if (first?.kind === 'update' && skill?.update) {
    const commit = skill.update.pin.commit;
    action = (
      <button type="button" className={`button small${first.risky.length ? ' secondary' : ''}`} disabled={!!busy}
        onClick={() => act(`update:${skill.id}`, () => rpc.skills.update({ skillId: skill.id, commit }), () => `${skill.name} pinned to ${shortCommit(commit)}`)}>
        {first.risky.length ? 'Update anyway' : 'Update'}
      </button>
    );
  } else if (first?.kind === 'newer' && skill) {
    action = (
      <button type="button" className="button small secondary" disabled={!!busy}
        onClick={() => act(`update:${skill.id}`, () => rpc.skills.update({ skillId: skill.id, commit: first.commit }),
          () => `${skill.name} pinned to ${shortCommit(first.commit)} on every Machine`)}>
        Use everywhere
      </button>
    );
  } else if (first?.kind === 'blocked' && skill) {
    const rest = overview.machines.map((machine) => machine.id).filter((id) => id !== first.machineId && isAssigned(skill, id));
    action = (
      <button type="button" className="button small secondary" disabled={!!busy}
        onClick={() => act(`assign:${skill.id}`, () => rpc.skills.assign({ skillId: skill.id, assignment: { to: 'chosen', machineIds: rest } }),
          () => `${skill.name} comes off ${nickname(first.machineId)} on its next skills sync`)}>
        Not on {nickname(first.machineId)}
      </button>
    );
  } else if (first?.kind === 'found' && entry.type === 'found') {
    const { found } = entry;
    action = (
      <button type="button" className="button small secondary" disabled={!!busy}
        onClick={() => act(`add:${found.name}`, () => rpc.skills.add({ repo: found.source, name: found.name, machineId: first.machineId }),
          (added) => `${added.name} added at ${shortCommit(added.pin.commit)}, the version ${nickname(first.machineId)} has`)}>
        {busy === `add:${found.name}` ? 'Adding…' : 'Add'}
      </button>
    );
  }

  const reason = first ? (
    <span className="sk-reason" data-tone={first.kind === 'update' ? (first.risky.length ? 'warn' : 'update') : first.kind === 'failed' ? 'error' : first.kind === 'newer' || first.kind === 'found' ? undefined : 'warn'}>
      {askText(first, skill, overview.machines)}
      {more.length ? <span className="muted">+{more.length}</span> : null}
    </span>
  ) : <span className="sk-reason" aria-label="Nothing to do"><Icon name="check" /></span>;

  if (entry.type === 'found') {
    const { found } = entry;
    const ref = found.machines[0]?.ref; // Add pins the first Machine's copy, so show its commit.
    return (
      <li>
        <div className="sk-line">
          <label className="sk-row-selection"><input type="checkbox" className="sk-checkbox" aria-label={`Select ${found.name}`} checked={selected} onChange={onSelect} disabled={!!busy} /></label>
          <div className="sk-row sk-row-static">
            <span className="row-title"><strong>{found.name}</strong><span className="sk-src">{ref ? shortCommit(ref) : ''}</span></span>
            <span className="sk-dots">
              <span className="sk-dot-group">
                {overview.machines.map((machine) => (
                  <span key={machine.id} className="sk-dot" data-state={found.machines.some((m) => m.machineId === machine.id) ? 'found' : 'none'}
                    title={found.machines.some((m) => m.machineId === machine.id) ? `Found on ${machine.nickname}` : undefined} />
                ))}
              </span>
            </span>
            {reason}
            <span />
          </div>
          <div className="sk-line-action"><button type="button" className="sk-text-button" disabled={!!busy} onClick={onIgnore} title="Exclude from collection adds">Ignore</button>{action}</div>
        </div>
      </li>
    );
  }

  return (
    <li data-open={open || undefined}>
      <div className="sk-line">
        <span className="sk-managed-check" title="Added"><Icon name="check" /></span>
        <button type="button" className="row-link sk-row" onClick={onToggle} aria-expanded={open}>
          <span className="row-title"><strong>{skill!.name}</strong><span className="sk-src">{shortCommit(skill!.pin.commit)}</span></span>
          <MachineDots skill={skill!} overview={overview} />
          {reason}
          <span className="row-chevron"><Icon name="chevron" /></span>
        </button>
        <div className="sk-line-action">{action}</div>
      </div>
      {open ? <SkillDetail skill={skill!} overview={overview} actions={actions} /> : null}
    </li>
  );
}
