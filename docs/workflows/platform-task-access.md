# Workflow: inspect a task's access

Version 1 · 2026-11-21 · implementation specification

## Registry

| View | Entry |
| --- | --- |
| Workflow | Inspect task access; triggered by opening a task's Access section or Connections tab |
| Components | Task panel hosts → task access surface → existing entity, connection, project, credential and launch reads |
| Journey | A member inspects linked repositories, working directories, accounts used by runs, and permitted changes |
| States | LOADING → READY / PARTIAL / ERROR; READY → STALE → LOADING; any state → DISPOSED |

## Actors and prerequisites

The authenticated viewer must be able to read the task. The server evaluates all
reads using that viewer's existing claims. Reading a task or session grants no
additional project, credential, account, filesystem or command permission.

## Workflow tree

1. **LOADING**: clear the previous task's data. Read all pages of the task's
   outgoing `in_project` and incoming `working_on` connections, with explicit
   edge types. Read only the associated visible projects and sessions.
   - Each request has a 10 second display deadline. A retryable network,
     server, timeout or rate-limit failure gets one retry after 300 ms.
   - Forbidden, not-found and invalid-input failures do not retry.
   - Preserve successful pages if a later page fails. Mark that group partial;
     never describe an incomplete group as empty or complete.
   - A repeated cursor or the 100 page safety limit is an incomplete read.
2. Read project metadata from the existing project list; read each session's
   recorded launch; resolve provider credential labels through existing
   viewer-scoped credential metadata reads. Independent failures do not erase
   successful groups. Limit concurrent session reads to four.
3. **READY**: show current task capabilities, associated repositories and
   current project roots where the existing gate supplies them. For each run,
   show recorded launch directory, approval/access mode and command-network
   policy, effective provider sources, and resolved connector accounts.
   - Session launch settings describe the recorded launch, not a live probe or
     permission grant. Account status/scopes and task capabilities are current
     metadata checked at the displayed time.
   - Missing manifests, old fields and inaccessible metadata have explicit
     unknown/unavailable text. An unrecorded credential is never inferred from
     today's defaults. No raw manifest, prompt, environment, token, key hint,
     encrypted credential, or connector configuration is rendered.
4. **PARTIAL / ERROR**: retain only successfully read current groups; show an
   incomplete notice and a Refresh action. Retry starts a new generation.
5. **STALE**: after a durable workspace change or 60 seconds, label the snapshot
   stale. Refresh rechecks all groups and clears old permission/account facts
   while loading. A task switch or unmount ignores late responses and clears
   pending timers; no response may populate a different task's view.

## Handoff contracts

| Boundary | Payload → success | Errors / recovery |
| --- | --- | --- |
| UI → connections | `{id, types, direction, limit:50, cursor?}` → `Page<EdgeView>` | Existing CollabError codes; 10 s deadline, bounded retry, incomplete group on failure |
| UI → projects / credential metadata | `{spaceId}` → existing metadata DTOs | Existing authorization gates; no fallback to raw manifests for names/accounts; independent incomplete group |
| UI → launch | `{workSessionId}` → `SessionLaunchRecord` | Missing row is explained empty; other failures affect that run only |
| Launch projection → DB | `read_mcp_launch_selections(sessionId)` under viewer claims → resolved account pins | A null row means not recorded; errors produce metadata unavailable, without refusing the launch posture read |
| Account projection → DB | Viewer-scoped visible connector entities plus `list_mcp_credentials(serverId, credentialId)` → metadata allowlist | Hidden connector counted without its id/name; missing account shown unavailable without id/label; no secret RPC is called |

`SessionLaunchRecord.connectorAccounts` is additive and optional for older
servers. It contains availability/reason, visible connector entries, hidden
count, and allowlisted account metadata only. Work-session bindings store the
resolved accounts actually bound at launch/resume; chat selections have
different semantics and are outside this task view. Current metadata may change
or be revoked after the binding was recorded.

## Observable states and cleanup

| State | Customer and operator see | Database | Logs |
| --- | --- | --- | --- |
| LOADING | Reading access…; no prior permissions/accounts retained | Unchanged | Existing authenticated read request records |
| READY | Checked time, current task capabilities and per-run recorded access | Unchanged | Existing successful reads; no manifest/credential content logging |
| PARTIAL | Available groups and generic incomplete notices, Refresh | Unchanged | Existing failing request/code; no raw error payload in UI |
| ERROR | Access unavailable, Refresh | Unchanged | Existing failing read request/code |
| STALE | Checked time and explicit stale notice | Unchanged | No new request until Refresh |
| DISPOSED | Section gone or new task loading | Unchanged | No mutation or cleanup job |

This read-only workflow creates no durable resources, so there is no rollback
inventory. Concurrent task/account/project changes are resolved by Refresh;
there is no claim that the independent reads form one database snapshot.

## Validation cases

Happy path; more than one page of sessions/projects; second-page failure;
hidden connector; hidden/revoked account; provider metadata unavailable; old
manifest; empty bindings; request timeout and retry; authorization failure with
no retry; stale event/time; task switch while reads are pending; malicious
manifest fields remain absent; click-through opens the linked entity.

## Assumptions and limits

- Existing project reads omit node-local roots for viewers without the folder
  gate. The task view preserves this omission; a recorded session workdir is
  shown only through the already-authorized launch record.
- The existing launch record is readable by a task's visible work sessions; a
  task connection alone is never used to bypass that endpoint's gates.
- Capability flags describe changes the viewer may request to the task now.
  A recorded agent mode describes its launch policy, not guaranteed effective
  OS privileges, current token validity, or changes already made.
- Historical connector binding rows can be updated on resume. Label them
  recorded bindings rather than immutable original-launch account snapshots.

## Integration reality check (2026-11-20)

Independent Sol review verified the code against this workflow. Upload review
closed interrupted receipts, unknown settlement cleanup, completed-writer races,
and active-writer SQLSTATE handling. Attention review verified priority, personal
headlines, complete paging and failed-sibling read ownership. Access review checked
viewer gates, metadata allowlists, masking and recorded/current distinctions.
Short-title creation seams and prompt preservation pass the focused test suites.
Deployment remains a separate completion requirement recorded on the task.
