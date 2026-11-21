import { SPACE_PUBLIC_ROUTES, type PublicSpace, type SpaceFile } from '@agentsync/contract';
import { Link } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { CopyButton } from '../Copy';
import { BrandMark, Icon } from '../Icon';
import { FileView, viewerUrl } from './FileView';
import { buildTree, formatBytes, pickFile, rawUrl, type TreeNode } from './files';
import { useLiveSpace, type Loaded } from './live';
import { SpaceIcon } from './SpaceIcon';

/** Below this width the file tree is a drawer over the file, closed until asked for. */
const NARROW = '(max-width: 760px)';

/**
 * The public page of a Share Link. One file fills the window under a small floating bar; two or
 * more get a file tree beside the open one. `requested` is the `file` search param, and `onSelect`
 * changes it, so a link can point at one file.
 */
export function SpaceViewer({ shareToken, initial, requested, onSelect }: {
  shareToken: string;
  initial: Loaded;
  requested: string | undefined;
  onSelect: (path: string) => void;
}) {
  const [live, setLive] = useState(true);
  const { state, connected } = useLiveSpace(shareToken, initial, live);
  if (state.kind === 'unavailable') return <Unavailable reason={state.reason} />;
  return (
    <Viewer shareToken={shareToken} space={state.space} requested={requested} onSelect={onSelect}
      live={live} connected={connected} onLive={setLive} />
  );
}

export function Unavailable({ reason }: { reason: 'missing' | 'expired' }) {
  return (
    <div className="sv-gone">
      <section className="appear" role="alert">
        <Link to="/" className="sv-brand" aria-label="AgentSync"><BrandMark /></Link>
        <h1>{reason === 'expired' ? 'This link has expired' : 'This Space isn’t available'}</h1>
        <p>{reason === 'expired' ? 'Ask whoever shared it to revive it.' : 'The link may be wrong, or it was turned off.'}</p>
      </section>
    </div>
  );
}

function Viewer({ shareToken, space, requested, onSelect, live, connected, onLive }: {
  shareToken: string;
  space: PublicSpace;
  requested: string | undefined;
  onSelect: (path: string) => void;
  live: boolean;
  connected: boolean;
  onLive: (live: boolean) => void;
}) {
  const origin = window.location.origin;
  const { file, missing } = pickFile(space.files, requested);
  const multi = space.files.length > 1;
  const [sidebar, setSidebar] = useState(() => !window.matchMedia?.(NARROW).matches);
  const paths = useMemo(() => new Set(space.files.map((f) => f.path)), [space.files]);
  const updated = useUpdated(file);
  const removed = useRemoved(file?.path, paths);
  const open = (path: string) => {
    removed.clear();
    onSelect(path);
    if (window.matchMedia?.(NARROW).matches) setSidebar(false);
  };
  const link = file && requested !== undefined && !missing ? viewerUrl(origin, shareToken, file.path) : space.shareUrl;

  return (
    <div className="sv" data-layout={multi ? 'tree' : 'single'} data-sidebar={multi && sidebar ? 'open' : 'closed'}>
      <aside className="sv-side" aria-label="Files" inert={!multi || !sidebar}>
        <div className="sv-side-inner">
          <header className="sv-side-head">
            <Link to="/" className="sv-brand" aria-label="AgentSync"><BrandMark /></Link>
            <strong title={space.title}>{space.title}</strong>
          </header>
          {space.summary ? <p className="sv-summary">{space.summary}</p> : null}
          <FileTree files={space.files} selected={file?.path} onOpen={open} />
          <p className="sv-side-foot">{space.files.length} files · {formatBytes(space.totalBytes)}</p>
        </div>
      </aside>
      {multi && sidebar ? <button type="button" className="sv-scrim" aria-label="Close files" onClick={() => setSidebar(false)} /> : null}

      <section className="sv-main">
        <header className="sv-bar">
          {multi ? (
            <>
              <button type="button" className="icon-button" aria-label={sidebar ? 'Hide files' : 'Show files'}
                aria-expanded={sidebar} title={sidebar ? 'Hide files' : 'Show files'} onClick={() => setSidebar(!sidebar)}>
                <SpaceIcon name="sidebar" />
              </button>
              <code className="sv-path" title={file?.path}>{file?.path}</code>
            </>
          ) : null}
          <span className="sv-bar-end">
            {updated ? <span key={updated} className="sv-updated" role="status">Updated</span> : null}
            <button type="button" className="sv-live" aria-pressed={live} onClick={() => onLive(!live)}
              title={live ? 'Pause live updates' : 'Resume live updates'}>
              <span className="sv-live-dot" data-state={!live ? 'off' : connected ? 'on' : 'connecting'} aria-hidden="true" />
              {live ? 'Live' : 'Paused'}
            </button>
            <CopyButton text={link} label="Copy link" />
            {file ? (
              <a className="icon-button" href={rawUrl(origin, shareToken, file.path)} target="_blank" rel="noreferrer"
                aria-label="Open raw file" title="Open raw file"><SpaceIcon name="external" /></a>
            ) : null}
            <a className="icon-button" href={SPACE_PUBLIC_ROUTES.zip(shareToken)} download aria-label="Download all as ZIP"
              title="Download all as ZIP"><SpaceIcon name="download" /></a>
          </span>
        </header>
        {removed.path || missing ? (
          <p className="sv-notice appear" role="status">
            <Icon name="warning" size={14} />
            <span>
              <code>{removed.path ?? missing}</code> {removed.path ? 'was deleted' : 'isn’t in this Space'}
              {file ? <>, so this is <code>{file.path}</code></> : null}.
            </span>
          </p>
        ) : null}
        <div className="sv-content" key={file?.path} data-kind={file ? undefined : 'empty'}>
          {file ? <FileView origin={origin} shareToken={shareToken} file={file} paths={paths} onOpen={open} />
            : <p className="sv-loading">Nothing here yet. Files show up as they’re added.</p>}
        </div>
      </section>
    </div>
  );
}

