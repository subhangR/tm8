# HANDOVER — T3-4 Files & attachments · T3-5 Node settings & status

**status-as-of:** `6dce6da` (tree HEAD at hand-off; nothing of mine is committed) · worker `sess_1785277838358_fq942k68u` · task `task_1785277837558_ffy3vizaw` · 2026-07-29

Oracle: `T0-1 workspace structure review (1)/T3 Files, Node & Inbox Hi-Fi.dc.html` (46 485 bytes). **Lines 21–245 read whole, not sampled.** The file carries exactly three `data-screen-label` frames — T3-4 (L21), T3-5 (L132), T3-7 Inbox (L246). **T3-7 is the sibling lane's and I did not read past L245 or touch it.**

Nothing outside `packages/tm8-ui/src/files/` was created or edited. No `git add`, no `git commit`.

---

## 0. The two sentences that govern these surfaces

**T3-4:** every READ is real, every WRITE and every BYTE is refused. Attachment chips come from `MessageView.content.attachments` — contract-typed, live through `seam.messages()`. Upload, retry, cancel, attach, detach, download and text-preview are all contract-**v1** routes with **no seam verb or read**, so they render disabled-with-reason (R7 / D28).

**T3-5:** the oracle's header says *"health payload already exists — this renders it."* **That is not true of this contract.** I listed all 102 operations in `@tm8/contract`'s `catalog.ts` and searched for node / health / backup / provider: **zero hits** (the only match is a comment about a Phase-2 `bridge.fetchBlob` that must answer an honest 501). So the machine room is built around the **two** node facts the seam can measure — `getConnection()` reachability and `liveness` session count — and every other number on it is a dash with a caption. Transcribing "up 14d 6h · 412 MB · 8 slots" would have been the easy, plausible, false thing to do.

---

## 1. Frame enumeration — what each needs, and what it got

| frame | oracle | region | real | refused / hollow |
|---|---|---|---|---|
| **T3-4** upload card | L30–L68 | dropzone, 3-phase queue | queue rendering, progress semantics | dropzone · ✕ cancel · try again · the per-file cap |
| **T3-4** chips card | L69–L95 | message bubble + FILES·N list | **chips, names, sizes, provenance, the whole list** | ＋ attach · per-row ↓ (until a resolver) |
| **T3-4** preview | L96–L119 | image / text / unpreviewable + overlay | overlay open+Esc+close, image bytes when a resolver exists | text & pdf frames · ↓ download |
| **T3-5** node status | L139–L187 | 3 subsystem rows + concurrency | **server row (reachability), agent-host live count, header pill** | database row · agent-host health · the slot cap |
| **T3-5** agent commands | L188–L216 | provider rows, templates, probe | host-supplied rows + probe bodies rendered whole | ＋ Provider · test launch · the registry itself |
| **T3-5** data & backup | L217–L233 | 4-row grid + 2 buttons | — | all four rows · Back up now · Restore |

---

## 2. Divergences — RULED vs DRIFT

### RULED (by me, alone — flagged for ratification or reversal)

