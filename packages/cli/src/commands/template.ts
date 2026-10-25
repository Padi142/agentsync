import type { Context, Outcome } from '../context.js';
import { writeText } from '../files.js';
import { expandHome } from '../paths.js';
import { machineClient } from '../session.js';

/** Print the Template, or write it to `--out`. */
export async function template(ctx: Context): Promise<Outcome> {
  const { text, revision } = await machineClient(ctx).template.get();
  if (ctx.flags.out) {
    writeText(expandHome(ctx.flags.out, ctx.io), text);
    ctx.say(`Wrote Template revision ${revision} to ${ctx.flags.out}.`);
    return { data: { revision } };
  }
  if (!ctx.flags.json) ctx.io.out(text.replace(/\n$/, ''));
  return { data: { revision, text } };
}
