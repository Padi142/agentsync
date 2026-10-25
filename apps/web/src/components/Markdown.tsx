import { Link } from '@tanstack/react-router';
import type { Element, ElementContent, Root, RootContent, Text } from 'hast';
import type { ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { MarkedRange } from '../preview';
import { CopyButton } from './Copy';

type Position = NonNullable<Text['position']>;

/**
 * Wrap the parts of text nodes that fall inside `ranges` (offsets into the Markdown source) in
 * `<mark>`. A text node's own position maps it straight onto the source; text without one, such
 * as code, is found inside its nearest positioned ancestor. Text that can't be placed exactly,
 * like an escaped character, is marked whole when it overlaps a range.
 */
function rehypeMarks(ranges: MarkedRange[]) {
  return (tree: Root, file: { value: unknown }) => {
    if (!ranges.length) return;
    const source = String(file.value);
    const marked = (value: string, name: string): Element => ({
      type: 'element', tagName: 'mark', properties: { className: ['machine-value'], title: `From {{${name}}}` },
      children: [{ type: 'text', value }],
    });
    const split = (node: Text, around: Position): ElementContent[] => {
      const from = around.start.offset ?? 0;
      const to = around.end.offset ?? from;
      const hits = ranges.filter((r) => r.start < to && r.end > from);
      if (!hits.length || !node.value) return [node];
      const slice = source.slice(from, to);
      const at = slice === node.value ? 0 : slice.indexOf(node.value);
      if (at < 0) return [marked(node.value, hits[0]!.name)];
      const base = from + at;
      const out: ElementContent[] = [];
      let cursor = 0;
      for (const hit of hits) {
        const start = Math.max(hit.start - base, cursor);
        const end = Math.min(hit.end - base, node.value.length);
        if (end <= start) continue;
        if (start > cursor) out.push({ type: 'text', value: node.value.slice(cursor, start) });
        out.push(marked(node.value.slice(start, end), hit.name));
        cursor = end;
      }
      if (cursor < node.value.length) out.push({ type: 'text', value: node.value.slice(cursor) });
      return out;
    };
    const walk = (parent: Root | Element, inherited: Position | undefined) => {
      const around = parent.position ?? inherited;
      parent.children = (parent.children as RootContent[]).flatMap((child): RootContent[] => {
        if (child.type === 'text') {
          const position = child.position ?? around;
          return position ? split(child, position) : [child];
        }
        if (child.type === 'element') walk(child, around);
        return [child];
      }) as typeof parent.children;
    };
    walk(tree, undefined);
  };
}

/**
 * Show raw HTML as the text it is. Instructions often use XML-style tags such as `<rules>`, and
 * dropping them (the default) would hide part of the file.
 */
function remarkHtmlAsText() {
  return (tree: { children?: unknown[] }) => {
    const visit = (node: { type?: string; children?: unknown[] }) => {
      if (node.type === 'html') node.type = 'text';
      node.children?.forEach((child) => visit(child as typeof node));
    };
    visit(tree);
  };
}

const textOf = (node: Element | ElementContent | undefined): string =>
  !node ? '' : node.type === 'text' ? node.value : 'children' in node ? node.children.map(textOf).join('') : '';

export const slug = (text: string) =>
  text.toLowerCase().replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-');

const childrenText = (children: ReactNode): string =>
  Array.isArray(children) ? children.map(childrenText).join('') : typeof children === 'string' ? children : '';

const components: Components = {
  pre: ({ node, children }) => (
    <div className="code-block">
      <pre>{children}</pre>
      <CopyButton text={textOf(node?.children[0]).replace(/\n$/, '')} label="Copy code" />
    </div>
  ),
  a: ({ href = '', children }) =>
    href.startsWith('/') ? <Link to={href as never}>{children}</Link>
      : href.startsWith('#') ? <a href={href}>{children}</a>
      : <a href={href} target="_blank" rel="noreferrer">{children}</a>,
  table: ({ children }) => <div className="table-scroll"><table>{children}</table></div>,
};

/** Docs headings get ids, so they can be linked to. */
const anchored: Components = {
  ...components,
  h2: ({ children }) => <h2 id={slug(childrenText(children))}>{children}</h2>,
  h3: ({ children }) => <h3 id={slug(childrenText(children))}>{children}</h3>,
};

/**
 * GitHub-flavored Markdown as React elements. Raw HTML in the source is shown as text, never
 * run. `ranges` marks text that came from Variables (see `renderMarked`).
 */
export function Markdown({ children, ranges = [], anchors = false, className = 'prose' }: {
  children: string;
  ranges?: MarkedRange[];
  anchors?: boolean;
  className?: string;
}) {
  return (
    <div className={className}>
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkHtmlAsText]} rehypePlugins={[[rehypeMarks, ranges]]}
        components={anchors ? anchored : components}>
        {children}
      </ReactMarkdown>
    </div>
  );
}

/** Plain text with the same Variable marks, for the "Text" view of a preview. */
export function MarkedText({ text, ranges }: { text: string; ranges: MarkedRange[] }) {
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.start > cursor) parts.push(text.slice(cursor, range.start));
    parts.push(<mark key={range.start} className="machine-value" title={`From {{${range.name}}}`}>{text.slice(range.start, range.end)}</mark>);
    cursor = range.end;
  }
  parts.push(text.slice(cursor));
  return <pre className="rendered-text">{parts}</pre>;
}
