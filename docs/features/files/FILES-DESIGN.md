# Files — browsing the node's real filesystem

Status: Phase 1 in build. Task `019fe5d6-a363-7cd3-a42b-c9ed0ec87be7`.
Branch `feat/files-browser`, based `origin/main` `15e4eb2`.

## 1. What this is, and what it is not

A **Files** menu item that browses **real directories on the node**. The tree you
see is the tree on disk — the same bytes the agents read and write.

It is **not** a copy. It is **not** one graph entity per file. Those two mistakes
are the reason this document exists.

### 1.1 The unit of storage is not the entity

A codebase is thousands of paths. Minting a `file` entity per path would put
thousands of rows, versions, activity records and edges into the graph to
describe something the filesystem already describes perfectly.

So:

| Thing | Lives where |
|---|---|
| the bytes, the directory structure, the truth | the filesystem |
| a **reference** to one file, so it can be discussed, attached, cited | a `file` entity |

**A `file` entity is a link.** The truth of the file is somewhere else. An entity
is minted only when a human or an agent wants to *point at* a file — attach it to
a task, cite it in a message, hang a review on it. Browsing mints nothing.

### 1.2 Measured blocker for §1.1

`public.files` (`db/migrations/001_core_graph.sql:599-608`) cannot express a
reference:

```sql
storage_path text not null check (storage_path ~ '^spaces/[0-9a-f-]{36}/[0-9a-zA-Z._-]{1,120}$'),
unique (storage_path)
```

- `not null` + the CHECK mean a `file` row can **only** name a blob tm8 itself
  uploaded under its own data dir. There is no way to say "this entity refers to
  `src/index.ts` inside project P".
- `unique (storage_path)` means two entities can **never** reference the same
  underlying file. Reference semantics require exactly that.

Phase 2 owns this migration. **Phase 1 mints no entities at all**, so it does not
need the migration — browsing and viewing are pure reads. This is deliberate
sequencing, not an oversight.

## 2. Rulings

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
reparented with `entities.move`. It was given under the entity-per-file framing
that R1 replaced. Folders are directories on disk. Do not build it.

**R4 note.** R4 was answered as "mount the existing `file` kind row". That row
lists *entities*, which under §1.1 are references, not the filesystem. It is
still worth mounting, but it is a different screen from this one and cannot
serve as the browser. Phase 1 therefore adds one view ref (§5.3) — the smallest
surface that can actually render a tree.

## 3. Roots — what is browsable

**A browsable root is a `project` linked to the current space.** Nothing else.

`ProjectResource.workingDir` (`packages/contract/src/contract.ts:1379`) is an
absolute path on the owning node, already documented as path-traversal and
symlink guarded. Projects are already a registered, node-level resource with a
trust grade and a `space_projects` link table.

Consequences, all of them deliberate:

- **No new registration concept.** To make a directory browsable, link a project.
  `projects.create` and `projects.link` already exist and are `v1`.
- **No new authorization surface.** Visibility is exactly "is this project linked
  to a space you are a member of" — the same predicate `execution.spawn` already
  uses (`packages/server/src/facade/execution-handlers.ts:175-186`, which
  deliberately collapses not-linked and not-found so it cannot leak the existence
  of projects in other spaces). The browser reuses that query verbatim.
- Arbitrary paths are **not** browsable. `/etc`, `$HOME`, `TM8_DATA_DIR` are
  reachable only if someone deliberately registers them as a project, which is
  an existing, audited, owner-facing act.

### 3.1 Why this is not a new privilege

A space member who can see a project can already **spawn an agent into it**.
Untrusted projects are not refused — they require an explicit confirmation flag
(`db/migrations/007_rpc_catalog.sql:2081-2082`:
`spawning into an untrusted project requires explicit confirmation`). A spawned
agent has a shell.

So read-only browsing of a linked project grants **no capability a space member
does not already hold**. It is a more convenient view of an existing power.

> Note: `packages/execution/src/spawn/workspace-trust.ts:31` claims
> `execution_spawn` *refuses* to launch into an untrusted project. Measured, it
> does not — it gates on `p_confirm_untrusted`. The comment is wrong. The
> argument above uses the measured behaviour.

