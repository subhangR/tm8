# Artifacts, tracking, voice, bridge

This family is four unrelated capabilities that share nothing but a place in the
catalog. `tracking.*` re-polls external forge state (GitHub PRs/commits already linked
into the graph) and performs the one write door onto the forge itself
(`tracking.pr.merge`) under the acting member's own stored credential, guarded by
observed facts (open, mergeable, CI not red) before any network call. `bridge.fetchBlob`
is a cross-node blob-fetch path for a future asymmetric-bridge design; it is catalogued
and permanently `reserved`, with no handler on any node. `voice.token.create` mints a
short-lived LiveKit room-join grant for one `voice_channel` entity — audio never
touches tm8-server, only the signed token does. `artifacts.*` is the versioned,
viewable static-web bundle feature (TM8-ARTIFACTS-DESIGN §8.1): an artifact entity's
identity is its manifest (a strict, model-agnostic file list), each publish is an
append-only revision, and `preview.start`/`export` serve the bytes back out as a
short-lived iframe capability or a deterministic zip.

## Summary

| name | method | path | kind | served |
|---|---|---|---|---|
| `tracking.refresh` | POST | `/v2/tracking/refresh` | command | yes |
| `tracking.pr.merge` | POST | `/v2/tracking/pr/:id/merge` | command | yes |
| `bridge.fetchBlob` | GET | `/v2/bridge/blobs/:fileEntityId` | read | no (501, reserved) |
| `voice.token.create` | POST | `/v2/entities/:id/commands/voice-token` | command | yes, conditional (see Notes) |
| `artifacts.create` | POST | `/v2/artifacts` | command | yes |
| `artifacts.publish` | POST | `/v2/artifacts/:artifactId/revisions` | command | yes |
| `artifacts.revisions.list` | GET | `/v2/artifacts/:artifactId/revisions` | read | yes |
| `artifacts.preview.start` | POST | `/v2/artifacts/:artifactId/preview-sessions` | command | yes |
| `artifacts.export` | GET | `/v2/artifacts/:artifactId/revisions/:revisionNumber/export` | read | yes |
| `artifacts.restore` | POST | `/v2/artifacts/:artifactId/commands/restore-revision` | command | yes |

Source: `packages/contract/src/catalog.ts:144` (tracking.refresh), `:147`
(tracking.pr.merge), `:228` (bridge.fetchBlob), `:318` (voice.token.create),
`:345-350` (artifacts.*).

## Shared types

**`CommandContext`** (`packages/contract/src/contract.ts:1698`, zod shape
`commandContextShape` at `packages/contract/src/schemas.ts:1662`) — embedded in every
command input below: `actorId?: EntityId` (impersonated actor), `clientMutationId?:
string` (idempotency key consumed by the command ledger; each RPC below declares
whether it is required), `workSessionId?: EntityId` (originating session).

**`CommandResult`** (`contract.ts:1687`) — the response shape of `artifacts.create`,
`artifacts.publish` and `artifacts.restore`:

| field | type | description |
|---|---|---|
| `entity` | `EntityDetail` \| absent | the artifact, in the same universal shape `entities.get` returns (defined in full in the entities reference; `content` is narrowed to `kind: 'artifact'` below) |
| `patches` | `EntitySummary[]` | other rows the RPC touched, refreshed |
| `edge` | `EdgeView` \| absent | not used by these three ops |
| `undo` | `{token, label, expiresAt?}` \| absent | not used by these three ops |
| `warnings` | `ResultWarning[]` \| absent | e.g. a supplied `header` the server could not store |

An artifact's `EntitySummary.state` is `{ kind: 'artifact', revisionNumber }`
(`contract.ts:461`); its `EntityDetail.content` is `{ kind: 'artifact', description,
currentRevisionNumber, entrypoint, manifestSha256, fileCount, totalSizeBytes }`
(`contract.ts:802-803`) — the CURRENT revision projected onto the entity row. Bundle
bytes are never in either; they are served only through `artifacts.export` and a
preview session.

