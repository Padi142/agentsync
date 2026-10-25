import { createFileRoute, Link } from '@tanstack/react-router';
import prompt from '../../../../../packages/cli/setup-prompt.md?raw';
import { Command, CopyBlock } from '../../components/Copy';
import { Icon } from '../../components/Icon';
import { serverUrl } from '../../commands';

export const Route = createFileRoute('/_app/setup')({ component: Setup });

function Setup() {
  const server = serverUrl();
  return (
    <div className="page">
      <Link className="back-link" to="/machines"><Icon name="back" size={14} />Machines</Link>
      <header className="page-head">
        <div>
          <h1>Add a Machine</h1>
          <p>
            Register a computer so its agents get your Template. On your first Machine, its existing
            <code> CLAUDE.md</code> or <code>AGENTS.md</code> becomes the Template.
          </p>
        </div>
      </header>

      <div className="setup-grid">
        <section className="setup-path" aria-labelledby="agent-path">
          <h2 id="agent-path">Ask your agent</h2>
          <p>
            Paste this into Claude Code or Codex on the computer you're adding. It installs the CLI, asks you to approve
            the sign-in, and tells you what it set up.
          </p>
          <CopyBlock label="Agent setup prompt" title="Setup prompt" text={prompt.replaceAll('<SERVER_URL>', server)} />
        </section>

        <section className="setup-path" aria-labelledby="cli-path">
          <h2 id="cli-path">Or run it yourself</h2>
          <ol className="steps">
            <li>
              <p>Install the CLI and register the computer. Needs Node.js 22.12 or later.</p>
              <Command command={`npm install -g agentsync && agentsync init --server ${server}`} label="Install command" />
            </li>
            <li>
              <p>Open the sign-in link it prints and approve the code.</p>
              <p className="muted">It then installs a hook for each agent it finds, and writes your Template into their files.</p>
            </li>
            <li>
              <p>Using Codex? Trust the new hook once: open Codex and run <code>/hooks</code>.</p>
            </li>
          </ol>
          <p className="muted">
            After that, every agent session fetches the latest Template when it starts, and a change applies from the session after. <Link to="/docs/$page" params={{ page: 'cli' }}>See every command</Link>
          </p>
        </section>
      </div>
    </div>
  );
}
