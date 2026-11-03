import type { SkillsOverview } from '@agentsync/contract';
import { safe } from '@orpc/client';
import { useEffect, useRef, useState } from 'react';
import { rpc } from '../rpc';
import { addSkills, collectionMessage, skillErrorText, type SkillActions } from '../skill-actions';
import { Icon } from './Icon';

/** Pick skills to sync from everything in a repository. Nothing starts ticked, and leaving a skill unticked changes nothing. */
export function CollectionDialog({ repo, onClose, overview, actions }: {
  repo: string | null;
  onClose: () => void;
  overview: SkillsOverview;
  actions: SkillActions;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [names, setNames] = useState<string[]>([]);
  const [source, setSource] = useState('');
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [progress, setProgress] = useState(0);
  const [failures, setFailures] = useState<{ name: string; error: string }[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const session = useRef(0);

  useEffect(() => {
    if (!repo) { dialog.current?.close(); return; }
    dialog.current?.showModal();
    session.current++;
    let live = true;
    setLoading(true);
    setNames([]);
    setError('');
    setFailures([]);
    setSaveError(false);
    setProgress(0);
    void (async () => {
      const collected = new Set<string>();
      let offset = 0;
      let commit: string | undefined;
      let canonical = repo;
      do {
        const [error, page] = await safe(rpc.skills.collection({ repo, offset, commit }));
        if (!live) return;
        if (error) { setError(skillErrorText(error)); setLoading(false); return; }
        page.names.forEach((name) => collected.add(name));
        canonical = page.repo;
        commit = page.commit;
        if (page.next === null) break;
        offset = page.next;
      } while (live);
      if (!live) return;
      setSource(canonical);
      setNames([...collected].sort((a, b) => a.localeCompare(b)));
      setSelected(new Set());
      setLoading(false);
    })();
    return () => { live = false; };
  }, [repo, retry]);

  const taken = new Set(overview.skills.map((skill) => skill.name));
  const available = names.filter((name) => !taken.has(name));
  const picked = available.filter((name) => selected.has(name));
  // A Machine's lock or an old exclusion may still name the repository as it was before a rename.
  const isThisRepo = (name: string) => [repo?.toLowerCase(), source.toLowerCase()].includes(name.toLowerCase());
  const foundHere = (name: string) => overview.found.find((item) => item.kind === 'github' && item.name === name && isThisRepo(item.source));
  const ignoredHere = (name: string) => overview.ignored.some((item) => item.name === name && isThisRepo(item.repo));
  const busy = !!actions.busy || saving;

  const save = async () => {
    if (!repo || busy) return;
    const started = session.current;
    setSaving(true);
    setProgress(0);
    setFailures([]);
    setSaveError(false);
    try {
      let partial = false;
      const ok = await actions.run(`add-collection:${source}`, async () => {
        // Each add gets a separate Worker request budget.
        const result = await addSkills(picked.map((name) => {
          const found = foundHere(name);
          return { repo: source, name, machineId: found?.kind === 'github' ? found.machines[0]?.machineId : undefined };
        }), setProgress);
        partial = result.failed.length > 0;
        if (started === session.current) setFailures(result.failed);
        return result;
      }, collectionMessage);
      if (started === session.current) setSaveError(!ok || partial);
      if (started === session.current && dialog.current?.open && ok && !partial) onClose();
    } finally {
      setSaving(false);
    }
  };

  return <dialog ref={dialog} className="sk-dialog sk-collection-dialog" aria-label="Browse repository" onClose={onClose}
    onCancel={(event) => { if (saving) event.preventDefault(); }} onClick={(event) => !saving && event.target === dialog.current && onClose()}>
    <div className="sk-dialog-head"><Icon name="collection" size={20} /><strong>{repo}</strong>
      <button type="button" className="icon-button" aria-label="Close repository" disabled={saving} onClick={onClose}><Icon name="close" /></button>
    </div>
    {loading ? <div className="sk-collection-loading" role="status">Reading skills from this repository…</div>
      : error ? <div className="sk-collection-loading"><p className="status-line" data-tone="error" role="alert">{error}</p><button type="button" className="button small secondary" onClick={() => setRetry((value) => value + 1)}>Try again</button></div>
        : names.length ? <>
          <div className="sk-dialog-selection"><span>{names.length} skills</span><div>
            <button type="button" className="sk-text-button" disabled={busy} onClick={() => setSelected(new Set(available))}>Select all</button>
            <button type="button" className="sk-text-button" disabled={busy} onClick={() => setSelected(new Set())}>Clear</button>
          </div></div>
          <ul className="sk-collection-options">{names.map((name) => {
            const added = taken.has(name);
            const onMachines = !added && !!foundHere(name);
            const own = overview.skills.some((skill) => skill.name === name && skill.repo.fullName.toLowerCase() === source.toLowerCase());
            const failure = failures.find((item) => item.name === name);
            return <li key={name}><label><input type="checkbox" className="sk-checkbox" checked={added || selected.has(name)} disabled={busy || added}
              onChange={(event) => setSelected((current) => {
                const next = new Set(current);
                if (event.target.checked) next.add(name); else next.delete(name);
                return next;
              })} /><span><strong>{name}</strong>{failure ? <small className="status-line" data-tone="error">{failure.error}</small> : null}</span>
              <span className="sk-option-state" data-added={own || undefined}>{own ? 'Synced' : added ? 'Name already in use' : onMachines ? 'On your machines' : ignoredHere(name) ? 'Ignored' : ''}</span>
            </label></li>;
          })}</ul>
        </> : <p className="sk-collection-loading">No supported skills found in this repository.</p>}
    <div className="sk-collection-dialog-footer"><span>{loading ? '' : `${picked.length} selected`}</span>
      <button type="button" className="button" disabled={busy || loading || !!error || !picked.length} onClick={save}>
        {saving ? `Syncing ${progress} of ${picked.length}…` : `Sync ${picked.length} ${picked.length === 1 ? 'skill' : 'skills'}`}
      </button></div>
    {saveError ? <p className="sk-dialog-error" role="alert">{actions.status?.text}</p> : null}
  </dialog>;
}
