# BRIEF — Artifacts: complete the design and implementation plan

You own **one** feature: **artifacts** in tm8 — generated HTML + JavaScript bundles that are stored
as first-class entities and viewable inside the app. Two sibling workers own memories and
worktrees; you will need to talk to them (see §7).

## 0. Provenance of this brief — read this first

Artifacts is the **newest** of the three features: there was no prior design, only a request. On
2026-07-30, session `sess_1785384914506_hkfpgm4zl` designed it from scratch against the shipped
code and reported its conclusions as chat messages. It **wrote nothing to disk** — **there is no
artifacts design document in this repository at all**. Its conclusions were recovered on
2026-07-31 into `docs/plans/TM8-NEW-ENTITIES-SESSION-DIGEST.md` §4.

Treat §3–§6 as **a strong prior from a competent reader, not as settled fact**. The user has not
ratified it. Where it conflicts with the current tree, **the tree wins** — and say so. Where you
think it is wrong, say that too.

The prior verdict was a **conditional GO**: the design is implementation-ready, but executable
preview must not ship until the Phase-0 security gates pass. Test that judgement rather than
inheriting it.

The originating request, verbatim from the user: *"i also want to add something called artifacts
which are html + javascript fiels genreated, and can be viewed on teh app itself."*

## 1. Your mission

Produce a **complete design and a phased implementation plan** for artifacts. You are writing the
document that does not yet exist.

You are **design-only**. Do not modify product source, do not run migrations, do not commit. The
working tree is dirty with other people's in-flight work — leave it alone. Writing your own new
documents under `docs/plans/` is expected and fine.

## 2. Read before you write

- `docs/plans/TM8-NEW-ENTITIES-SESSION-DIGEST.md` — §4 and §5 are yours
- `docs/tm8-architecture/10-SECURITY-MODEL.md` — the S-numbered gates; S2 Host, S3 Origin, S4 CORS,
  S6 CSRF are named as release blockers below. **Verify whether they are still unimplemented.**
- `docs/tm8-architecture/03-ENTITY-GRAPH-DELTAS.md`, `01-LAWS.md`

Current tree, to verify against:

- the `file` entity kind and the W2BlobStore path/checksum/token controls
- `packages/server/src/facade/entity-read.ts`
- the entity version debounce (previously described as a five-minute window) — you need publishes
  to be **exempt** from it
- the soft-delete purge scheduler — previously a **reporting stub**
- the UI entity registry and route table, plus the generic feed presentation discriminator
  currently named `artifact` (see the collision in §5)

## 3. The core decision

Add a **first-class core `artifact` entity** whose typed detail is the current **immutable
static-web bundle revision**.

Two alternatives were considered and rejected, and your document should record why:

- **A custom kind** — scalar-only, with no commands and no triggers. Insufficient.
- **A `file` or zip entity alone** — no bundle structure, no versioning, no provenance, no runtime
  policy. Insufficient.

## 4. Model agnosticism is a hard invariant

The manifest is `tm8.web-artifact/1`, runtime `web-static-v1`, plus an entrypoint and a sorted
`files(path, mediaType, size, sha256)` list. **No provider, model, agent tool, prompt, generator,
or storage URL** appears in the manifest or affects execution or validity.

A human, any model, a CI build, and an import all use the identical publish API and CLI. Identical
bytes produce the same manifest hash regardless of who or what generated them. Model and tool
details remain optional provenance reachable through a `work_session`, never part of artifact
identity. The preview runtime exposes no model SDK and no provider-specific JavaScript bridge. UI
language says **artifact**, never **AI artifact**.

This was stated as non-negotiable by the user in the originating session. Preserve it.

## 5. Physical model, provenance, and relations

**Storage.** An `artifacts` detail table; an append-only `artifact_bundle_revisions` table; an
`artifact_bundle_entries` table; and internal Space-scoped `stored_blobs` **shared with `file`
entities** after a compatibility backfill. The manifest is JCS-canonicalized and then SHA-256
hashed. A bundle revision is **not** the same thing as an entity version — but every publish must
create a **non-debounced** entity version and snapshot.

**Provenance** — refined jointly with the worktrees worker, who owns these primitives. Each bundle
revision stores an **immutable, versioned `sourceProvenance` object**, never a live project or
worktree DTO. Fields: `schemaVersion`, `publishedAt`, `spaceId`, `sourceWorkSessionId`,
`launchProjectId` (explicitly nullable, immutable launch origin) kept **separate** from sorted
`associatedProjectIds` — because `in_project` is a mutable M:N association and conflating the two
would silently rewrite history; a project snapshot of
`{projectResourceId, spaceProjectEntityId?, repoUrlAtPublish?, repoIdentity?}`; a worktree snapshot
of `{worktreeEntityId?, entityVersion?, branch?, baseRef?, baseCommitOid?, headCommitOid?,
treeDigest?, lifecycleStatusAtPublish?}`; and a build record of
`{sourceCommitOid, dirty, uncommittedTreeDigest?}`.

**Reproducibility rests on resolved commit OIDs plus a dirty-tree digest, never refs alone** — refs
and project metadata move after the fact.

Excluded deliberately: `workingDir` / `workdirPath` and node data paths, as host-local, sensitive
and non-portable; and model, agent tool and profile, as **execution** metadata rather than
**source** provenance.

Facts tm8 cannot yet supply — first-class worktree id/version/status and resolved OIDs — stay
**explicitly nullable rather than invented**. Today tm8 can honestly supply `spaceId`,
`workSessionId`, `launchProjectId`, the ProjectResource id and repo URL snapshot, and the session
base ref.

