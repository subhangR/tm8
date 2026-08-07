| Item | Groomed decision |
|---|---|
| User outcome | From an entity panel, browse the files inside an already-connected local project folder and attach one to that entity, without leaving the product UI. |
| Product surface | `packages/tm8-ui`, the staging product UI, inside the existing `AttachmentStrip` — not a new tab, not a new screen. |
| Scope | A node-side file listing for one connected project, a node-side ingest that records a `file` entity from a path, the seam and port wiring, and the picker the strip opens. |
| Out of scope | Mirroring, watching, two-way sync, and writing back to the folder. Attaching is a one-shot read: the graph gets a copy, and the copy does not track the file. |
| Safety | Node-admin, confined to `TM8_PROJECT_ROOTS` **and** to the project's own working directory, re-checked every request. |
| Completion | Contract-backed, server-authorized, driving the existing upload ledger rather than a second one, visible in the real UI, covered by contract/server/UI tests. |

Grooming
--------

`docs/plans/new-space-local-project-onboarding.md` line 6 put file work out of
scope and named a separate task for it. This is that task's read-and-attach
half. Two of the three things its title asks for already shipped in 45cd3a6:
connecting a folder (`projects.directories.list` plus the browse screen in
`packages/tm8-ui/src/projects/NewSpaceProjectDialog.tsx`) and creating a new one
(`ensureProjectWorkingDirectory`, one child beneath an allowed canonical
parent). What was missing was reading anything out of the folder once connected.

The constraint that shapes the whole design is the same one the onboarding plan
found: **tm8 is a server plus a browser UI, and a browser file input never
learns an absolute path.** A user who picks `README.md` out of an `<input
type="file">` hands over bytes and a bare filename; nothing in the page can say
*which* `README.md` in the project folder that was, and re-uploading bytes the
node already has on disk would be the wrong shape anyway. So reading a connected
folder means the node reads it — exactly as browsing one already does.

`packages/tm8-ui/src/files/` was NOT a greenfield: `AttachmentStrip` is already
mounted in every entity panel's content body, `createFileUploadTask` already
drives the browser upload lifecycle, and `attachmentsPortFromSeam` already
exists. The gap was a second byte SOURCE, not a second attachment surface.

| Acceptance criterion | Evidence required |
|---|---|
| A file inside a connected project folder can be attached to an entity from the panel. | UI interaction test; server ledger test. |
| The bytes never traverse the browser. | The picker has no upload task and no progress; the server reads the path itself. |
| No path is ever assembled in the browser — every path sent back came from the server. | UI test asserting the attach argument is verbatim a listed path. |
| A file outside the project's working directory cannot be attached, however it is reached. | Server test: symlink out, absolute path out, and a parent directory. |
| A file too large or too empty to store is shown and refused with the reason, not hidden. | Server listing test (`attachable`) and UI test on the disabled row. |
| The attach obeys the same ledger as a browser upload. | Server test asserting init → authorize → settle → complete and the frozen target set. |
| A deployment with no file storage answers an honest 501 rather than offering a dead browser. | Conditional registration beside the files lane. |

Design
------

| Layer | Change | Reason |
|---|---|---|
| Contract | `projects.files.list` (`GET /v2/projects/:projectId/files`) and `projects.files.attach` (`POST /v2/projects/:projectId/files/attach`). | The catalog is the route law; the server must not accept an undocumented filesystem read. Scoped to a project rather than to the roots at large — the connected folder is the unit the user is thinking in, and it is a tighter confinement than the picker for onboarding needs. |
| Server (read) | `listProjectFiles` lists directories and files in one directory, capped, with size/mtime/MIME and an `attachable` flag. Symlinks are omitted from both lists. | A symlink row would let the picker offer a path whose canonical target is outside the project; refusing at listing time is clearer than refusing at attach time. |
| Server (write) | `attachFile` resolves and hashes the file, then drives the EXISTING `w2_*_file_upload` ledger — init, authorize, `blobStore.writeUpload`, settle, complete — with a `fs.createReadStream` in place of the HTTP request body. | `WriteUploadInput.stream` is already `AsyncIterable<Uint8Array>`, so no new write path is needed. Reusing the ledger keeps ONE set of invariants: mutation-id replay, the frozen target set, the size ceiling, and the blob store's checksum re-verification behave identically whichever way a file arrived. A parallel ingest would have to re-earn all four. |
| Authorization | Node-admin, then the project row read under the caller's own claims, then containment in `TM8_PROJECT_ROOTS`, then containment in the project's canonical `workingDir`. | A project row can name any path — only `ensureWorkingDir` onboarding constrains it — so creation-time trust is not assumed. The root check runs on every request, not once at creation. |
| Seam | Optional `projectFiles` group (Amendment 5), beside the optional `projectSetup`. | A fixture seam has no filesystem. Optional is what lets the fixture host stay honest instead of stubbing a node. |
| UI | `ProjectFolderPicker`, opened from a second button in `AttachmentStrip`. | The strip is already the attachment surface for every kind; a second surface would split one concept across two places. The two buttons are two SOURCES, not two ways to do the same thing. |

The digest handed to the ledger is taken from a real read of the canonical path,
so it describes the bytes this node actually saw; the blob store then re-hashes
the same file while writing and refuses a mismatch. A file edited mid-attach
therefore fails closed rather than being stored under a stale checksum.

One mutation id is minted per attempt rather than derived from the path. A
path-stable id would make a second attach of the same file REPLAY the first
command instead of recording a second attachment, and — because the ledger
refuses a replayed id whose request hash differs — re-attaching a file that had
changed on disk would fail outright rather than attach the new bytes. Duplicate
edges are prevented by the server's frozen target set, not by the id.

Ledger pins reconciled in passing
---------------------------------

Three catalog pins were already red on the tree before this change and are
re-derived here, because a catalog change that leaves them red hides its own
blast radius: `test/w3/public-harness.test.ts` (still describing a 120-row
catalog), `test/w3/agentic/g15-agentic.test.ts` (121 rows, and both its
downstream assertions were failing as a consequence), and the facade tranche
list in `test/w2/rolling-public.integration.test.ts`, which
`projects.directories.list` joined the catalog without ever entering.