/** A changing value while the open file was just replaced by a newer version, for a moment. */
function useUpdated(file: SpaceFile | undefined) {
  const last = useRef(file);
  const [flash, setFlash] = useState<string | null>(null);
  useEffect(() => {
    const before = last.current;
    last.current = file;
    if (file && before && before.path === file.path && before.sha256 !== file.sha256) setFlash(file.sha256);
  }, [file]);
  useEffect(() => {
    if (!flash) return;
    const timer = setTimeout(() => setFlash(null), 2400);
    return () => clearTimeout(timer);
  }, [flash]);
  return flash;
}

/** The path of the file that was open until it was deleted, until another file is opened. */
function useRemoved(shown: string | undefined, paths: ReadonlySet<string>) {
  const last = useRef(shown);
  const [path, setPath] = useState<string | null>(null);
  useEffect(() => {
    if (last.current && last.current !== shown && !paths.has(last.current)) setPath(last.current);
    last.current = shown;
  }, [shown, paths]);
  return { path, clear: () => setPath(null) };
}

function FileTree({ files, selected, onOpen }: { files: SpaceFile[]; selected: string | undefined; onOpen: (path: string) => void }) {
  const tree = useMemo(() => buildTree(files), [files]);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  // Opening a file inside a closed folder, e.g. from a link, opens its folders.
  useEffect(() => {
    if (!selected) return;
    setCollapsed((was) => {
      const open = [...was].filter((folder) => !selected.startsWith(`${folder}/`));
      return open.length === was.size ? was : new Set(open);
    });
  }, [selected]);
  const toggle = (path: string) => setCollapsed((was) => {
    const next = new Set(was);
    if (!next.delete(path)) next.add(path);
    return next;
  });
  const render = (nodes: TreeNode<SpaceFile>[], depth: number) => (
    <ul className="sv-tree" role={depth ? 'group' : undefined}>
      {nodes.map((node) => (
        <li key={node.path}>
          {node.kind === 'folder' ? (
            <>
              <button type="button" className="sv-node" style={{ paddingLeft: 8 + depth * 14 }}
                aria-expanded={!collapsed.has(node.path)} onClick={() => toggle(node.path)}>
                <Icon name="chevron" size={12} />
                <span>{node.name}</span>
              </button>
              {collapsed.has(node.path) ? null : render(node.children, depth + 1)}
            </>
          ) : (
            <button type="button" className="sv-node" style={{ paddingLeft: 26 + depth * 14 }} title={node.path}
              aria-current={node.path === selected ? 'page' : undefined} onClick={() => onOpen(node.path)}>
              <span>{node.name}</span>
            </button>
          )}
        </li>
      ))}
    </ul>
  );
  return <nav className="sv-files" aria-label="Files in this Space">{render(tree, 0)}</nav>;
}