**Relations.** Widen the server-owned `authored_from` to artifact -> work_session, `in_project` to
artifact -> project projection, and use `attached_to` for context.

**Naming collision to fix:** the generic feed presentation discriminator currently called
`artifact` should be renamed to **`entity-change`** so it does not collide with the new kind.

## 6. Preview, sandboxing, lifecycle, limits

This is where the design spends most of its risk budget, because you are executing generated
JavaScript inside a privileged application.

**Origin isolation.** POST an authenticated, short-lived preview session on the **privileged
origin**, then iframe a **separate preview service on a separate origin**. Startup must **refuse to
boot** if the two origins coincide. A **distinct hostname, not merely a different port**, is
mandatory once cookie auth exists — the local canonical pair can be `127.0.0.1` for the app versus
`localhost` for preview.

**Sandbox.** iframe sandbox is `allow-scripts` **only** — never `allow-same-origin`, never
`allow-downloads`, `allow-forms`, `allow-popups`, or top-level navigation. Opaque origin. No parent
message bridge in the MVP.

**Preview service policy.** No API routes and no cookies. Capability scoped to
artifact + revision + viewer + TTL. `no-store`, `nosniff`, `no-referrer`, `frame-ancestors` the
app. Strict `Permissions-Policy`. CSP `default-src 'none'`, with an explicit preview origin allowed
for script/style/img bundle assets, and connect/worker/object/frame/form blocked. Network,
clipboard, storage and download are denied — the host controls export and copy. Export is a
deterministic zip served from the privileged origin.

**Bundles.** Self-contained relative assets only in the MVP; external and bare-specifier
dependencies are rejected. Limits: at most 128 files, at most 25 MiB total by default, path and
MIME rules, request/concurrency/rate caps, and **user-click Run** rather than autorun.

**Lifecycle.** Batch upload grants reuse the W2BlobStore path/checksum/token controls. Publish is
atomic: entity, revision, blob refs and edges together. Updates require `expectedVersion` plus
`clientMutationId`. Restore creates a **new** revision rather than mutating an old one. There is no
mutable draft entity. Delete revokes grants immediately; soft delete retains revisions and blobs
for 30 days; hard purge is a reference-aware mark and sweep.

**Release gates — prerequisites, not follow-up polish.** Implement tm8's currently deferred **S2
Host, S3 Origin, S4 CORS and S6 CSRF** checks. Never serve artifact HTML through `files.download`
or the app's static origin. No debounced artifact publish. Make the purge sweep **real** — it is
currently a stub. Add negative tests for RLS, capability scoping, path handling, CSP, and browser
isolation.

**Phases.** Phase 0 freezes the contract, the security gates and the `stored_blob` seam. Phase 1 is
a vertical slice: create, update, show, preview, export, with self-contained bundles and optional
provenance. Phase 2 adds revision UI and restore, GC, backups, import/export, and the bridge.
Phase 3 adds a deterministic dependency builder, quarantine and scanning, and process-level quotas.

**Residual risk requiring explicit acceptance:** a browser iframe **cannot** provide hard CPU or
memory limits, nor perfect network-egress containment against self-navigation. The MVP mitigates
with opaque sandboxing, CSP, a separate origin and process, quotas, and click-to-run. If hard
limits or absolute zero egress are required, previews need a separate renderer process or
container from phase one. Do not let this get lost — state it plainly and make the user decide.

## 7. Rebase facts and coordination

Verified against the working tree on 2026-07-31; **re-verify**. The catalog declares **110**
operations; the migration chain reaches **050**; edge `props_schema` validation shipped in **018**;
no `memory`, `worktree` or `artifact` kind exists in the contract today.

Siblings, spawned with you:

- **worktrees** worker — owns the provenance primitives your `sourceProvenance` snapshots. In the
  prior session they sent you the envelope in §5 and you adopted it. Confirm field names and
  semantics still agree, and confirm which worktree facts will actually exist by the time you need
  them versus staying nullable.
- **memories** worker — lighter overlap; do not invent a second vocabulary for the same provenance
  facts they are modelling.

Use `maestro session siblings` to find them and `maestro session prompt <id> --message "..."` to
talk. **Prose sent that way gets mangled by the shell**: backticks execute, and an apostrophe
truncates the message and runs the remainder as commands. The CLI prints a success checkmark
either way. Avoid backticks and apostrophes in messages entirely, or write to a file and send the
path.

## 8. Deliverable

Write to `docs/plans/TM8-ARTIFACTS-DESIGN.md` — this document does not exist yet and is the main
artifact of your task. It must contain:

1. The domain model and the rejected alternatives, with reasons.
2. The manifest format specified precisely enough to implement, plus the canonicalization and
   hashing rules.
3. Physical schema: tables, the blob-sharing seam with `file` entities, and the backfill plan.
4. The `sourceProvenance` schema, field by field, with nullability and the reason for each
   exclusion.
5. API, CLI and UI surfaces, stated against the **current** catalog.
6. The full preview/sandbox security design, with the origin-isolation boot check.
7. GC, retention and purge, including what must change in the current stub.
8. A phased implementation plan with explicit release gates and a test matrix, including the
   negative security tests.
9. An honest **threat model and residual risk** section. The iframe CPU/memory and egress limits
   above must appear as an explicit accepted risk, not be quietly designed around.

Report milestones with `maestro task report progress <taskId> "..."` and finish with
`maestro task report complete <taskId> "..."`.
