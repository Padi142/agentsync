import type { Context, Outcome } from '../context.js';
import { usage } from '../exit.js';
import { checkedNickname } from '../nickname.js';
import { machineClient } from '../session.js';

/** `rename <nickname>`: change this Machine's nickname on the server. Writes no Targets. */
export async function rename(ctx: Context): Promise<Outcome> {
  if (ctx.args.length !== 1) throw usage('Usage: agentsync rename <nickname>. Quote a nickname with spaces.');
  const name = await checkedNickname(ctx.args[0]!);
  const client = machineClient(ctx);
  // Only the nickname: sending Targets too could overwrite a newer list with a stale one.
  const machine = await ctx.during('Saving…', () => client.machines.update({ machineId: ctx.config.machineId!, nickname: name }));
  ctx.success(`Machine nickname saved: ${machine.nickname}`);
  ctx.say('Run `agentsync sync` to apply name-dependent Template changes.');
  return { data: { machine: { id: machine.id, nickname: machine.nickname, hostname: machine.hostname } } };
}
