import { AGENTS, detectAgents } from './agents.js';
import type { Context } from './context.js';

/** Ask a person a question until they answer with one of `choices` (matched by first letter or in full). */
export async function choose(ctx: Context, question: string, choices: string[]): Promise<string> {
  for (;;) {
    const answer = (await ctx.io.ask(question)).toLowerCase();
    const match = choices.find((choice) => choice === answer || choice[0] === answer);
    if (match) return match;
    ctx.say(`Please answer ${choices.join(', ')}.`);
  }
}

/** The agent this Machine hands Drift and Conflicts to: asked once, then remembered. */
async function handoffAgent(ctx: Context): Promise<string> {
  if (ctx.config.handoffAgent) return ctx.config.handoffAgent;
  const detected = detectAgents(ctx.io);
  const candidates = (detected.length ? detected : AGENTS).map((agent) => agent.id);
  const agent =
    candidates.length === 1
      ? candidates[0]!
      : await choose(ctx, `Which agent should take over? (${candidates.join('/')}) `, candidates);
  ctx.config.handoffAgent = agent;
  ctx.save();
  return agent;
}

/** Start this Machine's chosen agent in the terminal with `prompt`, and wait for it. */
export async function handOff(ctx: Context, prompt: string): Promise<void> {
  const agent = await handoffAgent(ctx);
  ctx.say(`Starting ${agent}…`);
  await ctx.io.launchAgent(agent, prompt);
}
