import {
  CollabError,
  decodeCursor,
  encodeCursor,
  SpaceSettingsViewSchema,
  type LeaderboardRow,
  type MenuConfig,
  type Page,
  type PointEventView,
  type SpaceSettings,
  type SpaceSettingsView,
  type TaskAxis,
  type TaskWorkflow,
} from '@tm8/contract';

import type { DbClaims, Querier } from '../../../db/types.js';
import type { OperationHandler } from '../../../http/types.js';
import { claimsFor, commandEnvelope, limitOf, requireUuidParam } from '../../context.js';
import type { FacadeDeps } from '../../deps.js';
import {
  MICROS,
  actorOf,
  iso,
  isoOrNull,
  loadActors,
  loadEntitySummariesByIds,
} from '../../entity-read.js';
import {
  SPACE_COLUMNS,
  SPACE_FROM,
  toSpaceSummary,
  type SpaceRow,
} from '../../handlers/spaces.js';

type MemberView = SpaceSettings['members'][number];
type InviteView = SpaceSettings['invites'][number];

interface MembershipRow {
  entity_id: string;
  role: 'owner' | 'admin' | 'member';
}

interface MemberRow extends MembershipRow {
  joined_at: Date | string;
}

interface InviteRow {
  id: string;
  code: string;
  role: 'admin' | 'member';
  max_uses: number;
  use_count: number;
  expires_at: Date | string | null;
  revoked_at: Date | string | null;
}

interface TaskAxisRow {
  id: string;
  space_id: string;
  name: string;
  axis_values: string[];
  kind: 'default' | 'manual';
  position: number;
}

interface SettingsSpaceRow extends SpaceRow {
  default_channel_id: string | null;
  default_interaction_profile_id: string | null;
  settings_revision: number;
}

interface MenuRow {
  schema_version: number;
  revision: number;
  payload: { schemaVersion?: number; groups?: unknown[] };
}

interface SpaceMutationResult {
  space: SpaceRow;
}

interface InviteMutationResult {
  invite: InviteRow;
}

interface AxisMutationResult {
  axis: TaskAxisRow;
}

interface TaskWorkflowRow {
  id: string;
  space_id: string;
  type_value: string;
  statuses: TaskWorkflow['statuses'];
}

interface WorkflowMutationResult {
  workflow: TaskWorkflowRow;
}

interface LeaderboardDbRow {
  actor_id: string;
  score: string | number;
  rank: string | number;
}

interface AwardDbRow {
  id: string;
  recipient_id: string;
  actor_id: string;
  amount: number;
  reason: 'grant' | 'award' | 'seed';
  ref_id: string | null;
  created_at: Date | string;
  /**
   * The keyset value, as microsecond TEXT straight from Postgres.
   *
   * REQUIRED, and typed `string` rather than `Date | string`, on purpose. A
   * `timestamptz` handed back as a JavaScript `Date` keeps only MILLISECONDS
   * while Postgres stores MICROSECONDS, so a cursor built from `created_at`
   * lands strictly BEFORE the row it came from. On this DESC keyset that does
   * not loop — it SILENTLY SKIPS every row sharing the truncated millisecond,
   * and rows written in one transaction share an identical `now()`, so a batch
   * lands squarely in the dropped window.
   *
   * ⚠ NEITHER HALF OF WHAT THIS COMMENT USED TO CLAIM IS TRUE. It said that
   * requiring the field makes a query path that forgets the `to_char` fail to
   * COMPILE, and that refusing `Date` stops a raw column being substituted
   * silently. **BOTH ARE FALSE ON THE ONLY PATH THAT PRODUCES THIS ROW.**
   * `Querier.query<R>` (db/types.ts:45) takes `R` as an UNCHECKED CALLER
   * ASSERTION and never sees a SELECT list, so a query that omits the column —
   * or that selects the raw `timestamptz` under this name — typechecks clean.
   * The type is checked only for OBJECT-LITERAL producers, and this row has
   * none. Measured both ways: literal omission → TS2741; SQL omission → exit 0,
   * zero diagnostics.
   *
   * NOT HYPOTHETICAL — `inbox-read-marks.ts` shipped exactly that omission on
   * one of its two producers, undetected by the compiler.
   *
   * THE TYPE STILL EARNS ITS PLACE: it documents the contract and it catches
   * the literal case. It is not a guarantee, and a comment that promises one
   * tells the next reader not to check. `sortKeyOf` (handlers/collections.ts)
   * is the shape that actually refuses at runtime.
   */
  cursor_created_at: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function bodyObject(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new CollabError('invalid_input', 'request body must be an object');
  }
  return body as Record<string, unknown>;
}

