import { AGENTS, detectAgents } from './agents.js';
import type { Context } from './context.js';

/** The agent this Machine hands Drift and Conflicts to: asked once, then remembered. */
async function handoffAgent(ctx: Context): Promise<string> {
  if (ctx.config.handoffAgent) return ctx.config.handoffAgent;
  const detected = detectAgents(ctx.io);
  const candidates = detected.length ? detected : AGENTS;
  const agent =
    candidates.length === 1
      ? candidates[0]!.id
      : await ctx.select(
          'Which agent should take over? AgentSync remembers this choice.',
          candidates.map((agent) => ({ value: agent.id, label: agent.name, hint: `runs \`${agent.id}\`` })),
          candidates[0]!.id,
        );
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
