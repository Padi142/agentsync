import type { SkillsOverview } from '@agentsync/contract';
import { useEffect, useId, useState } from 'react';
import { rpc } from '../rpc';
import { addSkills, collectionMessage, type SkillActions } from '../skill-actions';
import { collectionsOf, entriesOf, entryName, machineNames, waitingOn, type CollectionEntry, type GitHubFound, type SkillCollection } from '../skills';
import { Command } from './Copy';
import { Icon } from './Icon';
import { EntryRow } from './SkillEntryRow';
import { SyncDialog, type SyncRequest } from './SyncDialog';

function toggleKey(current: ReadonlySet<string>, key: string) {
  const next = new Set(current);
  if (next.has(key)) next.delete(key); else next.add(key);
  return next;
}

const count = (n: number) => `${n} ${n === 1 ? 'skill' : 'skills'}`;

/**
 * The Skills page's lists, split by the one thing that matters: what AgentSync manages and what it only
 * found. Machines with changes waiting and Skills that need the person come first. Repositories stay
 * closed until opened; `query` reveals matching skills inside theirs.
 */
export function SkillCollections({ overview, actions, query, onClearQuery, onBrowse }: {
  overview: SkillsOverview;
  actions: SkillActions;
  query: string;
  onClearQuery: () => void;
  onBrowse: (repo: string) => void;
}) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [searchCollapsed, setSearchCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [foundOpen, setFoundOpen] = useState<boolean | null>(null);
  const [ignoredOpen, setIgnoredOpen] = useState(false);
  const [detail, setDetail] = useState<string | null>(null);
  const [request, setRequest] = useState<SyncRequest | null>(null);
  const term = query.trim().toLowerCase();
  useEffect(() => setSearchCollapsed(new Set()), [term]);

  const matches = (repo: string, name: string) => !term || repo.toLowerCase().includes(term) || name.toLowerCase().includes(term);
  const collections = collectionsOf(overview);
  const section = (type: CollectionEntry['type']): SkillCollection[] => collections.flatMap((group) => {
    const entries = group.entries.filter((entry) => entry.type === type && matches(group.repo, entryName(entry)));
    return entries.length ? [{ ...group, entries }] : [];
  });
  const synced = section('skill');
  const found = section('found');
  const ignored = section('ignored');
  const needs = entriesOf(overview).filter((entry) => entry.type === 'skill' && entry.asks.length && matches(entry.skill.repo.fullName, entry.skill.name));
  const updates = overview.skills.filter((skill) => skill.update).length;
  const waiting = waitingOn(overview);
  const local = overview.found.flatMap((item) => item.kind === 'local' && matches('', item.name) ? [item] : []);
  const total = (groups: SkillCollection[]) => groups.reduce((sum, group) => sum + group.entries.length, 0);
  const ignoredCount = total(ignored);
  // Open while there's nothing else to look at, and while searching. Otherwise out of the way until asked for.
  const showFound = !!term || (foundOpen ?? overview.skills.length === 0);
  const showIgnored = ignoredOpen || (!!term && ignoredCount > 0);
  const nothing = !synced.length && !found.length && !ignored.length && !local.length;

  const repoProps = (name: string, group: SkillCollection) => {
    const key = `${name}:${group.key}`;
    return {
      group, overview, actions,
      open: term ? !searchCollapsed.has(key) : expanded.has(key),
      onToggle: () => term ? setSearchCollapsed((current) => toggleKey(current, key)) : setExpanded((current) => toggleKey(current, key)),
      onBrowse: () => onBrowse(group.repo),
    };
  };
  const requestSync = (repo: string, skills: GitHubFound[]) => {
    if (skills.length > 1) return setRequest({ repo, skills });
    void actions.run(`sync:${repo}`, () => addSkills(skills.map((skill) => ({ repo: skill.source, name: skill.name, machineId: skill.machines[0]?.machineId }))), collectionMessage);
  };

  if (term && nothing) {
    return <div className="sk-library-empty"><Icon name="search" size={24} />
      <h2>No matching skills</h2>
      <button type="button" className="button small secondary" onClick={onClearQuery}>Clear search</button>
    </div>;
  }

  return (
    <>
      {waiting.length && !term ? <div className="sk-waiting">
        <ul aria-label="Machines with changes waiting">
          {waiting.map(({ machine, changes }) => <li key={machine.id}><strong>{machine.nickname}</strong> has {changes}</li>)}
        </ul>
        <Command command="agentsync skills sync" />
      </div> : null}

      {needs.length ? <section className="sk-section" aria-label="Needs you">
        <div className="sk-section-head"><h2>Needs you</h2><span>{needs.length}</span>
          {updates >= 2 ? <button type="button" className="button small secondary" disabled={!!actions.busy}
            onClick={() => actions.run('update-all', () => rpc.skills.updateAll(), ({ updated }) => `${updated} skills updated`)}>Update all</button> : null}
        </div>
        <div className="sk-collection"><div className="sk-collection-body sk-flat">
          <ul className="rows sk-rows">
            {needs.map((entry) => <EntryRow key={entry.key} entry={entry} overview={overview} actions={actions}
              open={detail === entry.key} onToggle={() => setDetail(detail === entry.key ? null : entry.key)} />)}
          </ul>
        </div></div>
      </section> : null}

      {!term || synced.length ? <section className="sk-section" aria-label="Synced">
        <div className="sk-section-head"><h2>Synced</h2><span>{total(synced)}</span></div>
        {synced.length ? <ul className="sk-collections">
          {synced.map((group) => <Collection key={group.key} section="skill" {...repoProps('skill', group)} onSync={requestSync} />)}
        </ul> : <p className="sk-quiet">{found.length ? 'Nothing yet. Choose below what should be on all your machines.' : 'Nothing yet.'}</p>}
      </section> : null}

      {found.length || ignored.length || local.length ? <section className="sk-section" aria-label="On your machines, not synced">
        <div className="sk-section-head"><h2>On your machines, not synced</h2><span>{total(found)}</span>
          {term ? null : <button type="button" className="sk-text-button" aria-expanded={showFound} onClick={() => setFoundOpen(!showFound)}>{showFound ? 'Hide' : 'Show'}</button>}
        </div>
        {showFound ? <>
          {found.length ? <ul className="sk-collections">
            {found.map((group) => <Collection key={group.key} section="found" {...repoProps('found', group)} onSync={requestSync} />)}
          </ul> : null}
          {local.length ? <p className="sk-note sk-section-note">Can’t sync, not from GitHub:{' '}
            {local.map((item, i) => <span key={item.name}>{i ? ', ' : ''}<code>{item.name}</code> on {machineNames(item.machineIds, overview.machines)}</span>)}
          </p> : null}
          {ignored.length ? <div className="sk-section-note">
            {term ? null : <button type="button" className="sk-text-button" aria-expanded={showIgnored} onClick={() => setIgnoredOpen(!ignoredOpen)}>{ignoredCount} ignored</button>}
            {showIgnored ? <ul className="sk-collections">
              {ignored.map((group) => <Collection key={group.key} section="ignored" {...repoProps('ignored', group)} onSync={requestSync} />)}
            </ul> : null}
          </div> : null}
        </> : null}
      </section> : null}

      <SyncDialog request={request} machineCount={overview.machines.length} actions={actions} onClose={() => setRequest(null)} />
    </>
  );
}