function assertStrictKeys(body: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedKeys = new Set(allowed);
  const unknown = Object.keys(body).filter((key) => !allowedKeys.has(key));
  if (unknown.length > 0) {
    throw new CollabError('invalid_input', `unknown request field: ${unknown.sort()[0]}`);
  }
}

function requireMutationId(body: Record<string, unknown>): string {
  const value = body.clientMutationId;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new CollabError('invalid_input', 'clientMutationId is required');
  }
  return value;
}

function optionalActorId(body: Record<string, unknown>): string | null {
  const value = body.actorId;
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw new CollabError('invalid_input', 'actorId must be a uuid');
  }
  return value;
}

function requireString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new CollabError('invalid_input', `${key} is required`);
  }
  return value;
}

function toInvite(row: InviteRow): InviteView {
  return {
    id: row.id,
    code: row.code,
    role: row.role,
    maxUses: Number(row.max_uses),
    uses: Number(row.use_count),
    expiresAt: isoOrNull(row.expires_at),
    revoked: row.revoked_at !== null,
  };
}

function toTaskWorkflow(row: TaskWorkflowRow): TaskWorkflow {
  return {
    id: row.id,
    spaceId: row.space_id,
    typeValue: row.type_value,
    statuses: row.statuses,
  };
}

function toTaskAxis(row: TaskAxisRow): TaskAxis {
  return {
    id: row.id,
    spaceId: row.space_id,
    name: row.name,
    axisValues: row.axis_values,
    kind: row.kind,
    position: Number(row.position),
  };
}

/**
 * THE MEMBERSHIP CHECK IS ABOUT THE CALLER, AND IT TAKES THE CLAIMS TO SAY SO.
 *
 * It used to take a bare `identityId`, and all six call sites handed it
 * `owner.identityId` — the loopback AUTO-OWNER, not whoever is calling. Every
 * one of them then asked "is the node owner a member of this space?" on behalf
 * of a caller who is somebody else, which is wrong in both directions:
 *
 * - a genuine member of a space the node owner does not belong to was refused
 *   `forbidden: not a member of this space` — including that space's own
 *   owner, and including `spaces.settings`, which the workspace boot cannot
 *   complete without. The whole space was unopenable for everyone in it. It
 *   only looked fine on this node's first space, where the node owner happens
 *   to be a member too;
 * - the `'admin'` form read the NODE OWNER's role in the space, so where the
 *   node owner is a space admin, any plain member cleared an admin-only gate
 *   (`spaces.invites.list`).
 *
 * Taking `DbClaims` — the same object bound to this very transaction — makes
 * the two agree by construction: the row this reads is filtered by RLS through
 * `internal.identity_id()`, which is `claims.identityId` and nothing else. A
 * caller cannot be checked as one identity and read as another.
 */
function viewerIdentityOf(claims: DbClaims): string {
  const identityId = claims.identityId;
  // Unreachable through `claimsFor`, which refuses an anonymous request before
  // it can get here. Stated anyway: an absent identity must never fall through
  // to a query that binds it as null — a null `identity_id` matches no member
  // row, so the refusal would come back as `forbidden` and blame membership
  // for what is a missing credential.
  if (!identityId) throw new CollabError('unauthenticated', 'authentication is required');
  return identityId;
}

