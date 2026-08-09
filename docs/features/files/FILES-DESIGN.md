# Files — browse and VIEW a connected project's working directory

Status: Phase 1 built, on `feat/files-browser` off `origin/main` `8720ea5`.
Task `019fe5d6-a363-7cd3-a42b-c9ed0ec87be7`.

## 1. What this is

A **Files** rail row that browses and views the real directories of a project
linked to this space, on the node that holds them.

It is not a copy, and it is not one graph entity per file. Both of those were
proposed and rejected; §1.1 says why.

### 1.1 The unit of storage is not the entity

A codebase is thousands of paths. Minting a `file` entity per path would put
thousands of rows, versions, activity records and edges into the graph to
describe something the filesystem already describes.

| Thing | Lives where |
|---|---|
| the bytes, the directory structure, the truth | the filesystem |
| a **reference** to one file, so it can be attached, discussed, cited | a `file` entity |

**A `file` entity is a link. The truth of the file is somewhere else.** An entity
is minted only when someone wants to *point at* a file — and that operation
already exists as `projects.files.attach`. **Browsing and viewing mint nothing.**

### 1.2 The measured blocker for reference entities

`db/migrations/001_core_graph.sql:599-608`:

```sql
storage_path text not null check (storage_path ~ '^spaces/[0-9a-f-]{36}/[0-9a-zA-Z._-]{1,120}$'),
unique (storage_path)
```

- `not null` + the CHECK ⇒ a `file` row can only name a blob tm8 itself
  uploaded. It cannot name `src/index.ts` inside project P.
- `unique (storage_path)` ⇒ two entities can never reference the same file,
  which is exactly what reference semantics require.

Phase 1 needs no migration because it mints nothing. A future "reference a file
without copying it" feature does. Deliberate sequencing, not an oversight.

## 2. This lane BUILDS ON an existing feature, it does not repeat it

`projects.files.list` and `projects.files.attach` already shipped (seam
Amendment 5, `files/project-folder-picker.test.tsx`). They list one directory
inside a connected project's working directory and attach a node-local file into
the graph as a blob.

An earlier revision of this lane added its own `files.browse` — a second way to
list a project directory, at the same file path, with a second containment
implementation. It was measured against main and dropped. **The only genuinely
missing capability was READING a file**: the group could list a directory and
attach a file but never SHOW one, so a viewer had nothing to render.

So Phase 1 adds exactly one operation.

| | `projects.files.list` (existing) | `projects.files.read` (this lane) |
|---|---|---|
| lists a directory | yes | — |
| reads one file's content | — | yes |
| jail | `browsableWorkingDir` + `containedBy` | **the same helpers, reused** |
| path vocabulary | absolute | **absolute, deliberately identical** |

One jail, one path vocabulary. Two of either would be an invitation to pass one
where the other is meant.

## 3. Rulings

Recorded from the task owner, 2026-08-09.

| # | Ruling |
|---|---|
| R1 | Browse source is the **live directory on the node**, not an uploaded snapshot. |
| R2 | Folder upload transport is **one archive, streamed, expanded server-side**. |
| R3 | Scope is **space-only**. No workspace-level library. |
| R4 | Prefer the smallest reachable surface over a bespoke one. |
| R5 | **No quotas.** |
| R6 | In scope overall: folder upload, in-app viewing beyond images, dedup + GC, agent write access. |

**Void:** an earlier ruling modelled folders as zero-byte `file` entities
reparented with `entities.move`. It was answered under the entity-per-file
framing that R1 replaced. Folders are directories on disk. Do not build it.

**R4 note.** R4 was answered as "mount the existing `file` kind row". That row
lists *entities*, which under §1.1 are references, not the filesystem. Phase 1
therefore adds one view ref (§5.3) — the smallest surface that can render a tree
at all.

## 4. Security model

The viewer is a remote read primitive. Defenses, none relying on another.

### 4.1 Containment (inherited, not reinvented)

`readProjectFile` uses `browsableWorkingDir` + `containedBy` on the **canonical**
path — the same pair `resolveProjectFile` already uses for attach. Resolving with
`realpath` is what defeats a symlink pointing out of the tree: a symlink is not
refused for existing, only for **escaping**. The refusal deliberately does not
echo the resolved path, which would be a filesystem oracle for paths outside the
project.

### 4.2 Secret masking (new, and specific to viewing)

Containment is not enough. A `.env` inside a project is inside the jail, and
showing it in a viewer turns "spawn an agent and cat the file" into one click.
This matters more for a viewer than for the attach picker, because reading is the
whole point of the screen.

`isSecretProjectPath` withholds `.env*`, `.ssh`, `.aws`, `.gnupg`, `.netrc`,
`.npmrc`, `.pgpass`, private-key material by extension, `secret`/`credential`
names, and **`.git/config`** — which routinely carries a token in a push URL —
while leaving the rest of `.git` and all of `.github` readable.

It is checked **twice**: before resolution, so a secret file's existence is not
confirmed by the shape of the failure, and again on the **resolved** path, so an
innocently-named symlink cannot launder `.env`.

**A denylist is not a security boundary and is not claimed as one.** The boundary
is §4.1 plus "only projects linked to your space". This raises the cost of casual
exfiltration.

### 4.3 Bounds

`MAX_INLINE_BYTES` is 5 MiB and is **not** the attach ceiling. `maxSizeBytes`
(512 MiB) governs what may be copied into the blob store; rendering that inline
would be a denial of service against the browser. Two questions, two limits.

