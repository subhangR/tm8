/**
 * Attention v2 — the server's one attention module (spec chapter 5, "Server:
 * one module"). It owns every `attentionRequests.*` operation; the verbs are
 * SQL doors (050, 256), and this file is the thin, typed layer over them.
 *
 * Two facts come from the AUTH CONTEXT and never from input:
 *   - the persona: `claimsFor` binds the bearer's actor, and the doors'
 *     `resolve_actor` records it as `requested_by` / `resolved_by`;
 *   - the raising session (F1, F1a): `workSessionId ?? runtimeChatId` off the
 *     verified bearer row. A human caller has neither, so its rows carry none.
 */
import { createHash } from 'node:crypto';

import {
  CollabError,
  decodeCursor,
  encodeCursor,
  type AttentionRequest,
  type AttentionRequestMutationResult,
  type AttentionRequestPage,
  type CreateAttentionRequestInput,
  type ResolveEntityAttentionInput,
  type UpdateAttentionRequestInput,
  type WithdrawAttentionRequestInput,
} from '@tm8/contract';

import type { Querier } from '../../../db/types.js';
import type { RequestContext } from '../../../http/types.js';
import { claimsFor, commandEnvelope, limitOf, requireUuidParam } from '../../context.js';
import type { FacadeDeps } from '../../deps.js';
import { ENTITY_COLUMNS, ENTITY_FROM, MICROS, actorOf, iso, isoOrNull, loadActors, type EntityRow } from '../../entity-read.js';
import { loadUniversalSummaries } from '../w2/entities-commands-tracking.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `open` plus legacy `acknowledged` (read as open) is the default filter. */
const STATUSES: ReadonlySet<string> = new Set(['open', 'acknowledged', 'resolved', 'dismissed', 'cleared']);

interface AttentionRequestRow {
  id: string;
  space_id: string;
  entity_id: string;
  reason: string;
  points: number;
  status: AttentionRequest['status'];
  version: number;
  requested_by: string;
  acknowledged_by: string | null;
  resolved_by: string | null;
  resolution_note: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  acknowledged_at: Date | string | null;
  resolved_at: Date | string | null;
  level: NonNullable<AttentionRequest['level']>;
  action_type: NonNullable<AttentionRequest['actionType']>;
  assignee_id: string | null;
  source_session_id: string | null;
  origin: NonNullable<AttentionRequest['origin']>;
  resolution_batch_id: string | null;
  root_id: string;
  seen_by_me: boolean;
  source_session_live: boolean;
  /** Microsecond cursor key, selected only on queue reads. */
  cursor_created_at?: string;
}

interface AttentionMutationRpcResult {
  attentionRequestId: string | null;
  entityId: string;
  affectedCount: number;
  resolutionBatchId?: string | null;
}

/**
 * `ar` is `public.attention_requests`. seenByMe needs no member filter:
 * attention_seen's RLS returns only the caller's own rows (255).
 */
const ATTENTION_COLUMNS = `
  ar.id, ar.space_id, ar.entity_id, ar.reason, ar.points, ar.status, ar.version,
  ar.requested_by, ar.acknowledged_by, ar.resolved_by, ar.resolution_note,
  ar.created_at, ar.updated_at, ar.acknowledged_at, ar.resolved_at,
  ar.level, ar.action_type, ar.assignee_id, ar.source_session_id, ar.origin,
  ar.resolution_batch_id,
  internal.attention_root_id(ar.entity_id) as root_id,
  exists (select 1 from public.attention_seen s where s.request_id = ar.id) as seen_by_me,
  internal.attention_source_live(ar.source_session_id) as source_session_live
`;

/** The raising session or chat, off the verified bearer only (F1a). */
export function sourceSessionOf(ctx: RequestContext): string | null {
  if (ctx.identity?.kind !== 'bearer') return null;
  return ctx.identity.workSessionId ?? ctx.identity.runtimeChatId ?? null;
}

function fingerprint(scope: string, value: unknown): string {
  return createHash('sha256').update(JSON.stringify({ scope, value })).digest('base64url').slice(0, 22);
}

async function attentionRequestsOf(q: Querier, rows: readonly AttentionRequestRow[]): Promise<AttentionRequest[]> {
  const actors = await loadActors(q, rows.flatMap((row) => [
    row.requested_by,
    row.acknowledged_by ?? '',
    row.resolved_by ?? '',
  ]));
  return rows.map((row) => ({
    id: row.id,
    spaceId: row.space_id,
    entityId: row.entity_id,
    reason: row.reason,
    points: Number(row.points),
    status: row.status,
    version: Number(row.version),
    requestedBy: actorOf(actors, row.requested_by),
    acknowledgedBy: row.acknowledged_by ? actorOf(actors, row.acknowledged_by) : null,
    resolvedBy: row.resolved_by ? actorOf(actors, row.resolved_by) : null,
    resolutionNote: row.resolution_note,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    acknowledgedAt: isoOrNull(row.acknowledged_at),
    resolvedAt: isoOrNull(row.resolved_at),
    seenByMe: row.seen_by_me === true,
    rootId: row.root_id,
    level: row.level,
    actionType: row.action_type,
    assigneeId: row.assignee_id,
    sourceWorkSessionId: row.source_session_id,
    sourceSessionLive: row.source_session_live === true,
    origin: row.origin,
    resolutionBatchId: row.resolution_batch_id,
  }));
}

