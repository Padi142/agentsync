import { ORPCError } from '@orpc/client';

/** Stable exit codes. Agents and scripts branch on these, so never renumber them. */
export const EXIT = {
  ok: 0,
  error: 1,
  usage: 2,
  drift: 3,
  conflict: 4,
  auth: 5,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** An expected failure with its exit code. `details` is added to `--json` output. */
export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: ExitCode,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export const usage = (message: string) => new CliError(message, EXIT.usage);

/** The exit code for anything a command throws. */
export function exitCodeFor(error: unknown): ExitCode {
  if (error instanceof CliError) return error.exitCode;
  if (error instanceof ORPCError) {
    if (error.code === 'UNAUTHORIZED') return EXIT.auth;
    if (error.code === 'CONFLICT') return EXIT.conflict;
  }
  return EXIT.error;
}

/** A one-line explanation of a thrown error, with what to do next where we know it. */
export function describeError(error: unknown): string {
  if (error instanceof ORPCError && error.code === 'UNAUTHORIZED') {
    return 'This Machine is not registered or was revoked. Run `agentsync init` to register it again.';
  }
  if (error instanceof ORPCError && error.code === 'INVALID_TEMPLATE') {
    const issues = (error.data as { issues?: { message: string; line: number; column: number }[] })?.issues ?? [];
    const where = issues.map((issue) => `line ${issue.line}, column ${issue.column}: ${issue.message}`);
    return [error.message, ...where].join(' ');
  }
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return 'The AgentSync server did not answer in time.';
  }
  if (error instanceof TypeError && error.message === 'fetch failed') {
    return 'Could not reach the AgentSync server.';
  }
  return error instanceof Error ? error.message : String(error);
}