async function requireMembership(
  q: Querier,
  spaceId: string,
  claims: DbClaims,
  required: 'member' | 'admin' = 'member',
): Promise<MembershipRow> {
  const identityId = viewerIdentityOf(claims);
  const rows = await q.query<MembershipRow>(
    `select membership.entity_id, membership.role
       from public.members membership
      where membership.space_id = $1 and membership.identity_id = $2`,
    [spaceId, identityId],
  );
  const membership = rows[0];
  if (!membership) throw new CollabError('forbidden', 'not a member of this space');
  if (required === 'admin' && membership.role !== 'owner' && membership.role !== 'admin') {
    throw new CollabError('forbidden', 'space administrator role required');
  }
  return membership;
}

async function loadMembers(q: Querier, spaceId: string): Promise<MemberView[]> {
  const rows = await q.query<MemberRow>(
    `select member_row.entity_id, member_row.role, member_row.joined_at
       from public.members member_row
      where member_row.space_id = $1
      order by member_row.joined_at asc, member_row.entity_id asc`,
    [spaceId],
  );
  const actors = await loadActors(q, rows.map((row) => row.entity_id));
  return rows.map((row) => ({
    actor: actorOf(actors, row.entity_id),
    role: row.role,
    joinedAt: iso(row.joined_at),
  }));
}

async function loadInvites(q: Querier, spaceId: string): Promise<InviteView[]> {
  const rows = await q.query<InviteRow>(
    `select id, code, role, max_uses, use_count, expires_at, revoked_at
       from public.space_invites
      where space_id = $1
      order by created_at desc, id desc`,
    [spaceId],
  );
  return rows.map(toInvite);
}

async function loadTaskWorkflows(q: Querier, spaceId: string): Promise<TaskWorkflow[]> {
  const rows = await q.query<TaskWorkflowRow>(
    `select id, space_id, type_value, statuses
       from public.task_workflows
      where space_id = $1
      order by type_value asc, id asc`,
    [spaceId],
  );
  return rows.map(toTaskWorkflow);
}

async function loadTaskAxes(q: Querier, spaceId: string): Promise<TaskAxis[]> {
  const rows = await q.query<TaskAxisRow>(
    `select id, space_id, name, axis_values, kind, position
       from public.task_axes
      where space_id = $1
      order by position asc, name asc, id asc`,
    [spaceId],
  );
  return rows.map(toTaskAxis);
}

function readCursorPair(cursor: string, label: string): [string | number, string] {
  const { k } = decodeCursor(cursor);
  if (k.length !== 2 || !UUID_RE.test(String(k[1]))) {
    throw new CollabError('invalid_cursor', `invalid cursor: expected [${label}, id]`);
  }
  const first = k[0];
  if (typeof first !== 'string' && typeof first !== 'number') {
    throw new CollabError('invalid_cursor', `invalid cursor: expected [${label}, id]`);
  }
  return [first, String(k[1])];
}

export class W2IdentitySpacesService {
  constructor(private readonly deps: FacadeDeps) {}

  readonly spacesUpdate: OperationHandler = async (ctx) => {
    const owner = await this.deps.owner();
    const spaceId = requireUuidParam(ctx, 'spaceId');
    const body = bodyObject(ctx.body);
    const clientMutationId = requireMutationId(body);
    optionalActorId(body);
    const patch = Object.fromEntries(
      ['name', 'description', 'githubRepo']
        .filter((key) => Object.prototype.hasOwnProperty.call(body, key))
        .map((key) => [key, body[key]]),
    );
    if (Object.keys(patch).length === 0) {
      throw new CollabError('invalid_input', 'at least one Space metadata field is required');
    }
    const result = await this.deps.db.rpc<SpaceMutationResult>(
      claimsFor(owner, ctx, commandEnvelope(ctx)),
      'w2_update_space',
      [spaceId, patch, clientMutationId],
    );
    return toSpaceSummary(result.space);
  };

