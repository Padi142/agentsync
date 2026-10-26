import { machineOsSchema, type Machine } from '@agentsync/contract';
import { BUILTIN_VARIABLES } from '@agentsync/template';
import type { Suggestion } from './components/CodeEditor';

/** The agents the CLI sets up, offered even before any Machine has a Target for them. */
const AGENTS = ['claude', 'codex', 'pi'];

/** The Variables set on any Machine, for suggesting next to the Built-in ones. */
export function ownVariables(variables: readonly Record<string, string>[], machines: number): Suggestion[] {
  return ownNames(variables).map((name) => {
    const count = variables.filter((v) => Object.hasOwn(v, name)).length;
    return { name, description: count === machines ? 'Set on every Machine' : `Set on ${count} of ${machines} Machines` };
  });
}

/**
 * What a condition might compare each Variable with: the values your Machines have, plus every
 * OS and agent there is. `variables` holds each Machine's Variables, in `machines` order.
 */
export function conditionValues(machines: readonly Machine[], variables: readonly Record<string, string>[] = []) {
  const values: Record<string, Suggestion[]> = {
    'machine.nickname': tally(machines.map((m) => [m.nickname, m.hostname]), (on) => `Hostname ${on.join(', ')}`),
    'machine.hostname': tally(machines.map((m) => [m.hostname, m.nickname]), listMachines),
    'machine.os': tally(machines.map((m) => [m.os, m.nickname]), listMachines, machineOsSchema.options),
    agent: tally(
      machines.flatMap((m) => [...new Set(m.targets.map((t) => t.agent))].map((agent) => [agent, m.nickname] as const)),
      listMachines, AGENTS),
  };
  for (const name of ownNames(variables)) {
    const set = machines.flatMap((m, i) => {
      const value = variables[i]?.[name];
      return value === undefined ? [] : [[value, m.nickname] as const];
    });
    values[name] = tally(set, (on) => `Set on ${listMachines(on)}`);
  }
  return values;
}

function ownNames(variables: readonly Record<string, string>[]) {
  return [...new Set(variables.flatMap((v) => Object.keys(v)))]
    .filter((name) => !BUILTIN_VARIABLES.some((b) => b.name === name))
    .sort();
}

/** Each value once, described by the labels of the Machines that have it. */
function tally(pairs: Iterable<readonly [value: string, label: string]>, describe: (labels: string[]) => string,
  known: readonly string[] = []): Suggestion[] {
  const labels = new Map<string, string[]>(known.map((value) => [value, []]));
  for (const [value, label] of pairs) {
    // A quoted value can't hold a quote or a line break, and a long one is no use in a list.
    if (!value || /["\n]/.test(value) || value.length > 80) continue;
    labels.set(value, [...(labels.get(value) ?? []), label]);
  }
  return [...labels].map(([name, on]) => ({ name, description: describe(on) }));
}

function listMachines(nicknames: string[]) {
  if (nicknames.length === 0) return 'No Machine yet';
  if (nicknames.length <= 3) return nicknames.join(', ');
  return `${nicknames.slice(0, 2).join(', ')} and ${nicknames.length - 2} more`;
}
