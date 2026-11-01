import { ORPCError } from '@orpc/client';
import { deleteConfig } from '../config.js';
import type { Context, Outcome } from '../context.js';
import { uninstallHooks } from '../hooks.js';
import { tildify } from '../paths.js';
import { machineClient, machineId } from '../session.js';
import { uninstallSkills } from '../skill.js';

/**
 * Revoke this Machine, then remove its token and the hooks and skill files AgentSync installed
 * that nobody changed since. Targets and installed Skills stay as they are.
 */
export async function logout(ctx: Context): Promise<Outcome> {
  try {
    await machineClient(ctx).machines.revoke({ machineId: machineId(ctx) });
  } catch (error) {
    // Already revoked, e.g. from the web app: nothing left to do on the server.
    if (!(error instanceof ORPCError && (error.code === 'UNAUTHORIZED' || error.code === 'NOT_FOUND'))) throw error;
  }
  const hooks = uninstallHooks(ctx);
  const skills = uninstallSkills(ctx);
  const removed = [...hooks.removed, ...skills.removed].map((file) => tildify(file, ctx.io));
  const kept = [...hooks.kept, ...skills.kept].map((file) => tildify(file, ctx.io));
  // Installed Skills stay; only AgentSync's record of them goes with the config.
  const leftSkills = Object.keys(ctx.config.managedSkills ?? {});
  deleteConfig(ctx.io);
  ctx.say('Revoked this Machine. Its Targets were left as they are.');
  if (leftSkills.length) ctx.say(`Left ${leftSkills.join(', ')} installed; AgentSync no longer manages them.`);
  for (const file of removed) ctx.say(`Removed AgentSync from ${file}`);
  for (const file of kept) ctx.warn(`Kept ${file}: it was changed since AgentSync installed it.`);
  return { data: { removed, kept, leftSkills } };
}
