/**
 * Bridges B0a (BRIDGE-ENTITY-DESIGN §3.4, migration 395): the catalog doors B1
 * builds on. Every write is one SQL door; every read answers
 * `internal.bridge_view`, so status and health are derived once (T-L12).
 *
 * Who may call what is decided in SQL: create, retarget and remove are
 * human-only (and wrapped here so the catalog's `humanOnly` holds before the
 * call); the handle claim, the log read and listen take any session in the
 * space (D23).
 */
import {
  BridgeCreateInputSchema, BridgeHandleClaimInputSchema, BridgeListenInputSchema, BridgeRetargetInputSchema,
  BridgeStateInputSchema, BridgeUpdateInputSchema, BridgeWorkStartInputSchema, type BridgeWorkStartResult, BRIDGE_LOG_LIMIT_MAX, BRIDGE_PROVIDERS, CollabError,
  type BridgeDetailView, type BridgeFacts, type BridgeHandle, type BridgeHandleAppearance, type BridgeListenResult,
  type BridgeLogEntry, type BridgeLogResult, type BridgeRecentPoster, type BridgeView,
} from '@tm8/contract';
import type { FacadeDeps } from '../facade/deps.js';
import type { BridgeWorkStarter } from './commands/ports.js';
import type { HandlerRegistry } from '../facade/registry.js';
import { claimsFor, commandEnvelope, isUuid, limitOf, requireUuidParam } from '../facade/context.js';
import { requireHumanSession } from '../facade/handlers/w2/credentials.js';
import { actorOf, loadActors } from '../facade/entity-read.js';
import { bridgeMessageBadges } from '../db/bridge-badges.js';
import type { Querier } from '../db/types.js';
import { readBridgeChatSummary } from './summary.js';
import type { RequestContext } from '../http/types.js';

const iso = (value: Date | string | null): string | null => (value === null ? null : new Date(value).toISOString());

/** The route names the target; a repeated body ID must agree with it. */
function routeId(ctx: RequestContext, field: 'spaceId' | 'bridgeId'): string {
  const id = requireUuidParam(ctx, field);
  const bodyId = (ctx.body as Record<string, unknown> | undefined)?.[field];
  if (bodyId !== undefined && bodyId !== id) {
    throw new CollabError('invalid_input', `body ${field} does not match route`);
  }
  return id;
}

interface ViewRow { id: string; space_id: string; version: number; view: (BridgeFacts & { createdAt: string; updatedAt: string }) | null }

const VIEW_SELECT = `
  select e.id, e.space_id, e.version, internal.bridge_view(e.id) as view
    from public.entities e
   where e.kind = 'bridge' and e.deleted_at is null and internal.entity_readable(e.id)`;

function viewOf(row: ViewRow): BridgeView {
  const v = row.view;
  if (!v) throw new CollabError('not_found', 'Bridge is unavailable');
  const { createdAt, updatedAt, ...facts } = v;
  return {
    ...facts,
    id: row.id, spaceId: row.space_id, version: Number(row.version),
    title: facts.conversation.title,
    createdAt: iso(createdAt)!, updatedAt: iso(updatedAt)!,
    health: { ...facts.health, lastInboundAt: iso(facts.health.lastInboundAt), lastOutboundAt: iso(facts.health.lastOutboundAt) },
    pausedAt: iso(facts.pausedAt), endedAt: iso(facts.endedAt),
  };
}

export async function loadBridgeView(q: Querier, bridgeId: string): Promise<BridgeView> {
  const [row] = await q.query<ViewRow>(`${VIEW_SELECT} and e.id = $1`, [bridgeId]);
  if (!row) throw new CollabError('not_found', 'Bridge is unavailable');
  return viewOf(row);
}