### 4.4 Content-type posture

`projects.files.read` answers a **DTO**, deliberately not raw bytes like
`files.download`. Text rides a JSON field and the UI renders it into a `<pre>`.
Nothing off a project's disk is handed to the browser as a document on the app
origin. Renderable media travels as base64 into an `<img>`, and **`image/svg+xml`
is excluded** because an SVG *is* a document.

### 4.5 Not a new privilege

A member who can see a project can already spawn an agent into it — untrusted
projects are a confirmation gate, not a refusal
(`db/migrations/007_rpc_catalog.sql:2081`). A spawned agent has a shell, so
read-only viewing grants no capability a space member does not already hold.

> `packages/execution/src/spawn/workspace-trust.ts:31` claims `execution_spawn`
> *refuses* untrusted projects. Measured, it does not. The argument above uses
> the measured behaviour.

## 5. Surface

### 5.1 The one new read

`GET /v2/projects/:projectId/files/content?path=<absolute>` → `ProjectFileContent`.

`encoding` says which field carries the content: `'utf8'` fills `text`,
`'base64'` fills `base64`, `'none'` means `refusal` is set and both are null.

An **empty file** is `encoding: 'utf8'`, `text: ''`, `refusal: null`. "This file
is empty" and "you may not read this" are different facts and a caller must be
able to tell them apart.

Named refusals, never a silent empty body: `secret-pattern`, `too-large`,
`binary-not-previewable`, `not-a-file`, `outside-root`, `unreadable`. A refusal
rides **inside a 200**, because the caller asked a legitimate question and
deserves a named answer rather than a 4xx an offline client cannot distinguish
from a network fault.

`path` is **required**. Guessing a default would silently read the wrong file —
which is why the operation appears in `sweep.test.ts`'s `HANDLER_AUTHORED_400`.

### 5.2 No CLI command

`cmd: null`, matching `projects.files.list`: a CLI caller already holds the node
filesystem and reaches these bytes with shell tools. It stays discoverable by
exact lookup, and is named explicitly in the commandless set so it can never lose
a command by accident.

### 5.3 Menu and screen

`MenuViewRef` gains `'files'` — additive union widening, the `graph` precedent.
No `kind` ref could name this screen: a kind ref lists ENTITIES and the browser
mints none.

The row sits in the **Tracking** group beside Projects, because a project's
folder is what it reads. Not under the Workspace caret (that caret lists entity
collections) and not in its own group — group ids are pinned to
`DEFAULT_MENU_GROUP_SPINE`, which the server seeder (migration 061,
`menu-seeder-parity.pg.test.ts`) derives from too, so a new group is a MIGRATION
and a rail row does not justify one.

`seam.projectFiles` is **optional** — a fixture seam has no filesystem — so the
screen renders an honest "this build cannot read the node's filesystem" rather
than an empty tree that would read as "this project has no files".

## 6. What Phase 1 deliberately does not do

- **Mints no entities.** Attaching is `projects.files.attach`, and it is not on
  this screen.
- **No search**, no writes, no rename, no delete.
- **No recursion, no watch.** The client re-reads.
- **No quotas** — R5.
- **No masking flag on the LISTING.** `ProjectFileListing` is a shipped DTO and
  adding a field to it is a change to another lane's contract. Withholding
  therefore happens at read time, named. Worth revisiting.
- **No git awareness.** A `.gitignore`d file is still on disk and is still shown;
  hiding it would lie about what the agents see.

## 7. Phase 2 sketch — not built

1. **Reference entities.** The §1.2 migration: relax `storage_path`, add
   `(project_id, relative_path)`, replace the unique index with a partial one.
2. **Archive ingest (R2).** Stream one archive through the raw PUT and expand it
   server-side, generalising the artifact bundle substrate
   (`db/migrations/055_artifacts.sql:82-146`) past its `file_count between 1 and
   128` cap. The expander must defuse zip-slip, absolute and symlink members, and
   expansion bombs, and must cap total expanded bytes even though R5 waives
   quotas — a bomb cap is a safety limit, not a quota.
3. **Dedup + GC (R6).** `stored_blobs` already dedups on `(space_id, sha256)` and
   carries `unreferenced_since`; the sweep was never built.
4. **Agent write access (R6).** `forbidden: file upload slot belongs to another
   identity` — each upload stage derives its own mutation id from the caller
   root, so the slot opened at init is not recognised at transfer.

## 8. How this is proven

Containment, masking, the inline ceiling and each refusal get their own test
against a **real** temp directory with **real** symlinks — a mocked filesystem
proves nothing about `realpath`, which is the whole containment. Render states
are jsdom-provable. **Layout is not**: any claim about the two panes' width or
scrolling belongs in a Playwright e2e or is not made.

Baselines on `8720ea5` before any edit, so a regression delta is a set:

| package | baseline |
|---|---|
| `packages/contract` | 6 files, 88 passed, 0 failed |
| `tools/conformance` | 2 files, 14 passed, 0 failed |
| `packages/server` | 164 files, 3 failed / 1382 passed, 4 failing files |
| `packages/tm8-ui` | 150 files, 15 failed / 2245 passed, all in `views/gate.test.tsx` |

**Diff the normalised ASSERTION set, not just the failing FILE set.** A file set
says "this file is red"; it cannot say "this file is red for one MORE reason",
and this lane has twice had pins hide inside files that were already failing for
unrelated reasons.
