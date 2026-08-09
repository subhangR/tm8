/**
 * `spaces.list` / `spaces.create` / `spaces.get` / `spaces.home`.
 *
 * `spaces.create` is the loop's entry point: it mints the space, the caller's
 * owner member row, a `general` channel and the default task axis in one
 * transaction (007:428). Everything downstream — a project link, a task, a
 * message — needs the member row that this call is what creates, which is why
 * it is first after identity.
 */
import {
  CollabError,
  type CollectionResult,
  type HomeSnapshot,
  type NavChannelNode,
  type SpaceKindCounts,
  type SpaceNavigation,
  type SpaceSummary,
} from '@tm8/contract';
import type { OperationHandler } from '../../http/types.js';
import { ensureDefaultTeammates } from '../../bootstrap/default-teammates.js';
import type { FacadeDeps } from '../deps.js';
import { claimsFor, commandEnvelope, requireUuidParam } from '../context.js';
import { queryCollection } from './collections.js';
import { loadActivity } from './activity.js';
import {
  actorOf,
  assembleSummaries,
  ENTITY_COLUMNS,
  ENTITY_FROM,
  loadActors,
  type EntityRow,
} from '../entity-read.js';

export interface SpaceRow {
  id: string;
  name: string;
  description: string;
  github_repo: string | null;
  created_at: Date | string;
  member_count: string;
  unread_total: string;
}

export function toSpaceSummary(row: SpaceRow): SpaceSummary {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    memberCount: Number(row.member_count),
    unreadTotal: Number(row.unread_total),
    githubRepo: row.github_repo,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : new Date(row.created_at).toISOString(),
  };
}

export const SPACE_COLUMNS = `
  s.id, s.name, s.description, s.github_repo, s.created_at,
  (select count(*)::text from public.members member_count_row
    where member_count_row.space_id = s.id) as member_count,
  coalesce((
    select count(*)::text
      from public.messages message_row
      join public.entities message_entity
        on message_entity.id = message_row.entity_id and message_entity.deleted_at is null
      join public.entities anchor_entity
        on anchor_entity.id = message_row.anchor_id and anchor_entity.space_id = s.id
      join public.members viewer
        on viewer.space_id = s.id and viewer.identity_id = internal.identity_id()
      left join public.read_marks mark_row
        on mark_row.anchor_id = message_row.anchor_id and mark_row.member_id = viewer.entity_id
     where message_row.author_id is distinct from viewer.entity_id
       and (mark_row.last_read_at is null
         or message_row.entity_id > internal.uuid_at(mark_row.last_read_at))
  ), '0') as unread_total`;

export const SPACE_FROM = `from public.spaces s`;

export const SPACE_SELECT = `select ${SPACE_COLUMNS} ${SPACE_FROM}`;

export function spacesList(deps: FacadeDeps): OperationHandler {
  return async (ctx) => {
    const owner = await deps.owner();
    // No explicit membership filter: `spaces_select` (008:69) already limits
    // this to spaces the caller belongs to, plus public ones. Re-filtering here
    // would be a second, divergent copy of the same rule.
    const rows = await deps.db.query<SpaceRow>(
      claimsFor(owner, ctx),
      `${SPACE_SELECT} order by s.created_at desc, s.id desc`,
    );
    return rows.map(toSpaceSummary);
  };
}

export function spacesGet(deps: FacadeDeps): OperationHandler {
  return async (ctx) => {
    const owner = await deps.owner();
    const spaceId = requireUuidParam(ctx, 'spaceId');
    const rows = await deps.db.query<SpaceRow>(
      claimsFor(owner, ctx),
      `${SPACE_SELECT} where s.id = $1`,
      [spaceId],
    );
    const row = rows[0];
    // RLS makes an unreadable space indistinguishable from a missing one, and
    // that is the correct answer to give: "not found" leaks nothing about
    // whether a space you cannot see exists.
    if (!row) throw new CollabError('not_found', `no such space: ${spaceId}`);
    return toSpaceSummary(row);
  };
}

interface CreateSpaceResult {
  space: { id: string };
  memberId: string;
  defaultChannelId: string;
}

