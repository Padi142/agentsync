import { ADD_BATCH_SIZE } from '@agentsync/contract';
import { ORPCError, safe } from '@orpc/client';
import { useRouter } from '@tanstack/react-router';
import { useState } from 'react';
import { rpc } from './rpc';

type ActionMessage = { text: string; tone: 'success' | 'error' };
/** How far a bulk sync has got. `done` includes `failed`. */
export type SyncProgress = { done: number; failed: number };
type AddInput = { repo: string; name: string; machineId?: string | undefined };
type AddBatch = { repo: string; skills: Omit<AddInput, 'repo'>[] };

/** How many `addMany` calls run at once. */
const ADDS_AT_ONCE = 4;

function groupBy<T>(items: T[], key: (item: T) => string) {
  const groups = new Map<string, T[]>();
  for (const item of items) groups.set(key(item), [...(groups.get(key(item)) ?? []), item]);
  return [...groups];
}

export const progressText = ({ done, failed }: SyncProgress, total: number) =>
  `Syncing ${done} of ${total}${failed ? `, ${failed} failed` : ''}…`;

/**
 * Add skills in batches that each read their repository once, and keep going past a skill that fails.
 * Stop only when GitHub or the connection is down, as the rest would just fail too: they count as failed,
 * so they can be retried.
 */
export async function addSkills(inputs: AddInput[], onProgress?: (progress: SyncProgress) => void) {
  const queue = groupBy(inputs, (input) => input.repo).flatMap(([repo, skills]) =>
    Array.from({ length: Math.ceil(skills.length / ADD_BATCH_SIZE) }, (_, i): AddBatch => ({
      repo, skills: skills.slice(i * ADD_BATCH_SIZE, (i + 1) * ADD_BATCH_SIZE).map(({ name, machineId }) => ({ name, machineId })),
    })));
  const failed: { name: string; error: string }[] = [];
  let added = 0;
  let stopped = null as string | null;
  const report = () => onProgress?.({ done: added + failed.length, failed: failed.length });

  const addBatch = async (batch: AddBatch) => {
    const [error, result] = await safe(rpc.skills.addMany(batch));
    if (error) {
      failed.push(...batch.skills.map(({ name }) => ({ name, error: skillErrorText(error) })));
      if (!(error instanceof ORPCError) || !error.defined || error.code === 'UPSTREAM_UNAVAILABLE') stopped = skillErrorText(error);
      return;
    }
    added += result.added.length;
    failed.push(...result.failed.map(({ name, code, reason }) => ({ name, error: failureText(code, reason) })));
    const rest = batch.skills.filter(({ name }) => result.rest.includes(name));
    if (result.failed.some(({ code }) => code === 'UPSTREAM_UNAVAILABLE')) {
      stopped = failureText('UPSTREAM_UNAVAILABLE');
      failed.push(...rest.map(({ name }) => ({ name, error: stopped! })));
    } else if (rest.length) {
      queue.push({ repo: batch.repo, skills: rest });
    }
  };

  await Promise.all(Array.from({ length: ADDS_AT_ONCE }, async () => {
    while (queue.length && !stopped) {
      await addBatch(queue.shift()!);
      report();
    }
  }));
  // Batches still waiting weren't tried, which only happens once `stopped` is set.
  failed.push(...queue.flatMap((batch) => batch.skills.map(({ name }) => ({ name, error: stopped! }))));
  report();
  return { added, failed };
}

/** Every skill a repository offers at one commit, reading it a page at a time. */
export async function readCollection(repo: string) {
  const names = new Set<string>();
  let offset = 0;
  let commit: string | undefined;
  let canonical = repo;
  for (;;) {
    const page = await rpc.skills.collection({ repo, offset, commit });
    page.names.forEach((name) => names.add(name));
    canonical = page.repo;
    commit = page.commit;
    if (page.next === null) return { repo: canonical, names: [...names] };
    offset = page.next;
  }
}

export function collectionMessage({ added, failed }: Awaited<ReturnType<typeof addSkills>>): ActionMessage {
  if (!failed.length) return { text: `${added} ${added === 1 ? 'skill' : 'skills'} now syncing. Machines install them on their next skills sync.`, tone: 'success' };
  const reasons = groupBy(failed, ({ error }) => error)
    .map(([reason, skills]) => `${skills.map(({ name }) => name).join(', ')}: ${reason}`);
  return { text: `${added} synced. ${reasons.join(' ')}`, tone: 'error' };
}

/** What a failed Skills call means for the person, by the contract's code. */
function failureText(code: string, reason?: string): string {
  switch (code) {
    case 'NOT_FOUND': return 'GitHub has no such skill, or it’s gone.';
    case 'UNSUPPORTED_SKILL': return reason ?? 'GitHub has no skill folder AgentSync can install there.';
    case 'SKILL_NAME_TAKEN': return 'A Skill with this name is already in your account.';
    case 'NO_MATCHING_COMMIT': return 'That Machine’s copy matches no version on the default branch, so it can’t be synced as it is.';
    case 'UPSTREAM_UNAVAILABLE': return 'GitHub or skills.sh didn’t answer. Try again in a minute.';
    default: return 'That didn’t work. Try again.';
  }
}

/** What a failed Skills call means for the person. */
export function skillErrorText(error: unknown): string {
  if (!(error instanceof ORPCError) || !error.defined) return 'That didn’t work. Check your connection and try again.';
  return failureText(error.code, (error.data as { reason?: string } | undefined)?.reason);
}

/**
 * Run Skills changes one at a time, with a status line that answers the last one. `run` resolves to
 * whether it worked; on success the page's data reloads before the next change may start.
 */
export function useSkillActions() {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<{ text: string; tone: 'success' | 'error'; at: number } | null>(null);
  const say = (text: string, tone: 'success' | 'error' = 'success') => setStatus({ text, tone, at: Date.now() });
  /** `beforeReload` runs after success and before the data reloads, e.g. to fade out a row that leaves. */
  async function run<T>(key: string, work: () => Promise<T>, done: (result: T) => string | ActionMessage, beforeReload?: () => Promise<void>): Promise<boolean> {
    if (busy) return false;
    setBusy(key);
    try {
      const [error, result] = await safe(work());
      if (error) {
        say(skillErrorText(error), 'error');
        // A bulk action may have saved earlier batches before a later request failed.
        await router.invalidate({ sync: true });
        return false;
      }
      const message = done(result as T);
      if (typeof message === 'string') say(message);
      else say(message.text, message.tone);
      await beforeReload?.();
      // Stay busy until the page shows the new data, so the next change starts from it, not from stale state.
      await router.invalidate({ sync: true });
      return true;
    } finally {
      setBusy(null);
    }
  }
  return { busy, status, say, run };
}

export type SkillActions = ReturnType<typeof useSkillActions>;