async function attentionMutationResult(
  q: Querier,
  raw: AttentionMutationRpcResult,
  viewerIdentityId: string,
): Promise<AttentionRequestMutationResult> {
  const entityRows = await q.query<EntityRow>(
    `select ${ENTITY_COLUMNS} ${ENTITY_FROM} where e.id = $1 and e.deleted_at is null`,
    [raw.entityId],
  );
  const entity = (await loadUniversalSummaries(q, entityRows, viewerIdentityId))[0];
  if (!entity) throw new CollabError('not_found', `no such entity: ${raw.entityId}`);
  const requestRows = raw.attentionRequestId
    ? await q.query<AttentionRequestRow>(
      `select ${ATTENTION_COLUMNS} from public.attention_requests ar where ar.id = $1`,
      [raw.attentionRequestId],
    )
    : [];
  const request = (await attentionRequestsOf(q, requestRows))[0] ?? null;
  return {
    request,
    entity,
    affectedCount: Number(raw.affectedCount),
    ...(raw.resolutionBatchId !== undefined ? { resolutionBatchId: raw.resolutionBatchId } : {}),
  };
}

export class AttentionService {
  constructor(private readonly deps: FacadeDeps) {}

  readonly list = async (ctx: RequestContext): Promise<AttentionRequestPage> => {
    const owner = await this.deps.owner();
    const spaceId = ctx.query.get('spaceId') ?? '';
    if (!UUID_RE.test(spaceId)) throw new CollabError('invalid_input', 'spaceId must be a uuid');
    const entityId = ctx.query.get('entityId');
    if (entityId !== null && !UUID_RE.test(entityId)) {
      throw new CollabError('invalid_input', 'entityId must be a uuid');
    }
    const status = ctx.query.get('status');
    if (status !== null && !STATUSES.has(status)) {
      throw new CollabError('invalid_input', 'invalid attention request status');
    }
    const minPointsRaw = ctx.query.get('minPoints');
    const minPoints = minPointsRaw === null ? null : Number(minPointsRaw);
    if (minPoints !== null && (!Number.isInteger(minPoints) || minPoints < 1 || minPoints > 100)) {
      throw new CollabError('invalid_input', 'minPoints must be an integer from 1 to 100');
    }
    const limit = limitOf(ctx.query.get('limit'));
    const fp = fingerprint('attentionRequests.list', { spaceId, entityId, status, minPoints });
    return this.deps.db.tx(claimsFor(owner, ctx), async (q) => {
      const values: unknown[] = [spaceId];
      const where = ['ar.space_id = $1'];
      if (entityId) {
        // An entity's requests are its own plus those rolled up to it (R3):
        // the same set its badge counts.
        values.push(entityId);
        const p = `$${values.length}::uuid`;
        where.push(`(ar.entity_id = ${p} or (ar.entity_id = any(internal.attention_root_candidates(${p}))
                     and internal.attention_root_id(ar.entity_id) = ${p}))`);
      }
      if (status) { values.push(status); where.push(`ar.status = $${values.length}`); }
      else where.push(`ar.status in ('open', 'acknowledged')`);
      if (minPoints !== null) { values.push(minPoints); where.push(`ar.points >= $${values.length}`); }
      const cursor = ctx.query.get('cursor');
      if (cursor) {
        const decoded = decodeCursor(cursor);
        if (decoded.k[0] !== fp || decoded.k.length !== 5) {
          throw new CollabError('invalid_cursor', 'attention cursor does not match this query');
        }
        const points = Number(decoded.k[1]);
        const at = String(decoded.k[2] ?? '');
        const id = String(decoded.k[3] ?? '');
        if (!Number.isInteger(points)) throw new CollabError('invalid_cursor', 'invalid attention points cursor');
        if (at.length === 0 || Number.isNaN(Date.parse(at))) {
          throw new CollabError('invalid_cursor', 'cursor contains an invalid timestamp');
        }
        if (!UUID_RE.test(id)) throw new CollabError('invalid_cursor', 'cursor contains an invalid entity id');
        values.push(points, at, id);
        const pointParam = `$${values.length - 2}`;
        const atParam = `$${values.length - 1}`;
        const idParam = `$${values.length}`;
        where.push(`(ar.points < ${pointParam} or (ar.points = ${pointParam} and (ar.created_at, ar.id) > (${atParam}::timestamptz, ${idParam}::uuid)))`);
      }
      const rows = await q.query<AttentionRequestRow>(
        `select ${ATTENTION_COLUMNS}, ${MICROS('ar.created_at')} cursor_created_at
           from public.attention_requests ar
          where ${where.join(' and ')}
          order by ar.points desc, ar.created_at asc, ar.id asc
          limit ${limit + 1}`,
        values,
      );
      const hasMore = rows.length > limit;
      const pageRows = hasMore ? rows.slice(0, limit) : rows;
      const items = await attentionRequestsOf(q, pageRows);
      const last = pageRows.at(-1);
      return {
        items,
        nextCursor: hasMore && last
          ? encodeCursor([fp, Number(last.points), last.cursor_created_at!, last.id, 'attention'])
          : null,
      };
    });
  };

