import { createFileRoute, Link, notFound } from '@tanstack/react-router';
import { serverUrl } from '../commands';
import { Markdown } from '../components/Markdown';
import { DOCS, findDoc } from '../docs';

export const Route = createFileRoute('/docs/$page')({
  loader: ({ params }) => {
    const doc = findDoc(params.page);
    if (!doc) throw notFound();
    return doc;
  },
  head: ({ loaderData }) => ({ meta: [{ title: `${loaderData?.title ?? 'Docs'} – AgentSync docs` }] }),
  component: DocPage,
  notFoundComponent: () => (
    <article className="docs-article">
      <div className="prose">
        <h1>No such page</h1>
        <p>That page isn't in the docs. <Link to="/docs/$page" params={{ page: 'getting-started' }}>Start with Getting started</Link>.</p>
      </div>
    </article>
  ),
});

function DocPage() {
  const doc = Route.useLoaderData();
  const index = DOCS.findIndex((d) => d.slug === doc.slug);
  const previous = DOCS[index - 1];
  const next = DOCS[index + 1];
  return (
    <article className="docs-article">
      <Markdown anchors>{doc.body.replaceAll('<SERVER_URL>', serverUrl())}</Markdown>
      <nav className="docs-pager" aria-label="More docs">
        {previous ? (
          <Link to="/docs/$page" params={{ page: previous.slug }}><span>Previous</span>{previous.title}</Link>
        ) : null}
        {next ? (
          <Link to="/docs/$page" params={{ page: next.slug }}><span>Next</span>{next.title}</Link>
        ) : null}
      </nav>
    </article>
  );
}