  readonly spacesSettings: OperationHandler = async (ctx) => {
    const owner = await this.deps.owner();
    const spaceId = requireUuidParam(ctx, 'spaceId');
    const claims = claimsFor(owner, ctx);
    return this.deps.db.tx(claims, async (q) => {
      await requireMembership(q, spaceId, claims);
      const spaces = await q.query<SettingsSpaceRow>(
        `select ${SPACE_COLUMNS}, s.default_channel_id,
                s.default_interaction_profile_id, s.settings_revision
           ${SPACE_FROM}
          where s.id = $1`,
        [spaceId],
      );
      const space = spaces[0];
      if (!space) throw new CollabError('not_found', `no such space: ${spaceId}`);

      const members = await loadMembers(q, spaceId);
      const invites = await loadInvites(q, spaceId);
      const taskAxes = await loadTaskAxes(q, spaceId);
      const taskWorkflows = await loadTaskWorkflows(q, spaceId);
      const menuRows = await q.query<MenuRow>(
        `select schema_version, revision, payload
           from public.space_menu_configs
          where space_id = $1`,
        [spaceId],
      );
      const menuRow = menuRows[0];
      if (!menuRow) {
        throw new CollabError('upstream_unavailable', 'Space menu configuration is missing');
      }
      const menu = {
        ...menuRow.payload,
        schemaVersion: menuRow.schema_version,
        revision: menuRow.revision,
      } as MenuConfig;
      const settings: SpaceSettingsView = {
        space: toSpaceSummary(space),
        members,
        invites,
        taskAxes,
        taskWorkflows,
        menu,
        defaultChannelId: space.default_channel_id,
        defaultInteractionProfileId: space.default_interaction_profile_id,
        settingsRevision: Number(space.settings_revision),
      };
      const parsed = SpaceSettingsViewSchema.safeParse(settings);
      if (!parsed.success) {
        throw new CollabError('upstream_unavailable', 'stored Space settings violate the frozen contract');
      }
      return parsed.data;
    });
  };

  readonly spacesMembersList: OperationHandler = async (ctx) => {
    const owner = await this.deps.owner();
    const spaceId = requireUuidParam(ctx, 'spaceId');
    const claims = claimsFor(owner, ctx);
    return this.deps.db.tx(claims, async (q) => {
      await requireMembership(q, spaceId, claims);
      return loadMembers(q, spaceId);
    });
  };

  readonly spacesInvitesList: OperationHandler = async (ctx) => {
    const owner = await this.deps.owner();
    const spaceId = requireUuidParam(ctx, 'spaceId');
    const claims = claimsFor(owner, ctx);
    return this.deps.db.tx(claims, async (q) => {
      await requireMembership(q, spaceId, claims, 'admin');
      return loadInvites(q, spaceId);
    });
  };

  readonly spacesInvitesCreate: OperationHandler = async (ctx) => {
    const owner = await this.deps.owner();
    const spaceId = requireUuidParam(ctx, 'spaceId');
    const body = bodyObject(ctx.body);
    assertStrictKeys(body, ['actorId', 'clientMutationId', 'maxUses', 'expiresAt', 'role']);
    const clientMutationId = requireMutationId(body);
    const actorId = optionalActorId(body);
    const maxUses = body.maxUses ?? 1;
    if (!Number.isInteger(maxUses) || Number(maxUses) <= 0) {
      throw new CollabError('invalid_input', 'maxUses must be a positive integer');
    }
    const expiresAt = body.expiresAt ?? null;
    if (expiresAt !== null && (typeof expiresAt !== 'string' || Number.isNaN(Date.parse(expiresAt)))) {
      throw new CollabError('invalid_input', 'expiresAt must be an ISO timestamp or null');
    }
    // 114 R4. Checked here as well as in SQL, and the two are not redundant:
    // this one turns a wrong word into a 400 with the vocabulary in it, while
    // the SQL check is what actually holds when a caller reaches the RPC by
    // another road. Absent means 'member' — the value every pre-114 invite
    // already had.
    const role = body.role ?? 'member';
    if (role !== 'admin' && role !== 'member') {
      throw new CollabError('invalid_input', "role must be 'admin' or 'member': an invite cannot confer ownership");
    }
    const result = await this.deps.db.rpc<InviteMutationResult>(
      claimsFor(owner, ctx, commandEnvelope(ctx)),
      'create_invite',
      [spaceId, maxUses, expiresAt, actorId, clientMutationId, role],
    );
    return { kind: 'json' as const, status: 201, data: toInvite(result.invite) };
  };

