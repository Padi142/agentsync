import type { SkillCandidate, SkillSearchResult } from '@agentsync/contract';
import { safe } from '@orpc/client';
import { useEffect, useRef, useState } from 'react';
import { rpc } from '../rpc';
import { skillErrorText, type SkillActions } from '../skill-actions';
import { riskyVerdicts, shortCommit, shortDate } from '../skills';
import { Icon } from './Icon';
import { Verdicts } from './SkillDetail';

const compact = new Intl.NumberFormat(undefined, { notation: 'compact' });
/** Wait this long after typing stops before searching. */
const SEARCH_DELAY_MS = 250;

/**
 * Add a Skill: search skills.sh, pick one to see the version that would be pinned and its audits,
 * then add it for every Machine. `taken` are the names already in the account.
 */
export function AddSkillDialog({ open, onClose, taken, actions }: {
  open: boolean;
  onClose: () => void;
  taken: ReadonlySet<string>;
  actions: SkillActions;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SkillSearchResult[] | null>(null);
  const [searchError, setSearchError] = useState('');
  const [picked, setPicked] = useState<SkillSearchResult | null>(null);
  const [candidate, setCandidate] = useState<SkillCandidate | { error: string } | null>(null);
  /** The last Add from this preview failed: show why here, not only under the page title behind the dialog. */
  const [addFailed, setAddFailed] = useState(false);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) {
      setQuery('');
      setResults(null);
      setPicked(null);
      element.showModal();
      input.current?.focus();
    } else if (!open && element.open) {
      element.close();
    }
  }, [open]);

  useEffect(() => {
    const term = query.trim();
    if (!term) return setResults(null);
    let live = true;
    const timer = setTimeout(async () => {
      const [error, found] = await safe(rpc.skills.search({ query: term }));
      if (!live) return;
      setSearchError(error ? skillErrorText(error) : '');
      setResults(error ? [] : found);
    }, SEARCH_DELAY_MS);
    return () => { live = false; clearTimeout(timer); };
  }, [query]);

  useEffect(() => {
    if (!picked) return;
    let live = true;
    setCandidate(null);
    setAddFailed(false);
    void safe(rpc.skills.inspect({ repo: picked.source, name: picked.name })).then(([error, found]) => {
      if (live) setCandidate(error ? { error: skillErrorText(error) } : found);
    });
    return () => { live = false; };
  }, [picked]);

  const add = async (found: SkillCandidate) => {
    setAddFailed(false);
    const ok = await actions.run(`add:${found.name}`, () => rpc.skills.add({ repo: found.repo.fullName, name: found.name }),
      (skill) => `${skill.name} added at ${shortCommit(skill.pin.commit)}. Machines install it on their next skills sync.`);
    if (ok) onClose();
    else setAddFailed(true);
  };

  return (
    <dialog ref={dialog} className="sk-dialog" aria-label="Add a Skill" onClose={onClose}
      onClick={(event) => event.target === dialog.current && onClose()}>
      {picked ? (
        <div className="sk-preview">
          <div className="sk-dialog-head">
            <button type="button" className="icon-button" aria-label="Back to results" onClick={() => setPicked(null)}>
              <Icon name="back" />
            </button>
            <strong>{picked.name}</strong>
            <button type="button" className="icon-button" aria-label="Close" onClick={onClose}><Icon name="close" /></button>
          </div>
          <div className="sk-preview-body">
            {candidate === null ? <p className="sk-note">Finding the newest version on GitHub…</p>
              : 'error' in candidate ? <p className="status-line" data-tone="error" role="status">{candidate.error}</p> : (
                <>
                  <p className="sk-src">{candidate.repo.fullName} @ {shortCommit(candidate.pin.commit)} · {shortDate(candidate.pin.committedAt)}</p>
                  <Verdicts audits={candidate.audits} />
                  <div className="sk-preview-actions">
                    <button type="button" className={`button small${riskyVerdicts(candidate.audits).length ? ' secondary' : ''}`}
                      disabled={!!actions.busy || taken.has(candidate.name)} onClick={() => add(candidate)}>
                      {taken.has(candidate.name) ? 'Added' : actions.busy ? 'Adding…' : riskyVerdicts(candidate.audits).length ? 'Add anyway' : 'Add for every Machine'}
                    </button>
                    <a className="sk-note" href={`https://skills.sh/${candidate.repo.fullName}`} target="_blank" rel="noopener noreferrer">Audit details</a>
                  </div>
                  {addFailed && actions.status?.tone === 'error' ? <p className="status-line" data-tone="error" role="status">{actions.status.text}</p> : null}
                </>
              )}
          </div>
        </div>
      ) : (
        <>
          <div className="sk-dialog-head">
            <input ref={input} type="search" placeholder="Search skills.sh" aria-label="Search skills.sh" autoComplete="off"
              value={query} onChange={(event) => setQuery(event.target.value)} />
            <button type="button" className="icon-button" aria-label="Close" onClick={onClose}><Icon name="close" /></button>
          </div>
          <ul className="sk-results">
            {results === null ? null : results.length === 0 ? (
              <li className="sk-empty">{searchError || `No skills match “${query.trim()}”`}</li>
            ) : results.map((result) => (
              <li key={`${result.source}/${result.name}`}>
                <button type="button" className="sk-result" onClick={() => setPicked(result)} disabled={taken.has(result.name)}>
                  <span className="sk-result-main"><strong>{result.name}</strong><span className="sk-src">{result.source}</span></span>
                  <span className="sk-installs">{taken.has(result.name) ? 'Added' : compact.format(result.installs)}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </dialog>
  );
}
