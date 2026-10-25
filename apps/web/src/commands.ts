/** This server, as the CLI should reach it. */
export const serverUrl = () => window.location.origin;

/** Installs the CLI and registers this computer with this server. */
export const installCommand = (server = serverUrl()) => `npm install -g agentsync && agentsync init --server ${server}`;