"No new privilege" justifies the feature. It does **not** justify carelessness —
see §4.

## 4. Security model

The browser is a remote read primitive. Four independent defenses, none of which
rely on another being correct.

### 4.1 Root jail (containment)

Every request resolves to a candidate path and must prove containment:

1. `realpath(root)` once — the jail.
2. Reject any request path that is absolute, contains a `..` segment, or contains
   a NUL byte, **before** touching the filesystem.
3. `realpath(join(jail, relPath))` — follows every symlink to its true target.
4. Require the result to equal the jail, or begin with the jail **plus a path
   separator**. The separator matters: `/data/project-secrets` must not pass a
   jail of `/data/project`.

Step 4 on the *resolved* path is what defeats a symlink pointing out of the tree.
A symlink is not refused for existing — it is refused for *escaping*, and the
refusal is named.

### 4.2 Secret masking (defense in depth)

Containment is not enough. A `.env` inside a project is inside the jail, and
surfacing it in a browser UI turns "spawn an agent and cat the file" into one
click.

Files matching a secret pattern are **listed but not readable**. The entry
appears in the tree with `masked: true` and a named reason; the content read
refuses.

Listing rather than hiding is the honest choice and is this codebase's house
style: a user told "there is a file here you may not read through this surface"
can act on it. A user shown a tree with silent holes will conclude the file does
not exist and make decisions on a lie.

Patterns are matched on the **basename** and on **path segments**, case
insensitively — see `SECRET_PATTERNS` in the implementation for the authoritative
list. It covers `.env` and its variants, private keys, `.ssh`, `.netrc`,
`.npmrc`, `.pgpass`, `.aws`/`.gnupg` directories, `.git/config`, and
`credential`/`secret`-named files.

**A denylist is not a security boundary and is not claimed as one.** It raises
the cost of casual exfiltration. The boundary is §3 (only registered projects)
and §4.1 (containment).

### 4.3 Bounded responses

Unbounded reads are a denial of service against the node and the browser.

| Bound | Value | Behaviour on exceeding |
|---|---|---|
| entries per directory | 1000 | return the first 1000, `truncated: true`, with the true `totalEntries` |
| bytes served inline | 5 MiB | refuse with `payload_too_large` and a named reason |
| recursion | **none** | the tree read is one directory deep, always |

Never recursive. A recursive read of a repo with `node_modules` is unbounded work
for one request. The client walks one directory at a time, which is also how a
human browses.

### 4.4 Content-type posture

Inherited verbatim from `files.download`
(`packages/server/src/facade/services/w2/files.ts:128-145`), which was already
right:

- `X-Content-Type-Options: nosniff` always.
- `Content-Disposition: inline` only for `image/*`, `audio/*`, `video/*`, and
  **`image/svg+xml` is excluded** — an inline SVG is script execution on the app
  origin.
- Everything else is `attachment`.

Text and source files are returned to the app as **JSON with the text in a
field**, never as an inline HTML-capable response. The app renders it into a
`<pre>`. Nothing from a project's disk is ever handed to the browser as a
document on the app origin.

## 5. Surface

### 5.1 Reads

Two new catalog operations. Both are `read`, both are space-scoped, both are
authenticated exactly like `execution.spawn`'s project resolution.

| name | method | path |
|---|---|---|
| `files.browse` | GET | `/v2/spaces/:spaceId/projects/:projectId/files` |
| `files.read` | GET | `/v2/spaces/:spaceId/projects/:projectId/files/content` |

Both take `?path=<relative>`; empty or absent means the project root.

`files.browse` answers one directory:

```jsonc
{
  "root": { "projectId": "…", "name": "tm8", "trust": "trusted" },
  "path": "packages/contract",
  "parentPath": "packages",          // null at the root
  "entries": [
    { "name": "src", "kind": "dir",  "sizeBytes": null, "modifiedAt": "…",
      "mimeType": null, "masked": false, "symlink": false },
    { "name": ".env", "kind": "file", "sizeBytes": 210, "modifiedAt": "…",
      "mimeType": "text/plain", "masked": true, "maskReason": "secret-pattern",
      "symlink": false }
  ],
  "totalEntries": 2,
  "truncated": false
}
```

