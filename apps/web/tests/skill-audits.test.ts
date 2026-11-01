import type { AuditRisk, Audits } from '@agentsync/contract';
import { describe, expect, it } from 'vitest';
import { isAudited, mayAutoUpdate } from '../src/skills/audits';

const pushedAt = new Date('2026-10-01T12:00:00Z');
const after = new Date('2026-10-01T12:00:30Z');
const before = new Date('2026-10-01T11:59:00Z');
const audits = (risk: AuditRisk = 'safe', analyzedAt = after): Audits => ({
  gen: { risk, analyzedAt },
  socket: { risk: 'safe', analyzedAt },
  snyk: { risk: 'low', analyzedAt },
});

describe('the audit hold-back rule', () => {
  it('counts a version as audited when all three verdicts came after the push that brought it', () => {
    expect(isAudited(audits(), pushedAt)).toBe(true);
    expect(isAudited(audits('safe', pushedAt), pushedAt)).toBe(true);
  });

  it('does not when a verdict is missing or older than the push', () => {
    expect(isAudited({ ...audits(), snyk: null }, pushedAt)).toBe(false);
    expect(isAudited({ ...audits(), socket: { risk: 'safe', analyzedAt: before } }, pushedAt)).toBe(false);
    expect(isAudited(audits(), null)).toBe(false);
  });

  it('updates automatically only to an audited version rated below High', () => {
    expect(mayAutoUpdate(audits('medium'), pushedAt)).toBe(true);
    expect(mayAutoUpdate(audits('high'), pushedAt)).toBe(false);
    expect(mayAutoUpdate(audits('critical'), pushedAt)).toBe(false);
    expect(mayAutoUpdate(audits('safe', before), pushedAt)).toBe(false);
  });
});