/** Who has posted through the outbox lately (D23: recent posters come from bridge_outbox). */
async function recentPosters(q: Querier, bridgeId: string): Promise<BridgeRecentPoster[]> {
  const rows = await q.query<{ author_id: string; posts: number; last_post_at: Date | string; handle: string | null }>(
    `select m.author_id, count(*)::int as posts, max(ob.created_at) as last_post_at,
            (array_agg(h.handle order by ob.created_at desc) filter (where h.handle is not null))[1] as handle
       from public.bridge_outbox ob
       join public.messages m on m.entity_id = ob.message_id
       -- The post's session origin only: bridge provenance (props.bridgeId, 399)
       -- would otherwise count each post once per edge.
       left join public.edges af on af.src_id = m.entity_id and af.type = 'authored_from' and not (af.props ? 'bridgeId')
       left join public.bridge_handles h on h.entity_id = af.dst_id
      where ob.bridge_id = $1 and m.author_id is not null
      group by m.author_id
      order by max(ob.created_at) desc
      limit 10`, [bridgeId]);
  const actors = await loadActors(q, rows.map(r => r.author_id));
  return rows.map(r => {
    const actor = actorOf(actors, r.author_id);
    return {
      actorId: r.author_id, actorKind: actor.kind, displayName: actor.displayName,
      handle: r.handle, posts: Number(r.posts), lastPostAt: iso(r.last_post_at)!,
    };
  });
}

interface LogRow {
  id: string; created_at: Date | string; author_id: string | null; body: string;
  parent_id: string | null; root_message_id: string | null;
  direction: 'in' | 'out' | null; external_message_id: string | null; participant: string | null;
  handle: string | null;
}

/**
 * `bridges.log.read` (§2.7): a page of the log anchor. A thin verb over the
 * anchor's messages plus the caller session's cursor. Rows within a page are
 * always oldest first; the page is chosen one of four ways:
 *
 * - default / `since`: the oldest page after `since` (or from the start);
 * - `unread`: the page after the caller's cursor, and the cursor advances to
 *   its last row;
 * - `latest`: the NEWEST page (the bridge panel opens here);
 * - `before`: the page immediately older than that message (scroll back).
 *
 * `latest` and `before` never move the cursor. `olderCursor` is what to pass as
 * `before` next, null at the start of the log. Bodies are data; nothing here
 * turns one into an instruction.
 */
