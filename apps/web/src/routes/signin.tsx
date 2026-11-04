import { createFileRoute, Link, redirect } from '@tanstack/react-router';
import { useState } from 'react';
import { z } from 'zod';
import { AgentLogo } from '../components/AgentLogo';
import { highlight } from '../components/CodeEditor';
import { Icon } from '../components/Icon';
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
  { agent: 'pi', name: 'pi', file: '~/.pi/agent/AGENTS.md' },
] as const;

/** Example rows for the Skills section, worded like the real Skills page. */
const SKILLS = [
  {
    name: 'frontend-design', repo: 'anthropics/skills', commit: 'b81d07e', installed: 3, update: 'e4c92a1',
    verdicts: [['Gen', 'Safe'], ['Socket', 'Safe'], ['Snyk', 'Low']],
  },
  { name: 'animate', repo: 'emilkowalski/skill', commit: '3f2a91c', installed: 3 },
  { name: 'find-skills', repo: 'vercel-labs/skills', commit: '9c04d1e', installed: 2 },
];

function SignIn() {
  const { authError, returnTo } = Route.useSearch();
  return (
    <div className="landing">
      <section className="hero">
        <div className="hero-copy">
          <h1>One agent setup for every computer.</h1>
          <p>
            Write your agent instructions once and pick your Skills. AgentSync keeps both current on each of your
            computers, and fills in what's different on each one.
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

      <section className="skills-band">
        <div className="skills-copy">
          <h2>The same Skills everywhere.</h2>
          <p>
            Add them from <a href="https://skills.sh">skills.sh</a>, or sync the ones already on your computers, then choose
            which computers get each one.
          </p>
          <ul>
            <li>
              <strong>Updates you can check</strong>
              Each Skill stays at an exact commit. An update shows the changed files and audits from Gen, Socket and Snyk.
            </li>
            <li>
              <strong>Installed when you say so</strong>
              Agents only tell you what's waiting. <code>agentsync skills sync</code> installs it.
            </li>
            <li>
              <strong>Your own skills are safe</strong>
              AgentSync never touches skills you wrote, and keeps your hand edits unless you choose to overwrite them.
            </li>
          </ul>
          <Link to="/docs/$page" params={{ page: 'skills' }}>How Skills work</Link>
        </div>
        <SkillsDemo />
      </section>

      <ol className="how">
        <li>
          <h2>Write one Template</h2>
          <p>Markdown with a few Expressions, like <code>{'{{machine.os}}'}</code>, for what differs per computer.</p>
        </li>
        <li>
          <h2>Register your computers</h2>
          <p>One command, or a prompt you paste into Claude Code, Codex or pi. It finds your agents and their files.</p>
        </li>
        <li>
          <h2>Start a session</h2>
          <p>A hook fetches the latest Template when an agent starts, fills it in, writes the file, and tells you when Skills are waiting.</p>
        </li>
      </ol>
    </div>
  );
}

/** The real renderer, on example Machines: the violet text is what changes from one to the next. */
function Demo() {
  const [index, setIndex] = useState(0);
  // It shows each Machine in turn until you pick one.
  const [auto, setAuto] = useState(true);
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
              <button key={m.nickname} type="button" aria-pressed={i === index} onClick={() => { setIndex(i); setAuto(false); }}>{m.nickname}</button>
            ))}
          </div>
          <code>{machine.path}</code>
        </div>
        <MarkedText key={index} text={result.text} ranges={result.ranges} />
      </div>
      {/* The bar is the timer: each pass shows the next Machine, so CSS can pause both together (see .demo-progress). */}
      <div className="demo-progress" data-stopped={auto ? undefined : true} aria-hidden="true">
        <span onAnimationIteration={() => setIndex((i) => (i + 1) % MACHINES.length)} />
      </div>
    </figure>
  );
}

/** A static picture of the Skills page, and the one command that installs what it shows. */
function SkillsDemo() {
  return (
    <figure className="skills-demo" aria-label="Example: three pinned Skills and the command that installs them">
      <ul>
        {SKILLS.map((skill) => (
          <li key={skill.name}>
            <span className="skills-demo-name">
              <strong>{skill.name}</strong>
              <code>{skill.repo} @ {skill.commit}</code>
            </span>
            <span className="skills-demo-machines">{skill.installed} of 3 machines</span>
            {skill.update ? <span className="skills-demo-update">Update to {skill.update}</span> : skill.installed === 3 ? <Icon name="check" /> : null}
            {skill.verdicts ? (
              <span className="sk-verdicts">
                {skill.verdicts.map(([scanner, risk]) => <span key={scanner} className="sk-verdict" data-risk={risk.toLowerCase()}>{scanner} <b>{risk}</b></span>)}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
      <pre>
        <span className="skills-demo-prompt">$ </span>agentsync skills sync{'\n'}
        <span className="skills-demo-output">Installed find-skills @ 9c04d1e</span>
      </pre>
    </figure>
  );
}