  /**
   * `spaces.members.updateRole` — the space-role writer (118).
   *
   * The subject is the PATH pair (spaceId, memberId) and both travel to SQL,
   * where `set_member_role` names them in ONE predicate. Passing only the
   * member id would authorize against a space the row is not in.
   *
   * Every rule — admin to change anything, owner to touch the owner role, and
   * never demote the last owner — is enforced in the RPC, not here. This
   * handler validates the vocabulary and binds claims; it makes no
   * authorization decision, which is what keeps there being exactly one place
   * the rules live.
   */
  readonly spacesMembersUpdateRole: OperationHandler = async (ctx) => {
    const owner = await this.deps.owner();
    const spaceId = requireUuidParam(ctx, 'spaceId');
    const memberId = requireUuidParam(ctx, 'memberId');
    const body = bodyObject(ctx.body);
    assertStrictKeys(body, ['actorId', 'clientMutationId', 'role']);
    const clientMutationId = requireMutationId(body);
    const actorId = optionalActorId(body);
    const role = requireString(body, 'role');
    if (role !== 'owner' && role !== 'admin' && role !== 'member') {
      throw new CollabError('invalid_input', "role must be 'owner', 'admin' or 'member'");
    }
    return this.deps.db.rpc(
      claimsFor(owner, ctx, commandEnvelope(ctx)),
      'set_member_role',
      [spaceId, memberId, role, actorId, clientMutationId],
    );
  };

  readonly spacesInvitesRevoke: OperationHandler = async (ctx) => {
    const owner = await this.deps.owner();
    const spaceId = requireUuidParam(ctx, 'spaceId');
    const inviteId = requireUuidParam(ctx, 'inviteId');
    const body = bodyObject(ctx.body);
    assertStrictKeys(body, ['actorId', 'clientMutationId']);
    const clientMutationId = requireMutationId(body);
    optionalActorId(body);
    const result = await this.deps.db.rpc<InviteMutationResult>(
      claimsFor(owner, ctx, commandEnvelope(ctx)),
      'w2_revoke_invite',
      [spaceId, inviteId, clientMutationId],
    );
    return toInvite(result.invite);
  };

  readonly spacesInvitesRedeem: OperationHandler = async (ctx) => {
    const owner = await this.deps.owner();
    const body = bodyObject(ctx.body);
    assertStrictKeys(body, ['actorId', 'clientMutationId', 'code']);
    const clientMutationId = requireMutationId(body);
    optionalActorId(body);
    const code = requireString(body, 'code');
    return this.deps.db.rpc(
      // Redeeming creates the caller's human membership. Acting as a persona
      // from another Space is neither an authorization input nor honest audit
      // attribution for this identity-level transition.
      claimsFor(owner, ctx, { clientMutationId }),
      'redeem_invite',
      [code, clientMutationId],
    );
  };

  readonly spacesTaskAxesList: OperationHandler = async (ctx) => {
    const owner = await this.deps.owner();
    const spaceId = requireUuidParam(ctx, 'spaceId');
    const claims = claimsFor(owner, ctx);
    return this.deps.db.tx(claims, async (q) => {
      await requireMembership(q, spaceId, claims);
      return loadTaskAxes(q, spaceId);
    });
  };

  readonly spacesTaskAxesCreate: OperationHandler = async (ctx) => {
    const owner = await this.deps.owner();
    const spaceId = requireUuidParam(ctx, 'spaceId');
    const body = bodyObject(ctx.body);
    const clientMutationId = requireMutationId(body);
    const actorId = optionalActorId(body);
    const result = await this.deps.db.rpc<AxisMutationResult>(
      claimsFor(owner, ctx, commandEnvelope(ctx)),
      'w2_create_task_axis',
      [
        spaceId,
        body.name,
        body.axisValues,
        body.kind,
        body.position,
        actorId,
        clientMutationId,
      ],
    );
    return { kind: 'json' as const, status: 201, data: toTaskAxis(result.axis) };
  };

