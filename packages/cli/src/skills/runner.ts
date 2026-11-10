import { gitShaSchema, repoNameSchema, skillNameSchema } from '@agentsync/contract';
import type { Agent } from '../agents.js';
import type { Context } from '../context.js';

/** What `skills add --json` says about each skill. */
interface AddResult {
  name?: unknown;
  status?: unknown;
  /** Why it was `skipped`. */
  reason?: unknown;
  /** Why it `failed`. */
  error?: unknown;
}

/** Throw unless every argument is one decision 24 allows: names, `owner/repo` and full SHAs, none starting with `-`. */
function checked(repo: string, commit: string, names: readonly string[]) {
  if (!repoNameSchema.safeParse(repo).success) throw new Error(`"${repo}" is not a GitHub owner/repo.`);
  if (!gitShaSchema.safeParse(commit).success) throw new Error(`"${commit}" is not a commit SHA.`);
  for (const name of names) if (!skillNameSchema.safeParse(name).success) throw new Error(`"${name}" is not a valid Skill name.`);
}

const lastLine = (text: string) => text.trim().split('\n').filter(Boolean).at(-1) ?? '';

/**
 * Install `names` from `repo` at `commit` for `agents` in one `skills add` (one clone). Returns each
 * name's outcome as `skills` reports it: `installed`, or an error to show. The caller checks the disk.
 */
export async function addSkills(ctx: Context, repo: string, commit: string, names: readonly string[], agents: readonly string[]) {
  checked(repo, commit, names);
  const { code, stdout, stderr } = await ctx.io.runSkills([
    'add', `${repo}#${commit}`, '--skill', ...names, '-g', '-a', ...agents, '-y', '--json',
  ]);
  let results: AddResult[] = [];
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (Array.isArray(parsed)) results = parsed as AddResult[];
  } catch {
    // Not JSON: `skills` failed before it could say anything per skill.
  }
  const fallback = lastLine(stderr) || lastLine(stdout) || `skills exited with code ${code}.`;
  return new Map(names.map((name): [string, { ok: true } | { ok: false; error: string }] => {
    const result = results.find((entry) => entry.name === name);
    if (result?.status === 'installed') return [name, { ok: true }];
    const why = typeof result?.error === 'string' ? result.error : typeof result?.reason === 'string' ? result.reason : fallback;
    return [name, { ok: false, error: why }];
  }));
}

/**
 * The `skills` agents whose global directory is one AgentSync manages: `~/.agents/skills` and Claude
 * Code's `skills/`. `skills remove -a` deletes `<name>` from each agent's global directory, so OpenCode,
 * whose own is `~/.config/opencode/skills` (the person's, never AgentSync's), must not be one of them.
 */
const REMOVE_AGENTS = ['claude-code', 'codex', 'pi'] as const satisfies readonly Agent['skillsAgent'][];

/**
 * Remove `names` with `skills remove`, from both directories AgentSync manages, so no copy of them is left.
 * It always exits 0 and has no `--json`: the caller checks the disk afterwards.
 */
export async function removeSkills(ctx: Context, names: readonly string[]) {
  for (const name of names) if (!skillNameSchema.safeParse(name).success) throw new Error(`"${name}" is not a valid Skill name.`);
  await ctx.io.runSkills(['remove', ...names, '-g', '-y', '-a', ...REMOVE_AGENTS]);
}