1. **The preview card / overlay is an ALWAYS-DARK scope.** Inside *one* frame the oracle paints the upload and chips cards on `#FBFAF6` (light `--pn-surface`, L31/L70) and the preview card on `#221E15` (dark `--pn-card`, L97). Two palettes side by side in a single frame is an intention, not drift — a media lightbox is dark the way the terminal family is dark (design law 8 / D40). Implemented as D16/D24's mechanism (nested `.cv2-root[data-theme="dark"]`), zero duplicated hex. Asserted by test. `FilesScreen.tsx` `PreviewCard` / `PreviewOverlay`.
2. **The annotation band and the per-card captions are CANVAS FURNITURE, gated behind `notes` (default `false`).** The oracle gates its own band with `<sc-if value="{{notes}}">` (L121/L235), and the per-card lines ("drag target names its destination…", L67) are written in the same design-note voice. D47's ruling about the layout picker generalises. The review board turns them on; the product does not. **One exception, deliberate:** the node card keeps `NODE_MEASURABLE_NOTE` on at all times — a user who cannot see *why* rows are dashed reads the dashes as a bug.
3. **Download is a host-supplied `downloadHref` resolver, not a URL this lane builds.** `files.download` (`GET /v2/files/:fileEntityId/download`, catalog.ts:109) is contract-**v1** and same-origin through the dev proxy, so an `<a href>` would have *worked*. I refused to write one: constructing transport is `src/data/**` work, a lane whose seat the user closed. Pass a resolver → every download control on the screen becomes real at once; pass nothing → they all carry `DOWNLOAD_UNAVAILABLE`. **This is the one place I chose the stricter reading of the boundary over the more functional screen, and it is the ruling most worth reversing if you disagree.**
4. **The concurrency strip draws no hollow pills.** The oracle draws eight (three filled, five hollow) and prints "8 slots · 3 in use". The in-use half is real; **the cap has no reader anywhere in the contract** (there is a `capacity` refusal *code* and no operation reporting the ceiling). Five hollow pills would be a spatial claim about a number this build cannot know — D7.2's lie in geometry rather than digits. So: one pill per live session, then the cap stated as unknown in words. The oracle's "at 8/8 Run disables" sentence survives as the *mechanism* it names, with the number withheld.
5. **Column widths are flexible, not the oracle's 380/380/408 and 450/400/334.** Those are specimen measurements on a 1264px review board (D47 / D52's lesson). Product columns are `flex: 1 1 360px; min-width: 320px`, so the screen stacks instead of clipping.
6. **`FileRow.attributedTo` carries the whole actor, not a name.** L125 makes agent provenance visible ("square avatar in the meta, nothing visually second-class"); `kit/Avatar` already encodes round-human / rounded-square-agent, so the row keeps the flag and reuses the law rather than restating it.

### DRIFT (oracle value vs built value)

1. **The 25 MB cap.** Oracle L36/L60 prints "25 MB per file" and "41 MB — over the 25 MB cap". The contract says the ceiling is deployment-configurable (`FILE_MAX_SIZE_BYTES_DEFAULT` = 512 MB) and that **grants carry the effective value** — i.e. the real number is only knowable from a grant, and no grant is obtainable here. Built: `capSentence(null)` → the dropzone prints a hollow cap with `FILE_CAP_UNKNOWN`. The "25 MB" text survives **only** inside the specimen failure row, where it is transcribed canvas copy on a canvas-only state. `model.ts:capSentence`, `specimen.ts`.
2. **Subsystem row dividers.** Oracle L147 draws `--pn-line` (`#2C2719`) between the three status rows. Built with `--pn-x-hairline-soft` per D-law 4: `--pn-line` BOUNDS a component, the soft hairline SEPARATES repeated siblings inside one, and these are repeated siblings. Same call the auth lane made for its token rows. `files.css` `.fn-sub`.
3. **`missing from this node` has no data source.** Oracle L90 draws the state and L124 rules its tone ("wait amber — the record exists, the bytes don't"). **The contract has no per-file `sourceMissing`** — that field exists only on `HandoffView`. Built: `FileRow.sourceMissing` renders correctly and every *real* row arrives `false`; the state is reachable from specimen data only. See §4 GAPS.
4. **Provider names.** Oracle L197/L206 draw `claude` and `openai` with their command templates. No provider registry read exists, so the card renders **no providers** unless a host supplies them, and a test asserts neither canvas name leaks in.

---

## 3. Files (all new, all mine, none tracked)