  readonly spacesTaskAxesUpdate: OperationHandler = async (ctx) => {
    const owner = await this.deps.owner();
    const spaceId = requireUuidParam(ctx, 'spaceId');
    const axisId = requireUuidParam(ctx, 'axisId');
    const body = bodyObject(ctx.body);
    const clientMutationId = requireMutationId(body);
    optionalActorId(body);
    const result = await this.deps.db.rpc<AxisMutationResult>(
      claimsFor(owner, ctx, commandEnvelope(ctx)),
      'w2_update_task_axis',
      [spaceId, axisId, body.name, body.axisValues, body.kind, body.position, clientMutationId],
    );
    return toTaskAxis(result.axis);
  };

  readonly spacesTaskAxesDelete: OperationHandler = async (ctx) => {
    const owner = await this.deps.owner();
    const spaceId = requireUuidParam(ctx, 'spaceId');
    const axisId = requireUuidParam(ctx, 'axisId');
    const body = bodyObject(ctx.body);
    assertStrictKeys(body, ['actorId', 'clientMutationId']);
    const clientMutationId = requireMutationId(body);
    optionalActorId(body);
    await this.deps.db.rpc(
      claimsFor(owner, ctx, commandEnvelope(ctx)),
      'w2_delete_task_axis',
      [spaceId, axisId, clientMutationId],
    );
    return { axisId };
  };

  readonly spacesTaskWorkflowsList: OperationHandler = async (ctx) => {
    const owner = await this.deps.owner();
    const spaceId = requireUuidParam(ctx, 'spaceId');
    const claims = claimsFor(owner, ctx);
    return this.deps.db.tx(claims, async (q) => {
      await requireMembership(q, spaceId, claims);
      return loadTaskWorkflows(q, spaceId);
    });
  };

  readonly spacesTaskWorkflowsUpsert: OperationHandler = async (ctx) => {
    const owner = await this.deps.owner();
    const spaceId = requireUuidParam(ctx, 'spaceId');
    const body = bodyObject(ctx.body);
    const clientMutationId = requireMutationId(body);
    optionalActorId(body);
    const result = await this.deps.db.rpc<WorkflowMutationResult>(
      claimsFor(owner, ctx, commandEnvelope(ctx)),
      'upsert_task_workflow',
      [spaceId, body.typeValue, body.statuses, clientMutationId],
    );
    return toTaskWorkflow(result.workflow);
  };

  readonly spacesTaskWorkflowsDelete: OperationHandler = async (ctx) => {
    const owner = await this.deps.owner();
    const spaceId = requireUuidParam(ctx, 'spaceId');
    const workflowId = requireUuidParam(ctx, 'workflowId');
    const body = bodyObject(ctx.body);
    assertStrictKeys(body, ['actorId', 'clientMutationId']);
    const clientMutationId = requireMutationId(body);
    optionalActorId(body);
    await this.deps.db.rpc(
      claimsFor(owner, ctx, commandEnvelope(ctx)),
      'delete_task_workflow',
      [spaceId, workflowId, clientMutationId],
    );
    return { workflowId };
  };

