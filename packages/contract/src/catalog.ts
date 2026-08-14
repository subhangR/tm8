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
  { name: 'spaces.members.updateRole', method: 'PATCH', path: '/v2/spaces/:spaceId/members/:memberId',       kind: 'command', status: 'v1' },
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
  { name: 'entities.commands.gate',       method: 'POST', path: '/v2/entities/:id/commands/gate',           kind: 'command', status: 'v1' },
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

  // chat — configure an already-posted human root and start its first turn.
  // Every later user turn still travels through messages.post.
  { name: 'chat.threads.start',      method: 'POST',   path: '/v2/chat/threads',                            kind: 'command', status: 'v1' },

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
  // POST-WITH-`kind: 'read'`, DELIBERATELY. It writes nothing — it answers what
  // a join code lets you join, before the holder is anybody on this node — but
  // the code must travel in the BODY. A bearer capability in a URL path lands
  // in access logs, browser history and `Referer`, and a join link is exactly
  // the kind of URL that gets pasted somewhere it will be logged. Precedent for
  // the shape: `collections.query` and `graph.query`, both POST reads for the
  // same reason (a payload that does not belong in a URL).
  { name: 'auth.invite.resolve',                         method: 'POST',   path: '/v2/auth/invite/resolve',                                            kind: 'read',    status: 'v1' },

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
