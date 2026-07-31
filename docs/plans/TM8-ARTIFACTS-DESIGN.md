# tm8 — Artifacts: Design and Implementation Plan

**Status:** DRAFT v1 (2026-07-31) — authored by the artifacts design worker
(`sess_1785450802002_21mczq0wh`). **Design only.** No product source was modified, no migration
was run, nothing was committed.

**What this document is.** The artifacts feature had no design document in this repository. A
2026-07-30 session (`sess_1785384914506_hkfpgm4zl`) designed it against the shipped code and
reported its conclusions as chat messages only; those were recovered into
`docs/plans/TM8-NEW-ENTITIES-SESSION-DIGEST.md` §4. This document is the first written design.
It treats that recovered prior as a strong hypothesis from a competent reader and tests it
against the tree rather than inheriting it.

**The originating request, verbatim:** *"i also want to add something called artifacts which are
html + javascript fiels genreated, and can be viewed on teh app itself."*

**Verdict.** Confirmed **conditional GO**, with the condition tightened. The prior said executable
preview must not ship until the Phase-0 security gates pass. Verification shows that is not merely
prudent sequencing — **S2 (Host allowlist) is the mechanism that makes origin isolation work at
all**, not a gate standing beside it. See §9.3. Two things also need an explicit decision from the
user before Phase 1 starts, in §12.

---

## 1. Verification ledger — the brief against the tree

Everything below was read from the **working tree** (which is dirty with three other workers'
in-flight work), not from `git HEAD`.

### 1.1 Confirmed

| Claim | Verdict | Evidence |
|---|---|---|
| Catalog declares 110 operations | **TRUE** — 108 `v1` + 2 `reserved` | `packages/contract/src/catalog.ts:30-174`; asserted by three tests, incl. `packages/cli/test/catalog-exhaustiveness.test.ts:33,39-44` |
| Migration chain reaches 050 | **TRUE** (47 files; 025, 026, 028 skipped) | `db/migrations/050_entity_attention.sql`; runner `db/migrate.mjs` |
| Edge `props_schema` validation shipped in 018 | **TRUE** | `db/migrations/018_w2_edges_placements.sql:94-143`; column created unenforced at `001_core_graph.sql:758` |
| No `memory`/`worktree`/`artifact` kind exists | **TRUE** — 15 core kinds, none of them these | `packages/contract/src/contract.ts:30-39`; `schemas.ts:82-94` |
| S2/S3/S4/S6 still unimplemented | **TRUE** — named no-ops | `packages/server/src/http/security.ts:51-70`; every parameter is `_`-prefixed and unread |
| Entity version debounce is a 5-minute window | **TRUE**, and it is **sliding** | `db/migrations/001_core_graph.sql:1125-1128`, `:1130-1176` |
| The purge scheduler is a stub | **TRUE, and worse** — see §1.2 | `packages/server/src/scheduler/jobs/retention.ts:62-105` |
| The feed discriminator `artifact` collides | **TRUE**, and the rename is cheap | `packages/tm8-ui/src/channel-screen/feed-model.ts:218` |

### 1.2 Corrected — the brief is wrong or incomplete in six places

**C1. `stored_blobs` does not exist. There is no blob table at all.**
The brief reads as though `stored_blobs` were an existing internal table to start sharing. It is
not. Bytes live **only** on the filesystem at `<dataDir>/blobs/spaces/<spaceId>/<uuid>`; Postgres
holds `public.files.storage_path` plus size and checksum (`db/migrations/001_core_graph.sql:594-611`)
and the transient `public.file_upload_slots` lease (`006_execution_side.sql:115-140`, extended by
`022_w2_files.sql:12-50`). So `stored_blobs` is a **new table this design creates**, and the
"compatibility backfill" is a data migration out of `public.files`. This is materially larger and
riskier than the brief implies, and it reshapes the phasing — see §5.1.

**C2. `files.checksum_sha256` is nullable, so the backfill cannot be a SQL statement.**
`001_core_graph.sql:604`. A content-addressed table needs a hash on every row. Backfilling
therefore requires **re-reading and re-hashing existing blobs from disk** for null-checksum rows:
an application job with I/O, partial-failure and resumability concerns, not an `INSERT ... SELECT`.

**C3. Filling in `security.ts` does not close S2/S3 on WebSockets.**
`security.ts:40` claims "enabling a rule is a change to this file alone." That is true for HTTP and
**false for the WS upgrade**: `checkTransport` is called only from the ordinary request handler
(`packages/server/src/http/server.ts:129-130`), while the `upgrade` listener
(`server.ts:104-119`) is a separate path that never calls it. Neither socket server does its own
Origin check (`events/ws-server.ts:110-130`; `pty/pty-ws-server.ts`). **Two wiring changes, not
one.** Any plan that budgets S2/S3 as "fill in four function bodies" is under-scoped.

**C4. The purge is not a stub that reports — it is an unscheduled stub that never runs.**
`createDefaultScheduler` (`packages/server/src/scheduler/index.ts:54-59`) is called **only from two
test files**. `packages/server/src/main.ts` never imports `scheduler/`, never constructs a
`Scheduler`, and never calls `.start()`. So no retention job, no backup job (S18), and not even a
`skipped` report has ever executed in production. Making the sweep real is therefore **two** pieces
of work: start a scheduler at all, then supply the sweep. Related: `internal.prune_entity_versions`
(`001_core_graph.sql:1192`) and `internal.prune_workspace_events` (`003_read_model.sql:403`) both
have **zero** production callers.

**C5. There is no authentication of any kind, so CORS and CSRF are the *entire* boundary.**
The live resolver (`packages/server/src/main.ts:288-293`) ignores request headers and returns the
node owner for every request. No cookies exist anywhere in `packages/server/src`. The bearer path
(`identity/service.ts:110-111`) is written but unwired, and `loopback.ts:4-12` explains why —
`PgIdentityRepository` targets a schema that never landed. `10-SECURITY-MODEL.md:27` asserts
auto-auth "only applies to requests that pass S1–S4"; **S2–S4 do not exist, so that precondition is
currently false.** Practical consequence, and the reason this matters far more once artifacts
exist: with no CORS and no CSRF check, a malicious page in the user's browser can already send a
simple `POST` to `127.0.0.1:4610` and **the mutation lands** (the response is unreadable, which
does not help). Artifacts would add *attacker-authored JavaScript running on the same machine* to
that situation.

**C6. There are three `artifact` name collisions, not one.** The brief names one. See §7.2.

### 1.3 Not previously stated, and load-bearing

- **The UI has no iframe, no CSP, and no HTML-rendering surface.** Zero occurrences of `<iframe`,
  `sandbox=`, or `dangerouslySetInnerHTML` in `packages/tm8-ui/src`. Doc rendering is a deliberate
  three-shape regex splitter, not a markdown/HTML renderer
  (`packages/tm8-ui/src/panels/bodies/ReaderBody.tsx:243-280`); file "preview" renders a **text
  label**, not an `<img>` (`panels/bodies/GenericBody.tsx:162-188`). The server's complete header
  set is one header: `x-content-type-options: nosniff`
  (`packages/server/src/http/security.ts:104-108`). **An artifact preview would be the first iframe
  in this UI and the first CSP this server has ever emitted.** Nothing can be reused; all of §9 is
  greenfield.
- **The app is same-origin by deliberate architecture.** The vite dev server proxies `/v2` to the
  node with `changeOrigin: false` (`packages/tm8-ui/vite.config.ts`), and even *remote* servers are
  reached through a same-origin server-side relay explicitly so that "browser CORS never becomes
  transport" (`packages/tm8-ui/src/views/useGateData.ts:173-186`;
  `src/servers/server-registry.ts:62-64`). `static.ts:1-8` states the same posture. Introducing a
  second origin is a genuine architectural departure and must be argued for, not assumed — §9.1.
- **The static handler has an SPA fallback** that serves `index.html` for extension-less paths
  (`packages/server/src/http/static.ts:14-17`). If artifact assets were ever served through it, a
  missing asset would return HTML with a 200. Another reason artifacts never touch that path.
- **`tm8_app` has no INSERT/UPDATE/DELETE on any table.** Every write is a `SECURITY DEFINER` RPC
  (`db/migrations/008_rls_policies.sql:4-11`). All artifact writes must be RPCs. RLS is enabled on
  every table via the loop at `008:43-59`; new tables must join it.
- **Badges are twinned.** Per the memories worker: a read-time badge computed in `badgesOf`
  (`packages/server/src/facade/entity-read.ts`) must **also** be added to the projector twin
  (`packages/server/src/events/projector.ts`) or the event feed and the REST read disagree. This
  applies to any badge artifacts add.

---

## 2. Domain model

### 2.1 The decision

**Add a first-class core `artifact` entity whose typed detail is the current immutable static-web
bundle revision.** An artifact is a *named, versioned, viewable thing* in the graph. A bundle
revision is an immutable published snapshot of its contents. The entity is the identity that
persists; revisions are the history.

The four universal capabilities pay rent (the T-L3 entity test): you would discuss an artifact
(messages), link it (edges), parent it (hierarchy), and react to it (points). It deserves a chip, a
card, and a panel. It is an entity.

### 2.2 Rejected alternatives

**A custom kind (`c:artifact`) — rejected.** T-L4 is explicit: custom-kind fields are **scalars
only** (`03-ENTITY-GRAPH-DELTAS.md:51`, `[R8]`), stored in one shared jsonb table, and custom kinds
get **no custom commands and no custom triggers** (`:50`). Artifacts need all four of the things
that excludes: a file list (not a scalar), a publish command, an append-only revision trigger, and
a runtime policy. Modelling a bundle as scalar jsonb fields would rebuild exactly the
`assigneeUids[]` failure mode T-L3 exists to prevent. Promotion of a custom kind to a core kind is
a migration anyway — so this route ends where we started, having shipped a bad schema first.

**A `file` or zip entity alone — rejected.** A zip has no addressable entrypoint, no per-file media
types, no manifest to hash, no revision history, no provenance, and no runtime policy. More
importantly it has the **wrong security posture**: `files.download` returns raw bytes from the
privileged origin (`facade/services/w2/files.ts:282-312`). Serving artifact HTML through it would
execute attacker-authored script *as the app's origin* — the single failure this design exists to
prevent. A zip also cannot express "this bundle is self-contained", which is the property the
preview sandbox depends on.

**A mutable draft entity — rejected (not in the brief; worth recording).** There is no draft
artifact. Every publish creates a revision; there is no half-published state. Rationale: a mutable
draft would need its own blob lifecycle, its own GC rules, and its own answer to "what does preview
show?", and would reintroduce the debounce problem it took a bypass RPC to solve. Iteration is
cheap already — publish, look, publish again — because revisions are append-only and blobs
deduplicate.

### 2.3 Lifecycle

Create-with-first-revision → publish further revisions → preview / export → soft delete → purge.
Restore creates a **new** revision rather than mutating an old one, because revisions are
append-only; "restore revision 3" means "publish revision 3's content as revision 8, with new
provenance recording that it was restored from 3."

---

## 3. Model agnosticism — the hard invariant