/** How a repository's Skills stand: what needs the person, what's waiting on a Machine, or where they are. */
function SyncedStatus({ entries, machineCount }: { entries: CollectionEntry[]; machineCount: number }) {
  const skills = entries.flatMap((entry) => entry.type === 'skill' ? [entry.skill] : []);
  const needs = entries.filter((entry) => entry.asks.length).length;
  if (needs) return <span className="sk-collection-attention">{needs} {needs === 1 ? 'needs' : 'need'} you</span>;
  const waiting = skills.filter((skill) => skill.machines.some((state) => state.status === 'pending')).length;
  if (waiting) return <span className="sk-collection-state">{waiting} waiting</span>;
  if (!machineCount) return null;
  return <span className="sk-collection-state" data-done>{skills.every((skill) => skill.assignment.to === 'all') ? 'On all machines' : 'On chosen machines'}</span>;
}

/** One repository's skills within a section of the page. The head's action applies to what's listed, so to the matches while searching. */
function Collection({ section, group, open, onToggle, overview, actions, onBrowse, onSync }: {
  section: CollectionEntry['type'];
  group: SkillCollection;
  open: boolean;
  onToggle: () => void;
  overview: SkillsOverview;
  actions: SkillActions;
  onBrowse: () => void;
  onSync: (repo: string, skills: GitHubFound[]) => void;
}) {
  const id = useId();
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [detail, setDetail] = useState<string | null>(null);
  const found = group.entries.flatMap((entry) => entry.type === 'found' ? [entry] : []);
  const picked = found.filter((entry) => selected.has(entry.key));
  const busy = !!actions.busy;
  const selectable = found.length > 1;
  const [owner, ...repo] = group.repo.split('/');
  const setIgnored = (entries: CollectionEntry[], value: boolean) => actions.run(`ignore:${group.key}`,
    async () => {
      for (let offset = 0; offset < entries.length; offset += 500) {
        await rpc.skills.setIgnored({ repo: group.repo, names: entries.slice(offset, offset + 500).map(entryName), ignored: value });
      }
    },
    () => `${entries.length === 1 ? entryName(entries[0]!) : `${entries.length} skills`} ${value ? 'ignored' : 'restored'}.`);

  return <li className="sk-collection" data-expanded={open || undefined}>
    <div className="sk-collection-head">
      <button type="button" className="sk-collection-toggle" aria-label={`${group.repo}, ${count(group.entries.length)}`} aria-expanded={open} aria-controls={open ? id : undefined} onClick={onToggle}>
        <span className="sk-collection-chevron"><Icon name="chevron" /></span>
        <span className="sk-collection-title"><strong><span>{owner}/</span>{repo.join('/')}</strong></span>
        <span className="sk-collection-summary">{count(group.entries.length)}</span>
      </button>
      <div className="sk-collection-actions">
        {section === 'skill' ? <SyncedStatus entries={group.entries} machineCount={overview.machines.length} /> : null}
        {section === 'found' ? <button type="button" className="button small secondary" disabled={busy} aria-label={`Sync ${count(found.length)} from ${group.repo}`}
          onClick={() => onSync(group.repo, found.map((entry) => entry.found))}>
          {actions.busy === `sync:${group.repo}` ? 'Syncing…' : found.length > 1 ? `Sync ${found.length}` : 'Sync'}
        </button> : null}
        {section === 'ignored' ? <button type="button" className="button small secondary" disabled={busy} onClick={() => setIgnored(group.entries, false)}>Restore all</button> : null}
      </div>
    </div>
    {open ? <div id={id} className="sk-collection-body">
      {selectable ? <div className="sk-selection-bar">
        <label><input type="checkbox" className="sk-checkbox" checked={picked.length === found.length}
          aria-label={`Select all available skills in ${group.repo}`} disabled={busy}
          onChange={(event) => setSelected(event.target.checked ? new Set(found.map((entry) => entry.key)) : new Set())}
          ref={(element) => { if (element) element.indeterminate = picked.length > 0 && picked.length < found.length; }} />
          <span>{picked.length ? `${picked.length} selected` : 'Select all'}</span></label>
        <div><button type="button" className="sk-text-button" disabled={busy || !picked.length} onClick={() => setIgnored(picked, true)}>Ignore selected</button>
          <button type="button" className="button small secondary" disabled={busy || !picked.length} onClick={() => onSync(group.repo, picked.map((entry) => entry.found))}>
            Sync selected{picked.length ? ` (${picked.length})` : ''}
          </button></div>
      </div> : null}
      <ul className="rows sk-rows" aria-label={`Skills in ${group.repo}`}>
        {group.entries.map((entry) => entry.type === 'ignored' ? <li key={entry.key} className="sk-ignored-row">
          <strong>{entry.name}</strong>
          <button type="button" className="sk-text-button" disabled={busy} onClick={() => setIgnored([entry], false)}>Restore</button>
        </li> : <EntryRow key={entry.key} entry={entry} overview={overview} actions={actions} open={detail === entry.key} onToggle={() => setDetail(detail === entry.key ? null : entry.key)}
          onIgnore={() => setIgnored([entry], true)} selected={selected.has(entry.key)}
          onSelect={selectable ? () => setSelected((current) => toggleKey(current, entry.key)) : undefined} />)}
      </ul>
      <div className="sk-collection-footer">
        <button type="button" className="sk-text-button" onClick={onBrowse}>Browse all skills in this repo</button>
        <a href={`https://github.com/${group.repo}`} target="_blank" rel="noopener noreferrer">View on GitHub</a>
      </div>
    </div> : null}
  </li>;
}
