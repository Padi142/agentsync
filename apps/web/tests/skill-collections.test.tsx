// @vitest-environment jsdom
import type { Skill, SkillsOverview } from '@agentsync/contract';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CollectionDialog } from '../src/components/CollectionDialog';
import { SkillCollections } from '../src/components/SkillCollections';
import { useSkillActions } from '../src/skill-actions';

const api = vi.hoisted(() => ({ add: vi.fn(), setIgnored: vi.fn(), collection: vi.fn(), audits: vi.fn(), invalidate: vi.fn(), browse: vi.fn(), clear: vi.fn(), close: vi.fn() }));
vi.mock('../src/rpc', () => ({ rpc: { skills: api } }));
vi.mock('@tanstack/react-router', () => ({ useRouter: () => ({ invalidate: api.invalidate }) }));
vi.mock('../src/components/SkillDetail', () => ({ SkillDetail: () => <div>Skill details</div> }));

const synced: Skill = {
  id: 's1', name: 'tdd', repo: { id: 1, fullName: 'matt/skills' }, path: 'tdd', assignment: { to: 'all' }, autoUpdate: true, update: null, createdAt: new Date(0),
  pin: { commit: 'a'.repeat(40), treeSha: 'a'.repeat(40), installedHash: 'a'.repeat(40), committedAt: new Date(0) },
  machines: [{ machineId: 'laptop', status: 'installed' }],
};
const overview: SkillsOverview = {
  settings: { autoUpdate: false }, skills: [],
  found: [
    { kind: 'github', name: 'animate', source: 'emilkowalski/skill', machines: [{ machineId: 'laptop', ref: null }] },
    { kind: 'github', name: 'apple-design', source: 'emilkowalski/skill', machines: [{ machineId: 'laptop', ref: null }] },
    { kind: 'github', name: 'find-skills', source: 'vercel-labs/skills', machines: [{ machineId: 'laptop', ref: null }] },
  ],
  ignored: [{ repo: 'emilkowalski/skill', name: 'break-ui' }],
  machines: [{ id: 'laptop', nickname: 'Laptop', checkedInAt: null }],
};

const audit = { risk: 'safe' as const, analyzedAt: new Date(0) };

function Library({ data = overview, query = '' }: { data?: SkillsOverview; query?: string }) {
  const actions = useSkillActions();
  return <><SkillCollections overview={data} actions={actions} query={query} onClearQuery={api.clear} onBrowse={api.browse} /><p role="status">{actions.status?.text}</p></>;
}
function Picker() {
  const actions = useSkillActions();
  return <CollectionDialog repo="emilkowalski/skill" onClose={api.close} overview={overview} actions={actions} />;
}

beforeEach(() => {
  vi.clearAllMocks();
  api.invalidate.mockResolvedValue(undefined);
  api.setIgnored.mockResolvedValue(undefined);
  api.add.mockResolvedValue({ name: 'animate', pin: { commit: 'a'.repeat(40) } });
  api.audits.mockImplementation(async ({ names }: { names: string[] }) => names.map((name) => ({ name, audits: { gen: audit, socket: audit, snyk: audit } })));
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
});
afterEach(cleanup);