**No provider, model, agent tool, prompt, generator, or storage URL appears in the manifest, or
affects execution or validity.** A human, any model, a CI build, and an import use the identical
publish API and CLI. Identical bytes produce the same manifest hash regardless of origin. Model and
tool details remain optional provenance reachable through a `work_session`, never part of artifact
identity. The preview runtime exposes no model SDK and no provider-specific bridge. UI language
says **artifact**, never "AI artifact".

This was non-negotiable in the originating session. This design adds the part that was missing:
**an enforcement mechanism, so the invariant is testable rather than aspirational.** See §4.4.

---

## 4. The manifest

Media type: `application/vnd.tm8.web-artifact+json`.

```jsonc
{
  "schema": "tm8.web-artifact/1",
  "runtime": "web-static-v1",
  "entrypoint": "index.html",
  "files": [
    { "path": "index.html", "mediaType": "text/html",       "size": 1234, "sha256": "<64 lc hex>" },
    { "path": "app.js",     "mediaType": "text/javascript", "size": 9001, "sha256": "<64 lc hex>" }
  ]
}
```

Exactly four top-level keys; exactly four keys per entry. The schema is **strict** — any unknown
key at any level is `invalid_input`, never ignored. Strictness is what makes §4.4 possible.

### 4.1 Canonicalization and hashing

1. Validate against the strict schema.
2. Normalize every `path` to Unicode **NFC**. A non-NFC path is **rejected**, not silently
   rewritten — rewriting would make the client-computed hash disagree with the server's.
3. `files` must arrive **sorted ascending by the UTF-8 byte sequence of `path`** (not UTF-16 code
   units, not locale collation). An unsorted manifest is rejected, not re-sorted, for the same
   reason.
4. Serialize with **JCS (RFC 8785)**. `size` is an integer `<= 2^53 - 1`, so JCS number formatting
   is unambiguous here.
5. `manifestHash = lowercase_hex(SHA-256(jcs_bytes))`.

The hash is **never a field of the manifest** — self-referential hashing is a classic
canonicalization bug, excluded by construction.

### 4.2 Path rules

Reject with `invalid_input` if any path: is empty or exceeds 1024 UTF-8 bytes; has a segment over
255 bytes; is absolute or a Windows drive/UNC form; contains a backslash, NUL, or any C0/C1 control
character; contains a `.`, `..`, or empty segment; has a segment beginning with `.`; is not NFC; or
duplicates another path after NFC **or** after NFC + ASCII case-folding.

Case-folding is included even though the store is content-addressed and never writes these paths to
a filesystem, because **export-to-zip lands on case-insensitive filesystems** where `A.js` and
`a.js` collide.

`mediaType` is drawn from a closed server-side allowlist (html, css, js, json, svg, png, jpeg, gif,
webp, avif, woff2, txt, map, ico, wasm — frozen in Phase 0). It is *declared* metadata served
verbatim beside `nosniff`, so a lie about the type cannot upgrade a `.txt` into script. `size` must
equal the referenced blob's actual byte length, verified server-side against `stored_blobs.size`
rather than trusted.

### 4.3 Limits

| Limit | Default | Error |
|---|---|---|
| files per bundle | 128 | `limit_exceeded` |
| total uncompressed bytes | 25 MiB | `limit_exceeded` |
| single file bytes | 8 MiB | `limit_exceeded` |
| path length | 1024 B | `invalid_input` |

Node-configurable, never per-request. For scale: the existing global file cap is 512 MiB
(`contract.ts:1258`), so artifacts are deliberately two orders of magnitude tighter.

### 4.4 Excluded from the manifest, and how that is enforced

Excluded: provider, model, agent tool, prompt, generator, generator version, storage URL, bucket,
signed URL, author, timestamp, space id.

- **provider / model / tool / prompt / generator** — would make identity depend on who made it,
  which is the invariant.
- **storage URLs / buckets** — location is not identity; a restore or a move to object storage
  must not change the hash of an unchanged artifact.
- **timestamps / author** — provenance, and they live on the revision. They must not perturb
  content identity.
- **space id** — an artifact exported from one space and imported into another is the same artifact.

**Two Phase-0 tests turn the invariant red when it erodes:**

1. **Strictness test** — the schema rejects an extra key at every level.
2. **Vocabulary test** — walk the compiled manifest schema; assert no property name and no enum
   value case-insensitively matches `model, provider, prompt, agent, generator, llm, ai, anthropic,
   openai, claude, gpt, completion, temperature, apiKey, token, url, href, endpoint`.

The vocabulary test is deliberately blunt. Its purpose is to make a future well-meaning "just add
`generatedBy` for analytics" patch fail CI instead of reaching production.

---

## 5. Physical schema

### 5.1 The blob seam, and a deliberate departure from the brief

Given C1 and C2, two decisions:

**Decision 1 — Phase 0 creates `stored_blobs` and freezes the seam; Phase 1 uses it for artifacts
only; the `files` backfill moves to Phase 2.**
The brief's Phase-0 goal ("freeze the `stored_blob` seam") is met by freezing the *schema and the
write path*; it does not require moving existing data. Doing both at once couples the artifact
vertical slice to a re-hash-everything migration over user data — and if that migration is what
goes wrong, it takes artifacts down for reasons unrelated to artifacts. Splitting them keeps
exactly one blob table (never a second vocabulary to reconcile) while deferring the only
irreversible, data-touching step until the seam has run in production. Cost: an artifact and a
`file` holding identical bytes store them twice until Phase 2 — bounded by the 25 MiB cap, on a
local node. Accepted.

**Decision 2 — content addressing lives in the database, not in the path.**
`W2BlobStore.STORAGE_PATH_RE` (`packages/server/src/files/w2-blob-store.ts:27`) requires **both**
path segments to be full UUIDs, and the store realpath-checks containment, refuses symlinks via
`O_NOFOLLOW`, creates directories `0700`, and publishes with a same-directory **hard link rather
than `rename`** so a staged blob is never silently overwritten (`:159-163`). That is a carefully
built component. A content-addressed on-disk layout would require widening that frozen regex and
re-litigating every one of those guarantees.

So: **keep the on-disk shape exactly as it is — server-generated UUIDs, `W2BlobStore` unchanged —
and put content addressing in `stored_blobs` as `unique (space_id, sha256)`.** The blob's *name*
stays a UUID; its *identity* is a column. This buys deduplication and reference counting with zero
change to the filesystem authority and zero risk to S17. Space-scoping the uniqueness also
preserves the Space boundary that a global hash namespace would have quietly broken — two spaces
with identical bytes must not share a row, or purging one space's artifact could revoke the other's.

### 5.2 Tables

All four join the RLS loop at `008_rls_policies.sql:43-59`; `tm8_app` gets `SELECT` only; every
write is a `SECURITY DEFINER` RPC. Read policies use the shared predicate
`internal.entity_readable(entity_id)`, mirroring `entity_versions_select` (`008:77-79`).

```sql
create table public.stored_blobs (
  id           uuid primary key default internal.new_id(),
  space_id     uuid not null references public.spaces(id) on delete cascade,
  sha256       text not null check (sha256 ~ '^[a-f0-9]{64}$'),
  size_bytes   bigint not null check (size_bytes >= 0),
  -- The SAME frozen shape W2BlobStore already enforces. Server-generated (S17).
  -- Content addressing is the unique index below, NOT the path.
  storage_path text not null unique
    check (storage_path ~ '^spaces/[0-9a-f-]{36}/[0-9a-f-]{36}$'),
  created_at   timestamptz not null default now(),
  unreferenced_since timestamptz,          -- set when the last reference drops
  unique (space_id, sha256)
);
create index stored_blobs_sweep_idx on public.stored_blobs(unreferenced_since)
  where unreferenced_since is not null;

create table public.artifacts (
  entity_id           uuid primary key references public.entities(id) on delete cascade,
  name                text not null check (char_length(btrim(name)) between 1 and 200),
  description         text check (description is null or char_length(description) <= 2000),
  current_revision_id uuid references public.artifact_bundle_revisions(id)
                        deferrable initially deferred,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint artifacts_has_revision check (current_revision_id is not null)
    deferrable initially deferred
);
create trigger artifacts_validate_kind before insert or update of entity_id on public.artifacts
for each row execute function internal.validate_detail_envelope('artifact');

create table public.artifact_bundle_revisions (
  id                 uuid primary key default internal.new_id(),
  artifact_entity_id uuid not null references public.entities(id) on delete cascade,
  space_id           uuid not null references public.spaces(id) on delete cascade,
  revision_number    integer not null check (revision_number > 0),
  manifest           jsonb not null,
  manifest_sha256    text not null check (manifest_sha256 ~ '^[a-f0-9]{64}$'),
  entrypoint_path    text not null,
  file_count         integer not null check (file_count between 1 and 128),
  total_size_bytes   bigint not null check (total_size_bytes >= 0),
  source_provenance  jsonb not null,
  published_by       uuid not null references public.entities(id),
  created_at         timestamptz not null default now(),
  unique (artifact_entity_id, revision_number)
);
create index artifact_bundle_revisions_artifact_idx
  on public.artifact_bundle_revisions(artifact_entity_id, revision_number desc);

create table public.artifact_bundle_entries (
  revision_id uuid not null references public.artifact_bundle_revisions(id) on delete cascade,
  path        text not null,
  media_type  text not null,
  size_bytes  bigint not null check (size_bytes >= 0),
  blob_id     uuid not null references public.stored_blobs(id) on delete restrict,
  ordinal     integer not null,
  primary key (revision_id, path)
);
create index artifact_bundle_entries_blob_idx on public.artifact_bundle_entries(blob_id);

create table public.artifact_preview_sessions (
  id                 uuid primary key default internal.new_id(),
  artifact_entity_id uuid not null references public.entities(id) on delete cascade,
  revision_id        uuid not null references public.artifact_bundle_revisions(id) on delete cascade,
  space_id           uuid not null references public.spaces(id) on delete cascade,
  viewer_identity_id text not null,
  token_hash         text not null unique check (token_hash ~ '^[a-f0-9]{64}$'),
  created_at         timestamptz not null default now(),
  expires_at         timestamptz not null,
  revoked_at         timestamptz
);
create index artifact_preview_sessions_expiry_idx on public.artifact_preview_sessions(expires_at);
```

Notes that are load-bearing:

- **`artifacts` deliberately has no `snapshot_entity_version` trigger**, unlike every other core
  detail table. Version advancement for an artifact is driven by *publish*, not by detail mutation,
  and publish must bypass the debounce (§5.3); adding the trigger would create two competing
  version writers. **This absence must be a comment in the migration, not silence** — the memories
  worker's review (F1) found that migration 015 omitted this trigger *by accident* on two tables,
  so an unexplained absence here will read as the same bug and get "fixed".
- **Revisions are append-only, enforced**: a `before update or delete` trigger raising `42501`.
  `DELETE` is included because purge removes revisions via the *entity* cascade; a direct row
  delete is always a bug. The cascade fires as the table owner rather than `tm8_app`, so it still
  works — but the migration's own test must prove that, because a trigger that blocked cascade
  would make entity purge fail at its last step, discovered in production.
- **No uniqueness on `manifest_sha256`.** Publishing identical bytes twice is legal and creates a
  new revision, because the *provenance* differs even when the content does not. Content identity
  is `manifest_sha256`; revision identity is `(artifact, revision_number)`. Idempotent replay is
  handled where it belongs — `clientMutationId` and the command ledger.