```
src/files/model.ts             295   pure derivations — glyphs, sizes, failure words, rows
src/files/reasons.ts           218   the gap ledger, in code
src/files/port.ts              203   the ONLY seam contact (files + node)
src/files/FilesScreen.tsx      742   T3-4
src/files/NodeRoom.tsx         488   T3-5
src/files/specimen.ts          146   review-board data (never product)
src/files/FilesNodeBoard.tsx   130   dev review board, 5 frames
src/files/files.css           1012   every value oracle-cited, every colour a token
src/files/index.ts              70   public face; imports its own stylesheets
src/files/board.html            37   dev entry  →  http://127.0.0.1:4612/src/files/board.html
src/files/board.tsx             19   its mount (both themes stacked)
src/files/files.test.tsx       734   48 tests
src/files/port-seam.test.tsx   205    8 tests, driven against a REAL createFixtureSeam()
src/files/no-kind-literals.test.ts 165  9 tests, this lane's §15.2 + §14 guard
                              ─────
                               4464
```

`board.html`/`board.tsx` sit **inside** `src/` against brief §4.7's preference: Vite resolves html entries relative to the project root, and this lane may only create under `src/files/`. Putting the entry at the package root would have meant writing in someone else's lane to review my own. No route reaches it; `main.tsx` does not know it exists.