**`ArtifactManifest`** (`packages/contract/src/artifact-manifest.ts:80`, schema
`ArtifactManifestSchema` at `:151`) — the strict, model-agnostic bundle descriptor and
the artifact's sole identity (§4): `{ schema: 'tm8.web-artifact/1', runtime:
'web-static-v1', entrypoint: string, files: ArtifactManifestFile[] }`. Each
`ArtifactManifestFile` (`:73`) is `{ path, mediaType, size, sha256 }`. Validated
server-side (never trusted from the wire) with these invariants:

- 1–128 files, ≤25 MiB total, ≤8 MiB per file, path ≤1024 UTF-8 bytes, path segment
  ≤255 bytes (`ARTIFACT_MAX_FILES`/`ARTIFACT_MAX_TOTAL_BYTES`/`ARTIFACT_MAX_FILE_BYTES`/
  `ARTIFACT_MAX_PATH_BYTES`/`ARTIFACT_MAX_SEGMENT_BYTES`, `:62-66`).
- `path` must be relative, Unicode NFC, no backslash, no `.`/`..` segment, no segment
  starting with `.`, no control characters (`artifactPathError`, `:97-118`).
- `mediaType` is one of a closed 14-value allowlist (`ARTIFACT_MEDIA_TYPES`, `:38-52`);
  an unlisted extension is refused rather than guessed.
- `files` must arrive pre-sorted ascending by the UTF-8 byte sequence of `path`, with
  no exact or ASCII-case-folded duplicate path (`:171-207`), and `entrypoint` must name
  one of the files (`:208-213`).
- The manifest hash (`manifestSha256`, `:427`) is SHA-256 of the RFC 8785 JCS
  canonical bytes of the manifest — recomputed server-side on every create/publish,
  never carried on the wire as a field.

**`ArtifactInlineFile`** (`artifact-manifest.ts:378`) — `{ path, contentBase64 }`, an
optional array (1–128 entries) riding `artifacts.create`/`.publish`/(via restore's
re-publish) for manifest entries whose bytes are not already registered in the space's
blob store; the server decodes, hashes and size-checks each one against its manifest
entry before staging it (`invalid_input` on mismatch).

**`sourceProvenance`** (interface `SourceProvenance`,
`packages/server/src/facade/services/w2/artifacts.ts:58`) — built entirely
server-side and returned on each revision row: `{ schemaVersion: 1, publishedAt,
spaceId, sourceWorkSessionId, launchProjectId: null, associatedProjectIds: [],
project: null, worktree: null, build: null }`. Every key is always present; a fact this
Phase-1 slice cannot honestly supply is `null`/`[]`, never omitted or invented.

**`VoiceTokenGrant`** (`contract.ts:5469`, schema `VoiceTokenGrantSchema` at
`schemas.ts:3470`) — `{ voiceChannelId, url, token, roomName, identity, expiresAt }`.
`token` is an HS256 LiveKit access token; `url` is the LiveKit `ws(s)://` signalling
URL the client connects to directly.

**`TrackingPrMergeResult`** (`contract.ts:2807`) — `{ entityId, repo, number, merged:
true, mergeSha }`.

**Error envelope** — every non-2xx response is `{ error: { code, message, details?,
requestId, retryable } }`, HTTP status from `ERROR_STATUS[code]` (`contract.ts:1628`,
mapping applied in `packages/server/src/http/errors.ts:83-116`). A `CollabError`
thrown by a handler carries its own `details`; a raw Postgres error surfacing from an
RPC is translated by SQLSTATE alone (`packages/server/src/db/errors.ts`, table at
`http/errors.ts:34-63`) into `details: { sqlstate, ...parsed-DETAIL }` — e.g. a
`22023` (`invalid_input`) from the artifact RPCs carries `details.detail` set to
`unknown_blob` / `size_mismatch` / `entrypoint_missing`, and a `40001`
(`version_conflict`) carries `details.entityId` / `details.currentVersion` (parsed
from the RPC's DETAIL text, `db/migrations/007_rpc_catalog.sql:69-83` /
`014_assert_version_locks.sql:60-68`). A malformed uuid in a path param answers
`not_found`, not `invalid_input` (`requireUuidParam`,
`packages/server/src/facade/context.ts:117-133`).

---

### `tracking.refresh`
`POST /v2/tracking/refresh` · kind: command · status: v1 · served: yes
(`packages/server/src/facade/services/w2/entities-commands-tracking.ts:2179`,
registered at `packages/server/src/facade/handlers/w2/entities-commands-tracking.ts:46`)
CLI: `tm8 tracking refresh [entityId...]` (`packages/cli/src/commands/tracking.ts:41`)

Queues an async provider-refresh (GitHub) for `pull_request`/`commit` entities. Fans
out to **every Space the caller belongs to**: with no `entityIds`, one queued request
per Space; with `entityIds`, only Spaces containing at least one named entity.

**Request body** — `TrackingRefreshInput` (`contract.ts:2791`, schema
`TrackingRefreshInputSchema` at `schemas.ts:2585`)

| field | type | required | constraints | description |
|---|---|---|---|---|
| `actorId` | uuid | no | | impersonated actor |
| `clientMutationId` | string | no | | idempotency key (ledger replay keyed on this) |
| `workSessionId` | uuid | no | | originating session |
| `entityIds` | uuid[] | no | must be `pull_request`/`commit` kind, readable | omitted = "everything this actor tracks"; `[]` is a *different* request from omitted |

