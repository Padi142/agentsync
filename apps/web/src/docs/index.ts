import cli from './cli.md?raw';
import conflicts from './conflicts.md?raw';
import gettingStarted from './getting-started.md?raw';
import hooks from './hooks.md?raw';
import machines from './machines.md?raw';
import templates from './templates.md?raw';

/** The docs, in reading order. Each page is Markdown; its first line is its `# Title`. */
export const DOCS = [
  { slug: 'getting-started', title: 'Getting started', body: gettingStarted },
  { slug: 'templates', title: 'Templates', body: templates },
  { slug: 'machines', title: 'Machines and Variables', body: machines },
  { slug: 'conflicts', title: 'Drift and Conflicts', body: conflicts },
  { slug: 'hooks', title: 'Hooks and agents', body: hooks },
  { slug: 'cli', title: 'The CLI', body: cli },
] as const;

export const findDoc = (slug: string) => DOCS.find((doc) => doc.slug === slug);
