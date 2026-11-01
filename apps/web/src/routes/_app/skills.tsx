import type { Skill, SkillsOverview } from '@agentsync/contract';
import { createFileRoute } from '@tanstack/react-router';
import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { AddSkillDialog } from '../../components/AddSkillDialog';
import { Icon } from '../../components/Icon';
import { SkillDetail } from '../../components/SkillDetail';
import { rpc } from '../../rpc';
import { useSkillActions, type SkillActions } from '../../skill-actions';
import { askText, describeState, entriesOf, isAssigned, shortCommit, type Entry } from '../../skills';

export const Route = createFileRoute('/_app/skills')({
  loader: () => rpc.skills.overview(),
  component: SkillsPage,
});

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const EASE_OUT = 'cubic-bezier(0.23, 1, 0.32, 1)';
/** How long a resolved row fades before the list closes the gap. */
const LEAVE_MS = 150;

/**
 * Slide every `[data-flip]` item in `list` from where it was at the last render to where it is now
 * (FLIP, transform only), so a gap left by a removed row closes smoothly. Off under reduced motion.
 */
function useFlip(list: RefObject<HTMLElement | null>) {
  const last = useRef(new Map<string, number>());
  useLayoutEffect(() => {
    const items = [...(list.current?.querySelectorAll<HTMLElement>('[data-flip]') ?? [])];
    const now = new Map(items.map((item) => [item.dataset.flip!, item.offsetTop]));
    if (!reducedMotion()) {
      for (const item of items) {
        const before = last.current.get(item.dataset.flip!);
        const delta = before === undefined ? 0 : before - now.get(item.dataset.flip!)!;
        if (Math.abs(delta) >= 1) {
          item.animate([{ transform: `translateY(${delta}px)` }, { transform: 'none' }], { duration: 220, easing: EASE_OUT });
        }
      }
    }
    last.current = now;
  });
}

/** Fade a row out before the list loses it. */
function leave(row: HTMLElement | null): Promise<void> {
  if (!row || reducedMotion()) return Promise.resolve();
  row.dataset.leaving = '';
  return new Promise((resolve) => setTimeout(resolve, LEAVE_MS));
}

