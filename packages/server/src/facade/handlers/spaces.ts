/**
 * `spaces.list` / `spaces.create` / `spaces.get` / `spaces.home`.
 *
 * `spaces.create` is the loop's entry point: it mints the space, the caller's
 * owner member row, a `general` channel and the default task axis in one
 * transaction (007:428). Everything downstream — a project link, a task, a
 * message — needs the member row that this call is what creates, which is why
 * it is first after identity.
 */
import { CollabError, type CollectionResult, type HomeSnapshot, type SpaceSummary } from '@tm8/contract';
import type { OperationHandler } from '../../http/types.js';
import type { FacadeDeps } from '../deps.js';
import { claimsFor, commandEnvelope, requireUuidParam } from '../context.js';
import { queryCollection } from './collections.js';
import { loadActivity } from './activity.js';

interface SpaceRow {
  id: string;
  name: string;
  description: string;
  github_repo: string | null;
  created_at: Date | string;
  member_count: string;
}

function toSpaceSummary(row: SpaceRow): SpaceSummary {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    memberCount: Number(row.member_count),
    // Per-member unread rollup is `unread_counts` (007:1986), outside the G1A
    // slice. 0 is honest for a field that is required and not yet computed.
    unreadTotal: 0,
    githubRepo: row.github_repo,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : new Date(row.created_at).toISOString(),
  };
}

const SPACE_SELECT = `
  select s.id, s.name, s.description, s.github_repo, s.created_at,
         (select count(*)::text from public.members m where m.space_id = s.id) as member_count
    from public.spaces s`;

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
      claimsFor(owner, ctx, envelope),
      'create_space',
      [
        body.name,
        body.description ?? '',
        body.visibility ?? 'private',
        body.githubRepo ?? null,
        envelope.clientMutationId ?? null,
      ],
    );

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

    return deps.db.tx(claims, async (q) => {
      const memberRows = await q.query<{ entity_id: string }>(
        `select entity_id from public.members where space_id = $1 and identity_id = $2`,
        [spaceId, owner.identityId],
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
        owner.identityId,
      );
      const inFlight = await queryCollection(
        q,
        { spaceId, kinds: ['task'], filters: { inFlightForActorId: actorId } },
        owner.identityId,
      );
      const needsMe = await queryCollection(
        q,
        { spaceId, kinds: ['task'], filters: { needsActorId: actorId } },
        owner.identityId,
      );
      const activity = await loadActivity(q, { spaceId, limit: 20 });

      const home: HomeSnapshot = {
        readyToPull: readyToPull as CollectionResult,
        inFlight: inFlight as CollectionResult,
        needsMe: needsMe as CollectionResult,
        activity,
      };
      return home;
    });
  };
}
