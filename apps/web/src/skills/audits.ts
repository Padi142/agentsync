import type { AuditRisk, Audits } from '@agentsync/contract';

const order: readonly AuditRisk[] = ['safe', 'low', 'medium', 'high', 'critical'];

/** The worst verdict of the three, or `null` if there is none. */
export function worstRisk(audits: Audits): AuditRisk | null {
  const risks = [audits.gen, audits.socket, audits.snyk].flatMap((audit) => (audit ? [audit.risk] : []));
  return risks.length ? risks.reduce((worst, risk) => (order.indexOf(risk) > order.indexOf(worst) ? risk : worst)) : null;
}

/** High or Critical: an automatic update holds it back, and a manual one asks "Update anyway". */
export const isRisky = (audits: Audits) => order.indexOf(worstRisk(audits) ?? 'safe') >= order.indexOf('high');

/**
 * Whether skills.sh audited the newest version of a folder. Its verdicts are per skill, not per commit,
 * so a version counts as audited only if all three scanners have a verdict and each was made at or after
 * `pushedAt`: the repository's `pushed_at` when the update check first saw this version as the newest.
 * GitHub sets `pushed_at`, so it can't be faked like a commit date. A push to another branch also moves
 * it, which only ever holds a version back.
 */
export function isAudited(audits: Audits, pushedAt: Date | null): boolean {
  if (!pushedAt) return false;
  return [audits.gen, audits.socket, audits.snyk].every((audit) => audit !== null && audit.analyzedAt >= pushedAt);
}

/** An automatic update moves a Pin only to an audited version rated below High. */
export const mayAutoUpdate = (audits: Audits, pushedAt: Date | null) => isAudited(audits, pushedAt) && !isRisky(audits);
