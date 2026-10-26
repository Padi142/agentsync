/** This server, as the CLI should reach it. */
export const serverUrl = () => window.location.origin;

/** Until the CLI is published to npm, it runs from a clone of this repository. */
export const repoUrl = 'https://github.com/Padi142/agentsync.git';

/** Builds the CLI from a clone, puts `agentsync` on PATH, and registers this computer with this server. */
export const installCommand = (server = serverUrl()) =>
  `git clone ${repoUrl} ~/agentsync && cd ~/agentsync && pnpm install && pnpm build && (cd packages/cli && npm link) && agentsync init --server ${server}`;
