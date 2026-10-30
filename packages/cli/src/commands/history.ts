import { basename } from 'node:path';
import { findAgent } from '../agents.js';
import type { Context, Outcome } from '../context.js';
import { usage } from '../exit.js';
import { readHistory, type HistoryEntry, type TargetChange } from '../history.js';
import type { Palette } from '../style.js';
import { backupPath } from '../targets.js';

const DEFAULT_LIMIT = 10;

function ago(at: Date, now: Date): string {
  const minutes = Math.floor((now.getTime() - at.getTime()) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

const pad = (n: number) => String(n).padStart(2, '0');
const local = (at: Date) =>
  `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;

function triggerLabel(entry: HistoryEntry): string {
  if (entry.trigger === 'hook') return `${findAgent(entry.hookAgent ?? '')?.name ?? entry.hookAgent} session start`;
  return `agentsync ${entry.trigger}`;
}

/** Why a Target changed: what moved since AgentSync last wrote it. */
function reason(entry: HistoryEntry, change: TargetChange): string {
  const at = `Template revision ${entry.templateRevision}`;
  if (change.action === 'created') return `created from ${at}`;
  if (change.action === 'replaced') return `${at} replaced a hand edit, kept in ${basename(backupPath(change.path))}`;
  const { previous } = change;
  if (!previous) return `updated to ${at}`;
  const moved = [
    previous.template !== entry.templateRevision && `Template revision ${entry.templateRevision} (was ${previous.template})`,
    previous.variables !== entry.variablesRevision && `Variables revision ${entry.variablesRevision} (was ${previous.variables})`,
  ].filter(Boolean);
  return moved.length ? moved.join(', ') : `re-Rendered ${at}: this Machine's nickname, hostname or OS changed`;
}

/** `+added -removed` lines. */
function sizeOf(diff: string, paint: Palette): string {
  const lines = diff.split('\n');
  const count = (sign: string) => lines.filter((line) => line.startsWith(sign)).length;
  return `${paint.green(`+${count('+')}`)} ${paint.red(`-${count('-')}`)}`;
}

/** Every change AgentSync made to this Machine's Targets, newest first. Local only: it needs no server. */
export async function history(ctx: Context): Promise<Outcome> {
  const limit = ctx.flags.limit === undefined ? DEFAULT_LIMIT : Number(ctx.flags.limit);
  if (!Number.isInteger(limit) || limit < 1) throw usage('--limit must be a whole number above 0.');
  const agents = new Set(ctx.flags.agent);

  const entries = readHistory(ctx.io).flatMap((entry) => {
    const changes = agents.size ? entry.changes.filter((change) => agents.has(change.agent)) : entry.changes;
    return changes.length ? [{ ...entry, changes }] : [];
  });
  const newest = entries.reverse().slice(0, limit);

  if (!newest.length) {
    ctx.say(`AgentSync has not changed ${agents.size ? 'those' : 'any'} Targets on this Machine yet.`);
  } else {
    const paint = ctx.paint.out;
    const now = new Date();
    ctx.say('Changes AgentSync made to the Targets on this Machine, newest first:');
    for (const entry of newest) {
      const at = new Date(entry.at);
      ctx.say(`\n${paint.bold(ago(at, now))} (${local(at)}) · ${triggerLabel(entry)}`);
      const width = Math.max(...entry.changes.map((change) => change.path.length));
      for (const change of entry.changes) {
        const size = change.diff === null ? '(diff too large to keep)' : sizeOf(change.diff, paint);
        ctx.say(`  ${change.path.padEnd(width)}  ${reason(entry, change)}  ${size}`);
        if (!ctx.flags.verbose || change.diff === null) continue;
        for (const line of change.diff.trimEnd().split('\n')) {
          const color = line.startsWith('+') ? paint.green : line.startsWith('-') ? paint.red : (text: string) => text;
          ctx.say(`    ${color(line)}`);
        }
      }
    }
    const more = entries.length - newest.length;
    const hints = [!ctx.flags.verbose && '--verbose for the diffs', more > 0 && `--limit ${entries.length} for ${more} more`];
    const hint = hints.filter(Boolean).join(', ');
    if (hint) ctx.say(`\nRun \`agentsync history\` with ${hint}.`);
  }
  return { data: { entries: newest, total: entries.length } };
}
