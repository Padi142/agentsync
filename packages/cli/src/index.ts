#!/usr/bin/env node

const command = process.argv[2] ?? 'help';

if (command === 'help' || command === '--help' || command === '-h') {
  console.log(`AgentSync CLI (scaffold)

Usage:
  agentsync init       Show the future setup flow
  agentsync status     Show the future local status
  agentsync sync       Show the future sync flow

The sync engine and hook integration are not implemented yet.`);
} else if (command === '--version' || command === '-v') {
  console.log('0.1.0');
} else if (command === 'init' || command === 'status' || command === 'sync') {
  console.error(
    `AgentSync ${command} is not implemented in this scaffold. No files were changed.`,
  );
  process.exitCode = 2;
} else {
  console.error(`Unknown command: ${command}. Run agentsync --help.`);
  process.exitCode = 1;
}
