import { createHash } from 'node:crypto';

import {
  ACTION_ROW_COLUMNS,
  CollabError,
  decodeCursor,
  encodeCursor,
  expandActionRows,
  getOperation,
  type ActionDiscoveryPage,
  type ActionDiscoveryResult,
  type ActionRow,
  type ActionRows,
  type OperationName,
  type PaletteAction,
  type SavedView,
  type SavedViewInput,
  FORM_TRANSITIONS,
  type FormStatus,
} from '@tm8/contract';

import type { Querier } from '../../../db/types.js';
import { headerAuthorable } from '../../../headers/derive.js';
import type { RequestContext } from '../../../http/types.js';
import { actorOf, loadActors } from '../../entity-read.js';
import type { FacadeDeps } from '../../deps.js';
import type { HandlerRegistry } from '../../registry.js';
import { claimsFor, commandEnvelope, optionalUuid, requireUuidParam } from '../../context.js';

interface SavedViewRow {
  id: string;
  space_id: string;
  owner_member_id: string;
  name: string;
  share_mode: 'private' | 'space';
  query: SavedViewInput['query'];
  graph_layout: SavedViewInput['graphLayout'] | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface ActionContextRow {
  id: string;
  space_id: string;
  kind: string;
  version: number;
  deleted_at: Date | string | null;
  work_status: string | null;
  message_author_id: string | null;
  actor_id: string;
  is_space_admin: boolean;
  /** Forms (211): null for every other kind. */
  form_status?: string | null;
  /** The 211 doors' author-or-space-admin rule, for THIS caller. */
  form_can_edit?: boolean | null;
  /** A submitted response exists: questions and sections are frozen. */
  form_frozen?: boolean | null;
  /** The caller may respond (a member, or a teammate on an `anyone` form). */
  form_can_respond?: boolean | null;
  /** The caller holds a draft on this form (RLS: only their own is visible). */
  form_has_draft?: boolean | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireMutationId(ctx: RequestContext): string {
  const value = commandEnvelope(ctx).clientMutationId;
  if (!value) {
    throw new CollabError('invalid_input', 'clientMutationId is required');
  }
  return value;
}

function requireInputUuid(value: string, field: string): string {
  if (!UUID_RE.test(value)) {
    throw new CollabError('invalid_input', `${field} must be a uuid`);
  }
  return value;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

async function toSavedView(q: Querier, row: SavedViewRow): Promise<SavedView> {
  const actors = await loadActors(q, [row.owner_member_id]);
  return {
    id: row.id,
    spaceId: row.space_id,
    name: row.name,
    shareMode: row.share_mode,
    query: row.query,
    ...(row.graph_layout === null ? {} : { graphLayout: row.graph_layout }),
    createdBy: actorOf(actors, row.owner_member_id),
    createdAt: iso(row.created_at),
  };
}

async function listSavedViews(deps: FacadeDeps, ctx: RequestContext): Promise<SavedView[]> {
  const owner = await deps.owner();
  const spaceId = requireUuidParam(ctx, 'spaceId');
  return deps.db.tx(claimsFor(owner, ctx), async (q) => {
    // RLS is the visibility authority: a member sees Space-shared rows plus
    // only their own private rows. The service never reconstructs that rule.
    const rows = await q.query<SavedViewRow>(
      `select id, space_id, owner_member_id, name, share_mode, query,
              graph_layout, created_at, updated_at
         from public.saved_views
        where space_id = $1
        order by created_at desc, id desc`,
      [spaceId],
    );
    const actors = await loadActors(q, rows.map((row) => row.owner_member_id));
    return rows.map((row) => ({
      id: row.id,
      spaceId: row.space_id,
      name: row.name,
      shareMode: row.share_mode,
      query: row.query,
      ...(row.graph_layout === null ? {} : { graphLayout: row.graph_layout }),
      createdBy: actorOf(actors, row.owner_member_id),
      createdAt: iso(row.created_at),
    }));
  });
}

async function createSavedView(deps: FacadeDeps, ctx: RequestContext): Promise<SavedView> {
  const owner = await deps.owner();
  const input = ctx.body as SavedViewInput;
  const envelope = commandEnvelope(ctx);
  const clientMutationId = requireMutationId(ctx);
  const spaceId = requireInputUuid(input.query.spaceId, 'query.spaceId');

  return deps.db.tx(claimsFor(owner, ctx, envelope), async (q) => {
    const row = await q.rpc<SavedViewRow>('create_saved_view', [
      spaceId,
      input.name,
      input.shareMode,
      JSON.stringify(input.query),
      input.graphLayout === undefined ? null : JSON.stringify(input.graphLayout),
      envelope.actorId ?? null,
      clientMutationId,
    ]);
    return toSavedView(q, row);
  });
}

async function updateSavedView(deps: FacadeDeps, ctx: RequestContext): Promise<SavedView> {
  const owner = await deps.owner();
  const input = ctx.body as SavedViewInput;
  const envelope = commandEnvelope(ctx);
  const clientMutationId = requireMutationId(ctx);
  const viewId = requireUuidParam(ctx, 'viewId');
  requireInputUuid(input.query.spaceId, 'query.spaceId');

  return deps.db.tx(claimsFor(owner, ctx, envelope), async (q) => {
    const row = await q.rpc<SavedViewRow>('update_saved_view', [
      viewId,
      input.name,
      input.shareMode,
      JSON.stringify(input.query),
      input.graphLayout === undefined ? null : JSON.stringify(input.graphLayout),
      envelope.actorId ?? null,
      clientMutationId,
    ]);
    return toSavedView(q, row);
  });
}

async function deleteSavedView(deps: FacadeDeps, ctx: RequestContext): Promise<SavedView> {
  const owner = await deps.owner();
  const envelope = commandEnvelope(ctx);
  const clientMutationId = requireMutationId(ctx);
  const viewId = requireUuidParam(ctx, 'viewId');

  return deps.db.tx(claimsFor(owner, ctx, envelope), async (q) => {
    const row = await q.rpc<SavedViewRow>('delete_saved_view', [
      viewId,
      envelope.actorId ?? null,
      clientMutationId,
    ]);
    return toSavedView(q, row);
  });
}

const ADMIN_SPACE_OPERATIONS = new Set<OperationName>([
  'spaces.update',
  'spaces.settings',
  'spaces.invites.list',
  'spaces.invites.create',
  'spaces.invites.revoke',
  'spaces.taskAxes.create',
  'spaces.taskAxes.update',
  'spaces.taskAxes.delete',
  'projects.link',
  'spaces.projects.create',
  'projects.unlink',
  'entityKinds.create',
  'entityKinds.update',
  'spaces.menu.update',
  'spaces.defaultChannel.set',
  'interactionProfiles.propose',
  'spaces.interactionProfile.setDefault',
  'spaces.chatDefaults.set',
]);

// `container` is deliberately ABSENT from EDITABLE_KINDS: `entities.patch`
// refuses the kind outright (it is in RESTRICTED_LIFECYCLE_KINDS), so listing
// it here would advertise an action the only door for it refuses. A container
// is renamed through `containers.update`.
const EDITABLE_KINDS = new Set(['task', 'doc', 'channel', 'collection', 'team_member', 'spell', 'skill']);
// READING structure vs CHANGING it — one set could not answer both once
// `container` arrived, and conflating them is how an action list comes to
// advertise a verb the door refuses.
//
// `container` IS hierarchical to READ: nesting is real (a `dind`/microvm
// parent holds children, §4.2), the tree renders it, and `entities.children`
// answers for it. It is NOT movable: `entities.move` calls
// `assertGenericLifecycle`, which refuses the kind, because re-parenting a
// container would move a running runtime between owners without the runtime
// hearing about it.
const HIERARCHICAL_KINDS = new Set(['task', 'doc', 'channel', 'collection', 'container']);
const MOVABLE_KINDS = new Set(['task', 'doc', 'channel', 'collection']);
const PULLABLE_KINDS = new Set(['channel', 'task', 'doc', 'file', 'spell', 'skill', 'collection']);

function operationParams(operation: OperationName): string[] {
  return [...getOperation(operation).path.matchAll(/:([A-Za-z]+)/g)].map((match) => match[1] ?? '');
}

function structurallyAvailable(operation: OperationName, row: ActionContextRow): boolean {
  const live = row.deleted_at === null;
  switch (operation) {
    case 'entities.get':
    case 'entities.activity':
    case 'entities.connections':
    case 'entities.versions':
    case 'entities.react':
    case 'entities.feed':
    case 'entities.context':
    case 'presence.get':
      return live;
    case 'entities.patch':
      return live && EDITABLE_KINDS.has(row.kind);
    // The header doors refuse any other kind (216); the edit right is theirs.
    case 'entities.header.set':
    case 'entities.header.clear':
      return live && headerAuthorable(row.kind);
    case 'entities.move':
      return live && MOVABLE_KINDS.has(row.kind);
    case 'entities.delete':
      // `container` joins the refusals: it is DESTROYED, not deleted, and
      // `containers.destroy` stops the runtime before soft-deleting the
      // envelope. Advertising a delete the door refuses would offer a control
      // whose only outcome is a 403. `space_link` likewise (W6 review D1):
      // `spaceLinks.remove` is its only delete.
      return live && row.kind !== 'member' && row.kind !== 'project'
        && row.kind !== 'interaction_profile' && row.kind !== 'container'
        && row.kind !== 'space_link';
    case 'entities.restore':
      return false;
    case 'entities.children':
    case 'entities.hierarchy':
      return live && HIERARCHICAL_KINDS.has(row.kind);
    case 'entities.points.add':
      return live && (row.kind === 'member' || row.kind === 'team_member');
    case 'entities.commands.complete':
    case 'entities.commands.tick':
      return live && row.kind === 'task' && row.work_status !== 'done';
    case 'entities.commands.work':
      return live && row.kind === 'task';
    case 'entities.commands.pull':
      return live && PULLABLE_KINDS.has(row.kind);
    case 'entities.commands.linkPr':
    case 'entities.commands.linkCommit':
      return live && row.kind === 'task';
    case 'messages.list':
      return live;
    case 'messages.edit':
      return live && row.kind === 'message' && row.message_author_id === row.actor_id;
    case 'messages.delete':
    case 'messages.attachments.add':
    case 'messages.attachments.remove':
      return live && row.kind === 'message'
        && (row.message_author_id === row.actor_id || row.is_space_admin);
    case 'messages.delivery.get':
      return live && row.kind === 'message';
    case 'files.download':
      return live && row.kind === 'file';
    case 'execution.terminate':
    case 'execution.streams.attach':
    case 'handoffs.send':
    case 'handoffs.list':
      return live && row.kind === 'work_session' && row.is_space_admin;
    case 'projects.associations.correct':
      return live && row.is_space_admin && (row.kind === 'pull_request' || row.kind === 'commit');
    case 'interactionProfiles.updateDraft':
    case 'interactionProfiles.validate':
    case 'interactionProfiles.preview':
    case 'interactionProfiles.activate':
    case 'interactionProfiles.retire':
      return live && row.is_space_admin && row.kind === 'interaction_profile';
    case 'teamMembers.interactionProfile.setDefault':
      return live && row.is_space_admin && row.kind === 'team_member';
    // Forms (211): the SAME rules the doors enforce, read off the form's
    // status so an agent discovers submit/close/reopen/cancel from state.
    case 'forms.update':
      return live && row.kind === 'form' && row.form_can_edit === true && row.form_status !== 'cancelled';
    case 'forms.questions.add':
    case 'forms.questions.update':
    case 'forms.questions.remove':
    case 'forms.questions.move':
      return live && row.kind === 'form' && row.form_can_edit === true
        && row.form_status !== 'cancelled' && row.form_frozen !== true;
    case 'forms.transition':
      // Offered exactly when FORM_TRANSITIONS (the contract's copy of 211's
      // lifecycle) names a target from this status.
      return live && row.kind === 'form' && row.form_can_edit === true
        && (FORM_TRANSITIONS[row.form_status as FormStatus]?.length ?? 0) > 0;
    case 'forms.responses.save':
    case 'forms.responses.submit':
      return live && row.kind === 'form' && row.form_status === 'open' && row.form_can_respond === true;
    case 'forms.responses.discard':
      return live && row.kind === 'form' && row.form_has_draft === true;
    case 'forms.responses.list':
      return live && row.kind === 'form';
    default:
      return false;
  }
}

function isAvailable(operation: OperationName, row: ActionContextRow | null): boolean {
  if (operation === 'actions.list' || operation === 'execution.prompt') return false;
  const binding = getOperation(operation);
  if (binding.status === 'reserved' || binding.method === 'WS') return false;
  const params = operationParams(operation);

  // Parameter-free operations are real palette composers in both global and
  // contextual discovery. They may open a form, but they never claim a target.
  // AUTHORIZATION stops here; whether one is SHOWN beside a context entity is
  // `actionScope`'s separate, presentation-only question.
  if (params.length === 0) return true;
  if (!row) return false;

  // A context entity supplies its Space authorization boundary. Operations
  // with a second resource parameter still need an explicit target and are not
  // advertised as immediately invokable.
  if (params.every((param) => param === 'spaceId')) {
    return !ADMIN_SPACE_OPERATIONS.has(operation) || row.is_space_admin;
  }

  return structurallyAvailable(operation, row);
}

/**
 * Parameter-free operations whose BODY or QUERY names the context entity —
 * the anchor of a message, the source of an edge, the parent of a child. They
 * carry no path parameter, yet on this kind of entity they are about the
 * entity, so they belong in its contextual list. Every other parameter-free
 * operation (`auth.*`, `spaces.create`, `identity.get`, …) is global: it
 * answers the same way on every entity and is withheld from the contextual
 * list unless the caller asks for `scope=all`.
 */
function anchoredOn(operation: OperationName, row: ActionContextRow): boolean {
  if (row.deleted_at !== null) return false;
  switch (operation) {
    case 'messages.post':
    case 'edges.create':
    case 'edges.list':
    case 'placements.apply':
    case 'attentionRequests.list':
    case 'graph.query':
    case 'files.uploadInit':
      return true;
    case 'entities.create':
    case 'collections.query':
      return MOVABLE_KINDS.has(row.kind);
    case 'tracking.refresh':
      return row.kind === 'task' || row.kind === 'pull_request' || row.kind === 'commit';
    case 'execution.spawn':
    case 'execution.dispatch':
      return row.kind === 'task';
    default:
      return false;
  }
}

/**
 * Where an AUTHORIZED operation sits relative to a context entity.
 *
 *   entity  acts on or with this entity — the default contextual list
 *   space   needs only the entity's Space (`spaces.get`, `savedViews.list`)
 *   global  needs nothing at all (`auth.logout`, `spaces.create`)
 *
 * Presentation only: the complete authorized inventory is still one
 * `scope=all` away, and the capabilityEpoch is computed over that inventory.
 */
type ActionScope = 'entity' | 'space' | 'global';

function actionScope(operation: OperationName, row: ActionContextRow): ActionScope {
  const params = operationParams(operation);
  if (params.length === 0) return anchoredOn(operation, row) ? 'entity' : 'global';
  if (params.every((param) => param === 'spaceId')) return 'space';
  return 'entity';
}

/**
 * What an agent most plausibly wants to do next on an entity, most relevant
 * first. A kind's head list is followed by this generic order; anything named
 * in neither keeps registry order after both. Deterministic by construction:
 * the inputs are the operation name, the kind and the stored work status.
 */
const GENERIC_RELEVANCE: readonly OperationName[] = [
  'messages.post',
  'entities.context',
  'entities.patch',
  'messages.list',
  'edges.create',
  'entities.get',
  'entities.children',
  'entities.hierarchy',
  'entities.connections',
  'edges.list',
  'entities.activity',
  'entities.feed',
  'entities.versions',
  'entities.react',
  'placements.apply',
  'entities.create',
  'entities.move',
  'files.uploadInit',
  'attentionRequests.list',
  'graph.query',
  'collections.query',
  'presence.get',
  'entities.delete',
];

const ACTIVE_WORK = new Set(['working', 'in_review']);

function kindRelevance(row: ActionContextRow): readonly OperationName[] {
  switch (row.kind) {
    case 'task':
      if (row.work_status !== null && ACTIVE_WORK.has(row.work_status)) {
        return [
          'entities.commands.complete',
          'messages.post',
          'entities.commands.tick',
          'entities.commands.linkPr',
          'entities.commands.linkCommit',
          'entities.patch',
          'edges.create',
          'tracking.refresh',
          'entities.context',
        ];
      }
      if (row.work_status === 'done' || row.work_status === 'cancelled') {
        return ['messages.post', 'entities.context', 'entities.patch'];
      }
      return [
        'entities.commands.work',
        'entities.commands.pull',
        'messages.post',
        'entities.patch',
        'execution.spawn',
        'execution.dispatch',
        'entities.context',
        'entities.commands.complete',
        'entities.commands.tick',
      ];
    case 'message':
      return [
        'messages.post',
        'messages.edit',
        'entities.react',
        'messages.attachments.add',
        'messages.attachments.remove',
        'messages.delivery.get',
        'messages.delete',
      ];
    case 'channel':
      return ['messages.post', 'messages.list', 'entities.context'];
    case 'work_session':
      return [
        'messages.post',
        'handoffs.send',
        'handoffs.list',
        'execution.streams.attach',
        'execution.terminate',
      ];
    case 'pull_request':
    case 'commit':
      return ['tracking.refresh', 'messages.post', 'projects.associations.correct'];
    case 'file':
      return ['files.download', 'messages.post'];
    case 'team_member':
      return [
        'messages.post',
        'entities.points.add',
        'entities.patch',
        'teamMembers.interactionProfile.setDefault',
      ];
    case 'member':
      return ['messages.post', 'entities.points.add'];
    case 'form':
      switch (row.form_status) {
        case 'open':
          return [
            'forms.responses.submit', 'forms.responses.save', 'forms.responses.discard',
            'messages.post', 'forms.responses.list', 'forms.transition', 'entities.context',
          ];
        case 'draft':
          return [
            'forms.transition', 'forms.questions.add', 'forms.update', 'forms.questions.update',
            'forms.questions.move', 'forms.questions.remove', 'messages.post', 'entities.context',
          ];
        case 'closed':
          return ['forms.responses.list', 'forms.transition', 'messages.post', 'entities.context'];
        default:
          return ['forms.responses.list', 'messages.post', 'entities.context'];
      }
    case 'interaction_profile':
      return [
        'interactionProfiles.updateDraft',
        'interactionProfiles.validate',
        'interactionProfiles.preview',
        'interactionProfiles.activate',
        'interactionProfiles.retire',
      ];
    default:
      return [];
  }
}

const SCOPE_ORDER: Record<ActionScope, number> = { entity: 0, space: 1, global: 2 };

/**
 * Order authorized operations for a context entity: scope first (entity, then
 * space, then global), then relevance within the scope, then registry order.
 * The byte-capped `entities.context` actions section trims from the END, so
 * this order is what decides which rows survive the cap.
 */
function rankForContext(
  operations: readonly OperationName[],
  row: ActionContextRow,
): OperationName[] {
  const rank = new Map<OperationName, number>();
  for (const operation of [...kindRelevance(row), ...GENERIC_RELEVANCE]) {
    if (!rank.has(operation)) rank.set(operation, rank.size);
  }
  return operations
    .map((operation, index) => ({
      operation,
      scope: SCOPE_ORDER[actionScope(operation, row)],
      relevance: rank.get(operation) ?? rank.size,
      index,
    }))
    .sort((a, b) => a.scope - b.scope || a.relevance - b.relevance || a.index - b.index)
    .map((entry) => entry.operation);
}

type DiscoveryScope = 'contextual' | 'all';

function discoveryScope(raw: string | null): DiscoveryScope {
  if (raw === null || raw === 'contextual') return 'contextual';
  if (raw === 'all') return 'all';
  throw new CollabError('invalid_input', 'scope must be contextual or all');
}

function authzTarget(operation: OperationName): PaletteAction['authzTarget'] {
  if (operation === 'identity.get' || operation === 'spaces.list' || operation === 'spaces.create') {
    return 'server';
  }
  if (operation.startsWith('spaces.') || operation.startsWith('savedViews.')
      || operation.startsWith('entityKinds.') || operation.startsWith('events.')) {
    return 'space';
  }
  if (operation.startsWith('projects.')) return 'project';
  if (operation.startsWith('execution.') || operation.startsWith('handoffs.')) return 'session';
  return 'entity';
}

function actionKind(operation: OperationName): PaletteAction['kind'] {
  const binding = getOperation(operation);
  if (/create|post|propose|spawn|uploadInit/.test(operation)) return 'create';
  if (/link|edge|association/.test(operation)) return 'link';
  if (/pull/.test(operation)) return 'pull';
  if (binding.kind === 'command') return 'status';
  return 'navigate';
}

function exposure(operation: OperationName): PaletteAction['exposure'] {
  return operation === 'messages.post' ? 'composite' : 'public';
}

function capabilityEpoch(
  actorId: string,
  row: ActionContextRow | null,
  operations: readonly OperationName[],
): string {
  const digest = createHash('sha256').update(JSON.stringify({
    actorId,
    target: row ? {
      id: row.id,
      spaceId: row.space_id,
      kind: row.kind,
      version: row.version,
      admin: row.is_space_admin,
      status: row.work_status ?? row.form_status ?? null,
      form: row.kind === 'form'
        ? [row.form_can_edit, row.form_frozen, row.form_can_respond, row.form_has_draft]
        : null,
    } : null,
    operations,
  })).digest('hex');
  return `cap:${digest}`;
}

async function actionContext(q: Querier, entityId: string): Promise<ActionContextRow> {
  const rows = await q.query<ActionContextRow>(
    `select e.id, e.space_id, e.kind, e.version, e.deleted_at,
            t.work_status, m.author_id message_author_id,
            internal.current_member_id(e.space_id)::text actor_id,
            internal.is_space_admin(e.space_id) is_space_admin,
            f.status form_status,
            case when f.entity_id is not null then
              e.created_by = coalesce(internal.actor_id(), internal.current_member_id(e.space_id))
              or internal.is_space_admin(e.space_id)
            end form_can_edit,
            case when f.entity_id is not null then
              exists (select 1 from public.form_responses r where r.form_id = e.id and r.is_current)
            end form_frozen,
            case when f.entity_id is not null then
              coalesce(who.kind = 'member'
                       or (who.kind = 'team_member' and f.settings->>'respondents' = 'anyone'), false)
            end form_can_respond,
            case when f.entity_id is not null then
              exists (select 1 from public.form_responses r
                       where r.form_id = e.id and r.status = 'draft'
                         and internal.form_is_caller(r.respondent_id))
            end form_has_draft
       from public.entities e
       left join public.tasks t on t.entity_id = e.id
       left join public.messages m on m.entity_id = e.id
       left join public.forms f on f.entity_id = e.id
       left join public.entities who
         on who.id = coalesce(internal.actor_id(), internal.current_member_id(e.space_id))
      where e.id = $1 and e.deleted_at is null`,
    [entityId],
  );
  const row = rows[0];
  if (!row || !row.actor_id) {
    throw new CollabError('not_found', `no readable entity: ${entityId}`);
  }
  return row;
}

/** A v2 page's default and maximum row count. Every page is bounded by these. */
const ACTIONS_PAGE_DEFAULT = 20;
const ACTIONS_PAGE_MAX = 100;

/**
 * One discovery answer in the factored form, before paging, plus the means to
 * continue it. Both `actions.list` and `entities.context`'s actions section
 * are projections of this, so they cannot disagree about rows, order or epoch.
 */
export interface ActionDiscovery {
  /** Every row in the requested scope, ranked; `total === rows.length`. */
  readonly compact: ActionRows;
  /** Names this listing: context entity, scope and capabilityEpoch. */
  readonly fingerprint: string;
}

/** The keyset cursor that continues a listing after `operation`. */
export function cursorAfter(discovery: ActionDiscovery, operation: OperationName): string {
  return encodeCursor([discovery.fingerprint, operation]);
}

/**
 * The cursor names the listing it continues: the context entity, the scope and
 * the capabilityEpoch. A different epoch means the authorized inventory, the
 * target's version or its state moved, so the ranked list the cursor points
 * into no longer exists — `invalid_cursor` is honest, a silent restart is not.
 */
function listingFingerprint(contextEntityId: string | null, scope: DiscoveryScope, epoch: string): string {
  return createHash('sha256')
    .update(JSON.stringify({ contextEntityId, scope, epoch }))
    .digest('hex')
    .slice(0, 16);
}

async function discover(
  deps: FacadeDeps,
  registry: HandlerRegistry,
  ctx: RequestContext,
  contextEntityId: string | null,
  scope: DiscoveryScope,
): Promise<ActionDiscovery> {
  const owner = await deps.owner();
  return deps.db.tx(claimsFor(owner, ctx), async (q) => {
    const row = contextEntityId ? await actionContext(q, contextEntityId) : null;
    const actorId = row?.actor_id ?? owner.identityId;
    // The epoch digests the COMPLETE authorized inventory in registry order,
    // never the filtered or ranked view: two views of the same capability
    // state must carry the same epoch, and a client comparing epochs must not
    // see a change that is only a change of presentation.
    const authorized = registry.implemented().filter((operation) => isAvailable(operation, row));
    const epoch = capabilityEpoch(actorId, row, authorized);
    // Without a context entity every authorized operation is already global,
    // and the order stays the registry's. With one, the entity's own
    // operations lead, most relevant first; space and global ones follow only
    // under `scope=all`.
    const operations = row
      ? rankForContext(authorized, row).filter((operation) =>
        scope === 'all' || actionScope(operation, row) === 'entity')
      : authorized;
    return {
      compact: {
        schema: 'tm8.actions.v2',
        actorId,
        ...(row ? { target: { id: row.id, kind: row.kind, version: row.version } } : {}),
        capabilityEpoch: epoch,
        columns: ACTION_ROW_COLUMNS,
        rows: operations.map((operation): ActionRow => [
          operation, actionKind(operation), authzTarget(operation), exposure(operation),
        ]),
        total: operations.length,
      },
      fingerprint: listingFingerprint(row?.id ?? null, scope, epoch),
    };
  });
}

type ActionsSchema = 'v1' | 'v2';

function actionsSchema(raw: string | null): ActionsSchema {
  if (raw === null || raw === 'v1') return 'v1';
  if (raw === 'v2') return 'v2';
  throw new CollabError('invalid_input', 'schema must be v1 or v2');
}

function pageLimit(raw: string | null): number {
  if (raw === null) return ACTIONS_PAGE_DEFAULT;
  const value = /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : Number.NaN;
  if (!Number.isInteger(value) || value < 1 || value > ACTIONS_PAGE_MAX) {
    throw new CollabError('invalid_input', `limit must be an integer from 1 to ${ACTIONS_PAGE_MAX}`);
  }
  return value;
}

/** Where a page starts: 0, or one past the operation the cursor names. */
function pageStart(discovery: ActionDiscovery, cursor: string | null): number {
  if (cursor === null) return 0;
  const { k } = decodeCursor(cursor);
  const last = k[1];
  const index = typeof last === 'string'
    ? discovery.compact.rows.findIndex(([operation]) => operation === last)
    : -1;
  if (k.length !== 2 || k[0] !== discovery.fingerprint || index < 0) {
    throw new CollabError(
      'invalid_cursor',
      'cursor does not continue this listing: its target, scope or capabilityEpoch changed; list again without a cursor',
    );
  }
  return index + 1;
}

/** A v2 page of a discovery answer. */
function actionPage(
  discovery: ActionDiscovery,
  options: { limit: number; cursor: string | null },
): ActionDiscoveryPage {
  const start = pageStart(discovery, options.cursor);
  const rows = discovery.compact.rows.slice(start, start + options.limit);
  const last = rows.at(-1);
  const more = start + rows.length < discovery.compact.rows.length;
  return {
    ...discovery.compact,
    rows,
    nextCursor: more && last ? cursorAfter(discovery, last[0]) : null,
  };
}

async function listActions(
  deps: FacadeDeps,
  registry: HandlerRegistry,
  ctx: RequestContext,
): Promise<ActionDiscoveryResult | ActionDiscoveryPage> {
  const rawContextId = ctx.query.get('contextEntityId');
  const contextEntityId = optionalUuid(rawContextId, 'contextEntityId');
  const scope = discoveryScope(ctx.query.get('scope'));
  const schema = actionsSchema(ctx.query.get('schema'));
  const rawLimit = ctx.query.get('limit');
  const cursor = ctx.query.get('cursor');
  // v1 is the unpaged legacy shape, kept for one release; paging is a v2
  // capability, and a v1 caller asking to page is told so rather than
  // silently handed the whole inventory.
  if (schema === 'v1' && (rawLimit !== null || cursor !== null)) {
    throw new CollabError('invalid_input', 'limit and cursor require schema=v2');
  }
  const limit = pageLimit(rawLimit);

  const discovery = await discover(deps, registry, ctx, contextEntityId, scope);
  return schema === 'v2'
    ? actionPage(discovery, { limit, cursor })
    : expandActionRows(discovery.compact);
}

export function createSavedViewsActionsService(deps: FacadeDeps, registry: HandlerRegistry) {
  return {
    listSavedViews: (ctx: RequestContext) => listSavedViews(deps, ctx),
    createSavedView: (ctx: RequestContext) => createSavedView(deps, ctx),
    updateSavedView: (ctx: RequestContext) => updateSavedView(deps, ctx),
    deleteSavedView: (ctx: RequestContext) => deleteSavedView(deps, ctx),
    listActions: (ctx: RequestContext) => listActions(deps, registry, ctx),
    discoverActions: (ctx: RequestContext, contextEntityId: string) =>
      discover(deps, registry, ctx, contextEntityId, 'contextual'),
  };
}
