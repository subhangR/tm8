# Projects and files

`ProjectResource` is a **node-level** configuration record — a repo URL, an absolute `workingDir` on
the tm8 node's filesystem, a `trust` level, and spawn `defaults` — created once per node and then
**linked** many-to-many into Spaces. Linking a project into a Space materializes a restricted
`project` **entity** scoped to that Space (a separate identifier domain: `projectId` names the
`ProjectResource`, `projectEntityId`/`projectId` inside an `EdgeCorrectionResult` names the per-Space
projection). This family also owns two independent blob-upload lifecycles that share one ledger:
`files.*` (a Space-scoped blob attached to any entity) and `projects.files.attach` /
`projects.folderUploads.*` (bytes read directly off the node's disk out of a connected project
folder, never transiting a browser upload). Everything that touches the node filesystem — browsing,
reading, archiving, attaching — is confined to `TM8_PROJECT_ROOTS`/the project's own `workingDir`,
refuses symlinks rather than following them, and omits or refuses a closed list of "secret" paths
(`.env*`, credential files, the tm8 data directory) rather than merely flagging them.

All 23 operations below are `status: 'v1'` and are all actually served (no `501 not_implemented`
placeholders in this group).

## Summary

| Operation | Method | Path | Kind | Served |
|---|---|---|---|---|
| `projects.list` | GET | `/v2/projects` | read | yes |
| `projects.create` | POST | `/v2/projects` | command | yes |
| `projects.directories.list` | GET | `/v2/project-directories` | read | yes |
| `projects.get` | GET | `/v2/projects/:projectId` | read | yes |
| `projects.contention` | GET | `/v2/projects/:projectId/contention` | read | yes |
| `projects.branches.list` | GET | `/v2/projects/:projectId/branches` | read | yes |
| `projects.file.history` | GET | `/v2/projects/:projectId/file-history` | read | yes |
| `projects.file.blame` | GET | `/v2/projects/:projectId/blame` | read | yes |
| `projects.update` | PATCH | `/v2/projects/:projectId` | command | yes |
| `projects.link` | POST | `/v2/spaces/:spaceId/projects` | command | yes |
| `projects.unlink` | DELETE | `/v2/spaces/:spaceId/projects/:projectId` | command | yes |
| `projects.files.list` | GET | `/v2/projects/:projectId/files` | read | yes |
| `projects.files.attach` | POST | `/v2/projects/:projectId/files/attach` | command | yes |
| `projects.files.read` | GET | `/v2/projects/:projectId/files/content` | read | yes |
| `projects.files.archive` | GET | `/v2/projects/:projectId/files/archive` | read (stream) | yes |
| `projects.folderUploads.init` | POST | `/v2/spaces/:spaceId/project-folder-uploads` | command | yes |
| `projects.folderUploads.complete` | POST | `/v2/project-folder-uploads/:folderUploadId/complete` | command | yes |
| `projects.folderUploads.abort` | POST | `/v2/project-folder-uploads/:folderUploadId/abort` | command | yes |
| `files.uploadInit` | POST | `/v2/files/uploads` | command | yes |
| `files.uploadComplete` | POST | `/v2/files/uploads/:uploadId/complete` | command | yes |
| `files.uploadAbort` | POST | `/v2/files/uploads/:uploadId/abort` | command | yes |
| `files.download` | GET | `/v2/files/:fileEntityId/download` | read (stream) | yes |
| `projects.associations.correct` | POST | `/v2/entities/:artifactId/commands/correct-project-association` | command | yes |

Source (catalog rows): `packages/contract/src/catalog.ts:179-226`, `:324`.

## Shared types

### Envelope, errors, idempotency

