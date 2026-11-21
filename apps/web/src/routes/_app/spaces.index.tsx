import { createFileRoute, Link } from '@tanstack/react-router';
import { Command, CopyButton } from '../../components/Copy';
import { formatBytes } from '../../components/spaces/files';
import { SpaceMenu, SpaceState, useSpaceActions } from '../../components/spaces/SpaceActions';
import { rpc } from '../../rpc';

export const Route = createFileRoute('/_app/spaces/')({
  loader: () => rpc.spaces.list(),
  component: Spaces,
});

function Spaces() {
  const { spaces, usedBytes, limitBytes } = Route.useLoaderData();
  const actions = useSpaceActions();
  const { status } = actions;
  return (
    <div className="page">
      <header className="page-head sp-head">
        <h1>Spaces</h1>
        {spaces.length ? (
          <div className="sp-usage" title={`${formatBytes(usedBytes)} of ${formatBytes(limitBytes)} used`}>
            <span>{formatBytes(usedBytes)} of {formatBytes(limitBytes)}</span>
            <span className="sp-meter" aria-hidden="true">
              <span style={{ transform: `scaleX(${Math.min(1, usedBytes / limitBytes)})` }} />
            </span>
          </div>
        ) : null}
      </header>
      <div className="sp-line" role="status">
        {status ? <span key={status.at} className="status-line appear" data-tone={status.tone}>{status.text}</span> : null}
      </div>
      {spaces.length === 0 ? (
        <div className="empty sp-empty">
          <p>Share files from a Machine:</p>
          <div style={{ width: '100%' }}><Command command="agentsync space create <path>" /></div>
        </div>
      ) : (
        <ul className="rows" aria-label="Spaces">
          {spaces.map((space) => (
            <li key={space.id}>
              <div className="sp-row" data-status={space.status}>
                <Link className="sp-row-main" to="/spaces/$spaceId" params={{ spaceId: space.id }}>
                  <span className="row-title">
                    <strong>{space.title}</strong>
                    <span>{space.fileCount === 1 ? '1 file' : `${space.fileCount} files`} · {formatBytes(space.totalBytes)}</span>
                  </span>
                </Link>
                <SpaceState space={space} />
                <span className="sp-row-actions">
                  {space.status === 'active' ? <CopyButton text={space.shareUrl} label={`Copy link to ${space.title}`} /> : null}
                  <SpaceMenu space={space} actions={actions} />
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
