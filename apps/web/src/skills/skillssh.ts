import type { Audit, Audits, SkillSearchResult } from '@agentsync/contract';
import { auditRiskSchema } from '@agentsync/contract';
import { z } from 'zod';
import { UpstreamError } from './github';

const TIMEOUT_MS = 8000;

async function get(url: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, { headers: { 'user-agent': 'agentsync' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (error) {
    throw new UpstreamError(`skills.sh did not answer: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) throw new UpstreamError(`skills.sh answered ${response.status}.`);
  return await (response.json() as Promise<unknown>).catch((error: unknown) => {
    throw new UpstreamError(`skills.sh did not answer: ${error instanceof Error ? error.message : String(error)}`);
  });
}

const searchResponse = z.object({
  skills: z.array(z.object({ source: z.string(), name: z.string(), installs: z.number().int().min(0).catch(0) })),
});

/** Search skills.sh by text. */
export async function searchSkills(query: string): Promise<SkillSearchResult[]> {
  const body = searchResponse.parse(await get(`https://skills.sh/api/search?${new URLSearchParams({ q: query, limit: '20' })}`));
  return body.skills.map(({ source, name, installs }) => ({ source, name, installs }));
}

const verdict = z.object({ risk: auditRiskSchema, analyzedAt: z.coerce.date() }).nullable().catch(null);
const auditResponse = z.record(
  z.string(),
  z.object({ ath: verdict.optional(), socket: verdict.optional(), snyk: verdict.optional() }).catch({}),
);

const noAudits: Audits = { gen: null, socket: null, snyk: null };

/**
 * The skills.sh verdicts (Gen, Socket, Snyk) for skills of one repository, by name. They are keyed by
 * the `owner/repo` string, so always ask with the canonical name: an old name returns frozen verdicts.
 */
export async function fetchAudits(fullName: string, names: string[]): Promise<Map<string, Audits>> {
  const query = new URLSearchParams({ source: fullName, skills: names.join(',') });
  const body = auditResponse.parse(await get(`https://www.skills.sh/tele/audit?${query}`));
  const pick = (audit: Audit | null | undefined) => (audit ? { risk: audit.risk, analyzedAt: audit.analyzedAt } : null);
  return new Map(names.map((name) => {
    const entry = body[name];
    return [name, entry ? { gen: pick(entry.ath), socket: pick(entry.socket), snyk: pick(entry.snyk) } : noAudits];
  }));
}