Example: `{"entityIds": ["<pull-request-entity-id>"], "clientMutationId": "<uuid>"}`

**Response** — 202 (`json(..., {status: 202})` at
`entities-commands-tracking.ts:46`); `data` is the raw RPC result of
`public.queue_tracking_refresh` (`db/migrations/034_w2_g02fix_tracking_refresh_actor_binding.sql:107-153`,
superseding `017_w2_entities_commands_tracking.sql:627`):

| field | type | description |
|---|---|---|
| `accepted` | boolean | always `true` on success |
| `status` | string | `"queued"` |
| `requestIds` | uuid[] | one `tracking_refresh_requests.id` per Space queued |

```json
{"data": {"accepted": true, "status": "queued", "requestIds": ["<uuid>"]}, "requestId": "<redacted>"}
```
(illustrative, from schema — this is a command; no example was captured)

**Errors** — `not_found` (P0002, 400→404 mapping N/A — see table): a named entity
isn't `pull_request`/`commit`, is deleted, or the caller cannot see its Space.
`forbidden` (42501): the caller belongs to no readable Space (`no readable Space to
refresh`) — this is also the code an acting-as actor gets the moment the fan-out
reaches a Space it cannot act in.
**Notes**: idempotency via `clientMutationId` (ledger replay returns the original
`requestIds`, not a fresh queue). **Known live defect**, deliberately not worked
around by the CLI: an ordinary (non-acting-as) caller who belongs to 2+ Spaces was
refused with 403 before migration 034 restored per-iteration actor state; 034 fixes
the ordinary-caller path, but the CLI's own comment
(`packages/cli/src/commands/tracking.ts:10-17`) still documents the class of defect
and refuses to paper over a future recurrence. Side effect: one row inserted per
Space into `tracking_refresh_requests`; the observer worker (not part of this op)
does the actual GitHub polling asynchronously.
Source: `entities-commands-tracking.ts:2179-2186`; RPC at
`034_w2_g02fix_tracking_refresh_actor_binding.sql:107`.

---

### `tracking.pr.merge`
`POST /v2/tracking/pr/:id/merge` · kind: command · status: v1 · served: yes
(`packages/server/src/facade/services/w2/tracking-write.ts:66`, registered at
`entities-commands-tracking.ts:48`)
CLI: `tm8 pr merge <pull-request-entity-id> [--head] [--title]`
(`packages/cli/src/commands/tracking.ts:74`)

The one forge WRITE door. Refuses BEFORE any GitHub call unless the **stored, observed**
row says the PR is `open`, not `dirty` (mergeable), and CI is not `failing` — the same
facts a human reviewed in the UI, not a fresh re-read. Merges using the acting
member's OWN stored GitHub credential (`read_account_git_credential`, resolved under
the caller's claims), so a node token can never merge and every merge is attributable.
After a successful merge it queues `tracking.refresh`'s RPC to close the loop
(`apply_pull_request_facts` will later project `merged` from the observer).

**Path params**

| name | type | description |
|---|---|---|
| `id` | uuid | the `pull_request` entity id |

**Request body** — `TrackingPrMergeInput` (`contract.ts:2801`, schema
`TrackingPrMergeInputSchema` at `schemas.ts:2590`)

| field | type | required | constraints | description |
|---|---|---|---|---|
| `actorId` | uuid | no | | impersonated actor |
| `clientMutationId` | string | yes | min 1 | idempotency key |
| `workSessionId` | uuid | no | | originating session |
| `headSha` | string | no | min 1 | pins the merge to this head; defaults to the OBSERVED `head_sha` — never an unpinned merge |
| `commitTitle` | string | no | 1–200 chars | merge commit title override |

```json
{"clientMutationId": "<uuid>", "commitTitle": "Merge #42"}
```

**Response** — 200; `data: TrackingPrMergeResult`

| field | type | description |
|---|---|---|
| `entityId` | uuid | the `pull_request` entity |
| `repo` | string | `owner/repo` |
| `number` | int | PR number |
| `merged` | `true` | literal |
| `mergeSha` | string | the merge commit the forge created |

```json
{"data": {"entityId": "<uuid>", "repo": "org/repo", "number": 42, "merged": true, "mergeSha": "<redacted>"}, "requestId": "<redacted>"}
```
(illustrative — this is a command; never run to capture a real example)

**Errors** (`packages/server/src/facade/services/w2/tracking-write.ts:81-135`):
- `not_found` — no `pull_request` entity `id` (`details.reason` not set; plain message).
- `invariant_violation` (409) — `details.reason: 'not_open'` (state is `merged`/`closed`/`draft`),
  `'conflicted'` (`mergeable_state = 'dirty'`), or `'ci_red'` (`ci_status = 'failing'`).