- **`on delete restrict` on `blob_id`** is the referential half of GC: a blob with a live entry
  cannot be deleted, so a GC bug becomes a loud FK error rather than a silent 404 in a preview.
- **`primary key (revision_id, path)`** gives the preview an exact-equality lookup and makes
  duplicate paths structurally impossible, independent of manifest validation.
- **`token_hash`, never the token** — the discipline `w2-file-upload.ts:94-95` already applies to
  upload grants. A database read never yields a usable credential.

### 5.3 The non-debounced publish

`internal.version_debounce_window()` returns `interval '5 minutes'`
(`001_core_graph.sql:1125-1128`), and `internal.snapshot_entity_version()` (`:1130-1176`) folds an
edit into the previous snapshot when **both** the actor matches (`is not distinct from`, so two
`created_by`-fallback writes also coalesce) **and** `latest.changed_at > now() - window`. It is a
**sliding** window — the debounce branch sets `changed_at = now()` — so a same-actor edit every
four minutes for an hour yields exactly one `entity_versions` row.

**Why that is fatal here, concretely:** publishing revision 2 four minutes after revision 1, as the
same actor, would **overwrite revision 1's snapshot in place**. The revision row survives, but the
entity-version snapshot recording what the entity looked like at revision 1 is gone — version
history silently disagrees with revision history. Publish-look-tweak-publish is not an edge case
for this feature; it is the main case.

**There is no flag, option, env var, or bypass parameter**: the trigger function takes no
arguments, and `version_debounce_window()` is `immutable` and hardcoded.

**But three existing write paths already bypass the trigger** by advancing `entities.version`
themselves and inserting the version row directly: `move_entity`
(`017_w2_entities_commands_tracking.sql:347-349`), the project materializer
(`021_w2_projects.sql:76-79`), and `internal.w2g12_advance_profile_entity`
(`027_w2_entity_kinds_profiles.sql:604-612`). So this is an **established pattern, not a new
mechanism**:

```sql
update public.entities
   set version = version + 1, activity_at = now(), updated_at = now()
 where id = p_artifact_entity_id
returning version into next_version;

insert into public.entity_versions(entity_id, version, snapshot, changed_by)
values (p_artifact_entity_id, next_version,
        internal.entity_snapshot(p_artifact_entity_id), actor);
```

**The test that pins it:** publish twice as the same actor inside five minutes; assert
`entity_versions` gained **two** rows. This is the exact inverse of the existing debounce test at
`packages/server/test/w3/g02-public.test.ts:1310-1324` (`toHaveLength(1)`), so the pair documents
both behaviours and neither can break silently.

### 5.4 Backfill plan (Phase 2)

1. Add `files.blob_id uuid references public.stored_blobs(id)`, nullable.
2. Resumable job, in `space_id` batches: for each `files` row, read the blob through
   `W2BlobStore.read` (which realpath-checks and refuses symlinks), compute SHA-256, upsert
   `stored_blobs` on `(space_id, sha256)`, set `files.blob_id`. Where `checksum_sha256` was
   non-null, **assert** the recomputed hash matches and hard-fail the batch on mismatch — a
   mismatch means on-disk corruption and must be surfaced, not smoothed over.
3. Dedup note: rows that collide on `(space_id, sha256)` now share one `stored_blobs` row while
   keeping distinct `storage_path` values on disk. Reclaiming the duplicate bytes is a separate,
   later step; the backfill itself must not delete anything.
4. Gate: `files.blob_id` becomes `NOT NULL` only after a verification pass reports zero nulls.
5. **The latent bug this introduces, stated now:** once blobs are shared, deleting a file must not
   delete its blob unless nothing else references it. Today this is dormant because *nothing ever
   deletes blobs* (C4). The moment GC becomes real, `W2BlobStore.remove` must be called only from
   the reference-aware sweep (§10), never from a delete path.

---

## 6. `sourceProvenance`

`artifact_bundle_revisions.source_provenance jsonb NOT NULL`. Written once at publish, never
updated; the append-only trigger in §5.2 makes that structural.

```jsonc
{
  "schemaVersion": 1,
  "publishedAt": "2026-07-31T12:34:56.789Z",
  "spaceId": "0199...",
  "sourceWorkSessionId": "0199..." | null,
  "launchProjectId": "0199..." | null,
  "associatedProjectIds": ["0199...", "..."],
  "project":  { "projectResourceId": "…", "spaceProjectEntityId": null,
                "repoUrlAtPublish": null, "repoIdentity": null } | null,
  "worktree": { "worktreeEntityId": null, "entityVersion": null, "branch": null,
                "baseRef": null, "baseCommitOid": null,
                "lifecycleStatusAtPublish": null } | null,
  "build":    { "sourceCommitOid": null, "dirty": false,
                "uncommittedTreeDigest": null } | null
}
```

**`schemaVersion`** — integer, required. Not the manifest's `schema`: provenance evolves
independently, and we will learn to record more source facts long before the bundle format changes.
Readers switch on it and must tolerate a higher value by rendering what they understand and saying
so, never by discarding the object.

**`publishedAt`** — RFC 3339 UTC, ms precision, **server clock**. Client-supplied would let a caller
backdate history. Duplicated from the row's `created_at` deliberately: the snapshot must be
meaningful after export, detached from its row.

**`spaceId`** — denormalized so an exported revision is self-describing. **Never used for
authorization** — RLS reads `entities.space_id`. Stated explicitly because a denormalized tenant id
that *looks* authoritative is a classic authorization bug.

**`sourceWorkSessionId`** — nullable, and nullable because **most publishes legitimately have no
session** (human upload, CLI outside a session, CI, import), not because data is missing. This is
the sole hook to model/agent/tool facts: follow it to the `work_session` and `agent_tool` and
`model` are right there. That indirection *is* the agnosticism design — reachable, not identity.
The matching edge is `authored_from: artifact -> work_session`, written in the same transaction.
The scalar is the frozen record, the edge is the queryable index; if they disagree, the scalar wins.

**`launchProjectId`** (nullable, immutable) and **`associatedProjectIds`** (sorted, possibly empty).
**These must not be merged, and this is the most important structural decision in the envelope** —
independently confirmed as such by the worktrees worker, who applies the same split to
`work_sessions.workdir_*` versus `in_worktree` edges.

`in_project` is a mutable M:N association; `launchProjectId` is a historical fact. Merged, adding an
`in_project` edge next month would appear to rewrite where the bundle came from; removing the last
one would appear to erase its origin; and "what was this built from?" and "where does this live?"
would return the same, wrong answer.

**And the tree makes the case sharper than cardinality alone does.** `work_sessions.project_id` is a
nullable single FK to the project **resource** (`db/migrations/001_core_graph.sql:698`), while
`in_project` edges point at the per-space project **projection entity** and are mutable M:N, capped
at 16 live associations per session (`015_w1_foundations.sql:685`). **They are different targets,
not merely different cardinalities of the same target.** Flattening them would not just lose
history — it would conflate two different kinds of identifier.

Sorted because unsorted arrays produce spurious diffs.

**`project`** — `repoUrlAtPublish` is named for what it is: a value that was true at a moment.
`repoIdentity` exists because **URLs are not identity** — a repo can be renamed, moved between
forges, or mirrored, after which the URL snapshot points somewhere wrong while looking
authoritative. Where a stable identity is derivable (root commit oid is the usual choice) it is
worth far more than the URL.

**`worktree`** — every field nullable and the whole object nullable, because **no `worktree` kind
exists in the contract today**. Field names are the worktrees worker's, **confirmed by them**
(§13): `worktreeEntityId`, `entityVersion`, `branch`, `baseRef`, `baseCommitOid`, and
`lifecycleStatusAtPublish` all match their columns and semantics.

**Two fields were dropped on their review, and the reasoning is worth keeping.** The earlier
envelope carried `headCommitOid` and `treeDigest` here; both are removed because they **duplicate**
`build.sourceCommitOid` and `build.uncommittedTreeDigest`. HEAD is a point-in-time sample of a
checkout, not a property of a worktree allocation, and the worktrees design will never store it.
Two fields that can disagree about the same fact is precisely the class of quiet lie both designs
exist to prevent. **All commit and digest sampling lives in `build`; the worktree block describes
the allocation.**

`lifecycleStatusAtPublish` is stored as an **opaque string**, not an enum validated on my side — the
domain belongs to their design and I must not fork a copy that drifts. For reference only, their
enum is forward-only `active | merged | abandoned | deleted`; artifacts must not encode that.

They additionally direct me to exclude, and I do: the worktree `path`/`workdirPath` (host-local,
already covered by §6.1), the **operational allocation state**
(`preparing/ready/cleanup_pending/missing/failed`, which lives on a separate non-entity table,
**flaps**, and must never enter an immutable snapshot), and `leaseSessionId`.

**`build`** — **reproducibility rests on resolved commit OIDs plus a dirty-tree digest, never refs
alone.** A ref is a mutable pointer: `baseRef: "main"` is close to worthless six commits later. The
OID is the fact; the ref is a human-readable label. `dirty` closes the remaining hole: most
generated bundles are built from a working tree matching no commit, and recording only
`sourceCommitOid` for a dirty tree is an **actively misleading** record that claims reproducibility
which does not exist. So if `dirty` is true, `uncommittedTreeDigest` is required; if it cannot be
computed, it is null and **the UI must say "built from uncommitted changes, contents not recorded"**
rather than showing the commit as though it were the source.

**`build` is not the solid part of this envelope, and the earlier draft read as though it were.**
The worktrees worker verified for me that **there is zero Git invocation anywhere in
`packages/*/src`** — no git subprocess, no `simple-git`, no `isomorphic-git`; the only process
spawning in product source is `node-pty` and the Postgres sidecar. So `sourceCommitOid`, `dirty`
and `uncommittedTreeDigest` are **not computable by any code that exists today**, on exactly the
same footing as the worktree block. Their Phase 1 builds the argv-only Git invoker such a facility
would sit on but does **not** commit to exposing a git-facts read; assume **Phase 2 at the
earliest**. Until then `build` is honestly `null` — which is the correct outcome, not a gap.

**Digest algorithm** (mine; they have no shipped algorithm and defer to it): per tracked,
non-ignored file take `{path (NFC), mode, sha256(content)}`, sort by path UTF-8 bytes,
JCS-serialize, SHA-256. Same canonicalization discipline as the manifest, deliberately — one rule
in the codebase, not two.

**One hard requirement, from a hazard this program already measured:** tm8 observed **four
different digests for byte-identical files** computed from four different directories. So the paths
that are sorted and hashed **must be relative to a declared root, and the root must be named in the
recipe.** For anything worktree-scoped the declared root is the worktree directory — never the node
data dir, never process cwd. The recipe is stored beside the digest, not assumed. A digest whose
root is implicit is not a digest, it is a coincidence.

### 6.1 Exclusions