function SkillsPage() {
  const overview = Route.useLoaderData();
  const actions = useSkillActions();
  const { run, busy, status } = actions;
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [filter, setFilter] = useState<'needs' | 'all'>('needs');
  const list = useRef<HTMLUListElement>(null);
  useFlip(list);

  const entries = entriesOf(overview);
  const needs = entries.filter((entry) => entry.asks.length).length;
  const showAll = filter === 'all' || needs === 0;
  const shown = showAll ? entries : entries.filter((entry) => entry.asks.length);
  const updates = overview.skills.filter((skill) => skill.update).length;
  const local = overview.found.flatMap((found) => (found.kind === 'local' ? [found] : []));
  const nickname = (id: string) => overview.machines.find((machine) => machine.id === id)?.nickname ?? 'a Machine';

  return (
    <div className="page sk-page">
      <header className="page-head">
        <div><h1>Skills</h1></div>
        <div className="sk-head-end">
          <span className="muted">Updates</span>
          <div className="segmented" role="group" aria-label="Updates">
            {([false, true] as const).map((automatic) => (
              <button key={String(automatic)} type="button" aria-pressed={overview.settings.autoUpdate === automatic} disabled={!!busy}
                onClick={() => overview.settings.autoUpdate !== automatic && run('settings', () => rpc.skills.settings({ autoUpdate: automatic }),
                  () => (automatic ? 'Automatic updates on. Audited versions rated below High install from the next daily check.' : 'Updates are manual'))}>
                {automatic ? 'Automatic' : 'Manual'}
              </button>
            ))}
          </div>
          {updates >= 2 ? (
            <button type="button" className="button secondary" disabled={!!busy}
              onClick={() => run('update-all', () => rpc.skills.updateAll(), ({ updated }) => `${updated} ${updated === 1 ? 'Skill' : 'Skills'} updated`)}>
              Update all
            </button>
          ) : null}
          <button type="button" className="button" onClick={() => setAdding(true)}><Icon name="plus" />Add a Skill</button>
        </div>
      </header>
      <p className="sk-status" role="status">
        {status ? <span key={status.at} className="status-line appear" data-tone={status.tone}>{status.text}</span> : null}
      </p>

      {entries.length === 0 ? (
        <div className="empty">
          <h2>No Skills yet</h2>
          <p>Add agent skills from skills.sh. Each is pinned to one commit, and <code>agentsync skills sync</code> installs it on your Machines.</p>
          <button type="button" className="button" onClick={() => setAdding(true)}><Icon name="plus" />Add a Skill</button>
        </div>
      ) : (
        <>
          <div className="sk-filter">
            <div className="segmented" role="group" aria-label="Show">
              <button type="button" aria-pressed={!showAll} disabled={!needs} onClick={() => setFilter('needs')}>
                Needs you{needs ? <span className="sk-count">{needs}</span> : null}
              </button>
              <button type="button" aria-pressed={showAll} onClick={() => setFilter('all')}>
                All<span className="sk-count">{entries.length}</span>
              </button>
            </div>
          </div>
          <ul className="rows sk-rows" aria-label="Skills" ref={list}>
            {shown.map((entry) => (
              <EntryRow key={entry.key} entry={entry} overview={overview} actions={actions}
                leaves={!showAll && entry.asks.length === 1}
                open={entry.type === 'skill' && open === entry.skill.id}
                onToggle={() => entry.type === 'skill' && setOpen(open === entry.skill.id ? null : entry.skill.id)} />
            ))}
          </ul>
          {showAll && local.length ? (
            <p className="sk-note sk-local">
              Hand-written on Machines:{' '}
              {local.map((found, i) => (
                <span key={found.name}>{i ? ', ' : ''}<code>{found.name}</code> ({found.machineIds.map(nickname).join(', ')})</span>
              ))}
            </p>
          ) : null}
        </>
      )}
      <AddSkillDialog open={adding} onClose={() => setAdding(false)} taken={new Set(overview.skills.map((skill) => skill.name))} actions={actions} />
    </div>
  );
}

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
function EntryRow({ entry, overview, actions, leaves, open, onToggle }: {
  entry: Entry;
  overview: SkillsOverview;
  actions: SkillActions;
  /** The row's action resolves its only ask, so it leaves the "Needs you" list. */
  leaves: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const row = useRef<HTMLLIElement>(null);
  const { busy } = actions;
  const run = actions.run;
  const [first, ...more] = entry.asks;
  const skill = entry.type === 'skill' ? entry.skill : null;
  const fade = () => (leaves ? leave(row.current) : Promise.resolve());
  /** Run a row action; a row that faded but is still listed after the reload (it has another ask) comes back. */
  const act: typeof run = async (...args) => {
    const ok = await run(...args);
    if (row.current) delete row.current.dataset.leaving;
    return ok;
  };
  const nickname = (id: string) => overview.machines.find((machine) => machine.id === id)?.nickname ?? 'a Machine';

  let action = null;
  if (first?.kind === 'update' && skill?.update) {
    const commit = skill.update.pin.commit;
    action = (
      <button type="button" className={`button small${first.risky.length ? ' secondary' : ''}`} disabled={!!busy}
        onClick={() => act(`update:${skill.id}`, () => rpc.skills.update({ skillId: skill.id, commit }), () => `${skill.name} pinned to ${shortCommit(commit)}`, fade)}>
        {first.risky.length ? 'Update anyway' : 'Update'}
      </button>
    );
  } else if (first?.kind === 'newer' && skill) {
    action = (
      <button type="button" className="button small secondary" disabled={!!busy}
        onClick={() => act(`update:${skill.id}`, () => rpc.skills.update({ skillId: skill.id, commit: first.commit }),
          () => `${skill.name} pinned to ${shortCommit(first.commit)} on every Machine`, fade)}>
        Use everywhere
      </button>
    );
  } else if (first?.kind === 'blocked' && skill) {
    const rest = overview.machines.map((machine) => machine.id).filter((id) => id !== first.machineId && isAssigned(skill, id));
    action = (
      <button type="button" className="button small secondary" disabled={!!busy}
        onClick={() => act(`assign:${skill.id}`, () => rpc.skills.assign({ skillId: skill.id, assignment: { to: 'chosen', machineIds: rest } }),
          () => `${skill.name} comes off ${nickname(first.machineId)} on its next skills sync`, fade)}>
        Not on {nickname(first.machineId)}
      </button>
    );
  } else if (first?.kind === 'found' && entry.type === 'found') {
    const { found } = entry;
    action = (
      <button type="button" className="button small secondary" disabled={!!busy}
        onClick={() => act(`add:${found.name}`, () => rpc.skills.add({ repo: found.source, name: found.name, machineId: first.machineId }),
          (added) => `${added.name} added at ${shortCommit(added.pin.commit)}, the version ${nickname(first.machineId)} has`, fade)}>
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
    const ref = found.machines.find((machine) => machine.ref)?.ref;
    return (
      <li ref={row} data-flip={entry.key}>
        <div className="sk-line">
          <div className="sk-row sk-row-static">
            <span className="row-title"><strong>{found.name}</strong><span className="sk-src">{found.source}{ref ? ` @ ${shortCommit(ref)}` : ''}</span></span>
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
          <div className="sk-line-action">{action}</div>
        </div>
      </li>
    );
  }

  return (
    <li ref={row} data-flip={entry.key} data-open={open || undefined}>
      <div className="sk-line">
        <button type="button" className="row-link sk-row" onClick={onToggle} aria-expanded={open}>
          <span className="row-title"><strong>{skill!.name}</strong><span className="sk-src">{skill!.repo.fullName} @ {shortCommit(skill!.pin.commit)}</span></span>
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