- `forbidden` (403) — `details.reason: 'no_github_credential'` (no stored GitHub
  credential for the acting member) or GitHub itself refused the credential
  (`outcome.reason === 'unauthorized'`, no `details.reason`).
- `invariant_violation` — `details.reason: 'forge_blocked'` when GitHub's branch
  protection refuses the merge method.
- `conflict` (409) — `details.reason: 'head_moved'` when the branch moved past
  `headSha`/the observed head since review.
- `rate_limited` (429) / `upstream_unavailable` (503) — GitHub rate limit or other
  upstream failure.
**Notes**: idempotency via required `clientMutationId`. Auth: acting member must have
a GitHub credential stored under Settings → Agent credentials
(`DbGitHubCredentialStore`). Side effect: on success, queues a tracking refresh
(`queue_tracking_refresh`) with the acting actor recorded, which later emits
`git.pr_state_changed` into the ledger via the observer.
Source: `tracking-write.ts:1-151`.

---

### `bridge.fetchBlob`
`GET /v2/bridge/blobs/:fileEntityId` · kind: read · status: reserved · served: no
(answers 501 not_implemented)
CLI: none — deliberately no command; discoverable only via `tm8 help --operation
bridge.fetchBlob` (`packages/cli/src/commands/search.ts:1-20`,
`packages/cli/src/commands/file.ts:40-43`)

A cross-node blob fetch over an asymmetric bridge (Phase 2, not built). The catalog
comment at `packages/contract/src/catalog.ts:227` calls it "honest 501 (DEV-13)": it
is `reserved`, and `HandlerRegistry.register` throws if any code ever tries to bind a
handler to a reserved operation (`packages/server/src/facade/registry.ts:30-48`), so
this cannot be silently implemented without a contract amendment. No handler is
registered anywhere in `packages/server/src`; every request lands on the router's
`notImplemented(opName)` (`packages/server/src/http/server.ts:427-428`,
`packages/server/src/http/errors.ts:184-188`).

**Path params** — `fileEntityId` (uuid): unverified beyond the catalog path — no
handler exists to document request/response shape further.

**Response** — 501; `{ "error": { "code": "not_implemented", "message": "operation
bridge.fetchBlob is not implemented on this node", "requestId": "<redacted>",
"retryable": false } }`.
**Errors** — `not_implemented` (501), always.
**Notes**: it is a Server-to-Server path (no caller should invoke it), and the CLI's
`file download` is the caller-facing way to read blob bytes today.
Source: `packages/contract/src/catalog.ts:228`; refusal mechanics at
`packages/server/src/facade/registry.ts:16-48` and
`packages/server/src/http/server.ts:427`.

---

### `voice.token.create`
`POST /v2/entities/:id/commands/voice-token` · kind: command · status: v1 · served:
yes, conditional — registered on every node, but refuses `not_implemented` when
LiveKit env vars are unset (`packages/server/src/facade/services/voice.ts:70-81`)
CLI: `tm8 voice token <voice-channel-id>` (`packages/cli/src/commands/voice.ts:41`)

Mints a short-lived LiveKit access token (room-join grant) scoped to one
`voice_channel` entity; audio never touches tm8-server. **The authorization is the
query**: the resolving SQL joins the channel to the caller's own membership row under
`set local role tm8_app` (so RLS decides), and a row that does not come back is
treated identically for "no such channel" and "not your Space" (avoids an existence
oracle).

**Path params**

| name | type | description |
|---|---|---|
| `id` | uuid | the `voice_channel` entity id |

**Request body** — `CreateVoiceTokenInput` = `CommandContext` (`contract.ts:5466`,
schema `CreateVoiceTokenInputSchema` at `schemas.ts:3466`) — `actorId?`,
`clientMutationId?`, `workSessionId?`, all optional; no voice-specific fields.

```json
{"clientMutationId": "<uuid>"}
```

**Response** — 200; `data: VoiceTokenGrant`

| field | type | description |
|---|---|---|
| `voiceChannelId` | uuid | echoes the path param |
| `url` | string | LiveKit `ws(s)://` signalling URL |
| `token` | string | HS256 LiveKit access token |
| `roomName` | string | == `voiceChannelId` (room name IS the entity id) |
| `identity` | string | caller's MEMBER entity id in this space (not account/identity id) |
| `expiresAt` | ISO timestamp | grant expiry |

```json
{"data": {"voiceChannelId": "<uuid>", "url": "wss://<redacted>", "token": "<redacted>",
  "roomName": "<uuid>", "identity": "<uuid>", "expiresAt": "2026-09-25T00:10:00.000Z"}, "requestId": "<redacted>"}
```
(illustrative — this is a command; never run to capture a real example)

