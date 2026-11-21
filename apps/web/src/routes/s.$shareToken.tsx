import { shareTokenSchema } from '@agentsync/contract';
import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { loadPublicSpace, type Loaded } from '../components/spaces/live';
import { SpaceViewer } from '../components/spaces/SpaceViewer';

/**
 * A Share Link opened in a browser: public, no sign-in. The Worker answers the link's other
 * forms (`.md`, `.json`, `/raw/…`, `/download.zip`, `/ws`) itself; only an HTML request gets here.
 */
export const Route = createFileRoute('/s/$shareToken')({
  validateSearch: z.object({ file: z.string().optional() }),
  loader: ({ params }): Promise<Loaded> | Loaded =>
    shareTokenSchema.safeParse(params.shareToken).success
      ? loadPublicSpace(params.shareToken)
      : { kind: 'unavailable', reason: 'missing' },
  // Picking a file changes only the search; the live socket keeps the Space current.
  staleTime: Infinity,
  head: ({ loaderData }) => ({
    meta: [{ title: loaderData?.kind === 'space' ? `${loaderData.space.title} – AgentSync` : 'AgentSync' }],
  }),
  component: SharedSpace,
});

function SharedSpace() {
  const { shareToken } = Route.useParams();
  const initial = Route.useLoaderData();
  const { file } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <SpaceViewer key={shareToken} shareToken={shareToken} initial={initial} requested={file}
      onSelect={(path) => navigate({ search: { file: path } })} />
  );
}
