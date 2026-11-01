import type { SkillsOverview } from '@agentsync/contract';
import { useId, useState } from 'react';
import { rpc } from '../rpc';
import { addSkills, collectionMessage, type SkillActions } from '../skill-actions';
import { collectionsOf, entryName, type CollectionEntry, type SkillCollection } from '../skills';
import { Icon } from './Icon';
import { EntryRow } from './SkillEntryRow';

type Filter = 'all' | 'needs' | 'ignored';

function toggleKey(current: ReadonlySet<string>, key: string) {
  const next = new Set(current);
  if (next.has(key)) next.delete(key); else next.add(key);
  return next;
}

/** Repository groups stay closed until opened; search reveals matching skills inside their collection. */
export function SkillCollections({ overview, actions, onAddCollection }: {
  overview: SkillsOverview;
  actions: SkillActions;
  onAddCollection: (repo: string) => void;
}) {
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [searchCollapsed, setSearchCollapsed] = useState<ReadonlySet<string>>(new Set());
  const collections = collectionsOf(overview);
  const term = query.trim().toLowerCase();
  const needs = collections.flatMap((group) => group.entries).filter((entry) => entry.asks.length).length;
  const counts = { all: collections.filter((group) => group.entries.some((entry) => entry.type !== 'ignored')).length, needs, ignored: overview.ignored.length };
  const visible = collections.flatMap((group) => {
    const entries = group.entries.filter((entry) => (filter === 'ignored' ? entry.type === 'ignored'
      : entry.type !== 'ignored' && (filter !== 'needs' || entry.asks.length > 0))
      && (!term || group.key.includes(term) || entryName(entry).toLowerCase().includes(term)));
    return entries.length ? [{ ...group, entries }] : [];
  });
  const isOpen = (key: string) => term ? !searchCollapsed.has(key) : expanded.has(key);
  const allExpanded = visible.length > 0 && visible.every((group) => isOpen(group.key));

  return (
    <>
      <div className="sk-library-toolbar">
        <div className="segmented" role="group" aria-label="Filter collections">
          {(['all', 'needs', 'ignored'] as const).map((value) => <button type="button" key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>
            {{ all: 'Collections', needs: 'Needs you', ignored: 'Ignored' }[value]}{' '}<span className="sk-count">{counts[value]}</span>
          </button>)}
        </div>
        <label className="sk-search"><Icon name="search" /><input type="search" aria-label="Search collections and skills" placeholder="Find a collection or skill…" value={query} onChange={(event) => { setQuery(event.target.value); setSearchCollapsed(new Set()); }} /></label>
      </div>
      <div className="sk-library-meta">
        <span>{visible.length} {visible.length === 1 ? 'collection' : 'collections'}{term ? ' matching your search' : filter === 'ignored' ? ' with ignored skills' : ''}</span>
        <button className="sk-text-button" type="button" disabled={!visible.length} onClick={() => term
          ? setSearchCollapsed(allExpanded ? new Set(visible.map((group) => group.key)) : new Set())
          : setExpanded(allExpanded ? new Set() : new Set(visible.map((group) => group.key)))}>
          {allExpanded ? 'Collapse all' : 'Expand all'}
        </button>
      </div>
      {visible.length ? <ul className="sk-collections" aria-label="Skill collections">
        {visible.map((group) => <Collection key={group.key} group={group} full={collections.find((item) => item.key === group.key)!}
          open={isOpen(group.key)} onToggle={() => term ? setSearchCollapsed((current) => toggleKey(current, group.key))
            : setExpanded((current) => toggleKey(current, group.key))} overview={overview} actions={actions} onAdd={() => onAddCollection(group.repo)} />)}
      </ul> : <div className="sk-library-empty"><Icon name={filter === 'ignored' ? 'check' : 'search'} size={24} />
        <h2>{term ? 'No matching skills' : filter === 'ignored' ? 'Nothing ignored' : filter === 'all' ? 'No active collections' : 'You’re all caught up'}</h2>
        <p>{term ? 'Try another skill name or repository.' : filter === 'ignored' ? 'Skills you exclude from a collection will appear here.' : filter === 'all' ? 'Restore ignored skills or add another collection.' : 'Your skills don’t need any changes.'}</p>
        {term ? <button type="button" className="button small secondary" onClick={() => setQuery('')}>Clear search</button> : null}
      </div>}
    </>
  );
}