async function readLog(q: Querier, bridgeId: string, opts: {
  since: string | null; before: string | null; latest: boolean; thread: string | null; limit: number; unread: boolean;
}): Promise<BridgeLogResult> {
  const [row] = await q.query<{ ctx: { anchorId: string; sessionId: string | null; cursor: string | null } }>(
    'select public.bridge_log_context($1) as ctx', [bridgeId]);
  const bridge = row ? { anchor: row.ctx.anchorId, caller: row.ctx.sessionId, cursor: row.ctx.cursor } : null;
  if (!bridge) throw new CollabError('not_found', 'Bridge is unavailable');
  if (opts.unread && !bridge.caller) {
    throw new CollabError('forbidden', '--unread reads a session\'s own cursor: run it from inside a session in this space',
      { details: { reason: 'not_a_session' } });
  }
  if (opts.before) {
    const [onLog] = await q.query<{ ok: boolean }>(
      'select exists (select 1 from public.messages where entity_id = $1 and anchor_id = $2) as ok', [opts.before, bridge.anchor]);
    if (!onLog?.ok) throw new CollabError('invalid_input', 'before must be a message on this bridge\'s log', { details: { path: 'before' } });
  }
  const backward = opts.latest || opts.before !== null;
  const after = opts.unread ? bridge.cursor : opts.since;
  // One select for every mode: forward pages read up from `after`, backward
  // pages read down from `before` (or the newest row) and are then reversed.
  const rows = await q.query<LogRow>(
    `select m.entity_id as id, m.created_at, m.author_id, m.body, e.parent_id, m.root_message_id,
            o.direction, o.external_message_id,
            case when o.direction = 'in' then p.display_name end as participant,
            h.handle
       from public.messages m
       join public.entities e on e.id = m.entity_id
       left join public.message_origins o on o.message_id = m.entity_id
       left join public.bridge_participants p on p.bridge_id = o.bridge_id and p.external_id = o.external_sender_id
       left join lateral (
         select bh.handle from public.edges af
           join public.bridge_handles bh on bh.entity_id = af.dst_id and bh.space_id = e.space_id
          where af.src_id = m.entity_id and af.type = 'authored_from' limit 1) h on true
      where m.anchor_id = $1 and e.deleted_at is null and internal.entity_readable(e.id)
        and ($2::uuid is null or (m.created_at, m.entity_id) >
             (select m2.created_at, m2.entity_id from public.messages m2 where m2.entity_id = $2::uuid))
        and ($5::uuid is null or (m.created_at, m.entity_id) <
             (select m2.created_at, m2.entity_id from public.messages m2 where m2.entity_id = $5::uuid))
        and ($3::uuid is null or m.root_message_id = $3::uuid or m.entity_id = $3::uuid)
      order by case when $6 then m.created_at end desc, case when $6 then m.entity_id end desc,
               m.created_at, m.entity_id
      limit $4`, [bridge.anchor, backward ? null : after, opts.thread, opts.limit + 1, opts.before, backward]);
  const page = backward ? rows.slice(0, opts.limit).reverse() : rows.slice(0, opts.limit);
  const actors = await loadActors(q, page.map(r => r.author_id).filter((x): x is string => x !== null));
  const badges = await bridgeMessageBadges(q, page.map(r => r.id), 'bridges.log.read:badges');
  const items: BridgeLogEntry[] = page.map(r => {
    const actor = r.author_id ? actorOf(actors, r.author_id) : null;
    return {
      id: r.id, createdAt: iso(r.created_at)!,
      authorId: r.author_id, authorKind: actor?.kind ?? null,
      authorName: r.participant ?? actor?.displayName ?? '',
      body: r.body, parentMessageId: r.parent_id, rootMessageId: r.root_message_id,
      origin: r.direction && r.external_message_id
        ? { direction: r.direction, externalMessageId: r.external_message_id, participant: r.participant }
        : null,
      handle: r.handle,
      delivery: badges.get(r.id)?.delivery ?? null,
    };
  });
  const first = page[0]?.id ?? null;
  const last = page.at(-1)?.id ?? null;
  // Older rows exist: a backward page knows from its extra row; a forward page asks.
  let older = backward ? rows.length > opts.limit : false;
  if (!backward && first) {
    const [probe] = await q.query<{ older: boolean }>(
      `select exists (
         select 1 from public.messages m join public.entities e on e.id = m.entity_id
          where m.anchor_id = $1 and e.deleted_at is null and internal.entity_readable(e.id)
            and ($3::uuid is null or m.root_message_id = $3::uuid or m.entity_id = $3::uuid)
            and (m.created_at, m.entity_id) < (select m2.created_at, m2.entity_id from public.messages m2 where m2.entity_id = $2::uuid)
       ) as older`, [bridge.anchor, first, opts.thread]);
    older = probe?.older === true;
  }
  if (opts.unread && last) await q.rpc('advance_bridge_read_cursor', [bridgeId, last]);
  return {
    bridgeId, logAnchorId: bridge.anchor, items, lastMessageId: last,
    // Newer rows follow: a forward page knows from its extra row; `before` always has its own message after it.
    more: backward ? opts.before !== null && page.length > 0 : rows.length > opts.limit,
    olderCursor: older ? first : null,
  };
}

function optionalUuidQuery(ctx: RequestContext, name: string): string | null {
  const value = ctx.query.get(name);
  if (value === null || value === '') return null;
  if (!isUuid(value)) throw new CollabError('invalid_input', `${name} must be an id`, { details: { path: name } });
  return value;
}