**Errors**:
- `not_implemented` (501) — LiveKit is unconfigured on this node (`TM8_LIVEKIT_URL`,
  `TM8_LIVEKIT_API_KEY`, `TM8_LIVEKIT_API_SECRET` unset), checked BEFORE any database
  call (`voice.ts:74-81`).
- `invalid_input` (400) — the `:id` path param is missing/empty (a malformed uuid
  falls through to `not_found` per the general path-param rule, though this handler's
  own check only guards emptiness).
- `not_found` (404) — no readable `voice_channel` at `id`, OR the caller has no
  member row in that channel's Space (same answer for both, by design).
**Notes**: no `expectedVersion` (not a versioned entity op here). Idempotency:
`clientMutationId` accepted but unused by this handler (no ledger write — token
minting is not itself an idempotent RPC). No side effects recorded in the graph; the
token is never stored server-side.
Source: `packages/server/src/facade/services/voice.ts:1-123`; LiveKit env vars parsed
at `packages/server/src/http/config.ts:818-831`.

---

### `artifacts.create`
`POST /v2/artifacts` · kind: command · status: v1 · served: yes
(`packages/server/src/facade/services/w2/artifacts.ts:234`, registered at
`packages/server/src/facade/handlers/w2/artifacts.ts:23`)
CLI: `tm8 artifact publish <dir>` (no `--artifact`/`--expect-version`) — a COMPOSED
command that builds the manifest from a directory and calls this op
(`packages/cli/src/commands/artifact.ts:312-377`)

Creates a new `artifact` entity with its first bundle revision (revision 1),
atomically — there is no draft state. The manifest hash is recomputed server-side
from the (optionally inline-supplied) bytes, never trusted from the client.

**Request body** — `ArtifactsCreateInput` (`artifact-manifest.ts:384`, schema
`ArtifactsCreateInputSchema` at `schemas.ts:2350`)

| field | type | required | constraints | description |
|---|---|---|---|---|
| `actorId` | uuid | no | | impersonated actor |
| `clientMutationId` | string | yes | min 1 | idempotency key |
| `workSessionId` | uuid | no | | originating session |
| `spaceId` | uuid | yes | | Space the artifact belongs to |
| `name` | string | yes | trimmed, 1–200 chars | |
| `description` | string | no | ≤2000 chars | |
| `manifest` | `ArtifactManifest` | yes | see Shared types | the bundle descriptor |
| `files` | `ArtifactInlineFile[]` | no | 1–128 entries | inline bytes for manifest entries not already in the space's blob store |
| `sourceWorkSessionId` | uuid \| null | no | | provenance: session that produced the bundle |
| `parentId` | uuid \| null | no | | parent entity in the hierarchy |
| `position` | number | no | | sort position among siblings |
| `header.whenToUse` / `.summary` / `.keywords` | string\|null / string\|null / string[] | no | | authored selection header, written in the same transaction |

```json
{"clientMutationId": "<uuid>", "spaceId": "<uuid>", "name": "dashboard",
 "manifest": {"schema": "tm8.web-artifact/1", "runtime": "web-static-v1",
   "entrypoint": "index.html",
   "files": [{"path": "index.html", "mediaType": "text/html", "size": 128, "sha256": "<64-hex>"}]},
 "files": [{"path": "index.html", "contentBase64": "<base64>"}]}
```

**Response** — 200; `data: CommandResult` (see Shared types) with `entity` = the new
artifact's `EntityDetail` (`content.kind: 'artifact'`, `currentRevisionNumber: 1`).

```json
{"data": {"entity": {"id": "<uuid>", "kind": "artifact",
  "state": {"kind": "artifact", "revisionNumber": 1}, "...": "…full EntityDetail, see entities reference"},
  "patches": []}, "requestId": "<redacted>"}
```
(illustrative — this is a command; never run to capture a real example)

**Errors**:
- `invalid_input` (400/22023) — manifest fails `ArtifactManifestSchema` (a
  `ZodError`, mapped to `invalid_input` with the failing path,
  `w2/artifacts.ts:128-139`); or an inline file's path is not in the manifest, or its
  decoded bytes/size disagree with the declared `sha256`/`size`
  (`stageInlineFiles`, `:485-509`); or the RPC finds `unknown_blob` / `size_mismatch`
  / `entrypoint_missing` (`db/migrations/055_artifacts.sql:380-407`), or the bundle
  has 0 or >128 files (`:381-384`).
- `not_found` (404) — implied by `require_space_member`/actor resolution failing on
  an invisible `spaceId`.