| Excluded | Why |
|---|---|
| `workingDir` / `workdirPath` | Host-local absolute path. Leaks directory layout and username into an object designed to be exported and backed up; meaningless on any other machine. Also *supplies* path data to a system whose S11 discipline is that paths are server-computed, never carried. |
| node data-dir / blob paths | Same, plus location is not identity — a restore that moves the data dir must not invalidate provenance. |
| model, provider | **Execution** metadata, not **source** metadata; recording it here breaks agnosticism at exactly the point where breaking it is most tempting. Reachable via `sourceWorkSessionId`. |
| agent tool, **interaction profile pin** | Same category. How the work was driven is not what it was built from. The profile pin is called out explicitly at the worktrees worker's request: it is pinned per session at spawn and therefore *reads* like provenance, which makes it the most likely of these to be added by mistake. |
| worktree allocation state, `leaseSessionId` | Operational disk health, on a separate non-entity table. It **flaps**; an immutable snapshot must never contain a value that changes for reasons unrelated to the artifact. |
| prompt text | Execution metadata, and the field most likely to contain secrets, personal data, and pasted credentials. Zero reproducibility value for a static bundle — the bytes are the bytes. |
| the manifest hash | Already a first-class column; duplicating invites disagreement. |
| any signed URL or token | Expiring values must never be frozen into an immutable record. |

### 6.2 The nullability rule

**Facts tm8 cannot honestly supply today are explicitly `null`. Never invented, never defaulted to
a plausible-looking value, never omitted.** Omission and null differ: omission means "this schema
version lacked the concept", null means "the concept exists and we did not know the value". So
every key is always present and unknown values are null.

Honestly supplied **today**: `schemaVersion`, `publishedAt`, `spaceId`, `sourceWorkSessionId`,
`launchProjectId`, `associatedProjectIds`, and within `project` the `projectResourceId` and
`repoUrlAtPublish`. **That is the complete list.**

Everything under `worktree` **and everything under `build`** is null — both objects entirely — and
the two are on the same footing, which the earlier draft obscured. `worktree` is null because the
kind does not exist; `build` is null because **no Git facility exists in the product source at
all** (§6, `build`). Neither is a case of "we have the data and did not wire it up".

Timeline, so the plan is honest about it: the six `worktree` fields become available when the
worktrees Phase 1 lands (they are stored columns, servable from a read with no Git call). The three
`build` fields need a git-facts read facility that is **Phase 2 at the earliest**.

A Phase-1 artifact therefore has honest, useful, **substantially incomplete** provenance — the
correct state, and far better than a complete-looking record containing guessed OIDs. The UI must
render nulls as "not recorded", never as blank or zero.

---

## 7. Relations and the naming collisions

### 7.1 Edges

Three server-owned widenings. All three are **DB-only** changes: the contract types edge `type` as
a bare `string` and carries no source/target matrix (`contract.ts:764-766`), and constraints live in
`internal.validate_edge()` (`001_core_graph.sql:795-804`).

| Edge | Change | Registry row |
|---|---|---|
| `authored_from` | `src_kinds` gains `artifact` | `015_w1_foundations.sql:41-42` |
| `in_project` | `src_kinds` gains `artifact` | `015:35-36` |
| `attached_to` | `src_kinds` gains `artifact` (context attachment) | `001:906-908` |

**Widening `src_kinds` is not sufficient.** Three additional gates exist that the registry row does
not show — verified, and communicated to both sibling workers because they hit the same wall:

1. **Writer ownership** (`015:615-624`): every `authored_from` insert must present
   `writer = 'message_recorder'` or it raises `42501`. This design widens that branch to a per-type
   **permitted-writer set** and claims the token `artifact_publisher`. Reusing the literal
   `message_recorder` was the cheaper option and is rejected: the token would then lie about what
   it records, and the next reader of the guard has to know that.
2. **A unique index assuming one edge per source** (`015:295-296`):
   `create unique index edges_authored_from_message_idx on public.edges(src_id) where type = 'authored_from'`.
   Correct for artifacts — an artifact has exactly one originating session — so it is kept. The
   index **name** becomes misleading once it covers three kinds and should be renamed in whichever
   migration widens it.
3. **`props.origin` is force-stamped** to `materialized` for `authored_from` (`015:631-633`), and
   supplying it with an empty writer raises (`015:628-630`). Publishers must not send it.

Also relevant for `in_project`: the guard requires the target project to be **actively linked** to
the space (`project_not_linked`, `015:667-690`), and stamps `props.origin` from the writer
(`015:630-631`). Artifacts inherit both.

### 7.1a Migration coordination — a shared prerequisite, not a convention

Two hazards of the same class sit between the three in-flight features, and both are silent.

1. **`edge_types.src_kinds` array rewrites.** Two migrations each appending to the same array: the
   lexically later filename wins and the earlier widening is gone.
2. **The guard function body.** `internal.guard_w1_edge()` is
   `db/migrations/015_w1_foundations.sql:592-703` — roughly 112 lines, trigger `edges_w1_guard`
   attached at `:704`. `create or replace` swaps the **entire body**, so two migrations
   re-declaring it silently destroy each other's branches. No error, no conflict, and no test
   failure unless someone happened to test the exact branch that vanished. Migrations are immutable
   once applied (per-file checksum ledger, `db/migrate.mjs:203-212`), so recovery is a *third*
   migration — after somebody notices. (Surfaced by the worktrees worker; I confirmed the line
   range and the whole-body replace semantics.)

Relying on "whoever lands first, everyone else re-applies their changes" makes the correctness of
three migrations depend on three people remembering an unwritten rule.

**Decision: neither hazard lives in a feature migration.** One shared prerequisite —
`db/migrations/051_edge_guard_multi_kind.sql` — lands **before** all three feature migrations.
**Agreed by both siblings.** Ownership sits with the artifacts lane; migration numbers are now
`051` shared, `052` artifacts, `053` memories, `054` worktrees.

#### The complete contract for `051` — all three features, negotiated, nothing left implicit

**Registry rows (outside the function).**

| Change | For | Note |
|---|---|---|
| `authored_from.src_kinds` → `['message','memory','artifact']` | memories + artifacts | one statement, both kinds at once |
| `in_project.src_kinds` += `artifact` | artifacts | |
| `attached_to.src_kinds` += `artifact`, `memory` | artifacts + memories | |
| `authored_from.description` → kind-neutral | all | currently reads "…work-session **message** provenance" |
| rename `edges_authored_from_message_idx` | all | ⚠ **rename only** — the UNIQUE constraint itself is correct for all three features and must **not** be dropped or widened. One `authored_from` per source is what makes the memories worker's verification-independence check well defined, and it matches artifacts' one-session-per-artifact rule. |

`in_worktree` is a brand-new `INSERT`, not a widening, so its registry row stays in the worktrees
feature migration.

**Function body — `create or replace internal.guard_w1_edge()`, exactly once.** Two branches, five
lines apart, and **my original proposal named only the first.** The worktrees worker corrected it;
the omission would have shipped:

1. **Recorder-ownership**, `015:615-624`. The single equality
   `coalesce(writer,'') <> 'message_recorder'` becomes a **per-type permitted-writer set**:
   `authored_from → {message_recorder, memory_recorder, artifact_publisher}`.
   `in_worktree` stays **out** of this branch — that is what keeps it ordinarily mutable.
2. **`props.origin` stamping**, `015:630-631` — verified:
   ```sql
   if new.type in ('in_project','participates_in') then
     new.props := new.props || jsonb_build_object('origin', coalesce(nullif(writer,''),'user'));
   ```
   **`in_worktree` joins this list**, so a spawn-created association is distinguishable from a
   hand-drawn one. One array element. That is the worktrees lane's entire ask on `051`.

**Two documentation requirements, both requested by the siblings and both correct:**

- The migration header must state that this file is a **shared prerequisite owned by no single
  feature**, and name the three features depending on it — otherwise the next person needing a
  guard branch will `create or replace` it again and we are back here.
- The reason `in_worktree` is **absent** from the recorder-owned set must be a **SQL comment inside
  `051`**, not only in a proposal document. The proposal is not what the next reader will grep.

**One branch nobody has claimed, flagged so it is a decision rather than a discovery.**
`015:635-637` gates *changing* `props.origin` on `UPDATE` to a writer allowlist
(`project_correction, handoff_recorder, message_recorder, profile_pin, profile_default`). None of
the three new tokens is in it. That is fine today — all three features write `authored_from` once
and never update it — but any future compensation or correction path that touches an existing
edge's origin will fail with `42501` until its token is added there too.

After `051` lands, every feature migration is purely additive — tables, kind seeds, RPCs — and no
shared object is re-declared twice.

Writer tokens, allocated without collision: `artifact_publisher` (artifacts), `memory_recorder`
(memories), `worktree_manager` (worktrees).

### 7.2 The three `artifact` name collisions

**(a) The feed presentation discriminator — rename to `entity-change`. Cheap; do it in Phase 0.**
`packages/tm8-ui/src/channel-screen/feed-model.ts:212-221`:

```ts
export type ActivityPresentation =
  | { kind: 'artifact'; entity: EntitySummary; verb: 'created' | 'updated' }
  | { kind: 'state'; label: string; from: string | null; to: string }
  | { kind: 'event'; label: string }
  | { kind: 'unknown' };
```

Complete inventory: the declaration (`feed-model.ts:218`), the single construction site
(`:240`), the single consumer branch (`FeedRow.tsx:500`), and one test assertion
(`feed-model.test.ts:205`). **Not on the wire** — the contract's feed union discriminates on
`itemKind` with exactly two members (`contract.ts:1427-1428`), and the string `artifact` appears
**zero** times in `packages/contract/src`. TypeScript exhaustiveness makes any miss a compile
error. No server, contract, migration, or persisted-URL impact. The CSS class `.chs-artifact` and
`data-testid="chs-artifact"` are independent of the discriminator and can be left alone or renamed
separately.

**(b) `:artifactId` as a catalog path parameter — leave the wire alone, rename the placeholder.**
`packages/contract/src/catalog.ts:155`:
`{ name: 'projects.associations.correct', path: '/v2/entities/:artifactId/commands/correct-project-association' }`.
Here "artifact" means "the PR/commit/task entity whose project association is being corrected" —
an entirely different concept that will read as *the artifact entity* once artifacts exist. The
placeholder is **not** part of any real URL (the wire carries `/v2/entities/<uuid>/commands/...`),
so renaming it to `:subjectId` is a pure source change. Recommended, low priority, with the caveat
that a test may assert the literal template string and must be updated with it.

**(c) The internal `'artifact' | 'project'` prefix** in
`packages/server/src/facade/services/w2/projects-associations.ts:143,156,177` (plus `artifactSummary`,
`row.artifact_kind`, and `artifactId` in `packages/tm8-ui/src/data/project/reducers.ts`). Same
concept as (b), internal identifiers only. Rename for readability when that file is next touched;
not a blocker.

---

## 8. API, CLI and UI surfaces — against the current catalog

### 8.1 Catalog operations

Today: **110** rows (108 v1 + 2 reserved). This design adds **six**, taking the catalog to **116**
(114 v1 + 2 reserved).

**The count is asserted in far more places than the brief or a casual reading suggests** — see
§A.3. `110` is hard-coded in **nine** test files, `15` (core kinds) in three more, and
`w1-amendment.test.ts:44-58` additionally pins **method and kind histograms**
(`{GET: 40, POST: 44, PATCH: 10, DELETE: 8, PUT: 7, WS: 1}` and
`{read: 43, command: 66, stream: 1}`), so adding six operations breaks two histograms as well as
nine counts. Adding a catalog row also changes `CATALOG_DIGEST`
(`sha256(JSON.stringify(OPERATIONS))`, `packages/cli/src/discovery/operations.ts:1308-1310`),
which forces regeneration of `tools/conformance/generated/w1-conformance-manifest.json`. This is
mechanical, but it is a sweep, not three edits — budget it as such.