  readonly spacesLeaderboard: OperationHandler = async (ctx) => {
    const owner = await this.deps.owner();
    const spaceId = requireUuidParam(ctx, 'spaceId');
    const limit = limitOf(ctx.query.get('limit'), 50);
    const cursor = ctx.query.get('cursor');
    const claims = claimsFor(owner, ctx);
    return this.deps.db.tx(claims, async (q) => {
      await requireMembership(q, spaceId, claims);
      const params: unknown[] = [spaceId];
      let cursorSql = '';
      if (cursor) {
        const [rawScore, actorId] = readCursorPair(cursor, 'score');
        const score = Number(rawScore);
        if (!Number.isFinite(score)) {
          throw new CollabError('invalid_cursor', 'invalid cursor: score must be numeric');
        }
        params.push(score, actorId);
        cursorSql = `where (score < $2::bigint or (score = $2::bigint and actor_id > $3::uuid))`;
      }
      const rows = await q.query<LeaderboardDbRow>(
        `with scores as (
           select entity_row.id actor_id, coalesce(sum(point_row.amount), 0)::bigint score
             from public.entities entity_row
             left join public.point_events point_row on point_row.entity_id = entity_row.id
            where entity_row.space_id = $1
              and entity_row.kind in ('member', 'team_member')
              and entity_row.deleted_at is null
            group by entity_row.id
         ), ranked as (
           select actor_id, score, rank() over (order by score desc)::bigint rank
             from scores
         )
         select actor_id, score, rank from ranked
         ${cursorSql}
         order by score desc, actor_id asc
         limit ${limit + 1}`,
        params,
      );
      const hasMore = rows.length > limit;
      const pageRows = hasMore ? rows.slice(0, limit) : rows;
      const actors = await loadActors(q, pageRows.map((row) => row.actor_id));
      const items: LeaderboardRow[] = pageRows.map((row) => ({
        actor: actorOf(actors, row.actor_id),
        score: Number(row.score),
        rank: Number(row.rank),
      }));
      const last = pageRows.at(-1);
      return {
        items,
        nextCursor: hasMore && last ? encodeCursor([Number(last.score), last.actor_id]) : null,
      } satisfies Page<LeaderboardRow>;
    });
  };

  readonly spacesAwards: OperationHandler = async (ctx) => {
    const owner = await this.deps.owner();
    const spaceId = requireUuidParam(ctx, 'spaceId');
    const limit = limitOf(ctx.query.get('limit'), 50);
    const cursor = ctx.query.get('cursor');
    const claims = claimsFor(owner, ctx);
    return this.deps.db.tx(claims, async (q) => {
      await requireMembership(q, spaceId, claims);
      const params: unknown[] = [spaceId];
      let cursorSql = '';
      if (cursor) {
        const [createdAt, id] = readCursorPair(cursor, 'createdAt');
        if (typeof createdAt !== 'string' || Number.isNaN(Date.parse(createdAt))) {
          throw new CollabError('invalid_cursor', 'invalid cursor: createdAt must be an ISO timestamp');
        }
        params.push(createdAt, id);
        cursorSql = `and (point_row.created_at, point_row.id) < ($2::timestamptz, $3::uuid)`;
      }
      const rows = await q.query<AwardDbRow>(
        `select point_row.id, point_row.entity_id recipient_id, point_row.actor_id,
                point_row.amount, point_row.reason, point_row.ref_id, point_row.created_at,
                ${MICROS('point_row.created_at')} cursor_created_at
           from public.point_events point_row
          where point_row.space_id = $1 and point_row.reason = 'award'
          ${cursorSql}
          order by point_row.created_at desc, point_row.id desc
          limit ${limit + 1}`,
        params,
      );
      const hasMore = rows.length > limit;
      const pageRows = hasMore ? rows.slice(0, limit) : rows;
      const actors = await loadActors(
        q,
        pageRows.flatMap((row) => [row.recipient_id, row.actor_id]),
      );
      const summaryIds = pageRows.flatMap((row) => [row.recipient_id, row.ref_id ?? '']);
      // The viewer projection on these summaries (unread, own reaction) is the
      // CALLER's, for the same reason the membership check above is: passing
      // the node owner's identity here handed every caller a stranger's read
      // state.
      const summaries = await loadEntitySummariesByIds(q, summaryIds, viewerIdentityOf(claims));
      const summaryById = new Map(summaries.map((summary) => [summary.id, summary]));
      const items: PointEventView[] = pageRows.map((row) => ({
        id: row.id,
        recipient: actorOf(actors, row.recipient_id),
        actor: actorOf(actors, row.actor_id),
        amount: Number(row.amount),
        reason: row.reason,
        onEntity: summaryById.get(row.recipient_id) ?? null,
        ref: row.ref_id ? (summaryById.get(row.ref_id) ?? null) : null,
        createdAt: iso(row.created_at),
      }));
      const last = pageRows.at(-1);
      return {
        items,
        // Carried verbatim — never through a JS Date. See AwardDbRow.cursor_created_at.
        nextCursor: hasMore && last ? encodeCursor([last.cursor_created_at, last.id]) : null,
      } satisfies Page<PointEventView>;
    });
  };
}
