import { createHash } from 'node:crypto';

import {
  CollabError,
  getOperation,
  type ActionDiscoveryResult,
  type OperationName,
  type PaletteAction,
  type SavedView,
  type SavedViewInput,
} from '@tm8/contract';

import type { Querier } from '../../../db/types.js';
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
  'projects.unlink',
  'entityKinds.create',
  'entityKinds.update',
  'spaces.menu.update',
  'spaces.defaultChannel.set',
  'interactionProfiles.propose',
  'spaces.interactionProfile.setDefault',
]);

const EDITABLE_KINDS = new Set(['task', 'doc', 'channel', 'collection', 'team_member', 'spell', 'skill']);
const HIERARCHICAL_KINDS = new Set(['task', 'doc', 'channel', 'collection']);
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
    case 'entities.move':
      return live && HIERARCHICAL_KINDS.has(row.kind);
    case 'entities.delete':
      return live && row.kind !== 'member' && row.kind !== 'project' && row.kind !== 'interaction_profile';
    case 'entities.restore':
      return false;
    case 'entities.children':
    case 'entities.hierarchy':
      return live && HIERARCHICAL_KINDS.has(row.kind);
    case 'entities.points.add':
      return live && (row.kind === 'member' || row.kind === 'team_member');
    case 'entities.commands.complete':
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
      status: row.work_status,
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
            internal.is_space_admin(e.space_id) is_space_admin
       from public.entities e
       left join public.tasks t on t.entity_id = e.id
       left join public.messages m on m.entity_id = e.id
      where e.id = $1 and e.deleted_at is null`,
    [entityId],
  );
  const row = rows[0];
  if (!row || !row.actor_id) {
    throw new CollabError('not_found', `no readable entity: ${entityId}`);
  }
  return row;
}

async function listActions(
  deps: FacadeDeps,
  registry: HandlerRegistry,
  ctx: RequestContext,
): Promise<ActionDiscoveryResult> {
  const owner = await deps.owner();
  const rawContextId = ctx.query.get('contextEntityId');
  const contextEntityId = optionalUuid(rawContextId, 'contextEntityId');

  return deps.db.tx(claimsFor(owner, ctx), async (q) => {
    const row = contextEntityId ? await actionContext(q, contextEntityId) : null;
    const actorId = row?.actor_id ?? owner.identityId;
    const operations = registry.implemented().filter((operation) => isAvailable(operation, row));
    const epoch = capabilityEpoch(actorId, row, operations);
    const actions: PaletteAction[] = operations.map((operation) => ({
      id: `action:${operation}:${row?.id ?? 'global'}`,
      label: operation.replaceAll('.', ' '),
      kind: actionKind(operation),
      operation,
      ...(row ? { targetEntityId: row.id, targetVersion: row.version } : {}),
      capabilityEpoch: epoch,
      authzTarget: authzTarget(operation),
      exposure: exposure(operation),
      helpRef: `tm8://help/operation/${operation}`,
    }));

    return {
      actorId,
      ...(row ? { targetEntityId: row.id, targetVersion: row.version } : {}),
      capabilityEpoch: epoch,
      actions,
    };
  });
}

export function createSavedViewsActionsService(deps: FacadeDeps, registry: HandlerRegistry) {
  return {
    listSavedViews: (ctx: RequestContext) => listSavedViews(deps, ctx),
    createSavedView: (ctx: RequestContext) => createSavedView(deps, ctx),
    updateSavedView: (ctx: RequestContext) => updateSavedView(deps, ctx),
    deleteSavedView: (ctx: RequestContext) => deleteSavedView(deps, ctx),
    listActions: (ctx: RequestContext) => listActions(deps, registry, ctx),
  };
}