**Dirty in the tree and NOT mine** (stated so you don't assume I know what you know): `src/channel-screen/`, `src/doc-edit/`, `src/home/`, `src/settings-space/`, `src/chat/` and others are untracked sibling lanes. **`src/doc-edit/docEdit-seam.test.tsx` fails 3 tests** — see §5.

---

## 4. GAPS — what these screens draw that nothing can perform

Machine-readable in `reasons.ts` as `MISSING_FILE_OPS`, split by remedy because the two are completely different work.

**SEAM GAP** — the server route exists and is contract-`v1`; the UI seam carries no verb. Remedy: a seam amendment (dual-consensus, `data/seam.ts` header).

| op | route |
|---|---|
| `files.uploadInit` | POST `/v2/files/uploads` |
| `files.uploadComplete` | POST `/v2/files/uploads/:uploadId/complete` |
| `files.uploadAbort` | POST `/v2/files/uploads/:uploadId/abort` |
| `files.download` | GET `/v2/files/:fileEntityId/download` |
| `messages.attachments.add` | POST `/v2/messages/:messageId/attachments` |
| `messages.attachments.remove` | DELETE `/v2/messages/:messageId/attachments` |

**CAPABILITY** — nothing anywhere reports this. Remedy: build it, server first. No UI wiring reaches it.

`node.health` · `node.providers.list` · `node.providers.test` · `node.providers.add` · `node.concurrency.cap` · `node.backup.run` · `node.backup.restore`

**DATA GAPS (not ops):**

1. **No per-file `sourceMissing` field** in the contract — see §2 DRIFT 3.
2. **The fixture dataset surfaces no `attached_to` edges through `EntityDetail.connections`.** MEASURED 2026-07-29, and it surprised me: `src/fixtures/graph.ts:116` *does* define `fileScreenshot -attached_to-> taskGuideLines`, but that edge lives in the graph dataset and never reaches entity connections. Across every fixture entity the connections carry exactly three types — `blocks`, `references`, `relates_to`. So `filesOn()` correctly answers `[]` everywhere and the FILES·N section correctly renders its measured-empty line. **`port-seam.test.tsx` pins this**, so if a fixtures seat later surfaces those edges the test goes red and whoever changed it learns immediately that a screen just came alive. `src/fixtures/` is not my lane to edit.

---

## 5. Verification

### Red-first record

Three deliberate breaks, applied to a green tree, run, then reverted (the rowsFor precedent).

**RED — 2026-07-29T14:22:36Z · `bunx vitest run src/files/` from `packages/tm8-ui` · vitest v4.1.10 · 6 failed | 59 passed (65)**

| break | test that went red |
|---|---|
| dropzone made a live `<button>` with no handler | `the verb sweep > refuses every unwired act…` — *"Drop to attach to T-114" must render disabled-with-reason: expected null not to be null* |
| " | `the dropzone is not a drop target, and does not silently swallow a file` |
| concurrency strip transcribed as `8 slots · N in use` | `a cold node room contains NO digit anywhere` — *expected 'Node status— node · — version●connect…' not to match /\d/* |
| " | `states the cap as unknown rather than transcribing the canvas's 8` — *expected 'CONCURRENCY8 slots · 3 in use…' not to contain '8 slots'* |
| " | `re-renders when the port pushes new facts` |
| `if (entity.kind !== 'file') return null;` in `model.ts` | `§15.2 > no source file here contains a kind string literal` — *files/model.ts → 'file'* |

**GREEN — 2026-07-29T14:22:43Z · same command, same runner, breaks reverted · 3 files, 65 passed (65)**

### Wide check

*Instrument: `bunx vitest run` invoked from `/Users/subhang/Desktop/Projects/tm8/packages/tm8-ui` — banner `RUN v4.1.10 …/packages/tm8-ui`, the control the brief names. Never from the repo root.*

| when (UTC) | scope | result |
|---|---|---|
| 2026-07-29T14:22:50Z | `--exclude 'src/terminal/**'` | **73 files · 1362 passed, 3 failed** — all 3 in `src/doc-edit/docEdit-seam.test.tsx` |
| 2026-07-29T14:23:34Z | `--exclude 'src/terminal/**' --exclude 'src/doc-edit/**'` | **71 files · 1331 passed, 0 failed** |
| 2026-07-29T14:23:34Z | `bunx tsc --noEmit` | **clean, zero errors** |

**The 3 failures are not mine and I did not fix them** (another lane's seat). Evidence: `src/doc-edit/` is untracked; all three failures are inside its own seam test around `doc-save`; and `grep -rn "from '../files" src` returns **nothing outside `src/files/`** — no file in the tree imports my lane, so it cannot be implicated. (An earlier `tsc` run at 14:19Z also showed `src/channel-screen/FeedRow.tsx(153,11)` — that lane fixed it during my run; it is clean now.)

### Build / serve check

- `bunx vite build` in lib mode over `src/files/index.ts` — **113 modules transformed, built in 9.52s**, `style.css` 90.12 kB. This is what proves `files.css` **parses**; the vitest run does not.
- Dev server on `:4612` was already up. `curl` of `/src/files/board.html`, `/src/files/board.tsx`, `/src/files/files.css`, `/src/files/index.ts` — all transform cleanly, zero errors in the module graph.

### NOT CHECKED — said plainly

1. **I have not LOOKED at these screens in a browser, in either theme.** My scope directive says no screenshots and that the user reviews live after wiring; the browser tool also requires a user-facing browser-selection question the quiet protocol forbids me to ask. So the brief's §4.4 verification is **owed and unpaid**. jsdom cannot see layout: a clipped label, a column that collapses under the 1.1× zoom, a dark card that inverts wrongly in light theme — every one of those passes all 65 of my tests. **The board at `http://127.0.0.1:4612/src/files/board.html` exists precisely so that this is one URL away.** Ready for capture.
2. **The always-dark preview overlay has not been seen against a LIGHT-theme page.** The nesting mechanism is D16/D24's and the test asserts the attribute, but "the tokens re-declare correctly inside a light ancestor" is a claim about CSS cascade I verified structurally, not visually.
3. **No responsive / narrow-width check.** The flex columns are a ruling (§2 RULED 5); I have not watched them wrap.
4. **`FilesScreen`'s upload queue at length.** The specimen shows three rows; I have not looked at twenty.
5. **The real seam (`createRealSeam`) was never exercised** — `port-seam.test.tsx` drives the fixture seam only. Both implementations are type-indistinguishable by LLD §10, so this is a reasonable gap, but it is a gap.
6. **`hex-ban.test.ts`'s exclusion count.** My lane guard asserts `files` is not on the exclusion path, and the package guard passed in the wide run — but I did not independently re-derive that the package guard's four-exclusion assertion still holds after another lane's changes.

---

## 6. Integration note — exactly what to mount, and where

Nothing of mine is mounted. Everything is exported from `src/files/index.ts`, which imports its own stylesheets (tokens, canvas-extra, honesty, kit, files) so a host needs **no second edit** anywhere.

### The review board (zero wiring — this is the fastest path to the user's eyes)

Already live: **`http://127.0.0.1:4612/src/files/board.html`**. Five frames × both themes: T3-4 populated, T3-5 live / degraded / cold, T3-4 empty. No route, no `main.tsx` edit, nothing to revert.

### T3-4 in product

```tsx
import { FilesScreen, filesPortFromSeam } from '../files';

const port = filesPortFromSeam(seam, spaceId);          // reads only
const [attached, setAttached] = useState<FileRow[]>([]);
useEffect(() => { port.filesOn(entityId).then(setAttached); }, [port, entityId]);

<FilesScreen
  destinationLabel={entity.title}   // REQUIRED — the drop target always names where
  attached={attached}
  bubble={bubble}                   // optional; from port.messagesWithFiles(anchorId)
  downloadHref={undefined}          // see below
/>
```

`FilesScreenProps` in full: `destinationLabel` (required, string) · `queue?: UploadItem[]` · `maxSizeBytes?: number | null` · `bubble?: MessageBubble | null` · `attached?: FileRow[]` · `attachedLabel?: string` · `downloadHref?: (fileEntityId: string) => string | null` · `onPreview?: (file: FileRow) => void` · `notes?: boolean`.

**Sensible mount points** (none of which I touched): the FILES·N section belongs inside a detail panel's content tab — `panels/bodies/GenericBody.tsx` already has a `file-preview` block and the `file` registry row already lists it, so the natural composition is registry data, not a new branch. The chips belong wherever a message renders. The upload card is a whole-screen affordance.

**On `downloadHref` — the one decision I am handing you rather than making.** Supplying `(id) => \`/v2/files/${id}/download\`` turns every download control real in one line, because that route is contract-`v1` and the dev proxy is same-origin. I did not write it because building a transport URL is `src/data/**`'s job. If you rule that a same-origin contract route is fair game for a screen lane, it is a one-line prop and my tests already cover both states.

### T3-5 in product

```tsx
import { NodeRoom, nodePortFromSeam } from '../files';

const port = useMemo(() => nodePortFromSeam(seam, spaceId), [seam, spaceId]);
<NodeRoom port={port} nodeName={null} version={null} providers={[]} />
```

`NodeRoom` subscribes, calls `refresh()` once on mount, and unsubscribes on unmount (asserted). `nodeName` / `version` / `providers` are host-supplied and render **hollow** when absent — pass `null`/`[]` rather than inventing. `staticNodePort(facts)` is the escape hatch for a host that already holds a liveness snapshot.

### D-entries I am authoring (text below is mine to propose; the ledger is yours to commit)

- **D6x — A lightbox is dark: a second palette inside one oracle frame is an intention, not drift.** Where a canvas paints two palettes side by side within a single `data-screen-label`, the darker one opens a nested `data-theme="dark"` scope rather than being normalised to the frame. Evidence: T3 Files L31/L70 (light `--pn-surface`) vs L97 (dark `--pn-card`). Generalises design law 8 beyond the terminal family.
- **D6y — A cap that cannot be read is not drawn as geometry.** Where a canvas encodes an unknown quantity spatially (n hollow slots, an n-segment bar), the build renders only the measured part and states the ceiling in words. D7.2's dash-not-zero law extends from digits to shapes: five hollow pills assert "there are eight" exactly as loudly as the numeral would.
- **D6z — Canvas annotations are furniture, and the canvas says so itself.** An oracle's `<sc-if value="{{notes}}">` band and its same-voice per-card captions render behind a `notes` prop defaulting to `false`. Extends D47 from the layout picker to the annotation layer. Exception: a caption that explains why a *product* value is hollow is product copy, not annotation, and stays on.

---

## 7. If you read one thing

The node room is a screen about an absence. It draws every subsystem, every backup row and every provider control the oracle draws — and tells the truth about all of them, which is that seven node capabilities do not exist and two do. That is what "link-level completeness, fidelity later" bought here: **zero silent voids, and a list of exactly what to build next.**