export function spacesCreate(deps: FacadeDeps): OperationHandler {
  return async (ctx) => {
    const owner = await deps.owner();
    const envelope = commandEnvelope(ctx);
    const body = (ctx.body ?? {}) as {
      name: string;
      description?: string;
      visibility?: 'private' | 'public';
      githubRepo?: string | null;
    };

    const result = await deps.db.rpc<CreateSpaceResult>(
      // A new Space has no actor namespace to act as yet. Preserve the
      // authenticated identity and mutation id, but never bind a caller-picked
      // actor from some unrelated existing Space into this command's ledger.
      claimsFor(owner, ctx, { clientMutationId: envelope.clientMutationId }),
      'create_space',
      [
        body.name,
        body.description ?? '',
        body.visibility ?? 'private',
        body.githubRepo ?? null,
        envelope.clientMutationId ?? null,
      ],
    );

    // A space with no team_member rows has nothing to launch, and the boot-time
    // bootstrap only ever sees spaces that existed when the process started —
    // so before this, a space was unlaunchable until someone restarted the node.
    // Seeded outside the create: the roster is a convenience, and losing the
    // space itself because a persona insert was refused would be the worse
    // trade. Boot repairs whatever is missing.
    if (deps.config.launchBootstrap) {
      try {
        await deps.db.tx(claimsFor(owner, ctx), (q) =>
          ensureDefaultTeammates(q, result.space.id),
        );
      } catch (error) {
        console.warn(
          `  default teammates not seeded for space ${result.space.id}: ${String(error)}`,
        );
      }
    }

    // Read the summary back through the same path `spaces.get` uses, rather
    // than shaping a second one from the RPC's raw row — one assembler per
    // shape is the whole point of L3.
    const rows = await deps.db.query<SpaceRow>(
      claimsFor(owner, ctx),
      `${SPACE_SELECT} where s.id = $1`,
      [result.space.id],
    );
    const row = rows[0];
    if (!row) throw new CollabError('upstream_unavailable', 'space created but not readable');
    return {
      status: 201,
      kind: 'json' as const,
      data: {
        space: toSpaceSummary(row),
        memberId: result.memberId,
        defaultChannelId: result.defaultChannelId,
      },
    };
  };
}

/**
 * `spaces.navigation` — the viewer plus the channel tree.
 *
 * This is what makes a space navigable (AM-3: "open a space, see tasks"), and
 * it is the first call a client makes after picking a space. Channels are
 * ordinary entities with an ordinary parent/child hierarchy, so the tree is
 * built here from a flat, position-ordered read rather than by recursing in
 * SQL — one query, assembled in memory, because a space has tens of channels
 * and not thousands.
 */
export function spacesNavigation(deps: FacadeDeps): OperationHandler {
  return async (ctx) => {
    const owner = await deps.owner();
    const spaceId = requireUuidParam(ctx, 'spaceId');

    const claims = claimsFor(owner, ctx);
    const viewerIdentity = claims.identityId;
    if (!viewerIdentity) throw new CollabError('unauthenticated', 'authentication is required');
    return deps.db.tx(claims, async (q) => {
      const memberRows = await q.query<{ entity_id: string }>(
        `select entity_id from public.members where space_id = $1 and identity_id = $2`,
        [spaceId, viewerIdentity],
      );
      const viewerId = memberRows[0]?.entity_id;
      // Membership is what `spaces.navigation` is FOR, so its absence is a
      // refusal rather than an empty tree — an empty nav would read as "this
      // space has no channels", which is a different and wrong statement.
      if (!viewerId) throw new CollabError('forbidden', 'not a member of this space');

      const viewers = await loadActors(q, [viewerId]);
      const viewer = actorOf(viewers, viewerId);

      const rows = await q.query<EntityRow>(
        `select ${ENTITY_COLUMNS} ${ENTITY_FROM}
          where e.space_id = $1 and e.kind = 'channel' and e.deleted_at is null
          order by e.position asc, e.id asc`,
        [spaceId],
      );
      // Per-channel `unreadCount` is no longer patched in here: the assembler
      // resolves it from the same `public.unread_counts`, so the nav tree and a
      // directly-fetched channel cannot disagree.
      const navigableSummaries = await assembleSummaries(q, rows, viewerIdentity);

      // The space-wide total still needs its own call, and it is NOT the sum of
      // the channel counts above: `unread_counts` reports every anchor kind, so
      // unread messages on a task or a doc belong in this total and have no
      // channel row to be summed from.
      const unreadRows = await q.rpc<Array<{ anchor_id: string; unread: number }>>(
        'unread_counts',
        [spaceId],
      );

      // Build the tree in one pass, then attach. A channel whose parent is
      // outside this result set (deleted, or not readable) is surfaced at the
      // root rather than dropped — losing a channel from the nav would hide
      // real content.
      const nodes = new Map<string, NavChannelNode>(
        navigableSummaries.map((entity) => [entity.id, { entity, childCount: 0, children: [] }]),
      );
      const roots: NavChannelNode[] = [];
      for (const summary of navigableSummaries) {
        const node = nodes.get(summary.id);
        if (!node) continue;
        const parent = summary.parentId ? nodes.get(summary.parentId) : undefined;
        if (parent) {
          parent.children.push(node);
          parent.childCount += 1;
        } else {
          roots.push(node);
        }
      }

      const navigation: SpaceNavigation = {
        spaceId,
        viewer,
        unreadTotal: unreadRows.reduce((total, row) => total + Number(row.unread), 0),
        channels: roots,
      };
      return navigation;
    });
  };
}

