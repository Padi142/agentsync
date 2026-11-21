import type { Space } from '@agentsync/contract';
import { safe } from '@orpc/client';
import { useRouter } from '@tanstack/react-router';
import { useId, useRef, useState, type MouseEvent } from 'react';
import { Ago } from '../Time';
import { runSpaceAction, spaceActions, type SpaceAction } from './actions';
import { SpaceIcon } from './SpaceIcon';

export type ActionStatus = { text: string; tone: 'success' | 'error'; at: number };

/**
 * Runs dashboard actions one at a time: confirms the risky ones, reloads the page's data after,
 * and keeps a line saying how the last one went. `onDeleted` runs instead of reloading after a delete.
 */
export function useSpaceActions(onDeleted?: () => Promise<unknown>) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<ActionStatus | null>(null);
  const run = async (action: SpaceAction, space: Pick<Space, 'id' | 'expiresAt'>) => {
    if (busy || (action.confirm && !window.confirm(action.confirm))) return;
    setBusy(`${space.id}:${action.id}`);
    const [error, text] = await safe(runSpaceAction(action.id, space));
    setStatus(error
      ? { text: `${action.label} failed. Please try again.`, tone: 'error', at: Date.now() }
      : { text, tone: 'success', at: Date.now() });
    if (!error && action.id === 'delete' && onDeleted) await onDeleted();
    else await router.invalidate();
    setBusy(null);
  };
  return { run, busy, status, setStatus };
}

export type SpaceActionsApi = ReturnType<typeof useSpaceActions>;

/** A Space's status, and when it expires or is deleted. */
export function SpaceState({ space }: { space: Pick<Space, 'status' | 'expiresAt' | 'deleteAt'> }) {
  return (
    <span className="sp-state">
      <span className="sp-status" data-status={space.status}>
        {space.status === 'active' ? 'Active' : space.status === 'private' ? 'Private' : 'Expired'}
      </span>
      <span className="muted">
        {space.status === 'expired'
          ? space.deleteAt ? <>Deletes <Ago date={space.deleteAt} /></> : null
          : space.status === 'private' ? 'Link off'
          : space.expiresAt ? <>Expires <Ago date={space.expiresAt} /></> : 'Never expires'}
      </span>
    </span>
  );
}

/** The actions as buttons, for a Space's own page: the safe ones, or with `danger` the destructive ones. */
export function ActionButtons({ space, actions, danger = false }: { space: Space; actions: SpaceActionsApi; danger?: boolean }) {
  return (
    <div className="sp-actions">
      {spaceActions(space).filter((action) => !!action.danger === danger).map((action) => (
        <button key={action.id} type="button" className={`button small ${action.danger ? 'danger' : 'secondary'}`}
          disabled={!!actions.busy} onClick={() => actions.run(action, space)}>
          {actions.busy === `${space.id}:${action.id}` ? `${action.label}…` : action.label}
        </button>
      ))}
    </div>
  );
}

/** Every action behind a "More" button, for a row in the list. */
export function SpaceMenu({ space, actions }: { space: Space; actions: SpaceActionsApi }) {
  const id = useId();
  const menu = useRef<HTMLDivElement>(null);
  // The menu sits in the top layer, so no row clips it: put it under the button, right-aligned.
  const place = (event: MouseEvent<HTMLButtonElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const el = menu.current;
    if (!el) return;
    el.style.top = `${rect.bottom + 4}px`;
    el.style.right = `${Math.max(8, window.innerWidth - rect.right)}px`;
  };
  return (
    <>
      <button type="button" className="icon-button" popoverTarget={id} aria-label={`Actions for ${space.title}`}
        title="Actions" disabled={!!actions.busy} onClick={place}>
        <SpaceIcon name="more" />
      </button>
      <div ref={menu} id={id} popover="auto" className="sp-menu" role="menu" aria-label={`Actions for ${space.title}`}>
        {spaceActions(space).map((action) => (
          <button key={action.id} type="button" role="menuitem" data-danger={action.danger}
            onClick={() => { menu.current?.hidePopover?.(); void actions.run(action, space); }}>
            {action.label}
          </button>
        ))}
      </div>
    </>
  );
}
