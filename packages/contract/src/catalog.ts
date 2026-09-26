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
  /**
   * THIS ROW RE-DECLARES AN EXISTING BINDING; it does not add a mount.
   *
   * Every other row owns its `method path` pair exclusively, and the
   * conformance generator asserts that — a duplicate binding is normally a
   * copy-paste defect that would shadow a real route. One case is legitimate:
   * a family wants its socket DISCOVERABLE under its own name while sharing
   * one physical endpoint with another family (`containers.stream` and
   * `events.subscribe` are both `WS /v2/ws`; the socket dispatches on the
   * grant, per TM8-CONTAINERS-DESIGN §4.1).
   *
   * Declaring it here is what keeps the uniqueness invariant's teeth: an
   * alias is legal ONLY when it says so and names what it aliases, so any
   * duplicate that is a mistake still fails. Anything that MOUNTS routes
   * (the HTTP router, the WS upgrade handler, the router inventory) must skip
   * alias rows; anything that LISTS operations (discovery, the CLI catalog,
   * help) must include them — being listed is the entire point.
   */
  aliasOf?: string;
}

export const BASE_PATH = '/v2';

export const OPERATIONS = [
  { name: 'skills.roots', method: 'GET', path: '/v2/spaces/:spaceId/skills/roots', kind: 'read', status: 'v1' },
  { name: 'skills.create', method: 'POST', path: '/v2/spaces/:spaceId/skills', kind: 'command', status: 'v1' },
  { name: 'skills.edit', method: 'PATCH', path: '/v2/skills/:id', kind: 'command', status: 'v1' },
  { name: 'skills.equip', method: 'POST', path: '/v2/skills/:id/equip', kind: 'command', status: 'v1' },
  { name: 'skills.unequip', method: 'POST', path: '/v2/skills/:id/unequip', kind: 'command', status: 'v1' },
  { name: 'skills.scan', method: 'POST', path: '/v2/spaces/:spaceId/skills/scan', kind: 'command', status: 'v1' },
  { name: 'skills.list', method: 'GET', path: '/v2/spaces/:spaceId/skills', kind: 'read', status: 'v1' },
  { name: 'skills.preview', method: 'GET', path: '/v2/spaces/:spaceId/skills/preview', kind: 'read', status: 'v1' },
  { name: 'skills.show', method: 'GET', path: '/v2/skills/:id', kind: 'read', status: 'v1' },
  // launch.suggest — Jev's launch-sheet advice (design 01a0cb80 §5.1). UI only:
  // no CLI, no dispatch, no spawn-time call. A command because it writes the
  // jev_runs / jev_calls cost rows; `requestId` in the body is its idempotency key.
  { name: 'launch.suggest', method: 'POST', path: '/v2/spaces/:spaceId/launch/suggest', kind: 'command', status: 'v1' },
  // launch.defaults — what a launch loads per selection group when nothing is
  // selected (design 01a0d348 §5.1, I9): spawn's own default loaders, read in
  // the caller's RLS tx, so the launch sheet pre-ticks exactly what spawn loads.
  { name: 'launch.defaults', method: 'GET', path: '/v2/spaces/:spaceId/launch/defaults', kind: 'read', status: 'v1' },
  // Per-kind chat defaults (entity-chat design 01a0da4e §3.4, migration 229):
  // space-wide teammate + model per entity kind. Read by any member; written
  // by a human owner/admin, the interactionProfile.setDefault gate.
  { name: 'spaces.chatDefaults.get',                      method: 'GET',    path: '/v2/spaces/:spaceId/chat-defaults',                                  kind: 'read',    status: 'v1' },
  { name: 'spaces.chatDefaults.set',                      method: 'PUT',    path: '/v2/spaces/:spaceId/chat-defaults',                                  kind: 'command', status: 'v1' },
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
  { name: 'spaces.configs',          method: 'GET',    path: '/v2/spaces/:spaceId/configs',                 kind: 'read',    status: 'v1' },
  { name: 'spaces.members.list',     method: 'GET',    path: '/v2/spaces/:spaceId/members',                 kind: 'read',    status: 'v1' },
  { name: 'spaces.members.updateRole', method: 'PATCH', path: '/v2/spaces/:spaceId/members/:memberId',       kind: 'command', status: 'v1' },
  // G6 (migration 232): a membership ends by tombstone. Both human-only; the
  // member row and everything it authored stay. POST verbs, like invites.revoke.
  { name: 'spaces.members.remove', method: 'POST',  path: '/v2/spaces/:spaceId/members/:memberId/remove', kind: 'command', status: 'v1' },
  { name: 'spaces.leave',          method: 'POST',  path: '/v2/spaces/:spaceId/leave',                   kind: 'command', status: 'v1' },
  // Node admin turns an account off: every session refused, launched work contained (232).
  { name: 'accounts.disable',      method: 'POST',  path: '/v2/accounts/:accountId/disable',             kind: 'command', status: 'v1' },
  { name: 'spaces.invites.list',     method: 'GET',    path: '/v2/spaces/:spaceId/invites',                 kind: 'read',    status: 'v1' },
  { name: 'spaces.invites.create',   method: 'POST',   path: '/v2/spaces/:spaceId/invites',                 kind: 'command', status: 'v1' },
  { name: 'spaces.invites.revoke',   method: 'POST',   path: '/v2/spaces/:spaceId/invites/:inviteId/revoke', kind: 'command', status: 'v1' },
  { name: 'spaces.invites.redeem',   method: 'POST',   path: '/v2/invites/redeem',                          kind: 'command', status: 'v1' },
  { name: 'spaces.taskAxes.list',    method: 'GET',    path: '/v2/spaces/:spaceId/task-axes',               kind: 'read',    status: 'v1' },
  { name: 'spaces.taskAxes.create',  method: 'POST',   path: '/v2/spaces/:spaceId/task-axes',               kind: 'command', status: 'v1' },
  { name: 'spaces.taskAxes.update',  method: 'PATCH',  path: '/v2/spaces/:spaceId/task-axes/:axisId',       kind: 'command', status: 'v1' },
  { name: 'spaces.taskAxes.delete',  method: 'DELETE', path: '/v2/spaces/:spaceId/task-axes/:axisId',       kind: 'command', status: 'v1' },
  // W4 (132): per-type status vocabularies. Upsert, not create+update — the
  // natural key is (space, type value) and the UI edits one row per value.
  { name: 'spaces.taskWorkflows.list',   method: 'GET',    path: '/v2/spaces/:spaceId/task-workflows',             kind: 'read',    status: 'v1' },
  { name: 'spaces.taskWorkflows.upsert', method: 'POST',   path: '/v2/spaces/:spaceId/task-workflows',             kind: 'command', status: 'v1' },
  { name: 'spaces.taskWorkflows.delete', method: 'DELETE', path: '/v2/spaces/:spaceId/task-workflows/:workflowId', kind: 'command', status: 'v1' },
  // Phase 2 (148): the real workflow tables — open, user-named states each
  // carrying one of the four closed categories. SUPERSEDES taskWorkflows above,
  // which stays read-only until phase 6 retires the `type` axis. Upsert is
  // WHOLE-DOCUMENT (states and transitions ride along) because every invariant
  // here is about a workflow as a whole; same reasoning that put `statuses` on
  // the taskWorkflows upsert rather than shipping an add-status op.
  { name: 'spaces.workflows.list',   method: 'GET',    path: '/v2/spaces/:spaceId/workflows',             kind: 'read',    status: 'v1' },
  { name: 'spaces.workflows.upsert', method: 'POST',   path: '/v2/spaces/:spaceId/workflows',             kind: 'command', status: 'v1' },
  { name: 'spaces.workflows.delete', method: 'DELETE', path: '/v2/spaces/:spaceId/workflows/:workflowId', kind: 'command', status: 'v1' },
  { name: 'spaces.leaderboard',      method: 'GET',    path: '/v2/spaces/:spaceId/leaderboard',             kind: 'read',    status: 'v1' },
  { name: 'spaces.awards',           method: 'GET',    path: '/v2/spaces/:spaceId/awards',                  kind: 'read',    status: 'v1' },

  // entities — uniform operations (02 §3.1)
  { name: 'entities.get',            method: 'GET',    path: '/v2/entities/:id',                            kind: 'read',    status: 'v1' },
  { name: 'entities.create',         method: 'POST',   path: '/v2/entities',                                kind: 'command', status: 'v1' },
  { name: 'entities.patch',          method: 'PATCH',  path: '/v2/entities/:id',                            kind: 'command', status: 'v1' },
  // The authored selection header (headers design 01a0d31e §9.2): its own
  // door, not a `content.header` patch member, because the header has its own
  // version and never moves `entities.version` (migration 216).
  { name: 'entities.header.set',     method: 'PUT',    path: '/v2/entities/:id/header',                     kind: 'command', status: 'v1' },
  { name: 'entities.header.clear',   method: 'DELETE', path: '/v2/entities/:id/header',                     kind: 'command', status: 'v1' },
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
  { name: 'entities.commands.gate',       method: 'POST', path: '/v2/entities/:id/commands/gate',           kind: 'command', status: 'v1' },
  // Tick (or untick) acceptance criteria BY ID — a merge the Server does, so a
  // caller never restates the whole `acceptanceCriteria` array to change one
  // `done`. The write `task complete`'s criteria gate asks for.
  { name: 'entities.commands.tick',       method: 'POST', path: '/v2/entities/:id/commands/tick',           kind: 'command', status: 'v1' },
  { name: 'tracking.refresh',        method: 'POST',   path: '/v2/tracking/refresh',                        kind: 'command', status: 'v1' },
  // The forge WRITE door — one verb, guarded server-side (open + mergeable per
  // observed facts, CI not red, head unchanged), acting-member credential only.
  { name: 'tracking.pr.merge',       method: 'POST',   path: '/v2/tracking/pr/:id/merge',                   kind: 'command', status: 'v1' },

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

  // chat — create the chat entity and post its opening turn, in one command.
  // Every later turn, from a human or from another agent, still travels through
  // messages.post anchored on the chat; there is no second write path.
  { name: 'chat.start',              method: 'POST',   path: '/v2/chats',                                   kind: 'command', status: 'v1' },

  // collections / graph / placements / undo
  { name: 'collections.query',       method: 'POST',   path: '/v2/collections/query',                       kind: 'read',    status: 'v1' },
  { name: 'collections.addItem',     method: 'POST',   path: '/v2/collections/:id/items',                   kind: 'command', status: 'v1' },
  { name: 'collections.removeItem',  method: 'DELETE', path: '/v2/collections/:id/items/:entityId',         kind: 'command', status: 'v1' },
  { name: 'graph.query',             method: 'POST',   path: '/v2/graph/query',                             kind: 'read',    status: 'v1' },
  { name: 'placements.apply',        method: 'POST',   path: '/v2/placements',                              kind: 'command', status: 'v1' },
  { name: 'commands.undo',           method: 'POST',   path: '/v2/undo',                                    kind: 'command', status: 'v1' },

  // search — DEFERRED v1 (DEV-13): reserved slot, honest 501 forever until built
  { name: 'search.query',            method: 'GET',    path: '/v2/search',                                  kind: 'read',    status: 'reserved' },

  // projects — linked resources, space↔project M2M (AM-2 §1, T-D17)
  { name: 'projects.list',           method: 'GET',    path: '/v2/projects',                                kind: 'read',    status: 'v1' },
  { name: 'projects.create',         method: 'POST',   path: '/v2/projects',                                kind: 'command', status: 'v1' },
  { name: 'projects.directories.list', method: 'GET',  path: '/v2/project-directories',                     kind: 'read',    status: 'v1' },
  { name: 'projects.get',            method: 'GET',    path: '/v2/projects/:projectId',                     kind: 'read',    status: 'v1' },
  { name: 'projects.contention',     method: 'GET',    path: '/v2/projects/:projectId/contention',          kind: 'read',    status: 'v1' },
  { name: 'projects.branches.list',  method: 'GET',    path: '/v2/projects/:projectId/branches',            kind: 'read',    status: 'v1' },
  // Tier 1 file reads: the path is a `?path=` QUERY pathspec (a file path
  // cannot ride a route segment); the directory git runs in always comes from
  // the project row. Authorization is exactly `projects.get`'s.
  { name: 'projects.file.history',   method: 'GET',    path: '/v2/projects/:projectId/file-history',        kind: 'read',    status: 'v1' },
  { name: 'projects.file.blame',     method: 'GET',    path: '/v2/projects/:projectId/blame',               kind: 'read',    status: 'v1' },
  { name: 'projects.update',         method: 'PATCH',  path: '/v2/projects/:projectId',                     kind: 'command', status: 'v1' },
  { name: 'projects.link',           method: 'POST',   path: '/v2/spaces/:spaceId/projects',                kind: 'command', status: 'v1' },
  // W11 (migration 234): a folder is the gate's and is granted to ONE space
  // (`gate.folders.*`); the space's project is its own entity, listed to
  // members without a path and named by a space admin on a folder granted to
  // that space. `projects.link` stays (decision 29): only a loopback-only
  // `single` node may link one folder into several spaces.
  { name: 'spaces.projects.list',    method: 'GET',    path: '/v2/spaces/:spaceId/projects',                kind: 'read',    status: 'v1' },
  { name: 'spaces.projects.create',  method: 'POST',   path: '/v2/spaces/:spaceId/projects/create',         kind: 'command', status: 'v1' },
  { name: 'gate.folders.list',       method: 'GET',    path: '/v2/gate/folders',                            kind: 'read',    status: 'v1' },
  { name: 'gate.folders.create',     method: 'POST',   path: '/v2/gate/folders',                            kind: 'command', status: 'v1' },
  { name: 'projects.unlink',         method: 'DELETE', path: '/v2/spaces/:spaceId/projects/:projectId',     kind: 'command', status: 'v1' },
  { name: 'projects.files.list',     method: 'GET',    path: '/v2/projects/:projectId/files',               kind: 'read',    status: 'v1' },
  { name: 'projects.files.attach',   method: 'POST',   path: '/v2/projects/:projectId/files/attach',        kind: 'command', status: 'v1' },
  // Reading one file's CONTENT out of a connected project folder — the viewer
  // half of `projects.files.list`'s picker. Answers a DTO with a NAMED refusal,
  // never raw bytes and never an inline document, so nothing off a project's
  // disk gets a document context on the app origin (FILES-DESIGN §4.4).
  { name: 'projects.files.read',     method: 'GET',    path: '/v2/projects/:projectId/files/content',       kind: 'read',    status: 'v1' },
  // A whole subtree as one zip. This is the one project-disk read that answers
  // BYTES rather than a DTO, and it does not weaken §4.4: an archive is
  // `application/zip` with an unconditional `attachment` disposition, so there
  // is no browser context in which it becomes a document on the app origin.
  // The response is chunked — a STORED zip's length is not known until the
  // central directory is written, and a guessed content-length is worse than
  // none.
  { name: 'projects.files.archive',  method: 'GET',    path: '/v2/projects/:projectId/files/archive',       kind: 'read',    status: 'v1' },

  // Browser-originated project folder import. Unlike projects.files.*, these
  // operations never read a path on the browser's machine: init freezes a
  // relative-path manifest and returns raw-byte grants, complete reconstructs
  // it beneath a server-authorized destination, and abort removes staging.

  // Browser-originated project folder import. Unlike projects.files.*, these
  // operations never read a path on the browser's machine: init freezes a
  // relative-path manifest and returns raw-byte grants, complete reconstructs
  // it beneath a server-authorized destination, and abort removes staging.
  { name: 'projects.folderUploads.init',     method: 'POST', path: '/v2/spaces/:spaceId/project-folder-uploads',            kind: 'command', status: 'v1' },
  { name: 'projects.folderUploads.complete', method: 'POST', path: '/v2/project-folder-uploads/:folderUploadId/complete',  kind: 'command', status: 'v1' },
  { name: 'projects.folderUploads.abort',    method: 'POST', path: '/v2/project-folder-uploads/:folderUploadId/abort',     kind: 'command', status: 'v1' },

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
  // The scoped change feed (spec doc 01a0cf35): "did anything I care about
  // change since seq N?" answered as a per-entity digest, not a replay.
  { name: 'events.changes',          method: 'GET',    path: '/v2/spaces/:spaceId/events/changes',          kind: 'read',    status: 'v1' },
  { name: 'presence.get',            method: 'GET',    path: '/v2/entities/:id/presence',                   kind: 'read',    status: 'v1' },

  // execution.* family (R16) — server-hosted PTY is the only spawn path (AM-1)
  { name: 'execution.spawn',          method: 'POST',  path: '/v2/execution/spawn',                         kind: 'command', status: 'v1' },
  // A VANILLA TERMINAL (101) — a shell session with no agent attached. Its own
  // door rather than a flag on `execution.spawn`, because spawn's body IS agent
  // setup (persona authorization, manifest, agent token, profile pin, trust
  // probes) and none of it applies. See `ExecutionTerminalStartInput`.
  { name: 'execution.terminal.start', method: 'POST',  path: '/v2/execution/terminal',                      kind: 'command', status: 'v1' },
  { name: 'execution.prompt',         method: 'POST',  path: '/v2/entities/:id/commands/prompt',            kind: 'command', status: 'v1' },
  { name: 'execution.terminate',      method: 'POST',  path: '/v2/entities/:id/commands/terminate',         kind: 'command', status: 'v1' },
  { name: 'execution.streams.attach', method: 'POST',  path: '/v2/entities/:id/commands/streams-attach',    kind: 'command', status: 'v1' },
  { name: 'execution.resume',         method: 'POST',  path: '/v2/entities/:id/commands/resume',            kind: 'command', status: 'v1' },
  // 187 — the session's own sharing dials. A command on the session entity
  // rather than a field on `entities.patch`, because the guard is not "may you
  // edit this row" but "may you widen who sees its BYTES", and only the owner
  // or a space admin may answer that.
  { name: 'execution.sessions.share', method: 'POST',  path: '/v2/entities/:id/commands/sharing',           kind: 'command', status: 'v1' },
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
  // The session git rail (Git UI wave): the #76 verbs behind the facade so a
  // BROWSER can drive them — the CLI runs argv git on its own machine; a
  // browser has no machine. The worktree path is resolved server-side from
  // the graph (`in_worktree` edge → `public.worktrees` row); no request ever
  // names a filesystem path, `execution.journal`'s discipline. Reads cap
  // their output (digest+partial, the transcript precedent); a session with
  // no worktree answers `available:false` with a named reason, never a 500.
  { name: 'execution.gitStatus',      method: 'GET',   path: '/v2/work-sessions/:workSessionId/git/status',      kind: 'read',    status: 'v1' },
  { name: 'execution.gitDiff',        method: 'GET',   path: '/v2/work-sessions/:workSessionId/git/diff',        kind: 'read',    status: 'v1' },
  { name: 'execution.gitCheckpoint',  method: 'POST',  path: '/v2/work-sessions/:workSessionId/git/checkpoint',  kind: 'command', status: 'v1' },
  { name: 'execution.gitRollback',    method: 'POST',  path: '/v2/work-sessions/:workSessionId/git/rollback',    kind: 'command', status: 'v1' },
  { name: 'execution.gitCommit',      method: 'POST',  path: '/v2/work-sessions/:workSessionId/git/commit',      kind: 'command', status: 'v1' },
  // Stage/UNSTAGE without committing — the review half of the commit verb.
  // Unstage is a path-scoped MIXED reset; no working-tree bytes move.
  { name: 'execution.gitStage',       method: 'POST',  path: '/v2/work-sessions/:workSessionId/git/stage',       kind: 'command', status: 'v1' },
  { name: 'execution.gitMerge',       method: 'POST',  path: '/v2/work-sessions/:workSessionId/git/merge',       kind: 'command', status: 'v1' },
  // Tier 2 completion (same laws as the six above): cherry-pick and stash
  // obey merge's abort-verify-surface contract — a conflict is DATA with the
  // worktree restored clean; branch delete/rename refuse checked-out and
  // protected branches, and the destructive gates (unmerged delete, stash
  // drop) require an explicit force. Stash LIST rides on execution.gitStatus.
  { name: 'execution.gitCherryPick',  method: 'POST',  path: '/v2/work-sessions/:workSessionId/git/cherry-pick', kind: 'command', status: 'v1' },
  { name: 'execution.gitBranch',      method: 'POST',  path: '/v2/work-sessions/:workSessionId/git/branch',      kind: 'command', status: 'v1' },
  { name: 'execution.gitStash',       method: 'POST',  path: '/v2/work-sessions/:workSessionId/git/stash',       kind: 'command', status: 'v1' },

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

  // forms — fifteen rows: §6's twelve plus responses.discard (coordinator
  // ruling on W1-R3), and W3's redeliver and pendingForSessions. An agent
  // asks, a human answers, the answer comes back to the requesting session
  // (FORMS-DESIGN §6; migrations 209 + 211). The form itself reads through
  // the universal entity reads (a `form` arm in entity_content); responses are
  // side rows, so they page here.
  { name: 'forms.create',                                method: 'POST',   path: '/v2/forms',                                                          kind: 'command', status: 'v1' },
  { name: 'forms.update',                                method: 'PATCH',  path: '/v2/forms/:formId',                                                  kind: 'command', status: 'v1' },
  { name: 'forms.questions.add',                         method: 'POST',   path: '/v2/forms/:formId/questions',                                        kind: 'command', status: 'v1' },
  { name: 'forms.questions.update',                      method: 'PATCH',  path: '/v2/forms/:formId/questions/:questionKey',                           kind: 'command', status: 'v1' },
  { name: 'forms.questions.remove',                      method: 'DELETE', path: '/v2/forms/:formId/questions/:questionKey',                           kind: 'command', status: 'v1' },
  { name: 'forms.questions.move',                        method: 'POST',   path: '/v2/forms/:formId/questions/:questionKey/move',                      kind: 'command', status: 'v1' },
  { name: 'forms.transition',                            method: 'POST',   path: '/v2/forms/:formId/transition',                                       kind: 'command', status: 'v1' },
  { name: 'forms.responses.save',                        method: 'PUT',    path: '/v2/forms/:formId/responses/mine',                                   kind: 'command', status: 'v1' },
  { name: 'forms.responses.discard',                     method: 'DELETE', path: '/v2/forms/:formId/responses/mine',                                   kind: 'command', status: 'v1' },
  { name: 'forms.responses.submit',                      method: 'POST',   path: '/v2/forms/:formId/responses/submit',                                 kind: 'command', status: 'v1' },
  { name: 'forms.responses.list',                        method: 'GET',    path: '/v2/forms/:formId/responses',                                        kind: 'read',    status: 'v1' },
  { name: 'forms.responses.get',                         method: 'GET',    path: '/v2/form-responses/:responseId',                                     kind: 'read',    status: 'v1' },
  { name: 'forms.responses.mine',                        method: 'GET',    path: '/v2/form-responses',                                                 kind: 'read',    status: 'v1' },
  // W3: the two delivery buttons (new session / resume now) and the batched
  // read behind the session tile chip and banner (FORMS-DESIGN §7.3, §10).
  { name: 'forms.responses.redeliver',                   method: 'POST',   path: '/v2/form-responses/:responseId/redeliver',                           kind: 'command', status: 'v1' },
  { name: 'forms.pendingForSessions',                    method: 'GET',    path: '/v2/forms-pending',                                                  kind: 'read',    status: 'v1' },

  // Identity v2 Stage 0 (doc 4 §6): the caller writes their OWN display
  // profile — display name, avatar, email, and the cross-server `globalId`
  // claim. Server-authorized, no space, no actor.
  { name: 'identity.profile.update',                     method: 'POST',   path: '/v2/identity/profile',                                               kind: 'command', status: 'v1' },

  // Identity v2 Stage 1 (doc 4 §6): local accounts. The four operations the UI
  // asked for as MISSING_AUTH_OPS — now wired by its gate as GATE_AUTH_OPS
  // (tm8-ui src/auth). `auth.signup` is node-admin gated — never open
  // self-registration. `auth.login` exchanges a local credential for a
  // `tm8s_…` bearer token; every other operation is unchanged.
  { name: 'auth.signup',                                 method: 'POST',   path: '/v2/auth/signup',                                                    kind: 'command', status: 'v1' },
  { name: 'auth.login',                                  method: 'POST',   path: '/v2/auth/login',                                                     kind: 'command', status: 'v1' },
  { name: 'auth.logout',                                 method: 'POST',   path: '/v2/auth/logout',                                                    kind: 'command', status: 'v1' },
  { name: 'auth.session.get',                            method: 'GET',    path: '/v2/auth/session',                                                   kind: 'read',    status: 'v1' },
  // W3 (plan 01a0d9eb): a gate session + membership mints a session pinned to
  // one space. Under TM8_SPACE_SESSIONS=enforce this is how a human gets past
  // the gate at all.
  { name: 'auth.space.enter',                            method: 'POST',   path: '/v2/auth/space/enter',                                               kind: 'command', status: 'v1' },
  // W4 (plan 01a0d9eb): your own sessions, or (space admin) the sessions
  // pinned to a space, and revoking one — the control K5's rejection left.
  { name: 'auth.sessions.list',                          method: 'GET',    path: '/v2/auth/sessions',                                                  kind: 'read',    status: 'v1' },
  { name: 'auth.sessions.revoke',                        method: 'POST',   path: '/v2/auth/sessions/:sessionId/revoke',                                kind: 'command', status: 'v1' },
  // `auth.password.change` — the day a human forgets their password, the only
  // recovery was `psql` (FIRST-RUN-CLAIM-DESIGN.md §10.3). This is CHANGE, not
  // reset: it demands the CURRENT password in the body and proves it with the
  // same scrypt work `auth.login` spends, so a walk-up attacker holding an open
  // session still cannot rotate the credential and lock the owner out. The write
  // is `set_account_credential` (007) under the caller's own claims — an account
  // sets its OWN credential without node admin — and it revokes every OTHER live
  // session for the account while sparing the one making the change. There is no
  // reset-without-the-old-password path here on purpose: that needs an
  // out-of-band capability, and an unauthenticated one would hand the node to
  // anyone who can reach it.
  { name: 'auth.password.change',                        method: 'POST',   path: '/v2/auth/password',                                                  kind: 'command', status: 'v1' },
  // POST-WITH-`kind: 'read'`, DELIBERATELY. It writes nothing — it answers what
  // a join code lets you join, before the holder is anybody on this node — but
  // the code must travel in the BODY. A bearer capability in a URL path lands
  // in access logs, browser history and `Referer`, and a join link is exactly
  // the kind of URL that gets pasted somewhere it will be logged. Precedent for
  // the shape: `collections.query` and `graph.query`, both POST reads for the
  // same reason (a payload that does not belong in a URL).
  { name: 'auth.invite.resolve',                         method: 'POST',   path: '/v2/auth/invite/resolve',                                            kind: 'read',    status: 'v1' },
  // `auth.invite.signup` — the second half of D5 (FIRST-RUN-CLAIM-DESIGN.md
  // §4.4, §5.3). CLAIM-FREE like `resolve`: an invited person has no account
  // until this call, and the INVITE CODE is the authorization. `signup_via_invite`
  // creates the account, the membership, and consumes the invite in ONE
  // transaction — a half-state would leave a person who can log in and see
  // nothing. It hard-codes `is_node_admin = false` / `is_owner = false` with no
  // input that can reach them (§7.3), so a forwarded link can never mint an
  // admin. Same POST-body reasoning as `resolve`: the code is a bearer
  // capability and must not land in a URL. Claiming an account SIGNS YOU IN, so
  // the result is `auth.login`'s shape plus the space you joined.
  { name: 'auth.invite.signup',                          method: 'POST',   path: '/v2/auth/invite/signup',                                             kind: 'command', status: 'v1' },

  // First-run node claim (docs/identity/FIRST-RUN-CLAIM-DESIGN.md, D1/D2).
  // Both are CLAIM-FREE, and both must stay that way: they are the only
  // operations reachable on a node where no credential exists yet.
  //
  // `auth.claim` closes the bootstrap dead end — the loopback owner bootstrap
  // mints account #1 with no password AND consumes `ensure_account`'s
  // zero-accounts window, so a node reached over a tailnet or a reverse proxy
  // showed a sign-in card for an account that could never exist. The one-time
  // `tm8c_…` token is the authorization, which is what lets the ceremony run
  // from a device that is not the server. It sets a credential on the EXISTING
  // owner row rather than creating an account, so `ensure_account` F1 is
  // untouched and `identity_id` — and every attribution keyed to it — survives.
  //
  // `auth.claim.status` is the bootstrap read the UI gate needs to pick a
  // frame. It shares a path with the command, which is established
  // (`artifacts.publish` / `artifacts.revisions.list` below).
  { name: 'auth.claim',                                  method: 'POST',   path: '/v2/auth/claim',                                                     kind: 'command', status: 'v1' },
  { name: 'auth.claim.status',                           method: 'GET',    path: '/v2/auth/claim',                                                     kind: 'read',    status: 'v1' },
  // `auth.claim.reissue` — recover from a lost claim token (§3.1, §4.3). A
  // restart REPRINTS the live token rather than rotating it, so rotation stays a
  // deliberate act; this is that act. ON-BOX BY CONSTRUCTION: the handler admits
  // only the loopback auto-owner arm, and the fresh `tm8c_…` is written to the
  // 0600 `<dataDir>/setup-token` — the file, not the network, is the boundary,
  // so triggering it confers nothing on a caller who cannot read the box. It is
  // inert on a claimed node, exactly like the token it mints.
  { name: 'auth.claim.reissue',                          method: 'POST',   path: '/v2/auth/claim/reissue',                                             kind: 'command', status: 'v1' },

  // Tier B per-member credentials (sub-doc 11 §D). A member connects their OWN
  // vendor account in a login terminal tm8 opens for them, so an agent they
  // spawn runs as them instead of as the node.
  //
  // ALL FOUR ARE HUMAN-ONLY, `status` INCLUDED (architect ruling R2), and the
  // reason is measured rather than defensive: `TM8_AGENT_TOKEN` binds the
  // SPAWNING HUMAN'S account (sub-doc 14 C7 — `acting_as_team_member_id`
  // constrains `internal.resolve_actor` only, while `identity_id()`,
  // `can_act_as`, `is_space_member` and `entity_readable` all key off
  // identity). So an agent calling these reaches its OWNER'S credentials: it
  // could read their status, delete their token, and open a login terminal in
  // their name. The refusal is enforced at registration and again in every RPC
  // via `internal.require_human_auth_kind()`.
  //
  // `status` is a MERGED view over two tables that are split by credential
  // SHAPE (sub-doc 0 / R6): file-shaped anthropic + openai in
  // `account_agent_credentials` (083), string-shaped github in
  // `account_git_credentials` (079). The second is NOT on this line, so the
  // view degrades honestly rather than claiming a connection that is absent.
  //
  // `delete` is Disconnect, and R3 makes it TERMINATE: revoke first, then the
  // login terminal for that pair, then the account's live agent sessions
  // carrying that provider. Containment, not revocation — only rotating at the
  // vendor invalidates a secret a running process already read.
  { name: 'credentials.status',                          method: 'GET',    path: '/v2/identity/credentials',                                           kind: 'read',    status: 'v1' },
  { name: 'credentials.delete',                          method: 'DELETE', path: '/v2/identity/credentials/:provider',                                 kind: 'command', status: 'v1' },
  { name: 'credentials.loginSessions.start',             method: 'POST',   path: '/v2/identity/credentials/login-sessions',                            kind: 'command', status: 'v1' },
  { name: 'credentials.loginSessions.finish',            method: 'POST',   path: '/v2/identity/credentials/login-sessions/:id/finish',                 kind: 'command', status: 'v1' },
  // Service keys — keys tm8 uses SERVER-SIDE for this member (today only
  // `typesafe`, Jev's key for ✦ Ask Jev). Encrypted at rest (203), never shown
  // back beyond the last four characters, and never injected into a spawned
  // session: they are not agent credentials, so they are not providers above.
  { name: 'credentials.serviceKeys.status',              method: 'GET',    path: '/v2/identity/credentials/service-keys',                              kind: 'read',    status: 'v1' },
  { name: 'credentials.serviceKeys.put',                 method: 'PUT',    path: '/v2/identity/credentials/service-keys/:provider',                    kind: 'command', status: 'v1' },
  { name: 'credentials.serviceKeys.delete',              method: 'DELETE', path: '/v2/identity/credentials/service-keys/:provider',                    kind: 'command', status: 'v1' },
  // Space credentials (206, design 01a0cfa8) — agent credentials a SPACE owns.
  // Any member adds one (D1) and every member launches with it (D3); only its
  // creator or a space admin changes it (D11). Every row is human-only (I2)
  // and answers metadata, never the secret (I5). The spawn reader is not a
  // catalog operation (A1). A login-shaped create/finish is SC-4's.
  { name: 'credentials.space.list',                      method: 'GET',    path: '/v2/spaces/:spaceId/credentials',                                    kind: 'read',    status: 'v1' },
  { name: 'credentials.space.create',                    method: 'POST',   path: '/v2/spaces/:spaceId/credentials',                                    kind: 'command', status: 'v1' },
  { name: 'credentials.space.rekey',                     method: 'PUT',    path: '/v2/space-credentials/:credentialId/secret',                         kind: 'command', status: 'v1' },
  { name: 'credentials.space.setDefault',                method: 'POST',   path: '/v2/space-credentials/:credentialId/default',                        kind: 'command', status: 'v1' },
  { name: 'credentials.space.rename',                    method: 'PATCH',  path: '/v2/space-credentials/:credentialId',                                kind: 'command', status: 'v1' },
  { name: 'credentials.space.delete',                    method: 'DELETE', path: '/v2/space-credentials/:credentialId',                                kind: 'command', status: 'v1' },
  { name: 'credentials.space.setVisibility',             method: 'PUT',    path: '/v2/space-credentials/:credentialId/visibility',                     kind: 'command', status: 'v1' },
  { name: 'credentials.space.spaceDefaultConsent',       method: 'PUT',    path: '/v2/space-credentials/:credentialId/space-default-consent',          kind: 'command', status: 'v1' },
  // W10d (doc 13 §7 step 2): add your own server-level GitHub token to this
  // space as a PRIVATE credential — read, probed and re-sealed in TS server-side;
  // the token never reaches the client. A login is a fresh sign-in, not this op.
  { name: 'credentials.space.addMine',                   method: 'POST',   path: '/v2/spaces/:spaceId/credentials/from-mine',                          kind: 'command', status: 'v1' },
  { name: 'credentials.space.claim',                     method: 'POST',   path: '/v2/space-credentials/:credentialId/claim',                          kind: 'command', status: 'v1' },
  { name: 'credentials.space.myDefault.set',             method: 'POST',   path: '/v2/space-credentials/:credentialId/my-default',                     kind: 'command', status: 'v1' },
  { name: 'credentials.space.myDefault.clear',           method: 'DELETE', path: '/v2/spaces/:spaceId/credentials/my-default/:provider',               kind: 'command', status: 'v1' },
  { name: 'credentials.space.usage',                     method: 'GET',    path: '/v2/space-credentials/:credentialId/usage',                          kind: 'read',    status: 'v1' },
  { name: 'credentials.space.policy.get',                method: 'GET',    path: '/v2/spaces/:spaceId/credential-policy',                              kind: 'read',    status: 'v1' },
  { name: 'credentials.space.policy.set',                method: 'PUT',    path: '/v2/spaces/:spaceId/credential-policy/:provider',                    kind: 'command', status: 'v1' },
  // The node's own fallback credentials (D5/D9): node admin, and human-only.
  { name: 'node.credentials.status',                     method: 'GET',    path: '/v2/node/credentials',                                               kind: 'read',    status: 'v1' },
  { name: 'node.credentials.policy.set',                 method: 'PUT',    path: '/v2/node/credential-policy/:provider',                               kind: 'command', status: 'v1' },
  // Host metrics for the desktop status strip: node admin, human sessions only.
  { name: 'node.metrics.get',                            method: 'GET',    path: '/v2/node/metrics',                                                   kind: 'read',    status: 'v1' },

  // What the agent SAID — the third face of a session, after `execution.launch`
  // (told) and `execution.journal` (did). The bytes are the agent's OWN native
  // transcript under the config home selected at spawn (CLAUDE_CONFIG_DIR or
  // CODEX_HOME, with the node defaults used only when no credential is injected),
  // NOT the database and NOT the PTY ring: PTY bytes are ANSI repaints a
  // coordinator cannot read, and the journal records tm8 CLI calls and holds no
  // model output at all. Keyed by work_session id for the same reason
  // `execution.journal` is — every path component is derived from that row's own
  // columns, so no request can ever name a file.
  { name: 'execution.transcript',                        method: 'GET',    path: '/v2/work-sessions/:workSessionId/transcript',                        kind: 'read',    status: 'v1' },

  // Dispatcher (dreamer-dispatcher DESIGN §4.3, D2/D4). "Route this entity to
  // whoever should do it" — the caller names a subject and nothing else. The
  // resident-dispatcher resolution (liveness probe, spawn-if-absent, task
  // derivation, trusted delivery to the session id) is entirely server-side,
  // which is the point: a client that had to find the dispatcher itself would
  // have to reimplement the liveness rule, and `work_sessions.status` lies.
  // This is the ONLY new catalog row the dispatcher needs — the dispatcher's
  // own actions are existing ops (`entities.patch`, `edges.create`,
  // `execution.spawn`, `messages.post`).
  { name: 'execution.dispatch',                          method: 'POST',   path: '/v2/execution/dispatch',                                             kind: 'command', status: 'v1' },

  // containers — machines agents run in or drive (TM8-CONTAINERS-DESIGN §4.1).
  //
  // TWENTY-FIVE ROWS. The Design's PROSE says 27 and is wrong; §4.1's list is
  // the contract and the coordinator ruled on it (2026-09-03).
  //
  // Reads go through the UNIVERSAL entity reads — `entities.get`,
  // `entities.children`, `entities.connections`, `collections.query` — because
  // a container is an entity. THERE IS DELIBERATELY NO `containers.get`.
  // `providers.list` and `logs` are the only family-specific reads, because
  // their truth is on the node and not in the graph.
  //
  // EVERY ROW IS REGISTERED IN P0, INCLUDING THE ONES NOT YET BUILT. A `v1`
  // row with no handler answers 404, which breaks the reserved-op honesty rule
  // (DEV-13) exactly as a `reserved` row 404ing would. The not-yet-built ones
  // answer `501 not_implemented` with a named reason — the same mechanism the
  // `TM8_CONTAINERS=off` gate uses, so it is one path and not two.
  { name: 'containers.create',           method: 'POST',   path: '/v2/containers',                                        kind: 'command', status: 'v1' },
  { name: 'containers.start',            method: 'POST',   path: '/v2/containers/:containerId/commands/start',            kind: 'command', status: 'v1' },
  { name: 'containers.stop',             method: 'POST',   path: '/v2/containers/:containerId/commands/stop',             kind: 'command', status: 'v1' },
  { name: 'containers.pause',            method: 'POST',   path: '/v2/containers/:containerId/commands/pause',            kind: 'command', status: 'v1' },
  { name: 'containers.resume',           method: 'POST',   path: '/v2/containers/:containerId/commands/resume',           kind: 'command', status: 'v1' },
  { name: 'containers.destroy',          method: 'POST',   path: '/v2/containers/:containerId/commands/destroy',          kind: 'command', status: 'v1' },
  { name: 'containers.update',           method: 'PATCH',  path: '/v2/containers/:containerId',                           kind: 'command', status: 'v1' },
  { name: 'containers.policy.set',       method: 'POST',   path: '/v2/containers/:containerId/commands/policy',           kind: 'command', status: 'v1' },
  { name: 'containers.run',              method: 'POST',   path: '/v2/containers/:containerId/commands/run',              kind: 'command', status: 'v1' },
  { name: 'containers.terminal.start',   method: 'POST',   path: '/v2/containers/:containerId/terminals',                 kind: 'command', status: 'v1' },
  { name: 'containers.attach',           method: 'POST',   path: '/v2/containers/:containerId/attach',                    kind: 'command', status: 'v1' },
  // The EXISTING `/v2/ws` binding re-declared for discoverability — NOT a
  // second socket. The PTY, graph events and every container surface share
  // one socket and dispatch on the grant.
  { name: 'containers.stream',           method: 'WS',     path: '/v2/ws',                                                kind: 'stream',  status: 'v1', aliasOf: 'events.subscribe' },
  { name: 'containers.computer',         method: 'POST',   path: '/v2/containers/:containerId/commands/computer',         kind: 'command', status: 'v1' },
  { name: 'containers.browser.endpoint', method: 'POST',   path: '/v2/containers/:containerId/commands/browser-endpoint', kind: 'command', status: 'v1' },
  { name: 'containers.files.put',        method: 'PUT',    path: '/v2/containers/:containerId/files',                     kind: 'command', status: 'v1' },
  { name: 'containers.files.get',        method: 'GET',    path: '/v2/containers/:containerId/files',                     kind: 'read',    status: 'v1' },
  { name: 'containers.logs',             method: 'GET',    path: '/v2/containers/:containerId/logs',                      kind: 'read',    status: 'v1' },
  { name: 'containers.expose',           method: 'POST',   path: '/v2/containers/:containerId/commands/expose',           kind: 'command', status: 'v1' },
  { name: 'containers.unexpose',         method: 'POST',   path: '/v2/containers/:containerId/commands/unexpose',         kind: 'command', status: 'v1' },
  { name: 'containers.proxy',            method: 'GET',    path: '/v2/containers/:containerId/ports/:port/*',             kind: 'read',    status: 'v1' },
  { name: 'containers.snapshot',         method: 'POST',   path: '/v2/containers/:containerId/commands/snapshot',         kind: 'command', status: 'v1' },
  { name: 'containers.fork',             method: 'POST',   path: '/v2/containers/:containerId/commands/fork',             kind: 'command', status: 'v1' },
  { name: 'containers.providers.list',   method: 'GET',    path: '/v2/containers/providers',                              kind: 'read',    status: 'v1' },
  { name: 'containers.pools.set',        method: 'POST',   path: '/v2/containers/:containerId/commands/pool',             kind: 'command', status: 'v1' },
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

/**
 * The rows that OWN a `method path` binding — every row except the aliases.
 *
 * This is the list anything that MOUNTS should read: the HTTP router, the WS
 * upgrade handler, and any inventory that asserts one route per binding.
 * Discovery, help and the CLI catalog read `OPERATIONS` instead, because an
 * alias exists precisely to be listed. See `OperationBinding.aliasOf`.
 */
export const MOUNTED_OPERATIONS: readonly OperationBinding[] =
  OPERATIONS.filter((op) => !('aliasOf' in op));

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
