import { ORPCError } from '@orpc/client';
import { AGENTS } from '../agents.js';
import { deleteConfig } from '../config.js';
import type { Context, Outcome } from '../context.js';
import { uninstallHook } from '../hooks.js';
import { tildify } from '../paths.js';
import { machineClient, machineId } from '../session.js';
import { uninstallSkill } from '../skill.js';

/** Revoke this Machine, then remove its token, hooks and skill. Targets stay as they are. */
export async function logout(ctx: Context): Promise<Outcome> {
  try {
    await machineClient(ctx).machines.revoke({ machineId: machineId(ctx) });
  } catch (error) {
    // Already revoked, e.g. from the web app: nothing left to do on the server.
    if (!(error instanceof ORPCError && (error.code === 'UNAUTHORIZED' || error.code === 'NOT_FOUND'))) throw error;
  }
  const removed: string[] = [];
  for (const agent of AGENTS) {
    if (uninstallHook(ctx.io, agent)) removed.push(tildify(agent.hooksFile(ctx.io), ctx.io));
    if (uninstallSkill(ctx.io, agent)) removed.push(tildify(agent.skillFile(ctx.io), ctx.io));
  }
  deleteConfig(ctx.io);
  ctx.say('Revoked this Machine. Its Targets were left as they are.');
  for (const file of removed) ctx.say(`Removed AgentSync from ${file}`);
  return { data: { removed } };
}
