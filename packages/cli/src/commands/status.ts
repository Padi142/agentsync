import type { Context, Outcome } from '../context.js';
import { machineClient } from '../session.js';
import { checkTarget } from '../targets.js';
import { assertValid, renderTargets } from './sync.js';

const describe = {
  missing: 'not written yet',
  current: 'up to date',
  stale: 'out of date, run agentsync sync',
  drift: 'Drift: edited by hand',
} as const;

/** This Machine, its Targets compared with the Template, and open Conflicts. Writes nothing. */
export async function status(ctx: Context): Promise<Outcome> {
  const payload = await machineClient(ctx).machines.sync();
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

  ctx.say(`Machine "${machine.name}" (${machine.os}) on ${ctx.config.server}`);
  ctx.say(template.revision ? `Template revision ${template.revision}` : 'No Template yet');
  for (const target of targets) ctx.say(`  ${target.path}: ${describe[target.status]}`);
  if (openConflicts.count) ctx.say(`${openConflicts.count} open Conflict(s): ${openConflicts.url}`);
  return {
    data: {
      server: ctx.config.server,
      machine: { id: machine.id, name: machine.name, os: machine.os },
      templateRevision: template.revision,
      targets,
      openConflicts,
    },
  };
}