`files.read` answers one file's content, or an honest refusal:

```jsonc
{
  "path": "packages/contract/src/catalog.ts",
  "mimeType": "text/x-typescript",
  "sizeBytes": 18244,
  "encoding": "utf8",       // or "base64" for binary, or "none" when refused
  "text": "…",              // null unless encoding === 'utf8'
  "base64": null,
  "refusal": null           // { reason, detail } when the content is withheld
}
```

Named refusals, never a silent empty body: `secret-pattern`, `too-large`,
`binary-not-previewable`, `not-a-file`, `outside-root`, `unreadable`.

### 5.2 Writes

Phase 2. R2's archive ingest and R6's agent write access are specified in §7 and
are deliberately not in Phase 1.

### 5.3 Menu and screen

`MenuViewRef` is a closed enum (`packages/contract/src/contract.ts:1096`,
`schemas.ts:1446`). Phase 1 widens it with `'files'` — additive union widening,
the same R4 posture already used for `'graph'` on 2026-07-29 and recorded in the
docblock there.

The screen is a two-pane browser: a directory pane on the left, a content pane on
the right, a root selector at the top when the space has more than one project.
No layout claim in this document is proven by jsdom; §8 covers that.

## 6. What Phase 1 deliberately does not do

Naming these keeps a later reader from concluding they were forgotten.

- **Mints no entities.** No `file` rows, no edges. Pure read.
- **No search.** Grep across a repo is a different feature with a different cost
  model (and agents already have `rg`).
- **No writes, no rename, no delete.**
- **No recursive tree, no watch, no live updates.** The client re-reads.
- **No quotas** — R5.
- **No git awareness.** A `.gitignore`d file is still on disk and is still shown.
  Hiding it would be a lie about what the agents see.

## 7. Phase 2 sketch — not built, not designed to completion

Recorded so the sequencing is legible, not as a commitment.

1. **Reference entities.** Migration to let a `file` entity name
   `(project_id, relative_path)` instead of a blob: relax `storage_path` to
   nullable, add the reference columns, and replace `unique (storage_path)` with
   a partial unique index so many entities may reference one path. §1.2.
2. **Archive ingest (R2).** Stream one archive through the existing raw PUT
   route; expand server-side into `stored_blobs` + path rows, generalising the
   artifact bundle substrate (`db/migrations/055_artifacts.sql:82-146`) out from
   under the `artifact` kind and past its `file_count between 1 and 128` cap.
   The expander must defuse zip-slip, absolute member paths, symlink members,
   hardlink members, and expansion bombs, and must cap total expanded bytes even
   though R5 waives quotas — a bomb cap is a safety limit, not a quota.
3. **Dedup + GC (R6).** `stored_blobs` already dedups on `(space_id, sha256)` and
   already carries `unreferenced_since`. The sweep was left unbuilt by artifacts
   Phase 2 and is the missing half.
4. **Agent write access (R6).** Fix `forbidden: file upload slot belongs to
   another identity` — each upload stage derives its own mutation id from the
   caller root, so the slot opened at init is not recognised as the same identity
   at transfer. No agent can currently upload anything.

## 8. How this is proven

- **Containment, masking, caps and refusals are unit-provable** against a real
  temp directory, including a symlink that escapes the jail and one that stays
  inside. These are the cases a careless implementation collapses, so each gets
  its own test.
- **Render states are jsdom-provable**: tree, empty directory, truncated
  directory, masked entry, each refusal, and the no-projects-linked case.
- **Layout is not jsdom-provable.** Any claim about the two panes' width or
  scrolling belongs in a Playwright e2e or is not made. jsdom will happily pass a
  pane that is visually clipped.

Suite baselines on `15e4eb2` before any edit, so a regression delta is a set and
not a count:

| package | result |
|---|---|
| `packages/contract` | 6 files, 88 passed, 0 failed |
| `packages/tm8-ui` | 138 files, 15 failed / 2106 passed — all 15 in `src/views/gate.test.tsx` |
| `packages/server` | 151 files, 15 failed / 1204 passed, 12 failing files (recorded in `.baseline/server-failfiles.txt`) |
