import type { Skill, SkillsOverview } from '@agentsync/contract';
import { rpc } from '../rpc';
import type { SkillActions } from '../skill-actions';
import { askText, describeState, isAssigned, machineNames, shortCommit, type Entry } from '../skills';
import { Icon } from './Icon';
import { SkillDetail } from './SkillDetail';

/** "k of n machines" that have it installed; hovering names each Machine's state. */
function MachineCount({ skill, overview }: { skill: Skill; overview: SkillsOverview }) {
  const set = skill.machines.filter((state) => isAssigned(skill, state.machineId));
  const installed = set.filter((state) => state.status === 'installed').length;
  const states = skill.machines.map((state) => `${overview.machines.find((machine) => machine.id === state.machineId)?.nickname}: ${describeState(skill, state).label}`);
  return <span className="sk-dots" title={states.join('\n')}>{installed} of {set.length} {set.length === 1 ? 'machine' : 'machines'}</span>;
}

/**
 * A row of the list. A Skill opens to its detail; its most pressing ask is the reason on the right and,
 * where one click fixes it, the action beside the row. A Found Skill is a static row with Ignore and
 * Sync; `onSelect` adds its checkbox when the row can be picked with others.
 */
export function EntryRow({ entry, overview, actions, open, onToggle, onIgnore, selected, onSelect }: {
  entry: Entry;
  overview: SkillsOverview;
  actions: SkillActions;
  onIgnore?: () => void;
  selected?: boolean;
  onSelect?: (() => void) | undefined;
  open: boolean;
  onToggle: () => void;
}) {
  const { busy } = actions;
  const act = actions.run;
  const nickname = (id: string) => overview.machines.find((machine) => machine.id === id)?.nickname ?? 'a Machine';

  if (entry.type === 'found') {
    const { found } = entry;
    const source = found.machines[0]!; // Sync pins the first Machine's copy, so show its commit.
    return (
      <li>
        <div className="sk-line" data-selectable={onSelect ? true : undefined}>
          {onSelect ? <label className="sk-row-selection"><input type="checkbox" className="sk-checkbox" aria-label={`Select ${found.name}`} checked={selected} onChange={onSelect} disabled={!!busy} /></label> : null}
          <div className="sk-row-static">
            <span className="row-title"><strong>{found.name}</strong><span className="sk-src">{source.ref ? shortCommit(source.ref) : ''}</span></span>
            <span className="sk-dots">{machineNames(found.machines.map((machine) => machine.machineId), overview.machines)}</span>
          </div>
          <div className="sk-line-action">
            <button type="button" className="sk-text-button" disabled={!!busy} onClick={onIgnore} title="Hide from this list">Ignore</button>
            <button type="button" className="button small secondary" disabled={!!busy} aria-label={`Sync ${found.name}`}
              onClick={() => act(`add:${found.name}`, () => rpc.skills.add({ repo: found.source, name: found.name, machineId: source.machineId }),
                (added) => `${added.name} now syncing at ${shortCommit(added.pin.commit)}, the version ${nickname(source.machineId)} has`)}>
              {busy === `add:${found.name}` ? 'Syncing…' : 'Sync'}
            </button>
          </div>
        </div>
      </li>
    );
  }

  const { skill } = entry;
  const [first, ...more] = entry.asks;

  let action = null;
  if (first?.kind === 'update' && skill.update) {
    const commit = skill.update.pin.commit;
    action = (
      <button type="button" className={`button small${first.risky.length ? ' secondary' : ''}`} disabled={!!busy}
        onClick={() => act(`update:${skill.id}`, () => rpc.skills.update({ skillId: skill.id, commit }), () => `${skill.name} pinned to ${shortCommit(commit)}`)}>
        {first.risky.length ? 'Update anyway' : 'Update'}
      </button>
    );
  } else if (first?.kind === 'newer') {
    action = (
      <button type="button" className="button small secondary" disabled={!!busy}
        onClick={() => act(`update:${skill.id}`, () => rpc.skills.update({ skillId: skill.id, commit: first.commit }),
          () => `${skill.name} pinned to ${shortCommit(first.commit)} on every Machine`)}>
        Use everywhere
      </button>
    );
  } else if (first?.kind === 'blocked') {
    const rest = overview.machines.map((machine) => machine.id).filter((id) => id !== first.machineId && isAssigned(skill, id));
    action = (
      <button type="button" className="button small secondary" disabled={!!busy}
        onClick={() => act(`assign:${skill.id}`, () => rpc.skills.assign({ skillId: skill.id, assignment: { to: 'chosen', machineIds: rest } }),
          () => `${skill.name} comes off ${nickname(first.machineId)} on its next skills sync`)}>
        Not on {nickname(first.machineId)}
      </button>
    );
  }

  const reason = first ? (
    <span className="sk-reason" data-tone={first.kind === 'update' ? (first.risky.length ? 'warn' : 'update') : first.kind === 'failed' ? 'error' : first.kind === 'newer' ? undefined : 'warn'}>
      {askText(first, skill, overview.machines)}
      {more.length ? <span className="muted">+{more.length}</span> : null}
    </span>
  ) : <span className="sk-reason" aria-label="Nothing to do"><Icon name="check" /></span>;

  return (
    <li data-open={open || undefined}>
      <div className="sk-line">
        <button type="button" className="row-link sk-row" onClick={onToggle} aria-expanded={open}>
          <span className="row-title"><strong>{skill.name}</strong><span className="sk-src">{shortCommit(skill.pin.commit)}</span></span>
          <MachineCount skill={skill} overview={overview} />
          {reason}
          <span className="row-chevron"><Icon name="chevron" /></span>
        </button>
        <div className="sk-line-action">{action}</div>
      </div>
      {open ? <SkillDetail skill={skill} overview={overview} actions={actions} /> : null}
    </li>
  );
}
