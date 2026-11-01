// @vitest-environment jsdom
import type { SkillsOverview } from '@agentsync/contract';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CollectionDialog } from '../src/components/CollectionDialog';
import { SkillCollections } from '../src/components/SkillCollections';
import { useSkillActions } from '../src/skill-actions';

const api = vi.hoisted(() => ({ add: vi.fn(), setIgnored: vi.fn(), collection: vi.fn(), invalidate: vi.fn(), browse: vi.fn(), close: vi.fn() }));
vi.mock('../src/rpc', () => ({ rpc: { skills: api } }));
vi.mock('@tanstack/react-router', () => ({ useRouter: () => ({ invalidate: api.invalidate }) }));
vi.mock('../src/components/SkillDetail', () => ({ SkillDetail: () => <div>Skill details</div> }));

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

function Library({ data = overview }: { data?: SkillsOverview }) {
  const actions = useSkillActions();
  return <><SkillCollections overview={data} actions={actions} onAddCollection={api.browse} /><p role="status">{actions.status?.text}</p></>;
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
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
});
afterEach(cleanup);

describe('collection controls', () => {
  it('restores an entire collection larger than one API batch', async () => {
    const ignored = Array.from({ length: 501 }, (_, i) => ({ repo: 'large/collection', name: `skill-${i}` }));
    render(<Library data={{ ...overview, found: [], ignored }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Ignored 501' }));
    fireEvent.click(screen.getByRole('button', { name: 'Restore all' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('501 skills restored'));
    expect(api.setIgnored.mock.calls.map(([input]) => input.names.length)).toEqual([500, 1]);
    expect(api.setIgnored.mock.calls.flatMap(([input]) => input.names)).toEqual(expect.arrayContaining(ignored.map(({ name }) => name)));
  });
  it('starts compact, expands collections, and search reveals only matching skills', () => {
    render(<Library />);
    expect(screen.queryByRole('checkbox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }));
    expect(screen.getByRole('checkbox', { name: 'Select animate' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Collapse all' }));
    expect(screen.queryByRole('checkbox')).toBeNull();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'apple' } });
    expect(screen.getByRole('checkbox', { name: 'Select apple-design' })).toBeTruthy();
    expect(screen.queryByRole('checkbox', { name: 'Select animate' })).toBeNull();
    expect(screen.queryByRole('button', { name: /vercel-labs/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Collapse all' }));
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('selects a collection, preserves Machine versions and reports partial failures without losing successes', async () => {
    api.add.mockResolvedValueOnce({ name: 'animate' }).mockRejectedValueOnce(new Error('offline'));
    render(<Library />);
    fireEvent.click(screen.getByRole('button', { name: /emilkowalski\/skill/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Select all available/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Add selected (2)' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('1 added. 1 couldn’t be added: apple-design'));
    expect(api.add.mock.calls.map(([input]) => input)).toEqual([
      { repo: 'emilkowalski/skill', name: 'animate', machineId: 'laptop' },
      { repo: 'emilkowalski/skill', name: 'apple-design', machineId: 'laptop' },
    ]);
    expect(api.invalidate).toHaveBeenCalledTimes(1);
  });

  it('restores excluded skills through the Ignored view', async () => {
    render(<Library />);
    fireEvent.click(screen.getByRole('button', { name: 'Ignored 1' }));
    fireEvent.click(screen.getByRole('button', { name: /emilkowalski\/skill/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(api.setIgnored).toHaveBeenCalledWith({ repo: 'emilkowalski/skill', names: ['break-ui'], ignored: false }));
  });

  it('reads every repository page, remembers exclusions and saves unchecked skills before adding', async () => {
    api.collection.mockResolvedValueOnce({ repo: 'emilkowalski/skill', commit: 'a'.repeat(40), names: ['animate', 'apple-design'], next: 20 })
      .mockResolvedValueOnce({ repo: 'emilkowalski/skill', commit: 'a'.repeat(40), names: ['break-ui'], next: null });
    render(<Picker />);
    await screen.findByRole('button', { name: 'Add 2 skills' });
    const animate = screen.getByRole('checkbox', { name: 'animate' });
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: /break-ui/ }).checked).toBe(false);
    fireEvent.click(animate);
    fireEvent.click(screen.getByRole('button', { name: 'Add 1 skill' }));
    await waitFor(() => expect(api.close).toHaveBeenCalledTimes(1));
    expect(api.collection).toHaveBeenLastCalledWith({ repo: 'emilkowalski/skill', offset: 20, commit: 'a'.repeat(40) });
    expect(api.setIgnored).toHaveBeenCalledWith({ repo: 'emilkowalski/skill', names: ['animate', 'break-ui'], ignored: true });
    expect(api.add).toHaveBeenCalledExactlyOnceWith({ repo: 'emilkowalski/skill', name: 'apple-design', machineId: 'laptop' });
  });
});
