import type { Context, Outcome } from '../context.js';
import { machineClient } from '../session.js';
import { checkTarget } from '../targets.js';
import { assertValid, renderTargets } from './sync.js';

const describe = {
  missing: 'Not written yet',
  current: 'Current',
  stale: 'Out of date',
  drift: 'Drift',
} as const;

/** Below this width each Target gets its own lines instead of one row. */
const NARROW_COLUMNS = 60;

/** This Machine, its Targets compared with the Template, and open Conflicts. Writes nothing. */
export async function status(ctx: Context): Promise<Outcome> {
  const payload = await ctx.during('Fetching the Template…', () => machineClient(ctx).machines.sync());
  const { machine, template, openConflicts } = payload;
  if (template.revision > 0) assertValid(template.text);
  const targets = renderTargets(ctx, payload).map(({ target, path, rendered }) => {
    const lastWritten = ctx.config.written[target.path];
    const check =
      template.revision === 0
        ? { status: 'current' as const }
        : checkTarget({ path, rendered, ...(lastWritten === undefined ? {} : { lastWritten }) });
    return { path: target.path, agent: target.agent, ...check };
  });

  const paint = ctx.paint.out;
  ctx.say(`Machine ${paint.bold(machine.nickname)} (${machine.hostname}) · ${template.revision ? `Template revision ${template.revision}` : 'no Template yet'}`);
  ctx.detail(`Server ${ctx.config.server} · ${machine.os}`);
  const narrow = (ctx.io.columns ?? 80) < NARROW_COLUMNS;
  const agentWidth = Math.max(0, ...targets.map((target) => target.agent.length));
  const pathWidth = Math.max(0, ...targets.map((target) => target.path.length));
  for (const target of targets) {
    const color = target.status === 'current' ? paint.green : target.status === 'drift' ? paint.yellow : (text: string) => text;
    const word = color(describe[target.status]);
    if (narrow) ctx.say(`  ${target.agent}: ${word}\n    ${target.path}`);
    else ctx.say(`  ${target.agent.padEnd(agentWidth)}  ${target.path.padEnd(pathWidth)}  ${word}`);
  }
  if (targets.some((target) => target.status !== 'current')) ctx.say('Run `agentsync sync` to update this Machine.');
  if (openConflicts.count) ctx.warn(`${openConflicts.count} open Conflict(s): ${openConflicts.url}`);
  return {
    data: {
      server: ctx.config.server,
      machine: { id: machine.id, nickname: machine.nickname, hostname: machine.hostname, os: machine.os },
      templateRevision: template.revision,
      targets,
      openConflicts,
    },
  };
}
