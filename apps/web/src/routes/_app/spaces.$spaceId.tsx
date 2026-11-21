import { parseShareUrl, SPACE_OWNER_ROUTES, type SpaceDetail, type SpaceFile } from '@agentsync/contract';
import { safe } from '@orpc/client';
import { createFileRoute, Link, useRouter } from '@tanstack/react-router';
import { useState } from 'react';
import { CopyButton } from '../../components/Copy';
import { Icon } from '../../components/Icon';
import { viewerUrl } from '../../components/spaces/FileView';
import { formatBytes } from '../../components/spaces/files';
import { ActionButtons, SpaceState, useSpaceActions } from '../../components/spaces/SpaceActions';
import { SpaceIcon } from '../../components/spaces/SpaceIcon';
import { Ago } from '../../components/Time';
import { useOwnNavigate } from '../../navigation';
import { rpc } from '../../rpc';

export const Route = createFileRoute('/_app/spaces/$spaceId')({
  loader: ({ params: { spaceId } }) => rpc.spaces.get({ spaceId }),
  component: SpacePage,
});

/**
 * The owner's file list for a Space in any status (active, private or expired). Active Spaces open
 * in the viewer; private and expired Spaces open through the session-authenticated owner raw route,
 * and every Space offers per-file and ZIP downloads.
 */
export function SpaceFilesSection({ space, removing, onRemove }: {
  space: Pick<SpaceDetail, 'id' | 'status' | 'shareUrl' | 'fileCount' | 'totalBytes' | 'files'>;
  removing: string | null;
  onRemove: (file: SpaceFile) => void;
}) {
  const link = space.status === 'active' ? parseShareUrl(space.shareUrl) : null;
  return (
    <section className="section">
      <div className="section-head sp-files-head">
        <div>
          <h2>Files</h2>
          <p>{space.fileCount === 1 ? '1 file' : `${space.fileCount} files`} · {formatBytes(space.totalBytes)}</p>
        </div>
        {space.files.length ? (
          <a className="button secondary small" href={SPACE_OWNER_ROUTES.zip(space.id)} download>
            <SpaceIcon name="download" />Download ZIP
          </a>
        ) : null}
      </div>
      {space.files.length ? (
        <ul className="sp-files" aria-label="Files">
          {space.files.map((file) => {
            const ownerRaw = SPACE_OWNER_ROUTES.raw(space.id, file.path);
            const openHref = link ? viewerUrl(link.origin, link.shareToken, file.path) : ownerRaw;
            const fileName = file.path.slice(file.path.lastIndexOf('/') + 1);
            return (
              <li key={file.path}>
                <a className="sp-file-path" href={openHref} target="_blank" rel="noreferrer"
                  title={link ? 'Open in the viewer' : 'Open file'}><code>{file.path}</code></a>
                <span className="sp-file-meta">
                  <span>{formatBytes(file.size)}</span>
                  <span className="sp-file-type">{file.contentType}</span>
                  <Ago date={file.updatedAt} />
                </span>
                <span className="sp-file-actions">
                  <a className="icon-button" href={ownerRaw} download={fileName}
                    aria-label={`Download ${file.path}`} title="Download file">
                    <SpaceIcon name="download" />
                  </a>
                  <button type="button" className="icon-button" aria-label={`Delete ${file.path}`} title="Delete file"
                    disabled={removing !== null} onClick={() => onRemove(file)}>
                    <SpaceIcon name="trash" />
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
      ) : <p className="muted">No files yet.</p>}
    </section>
  );
}

function SpacePage() {
  const space = Route.useLoaderData();
  const router = useRouter();
  const navigate = useOwnNavigate();
  const actions = useSpaceActions(() => navigate({ to: '/spaces' }));
  const { status, setStatus } = actions;
  const [removing, setRemoving] = useState<string | null>(null);
  const link = space.status === 'active' ? parseShareUrl(space.shareUrl) : null;

  const removeFile = async (file: SpaceFile) => {
    if (removing || !window.confirm(`Delete ${file.path} from this Space?`)) return;
    setRemoving(file.path);
    const [error] = await safe(rpc.spaces.deleteFile({ spaceId: space.id, path: file.path }));
    setStatus(error
      ? { text: `Deleting ${file.path} failed. Please try again.`, tone: 'error', at: Date.now() }
      : { text: `Deleted ${file.path}.`, tone: 'success', at: Date.now() });
    await router.invalidate();
    setRemoving(null);
  };

  return (
    <div className="page">
      <Link className="back-link" to="/spaces"><Icon name="back" size={14} />Spaces</Link>
      <header className="page-head sp-detail-head">
        <div>
          <h1>{space.title}</h1>
          {space.summary ? <p>{space.summary}</p> : null}
        </div>
        <SpaceState space={space} />
      </header>
      <div className="sp-line" role="status">
        {status ? <span key={status.at} className="status-line appear" data-tone={status.tone}>{status.text}</span> : null}
      </div>

      <div className="machine-layout">
        <SpaceFilesSection space={space} removing={removing} onRemove={removeFile} />

        <aside className="aside">
          <section>
            <h2>Share Link</h2>
            {link ? (
              <div className="command-line sp-link"><code>{space.shareUrl}</code><CopyButton text={space.shareUrl} label="Copy Share Link" /></div>
            ) : (
              <p className="muted">{space.status === 'private' ? 'Off while the Space is private.' : 'Stopped working when the Space expired.'}</p>
            )}
          </section>
          <section>
            <h2>About this Space</h2>
            <dl className="facts">
              <dt>Created</dt><dd><Ago date={space.createdAt} /></dd>
              <dt>Updated</dt><dd><Ago date={space.updatedAt} /></dd>
            </dl>
          </section>
          <section>
            <h2>Actions</h2>
            <ActionButtons space={space} actions={actions} />
          </section>
          <section className="danger-zone">
            <h2>Delete Space</h2>
            <p>Its files are removed now and its Share Link stops working.</p>
            <ActionButtons space={space} actions={actions} danger />
          </section>
        </aside>
      </div>
    </div>
  );
}
