import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import prompt from '../../../../../packages/cli/setup-prompt.md?raw';
import { copyText } from '../../copy';

export const Route = createFileRoute('/_app/setup')({ component: Setup });

function Setup() {
  // This server, as the CLI should reach it.
  const server = window.location.origin;
  const install = `npm install -g agentsync && agentsync init --server ${server}`;
  return (
    <div className="stack">
      <section className="panel">
        <h1>Set up a Machine</h1>
        <p className="muted">
          Register a computer so it Renders your Template into its agents' instruction files. Either run
          the CLI yourself, or give the prompt below to an agent on that computer.
        </p>
        <h2>Run it yourself</h2>
        <p className="muted">Needs Node.js 22.12 or later. It opens a sign-in link to approve this computer.</p>
        <Copyable label="Install command" text={install} />
      </section>
      <section className="panel">
        <h2>Or ask your agent</h2>
        <p className="muted">
          Paste this into Claude Code or Codex on the computer to set up. It runs the same CLI and asks you to
          approve the sign-in.
        </p>
        <Copyable label="Agent setup prompt" text={prompt.replaceAll('<SERVER_URL>', server)} />
      </section>
    </div>
  );
}

function Copyable({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    setCopied(await copyText(text));
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <div className="copyable">
      <pre className="rendered" aria-label={label}>{text}</pre>
      <button className="button secondary" type="button" onClick={copy}>
        {copied ? 'Copied' : `Copy ${label.toLowerCase()}`}
      </button>
    </div>
  );
}
