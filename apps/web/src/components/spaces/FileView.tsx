import type { SpaceFile } from '@agentsync/contract';
import { useEffect, useMemo, useState, type CSSProperties, type MouseEvent } from 'react';
import { defaultUrlTransform, type UrlTransform } from 'react-markdown';
import { Markdown } from '../Markdown';
import { dirOf, fileKind, formatBytes, rawDirUrl, rawUrl, resolveSpacePath, withBaseHref } from './files';
import { SpaceIcon } from './SpaceIcon';

export interface FileViewProps {
  origin: string;
  shareToken: string;
  file: SpaceFile;
  /** Every path in the Space, so Markdown links to them open in the viewer. */
  paths: ReadonlySet<string>;
  /** Show another file of the Space. */
  onOpen: (path: string) => void;
}

/** The viewer's URL for one file of the Space. */
export const viewerUrl = (origin: string, shareToken: string, path: string) =>
  `${origin}/s/${shareToken}?file=${encodeURIComponent(path)}`;

/**
 * One file, rendered by its kind. A new version replaces the old one only once it has loaded,
 * so the scroll position holds while a file updates.
 */
export function FileView(props: FileViewProps) {
  const { origin, shareToken, file } = props;
  const kind = fileKind(file);
  const src = rawUrl(origin, shareToken, file.path, file.sha256);
  if (kind === 'image') return <div className="sv-image"><img src={src} alt={file.path} /></div>;
  if (kind === 'binary') return <DownloadCard file={file} href={rawUrl(origin, shareToken, file.path)} />;
  return <TextFile {...props} kind={kind} src={src} />;
}

function TextFile({ origin, shareToken, file, paths, onOpen, kind, src }: FileViewProps & { kind: 'markdown' | 'html' | 'text'; src: string }) {
  const loaded = useRawText(src);
  const dir = dirOf(file.path);
  const transform = useMemo<UrlTransform>(() => (url, key) => {
    const safe = defaultUrlTransform(url);
    const target = resolveSpacePath(safe, dir);
    if (!target) return safe;
    return key === 'href' && paths.has(target.path)
      ? `${viewerUrl(origin, shareToken, target.path)}${target.hash}`
      : `${rawUrl(origin, shareToken, target.path)}${key === 'href' ? target.hash : ''}`;
  }, [origin, shareToken, dir, paths]);

  if (!loaded) return <p className="sv-loading" role="status">Loading…</p>;
  if ('error' in loaded) {
    return (
      <div className="sv-card" role="alert">
        <p>{file.path} could not be loaded.</p>
        <a className="button secondary small" href={rawUrl(origin, shareToken, file.path)} target="_blank" rel="noreferrer">Open raw</a>
      </div>
    );
  }
  if (kind === 'html') {
    return (
      // An opaque origin: the page's scripts run, but can't reach this app's cookies or API.
      <iframe className="sv-frame" title={file.path} sandbox="allow-scripts" referrerPolicy="no-referrer"
        srcDoc={withBaseHref(loaded.text, rawDirUrl(origin, shareToken, dir))} />
    );
  }
  if (kind === 'markdown') {
    // Links to other files of the Space open here instead of in a new tab.
    const openInViewer = (event: MouseEvent) => {
      const link = (event.target as Element).closest('a');
      if (!link || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
      const url = new URL(link.href);
      const path = url.searchParams.get('file');
      if (url.origin !== origin || url.pathname !== `/s/${shareToken}` || !path) return;
      event.preventDefault();
      onOpen(path);
    };
    return (
      <div className="sv-doc" onClick={openInViewer}>
        <Markdown urlTransform={transform}>{loaded.text}</Markdown>
      </div>
    );
  }
  return <CodeLines text={loaded.text} />;
}

/** Plain text with line numbers drawn by CSS, so copying takes only the text. */
function CodeLines({ text }: { text: string }) {
  const lines = text.replace(/\n$/, '').split('\n');
  return (
    <pre className="sv-code" tabIndex={0} style={{ '--gutter': `${String(lines.length).length + 1}ch` } as CSSProperties}>
      <code>{lines.map((line, i) => <span key={i} className="sv-line">{line}{'\n'}</span>)}</code>
    </pre>
  );
}

function DownloadCard({ file, href }: { file: SpaceFile; href: string }) {
  const name = file.path.slice(file.path.lastIndexOf('/') + 1);
  return (
    <div className="sv-card">
      <SpaceIcon name="file" size={28} />
      <p><strong>{name}</strong><span>{formatBytes(file.size)} · {file.contentType}</span></p>
      <a className="button" href={href} download={name}><SpaceIcon name="download" />Download</a>
    </div>
  );
}

type RawText = { url: string; text: string } | { url: string; error: true };

/** A URL's text. While a new URL loads, it still returns the last one's. */
function useRawText(url: string): RawText | null {
  const [state, setState] = useState<RawText | null>(null);
  useEffect(() => {
    let current = true;
    fetch(url)
      .then((response) => (response.ok ? response.text() : Promise.reject(new Error(`HTTP ${response.status}`))))
      .then((text) => current && setState({ url, text }), () => current && setState({ url, error: true }));
    return () => { current = false; };
  }, [url]);
  return state;
}