describe('the Skills lists', () => {
  it('restores an entire repository larger than one API batch', async () => {
    const ignored = Array.from({ length: 501 }, (_, i) => ({ repo: 'large/collection', name: `skill-${i}` }));
    render(<Library data={{ ...overview, found: [], ignored }} />);
    fireEvent.click(screen.getByRole('button', { name: '501 ignored' }));
    fireEvent.click(screen.getByRole('button', { name: 'Restore all' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('501 skills restored'));
    expect(api.setIgnored.mock.calls.map(([input]) => input.names.length)).toEqual([500, 1]);
    expect(api.setIgnored.mock.calls.flatMap(([input]) => input.names)).toEqual(expect.arrayContaining(ignored.map(({ name }) => name)));
  });

  it('keeps found skills out of Needs you, and tucks them away once something is synced', () => {
    const { rerender } = render(<Library />);
    expect(screen.queryByRole('region', { name: 'Needs you' })).toBeNull();
    expect(screen.getByRole('button', { name: /^emilkowalski\/skill,/ })).toBeTruthy();
    rerender(<Library data={{ ...overview, skills: [synced] }} />);
    expect(screen.queryByRole('button', { name: /^emilkowalski\/skill,/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show' }));
    expect(screen.getByRole('button', { name: /^emilkowalski\/skill,/ })).toBeTruthy();
  });

  it('search reveals only matching skills, and the repository action covers only those', () => {
    render(<Library query="apple" />);
    expect(screen.getByRole('button', { name: 'Sync apple-design' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Sync animate' })).toBeNull();
    expect(screen.queryByRole('button', { name: /vercel-labs/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Sync 1 skill from emilkowalski/skill' })).toBeTruthy();
  });

  it('confirms a bulk sync, naming flagged skills, keeps Machine versions and reports partial failures', async () => {
    api.audits.mockResolvedValueOnce([
      { name: 'animate', audits: { gen: audit, socket: audit, snyk: { risk: 'high', analyzedAt: new Date(0) } } },
      { name: 'apple-design', audits: { gen: audit, socket: audit, snyk: audit } },
    ]);
    api.add.mockResolvedValueOnce({ name: 'animate' }).mockRejectedValueOnce(new Error('offline'));
    render(<Library />);
    fireEvent.click(screen.getByRole('button', { name: 'Sync 2 skills from emilkowalski/skill' }));
    expect(api.add).not.toHaveBeenCalled();
    const flagged = await screen.findByRole('list', { name: 'Skills with High or Critical audits', hidden: true });
    expect(flagged.textContent).toContain('animate');
    expect(flagged.textContent).not.toContain('apple-design');
    fireEvent.click(screen.getByRole('button', { name: 'Sync anyway', hidden: true }));
    await screen.findByText(/1 synced\. 1 couldn’t sync: apple-design/);
    expect(api.add.mock.calls.map(([input]) => input)).toEqual([
      { repo: 'emilkowalski/skill', name: 'animate', machineId: 'laptop' },
      { repo: 'emilkowalski/skill', name: 'apple-design', machineId: 'laptop' },
    ]);
  });

  it('still allows a bulk sync when audits can’t be checked, and says so', async () => {
    api.audits.mockRejectedValueOnce(new Error('down'));
    render(<Library />);
    fireEvent.click(screen.getByRole('button', { name: 'Sync 2 skills from emilkowalski/skill' }));
    await screen.findByText('Couldn’t check security audits right now.');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Sync 2 skills', hidden: true }).disabled).toBe(false);
  });

  it('syncs a lone skill without asking', async () => {
    render(<Library />);
    fireEvent.click(screen.getByRole('button', { name: 'Sync 1 skill from vercel-labs/skills' }));
    await waitFor(() => expect(api.add).toHaveBeenCalledExactlyOnceWith({ repo: 'vercel-labs/skills', name: 'find-skills', machineId: 'laptop' }));
    expect(api.audits).not.toHaveBeenCalled();
  });

  it('restores ignored skills', async () => {
    render(<Library />);
    fireEvent.click(screen.getByRole('button', { name: '1 ignored' }));
    fireEvent.click(screen.getByRole('button', { name: /emilkowalski\/skill, 1 skill/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(api.setIgnored).toHaveBeenCalledWith({ repo: 'emilkowalski/skill', names: ['break-ui'], ignored: false }));
  });

  it('browses every repository page with nothing ticked, and leaving a skill unticked ignores nothing', async () => {
    api.collection.mockResolvedValueOnce({ repo: 'emilkowalski/skill', commit: 'a'.repeat(40), names: ['animate', 'apple-design'], next: 20 })
      .mockResolvedValueOnce({ repo: 'emilkowalski/skill', commit: 'a'.repeat(40), names: ['break-ui', 'new-upstream'], next: null });
    render(<Picker />);
    const animate = await screen.findByRole<HTMLInputElement>('checkbox', { name: /animate/, hidden: true });
    expect(screen.getAllByRole<HTMLInputElement>('checkbox', { hidden: true }).every((box) => !box.checked)).toBe(true);
    fireEvent.click(animate);
    fireEvent.click(screen.getByRole('button', { name: 'Sync 1 skill', hidden: true }));
    await waitFor(() => expect(api.close).toHaveBeenCalledTimes(1));
    expect(api.collection).toHaveBeenLastCalledWith({ repo: 'emilkowalski/skill', offset: 20, commit: 'a'.repeat(40) });
    expect(api.setIgnored).not.toHaveBeenCalled();
    expect(api.add).toHaveBeenCalledExactlyOnceWith({ repo: 'emilkowalski/skill', name: 'animate', machineId: 'laptop' });
  });
});
