/**
 * The operation catalog (T-L12, api-design 02 §4) — canonical, transport-
 * independent operation names + their HTTP bindings, extended with the tm8
 * families (`execution.*` per R16, `entityKinds.*` per T-L4, `projects.*` +
 * `files.*` per AM-2).
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
  { name: 'serverConnections.list',  method: 'GET',    path: '/v2/server-connections',                      kind: 'read',    status: 'v1' },
  { name: 'serverConnections.create', method: 'POST',  path: '/v2/server-connections',                      kind: 'command', status: 'v1' },
  { name: 'serverConnections.get',   method: 'GET',    path: '/v2/server-connections/:name',                kind: 'read',    status: 'v1' },
  { name: 'serverConnections.delete', method: 'DELETE', path: '/v2/server-connections/:name',               kind: 'command', status: 'v1' },
  { name: 'spaces.list',             method: 'GET',    path: '/v2/spaces',                                  kind: 'read',    status: 'v1' },
  { name: 'spaces.create',           method: 'POST',   path: '/v2/spaces',                                  kind: 'command', status: 'v1' },
  { name: 'spaces.get',              method: 'GET',    path: '/v2/spaces/:spaceId',                         kind: 'read',    status: 'v1' },
  { name: 'spaces.update',           method: 'PATCH',  path: '/v2/spaces/:spaceId',                         kind: 'command', status: 'v1' },
  { name: 'spaces.navigation',       method: 'GET',    path: '/v2/spaces/:spaceId/navigation',              kind: 'read',    status: 'v1' },
  { name: 'spaces.home',             method: 'GET',    path: '/v2/spaces/:spaceId/home',                    kind: 'read',    status: 'v1' },
  { name: 'spaces.counts',           method: 'GET',    path: '/v2/spaces/:spaceId/counts',                  kind: 'read',    status: 'v1' },
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
  { name: 'attentionRequests.list',  method: 'GET',    path: '/v2/attention-requests',                      kind: 'read',    status: 'v1' },
  { name: 'attentionRequests.create',method: 'POST',   path: '/v2/entities/:entityId/attention-requests',   kind: 'command', status: 'v1' },
  { name: 'attentionRequests.update',method: 'PATCH',  path: '/v2/attention-requests/:requestId',           kind: 'command', status: 'v1' },
  { name: 'attentionRequests.resolveEntity', method: 'POST', path: '/v2/entities/:entityId/attention-requests/resolve', kind: 'command', status: 'v1' },
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

  // projects — linked resources, space↔project M2M (AM-2 §1, T-D17)
  { name: 'projects.list',           method: 'GET',    path: '/v2/projects',                                kind: 'read',    status: 'v1' },
  { name: 'projects.create',         method: 'POST',   path: '/v2/projects',                                kind: 'command', status: 'v1' },
  { name: 'projects.get',            method: 'GET',    path: '/v2/projects/:projectId',                     kind: 'read',    status: 'v1' },
  { name: 'projects.update',         method: 'PATCH',  path: '/v2/projects/:projectId',                     kind: 'command', status: 'v1' },
  { name: 'projects.link',           method: 'POST',   path: '/v2/spaces/:spaceId/projects',                kind: 'command', status: 'v1' },
  { name: 'projects.unlink',         method: 'DELETE', path: '/v2/spaces/:spaceId/projects/:projectId',     kind: 'command', status: 'v1' },

  // files.* blob lifecycle (AM-2 §2, 03 §6); download returns bytes, not the JSON envelope
  { name: 'files.uploadInit',        method: 'POST',   path: '/v2/files/uploads',                           kind: 'command', status: 'v1' },
  { name: 'files.uploadComplete',    method: 'POST',   path: '/v2/files/uploads/:uploadId/complete',        kind: 'command', status: 'v1' },
  { name: 'files.uploadAbort',       method: 'POST',   path: '/v2/files/uploads/:uploadId/abort',           kind: 'command', status: 'v1' },
  { name: 'files.download',          method: 'GET',    path: '/v2/files/:fileEntityId/download',            kind: 'read',    status: 'v1' },
  // cross-node blob fetch over the asymmetric bridge — Phase 2, honest 501 (DEV-13)
  { name: 'bridge.fetchBlob',        method: 'GET',    path: '/v2/bridge/blobs/:fileEntityId',              kind: 'read',    status: 'reserved' },

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
  { name: 'execution.resume',         method: 'POST',  path: '/v2/entities/:id/commands/resume',            kind: 'command', status: 'v1' },
  // The session's CLI command journal. The bytes live on the node's disk at
  // `<dataDir>/journals/<sessionId>.jsonl`, written by the teammate's own `tm8`
  // invocations — NOT in the database. This op is the ONLY way they reach a
  // browser, and it is deliberately keyed by work_session id rather than by
  // path: the handler computes the filename itself from a validated UUID, so
  // no request can ever name a file. See TM8-CLI-SESSION-COMMAND-JOURNAL §11.
  { name: 'execution.journal',        method: 'GET',   path: '/v2/work-sessions/:workSessionId/journal',    kind: 'read',    status: 'v1' },
  // How the session was CONFIGURED, as opposed to what it then did. The stored
  // spawn manifest (persona, resolved launch posture, command-network policy,
  // workdir, project trust, interaction-profile pin, tasks), the environment
  // variable NAMES, and the two verbatim prompts the agent was launched with.
  // All of it is read back out of `public.session_manifests` under the caller's
  // claims; none of it is recomposed, because a recomposed prompt describes the
  // build doing the reading rather than the launch being inspected. Pairs with
  // `execution.journal` on one debug surface: told, then did.
  { name: 'execution.launch',         method: 'GET',   path: '/v2/work-sessions/:workSessionId/launch',     kind: 'read',    status: 'v1' },

  // custom entity kinds (T-L4, R7–R9)
  { name: 'entityKinds.list',        method: 'GET',    path: '/v2/spaces/:spaceId/entity-kinds',            kind: 'read',    status: 'v1' },
  { name: 'entityKinds.create',      method: 'POST',   path: '/v2/spaces/:spaceId/entity-kinds',            kind: 'command', status: 'v1' },
  { name: 'entityKinds.update',      method: 'PATCH',  path: '/v2/spaces/:spaceId/entity-kinds/:kind',      kind: 'command', status: 'v1' },

  // voice channels (Discord-style, self-hosted LiveKit SFU) — audio never
  // touches tm8-server; this op only mints the room-join grant (voice plan §2).
  // The LiveKit webhook is a server-to-server callback, not a client op, so it
  // is registered directly on the HTTP router rather than in this catalog.
  { name: 'voice.token.create',      method: 'POST',   path: '/v2/entities/:id/commands/voice-token',       kind: 'command', status: 'v1' },

  // W0 dossier A01-A20 — adopted additive rows, exact frozen order
  { name: 'spaces.menu.get',                              method: 'GET',    path: '/v2/spaces/:spaceId/menu',                                           kind: 'read',    status: 'v1' },
  { name: 'spaces.menu.update',                           method: 'PUT',    path: '/v2/spaces/:spaceId/menu',                                           kind: 'command', status: 'v1' },
  { name: 'spaces.defaultChannel.set',                    method: 'PUT',    path: '/v2/spaces/:spaceId/default-channel',                                kind: 'command', status: 'v1' },
  { name: 'projects.associations.correct',                method: 'POST',   path: '/v2/entities/:artifactId/commands/correct-project-association',        kind: 'command', status: 'v1' },
  { name: 'handoffs.send',                                method: 'POST',   path: '/v2/work-sessions/:workSessionId/handoffs',                           kind: 'command', status: 'v1' },
  { name: 'handoffs.list',                                method: 'GET',    path: '/v2/work-sessions/:workSessionId/handoffs',                           kind: 'read',    status: 'v1' },
  { name: 'handoffs.withdraw',                            method: 'POST',   path: '/v2/handoffs/:handoffId/withdraw',                                   kind: 'command', status: 'v1' },
  { name: 'messages.attachments.add',                     method: 'POST',   path: '/v2/messages/:messageId/attachments',                                kind: 'command', status: 'v1' },
  { name: 'messages.attachments.remove',                  method: 'DELETE', path: '/v2/messages/:messageId/attachments',                                kind: 'command', status: 'v1' },
  { name: 'messages.delivery.get',                        method: 'GET',    path: '/v2/messages/:messageId/delivery',                                   kind: 'read',    status: 'v1' },
  { name: 'entities.feed',                                method: 'GET',    path: '/v2/entities/:id/feed',                                              kind: 'read',    status: 'v1' },
  { name: 'entities.context',                             method: 'GET',    path: '/v2/entities/:id/context',                                           kind: 'read',    status: 'v1' },
  { name: 'interactionProfiles.propose',                 method: 'POST',   path: '/v2/spaces/:spaceId/interaction-profiles',                           kind: 'command', status: 'v1' },
  { name: 'interactionProfiles.updateDraft',             method: 'PATCH',  path: '/v2/interaction-profiles/:profileId/draft',                          kind: 'command', status: 'v1' },
  { name: 'interactionProfiles.validate',                method: 'POST',   path: '/v2/interaction-profiles/:profileId/validate',                       kind: 'command', status: 'v1' },
  { name: 'interactionProfiles.preview',                 method: 'POST',   path: '/v2/interaction-profiles/:profileId/preview',                        kind: 'read',    status: 'v1' },
  { name: 'interactionProfiles.activate',                method: 'POST',   path: '/v2/interaction-profiles/:profileId/activate',                       kind: 'command', status: 'v1' },
  { name: 'interactionProfiles.retire',                  method: 'POST',   path: '/v2/interaction-profiles/:profileId/retire',                         kind: 'command', status: 'v1' },
  { name: 'teamMembers.interactionProfile.setDefault',   method: 'PUT',    path: '/v2/team-members/:teamMemberId/interaction-profile-default',         kind: 'command', status: 'v1' },
  { name: 'spaces.interactionProfile.setDefault',        method: 'PUT',    path: '/v2/spaces/:spaceId/interaction-profile-default',                    kind: 'command', status: 'v1' },
  // A21 (D2/C-1): point-in-time PTY liveness for one space's work_sessions.
  { name: 'execution.liveness',                          method: 'GET',    path: '/v2/spaces/:spaceId/execution/liveness',                             kind: 'read',    status: 'v1' },

  // artifacts — versioned, viewable static-web bundles (TM8-ARTIFACTS-DESIGN §8.1).
  { name: 'artifacts.create',                            method: 'POST',   path: '/v2/artifacts',                                                      kind: 'command', status: 'v1' },
  { name: 'artifacts.publish',                           method: 'POST',   path: '/v2/artifacts/:artifactId/revisions',                                kind: 'command', status: 'v1' },
  { name: 'artifacts.revisions.list',                    method: 'GET',    path: '/v2/artifacts/:artifactId/revisions',                                kind: 'read',    status: 'v1' },
  { name: 'artifacts.preview.start',                     method: 'POST',   path: '/v2/artifacts/:artifactId/preview-sessions',                         kind: 'command', status: 'v1' },
  { name: 'artifacts.export',                            method: 'GET',    path: '/v2/artifacts/:artifactId/revisions/:revisionNumber/export',         kind: 'read',    status: 'v1' },
  { name: 'artifacts.restore',                           method: 'POST',   path: '/v2/artifacts/:artifactId/commands/restore-revision',                kind: 'command', status: 'v1' },

  // Identity v2 Stage 0 (doc 4 §6): the caller writes their OWN display
  // profile — display name, avatar, email, and the cross-server `globalId`
  // claim. Server-authorized, no space, no actor.
  { name: 'identity.profile.update',                     method: 'POST',   path: '/v2/identity/profile',                                               kind: 'command', status: 'v1' },

  // Identity v2 Stage 1 (doc 4 §6): local accounts. The four operations the UI
  // already names in MISSING_AUTH_OPS. `auth.signup` is node-admin gated —
  // never open self-registration. `auth.login` exchanges a local credential
  // for a `tm8s_…` bearer token; every other operation is unchanged.
  { name: 'auth.signup',                                 method: 'POST',   path: '/v2/auth/signup',                                                    kind: 'command', status: 'v1' },
  { name: 'auth.login',                                  method: 'POST',   path: '/v2/auth/login',                                                     kind: 'command', status: 'v1' },
  { name: 'auth.logout',                                 method: 'POST',   path: '/v2/auth/logout',                                                    kind: 'command', status: 'v1' },
  { name: 'auth.session.get',                            method: 'GET',    path: '/v2/auth/session',                                                   kind: 'read',    status: 'v1' },
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