**Notes**: idempotency via required `clientMutationId` (ledger-replayed at
`create_artifact`, `055_artifacts.sql:439-486`, keyed to the same `spaceId` on
replay). Blobs are staged on disk and registered content-addressed
(`register_stored_blob`) BEFORE the transaction that creates the entity; a duplicate
`(space, sha256)` upload is idempotent and the redundant staged file is removed. Side
effects: `entities` row, `artifact_bundle_revisions` row 1, an `authored_from` edge to
`sourceWorkSessionId` when given, and an `activity` row (`kind: 'created'`).
Source: `w2/artifacts.ts:234-266`; RPC at `055_artifacts.sql:439`.

---

### `artifacts.publish`
`POST /v2/artifacts/:artifactId/revisions` · kind: command · status: v1 · served: yes
(`w2/artifacts.ts:268`, registered at `handlers/w2/artifacts.ts:24`)
CLI: `tm8 artifact publish <dir> --artifact <id> --expect-version <n>` — the same
composed command as `artifacts.create`, routed here when both flags are given
(`packages/cli/src/commands/artifact.ts:312-358`)

Publishes a further, append-only revision of an existing artifact, guarded by
`expectedVersion` against the entity's current version. Unlike most versioned writes,
this RPC does NOT debounce rapid same-actor calls into one snapshot — two publishes
inside 5 minutes still produce two `entity_versions` rows, so version history stays
1:1 with revision history (`055_artifacts.sql:494-500`).

**Path params**

| name | type | description |
|---|---|---|
| `artifactId` | uuid | the artifact entity |

**Request body** — `ArtifactsPublishInput` (`artifact-manifest.ts:400`, schema at
`schemas.ts:2364`)

| field | type | required | constraints | description |
|---|---|---|---|---|
| `actorId` / `workSessionId` | uuid | no | | see `CommandContext` |
| `clientMutationId` | string | yes | min 1 | idempotency key |
| `expectedVersion` | int | yes | positive | optimistic-concurrency guard on the artifact entity |
| `manifest` | `ArtifactManifest` | yes | see Shared types | |
| `files` | `ArtifactInlineFile[]` | no | 1–128 | |
| `sourceWorkSessionId` | uuid \| null | no | | |
| `header.*` | see `artifacts.create` | no | | applied AFTER the new revision is current, so it pins THIS revision |

```json
{"clientMutationId": "<uuid>", "expectedVersion": 3, "manifest": {"...": "…"}}
```

**Response** — 200; `data: CommandResult`, `entity.content.currentRevisionNumber`
incremented.

**Errors**:
- `not_found` (P0002) — `artifactId` does not exist, is not `kind: 'artifact'`, or is
  deleted (`055_artifacts.sql:533`).
- `version_conflict` (40001, 409) — `expectedVersion` does not match the current
  version; raised by `internal.assert_version` (`007_rpc_catalog.sql:69-83`, lock
  added `014_assert_version_locks.sql:60-68`) and translated by SQLSTATE
  (`packages/server/src/db/errors.ts`) into `details: {sqlstate: '40001', entityId,
  currentVersion}` — parsed from the RPC's DETAIL text. The contract's
  `version_conflict` convention also has room for a top-level `current: EntityDetail`
  (`toWireError`, `http/errors.ts:91-93`), but this path raises through a plain
  translated Postgres error, not a handler-thrown `CollabError` with `opts.current`
  set, so `current` is `unverified: not observed set anywhere in `w2/artifacts.ts`;
  only `details.entityId`/`details.currentVersion` are confirmed present.
- `invalid_input` (400/22023) — same manifest/blob failure modes as `artifacts.create`.
**Notes**: idempotency via required `clientMutationId`, replay-scoped to this
`artifactId` (`require_replay_subject`, `055_artifacts.sql:517-521`). Publishes are
serialized per artifact with `for update` on the `artifacts` detail row before the
version check (`:497`). Side effects: new `artifact_bundle_revisions` row, `artifacts
.current_revision_id` repointed, `entities.version` bumped (non-debounced),
`entity_versions` row, `activity` row (`kind: 'updated'`, `revisionNumber`).
Source: `w2/artifacts.ts:268-304`; RPC at `055_artifacts.sql:506`.

---

### `artifacts.revisions.list`
`GET /v2/artifacts/:artifactId/revisions` · kind: read · status: v1 · served: yes
(`w2/artifacts.ts:306`, registered at `handlers/w2/artifacts.ts:25`)
CLI: `tm8 artifact revisions <artifact-id>` (`packages/cli/src/commands/artifact.ts:393`)

Lists every revision of one artifact, newest first. No pagination — the whole history
returns in one call.

**Path params**

| name | type | description |
|---|---|---|
| `artifactId` | uuid | the artifact entity |

**Response** — 200; `data: { revisions: ArtifactRevision[] }` (no query params; no
cursor)

| field | type | description |
|---|---|---|
| `revisions[].revisionNumber` | int | 1-based, ascending order of publish |
| `revisions[].manifestSha256` | string | 64-hex |
| `revisions[].entrypoint` | string | |
| `revisions[].fileCount` | int | |
| `revisions[].totalSizeBytes` | int | |
| `revisions[].sourceProvenance` | object \| null | see Shared types |
| `revisions[].createdAt` | ISO timestamp | |
| `revisions[].publishedBy` | uuid | the member/team_member actor who published it |

```json
{"data": {"revisions": [{"revisionNumber": 2, "manifestSha256": "<64-hex>",
  "entrypoint": "index.html", "fileCount": 3, "totalSizeBytes": 4096,
  "sourceProvenance": {"schemaVersion": 1, "publishedAt": "2026-09-24T00:00:00.000Z",
    "spaceId": "<uuid>", "sourceWorkSessionId": null, "launchProjectId": null,
    "associatedProjectIds": [], "project": null, "worktree": null, "build": null},
  "createdAt": "2026-09-24T00:00:00.000Z", "publishedBy": "<uuid>"}]}, "requestId": "<redacted>"}