Every JSON response is `{ data, requestId }` (the `json()` helper, `packages/server/src/http/types.ts:147`).
Two operations return raw bytes instead of the envelope: `projects.files.archive` (a zip stream) and
`files.download` (the file's own bytes) — both documented below with their actual headers.

Commands take a **command context** embedded in the body:

```ts
interface CommandContext {
  actorId?: EntityId;          // act-as; SQL authorizes it (can_act_as)
  clientMutationId?: string;   // the idempotency key — see below
  workSessionId?: EntityId;    // provenance: which work session originated this
}
```
Source: `packages/contract/src/contract.ts:1698`.

**Idempotency is `clientMutationId`, not an HTTP header.** There is no `Idempotency-Key` header in
this API; the ledger (`internal.ledger_replay` / `internal.ledger_record` in SQL) keys replay
detection on `clientMutationId` scoped to the operation name. Replaying the same id returns the
original result rather than re-executing. When the ledger is disabled (test mode), the server
injects a fresh random UUID before validation so strict schemas that require the field still
validate (`packages/server/src/http/idempotency.ts`).

A successful **command** result is a `CommandResult`:
```ts
interface CommandResult {
  entity?: EntityDetail;
  edge?: EdgeView;
  activity?: ActivityItem;
  patches: EntitySummary[];
  undo?: UndoToken;
  warnings?: ResultWarning[];
}
```
Source: `packages/contract/src/contract.ts:1687`.

Errors are a closed union, mapped to HTTP status by one table (`ERROR_STATUS`, never inferred from
message text):

| `CommandErrorCode` | HTTP |
|---|---|
| `invalid_input`, `invalid_cursor` | 400 |
| `unauthenticated` | 401 |
| `forbidden` | 403 |
| `not_found` | 404 |
| `version_conflict`, `conflict`, `invariant_violation` | 409 |
| `payload_too_large` | 413 |
| `rate_limited`, `limit_exceeded` | 429 |
| `not_implemented` | 501 |
| `upstream_unavailable` | 503 |

Source: `packages/contract/src/contract.ts:1613-1637` (`CommandErrorCode`, `ERROR_STATUS`).
Database errors are translated by one SQLSTATE table only — never by regexing a message — in
`packages/server/src/http/errors.ts:37-73` (`SQLSTATE_TO_ERROR_CODE`), e.g. `P0002`→`not_found`,
`22023`→`invalid_input`, `23514`→`invariant_violation`, `40001`→`version_conflict`,
`53400`→`limit_exceeded`, `42501`→`forbidden`.

### `ProjectResource`

```ts
interface ProjectResource {
  id: ProjectId;
  name: string;
  repoUrl?: string | null;
  workingDir: string;            // absolute path on the owning node
  trust: 'trusted' | 'untrusted';
  defaults: { model?: string | null; agentTool?: string | null;
              mode?: 'worker'|'coordinator'|'coordinated-worker'|'coordinated-coordinator'|'dispatcher' | null };
  linkFrozen?: boolean;           // true once the 16-active-link migration cap tripped
  activeLinkCount?: number;
  createdAt: string;
  updatedAt: string;
}
```
Source: `packages/contract/src/contract.ts:4239-4252`; schema `packages/contract/src/schemas.ts:2839`.

### `CommitSessionAttribution` (shared by `file.history` and `file.blame`)

```ts
interface CommitSessionAttribution {
  commitEntityId: string;
  sessionId: EntityId;
  sessionTitle: string;
  agentTool: string | null;
  teamMemberId: string | null;
  teamMemberName: string | null;
}
```
`null` on a revision/hunk means "no tm8 session recorded this commit" — never inferred from an
author-name or timestamp match. Source: `packages/contract/src/contract.ts:4404-4416`.

### `ContentionReport` family

```ts
interface ContentionLane {
  worktreeId: string; branch: string; path: string; sessionId: string | null;
  touchedCount: number; touchedPaths: string[]; skipped: string | null;
}
interface ContentionPair {
  aWorktreeId: string; bWorktreeId: string; aBranch: string; bBranch: string;
  overlappingPaths: string[];
}
interface ContentionReport {
  projectId: string; generatedAt: string; lanes: ContentionLane[]; pairs: ContentionPair[];
}
```
Source: `packages/contract/src/contract.ts:2832-2855`.

### `ProjectBranchTopology` / `ProjectBranch`

```ts
interface ProjectBranch {
  name: string; head: string; lastCommitAt: string; subject: string;
  upstream: string | null; ahead: number; behind: number;
  isDefault: boolean; isCurrent: boolean; merged: boolean; stale: boolean;
}
interface ProjectBranchTopology {
  projectId: ProjectId; workingDir: string; defaultBranch: string;
  defaultBranchSource: 'origin_head' | 'local_conventional' | 'current_branch';
  branches: ProjectBranch[]; truncated: boolean; staleAfterDays: number;
}
```
Source: `packages/contract/src/contract.ts:4353-4398`.

### `ProjectFileHistory` / `ProjectFileBlame`

```ts
interface ProjectRevisionDiff { oid: string; diff: string; truncated: boolean }
interface ProjectFileRevision {
  oid: string; author: string; authorEmail: string; committedAt: string; subject: string;
  additions: number | null; deletions: number | null; path: string;
  session: CommitSessionAttribution | null;
}
interface ProjectFileHistory {
  projectId: ProjectId; workingDir: string; path: string;
  revisions: ProjectFileRevision[]; truncated: boolean; diff: ProjectRevisionDiff | null;
}
interface ProjectBlameHunk {
  oid: string; startLine: number; lineCount: number; author: string; committedAt: string;
  summary: string; uncommitted: boolean; session: CommitSessionAttribution | null;
}
interface ProjectFileBlame {
  projectId: ProjectId; workingDir: string; path: string; hunks: ProjectBlameHunk[];
  blamedLines: number; totalLines: number; truncated: boolean;
}
```
Source: `packages/contract/src/contract.ts:4400-4488`.

### `ProjectDirectoryListing` / `ProjectFileListing` / `ProjectFileReadResult`

```ts
interface ProjectDirectoryEntry { name: string; path: string }
interface ProjectDirectoryListing {
  roots: string[]; path: string; parentPath: string | null; separator: '/' | '\\';
  directories: ProjectDirectoryEntry[]; truncated: boolean;
}
interface ProjectFileEntry {
  name: string; path: string; sizeBytes: number; modifiedAt: string; mime: string; attachable: boolean;
}
interface ProjectFileListing {
  projectId: string; workingDir: string; path: string; parentPath: string | null;
  separator: '/' | '\\'; directories: ProjectDirectoryEntry[]; files: ProjectFileEntry[];
  truncated: boolean; maxSizeBytes: number;
}
interface ProjectFileReadResult {
  projectId: string; path: string; name: string; mime: string; sizeBytes: number;
  encoding: 'utf8' | 'base64'; content: string; truncated: boolean;
}
```
`ProjectFileListing.files[].attachable` is `false` for empty files and files over the effective
size ceiling. `ProjectFileReadResult.mime` reports `text/html` and `image/svg+xml` as `text/plain`
so an inline read can never hand a UI a type it would render as active content (`packages/server/src/facade/services/w2/project-files.ts:256-259`).
Source: `packages/contract/src/contract.ts:4491-4587`.

### `EdgeCorrectionResult`

```ts
interface EdgeCorrectionResult {
  artifactId: EntityId; projectId: ProjectId;
  outcome: 'removed' | 'demoted' | 'unchanged'; edge: EdgeView | null;
}
```
Source: `packages/contract/src/contract.ts:4611-4622`; schema `packages/contract/src/schemas.ts:3107`.

### `FileUploadGrant` / `ProjectFolderUploadGrant` and the frozen folder-upload ceilings

```ts
interface FileUploadGrant {
  uploadId: string; uploadUrl: string; token?: string | null; expiresAt: string; maxSizeBytes: number;
}
interface ProjectFolderUploadFileGrant extends FileUploadGrant { relativePath: string }
interface ProjectFolderUploadGrant {
  folderUploadId: string; expiresAt: string;
  maxFiles: number; maxDirectories: number; maxTotalBytes: number; maxPathBytes: number;
  files: ProjectFolderUploadFileGrant[];
}
```
Deployment-independent, frozen constants carried on every folder grant:
`PROJECT_FOLDER_UPLOAD_MAX_FILES = 1000`, `PROJECT_FOLDER_UPLOAD_MAX_DIRECTORIES = 2000`,
`PROJECT_FOLDER_UPLOAD_MAX_TOTAL_BYTES = 1 GiB`, `PROJECT_FOLDER_UPLOAD_MAX_PATH_BYTES = 1024`.
`files.uploadInit`'s ceiling (`maxSizeBytes`) is instead deployment-configurable, defaulting to
`FILE_MAX_SIZE_BYTES_DEFAULT = 512 MiB`.
Source: `packages/contract/src/contract.ts:4274-4350, 6060-6109`.

**Upload lifecycle (both families):** `*.uploadInit`/`folderUploads.init` reserves a slot and
returns a grant; the client `PUT`s raw bytes to `grant.uploadUrl`
(`/v2/files/uploads/:uploadId/content`) with the grant token in the `x-tm8-upload-token` header
(`TM8_UPLOAD_TOKEN_HEADER`, `packages/contract/src/envelope.ts:72`); `*.uploadComplete`/
`folderUploads.complete` re-verifies size+checksum and creates the graph-side record in one
transaction; `*.uploadAbort`/`folderUploads.abort` (or grant expiry, 15 minutes) releases the slot.
`projects.files.attach` and `folderUploads.complete` drive this **same** ledger with the byte
source swapped from an HTTP body to a node-local read stream, via `deriveMutationId(rootId, stage)`
— a deterministic per-stage id so one caller-supplied mutation id can safely drive the multi-stage
sequence without violating "one `clientMutationId` per operation."

---

## `projects.list`
`GET /v2/projects` · kind: read · status: v1 · served: yes (`packages/server/src/facade/services/w2/projects-associations.ts:371`)
CLI: `tm8 project list [--limit <count>] [--cursor <cursor>]` — **note:** the CLI's own discovery
metadata prints this usage string, but the live binary refuses `--limit`/`--cursor` for this
operation ("the frozen contract defines no paging for `projects.list`: it answers the complete list
in one response"); `tm8 project list` with no flags is the accurate invocation.

Lists `ProjectResource` rows visible to the caller, optionally filtered to one Space's linked
projects. There is no pagination — the whole list is returned every time.

**Query params**

| name | type | required | default / constraints | description |
|---|---|---|---|---|
| `spaceId` | string (UUID) | no | — | filter to projects linked to this Space via `space_projects` |

**Response** — 200; `data`: `ProjectResource[]`, ordered `name asc, id asc`.

Example (captured, `tm8 project list --format json`, trimmed to 2 of 12 rows):
```json
{
  "data": [
    {
      "id": "01a025f4-5c82-7b57-836d-cdc82c9d3d45",
      "name": "BeFree",
      "repoUrl": "https://github.com/subhangR/BeFree",
      "workingDir": "/home/tm8/projects/befree",
      "trust": "trusted",
      "defaults": {},
      "linkFrozen": false,
      "activeLinkCount": 2,
      "createdAt": "2026-08-21T20:12:46.593Z",
      "updatedAt": "2026-08-31T09:32:36.022Z"
    },
    {
      "id": "01a0d349-dca6-7035-a2e3-6989c4fdbf72",
      "name": "Invoice Studio",
      "repoUrl": null,
      "workingDir": "/home/tm8/prod-data/scratch/01a0d344-a3c4-7c52-ae4a-22735666ba75",
      "trust": "untrusted",
      "defaults": { "model": "gpt-5.6-sol", "agentTool": "codex" },
      "linkFrozen": false,
      "activeLinkCount": 0,
      "createdAt": "2026-09-24T12:00:28.269Z",
      "updatedAt": "2026-09-24T12:00:28.269Z"
    }
  ],
  "requestId": "<redacted>"
}
```

**Errors** — none beyond the standard `unauthenticated` (no session/loopback identity).
**Notes** — no idempotency (read). No pagination cursor exists for this operation despite the CLI
discovery metadata suggesting one (see CLI line above). `spaceId` filter uses `optionalUuid`.
Source: catalog `packages/contract/src/catalog.ts:179`; handler registration
`packages/server/src/facade/handlers/w2/projects-associations.ts:13`; service `…/services/w2/projects-associations.ts:371-388`.

---

## `projects.create`
`POST /v2/projects` · kind: command · status: v1 · served: yes (`packages/server/src/facade/services/w2/projects-associations.ts:627`)
CLI: `tm8 project create <name> --working-dir <absolute-path> [--repo-url <url|none>] [--trust trusted|untrusted] [--default-model <name|none>] [--default-agent-tool <name|none>] [--default-mode worker|coordinator|coordinated-worker|coordinated-coordinator|dispatcher|none] [--mutation-id <id>]`

Registers a new `ProjectResource`. **Node-admin only**, for both the "use an existing directory"
and the "create the directory" branches — refusing here keeps the refusal an honest, early
`forbidden` instead of surfacing the RPC's own `require_node_admin()` failure later.

**Request body**

| field | type | required | constraints | description |
|---|---|---|---|---|
| `name` | string | yes | min 1 char | project display name |
| `workingDir` | string | yes | min 1 char, absolute | node-local directory |
| `repoUrl` | string \| null | no | — | remote repository URL |
| `trust` | `'trusted' \| 'untrusted'` | no | default `'untrusted'` | explicit grant only |
| `defaults` | object | no | `{model?, agentTool?, mode?}` | spawn defaults |
| `ensureWorkingDir` | boolean | no | default `false` | create `workingDir` if it is one missing child under an allowed browse root; never mutates the filesystem when absent/false |
| `clientMutationId` | string | no | min 1 char | idempotency key |
| `actorId`, `workSessionId` | string (UUID) | no | — | command context |

Example request:
```json
{ "name": "BeFree", "workingDir": "/home/tm8/projects/befree", "trust": "trusted", "clientMutationId": "<redacted>" }
```

**Response** — 201; `data`: `ProjectResource` (see Shared types).
Example (illustrative, from schema):
```json
{ "data": { "id": "01a0...", "name": "BeFree", "repoUrl": null, "workingDir": "/home/tm8/projects/befree", "trust": "untrusted", "defaults": {}, "linkFrozen": false, "activeLinkCount": 0, "createdAt": "2026-09-25T00:00:00.000Z", "updatedAt": "2026-09-25T00:00:00.000Z" }, "requestId": "<redacted>" }
```

**Errors**
- `forbidden` (403) — caller is not node-admin.
- `invalid_input` (400) — malformed body (schema `.strict()` rejection).

**Notes** — idempotent via `clientMutationId` (ledger `create_project`). Side effect: for every
Space the new project ends up linked to (normally none at creation), `scanSpaceSkills` runs. RPC:
`create_project`.
Source: catalog `packages/contract/src/catalog.ts:180`; schema
`packages/contract/src/schemas.ts:2852` (`ProjectCreateInputSchema`); input binding
`packages/server/src/facade/input-schemas.ts:306`; handler
`packages/server/src/facade/handlers/w2/projects-associations.ts:14`; service `…/projects-associations.ts:627-665`.

---

## `projects.directories.list`
`GET /v2/project-directories` · kind: read · status: v1 · served: yes (`packages/server/src/facade/services/w2/projects-associations.ts:343`)
CLI: none — `cmd: null`, reason `ui_onboarding_only`: "the browser onboarding flow invokes this
root-confined read; tm8 CLI exposes no general filesystem browser" (`packages/cli/src/discovery/operations.ts:1330-1339`).

Browses allowed node-local directories (rooted at `TM8_PROJECT_ROOTS`) for Space project onboarding.
**Node-admin only** — browsing used to be open to any authenticated user, but that stopped being
survivable once Space roles became writable: the default browse scope is the OS filesystem root,
and the secret filter is a denylist over the whole filesystem rather than one home directory.

**Query params**

| name | type | required | default / constraints | description |
|---|---|---|---|---|
| `path` | string | no | must resolve inside an allowed root | directory to list; absent lists the roots |

**Response** — 200; `data`: `ProjectDirectoryListing` (see Shared types).
Example (illustrative, from schema):
```json
{ "data": { "roots": ["/home/tm8/projects"], "path": "/home/tm8/projects", "parentPath": null, "separator": "/", "directories": [{ "name": "befree", "path": "/home/tm8/projects/befree" }], "truncated": false }, "requestId": "<redacted>" }
```

**Errors**
- `forbidden` (403) — `claims.nodeAdmin !== true`.

**Notes** — no idempotency (read); files are deliberately absent from this listing — it is a
project-root picker, not a filesystem API. `path` is validated by `canonicalRoots`/`requireAllowed`
in `project-directories.ts`.
Source: catalog `packages/contract/src/catalog.ts:181`; contract
`packages/contract/src/contract.ts:4491-4502`; handler
`packages/server/src/facade/handlers/w2/projects-associations.ts:15`; service `…/projects-associations.ts:343-369`.

---

## `projects.get`
`GET /v2/projects/:projectId` · kind: read · status: v1 · served: yes (`packages/server/src/facade/services/w2/projects-associations.ts:390`)
CLI: `tm8 project get <project-resource-id>`

Reads one `ProjectResource` by id.

**Path params**

| name | type | description |
|---|---|---|
| `projectId` | string (UUID) | the `ProjectResource` id |

**Response** — 200; `data`: `ProjectResource`.
Example (captured, `tm8 project get 01a025f4-5c82-7b57-836d-cdc82c9d3d45 --format json`):
```json
{
  "data": {
    "id": "01a025f4-5c82-7b57-836d-cdc82c9d3d45",
    "name": "BeFree",
    "repoUrl": "https://github.com/subhangR/BeFree",
    "workingDir": "/home/tm8/projects/befree",
    "trust": "trusted",
    "defaults": {},
    "linkFrozen": false,
    "activeLinkCount": 2,
    "createdAt": "2026-08-21T20:12:46.593Z",
    "updatedAt": "2026-08-31T09:32:36.022Z"
  },
  "requestId": "<redacted>"
}
```

**Errors**
- `not_found` (404) — `no such project: <projectId>`.

**Notes** — no idempotency (read). Authorization is RLS-scoped (`projects_select`): visible to
linked-Space members and node admins.
Source: catalog `packages/contract/src/catalog.ts:182`; handler
`packages/server/src/facade/handlers/w2/projects-associations.ts:16`; service `…/projects-associations.ts:390-401`.

---

## `projects.contention`
`GET /v2/projects/:projectId/contention` · kind: read · status: v1 · served: yes (`packages/server/src/facade/services/contention.ts:40`)
CLI: `tm8 project contention <project-resource-id>`

Detects merge-order-dependent silent reverts: intersects the touched-path sets of every **active**
worktree lane of the project (argv-only git via `touchedPaths()`), while both lanes are still
active — before a second merge would silently undo the first lane's fix.

**Path params**

| name | type | description |
|---|---|---|
| `projectId` | string (UUID) | the `ProjectResource` id |

**Response** — 200; `data`: `ContentionReport` (see Shared types). A worktree this node cannot read
is reported as a lane with `skipped: "worktree is not readable on this node"` rather than omitted.
`pairs` contains only lanes whose touched-path sets actually overlap.

Example (captured, `tm8 project contention 01a025f4-5c82-7b57-836d-cdc82c9d3d45 --format json`,
trimmed to 1 of many lanes; this node could not read any of this project's worktree directories at
capture time, so `pairs` was empty):
```json
{
  "data": {
    "projectId": "01a025f4-5c82-7b57-836d-cdc82c9d3d45",
    "generatedAt": "2026-09-25T18:23:22.862Z",
    "lanes": [
      {
        "worktreeId": "01a07cb4-3243-782e-b579-c21657a78d93",
        "branch": "tm8/01a07cb4-3243-782e-b579-c21657a78d93",
        "path": "/home/tm8/prod-data/worktrees/01a025f4-5c82-7b57-836d-cdc82c9d3d45/01a07cb4-3243-782e-b579-c21657a78d93",
        "sessionId": "01a07cb4-3337-7383-bd1b-70da46c12c3b",
        "touchedCount": 0,
        "touchedPaths": [],
        "skipped": "worktree is not readable on this node"
      }
    ],
    "pairs": []
  },
  "requestId": "<redacted>"
}
```

**Errors**
- `not_found` (404) — `no such project: <projectId>`.

**Notes** — no idempotency (read). `public.worktrees` is read under the caller's RLS-scoped claims,
so an unreadable-to-the-caller lane never appears at all (distinct from a lane this *node* cannot
read, which appears `skipped`). O(n²) pairwise comparison over readable lanes only.
Source: catalog `packages/contract/src/catalog.ts:183`; contract
`packages/contract/src/contract.ts:2832-2855`; registration+service
`packages/server/src/facade/services/contention.ts:40-122`.

---

## `projects.branches.list`
`GET /v2/projects/:projectId/branches` · kind: read · status: v1 · served: yes (`packages/server/src/facade/services/w2/projects-associations.ts:412`)
CLI: `tm8 project branches <project-resource-id> [--stale-after-days <days>] [--limit <count>]`

Lists local branches in the project's working directory with ahead/behind and staleness, via
argv-only git — nothing is checked out, fetched, or written.

**Path params**

| name | type | description |
|---|---|---|
| `projectId` | string (UUID) | the `ProjectResource` id |

**Query params**

| name | type | required | default / constraints | description |
|---|---|---|---|---|
| `staleAfterDays` | integer | no | positive integer; module default when absent | branches with no commit newer than this are `stale: true` |
| `limit` | integer | no | `limitOf(…, MAX_LIMIT)` — **default 200 when absent**, capped at `MAX_LIMIT=200` | max branches returned |

Note: this operation's own absent-`limit` default is 200 (`MAX_LIMIT`), not the site-wide
`DEFAULT_LIMIT=50` used elsewhere (`packages/server/src/facade/context.ts:144-153`).

**Response** — 200; `data`: `ProjectBranchTopology` (see Shared types). `defaultBranchSource`
travels with `defaultBranch` because "main" is a convention, not a rule.

Example (captured, `tm8 project branches 01a025f4-5c82-7b57-836d-cdc82c9d3d45 --limit 5 --format json`, trimmed to 2 of 5 branches):
```json
{
  "data": {
    "projectId": "01a025f4-5c82-7b57-836d-cdc82c9d3d45",
    "workingDir": "/home/tm8/projects/befree",
    "defaultBranch": "main",
    "defaultBranchSource": "origin_head",
    "branches": [
      { "name": "tm8/01a09c62-af81-7abd-ae14-e694b7021135", "head": "59f04491...", "lastCommitAt": "2026-09-14T16:58:01.000Z", "subject": "Correct three security claims that the code does not support", "upstream": null, "ahead": 11, "behind": 0, "isDefault": false, "isCurrent": false, "merged": false, "stale": false },
      { "name": "main", "head": "2dd9e044...", "lastCommitAt": "2026-08-21T20:07:22.000Z", "subject": "Initial import of BeFree", "upstream": "origin/main", "ahead": 0, "behind": 0, "isDefault": true, "isCurrent": true, "merged": false, "stale": true }
    ],
    "truncated": true,
    "staleAfterDays": 30
  },
  "requestId": "<redacted>"
}
```

**Errors**
- `not_found` (404) — `no such project: <projectId>`.
- `invalid_input` (400) — the working directory is not a git repository, or has no default branch
  (reasons `not_a_git_repository` / `no_default_branch` from the execution layer, deliberately
  reported as `invalid_input` rather than `internal` — this is a configuration fact about the
  project, not a server fault).

**Notes** — no idempotency (read). Authorization is exactly `projects.get`'s: the path always comes
from the project row, never the request.
Source: catalog `packages/contract/src/catalog.ts:184`; contract
`packages/contract/src/contract.ts:4353-4398`; handler
`packages/server/src/facade/handlers/w2/projects-associations.ts:17`; service `…/projects-associations.ts:412-442`.

---

## `projects.file.history`
`GET /v2/projects/:projectId/file-history` · kind: read · status: v1 · served: yes (`packages/server/src/facade/services/w2/projects-associations.ts:551`)
CLI: `tm8 project file-history <project-resource-id> <path> [--max-revisions <count>]`

Revisions of one path in the project's working directory (`git log --follow`, argv-only), each
joined to its `created_in` session-provenance edge when one exists.

**Path params**

| name | type | description |
|---|---|---|
| `projectId` | string (UUID) | the `ProjectResource` id |

**Query params**

| name | type | required | default / constraints | description |
|---|---|---|---|---|
| `path` | string | yes | non-empty | pathspec inside the checkout (never a directory outside it) |
| `maxRevisions` | integer | no | positive integer | caps the walk |
| `diffOid` | string | no | a commit oid from `revisions` | when present, also returns the patch that revision applied to the path |

**Response** — 200; `data`: `ProjectFileHistory` (see Shared types).
Example (captured, `tm8 project file-history 01a025f4-5c82-7b57-836d-cdc82c9d3d45 README.md --max-revisions 3 --format json`):
```json
{
  "data": {
    "projectId": "01a025f4-5c82-7b57-836d-cdc82c9d3d45",
    "workingDir": "/home/tm8/projects/befree",
    "path": "README.md",
    "revisions": [
      { "oid": "2dd9e04475b8f895676f78716955e79c9385da67", "author": "subhangR", "authorEmail": "<redacted>", "committedAt": "2026-08-22T01:37:22+05:30", "subject": "Initial import of BeFree", "additions": 427, "deletions": 0, "path": "README.md", "session": null }
    ],
    "truncated": false,
    "diff": null
  },
  "requestId": "<redacted>"
}
```

**Errors**
- `not_found` (404) — no such project.
- `invalid_input` (400) — `path` query parameter missing; or the underlying execution-layer error
  is itself `invalid_input`, lifted with `details.reason` set to the execution layer's own reason
  string.

**Notes** — no idempotency (read). `session: null` means no tm8 session recorded the commit — never
inferred from author/timestamp. Attribution join reads `public.commits` → `created_in` edge →
`work_sessions` (→ newest `relates_to` teammate), under the caller's claims, so RLS decides
visibility; first (oldest) recorded provenance wins if a sha is mirrored in two visible Spaces.
Source: catalog `packages/contract/src/catalog.ts:188`; contract
`packages/contract/src/contract.ts:4418-4460`; handler
`packages/server/src/facade/handlers/w2/projects-associations.ts:18`; service `…/projects-associations.ts:497-591`.

---

## `projects.file.blame`
`GET /v2/projects/:projectId/blame` · kind: read · status: v1 · served: yes (`packages/server/src/facade/services/w2/projects-associations.ts:594`)
CLI: `tm8 project blame <project-resource-id> <path> [--max-lines <count>]`

Working-tree blame of one path (`git blame --porcelain`, argv-only), grouped into contiguous hunks,
each joined to the session provenance graph. Bounded: `blamedLines ≤` the line cap; `totalLines` is
measured, so a cut states exactly how many lines it withholds.

**Path params**

| name | type | description |
|---|---|---|
| `projectId` | string (UUID) | the `ProjectResource` id |

**Query params**

| name | type | required | default / constraints | description |
|---|---|---|---|---|
| `path` | string | yes | non-empty | pathspec inside the checkout |
| `maxLines` | integer | no | positive integer | caps hunks reported |

**Response** — 200; `data`: `ProjectFileBlame` (see Shared types).
Example (captured, `tm8 project blame 01a025f4-5c82-7b57-836d-cdc82c9d3d45 README.md --max-lines 10 --format json`):
```json
{
  "data": {
    "projectId": "01a025f4-5c82-7b57-836d-cdc82c9d3d45",
    "workingDir": "/home/tm8/projects/befree",
    "path": "README.md",
    "hunks": [
      { "oid": "2dd9e04475b8f895676f78716955e79c9385da67", "startLine": 1, "lineCount": 10, "author": "subhangR", "committedAt": "2026-08-21T20:07:22.000Z", "summary": "Initial import of BeFree", "uncommitted": false, "session": null }
    ],
    "blamedLines": 10,
    "totalLines": 427,
    "truncated": true
  },
  "requestId": "<redacted>"
}
```

**Errors**
- `not_found` (404) — no such project.
- `invalid_input` (400) — `path` missing, or a lifted execution-layer `invalid_input`.

**Notes** — no idempotency (read). The all-zero oid marks not-yet-committed lines
(`UNCOMMITTED_OID`); uncommitted hunks are never joined to session attribution.
Source: catalog `packages/contract/src/catalog.ts:189`; contract
`packages/contract/src/contract.ts:4462-4488`; handler
`packages/server/src/facade/handlers/w2/projects-associations.ts:19`; service `…/projects-associations.ts:497-511, 594-625`.

---

## `projects.update`
`PATCH /v2/projects/:projectId` · kind: command · status: v1 · served: yes (`packages/server/src/facade/services/w2/projects-associations.ts:667`)
CLI: `tm8 project update <project-resource-id> [--name <name>] [--working-dir <absolute-path>] [--trust trusted|untrusted] [--yes] [--mutation-id <id>]`

Changes `ProjectResource` configuration (partial patch — only fields present in the body are
changed).

**Path params**

| name | type | description |
|---|---|---|
| `projectId` | string (UUID) | the `ProjectResource` id |

**Request body**

| field | type | required | constraints | description |
|---|---|---|---|---|
| `name` | string | no | min 1 char | |
| `workingDir` | string | no | min 1 char | |
| `repoUrl` | string \| null | no | | |
| `trust` | `'trusted' \| 'untrusted'` | no | | |
| `defaults.model` | string \| null | no | | |
| `defaults.agentTool` | string \| null | no | | |
| `defaults.mode` | enum | no | | |
| `clientMutationId`, `actorId`, `workSessionId` | — | no | command context | |

**Response** — 200; `data`: `ProjectResource`.

**Errors**
- `not_found` (404) — `P0002`, project not found.
- `invalid_input` (400) — `22023`: patch has an unrecognized key, or a field is the wrong JSON type
  (`name`/`workingDir` must be string, `repoUrl` string-or-null, `trust` must be
  `'trusted'|'untrusted'`, `defaults` must be an object).
- `limit_exceeded` (429) — `53400`, `details.reason: "project_over_cap"`: the project is
  `link_frozen` (over the 16-active-link migration cap).

**Notes** — idempotent via `clientMutationId` (RPC `update_project_w2`, ledger-backed). **Node-admin
only** (`internal.require_node_admin()` inside the RPC). `details.reason` is lifted from the RPC's
`detail` field by `normalizeFrozenProjectReason` (shared with `link`/`unlink`/`associations.correct`).
Source: catalog `packages/contract/src/catalog.ts:190`; schema
`packages/contract/src/schemas.ts:3087` (`ProjectUpdateInputSchema`); input binding
`packages/server/src/facade/input-schemas.ts:314`; handler
`packages/server/src/facade/handlers/w2/projects-associations.ts:20`; service `…/projects-associations.ts:667-682`;
RPC `db/migrations/021_w2_projects.sql:214-280`.

---

## `projects.link`
`POST /v2/spaces/:spaceId/projects` · kind: command · status: v1 · served: yes (`packages/server/src/facade/services/w2/projects-associations.ts:684`)
CLI: `tm8 project link <project-resource-id> [--space <space-id>] [--mutation-id <id>]`

Links a `ProjectResource` into a Space and materializes its restricted per-Space `project`
projection entity. The result carries **both** identities — the `ProjectResource` id and the
per-Space projection entity id — never interchangeable.

**Path params**

| name | type | description |
|---|---|---|
| `spaceId` | string (UUID) | the Space to link into |

**Request body**

| field | type | required | constraints | description |
|---|---|---|---|---|
| `projectId` | string (UUID) | yes | | the `ProjectResource` to link |
| `clientMutationId`, `actorId`, `workSessionId` | — | no | command context | |

**Response** — 200; `data`: `{ spaceId: string, projectId: string, patches: [] }`.

**Errors**
- `not_found` (404) — `P0002`, project not found.
- `forbidden` (403) — caller is not a Space admin (`internal.require_space_admin`).
- `limit_exceeded` (429) — `53400`, `details.reason: "project_over_cap"` — project is frozen.

**Notes** — idempotent via `clientMutationId` (RPC `link_project_w2`; `on conflict … do nothing` on
the link row itself). Side effect: `scanSpaceSkills` runs for the newly linked project. Requires
**Space admin**, not node-admin.
Source: catalog `packages/contract/src/catalog.ts:191`; schema
`packages/contract/src/schemas.ts:3096` (`ProjectLinkInputSchema`); input binding
`packages/server/src/facade/input-schemas.ts:315`; handler
`packages/server/src/facade/handlers/w2/projects-associations.ts:21`; service `…/projects-associations.ts:684-700`;
RPC `db/migrations/021_w2_projects.sql:285-330`.

---

## `projects.unlink`
`DELETE /v2/spaces/:spaceId/projects/:projectId` · kind: command · status: v1 · served: yes (`packages/server/src/facade/services/w2/projects-associations.ts:702`)
CLI: `tm8 project unlink <project-resource-id> [--space <space-id>] --yes [--mutation-id <id>]`

Unlinks a `ProjectResource` from a Space. **Idempotent at the domain level**: unlinking an
already-unlinked pair is not an error.

**Path params**

| name | type | description |
|---|---|---|
| `spaceId` | string (UUID) | |
| `projectId` | string (UUID) | |

**Request body** — only the bare command context (`RequiredCommandContextSchema`):

| field | type | required | constraints | description |
|---|---|---|---|---|
| `clientMutationId` | string | yes | min 1 char | |
| `actorId` | string (UUID) | no | | |

**Response** — 200; `data`: `{ spaceId: string, projectId: string, patches: [] }`.

**Errors**
- `not_found` (404) — `P0002`, project not found. (Space-project link absence is *not* an error.)
- `forbidden` (403) — caller is not a Space admin.

**Notes** — idempotent via `clientMutationId` (RPC `unlink_project_w2`). Side effect: if a stable
per-Space projection entity existed and the space-project link is now gone, it is soft-deleted
(idempotent repair against an interrupted prior unlink); `active_link_count` is recomputed and
`link_frozen` clears once the count is `≤ 16`.
Source: catalog `packages/contract/src/catalog.ts:192`; input binding (`RequiredCommandContextSchema`)
`packages/server/src/facade/input-schemas.ts:154, 316`; handler
`packages/server/src/facade/handlers/w2/projects-associations.ts:22`; service `…/projects-associations.ts:702-717`;
RPC `db/migrations/021_w2_projects.sql:332-370`.

---

## `projects.files.list`
`GET /v2/projects/:projectId/files` · kind: read · status: v1 · served: yes (`packages/server/src/facade/services/w2/project-files-service.ts:177`)
CLI: none — `cmd: null`, reason `ui_project_browser_only`: "confined to the project working
directory AND to `TM8_PROJECT_ROOTS`; symlink rows are omitted rather than followed. A CLI caller
already holds the node filesystem and reaches these bytes with shell tools." (`packages/cli/src/discovery/operations.ts:1416-1427`)

Bounded view of one directory inside a connected project's working directory — confined to that
single project (unlike `projects.directories.list`, which browses `TM8_PROJECT_ROOTS` at large) and
lists files (browsing exists to support attaching one).

**Path params**

| name | type | description |
|---|---|---|
| `projectId` | string (UUID) | |

**Query params**

| name | type | required | default / constraints | description |
|---|---|---|---|---|
| `path` | string | no | must resolve inside the project's `workingDir` | directory to list; absent lists the working directory root |

**Response** — 200; `data`: `ProjectFileListing` (see Shared types; `MAX_PROJECT_FILES = 500` per
directories/files list, symlinks omitted).
Example (illustrative, from schema):
```json
{ "data": { "projectId": "01a0...", "workingDir": "/home/tm8/projects/befree", "path": "/home/tm8/projects/befree", "parentPath": null, "separator": "/", "directories": [{ "name": "src", "path": "/home/tm8/projects/befree/src" }], "files": [{ "name": "README.md", "path": "/home/tm8/projects/befree/README.md", "sizeBytes": 12345, "modifiedAt": "2026-08-21T20:07:22.000Z", "mime": "text/markdown", "attachable": true }], "truncated": false, "maxSizeBytes": 536870912 }, "requestId": "<redacted>" }
```

**Errors**
- `not_found` (404) — no such project.
- `forbidden` (403) — path resolves outside the project working directory, or the directory is not
  readable (`EACCES`/`EPERM`).
- `upstream_unavailable` (503) — directory could not be listed for any other reason.

**Notes** — no idempotency (read). Requires only that the project row is visible to the caller (RLS
`projects_select`) — a member who can see a project can already spawn a shell in it, so read-only
browsing adds no new capability; **not** node-admin gated (contrast `projects.files.attach` below).
Every access — allowed or refused — is logged via `ProjectFileAuditEvent` (`op: 'projects.files.list'`).
Source: catalog `packages/contract/src/catalog.ts:193`; contract
`packages/contract/src/contract.ts:4491, 4511, 4528`; handler
`packages/server/src/facade/handlers/w2/project-files.ts:22`; service
`packages/server/src/facade/services/w2/project-files-service.ts:177-185, 322-344, 415-439`;
pure listing logic `packages/server/src/facade/services/w2/project-files.ts:112-175`.

---

## `projects.files.attach`
`POST /v2/projects/:projectId/files/attach` · kind: command · status: v1 · served: yes (`packages/server/src/facade/services/w2/project-files-service.ts:242`)
CLI: none — `cmd: null`, reason `use_file_upload`: "the browser cannot name an absolute node path,
so a connected folder is readable only by the node holding it. `tm8 file upload <path>
--attach-to` is the CLI surface for the same outcome and carries the same ledger."
(`packages/cli/src/discovery/operations.ts:1428-1439`)

Reads one node-local file out of a connected project folder and records it as a `file` entity,
optionally attached to targets. The bytes never travel through a browser. Drives the **same**
`w2_*_file_upload` ledger as `files.uploadInit`/`files.uploadComplete` (init → authorize → write →
settle → complete), with the byte source swapped to a node-local read stream.

**Path params**

| name | type | description |
|---|---|---|
| `projectId` | string (UUID) | |

**Request body**

| field | type | required | constraints | description |
|---|---|---|---|---|
| `clientMutationId` | string | yes | min 1 char | root id; two derived ids drive the two upload-ledger stages |
| `spaceId` | string (UUID) | yes | | the Space the resulting `file` entity belongs to |
| `path` | string | yes | absolute, inside the project's `workingDir`, no symlink hop, not a secret path | the node-local file to read |
| `name` | string | no | min 1 char | overrides the on-disk basename |
| `mime` | string | no | min 1 char | overrides the extension-derived MIME |
| `targets` | string[] (UUID, ≤16, unique) | no | | entities to attach the resulting file to |

**Response** — 200; `data`: `CommandResult` (same shape `files.uploadComplete` returns; `entity` is
the new `file` entity detail).

**Errors**
- `not_found` (404) — no such project, or path does not exist (`ENOENT`).
- `forbidden` (403) — **node-admin required** (see Notes); path outside the project working
  directory; path is a withheld secret (`.env*`, credential file, tm8 data directory); path became
  a symlink mid-read (TOCTOU guard fired).
- `invalid_input` (400) — file is empty (0 bytes cannot be attached); upload slot is
  `aborted`/`expired`/incomplete on settlement.
- `payload_too_large` (413) — file exceeds the configured per-blob size limit.
- `upstream_unavailable` (503) — file could not be read for another reason.

**Notes** — idempotent via `clientMutationId`, split into two derived ledger stages
(`deriveMutationId(input.clientMutationId, 'files.uploadInit'|'files.uploadComplete')`). Requires
`claims.nodeAdmin` — but this handler computes `claims.nodeAdmin` narrowly as
`viewerIdentityId === owner.identityId ? owner.isNodeAdmin : false`
(`project-files-service.ts:426`), i.e. **true only for the literal node-owner/loopback identity**,
not for every account with `is_node_admin = true`. This differs from `projects.folderUploads.*`,
which explicitly reads the node-admin *authorization fact* off `requestClaims()` instead of this
narrower RLS-posture form (see that file's comment, `project-folder-uploads.ts:340-362`, which
documents fixing exactly this class of refusal there). Every access is audited
(`ProjectFileAuditEvent`, `op: 'projects.files.attach'`) on both success and refusal.
Source: catalog `packages/contract/src/catalog.ts:194`; schema
`packages/contract/src/schemas.ts:3077` (`ProjectFileAttachInputSchema`); input binding
`packages/server/src/facade/input-schemas.ts:318`; handler
`packages/server/src/facade/handlers/w2/project-files.ts:25`; service
`packages/server/src/facade/services/w2/project-files-service.ts:242-320, 415-439`;
resolve/hash logic `packages/server/src/facade/services/w2/project-files.ts:195-250`.

---

## `projects.files.read`
`GET /v2/projects/:projectId/files/content` · kind: read · status: v1 · served: yes (`packages/server/src/facade/services/w2/project-files-service.ts:187`)
CLI: none — `cmd: null`, reason `ui_project_browser_only` (same rationale as `projects.files.list`).

Reads one file inline out of a connected project folder, for a viewer. Distinct from
`projects.files.attach`: nothing is copied into the Space and no entity is minted. **Never returns
raw bytes or an inline document** — this is a "NAMED refusal" surface: `text/html` and
`image/svg+xml` are reported as `text/plain` so an inline read can never hand a UI a type it would
render as active content.

**Path params**

| name | type | description |
|---|---|---|
| `projectId` | string (UUID) | |

**Query params**

| name | type | required | default / constraints | description |
|---|---|---|---|---|
| `path` | string | yes | absolute, inside the project's `workingDir` | file to read |

**Response** — 200; `data`: `ProjectFileReadResult` (see Shared types). `content` is UTF-8 text when
the bytes decode cleanly, else base64; `truncated: true` when `sizeBytes` exceeds the inline ceiling
`MAX_INLINE_READ_BYTES = 5 MiB` and `content` is a byte-truncated prefix.

Example (illustrative, from schema):
```json
{ "data": { "projectId": "01a0...", "path": "/home/tm8/projects/befree/README.md", "name": "README.md", "mime": "text/markdown", "sizeBytes": 12345, "encoding": "utf8", "content": "# BeFree\n...", "truncated": false }, "requestId": "<redacted>" }
```

**Errors**
- `not_found` (404) — no such project; file does not exist (`ENOENT`).
- `invalid_input` (400) — `path` query parameter missing; target is not a regular file.
- `forbidden` (403) — path outside the project working directory; withheld secret path; file
  changed to a symlink mid-read (`ELOOP`/`EMLINK` — the TOCTOU race the `O_NOFOLLOW` guard exists to
  catch); not readable (`EACCES`/`EPERM`).
- `upstream_unavailable` (503) — file could not be opened/read for another reason.

**Notes** — no idempotency (read). Same visibility rule as `projects.files.list` (project must be
visible; **not** node-admin gated). TOCTOU protection: containment/secret checks run on the
`realpath`-resolved canonical path, then a single `O_NOFOLLOW` file handle is opened and held for
every subsequent read — a post-resolution symlink swap fails the open rather than silently
following the new target. Audited (`op: 'projects.files.read'`).
Source: catalog `packages/contract/src/catalog.ts:199`; contract
`packages/contract/src/contract.ts:4570-4587`; handler
`packages/server/src/facade/handlers/w2/project-files.ts:23`; service
`packages/server/src/facade/services/w2/project-files-service.ts:187-200`;
`readProjectFile` `packages/server/src/facade/services/w2/project-files.ts:271-352`.

---

## `projects.files.archive`
`GET /v2/projects/:projectId/files/archive` · kind: read (stream) · status: v1 · served: yes (`packages/server/src/facade/services/w2/project-files-service.ts:216`)
CLI: none — `cmd: null`, reason `ui_project_browser_only`: "a CLI caller already holds the node
filesystem and reaches the same bytes with `zip`/`tar`" (`packages/cli/src/discovery/operations.ts:1452-1464`).

Downloads a whole subtree of a connected project folder as one zip. The **one** project-disk read
that returns raw bytes rather than the JSON envelope — safe under the same content-type posture as
`projects.files.read` because a zip is never rendered as a document: `Content-Disposition:
attachment` is unconditional and the type is `application/zip` with `nosniff`. The full plan (every
file to include, every exclusion) is computed **before** the response headers are written, because
once headers are on the wire a refusal can only be a severed connection.

**Path params**

| name | type | description |
|---|---|---|
| `projectId` | string (UUID) | |

**Query params**

| name | type | required | default / constraints | description |
|---|---|---|---|---|
| `path` | string | no | must resolve inside the project's `workingDir` | subtree root; absent archives the whole working directory |

**Response** — 200, `Content-Type: application/zip`, streamed (chunked — the byte length is not
known up front, since STORED framing adds per-entry overhead and a late exclusion can add a
manifest entry). Headers:

| header | description |
|---|---|
| `content-disposition` | `attachment; filename="<root>.zip"; filename*=UTF-8''<encoded>` (unconditional) |
| `x-content-type-options` | `nosniff` |
| `x-tm8-archive-entries` | count of files actually included |
| `x-tm8-archive-bytes` | total uncompressed bytes planned |
| `x-tm8-archive-excluded` | count of withheld paths |
| `cache-control` | `private, no-store` |

Withheld paths (symlinks, secret files/directories, the tm8 data directory, unreadable entries,
anything that resolves outside the project during the walk) are **omitted and recorded** — never
silently dropped — listed inside the archive as `_tm8-excluded.txt`.

**Errors** (raised before streaming begins, as ordinary typed errors)
- `not_found` (404) — no such project.
- `forbidden` (403) — `path` resolves outside the project working directory.
- `payload_too_large` (413) — the subtree exceeds the archive file-count or byte-count ceiling
  (`MAX_ARCHIVE_FILES` / `MAX_ARCHIVE_BYTES`).
- `upstream_unavailable` (503) — a directory could not be listed for a reason other than
  permissions.

**Notes** — no idempotency (read). Same visibility rule as `projects.files.list` (**not**
node-admin gated). Re-establishes path containment on every directory it descends into via a fresh
`realpath` immediately before recursing — a demonstrated 5 ms rename-to-symlink race previously let
an outside file into the archive with an empty exclusion list; this closes it. A read that fails
*during* streaming (file vanished after the plan was built) becomes an exclusion-manifest note, not
a severed response. Audited (`op: 'projects.files.archive'`).
Source: catalog `packages/contract/src/catalog.ts:207`; handler
`packages/server/src/facade/handlers/w2/project-files.ts:24`; service
`packages/server/src/facade/services/w2/project-files-service.ts:216-240`;
`planProjectArchive`/`projectArchiveEntries` `packages/server/src/facade/services/w2/project-files.ts:448-582+`.

---

## `projects.folderUploads.init`
`POST /v2/spaces/:spaceId/project-folder-uploads` · kind: command · status: v1 · served: yes (`packages/server/src/facade/services/w2/project-folder-uploads.ts:126`)
CLI: none — `cmd: null`, reason `ui_project_browser_only`: "the browser-originated half of R7
folder import; a CLI caller already holds the node filesystem and links a directory as a project
directly." (`packages/cli/src/discovery/operations.ts:1465-1474`)

Freezes a browser folder-upload manifest (validated **purely**, with no filesystem access, before
any name is probed) and issues one per-file byte grant for every non-empty file, reusing the
ordinary `files.uploadInit` slot mechanism per file.

**Path params**

| name | type | description |
|---|---|---|
| `spaceId` | string (UUID) | |

**Request body**

| field | type | required | constraints | description |
|---|---|---|---|---|
| `clientMutationId` | string | yes | min 1 char | |
| `projectName` | string | yes | trimmed, 1..500 chars | |
| `destinationParent` | string | yes | min 1 char, absolute, inside an allowed browse root | server-authorized parent directory |
| `rootName` | string | yes | trimmed, 1..255 chars; not `.`/`..`; no `/`,`\`,NUL | one new child directory name |
| `trust` | `'trusted' \| 'untrusted'` | no | default `'untrusted'` | off by default: importing bytes ≠ execution trust |
| `mode` | `'create' \| 'merge'` | no | default `'create'` | `create` reserves a new root exclusively; `merge` re-uploads into an existing root, replacing matching paths |
| `entries` | array, ≤ `PROJECT_FOLDER_UPLOAD_MAX_FILES + MAX_DIRECTORIES` | yes | discriminated union, see below | the whole manifest |
| `entries[].kind` | `'directory' \| 'file'` | yes | | |
| `entries[].relativePath` | string | yes | ≤1024 bytes, no NUL, not absolute, `/`-separated, no empty/`.`/`..` segment | |
| `entries[].sizeBytes` (file only) | integer | yes | ≥0 | |
| `entries[].checksumSha256` (file only) | string | yes | lowercase sha-256 hex | |
| `entries[].mime` (file only) | string | yes | 1..255 chars | |

Example request (trimmed):
```json
{
  "clientMutationId": "<redacted>",
  "projectName": "My Import",
  "destinationParent": "/home/tm8/projects",
  "rootName": "my-import",
  "mode": "create",
  "entries": [
    { "kind": "directory", "relativePath": "src" },
    { "kind": "file", "relativePath": "src/index.ts", "sizeBytes": 1024, "checksumSha256": "<redacted>", "mime": "text/plain" }
  ]
}
```

**Response** — 200; `data`: `ProjectFolderUploadGrant`:

| field | type | description |
|---|---|---|
| `folderUploadId` | string (UUID) | |
| `expiresAt` | ISO timestamp | 15-minute TTL |
| `maxFiles`, `maxDirectories`, `maxTotalBytes`, `maxPathBytes` | number | the frozen ceilings, echoed |
| `files[].uploadId`, `.uploadUrl`, `.token`, `.expiresAt`, `.maxSizeBytes`, `.relativePath` | — | one grant per non-empty file; zero-byte files get no slot/grant |

**Errors**
- `forbidden` (403) — **node-admin required**, checked before manifest paths are ever touched;
  containment failures for `destinationParent` are also refused (as `forbidden`, via
  `requireAllowed`) before any existence probe.
- `invalid_input` (400) — malformed manifest (`normalizeProjectFolderManifest` failure); a protected
  path component; a zero-byte file with a non-empty checksum; `mode: 'merge'` but the destination
  does not exist.
- `conflict` (409) — `mode: 'create'` (or absent) but the destination already exists ("use mode
  'merge' to re-upload").
- `payload_too_large` (413) — a file exceeds the configured per-blob size limit.

**Notes** — idempotency is per-file at the `files.uploadInit` layer (each file's own
`clientMutationId` is derived internally, not supplied by the caller); the folder-upload session
itself is a JSON file under `stateDir` (mode 0600, written with the `wx` flag for atomic
create-only). Containment is checked **before** the first filesystem probe of the destination so a
refusal can never be used as an existence oracle.
Source: catalog `packages/contract/src/catalog.ts:218`; schema
`packages/contract/src/schemas.ts:2881-2905` (`ProjectFolderUploadInitInputSchema`,
`ProjectFolderRelativePathSchema`); input binding
`packages/server/src/facade/input-schemas.ts:319`; handler
`packages/server/src/facade/handlers/w2/project-folder-uploads.ts:24`; service
`packages/server/src/facade/services/w2/project-folder-uploads.ts:126-251, 363-378`.

---

## `projects.folderUploads.complete`
`POST /v2/project-folder-uploads/:folderUploadId/complete` · kind: command · status: v1 · served: yes (`packages/server/src/facade/services/w2/project-folder-uploads.ts:253`)
CLI: none — `cmd: null`, reason `ui_project_browser_only`.

Verifies every staged blob against its declared size/checksum, materializes the tree under the
server-authorized destination, creates-or-reuses the `ProjectResource`, links it into the Space, and
only then releases staging.

**Path params**

| name | type | description |
|---|---|---|
| `folderUploadId` | string (UUID) | |

**Request body**

| field | type | required | constraints | description |
|---|---|---|---|---|
| `clientMutationId` | string | yes | min 1 char | |
| `actorId`, `workSessionId` | string (UUID) | no | | |

**Response** — 200; `data`: `ProjectFolderUploadResult`:

| field | type | description |
|---|---|---|
| `folderUploadId` | string (UUID) | |
| `spaceId` | string (UUID) | |
| `project` | `ProjectResource` | the created-or-reused project |
| `rootName` | string | |
| `fileCount`, `directoryCount`, `totalBytes` | number | |
| `replacedCount` | number | files replaced in place; always 0 for `mode: 'create'` |

**Errors**
- `not_found` (404) — no such folder upload (state file absent) — same code whether it never
  existed, already completed/aborted, or belongs to a different node process.
- `forbidden` (403) — **node-admin required** (checked before the session is even looked up, so a
  non-admin cannot probe which `folderUploadId`s exist); the upload session belongs to a different
  identity.
- `invalid_input` (400) — the folder upload has expired; a staged blob's bytes are incomplete or do
  not match the declared size/checksum; the materializer itself failed (its own message is
  surfaced, staging survives so the caller can retry or abort).

**Notes** — idempotent via `clientMutationId` (the RPC layer's ledger applies to the
`link_project_w2` call this makes). On any failure the materializer already rolls back what it
created; the session and staged slots survive so the operation can be retried or explicitly
aborted. `mode: 'merge'` reuses the project already anchored at the resolved working directory;
`mode: 'create'` refuses to reuse one.
Source: catalog `packages/contract/src/catalog.ts:219`; schema
`packages/contract/src/schemas.ts:2917` (`ProjectFolderUploadCompleteInputSchema`); input binding
`packages/server/src/facade/input-schemas.ts:320`; handler
`packages/server/src/facade/handlers/w2/project-folder-uploads.ts:25`; service
`packages/server/src/facade/services/w2/project-folder-uploads.ts:253-330, 398+`.

---

## `projects.folderUploads.abort`
`POST /v2/project-folder-uploads/:folderUploadId/abort` · kind: command · status: v1 · served: yes (`packages/server/src/facade/services/w2/project-folder-uploads.ts:331`)
CLI: none — `cmd: null`, reason `ui_project_browser_only`.

Aborts a pending folder upload and releases its staged bytes; nothing was materialized yet.

**Path params**

| name | type | description |
|---|---|---|
| `folderUploadId` | string (UUID) | |

**Request body**

| field | type | required | constraints | description |
|---|---|---|---|---|
| `clientMutationId` | string | yes | min 1 char | |
| `actorId`, `workSessionId` | string (UUID) | no | | |

**Response** — 200; `data`: `CommandResult` with `patches: []`.

**Errors**
- `not_found` (404) — no such folder upload.
- `forbidden` (403) — node-admin required; session belongs to a different identity.

**Notes** — releases every staged slot and the frozen manifest. Staged blobs never outlive the
session — every terminal path (`complete`, `abort`, or expiry) removes them.
Source: catalog `packages/contract/src/catalog.ts:220`; schema
`packages/contract/src/schemas.ts:2921` (`ProjectFolderUploadAbortInputSchema`); input binding
`packages/server/src/facade/input-schemas.ts:321`; handler
`packages/server/src/facade/handlers/w2/project-folder-uploads.ts:26`; service
`packages/server/src/facade/services/w2/project-folder-uploads.ts:331-338`.

---

## `files.uploadInit`
`POST /v2/files/uploads` · kind: command · status: v1 · served: yes (`packages/server/src/facade/services/w2/files.ts:224`)
CLI: `tm8 file upload <path|-> [--space <space-id>] [--name <name>] [--mime <mime-type>] [--attach-to <entity-id>...] [--size <bytes>] [--sha256 <lowercase-hex>] [--mutation-id <id>]`
— `file upload` is a composition over `uploadInit` + the raw PUT transfer + `uploadComplete`; each
stage derives its own mutation id from the caller root.

Begins a Space-scoped blob upload: reserves a slot and returns a grant. The declared size/checksum
are re-verified at `uploadComplete`, not trusted here.

**Request body**

| field | type | required | constraints | description |
|---|---|---|---|---|
| `spaceId` | string (UUID) | yes | | |
| `name` | string | yes | 1..500 chars, trimmed non-empty | |
| `mime` | string | yes | ≤255 chars, no control chars | |
| `sizeBytes` | integer | yes | positive, ≤ effective deployment ceiling (`FILE_MAX_SIZE_BYTES_DEFAULT = 512 MiB` by default) | |
| `checksumSha256` | string | yes | lowercase sha-256 hex | |
| `entityId` | string (UUID) \| null | no | | on complete, the file is `attached_to` this entity |
| `actorId`, `clientMutationId`, `workSessionId` | — | no | command context | |

**Response** — 200; `data`: `FileUploadGrant`:

| field | type | description |
|---|---|---|
| `uploadId` | string (UUID) | |
| `uploadUrl` | string | `/v2/files/uploads/:uploadId/content` — PUT target |
| `token` | string \| null | grant token; send as `x-tm8-upload-token` on the PUT |
| `expiresAt` | ISO timestamp | 15-minute TTL |
| `maxSizeBytes` | number | effective ceiling |

**Errors**
- `unauthenticated` (401) — anonymous caller, or a bearer identity that failed to resolve.
- `invalid_input` (400) — name empty/too long; MIME invalid or too long; `sizeBytes` not a positive
  safe integer.
- `payload_too_large` (413) — `sizeBytes` exceeds the effective ceiling.

**Notes** — idempotent via `clientMutationId`: a replay returns the **original** upload id, and the
grant token is re-derived deterministically from that id and a data-directory-private key (never
stored in Postgres in plaintext), so the replay is byte-for-byte the same grant. RPC:
`w2_init_file_upload`. The raw byte transfer itself (`PUT /v2/files/uploads/:uploadId/content`) is a
separate, non-catalog route (`packages/server/src/http/w2-file-upload.ts`) authorized by the grant
token in `x-tm8-upload-token` (falling back to a legacy `Authorization: Bearer <token>` **only**
when it is not a tm8 session token — a session token in that header is refused as
`unauthenticated` rather than misread as a grant).
Source: catalog `packages/contract/src/catalog.ts:223`; schema
`packages/contract/src/schemas.ts:3120` (`FileUploadInitInputSchema`); input binding
`packages/server/src/facade/input-schemas.ts:344`; handler
`packages/server/src/facade/handlers/w2/files.ts:22`; service
`packages/server/src/facade/services/w2/files.ts:224-272`.

---

## `files.uploadComplete`
`POST /v2/files/uploads/:uploadId/complete` · kind: command · status: v1 · served: yes (`packages/server/src/facade/services/w2/files.ts:274`)
CLI: `tm8 file upload <path|-> [--attach-to <entity-id>...] [--mutation-id <id>]` (second stage of
the same composed command)

Re-verifies the staged blob's size and checksum, then creates the `file` entity and its requested
attachment edges in one transaction.

**Path params**

| name | type | description |
|---|---|---|
| `uploadId` | string (UUID) | |

**Request body**

| field | type | required | constraints | description |
|---|---|---|---|---|
| `clientMutationId` | string | yes | min 1 char | |
| `targets` | string[] (UUID, ≤16, unique) | no | | entities to attach the file to, created atomically |
| `actorId`, `workSessionId` | — | no | command context | |

**Response** — 200; `data`: `CommandResult` (`entity` is the new `file` entity's detail).

**Errors**
- `not_found` (404) — no such upload slot.
- `invalid_input` (400) — bytes not yet fully staged (`staged_at`/size/checksum missing on the slot,
  and the slot's own expiry has not yet passed); upload slot has expired (bytes are removed from the
  blob store as part of this response); upload slot was aborted (bytes removed); slot in any other
  non-completable state.

**Notes** — idempotent via `clientMutationId` — a completed slot's ledger entry replays rather than
re-executing. RPC: `w2_complete_file_upload`, run inside a transaction alongside `toCommandResult`.
Source: catalog `packages/contract/src/catalog.ts:224`; schema
`packages/contract/src/schemas.ts:3139` (`FileUploadCompleteInputSchema`); input binding
`packages/server/src/facade/input-schemas.ts:345`; handler
`packages/server/src/facade/handlers/w2/files.ts:23`; service
`packages/server/src/facade/services/w2/files.ts:274-326`.

---

## `files.uploadAbort`
`POST /v2/files/uploads/:uploadId/abort` · kind: command · status: v1 · served: yes (`packages/server/src/facade/services/w2/files.ts:328`)
CLI: `tm8 file upload abort <upload-id> --yes [--mutation-id <id>]` — also invoked automatically by
`tm8 file upload` on a recoverable failure.

Abandons an in-flight upload and releases its slot/staged bytes.

**Path params**

| name | type | description |
|---|---|---|
| `uploadId` | string (UUID) | |

**Request body** — bare `CommandContext` (`FileUploadAbortInput = CommandContext`):

| field | type | required | description |
|---|---|---|---|
| `clientMutationId` | string | no (but effectively required for idempotency) | |
| `actorId`, `workSessionId` | string (UUID) | no | |

**Response** — 200; `data`: `CommandResult` with `patches: []`.

**Errors** — none beyond the standard authentication/RPC-surfaced errors; aborting an
already-completed/aborted/expired slot is handled by outcome, not by throwing (bytes are removed
from the blob store unless the outcome is `completed`).

**Notes** — RPC: `w2_abort_file_upload`.
Source: catalog `packages/contract/src/catalog.ts:225`; schema
`packages/contract/src/schemas.ts:3144` (`FileUploadAbortInputSchema = CommandContextSchema`);
input binding `packages/server/src/facade/input-schemas.ts:346`; handler
`packages/server/src/facade/handlers/w2/files.ts:24`; service
`packages/server/src/facade/services/w2/files.ts:328-339`.

---

## `files.download`
`GET /v2/files/:fileEntityId/download` · kind: read (stream) · status: v1 · served: yes (`packages/server/src/facade/services/w2/files.ts:341`)
CLI: `tm8 file download <file-entity-id> --output <path|-> [--overwrite]` — answers with raw bytes,
so it is mutually exclusive with `--format json`.

The authorized, entity-scoped byte stream for a `file` entity. **Not** the `{data, requestId}`
JSON envelope — this is the one catalog read that returns raw bytes directly, with full
conditional-request (`ETag`/`If-None-Match`) and byte-range (`Range`/`If-Range`, 206/416) support.

**Path params**

| name | type | description |
|---|---|---|
| `fileEntityId` | string (UUID) | |

**Request headers** (all optional)

| header | effect |
|---|---|
| `If-None-Match` | strong-compared against the blob's `sha256-<hex>` ETag; a match returns 304 with no body |
| `Range` | single `bytes=start-end`/`bytes=start-`/`bytes=-suffix` form; other shapes are ignored (whole file served) |
| `If-Range` | must equal the current ETag or the `Range` is ignored (serves the whole file) |

**Response** — 200 (whole file) / 206 (partial) / 304 (not modified) / 416 (range not satisfiable).
Headers on every non-304 response:

| header | description |
|---|---|
| `content-type` | the file's stored MIME (or `application/octet-stream` if it fails the same safety check as everywhere else) |
| `content-disposition` | `inline` for image/audio/video (excluding SVG), else `attachment`; ASCII fallback + RFC 5987 UTF-8 filename |
| `x-content-type-options` | `nosniff` |
| `x-tm8-checksum-sha256`, `digest` | the stored sha-256, hex and RFC 3230 base64 forms |
| `accept-ranges` | `bytes` |
| `cache-control` | `private, no-cache` (content-addressed by the ETag, so revalidation is free) |
| `content-length` | declared size (200) or range span (206) |
| `content-range` | `bytes start-end/total` (206 and 416) |

**Errors**
- `not_found` (404) — no such file entity, soft-deleted, or the stored blob has no checksum
  recorded (never fully uploaded).
- `upstream_unavailable` (503) — the stored blob's actual size does not match its recorded metadata
  (a cheap `stat` guard, run without buffering the whole file).

**Notes** — no idempotency (read). Content-addressed by the checksum ETag, so a `304` never needs to
re-read the blob. `bridge.fetchBlob` (cross-node blob fetch) is a separate, **reserved** operation
that always answers `501` — not part of this group's 23 operations.
Source: catalog `packages/contract/src/catalog.ts:226`; contract
`packages/contract/src/contract.ts:6114-6120`; handler
`packages/server/src/facade/handlers/w2/files.ts:25`; service
`packages/server/src/facade/services/w2/files.ts:341-410`.

---

## `projects.associations.correct`
`POST /v2/entities/:artifactId/commands/correct-project-association` · kind: command · status: v1 · served: yes (`packages/server/src/facade/services/w2/projects-associations.ts:719`)
CLI: `tm8 project association correct <artifact-entity-id> --project <project-resource-id|none> --expect-version <n> [--mutation-id <id>]`

Corrects the `ProjectResource` a pull request or commit artifact was attributed to, under an
artifact-version guard. Owner/admin-only inverse for PR/commit materialization — intentionally not a
generic edge-repair command. A purely materialized `in_project` association is **removed**; a
promoted (user-set) association with a frozen prior origin is **demoted** back to it; anything else
is `unchanged`.

**Path params**

| name | type | description |
|---|---|---|
| `artifactId` | string (UUID) | a live `pull_request` or `commit` entity |

**Request body**

| field | type | required | constraints | description |
|---|---|---|---|---|
| `clientMutationId` | string | yes | min 1 char | |
| `projectId` | string (UUID) | yes | | the `ProjectResource` the artifact should (not) be associated with |
| `expectedArtifactVersion` | integer | yes | positive | guards the **artifact's** version, not the `ProjectResource`'s — the CLI's `--expect-version` flag carries this field |

Note: `CorrectProjectAssociationInput` does **not** extend `CommandContext` — it has no
`actorId`/`workSessionId` fields.

**Response** — 200; `data`: `EdgeCorrectionResult` (see Shared types).
Example (illustrative, from schema):
```json
{ "data": { "artifactId": "01a0...", "projectId": "01a025f4-5c82-7b57-836d-cdc82c9d3d45", "outcome": "removed", "edge": null }, "requestId": "<redacted>" }
```

**Errors**
- `not_found` (404) — `P0002`: project not found; artifact not found, soft-deleted, or not a
  `pull_request`/`commit`.
- `forbidden` (403) — caller is not a Space admin (`internal.require_space_admin` on the artifact's
  Space).
- `version_conflict` (409) — `expectedArtifactVersion` does not match the artifact's current version
  (`internal.assert_version`).
- `invariant_violation` (409) — `23514`, `details.reason: "project_not_linked"`: the named project
  is not actively linked to the artifact's Space (no live `project_links` → active `space_projects`
  → non-deleted projection entity → `project_projection_details` join).

`unverified:` I looked for a `project_association_cap`/`project_over_cap` (`53400`) raise
**inside `correct_project_association`'s own SQL body** (`db/migrations/021_w2_projects.sql:384-476`)
to confirm whether those reasons — which the shared `normalizeFrozenProjectReason` helper
(`projects-associations.ts:158-171`) is written to recognize for **all four** of
`update`/`link`/`unlink`/`associations.correct` — are actually reachable from this specific RPC. I
did not find such a raise in this function's body; only `update_project_w2` and `link_project_w2`
raise it directly. I am not asserting it is unreachable here (a shared trigger elsewhere could still
produce it), only that I could not confirm it from this function's own SQL.

**Notes** — idempotent via `clientMutationId` (RPC `correct_project_association`, run inside
`deps.db.tx`). Side effects: on `removed`/`demoted`, records an `unlinked` activity row and emits a
`project.association.corrected` workspace event.
Source: catalog `packages/contract/src/catalog.ts:324`; schema
`packages/contract/src/schemas.ts:3101` (`CorrectProjectAssociationInputSchema`); input binding
`packages/server/src/facade/input-schemas.ts:317`; handler
`packages/server/src/facade/handlers/w2/projects-associations.ts:23`; service
`packages/server/src/facade/services/w2/projects-associations.ts:719-742, 158-171`;
RPC `db/migrations/021_w2_projects.sql:384-476`.