/**
 * `spaces.home` — the three server-defined presets plus compact activity.
 *
 * The presets are executed as ordinary `collections.query` calls with the
 * facade-defined filters (`readyToPull`, `inFlightForActorId`, `needsActorId`),
 * so the query attached to each result is one the client can re-run verbatim
 * and get the same rows. A preset the client cannot reproduce is a preset the
 * client has to special-case.
 */
export function spacesHome(deps: FacadeDeps): OperationHandler {
  return async (ctx) => {
    const owner = await deps.owner();
    const spaceId = requireUuidParam(ctx, 'spaceId');
    const claims = claimsFor(owner, ctx);
    const viewerIdentity = claims.identityId;
    if (!viewerIdentity) throw new CollabError('unauthenticated', 'authentication is required');

    return deps.db.tx(claims, async (q) => {
      const memberRows = await q.query<{ entity_id: string }>(
        `select entity_id from public.members where space_id = $1 and identity_id = $2`,
        [spaceId, viewerIdentity],
      );
      const actorId = memberRows[0]?.entity_id;
      if (!actorId) throw new CollabError('forbidden', 'not a member of this space');

      // Sequential: the four presets share one pooled pg client, which cannot
      // run queries concurrently (see facade/entity-read.ts). Running them in
      // one transaction is deliberate — home is a SNAPSHOT, and three presets
      // read at three different instants would be internally inconsistent.
      const readyToPull = await queryCollection(
        q,
        { spaceId, kinds: ['task'], filters: { readyToPull: true } },
        viewerIdentity,
      );
      const inFlight = await queryCollection(
        q,
        { spaceId, kinds: ['task'], filters: { inFlightForActorId: actorId } },
        viewerIdentity,
      );
      const needsMe = await queryCollection(
        q,
        { spaceId, kinds: ['task'], filters: { needsActorId: actorId } },
        viewerIdentity,
      );
      const activityPage = await loadActivity(q, { spaceId, limit: 20 });

      const home: HomeSnapshot = {
        readyToPull: readyToPull as CollectionResult,
        inFlight: inFlight as CollectionResult,
        needsMe: needsMe as CollectionResult,
        // The compact home preview is NOT a paginable list, so it does not
        // advertise a continuation. `loadActivity` mints a two-part
        // `(createdAt, id)` keyset, and the only operation that pages activity
        // — `entities.activity` (catalog.ts:63) — is ENTITY-scoped and demands
        // a three-part fingerprinted cursor, which it would reject. Nothing in
        // the catalog accepts a SPACE-scoped activity cursor.
        //
        // Passing the token through would advertise "there is more, here is
        // your handle" and hand over a handle no operation will take. `null`
        // is the honest answer, and `Page.nextCursor` is nullable for it.
        // If space-activity paging is ever added, drop this and pass the page
        // through — the cursor itself is microsecond-exact as of the fix to
        // ActivityRow.cursor_created_at.
        activity: { items: activityPage.items, nextCursor: null },
      };
      return home;
    });
  };
}

/**
 * `spaces.counts` — the menu rail's per-kind numbers, in one round trip.
 *
 * WHY A DEDICATED READ. `Page` already carries an optional `total` that
 * `collections.query` never fills in, and populating it would look cheaper.
 * It is not: the browser hydrates only a handful of kinds at boot, so a
 * `total`-driven rail would leave most rows blank until the user visited each
 * section — a counter that appears only after you have already looked is not
 * doing its job. One grouped scan answers every kind before any list is
 * fetched.
 *
 * The RPC is `security definer` and re-checks membership plus per-entity
 * readability itself (063), so a counter can never disclose that a restricted
 * entity exists when the corresponding list would hide it. That is also why
 * this does NOT go through `queryCollection`: counting is not paging, and
 * running it as a capped page would either be wrong or read the whole table.
 */
export function spacesCounts(deps: FacadeDeps): OperationHandler {
  return async (ctx) => {
    const owner = await deps.owner();
    const spaceId = requireUuidParam(ctx, 'spaceId');
    const claims = claimsFor(owner, ctx);

    return deps.db.tx(claims, async (q) => {
      const rows = await q.rpc<Array<{ kind: string; total: number; unseen: number }>>(
        'space_kind_counts',
        [spaceId],
      );
      // Absent rather than zero for a kind with no rows: the shape is a
      // Partial record, and the client renders a missing key as "no entities".
      const counts: SpaceKindCounts = {};
      for (const row of rows) {
        counts[row.kind as keyof SpaceKindCounts] = {
          total: Number(row.total),
          unseen: Number(row.unseen),
        };
      }
      return counts;
    });
  };
}
