import { ORPCError, safe } from '@orpc/client';
import { useRouter } from '@tanstack/react-router';
import { useState } from 'react';
import { rpc } from './rpc';

type ActionMessage = { text: string; tone: 'success' | 'error' };

/** Each add has its own Worker budget. Keep successes and report failures so a collection can be retried. */
export async function addSkills(inputs: { repo: string; name: string; machineId?: string }[], onProgress?: (done: number) => void) {
  const failed: { name: string; error: string }[] = [];
  let added = 0;
  for (const input of inputs) {
    const [error] = await safe(rpc.skills.add(input));
    if (error) failed.push({ name: input.name, error: skillErrorText(error) });
    else added++;
    onProgress?.(added + failed.length);
  }
  return { added, failed };
}

export function collectionMessage({ added, failed }: Awaited<ReturnType<typeof addSkills>>): ActionMessage {
  return failed.length
    ? { text: `${added} added. ${failed.length} couldn’t be added: ${failed.map(({ name }) => name).join(', ')}. Open the collection to retry.`, tone: 'error' }
    : { text: `${added} ${added === 1 ? 'skill' : 'skills'} added. Machines install them on their next skills sync.`, tone: 'success' };
}

/** What a failed Skills call means for the person. */
export function skillErrorText(error: unknown): string {
  if (!(error instanceof ORPCError) || !error.defined) return 'That didn’t work. Check your connection and try again.';
  switch (error.code) {
    case 'NOT_FOUND': return 'GitHub has no such skill, or it’s gone.';
    case 'UNSUPPORTED_SKILL': return (error.data as { reason?: string })?.reason ?? 'GitHub has no skill folder AgentSync can install there.';
    case 'SKILL_NAME_TAKEN': return 'A Skill with this name is already in your account.';
    case 'NO_MATCHING_COMMIT': return 'That Machine’s copy matches no version on the default branch, so it can’t be added as it is.';
    case 'UPSTREAM_UNAVAILABLE': return 'GitHub or skills.sh didn’t answer. Try again in a minute.';
    default: return 'That didn’t work. Try again.';
  }
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