function Collection({ group, full, open, onToggle, overview, actions, onAdd }: {
  group: SkillCollection;
  full: SkillCollection;
  open: boolean;
  onToggle: () => void;
  overview: SkillsOverview;
  actions: SkillActions;
  onAdd: () => void;
}) {
  const id = useId();
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [detail, setDetail] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const found = group.entries.filter((entry) => entry.type === 'found');
  const picked = found.filter((entry) => selected.has(entry.key));
  const added = full.entries.filter((entry) => entry.type === 'skill').length;
  const ignored = full.entries.filter((entry) => entry.type === 'ignored').length;
  const needs = full.entries.filter((entry) => entry.asks.length && entry.type === 'skill').length;
  const busy = !!actions.busy;
  const allIgnored = group.entries.every((entry) => entry.type === 'ignored');
  const [owner, ...repo] = group.repo.split('/');
  const setIgnored = (entries: CollectionEntry[], value: boolean) => actions.run(`ignore:${group.key}`,
    async () => {
      for (let offset = 0; offset < entries.length; offset += 500) {
        await rpc.skills.setIgnored({ repo: group.repo, names: entries.slice(offset, offset + 500).map(entryName), ignored: value });
      }
    },
    () => value ? `${entries.length === 1 ? entryName(entries[0]!) : `${entries.length} skills`} ignored.` : `${entries.length === 1 ? entryName(entries[0]!) : `${entries.length} skills`} restored. You can add them again.`);

  const addSelected = async () => {
    setProgress(0);
    await actions.run(`collection:${group.key}`, () => addSkills(picked.map(({ found }) => ({ repo: found.source, name: found.name, machineId: found.machines[0]?.machineId })), setProgress), collectionMessage);
    setSelected(new Set());
  };

  return <li className="sk-collection" data-expanded={open || undefined}>
    <div className="sk-collection-head">
      <button type="button" className="sk-collection-toggle" aria-label={`${group.repo}, ${full.entries.length} skills`} aria-expanded={open} aria-controls={open ? id : undefined} onClick={onToggle}>
        <span className="sk-collection-chevron"><Icon name="chevron" /></span>
        <span className="sk-collection-icon"><Icon name="collection" size={20} /></span>
        <span className="sk-collection-title"><strong><span>{owner}/</span>{repo.join('/')}</strong>
          <span className="sk-collection-summary"><span>{full.entries.length} {full.entries.length === 1 ? 'skill' : 'skills'}</span>{added ? <span className="sk-added-count">{added} added</span> : null}{ignored ? <span>{ignored} ignored</span> : null}</span>
        </span>
      </button>
      <div className="sk-collection-actions">
        {needs ? <span className="sk-collection-attention">{needs} need you</span> : null}
        {allIgnored ? <button type="button" className="button small secondary" disabled={busy} onClick={() => setIgnored(group.entries, false)}>Restore all</button>
          : <button type="button" className={`button small ${added && !found.length ? 'secondary' : ''}`} disabled={busy} onClick={onAdd}>
            <Icon name={added && !found.length ? 'collection' : 'plus'} />{added && !found.length ? 'Manage collection' : 'Add collection'}
          </button>}
      </div>
    </div>
    {open ? <div id={id} className="sk-collection-body">
      {found.length ? <div className="sk-selection-bar">
        <label><input type="checkbox" className="sk-checkbox" checked={picked.length === found.length}
          aria-label={`Select all available skills in ${group.repo}`} disabled={busy}
          onChange={(event) => setSelected(event.target.checked ? new Set(found.map((entry) => entry.key)) : new Set())}
          ref={(element) => { if (element) element.indeterminate = picked.length > 0 && picked.length < found.length; }} />
          <span>{picked.length ? `${picked.length} selected` : `${found.length} available`}</span></label>
        <div><button type="button" className="sk-text-button" disabled={busy || !picked.length} onClick={() => setIgnored(picked, true)}>Ignore selected</button>
          <button type="button" className="button small secondary" disabled={busy || !picked.length} onClick={addSelected}>
            {actions.busy === `collection:${group.key}` ? `Adding ${progress} of ${picked.length}…` : `Add selected${picked.length ? ` (${picked.length})` : ''}`}
          </button></div>
      </div> : null}
      <ul className="rows sk-rows" aria-label={`Skills in ${group.repo}`}>
        {group.entries.map((entry) => entry.type === 'ignored' ? <li key={entry.key} className="sk-ignored-row">
          <Icon name="minus" /><strong>{entry.name}</strong><span>Ignored</span>
          <button type="button" className="sk-text-button" disabled={busy} onClick={() => setIgnored([entry], false)}>Restore</button>
        </li> : <EntryRow key={entry.key} entry={entry} overview={overview} actions={actions} open={detail === entry.key} onToggle={() => setDetail(detail === entry.key ? null : entry.key)}
          onIgnore={() => setIgnored([entry], true)} selected={selected.has(entry.key)} onSelect={() => setSelected((current) => {
            const next = new Set(current);
            if (next.has(entry.key)) next.delete(entry.key); else next.add(entry.key);
            return next;
          })} />)}
      </ul>
      <div className="sk-collection-footer"><a href={`https://github.com/${group.repo}`} target="_blank" rel="noopener noreferrer">View repository</a>
        <span>Only added skills sync to your machines.</span></div>
    </div> : null}
  </li>;
}