  readonly create = async (ctx: RequestContext): Promise<AttentionRequestMutationResult> => {
    const owner = await this.deps.owner();
    const entityId = requireUuidParam(ctx, 'entityId');
    const input = ctx.body as CreateAttentionRequestInput;
    const envelope = commandEnvelope(ctx);
    return this.deps.db.tx(claimsFor(owner, ctx, envelope), async (q) => {
      const raw = await q.rpc<AttentionMutationRpcResult>('create_attention_request', [
        entityId,
        input.reason,
        // Omitted, the door derives points from the level (chapter 1).
        input.points ?? null,
        envelope.actorId ?? null,
        envelope.clientMutationId ?? null,
        sourceSessionOf(ctx),
        input.level ?? null,
        input.actionType ?? null,
        input.assigneeId ?? null,
      ]);
      return attentionMutationResult(q, raw, owner.identityId);
    });
  };

  readonly update = async (ctx: RequestContext): Promise<AttentionRequestMutationResult> => {
    const owner = await this.deps.owner();
    const requestId = requireUuidParam(ctx, 'requestId');
    const input = ctx.body as UpdateAttentionRequestInput;
    const envelope = commandEnvelope(ctx);
    return this.deps.db.tx(claimsFor(owner, ctx, envelope), async (q) => {
      const raw = await q.rpc<AttentionMutationRpcResult>('update_attention_request', [
        requestId,
        input.expectedVersion,
        input.reason ?? null,
        input.points ?? null,
        input.status ?? null,
        input.resolutionNote ?? null,
        envelope.actorId ?? null,
        envelope.clientMutationId ?? null,
      ]);
      return attentionMutationResult(q, raw, owner.identityId);
    });
  };

  /** Resolve every open request on the entity's roll-up root, as one batch. */
  readonly resolveEntity = async (ctx: RequestContext): Promise<AttentionRequestMutationResult> => {
    const owner = await this.deps.owner();
    const entityId = requireUuidParam(ctx, 'entityId');
    const input = ctx.body as ResolveEntityAttentionInput;
    const envelope = commandEnvelope(ctx);
    return this.deps.db.tx(claimsFor(owner, ctx, envelope), async (q) => {
      const raw = await q.rpc<AttentionMutationRpcResult>('resolve_attention_root', [
        entityId,
        input.resolutionNote ?? null,
        envelope.actorId ?? null,
        envelope.clientMutationId ?? null,
        input.resolutionBatchId ?? null,
      ]);
      return attentionMutationResult(q, raw, owner.identityId);
    });
  };

  readonly markSeen = async (ctx: RequestContext): Promise<AttentionRequestMutationResult> => {
    const owner = await this.deps.owner();
    const entityId = requireUuidParam(ctx, 'entityId');
    const envelope = commandEnvelope(ctx);
    return this.deps.db.tx(claimsFor(owner, ctx, envelope), async (q) => {
      const raw = await q.rpc<AttentionMutationRpcResult>('mark_attention_seen', [
        entityId,
        envelope.clientMutationId ?? null,
      ]);
      return attentionMutationResult(q, raw, owner.identityId);
    });
  };

  readonly unresolve = async (ctx: RequestContext): Promise<AttentionRequestMutationResult> => {
    const owner = await this.deps.owner();
    const batchId = requireUuidParam(ctx, 'batchId');
    const envelope = commandEnvelope(ctx);
    return this.deps.db.tx(claimsFor(owner, ctx, envelope), async (q) => {
      const raw = await q.rpc<AttentionMutationRpcResult>('unresolve_attention_batch', [
        batchId,
        envelope.actorId ?? null,
        envelope.clientMutationId ?? null,
      ]);
      return attentionMutationResult(q, raw, owner.identityId);
    });
  };

  readonly withdraw = async (ctx: RequestContext): Promise<AttentionRequestMutationResult> => {
    const owner = await this.deps.owner();
    const requestId = requireUuidParam(ctx, 'requestId');
    const input = ctx.body as WithdrawAttentionRequestInput;
    const envelope = commandEnvelope(ctx);
    return this.deps.db.tx(claimsFor(owner, ctx, envelope), async (q) => {
      const raw = await q.rpc<AttentionMutationRpcResult>('withdraw_attention_request', [
        requestId,
        input.expectedVersion ?? null,
        envelope.actorId ?? null,
        envelope.clientMutationId ?? null,
      ]);
      return attentionMutationResult(q, raw, owner.identityId);
    });
  };
}