export function registerBridgeHandlers(registry: HandlerRegistry, deps: FacadeDeps): void {
  const command = async <T>(ctx: RequestContext, work: (q: Querier) => Promise<T>) =>
    deps.db.tx(claimsFor(await deps.owner(), ctx, commandEnvelope(ctx)), work);
  const read = async <T>(ctx: RequestContext, work: (q: Querier) => Promise<T>) =>
    deps.db.tx(claimsFor(await deps.owner(), ctx), work);

  /** pause, resume and remove share one shape: a versioned call on the bridge. */
  const state = (rpc: 'pause_bridge' | 'resume_bridge' | 'remove_bridge') => async (ctx: RequestContext) => {
    const input = BridgeStateInputSchema.parse(ctx.body);
    const bridgeId = routeId(ctx, 'bridgeId');
    return command(ctx, async q => {
      await q.rpc(rpc, [bridgeId, input.expectedVersion, input.actorId ?? null, input.clientMutationId]);
      return loadBridgeView(q, bridgeId);
    });
  };

  registry.registerAll({
    'bridges.list': async ctx => {
      const spaceId = requireUuidParam(ctx, 'spaceId');
      const provider = ctx.query.get('provider');
      if (provider !== null && !(BRIDGE_PROVIDERS as readonly string[]).includes(provider)) {
        throw new CollabError('invalid_input', `provider must be one of ${BRIDGE_PROVIDERS.join(', ')}`);
      }
      const target = optionalUuidQuery(ctx, 'target');
      const includeEnded = ctx.query.get('includeEnded') === 'true';
      return read(ctx, async q => {
        const rows = await q.query<ViewRow>(
          `${VIEW_SELECT} and e.space_id = $1
             and exists (select 1 from public.bridges b where b.entity_id = e.id
                          and ($2::text is null or b.provider = $2)
                          and ($3::uuid is null or b.target_id = $3)
                          and ($4 or b.ended_at is null))
           order by e.created_at, e.id`, [spaceId, provider, target, includeEnded]);
        return { items: rows.map(viewOf) };
      });
    },
    'bridges.get': async ctx => read(ctx, async (q): Promise<BridgeDetailView> => {
      const bridgeId = requireUuidParam(ctx, 'bridgeId');
      const view = await loadBridgeView(q, bridgeId);
      return { ...view, recentPosters: await recentPosters(q, bridgeId), summary: await readBridgeChatSummary(q, bridgeId) };
    }),
    'bridges.create': requireHumanSession(async ctx => {
      const input = BridgeCreateInputSchema.parse(ctx.body);
      const spaceId = routeId(ctx, 'spaceId');
      return command(ctx, async q => {
        const result = await q.rpc<{ entity: { id: string } }>('create_bridge', [
          spaceId, input.connectionId, input.conversation.externalId,
          JSON.stringify({ kind: input.conversation.kind, title: input.conversation.title, memberCount: input.conversation.memberCount ?? null }),
          input.targetId, JSON.stringify(input.policy ?? {}), input.teammateId ?? null, input.purpose ?? null,
          input.quietHours ? JSON.stringify(input.quietHours) : null, input.workerPosting ?? true,
          input.retentionDays ?? null, input.actorId ?? null, input.clientMutationId,
        ]);
        return loadBridgeView(q, result.entity.id);
      });
    }, 'bridges.create is for a human: the number\'s owner, a space admin, at a keyboard'),
    'bridges.update': async ctx => {
      const input = BridgeUpdateInputSchema.parse(ctx.body);
      const bridgeId = routeId(ctx, 'bridgeId');
      return command(ctx, async q => {
        await q.rpc('update_bridge', [bridgeId, input.expectedVersion, JSON.stringify(input.patch), input.actorId ?? null, input.clientMutationId]);
        return loadBridgeView(q, bridgeId);
      });
    },
    'bridges.retarget': requireHumanSession(async ctx => {
      const input = BridgeRetargetInputSchema.parse(ctx.body);
      const bridgeId = routeId(ctx, 'bridgeId');
      return command(ctx, async q => {
        await q.rpc('retarget_bridge', [bridgeId, input.expectedVersion, input.targetId, input.actorId ?? null, input.clientMutationId]);
        return loadBridgeView(q, bridgeId);
      });
    }, 'bridges.retarget is for a human space admin'),
    'bridges.pause': state('pause_bridge'),
    'bridges.resume': state('resume_bridge'),
    'bridges.remove': requireHumanSession(state('remove_bridge'), 'bridges.remove is for a human space admin'),
    'bridges.handles.list': async ctx => read(ctx, async q => {
      const bridgeId = requireUuidParam(ctx, 'bridgeId');
      await loadBridgeView(q, bridgeId);
      const rows = await q.query<{
        space_id: string; handle: string; entity_id: string; kind: 'chat' | 'work_session'; title: string | null;
        status: 'live' | 'ended'; created_at: Date | string; first_at: Date | string; last_at: Date | string;
      }>(
        `select h.space_id, h.handle, h.entity_id, h.kind, h.title, h.status, h.created_at, a.first_at, a.last_at
           from public.bridge_handle_appearances a
           join public.bridge_handles h on h.space_id = a.space_id and h.handle = a.handle
          where a.bridge_id = $1
          order by a.last_at desc, h.handle`, [bridgeId]);
      const items: BridgeHandleAppearance[] = rows.map(r => ({
        spaceId: r.space_id, handle: r.handle, entityId: r.entity_id, kind: r.kind, title: r.title, status: r.status,
        createdAt: iso(r.created_at)!, firstAt: iso(r.first_at)!, lastAt: iso(r.last_at)!,
      }));
      return { items };
    }),
    'bridges.handles.claim': async ctx => {
      const input = BridgeHandleClaimInputSchema.parse(ctx.body ?? {});
      const spaceId = routeId(ctx, 'spaceId');
      return command(ctx, async q => {
        const row = await q.rpc<BridgeHandle>('claim_bridge_handle', [spaceId, input.title ?? null]);
        return { ...row, createdAt: iso(row.createdAt)! };
      });
    },
    'bridges.log.read': async ctx => {
      const bridgeId = requireUuidParam(ctx, 'bridgeId');
      const unread = ctx.query.get('unread') === 'true';
      const latest = ctx.query.get('latest') === 'true';
      const since = optionalUuidQuery(ctx, 'since');
      const before = optionalUuidQuery(ctx, 'before');
      // One way to choose the page: --unread, --since, --latest or --before.
      if ([unread, since !== null, latest, before !== null].filter(Boolean).length > 1) {
        throw new CollabError('invalid_input', 'pass one of --unread, --since, --latest or --before');
      }
      const thread = optionalUuidQuery(ctx, 'thread');
      const limit = Math.min(limitOf(ctx.query.get('limit')), BRIDGE_LOG_LIMIT_MAX);
      // --unread moves the caller's cursor, so it runs as a write transaction;
      // --latest and --before never move it.
      const run = unread ? command : read;
      return run(ctx, q => readLog(q, bridgeId, { since, before, latest, thread, limit, unread }));
    },
    'bridges.work.start': async (ctx): Promise<BridgeWorkStartResult> => {
      const input = BridgeWorkStartInputSchema.parse(ctx.body);
      const bridgeId = routeId(ctx, 'bridgeId');
      const starter = deps.bridgeCommands as (Partial<BridgeWorkStarter> & object) | undefined;
      if (!starter?.workStart) {
        throw new CollabError('not_implemented', 'this node runs no bridge command executor (it needs the execution runtime)');
      }
      const claims = claimsFor(await deps.owner(), ctx, commandEnvelope(ctx));
      return starter.workStart(claims, { ...input, bridgeId });
    },
    'bridges.listen': async ctx => {
      const input = BridgeListenInputSchema.parse(ctx.body);
      const bridgeId = routeId(ctx, 'bridgeId');
      return command(ctx, q => q.rpc<BridgeListenResult>('set_bridge_listen', [bridgeId, input.wake]));
    },
  });
}