| Operation | Method | Path | Kind |
|---|---|---|---|
| `artifacts.create` | POST | `/v2/artifacts` | command |
| `artifacts.publish` | POST | `/v2/artifacts/:artifactId/revisions` | command |
| `artifacts.revisions.list` | GET | `/v2/artifacts/:artifactId/revisions` | read |
| `artifacts.preview.start` | POST | `/v2/artifacts/:artifactId/preview-sessions` | command |
| `artifacts.export` | GET | `/v2/artifacts/:artifactId/revisions/:revisionNumber/export` | read |
| `artifacts.restore` | POST | `/v2/artifacts/:artifactId/commands/restore-revision` | command |

Naming follows the existing convention exactly (`files.uploadInit`, `messages.attachments.add`,
`projects.associations.correct`).

**Reads reuse the generic surface**: `entities.get`, `entities.list`, `entities.feed`,
`entities.patch`, `entities.delete` all work on artifacts through the envelope. No bespoke
`artifacts.get` — that would be a parallel API, which T-L12 forbids.

**`artifact` must be a restricted kind for `entities.create`**, joining `project` and
`interaction_profile` (`discovery/operations.ts:344-356`: "restricted kinds refuse generic creation
and use their named writers"). Creating an artifact entity without a bundle revision is
meaningless — the deferred `artifacts_has_revision` constraint would reject it at commit anyway, so
refusing at the door gives a comprehensible error instead of a constraint violation.

**Blob upload reuses `files.uploadInit` / `files.uploadComplete`** and the existing raw PUT seam
(`packages/server/src/http/w2-file-upload.ts`) — Phase 1 uses the shipped grant machinery rather
than minting a parallel upload path. `artifacts.publish` then references already-uploaded blobs by
`sha256`. A batch-grant optimization (one round trip for up to 128 blobs) is a Phase-2 refinement,
not a Phase-1 requirement.

**Publish is atomic**: entity, revision, entries, blob references, edges, and the non-debounced
entity version all commit in one transaction, in one RPC. `expectedVersion` and `clientMutationId`
are required on `artifacts.publish` and `artifacts.restore`, matching the conventions the CLI
already enforces (`--expect-version` mandatory on updates, `entity.ts:557-561`).

### 8.2 CLI

Grammar is `tm8 <noun> [<subnoun>] <verb>`, registered **statically** in two places that answer two
different questions: `packages/cli/src/commands/registry.ts` ("what can this build execute?") and
`packages/cli/src/discovery/operations.ts` ("what does the grammar contain?"). Missing the second
yields exit 8 ("documented, not built here") instead of exit 2 ("unknown command"), so both are
mandatory.

```
tm8 artifact publish <dir> [--space <space-id>] [--name <name>] [--description <text>]
                           [--entrypoint <path>] [--attach-to <entity-id>...]
                           [--artifact <artifact-id>] [--expect-version <n>]
                           [--mutation-id <id>]
tm8 artifact get <artifact-id>
tm8 artifact revisions <artifact-id>
tm8 artifact export <artifact-id> [--revision <n>] [--out <path>]
tm8 artifact preview <artifact-id> [--revision <n>]        # prints the URL; opens nothing
```

`artifact publish` is a **composed** command in the established sense — one caller-visible
invocation performing manifest construction, N blob uploads, and `artifacts.publish` — exactly as
`file upload` composes `files.uploadInit` + grant transfer + `files.uploadComplete`
(`packages/cli/src/commands/file.ts:3-11`). It must honour the cross-cutting conventions:
`assertKnownOptions` (an unlisted flag is exit 2 quoting the frozen syntax string),
`clientMutationId` on every mutation, `refuseMutationId` on every read, and `--format
human|json|jsonl` rendering the same DTO.

`artifact preview` **prints a URL and does not open a browser**. Opening one from a CLI would be an
outward-facing side effect the user did not ask for, and the URL is short-lived and viewer-bound
anyway.

### 8.3 UI

The UI is `packages/tm8-ui` (dev port **4612**, charter-fixed; `packages/ui` on 4611 is the
condemned old UI and is not touched).

- **Registry row** in `packages/tm8-ui/src/domain/registry.ts`, following the 16 existing rows.
  Slug `artifacts` — verified free; the reserved list is `home, feed, inbox, workspace, channel, e,
  k` (`registry.ts:35-44`). Strategy `collection`, panel archetype **`generic`** with a new ordered
  content block `artifact-preview` — the same shape `file` uses with `file-preview`
  (`registry.ts:554`), and much cheaper than a ninth `BodyArchetype`.
  **This row is not optional**: `registry.test.ts:39-51` asserts totality over
  `CoreEntityKindSchema`, so adding the kind to the contract without a registry row fails the
  build. Another deliberate completeness net.
- **Route** needs no new grammar: `#/s/{spaceId}/e/{entityId}` already addresses any entity
  (`packages/tm8-ui/src/routes/codec.ts:257-261,274-294`).
- **The panel** shows name, description, revision number, file count, total size, provenance, a
  revision list, an **Export** button, and a **Run** button. The iframe does not exist in the DOM
  until Run is clicked (§9.5).
- **Any new badge must be added twice** — `badgesOf` in `packages/server/src/facade/entity-read.ts`
  **and** the projector twin in `packages/server/src/events/projector.ts`, or the event feed and the
  REST read disagree. (Credit: the memories worker surfaced this trap.)
- **Caveat on the current UI state:** the shipped `GateApp.tsx` still drives the centre with local
  `activeTarget` state (`views/GateApp.tsx:299-320,369-416`) rather than the route codec, and
  several views render `data-testid="unbuilt-view"`. The artifact panel must be mounted into
  whatever the host is at the time; this design does not assume the codec is already the driver.

---

## 9. Preview and sandbox — the security design

This is where the design spends most of its risk budget, because it executes generated JavaScript
inside a privileged application that currently has **no CSP, no iframe, no CORS, and no
authentication** (§1.2 C5, §1.3).

### 9.1 Why a separate origin — the argument the `allow-scripts` answer misses

An iframe with `sandbox="allow-scripts"` and no `allow-same-origin` already gets an **opaque
origin**, so bundle JS cannot read the app's cookies, storage, or DOM even if the frame's URL is
same-origin with the app. So why insist on a separate origin, especially when tm8 is same-origin by
deliberate architecture (§1.3)?

**Because the preview URL is reachable outside the iframe.** It is a normal URL. A user can paste it
into the address bar; a link can target it; a redirect can land on it; a future feature can add
"open preview in a new tab". In every one of those cases the bundle loads as a **top-level document
with the full privileges of whatever origin served it**. If that origin is the app's, generated
JavaScript is now running with the app's cookies, the app's `localStorage`, the app's service-worker
scope, and same-origin access to every `/v2/*` route — which, given auto-owner auth, is *everything
the user can do*.

The sandbox attribute protects the framed case. Origin separation protects the unframed case — and
the unframed case is the one that arrives by accident, six months later, in someone else's patch.
Both are required; neither substitutes for the other.

Two weaker but real reasons: it keeps a future `allow-same-origin` mistake from being catastrophic,
and it lets the preview run `default-src 'none'` without fighting the app's own needs.

### 9.2 The boot check

At startup, compute `appOrigin` and `previewOrigin` as normalized `scheme://host:port` triples
(lowercased, explicit port, IDNA-normalized), then:

```
if (previewOrigin === appOrigin) refuse to start
if (previewHost   === appHost)   refuse to start   // port-only separation is not separation
```

The **second** check is the one that matters and the one that is easy to drop. Port-only separation
satisfies the browser's origin comparison but **not cookies, which ignore port**. The moment tm8
issues a session cookie for host `localhost`, a preview served from `localhost:4613` receives it.
So the rule is a *host* rule, enforced at boot before any listener binds — not a lint, not a doc
note.

This **refuses to boot the whole node**, deliberately: a node silently serving artifacts from its
privileged origin is worse than a node that does not start. The error must name both origins and
the config keys that set them.

### 9.3 Why S2 is not a neighbouring gate but the mechanism itself

The brief lists S2 Host, S3 Origin, S4 CORS and S6 CSRF as release gates standing beside origin
isolation. Verification shows S2 is *part of* it.

`appOrigin` differs between dev and production: dev is `http://127.0.0.1:4612` (vite), production is
`http://127.0.0.1:4610` (the node serving `TM8_UI_DIR`). Pick `previewOrigin` as a distinct
hostname and the boot check passes in both. **But a hostname is only distinct if the other listener
refuses it.** The node binds `127.0.0.1` and `LOOPBACK = {'127.0.0.1','::1','localhost'}`
(`http/config.ts:62`), so absent a Host allowlist the app socket answers to *every* loopback name it
is reached by. Naming the preview host `localhost` while the app also answers to `localhost` gives
two names for one socket, and the "separation" is cosmetic.

**Therefore: S2 must be implemented as the mechanism that makes §9.2 true — the app listener's
allowlist must exclude the preview hostname, and the preview listener's allowlist must contain only
the preview hostname.** Plus, per C3, the WS upgrade path needs its own wiring; `security.ts` alone
does not reach it.

Canonical local pair: app `http://127.0.0.1:4610` (dev `:4612`), preview
`http://artifact-preview.localhost:4613`. The `.localhost` TLD is reserved to loopback by RFC 6761
and Chrome and Firefox resolve `*.localhost` in-browser without a hosts entry. **Honest caveat:**
this is not universal — the macOS system resolver does not resolve arbitrary `*.localhost`, so
non-browser tooling and some browsers may need an `/etc/hosts` entry. Phase 0 must **test** this on
the target browsers rather than assume it, with a documented fallback to plain `localhost:4613` (a
distinct host from `127.0.0.1`, and adequate until cookies exist).

### 9.4 Sandbox and headers

```html
<iframe sandbox="allow-scripts"
        src="<previewOrigin>/p/<sessionId>/"
        referrerpolicy="no-referrer"></iframe>
```

`allow-scripts` and nothing else. Explicitly never `allow-same-origin` (defeats the opaque origin;
combined with `allow-scripts` a frame can strip its own sandbox attribute), `allow-top-navigation*`
(phishing and exfiltration), `allow-popups` (a popup is an unframed document again),
`allow-downloads` (the host owns export), `allow-forms` (navigation-shaped egress),
`allow-modals` (`alert` blocks the app's event loop), `allow-pointer-lock`, `allow-presentation`,
`allow-storage-access-by-user-activation`.

The preview listener is a **separate router sharing no middleware**: no `/v2/*` routes, no API
routes of any kind, no cookie parsing, no `Set-Cookie`, and no auth middleware beyond capability
resolution.

Headers on every preview response: `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
`Cache-Control: no-store`, `Cross-Origin-Opener-Policy: same-origin`,
`Cross-Origin-Resource-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp`, an
all-deny `Permissions-Policy` (`accelerometer, ambient-light-sensor, autoplay, battery, camera,
display-capture, encrypted-media, fullscreen, geolocation, gyroscope, idle-detection, local-fonts,
magnetometer, microphone, midi, payment, picture-in-picture, publickey-credentials-get,
screen-wake-lock, serial, storage-access, usb, xr-spatial-tracking` each `=()`), and:

```
Content-Security-Policy:
  default-src 'none';
  script-src  <previewOrigin> 'unsafe-inline' 'unsafe-eval';
  style-src   <previewOrigin> 'unsafe-inline';
  img-src     <previewOrigin> data: blob:;
  font-src    <previewOrigin>;  media-src <previewOrigin>;
  connect-src 'none'; worker-src 'none'; object-src 'none';
  frame-src   'none'; child-src 'none'; manifest-src 'none';
  base-uri    'none'; form-action 'none';
  frame-ancestors <appOrigin>;
  sandbox allow-scripts;
```

Three notes stated rather than hidden:

- **`'unsafe-inline'` and `'unsafe-eval'` are kept on purpose.** The threat model is not "XSS into a
  trusted page" — the whole document *is* attacker-controlled by assumption. Nonces and hashes buy
  nothing when the adversary authors the markup. What actually contains the bundle is
  `connect-src 'none'`, the opaque origin, and the absence of anything privileged on that origin.
  Claiming otherwise would be theatre.
- **`sandbox allow-scripts` appears in the CSP header, not only the iframe attribute.** This is the
  fix for the unframed case: a top-level load of the preview URL is *still* sandboxed into an opaque
  origin because the header travels with the response. **This is the single most important line in
  the policy.**
- **`frame-ancestors <appOrigin>`** stops a third-party page framing a leaked preview URL. It does
  not stop top-level navigation to one; the TTL and viewer binding do.

### 9.5 Capability tokens, and Run is a click

`POST /v2/artifacts.preview.start` on the **privileged** origin returns `{ previewUrl, expiresAt }`.
The token behind it is a **database row** (`artifact_preview_sessions`), not a signed stateless
token, because **revocation must be immediate on delete** and a stateless token cannot be revoked
without a denylist that is this table with extra steps. Cost is one indexed lookup per asset
request, bounded by 128 assets. Accepted.

Scope is `(artifact, revision, viewer, TTL)`; TTL 10 minutes, refreshable. Asset lookup is
`WHERE revision_id = $1 AND path = $2` — an equality match against a stored path, so **there is no
filesystem traversal surface at all**; blobs are then read by content hash, never by a
client-influenced path. Every asset request re-checks: not expired, not revoked, artifact not
soft-deleted, and the viewer still authorized under ordinary RLS. Revocation on delete is therefore
both explicit (`revoked_at`) and implicit (RLS stops answering).

**Preview never autoruns.** The panel shows metadata and a **Run** button; the iframe is not created
until the user activates it. This makes execution an intentional act, keeps list and feed rendering
from executing anything, and gives the UI a natural place to show size, file count and provenance
*before* execution.

### 9.6 Export

Served from the **privileged** origin as `application/zip` with `Content-Disposition: attachment`
and `nosniff`. Deterministic: entries in manifest order (already canonical), no directory entries,
all timestamps fixed to 1980-01-01T00:00:00Z, external attributes `0644`, one frozen compression
choice, no extra fields, no comment. Consequence worth having: the zip's own SHA-256 becomes a pure
function of `manifestHash`, making "export is deterministic" a one-line test rather than a claim.

**Artifact HTML is never served through `files.download` or the app's static origin.** Enforced by a
test asserting the app router has no route matching the preview prefix and the preview router has
no route matching `/v2/`. The static handler's SPA fallback (§1.3) is an additional reason: a
missing asset there would return `index.html` with a 200.

---

## 10. GC, retention and purge

### 10.1 What must change in the current stub

Per C4, this is **two** pieces of work, and the brief's "make the sweep real" understates the first:

1. **Start a scheduler in production at all.** `packages/server/src/main.ts` never imports
   `scheduler/`. Until it does, supplying a sweep function changes nothing. This also fixes S18
   (backups have never run) — worth stating, because it is a larger win than artifacts and a larger
   risk than artifacts: turning on a scheduler that has never executed in production will surface
   whatever else those four jobs do.
2. **Supply the sweeps** via the existing injection seam `RetentionJobOptions.sweeps`
   (`scheduler/jobs/retention.ts:77-78` — "Anything absent stays a reporting stub"). The seam is
   already correctly shaped; nothing needs redesigning.

### 10.2 Retention

- **Soft delete** sets `entities.deleted_at` through `public.delete_entity`
  (`007_rpc_catalog.sql:1420-1463`), the sole writer, which soft-deletes the whole subtree in one
  transaction and issues an undo token. Artifacts inherit this unchanged.
- **On soft delete, preview grants are revoked immediately** — set `revoked_at = now()` on every
  live `artifact_preview_sessions` row for the artifact, in the same transaction. Not deferred to
  the sweep: a running preview must stop being servable at the moment of deletion.
- **Revisions and blobs are retained for 30 days**, matching the declared
  `retention.soft-delete-purge` policy (`retention.ts:63-67`).
- Restore (`public.restore_entity`, `007:1465-1504`) works unchanged, including its orphan guard.

### 10.3 The reference-aware mark and sweep

Blobs are shared, so deletion is refcount-driven, never delete-path-driven:

1. **Mark.** A blob is unreferenced when no `artifact_bundle_entries` row references it **and** (from
   Phase 2) no `files.blob_id` does. Set `unreferenced_since = now()` on transition.
2. **Grace.** Only sweep rows where `unreferenced_since < now() - grace` with grace **≥ 24 h**, and
   additionally never sweep a blob whose `created_at` is within the grace window. This closes the
   publish race: a blob uploaded but not yet referenced (its `artifacts.publish` still in flight)
   must not be collected out from under the transaction.
3. **Sweep.** In one transaction per blob: `SELECT ... FOR UPDATE` the `stored_blobs` row, re-check
   both reference sources under the lock, delete the row, then call `W2BlobStore.remove`. Row first,
   file second — if the process dies between them the file is orphaned on disk (recoverable by a
   separate reconciliation pass) rather than the row surviving with no bytes, which would present as
   a broken preview.
4. **The `on delete restrict` FK on `artifact_bundle_entries.blob_id` is the backstop**: if the
   refcount logic is ever wrong, the delete raises instead of silently breaking a live artifact.

`artifact_preview_sessions` rows expire and are pruned on the same daily cadence; expiry is
enforced at read time regardless, so pruning is hygiene, not security.

### 10.4 Hard purge

After 30 days, purge deletes the **entity**; `on delete cascade` removes `artifacts`,
`artifact_bundle_revisions` (whose append-only trigger must be proven not to block cascade — §5.2),
`artifact_bundle_entries` and `artifact_preview_sessions`. Blobs then become unreferenced and are
collected by the next sweep, not by the purge — one deletion authority for blobs, not two.

---

## 11. Phased plan, release gates and test matrix

### Phase 0 — freeze the contract, the security gates and the blob seam

Nothing executable ships. Gates, not polish.

| # | Item | Done when |
|---|---|---|
| 0.1 | Manifest schema + JCS canonicalization + hashing, in `packages/contract` | Strictness and vocabulary tests green (§4.4) |
| 0.2 | Six catalog rows; the full count sweep (§A.3) incl. both histograms; conformance manifest regenerated | All nine count files + `taxonomy.test.ts` green at 116 |
| 0.3 | `artifact` in `CoreEntityKind` + Zod enum + `entity_kinds` seed + `CORE_KIND_DISPOSITIONS` + UI registry row | `registry.test.ts` totality and `assertKindDispositionTotality` green |
| 0.3b | **`internal.entity_content` `artifact` branch + `loop_rpcs.test.mjs` assertion** (Hole 1, §A.1) | The assertion exists and fails when the branch is removed |
| 0.3c | **`projector.ts` twin arms** matching `entity-read.ts` (Hole 2, §A.1) | An artifact renders titled in the event feed, not just over REST |
| 0.4 | Feed discriminator renamed to `entity-change` | 4 sites; typecheck green |
| 0.5 | **S2 Host allowlist**, HTTP **and** the WS upgrade path | Negative tests: bad Host → 403, on both paths |
| 0.6 | **S3 Origin**, **S4 CORS**, **S6 CSRF** (`X-TM8-Client` on mutations) | Cross-site form-POST and rebound-Host mutation → 403/401 |
| 0.7 | Origin-isolation boot check (§9.2), incl. the host-equality arm | Node refuses to start on same-host config; test asserts the refusal |
| 0.8a | **Shared prerequisite migration `051_edge_guard_multi_kind.sql`** (§7.1a) — owned by one worker for all three features | Applies; edge widenings + permitted-writer set land once |
| 0.8b | `stored_blobs` table + RLS + write RPC; **no backfill** | Migration `052` applies; RLS negative tests green |
| 0.9 | Production scheduler started; soft-delete sweep made real | Sweep deletes a real expired row in an integration test |
| 0.10 | `.localhost` resolution verified on target browsers | Documented result + fallback decision |

**Release gate G-A0: no executable preview code merges until 0.5–0.7 and 0.9 are green.**

### Phase 1 — the vertical slice

Create, publish, show, preview, export. Self-contained relative assets only; external and
bare-specifier dependencies rejected. Provenance optional and honestly null (§6.2).

Includes: the four remaining tables; `publish_artifact_revision` RPC with the non-debounced version
write; the three edge widenings + the permitted-writer set; the preview listener and its router;
the capability-token flow; deterministic export; CLI `artifact publish|get|revisions|export|preview`;
the UI registry row, panel and Run button.

**Release gate G-A1:** the full negative test matrix below is green, and §12's two decisions have
been made by the user.

### Phase 2 — revisions, GC, portability

Revision UI and restore; the `files` → `stored_blobs` backfill (§5.4) with its verification pass;
blob GC sweep in production; backups covering `stored_blobs`; import/export of artifacts across
spaces; batch upload grants; the parent↔frame message bridge (explicitly **not** in Phase 1).

### Phase 3 — hardening

Deterministic dependency builder (so bundles may declare dependencies without fetching at runtime);
quarantine and scanning; **process-level quotas** — the only real answer to §12.1.

### Test matrix

**Positive.** Round-trip publish→get→preview→export; identical bytes from two different publishers
produce an identical `manifestHash`; export zip SHA-256 is a pure function of `manifestHash`;
restore creates a new revision; blob dedup across two artifacts in one space.

**Positive — the two silent holes (§A.1), which no generic test can catch.**

| Test | Asserts |
|---|---|
| `db/test/loop_rpcs.test.mjs` — artifact content assertion | `internal.entity_content` returns the artifact detail, not `{}` |
| Event-feed rendering of a published artifact | `projector.ts` `titleOf`/`stateOf` agree with `entity-read.ts`; the artifact is titled in the feed, not blank |

Both must be written by hand and both must be *seen to fail* with the branch removed — an assertion
that passes against `{}` is worse than none.

**Negative — security (all required for G-A1).**

| Test | Asserts |
|---|---|
| Publish into another space's artifact | `forbidden` (RLS) |
| Read a revision without membership | zero rows |
| Preview token for artifact A used on artifact B | `forbidden` |
| Preview token after `expires_at` | `unauthenticated` |
| Preview token after artifact soft delete | `forbidden`, immediately |
| Manifest path `../x`, `/x`, `a//b`, `.hidden`, non-NFC, case-dup | `invalid_input`, each |
| `mediaType` outside the allowlist | `invalid_input` |
| Declared `size` ≠ blob size | `invalid_input` |
| 129 files / 26 MiB | `limit_exceeded` |
| Unknown manifest key at any level | `invalid_input` |
| App router serves any preview path | **fails** |
| Preview router serves any `/v2/` path | **fails** |
| Preview response lacks `sandbox allow-scripts` in CSP | **fails** |
| Boot with `previewHost === appHost` | node refuses to start |
| Bad `Host` header, HTTP **and** WS upgrade | 403 on both |
| Cross-site form-POST mutation | 403/401 |
| Artifact HTML requested via `files.download` | not reachable |
| Two publishes, same actor, inside 5 minutes | **two** `entity_versions` rows |
| Blob referenced by a live entry, GC run | not deleted; FK holds |
| Blob unreferenced but inside grace | not deleted |
| Direct `UPDATE`/`DELETE` on a revision row | `42501` |
| Entity purge cascade through the append-only trigger | succeeds |

**Browser isolation (manual or Playwright, Phase 1).** Bundle attempts `fetch('/v2/...')` → blocked
by `connect-src 'none'`; `top.location = ...` → blocked; `document.cookie` → empty; `localStorage`
→ throws; loading the preview URL **top-level** → still opaque-origin sandboxed.

---

## 12. Threat model and residual risk

**Assets:** the user's filesystem and shell via PTY, provider API credentials, the graph DB,
transcripts, git repositories. **Adversary added by this feature: A5 — malicious or
prompt-injected bundle content executing in the user's browser.**

Ranked, with mitigation and honest residual:

| # | Threat | Mitigation | Residual |
|---|---|---|---|
| T1 | Bundle JS reaches `/v2/*` with owner identity | Opaque origin; `connect-src 'none'`; separate origin; S3/S4/S6 | **None if the Phase-0 gates land. Total compromise if they do not** — see below |
| T2 | Preview URL opened top-level, running as a privileged origin | Separate host + `sandbox` **in the CSP header** | Low; depends on the boot check being right |
| T3 | Bundle navigates the app away (phishing) | No `allow-top-navigation`, no `allow-popups`, `form-action 'none'` | Low |
| T4 | Path traversal via manifest paths | Equality lookup on stored paths; blobs by hash; W2BlobStore realpath + `O_NOFOLLOW` | Very low — there is no path API in the read route |
| T5 | Storage exhaustion | 128 files / 25 MiB / 8 MiB per file; blob dedup; GC | Medium until GC is real |
| T6 | Stale grants after delete | Stateful revocable tokens; revoke in the delete transaction; RLS re-check per asset | Low |
| T7 | Secrets leaked into provenance | `prompt`, `workingDir`, tokens all excluded by schema | Low; the strict schema makes additions deliberate |
| T8 | **CPU / memory exhaustion by the bundle** | Click-to-run; user closes the panel | **ACCEPTED — see §12.1** |
| T9 | **Network egress via self-navigation** | CSP, opaque origin, no top-nav | **ACCEPTED — see §12.1** |

**On T1, stated plainly:** today the server has no CORS check and no CSRF check, and every loopback
request is promoted to the node owner (C5). A malicious page can already land mutations. Adding
artifacts adds *attacker-authored JavaScript running on the user's machine* to that. The Phase-0
gates are not defence in depth for this feature — for T1 they are the **only** defence.

### 12.1 Accepted residual risk — requires an explicit user decision

> **RATIFIED 2026-07-31.** The user ACCEPTED the iframe CPU/memory/egress
> residual for MVP: ship with opaque sandboxing, CSP, the separate origin,
> quotas and click-to-run. This acceptance is recorded here deliberately
> rather than silently relied on. Hard limits / zero egress remain Phase 3's
> separate-renderer work, unchanged.

**A browser iframe cannot provide hard CPU or memory limits, nor perfect network-egress containment
against self-navigation.** This is a property of the platform, not a gap in this design.

- **CPU/memory.** A bundle can spin a busy loop or allocate until the tab is killed. `allow-scripts`
  is what makes artifacts useful at all, and it is also what makes this possible. The browser may
  degrade or kill the tab — taking the app's tab with it. There is no `Permissions-Policy`, CSP
  directive, or sandbox flag that caps compute.
- **Egress.** `connect-src 'none'` blocks `fetch`/XHR/WebSocket, and `img-src`/`font-src` are pinned
  to the preview origin. But a determined bundle retains side channels — timing, and any future
  relaxation of an `-src` directive. "Zero egress" is not achievable in an iframe and this document
  does not claim it.

**MVP mitigation:** opaque sandboxing, `default-src 'none'` CSP, a separate origin, click-to-run,
size and count quotas, and short-lived viewer-bound capabilities.

**If hard limits or absolute zero egress are required, previews need a separate renderer process or
container from Phase 1** — which is a materially different and larger project than the one designed
here. That is Phase 3's "process-level quotas", and pulling it forward changes Phase 1's scope
substantially.

**This is a decision for the user, not for the implementer. It must not be quietly designed
around.**

### 12.2 The second decision the user must make

> **RATIFIED 2026-07-31.** The same-origin architecture bends: the user
> approved the second origin as the loopback pair — app stays on
> `http://127.0.0.1:4610`, preview served from `http://localhost:4613`
> (`TM8_PREVIEW_HOST`/`TM8_PREVIEW_PORT`, listener in
> `packages/server/src/http/artifact-preview.ts`). The server refuses to boot
> if the two origins — or the two HOSTS — ever coincide (`http/config.ts`
> `resolvePreview`), and the refusal names both origins and both config keys.
> Consequence of the §9.3 partition: the app socket now REFUSES
> `Host: localhost` / `Origin: http://localhost:*`; the app is reached at
> `127.0.0.1` only.

**Does the same-origin architecture bend?** §1.3 shows tm8 is deliberately same-origin everywhere,
including a server-side relay for remote servers so that "browser CORS never becomes transport".
This design introduces a second origin and a second HTTP listener. That is the right call for the
reasons in §9.1 — but it is a real architectural departure, and it means the node grows a second
listener whose only job is serving untrusted content.

Note also that Phase 1's preview listener would run **in the same process** as the app. Origin
isolation is **not** process isolation: a crash or resource exhaustion on the preview listener
affects the app. That is consistent with T8 being accepted, and it is the same seam Phase 3 would
replace.

---

## 13. Coordination with the sibling designs

**Memories worker** (`sess_1785450778830_sv7mlxhn2`) — agreed, in `MEMO-MEMORY-SEAM-QUESTIONS.md`
A1–A4 and my reply:
- A1: widen the shipped `authored_from` rather than minting a provenance edge. **One migration must
  own the `src_kinds` widening** or two array rewrites silently drop each other.
- A2: no new pinned-reference edge type. An artifact revision references no entity in Phase 1 — only
  content hashes — so `copy_of` has nothing to point at yet; if that changes, `copy_of` with
  `props.pinnedVersion`, their convention verbatim.
- A3: they support the `entity-change` rename and reserve the word.
- A4: their provenance is live edges, mine is a frozen snapshot. Both correct: a memory asks "is
  what I believe still true?", which is only meaningful against current state, so drift is the
  signal; an artifact revision asks "what exactly was this built from?", which must answer
  identically forever, so drift would be corruption. **Consequence they must carry: a
  `source_provenance` snapshot goes stale by design and must never receive a staleness badge — their
  derivation must exclude `artifact_bundle_revisions.source_provenance`.**
- They surfaced the `badgesOf` ↔ `projector.ts` twinning trap (§8.3).
- I sent both siblings the verified `authored_from` writer-guard finding (§7.1), which blocks all
  three features and is invisible from the registry row.

**Worktrees worker** (`sess_1785450789291_ekks1smst`) — **replied and reconciled**; §6 has been
amended to match. Full exchange in `~/Desktop/tm8-artifacts-handoff/{Q-TO-WORKTREES,A-FROM-WORKTREES}.md`.

- **Confirmed** `worktreeEntityId`, `entityVersion`, `branch`, `baseRef`, `baseCommitOid` as their
  column names and semantics. They confirm `baseRef` is symbolic and not reproducible, and that
  `base_commit_oid` is resolved server-side at `git worktree add` time and immutable thereafter —
  built specifically so §6's OID rule is satisfiable rather than aspirational.
- **Rejected** `headCommitOid` and `treeDigest` from the worktree block as duplicates of the
  `build` fields. Accepted; §6 amended. Their reasoning is the one this document already applies
  elsewhere — two fields that can disagree about one fact are a quiet lie.
- **Confirmed** my `lifecycleStatusAtPublish` name over their `status`, as explicitly time-scoped.
  Enum: `active | merged | abandoned | deleted`, forward-only.
- **The uncomfortable answer to "what exists today": nothing.** Not one worktree field, **and not
  one `build` field either** — they verified there is zero Git invocation anywhere in
  `packages/*/src`. §6 and §6.2 were rewritten on this; the earlier draft read as though `build`
  were the solid part, and it was wrong.
- **Digest recipe:** mine wins, with their hard requirement folded in — paths relative to a
  **declared, named root**, because tm8 already measured four different digests for byte-identical
  files computed from four different directories.
- They asked me to add the **interaction profile pin** to the exclusion list explicitly (§6.1),
  since it is pinned per session at spawn and therefore reads like provenance.
- They surfaced the **`guard_w1_edge` whole-body-replace hazard**, which generalizes the
  `authored_from` finding I sent them; resolved by the shared prerequisite migration in §7.1a.
- My `authored_from` finding does not affect them: they use no `authored_from` edges, register
  `in_worktree` themselves as ordinarily mutable, and add no unique index to it.

---

## 14. Open questions

1. **§12.1 — accept the iframe CPU/memory/egress residual, or pull process isolation into Phase 1?**
   Blocks Phase 1 scope.
2. **§12.2 — accept a second origin and a second listener?** Blocks Phase 0 item 0.7.
3. **Does starting the scheduler (§10.1) need its own review?** It turns on four jobs that have never
   run in production, including `pg_dump` backups. Larger blast radius than artifacts.
4. **`.localhost` browser support** — Phase 0 item 0.10 must test, not assume.

**Resolved during this session** (recorded so they are not reopened): worktree field names and
nullability (§13 — confirmed, two fields dropped); the digest recipe and its declared-root
requirement (§6); the `authored_from` writer guard and writer-token allocation (§7.1); the
`entity-change` rename, supported by both siblings (§7.2); and the **shared `051` prerequisite
migration** — agreed by both siblings, owned by the artifacts lane, contract fully specified in
§7.1a with migration numbers `051` shared / `052` artifacts / `053` memories / `054` worktrees.

### 14.1 The two things a reader should not mistake

**This design is honest that `build` and `worktree` provenance are empty in Phase 1.** That is not
a gap to be closed before shipping — it is the correct state given that no `worktree` kind and no
Git facility exist. An artifact published in Phase 1 records *where and when and by which session*,
and says "not recorded" for *from which commit*. Shipping that is fine. Shipping a
complete-looking record with guessed values is not.

**The risk in this feature is not the kind, it is the sandbox.** Appendix A shows the kind-and-
catalog mechanics are large but heavily enforced by tsc and by nine count assertions. §9 and §10 —
the first CSP this server has ever emitted, the first iframe in this UI, a second origin in a
deliberately same-origin architecture, and switching on a scheduler that has never run in
production — are where the judgement is required and where review effort should go.

---

## Appendix A — Adding the core kind: verified touchpoints

Traced end-to-end against the `file` kind, cross-referenced with `project` and
`interaction_profile` (added in `015_w1_foundations.sql`, the cleanest "add a core kind in one
migration" precedent). This exists because most of the cost of this feature is not the design — it
is hitting every touchpoint, and **two of them fail silently**.

### A.1 The two silent holes — read these first

**Hole 1: `internal.entity_content` falls through to `{}`.** A kind with no branch yields an empty
jsonb object, which is *valid*, so nothing errors and no generic test can fail. The codebase says
so itself, in a note addressed to whoever adds the next kind
(`db/migrations/011_entity_content_missing_kinds.sql:103-108`):

> NOTE for whoever adds the next core kind: entity_content is the ONE place that needs to learn
> about it. There is no test that can fail generically for a missing branch, because `{}` is a
> valid content block — so `db/test/loop_rpcs.test.mjs` asserts the content of each kind the loop
> touches explicitly. Add yours there too.

**Two actions, both manual:** re-declare `internal.entity_content` in full with a
`when 'artifact' then ...` arm (current definitive version:
`017_w2_entities_commands_tracking.sql:16-46`), **and** add an explicit assertion in
`db/test/loop_rpcs.test.mjs`. Neither is optional and neither has a safety net.

**Hole 2: `entity-read.ts` ↔ `projector.ts` are twins enforced only by comments.** The REST read
projection and the event projector each compute `titleOf`, `excerptOf` and `stateOf` independently.
Parity is asserted by prose at `entity-read.ts:718` and `projector.ts:573` — **there is no test**.
Miss the projector arm and artifacts render correctly over REST while appearing untitled in the
event feed. The memories worker independently hit the same trap for badges (§8.3); it is the same
hole, and it is wider than badges.

Partial mitigation exists in one direction only: `projector.ts:63-83` throws `EntityKindDriftError`
if the DB carries a kind absent from `CoreEntityKindSchema` — so *forgetting the contract* is loud,
but *forgetting the projector arm* is silent.

### A.2 Ordered checklist

**Database — one new migration, `db/migrations/052_artifacts.sql`** (`051` is the shared edge-guard
prerequisite, §7.1a; it must land first and this file must **not** re-declare anything it owns).
Numbering is
`NNN_lower_snake_case.sql`, enforced by regex twice (`db/migrate.mjs:31`,
`tools/ci/migrations-check.sh:68`); ordering is lexical by filename only; gaps are legal (025, 026,
028 do not exist). Migrations are **immutable once applied** — the runner keeps a per-file SHA-256
ledger in `public.applied_migrations` and refuses on drift (`db/migrate.mjs:203-212`). This is a
checksum ledger, **not** a chained hash.

1. `insert into public.entity_kinds(kind, origin, space_id, icon) values ('artifact','core',null,…) on conflict (kind) where space_id is null do nothing;` — model `015:29-32`
2. `create table public.artifacts (...)` and the other four tables from §5.2
3. `create trigger artifacts_validate_kind ... internal.validate_detail_envelope('artifact')` — model `001:610`
4. **NO** `snapshot_entity_version` trigger — with the explanatory comment §5.2 demands
5. **`internal.entity_content` re-declared with the `artifact` arm** — ⚠ Hole 1
6. RLS in three places, all of which this migration must do itself because `008` is immutable: `alter table ... enable row level security`, `create policy artifacts_select ... using (internal.entity_readable(entity_id))`, and `grant select ... to tm8_app` — models `008:46`, `008:96-97`, `008:212-224`
7. `public.create_artifact_entity(...)` and `publish_artifact_revision(...)` as `SECURITY DEFINER` RPCs with the `ledger_replay` / `require_space_member` / `resolve_actor` / `record_activity` / `ledger_record` shape — model `017:62-85`; note `036_w2_sec1_stage2_entities_create_resource_binding.sql:330-332` supersedes `create_file_entity` for resource binding and a new kind needs the same treatment. Each ends with `revoke all on function ... from public; grant execute ... to tm8_app;`
8. Edge-type widenings per §7.1 (`authored_from`, `in_project`, `attached_to`) plus the permitted-writer set

**Contract (`packages/contract/src`).** 9. `contract.ts:33` `CoreEntityKind`. 10. `contract.ts:100`
`CoreEntityState` arm. 11. `contract.ts:217` `CoreEntityContent` arm. 12. `contract.ts:713` /
`schemas.ts:920-924` — **add `artifact` to the `entities.create` exclusion list**, joining
`message`, `member`, `work_session`, `project`, `interaction_profile` (§8.1). 13. `schemas.ts:82`
`CoreEntityKindSchema`. 14. `schemas.ts:~230` the `.strict()` `EntityStateSchema` arm. 15. New
`*Input` interfaces + `.strict()` `*InputSchema`, exported from `index.ts`. 16. Six rows appended
to `catalog.ts` before the closing `] as const satisfies readonly OperationBinding[]`.

**Server.** 17. `facade/services/w2/artifacts.ts` (service). 18.
`facade/handlers/w2/artifacts.ts` exporting `registerW2ArtifactHandlers` calling
`registry.registerAll({...})` — model `handlers/w2/files.ts:15-26`. 19. `facade/index.ts`: one
import (~`:53`) + one call in `registerFacadeHandlers` (~`:120`). 20. `facade/input-schemas.ts`:
bind every command; `UNBOUND_COMMAND_OPERATIONS` must stay empty — *"an omission here is a to-do,
not a decision"* (`input-schemas.ts:17-20`). 21.
`facade/services/w2/entities-commands-tracking.ts:56-63` — add `artifact` to
`RESTRICTED_LIFECYCLE_KINDS`. 22. `facade/entity-read.ts`: eight edits — `ENTITY_COLUMNS` (`:88`),
`ENTITY_FROM` join (`:121`), `EntityRow` (`:197`), `titleOf` (`:604`), `excerptOf` (`:624`),
`stateOf` (`:732`), `contentOf` (`:896`), `capabilitiesOf` (`:845-848`). 23.
**`events/projector.ts`: the twin edits** — `SUMMARY_SQL` (`:246`), joins (`:321`), `SummaryRow`,
`titleOf` (`:626`), `excerptOf` (`:671`), `stateOf` (`:764`) — ⚠ Hole 2.

**CLI.** 24. `discovery/operations.ts:164` — one `ROWS` entry per operation; the type is
`Record<OperationName, Row>`, so this is **tsc-enforced**. 25.
`discovery/operations.ts:1244-1280` — `artifacts: 'artifact'` in `NOUN_BY_FAMILY`; ⚠ **`nounFor()`
throws at module load** if missed, crashing the whole CLI suite. 26. `NOUN_SUMMARY` (~`:1525`).
27. `commands/artifact.ts` exporting `ARTIFACT_COMMANDS`. 28. `commands/registry.ts` — import +
spread. Help, completion and search need no edit: they are three renderings of the one table
(`operations.ts:38-41`).

**Conformance — a touchpoint easy to miss entirely.** 29.
`tools/conformance/src/foundations/kind-dispositions.ts` — a `CORE_KIND_DISPOSITIONS.artifact`
entry. **tsc-enforced** via `satisfies Readonly<Record<CoreEntityKind, KindDisposition>>` (`:268`),
and `assertKindDispositionTotality` (`:292-303`) throws from the manifest generator
(`generator.ts:326`). 30. Regenerate the manifest:
`bun run --cwd tools/conformance generate` — `check:generated` runs *before* vitest, so a stale
manifest fails the package outright.

**UI (`packages/tm8-ui`).** 31. A full `KindConfig` row in `src/domain/registry.ts` (§8.3). 32.
The `artifact-preview` block added to the vocabulary at `src/domain/types.ts:443-473` **and** a
`case` in `src/panels/bodies/GenericBody.tsx`. 33. `src/domain/registry.test.ts:71` —
`EXPECTED_SLUGS` entry. ⚠ Note the **kind-literal bans**: `no-kind-literals.test.ts` in
`files/`, `settings-governance/` and `authoring/`, plus `panels/no-branching.test.ts`, forbid
writing `'artifact'` outside `domain/`. Reach the kind through registry *data*, as
`src/files/port.ts:38-52` does by matching on the presence of a `file-preview` block.

**Counts and gates.** 34. The count sweep, §A.3. 35.
`packages/contract/test/w1-amendment.test.ts:77` — add `'artifact'` to the verbatim kind list; this
is the most direct "you added a kind" red. 36. `db/test/loop_rpcs.test.mjs` — ⚠ Hole 1. 37. Run
`bun run check` (`tools/ci/check.sh`), `bun run check:migrations`, `node db/test/run.mjs`.

### A.3 The count sweep

| Value | Files |
|---|---|
| `110` → `116` | `packages/cli/test/catalog-exhaustiveness.test.ts:33`; `discovery-operations.test.ts:49`; `kernel-global-collision.test.ts:292`; `discovery-availability.test.ts:36-40`; `help.test.ts:110-117,191-205`; `w5/f/discovery-honesty.test.ts`; `packages/contract/test/w1-amendment.test.ts:49`; `packages/server/test/w2/reserved-honesty.test.ts:119`; `w3/g15-public.test.ts:63`; `tools/conformance/test/w2-reserved-honesty.test.ts:31`; `foundation/w1-foundations.test.ts:159` |
| `108` → `114` (v1) | `w1-amendment.test.ts:50`; `discovery-availability.test.ts` |
| `109` → `115` (HTTP, i.e. minus the one WS row) | `catalog-exhaustiveness.test.ts:70,116,118,145` |
| `107` → derived | `help.test.ts:104` |
| `15` → `16` (core kinds) | `packages/tm8-ui/src/domain/registry.test.ts:47-49`; `tools/conformance/test/foundation/w1-foundations.test.ts:166` |
| Method histogram | `w1-amendment.test.ts:38-58` — `POST` +5, `GET` +1 for the six new rows |
| Kind histogram | `w1-amendment.test.ts:38-58` — `command` +4, `read` +2 |

Two live-server conformance behaviours also bind: `tools/conformance/test/taxonomy.test.ts:31-39`
asserts **every v1 GET must not answer 501**, so cataloguing `artifacts.revisions.list` or
`artifacts.export` as `v1` without a registered handler fails; and `HandlerRegistry.register`
(`packages/server/src/facade/registry.ts:38-55`) throws on an unknown name, a reserved name, or a
duplicate registration. Unregistered catalog rows answer an honest `501` (DEV-13).

### A.4 What this appendix implies for the plan

The kind-and-catalog mechanics above are roughly **half** the Phase-0/Phase-1 effort and are almost
entirely *sweep* work with strong automated enforcement — the exceptions being the two silent
holes, which need deliberate manual attention and a reviewer who knows to look for them. That is a
good ratio, and it is worth stating: the risk in this feature is concentrated in §9 (the sandbox)
and §10 (turning on a scheduler that has never run), **not** in adding the kind.
