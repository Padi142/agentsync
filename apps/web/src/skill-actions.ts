import { ORPCError, safe } from '@orpc/client';
import { useRouter } from '@tanstack/react-router';
import { useState } from 'react';

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
 * whether it worked; on success the page's data reloads.
 */
export function useSkillActions() {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<{ text: string; tone: 'success' | 'error'; at: number } | null>(null);
  const say = (text: string, tone: 'success' | 'error' = 'success') => setStatus({ text, tone, at: Date.now() });
  /** `beforeReload` runs after success and before the data reloads, e.g. to fade out a row that leaves. */
  async function run<T>(key: string, work: () => Promise<T>, done: (result: T) => string, beforeReload?: () => Promise<void>): Promise<boolean> {
    if (busy) return false;
    setBusy(key);
    const [error, result] = await safe(work());
    setBusy(null);
    if (error) {
      say(skillErrorText(error), 'error');
      return false;
    }
    say(done(result as T));
    await beforeReload?.();
    await router.invalidate();
    return true;
  }
  return { busy, status, say, run };
}

export type SkillActions = ReturnType<typeof useSkillActions>;
