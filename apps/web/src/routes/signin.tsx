import { createFileRoute, Link, redirect } from '@tanstack/react-router';
import { useState } from 'react';
import { z } from 'zod';
import { AgentLogo } from '../components/AgentLogo';
import { highlight } from '../components/CodeEditor';
import { MarkedText } from '../components/Markdown';
import { loginHref } from '../login';
import { renderMarked } from '../preview';

export const Route = createFileRoute('/signin')({
  validateSearch: z.object({ authError: z.string().optional(), returnTo: z.string().optional() }),
  beforeLoad: ({ context }) => {
    if (context.user) throw redirect({ to: '/' });
  },
  component: SignIn,
});

const TEMPLATE = `# Notes for {{machine.nickname}}

I'm on {{machine.os}}, and my editor is {{editor}}.
{{if agent == "codex"}}
Run the tests before you say you're done.
{{else}}
Use the agentsync skill to change these notes.
{{end}}`;

const MACHINES = [
  { nickname: 'Work MacBook', os: 'macos', agent: 'claude', path: '~/.claude/CLAUDE.md', editor: 'Zed' },
  { nickname: 'home-server', os: 'linux', agent: 'codex', path: '~/.codex/AGENTS.md', editor: 'neovim' },
  { nickname: 'gaming-pc', os: 'windows', agent: 'claude', path: '~/.claude/CLAUDE.md', editor: 'VS Code' },
];

/** Every agent the CLI sets up, and the file it keeps current for each. */
const HARNESSES = [
  { agent: 'claude', name: 'Claude Code', file: '~/.claude/CLAUDE.md' },
  { agent: 'codex', name: 'Codex', file: '~/.codex/AGENTS.md' },
] as const;

function SignIn() {
  const { authError, returnTo } = Route.useSearch();
  return (
    <div className="landing">
      <section className="hero">
        <div className="hero-copy">
          <h1>One CLAUDE.md for every computer you work on.</h1>
          <p>
            Write your agent instructions once. AgentSync keeps <code>CLAUDE.md</code> and <code>AGENTS.md</code> current
            on each of your computers, and fills in what's different on each one.
          </p>
          <div className="hero-actions">
            <a className="button" href={loginHref(returnTo)}>Sign in</a>
            <Link className="button secondary" to="/docs/$page" params={{ page: 'getting-started' }}>Read the docs</Link>
          </div>
          {authError ? (
            <p className="callout error" role="status">
              {authError === 'cancelled'
                ? 'Sign-in was cancelled. You can try again.'
                : 'Sign-in could not be completed. Try again, and if it keeps failing, check the server logs.'}
            </p>
          ) : null}
          <ul className="harnesses" aria-label="Works with">
            {HARNESSES.map((harness) => (
              <li key={harness.agent}>
                <AgentLogo agent={harness.agent} size={28} />
                <span>
                  <strong>{harness.name}</strong>
                  <code>{harness.file}</code>
                </span>
              </li>
            ))}
          </ul>
        </div>
        <Demo />
      </section>

      <ol className="how">
        <li>
          <h2>Write one Template</h2>
          <p>Markdown with a few Expressions, like <code>{'{{machine.os}}'}</code>, for what differs per computer.</p>
        </li>
        <li>
          <h2>Register your computers</h2>
          <p>One command, or a prompt you paste into Claude Code or Codex. It finds your agents and their files.</p>
        </li>
        <li>
          <h2>Start a session</h2>
          <p>A hook fetches the latest Template when an agent starts, fills it in, and writes the file.</p>
        </li>
      </ol>
    </div>
  );
}

/** The real renderer, on example Machines: the violet text is what changes from one to the next. */
function Demo() {
  const [index, setIndex] = useState(0);
  const machine = MACHINES[index]!;
  const result = renderMarked(TEMPLATE, {
    variables: { editor: machine.editor },
    builtins: { machine: { nickname: machine.nickname, hostname: machine.nickname, os: machine.os }, agent: machine.agent },
  });
  return (
    <figure className="demo" aria-label="Example: one Template rendered for three Machines">
      <div className="demo-template">
        <div className="demo-caption"><span>Your Template</span></div>
        <pre>{TEMPLATE.split('\n').map((line, i) => <div key={i}>{highlight(line)}{line ? null : ' '}</div>)}</pre>
      </div>
      <div className="demo-output">
        <div className="demo-caption">
          <div className="demo-machines" role="group" aria-label="Machine">
            {MACHINES.map((m, i) => (
              <button key={m.nickname} type="button" aria-pressed={i === index} onClick={() => setIndex(i)}>{m.nickname}</button>
            ))}
          </div>
          <code>{machine.path}</code>
        </div>
        <MarkedText key={index} text={result.text} ranges={result.ranges} />
      </div>
    </figure>
  );
}
