/**
 * The operation catalog (T-L12, api-design 02 §4) — canonical, transport-
 * independent operation names + their HTTP bindings, extended with the tm8
 * families (`execution.*` per R16, `entityKinds.*` per T-L4).
 *
 * HTTP facade, CLI, and future MCP tools are projections of THIS list — never
 * parallel APIs. `status: 'reserved'` operations are part of the contract but
 * deliberately unbuilt in v1: every deployment must answer them with an honest
 * `501 not_implemented` (DEV-13), never a 404.
 *
 * Path params use `:param` notation; all paths are relative to the server
 * origin (tm8-server, port 4610 by default) and already include the `/v2`
 * mount.
 */

export type OperationKind = 'read' | 'command' | 'stream';
export type OperationStatus = 'v1' | 'reserved';

export interface OperationBinding {
  name: string;
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE' | 'WS';
  path: string;
  kind: OperationKind;
  status: OperationStatus;
}

export const BASE_PATH = '/v2';

export const OPERATIONS = [
  // identity & spaces
  { name: 'identity.get',            method: 'GET',    path: '/v2/identity',                                kind: 'read',    status: 'v1' },
  { name: 'spaces.list',             method: 'GET',    path: '/v2/spaces',                                  kind: 'read',    status: 'v1' },
  { name: 'spaces.create',           method: 'POST',   path: '/v2/spaces',                                  kind: 'command', status: 'v1' },
  { name: 'spaces.get',              method: 'GET',    path: '/v2/spaces/:spaceId',                         kind: 'read',    status: 'v1' },
  { name: 'spaces.update',           method: 'PATCH',  path: '/v2/spaces/:spaceId',                         kind: 'command', status: 'v1' },
  { name: 'spaces.navigation',       method: 'GET',    path: '/v2/spaces/:spaceId/navigation',              kind: 'read',    status: 'v1' },
  { name: 'spaces.home',             method: 'GET',    path: '/v2/spaces/:spaceId/home',                    kind: 'read',    status: 'v1' },
  { name: 'spaces.settings',         method: 'GET',    path: '/v2/spaces/:spaceId/settings',                kind: 'read',    status: 'v1' },
  { name: 'spaces.members.list',     method: 'GET',    path: '/v2/spaces/:spaceId/members',                 kind: 'read',    status: 'v1' },
  { name: 'spaces.invites.list',     method: 'GET',    path: '/v2/spaces/:spaceId/invites',                 kind: 'read',    status: 'v1' },
  { name: 'spaces.invites.create',   method: 'POST',   path: '/v2/spaces/:spaceId/invites',                 kind: 'command', status: 'v1' },
  { name: 'spaces.invites.revoke',   method: 'POST',   path: '/v2/spaces/:spaceId/invites/:inviteId/revoke', kind: 'command', status: 'v1' },
  { name: 'spaces.invites.redeem',   method: 'POST',   path: '/v2/invites/redeem',                          kind: 'command', status: 'v1' },
  { name: 'spaces.taskAxes.list',    method: 'GET',    path: '/v2/spaces/:spaceId/task-axes',               kind: 'read',    status: 'v1' },
  { name: 'spaces.taskAxes.create',  method: 'POST',   path: '/v2/spaces/:spaceId/task-axes',               kind: 'command', status: 'v1' },
  { name: 'spaces.taskAxes.update',  method: 'PATCH',  path: '/v2/spaces/:spaceId/task-axes/:axisId',       kind: 'command', status: 'v1' },
  { name: 'spaces.taskAxes.delete',  method: 'DELETE', path: '/v2/spaces/:spaceId/task-axes/:axisId',       kind: 'command', status: 'v1' },
  { name: 'spaces.leaderboard',      method: 'GET',    path: '/v2/spaces/:spaceId/leaderboard',             kind: 'read',    status: 'v1' },
  { name: 'spaces.awards',           method: 'GET',    path: '/v2/spaces/:spaceId/awards',                  kind: 'read',    status: 'v1' },

  // entities — uniform operations (02 §3.1)
  { name: 'entities.get',            method: 'GET',    path: '/v2/entities/:id',                            kind: 'read',    status: 'v1' },
  { name: 'entities.create',         method: 'POST',   path: '/v2/entities',                                kind: 'command', status: 'v1' },
  { name: 'entities.patch',          method: 'PATCH',  path: '/v2/entities/:id',                            kind: 'command', status: 'v1' },
  { name: 'entities.move',           method: 'POST',   path: '/v2/entities/:id/move',                       kind: 'command', status: 'v1' },
  { name: 'entities.delete',         method: 'DELETE', path: '/v2/entities/:id',                            kind: 'command', status: 'v1' },
  { name: 'entities.restore',        method: 'POST',   path: '/v2/entities/:id/restore',                    kind: 'command', status: 'v1' },
  { name: 'entities.children',       method: 'GET',    path: '/v2/entities/:id/children',                   kind: 'read',    status: 'v1' },
  { name: 'entities.hierarchy',      method: 'GET',    path: '/v2/entities/:id/hierarchy',                  kind: 'read',    status: 'v1' },
  { name: 'entities.connections',    method: 'GET',    path: '/v2/entities/:id/connections',                kind: 'read',    status: 'v1' },
  { name: 'entities.versions',       method: 'GET',    path: '/v2/entities/:id/versions',                   kind: 'read',    status: 'v1' },
  { name: 'entities.activity',       method: 'GET',    path: '/v2/entities/:id/activity',                   kind: 'read',    status: 'v1' },
  { name: 'entities.react',          method: 'PUT',    path: '/v2/entities/:id/reaction',                   kind: 'command', status: 'v1' },
  { name: 'entities.points.add',     method: 'POST',   path: '/v2/entities/:id/points',                     kind: 'command', status: 'v1' },

  // entities — closed kind-command namespace (02 §3.2)
  { name: 'entities.commands.complete',   method: 'POST', path: '/v2/entities/:id/commands/complete',       kind: 'command', status: 'v1' },
  { name: 'entities.commands.work',       method: 'POST', path: '/v2/entities/:id/commands/work',           kind: 'command', status: 'v1' },
  { name: 'entities.commands.pull',       method: 'POST', path: '/v2/entities/:id/commands/pull',           kind: 'command', status: 'v1' },
  { name: 'entities.commands.linkPr',     method: 'POST', path: '/v2/entities/:id/commands/link-pr',        kind: 'command', status: 'v1' },
  { name: 'entities.commands.linkCommit', method: 'POST', path: '/v2/entities/:id/commands/link-commit',    kind: 'command', status: 'v1' },
  { name: 'tracking.refresh',        method: 'POST',   path: '/v2/tracking/refresh',                        kind: 'command', status: 'v1' },

  // edges
  { name: 'edges.list',              method: 'GET',    path: '/v2/edges',                                   kind: 'read',    status: 'v1' },
  { name: 'edges.create',            method: 'POST',   path: '/v2/edges',                                   kind: 'command', status: 'v1' },
  { name: 'edges.patch',             method: 'PATCH',  path: '/v2/edges/:edgeId',                           kind: 'command', status: 'v1' },
  { name: 'edges.delete',            method: 'DELETE', path: '/v2/edges/:edgeId',                           kind: 'command', status: 'v1' },
  { name: 'edgeTypes.list',          method: 'GET',    path: '/v2/edge-types',                              kind: 'read',    status: 'v1' },

  // messages (anchor-first addressing, 02 §3.4)
  { name: 'messages.list',           method: 'GET',    path: '/v2/entities/:anchorId/messages',             kind: 'read',    status: 'v1' },
  { name: 'messages.post',           method: 'POST',   path: '/v2/messages',                                kind: 'command', status: 'v1' },
  { name: 'messages.edit',           method: 'PATCH',  path: '/v2/messages/:id',                            kind: 'command', status: 'v1' },
  { name: 'messages.delete',         method: 'DELETE', path: '/v2/messages/:id',                            kind: 'command', status: 'v1' },

  // collections / graph / placements / undo
  { name: 'collections.query',       method: 'POST',   path: '/v2/collections/query',                       kind: 'read',    status: 'v1' },
  { name: 'graph.query',             method: 'POST',   path: '/v2/graph/query',                             kind: 'read',    status: 'v1' },
  { name: 'placements.apply',        method: 'POST',   path: '/v2/placements',                              kind: 'command', status: 'v1' },
  { name: 'commands.undo',           method: 'POST',   path: '/v2/undo',                                    kind: 'command', status: 'v1' },

  // search — DEFERRED v1 (DEV-13): reserved slot, honest 501 forever until built
  { name: 'search.query',            method: 'GET',    path: '/v2/search',                                  kind: 'read',    status: 'reserved' },

  // per-member read state
  { name: 'inbox.list',              method: 'GET',    path: '/v2/inbox',                                   kind: 'read',    status: 'v1' },
  { name: 'inbox.markRead',          method: 'PUT',    path: '/v2/inbox/:notificationId/read',              kind: 'command', status: 'v1' },
  { name: 'readMarks.upsert',        method: 'PUT',    path: '/v2/read-marks/:anchorId',                    kind: 'command', status: 'v1' },

  // saved views
  { name: 'savedViews.list',         method: 'GET',    path: '/v2/spaces/:spaceId/saved-views',             kind: 'read',    status: 'v1' },
  { name: 'savedViews.create',       method: 'POST',   path: '/v2/saved-views',                             kind: 'command', status: 'v1' },
  { name: 'savedViews.update',       method: 'PATCH',  path: '/v2/saved-views/:viewId',                     kind: 'command', status: 'v1' },
  { name: 'savedViews.delete',       method: 'DELETE', path: '/v2/saved-views/:viewId',                     kind: 'command', status: 'v1' },

  // palette actions (capability discovery, UI contract §3)
  { name: 'actions.list',            method: 'GET',    path: '/v2/actions',                                 kind: 'read',    status: 'v1' },

  // events — one socket (T-L10/04 §2.3) + polling catch-up fallback
  { name: 'events.subscribe',        method: 'WS',     path: '/v2/ws',                                      kind: 'stream',  status: 'v1' },
  { name: 'events.poll',             method: 'GET',    path: '/v2/spaces/:spaceId/events',                  kind: 'read',    status: 'v1' },
  { name: 'presence.get',            method: 'GET',    path: '/v2/entities/:id/presence',                   kind: 'read',    status: 'v1' },

  // execution.* family (R16) — server-hosted PTY is the only spawn path (AM-1)
  { name: 'execution.spawn',          method: 'POST',  path: '/v2/execution/spawn',                         kind: 'command', status: 'v1' },
  { name: 'execution.prompt',         method: 'POST',  path: '/v2/entities/:id/commands/prompt',            kind: 'command', status: 'v1' },
  { name: 'execution.terminate',      method: 'POST',  path: '/v2/entities/:id/commands/terminate',         kind: 'command', status: 'v1' },
  { name: 'execution.streams.attach', method: 'POST',  path: '/v2/entities/:id/commands/streams-attach',    kind: 'command', status: 'v1' },

  // custom entity kinds (T-L4, R7–R9)
  { name: 'entityKinds.list',        method: 'GET',    path: '/v2/spaces/:spaceId/entity-kinds',            kind: 'read',    status: 'v1' },
  { name: 'entityKinds.create',      method: 'POST',   path: '/v2/spaces/:spaceId/entity-kinds',            kind: 'command', status: 'v1' },
  { name: 'entityKinds.update',      method: 'PATCH',  path: '/v2/spaces/:spaceId/entity-kinds/:kind',      kind: 'command', status: 'v1' },
] as const satisfies readonly OperationBinding[];

export type OperationName = (typeof OPERATIONS)[number]['name'];

const BY_NAME = new Map<string, OperationBinding>(OPERATIONS.map((op) => [op.name, op]));

export function getOperation(name: OperationName): OperationBinding {
  const op = BY_NAME.get(name);
  if (!op) throw new Error(`unknown operation: ${name}`);
  return op;
}

export function isOperationName(name: string): name is OperationName {
  return BY_NAME.has(name);
}

/** Operations every v1 deployment must implement (everything not reserved). */
export const V1_OPERATIONS = OPERATIONS.filter((op) => op.status === 'v1');

/** Reserved operations — must answer `501 not_implemented`, never 404. */
export const RESERVED_OPERATIONS = OPERATIONS.filter((op) => op.status === 'reserved');

/** Substitute `:params` in an operation path. Throws on missing params. */
export function bindPath(name: OperationName, params: Record<string, string> = {}): string {
  const op = getOperation(name);
  return op.path.replace(/:([A-Za-z]+)/g, (_, p: string) => {
    const v = params[p];
    if (v === undefined) throw new Error(`bindPath(${name}): missing param :${p}`);
    return encodeURIComponent(v);
  });
}
