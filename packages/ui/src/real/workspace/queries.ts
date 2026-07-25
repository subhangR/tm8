/**
 * The workspace's collection queries, in ONE place.
 *
 * Co-located deliberately: `usePolledCollection` de-duplicates subscriptions by
 * the SERIALIZED query, so two call sites that build "the same" query slightly
 * differently — a different `limit`, a different sort, keys in another order —
 * silently become two polls instead of one. Building them from shared factories
 * makes the sharing structural rather than something each tab has to remember.
 *
 * The Docs and Drawings tabs are the case that matters: they are ONE query
 * (`kinds:['doc']`) split client-side by format, so browsing between them costs
 * nothing and they can never disagree about which documents exist.
 */
import type { CollectionQuery, EntitySummary } from '../../collab-v2/types/contract';

/**
 * `work_session` and `team_member` reach `collections.query` through a cast.
 *
 * The module's `EntityKind` union predates tm8's promotion of these kinds, but
 * the server is generic over kinds with no allowlist — so this works today
 * against the real node with no contract change. The cast is the honest, narrow
 * way to say "the type is behind the server here", and it is confined to this
 * file rather than repeated at every call site.
 */
const asKinds = (kinds: string[]): EntitySummary['kind'][] =>
  kinds as unknown as EntitySummary['kind'][];

export const WORK_SESSION_KINDS = asKinds(['work_session']);
export const TEAM_MEMBER_KINDS = asKinds(['team_member']);
export const DOC_KINDS = asKinds(['doc']);

export function sessionsQuery(spaceId: string): CollectionQuery {
  return { spaceId, kinds: WORK_SESSION_KINDS, limit: 100, sort: 'activityAt_desc' };
}

export function agentsQuery(spaceId: string): CollectionQuery {
  return { spaceId, kinds: TEAM_MEMBER_KINDS, limit: 100, sort: 'activityAt_desc' };
}

/** Docs AND drawings — one query, split by format at the tab boundary. */
export function docsQuery(spaceId: string): CollectionQuery {
  return { spaceId, kinds: DOC_KINDS, limit: 200, sort: 'activityAt_desc' };
}

export type DocFormat = 'markdown' | 'mermaid' | 'excalidraw';

/**
 * A doc's format, defaulting to `markdown`.
 *
 * The default is not cosmetic: it decides which TAB a document appears in, and
 * an unknown format must not make a real document vanish from both. Anything
 * that is not recognisably a drawing is listed as a doc, so every row the
 * server returns is reachable somewhere.
 */
export function docFormat(doc: EntitySummary): DocFormat {
  const raw = (doc.state as unknown as { format?: string } | null)?.format;
  return raw === 'excalidraw' || raw === 'mermaid' ? raw : 'markdown';
}

export const isDrawing = (doc: EntitySummary): boolean => docFormat(doc) === 'excalidraw';