```
(illustrative, from schema — the space checked for this task had no artifacts to
capture a real example against)

**Errors** — `not_found` (404): `artifactId` is invisible or not `kind: 'artifact'`
(`artifactSpaceId`, `w2/artifacts.ts:224-232` — visibility is resolved BEFORE the
revisions query, so a cross-space read is `not_found`, never an empty list).
**Notes**: no idempotency (read). No `expectedVersion`. Ordered
`revision_number desc`.
Source: `w2/artifacts.ts:306-323`.

---

### `artifacts.preview.start`
`POST /v2/artifacts/:artifactId/preview-sessions` · kind: command · status: v1 ·
served: yes (`w2/artifacts.ts:325`, registered at `handlers/w2/artifacts.ts:26`)
CLI: `tm8 artifact preview <artifact-id> [--revision <n>]`
(`packages/cli/src/commands/artifact.ts:404`)

Mints a short-lived (10-minute), viewer-bound, revocable capability to view one
revision's rendered bundle in an iframe. The raw token is generated here and never
stored — only its SHA-256 is (`artifact_preview_sessions.token_hash`), so a database
read alone can never yield a usable credential.

**Path params**

| name | type | description |
|---|---|---|
| `artifactId` | uuid | the artifact entity |

**Request body** — `ArtifactsPreviewStartInput` (`artifact-manifest.ts:415`, schema
at `schemas.ts:2374`)

| field | type | required | constraints | description |
|---|---|---|---|---|
| `actorId` / `workSessionId` | uuid | no | | |
| `clientMutationId` | string | yes | min 1 | idempotency key |
| `revisionNumber` | int | no | positive | defaults to the artifact's current revision |

```json
{"clientMutationId": "<uuid>"}
```

**Response** — 200; `data: ArtifactPreviewSession`
(`artifact-manifest.ts:438-445`)

| field | type | description |
|---|---|---|
| `previewSessionId` | uuid | |
| `token` | string | the raw capability (32 random bytes, hex); never stored server-side |
| `revisionNumber` | int | resolved revision (explicit or current) |
| `expiresAt` | ISO timestamp | `now() + 600s` |
| `previewUrl` | string | absent | absolute URL, present unless the node has no preview origin configured; NEVER fabricated when absent |

```json
{"data": {"previewSessionId": "<uuid>", "token": "<redacted>", "revisionNumber": 2,
  "expiresAt": "2026-09-25T00:10:00.000Z", "previewUrl": "https://<redacted>/p/<uuid>/<redacted>/"},
  "requestId": "<redacted>"}
