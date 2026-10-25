import type { Context, Outcome } from '../context.js';
import { machineClient, machineId } from '../session.js';
import { changeVariables, parseAssignments } from '../variables.js';

/** Show this Machine's Variables, or change them with `--var KEY=VALUE` and `--unset KEY`. */
export async function vars(ctx: Context): Promise<Outcome> {
  const client = machineClient(ctx);
  const set = parseAssignments(ctx.flags.var);
  const changing = Object.keys(set).length > 0 || ctx.flags.unset.length > 0;
  const result = changing
    ? await changeVariables(client, machineId(ctx), set, ctx.flags.unset)
    : await client.variables.get({ machineId: machineId(ctx) });
  if (changing) ctx.say(`Saved Variables revision ${result.revision}. Run \`agentsync sync\` to apply them.`);
  else for (const [name, value] of Object.entries(result.variables)) ctx.say(`${name}=${value}`);
  return { data: { variables: result.variables, revision: result.revision } };
}