```
(illustrative — this is a command; never run to capture a real example)

**Errors**:
- `not_found` (P0002) — no such artifact, or (when `revisionNumber` given) no such
  revision (`055_artifacts.sql:609,632`).
- `invalid_input` (22023) — resolved TTL out of the RPC's 1–3600s band; not reachable
  through this handler today since `PREVIEW_TTL_SECONDS` is a fixed 600.
- `conflict` (409) — a ledger REPLAY of the same `clientMutationId` resolved to a
  session whose stored `token_hash` does not match this call's freshly generated
  token (a fresh token can never be re-derived from a replay); message names the
  fix: retry with a fresh `clientMutationId` (`w2/artifacts.ts:343-360`).
**Notes**: idempotency via required `clientMutationId`, but see the `conflict` case
above — a true replay is NOT safely idempotent for this op because the capability
token itself is never persisted, so the client-side default is to treat a replay as
an error rather than silently hand back a dead session id. Side effect: one
`artifact_preview_sessions` row (no entity/version change, no activity row).
Source: `w2/artifacts.ts:325-376`; RPC at `055_artifacts.sql:584`.

---

### `artifacts.export`
`GET /v2/artifacts/:artifactId/revisions/:revisionNumber/export` · kind: read ·
status: v1 · served: yes (`w2/artifacts.ts:378`, registered at
`handlers/w2/artifacts.ts:27`)
CLI: `tm8 artifact export <artifact-id> [--revision <n>] [--out <path>]`
(`packages/cli/src/commands/artifact.ts:427`)

Answers RAW ZIP BYTES, outside the `{data, requestId}` envelope — the documented
exception also used by `files.download`. Builds a deterministic zip (byte-stable
across identical inputs) of one revision's files, in manifest/ordinal order.

**Path params**

| name | type | description |
|---|---|---|
| `artifactId` | uuid | the artifact entity |
| `revisionNumber` | int (positive) | validated by `requireRevisionParam`, `invalid_input` if not a positive integer (`w2/artifacts.ts:151-158`) |

**Response** — 200, raw bytes (`raw(200, headers, zip)`,
`w2/artifacts.ts:418-424`):

| header | value |
|---|---|
| `content-type` | `application/zip` |
| `content-length` | byte length |
| `content-disposition` | `attachment; filename="<sanitized-name>-r<revisionNumber>.zip"` |
| `x-content-type-options` | `nosniff` |
| `cache-control` | `no-store` |

No JSON `data`/`requestId` on success. The CLI writes the bytes to `--out` (or stdout
when `--out` is omitted and the format is `human`).

**Errors**:
- `not_found` (404) — no such artifact, or no such revision number for it
  (`w2/artifacts.ts:391,398`).
- `invalid_input` (400) — `revisionNumber` path segment is not a positive integer.
**Notes**: no idempotency (read; GET, never mutates). This is the only capture-eligible
READ op in this family with byte output; per this task's rules no example bytes are
embedded here. Blobs are streamed from `W2BlobStore` by `storage_path`, joined only by
`blob_id` (never a client-influenced path) — no traversal surface.
Source: `w2/artifacts.ts:378-425`, `buildDeterministicZip` at
`packages/server/src/files/zip.ts`.

---

### `artifacts.restore`
`POST /v2/artifacts/:artifactId/commands/restore-revision` · kind: command · status:
v1 · served: yes (`w2/artifacts.ts:427`, registered at `handlers/w2/artifacts.ts:28`)
CLI: `tm8 artifact restore <artifact-id> --revision <n> --expect-version <n>`
(`packages/cli/src/commands/artifact.ts:519`)

Republishes an old revision's exact manifest bytes as a brand-new, append-only
revision (never mutates the old one) — the same `publish_artifact_revision` RPC
`artifacts.publish` uses, with the source revision's manifest re-hashed and
re-provenanced. There is no "restored from N" field on the wire; the new revision row
and its activity entry are the only record of the event.

**Path params**

| name | type | description |
|---|---|---|
| `artifactId` | uuid | the artifact entity |

**Request body** — `ArtifactsRestoreInput` (`artifact-manifest.ts:422`, schema at
`schemas.ts:2380`)

| field | type | required | constraints | description |
|---|---|---|---|---|
| `actorId` / `workSessionId` | uuid | no | | |
| `clientMutationId` | string | yes | min 1 | idempotency key |
| `expectedVersion` | int | yes | positive | guards the artifact's current version |
| `revisionNumber` | int | yes | positive | the OLD revision to republish |

```json
{"clientMutationId": "<uuid>", "expectedVersion": 4, "revisionNumber": 2}
```

**Response** — 200; `data: CommandResult` (no `header` option on this op, unlike
create/publish).

**Errors**:
- `not_found` (404) — no such artifact, or `revisionNumber` does not exist for it
  (`w2/artifacts.ts:442`).
- `version_conflict` (40001, 409) — `expectedVersion` mismatch (same mechanics as
  `artifacts.publish`).
- `invalid_input` (22023) — the stored old manifest somehow fails re-validation
  (`validateManifest`, `w2/artifacts.ts:447`) — `unverified: no test or comment names
  a path that produces this today, since the stored manifest was itself validated at
  publish time; documented because the code path exists.`
**Notes**: idempotency via required `clientMutationId`. No new blob bytes are
accepted — restore always reuses the old revision's already-registered blobs. Side
effects: identical to `artifacts.publish` (new revision row, `current_revision_id`
repointed, version bump, `entity_versions` row, `activity` row).
Source: `w2/artifacts.ts:427-465`; RPC at `055_artifacts.sql:506` (shared with
`artifacts.publish`).
