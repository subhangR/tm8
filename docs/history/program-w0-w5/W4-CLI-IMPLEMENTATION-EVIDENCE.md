# tm8 W4 — CLI and Harness Implementation Evidence

**Wave:** W4 — CLI and harness implementation by group
**Coordinator:** `sess_1785093404712_3h87437sp` — tm8 W4 Coordinator Opus (`tm_1785093306656_y4lqppl3u`)
**Task:** `task_1785034451951_r513micgx` under program task `task_1785034111359_8godfu0il`
**Entry authority:** amendment **M-2** (`W0-W5-HANDOFF-STATE.md` §9) — user-authorized parallel start, **not** a fresh G3 APPROVE
**Provider:** `provider=claude`, `agentTool=claude-code`, `model=claude-opus-5`, `reasoningEffort=xhigh`, `accessMode=fullAccess` (per M-1)
**Started:** 2026-07-27

> **Standing rule recorded once, applied everywhere:** no git command is run by this
> coordinator or by any session it spawns — not `status`, not `diff`, not `log`. A prior
> session in this program was rejected as gate evidence purely for running
> `git status --porcelain` despite a functionally passing result.

---

## 1. Scope and gate

W4 implements the noun-first CLI and the agent harness, bound to the frozen contract catalog,
tested against a **real local Server**.

**Gate G4 requires:** all CLI group/unit/integration tests pass against a real local Server;
help/completion and JSON output match the contract; no public `prompt`/`report`/`progress`
seam or second communication channel exists; reserved operations are honestly unavailable.

**M-2 does not waive G4 and does not waive G3.** W4 may not treat an unverified API as
proven. W5, UI, and Remote Phase 2 remain out of scope. This coordinator does not
self-certify G4 and does not start W5.

### 1.1 Ownership boundary (hard)

W4 owns **`packages/cli/**`** and the harness surfaces named in its packets.

W4 **must never edit**:

- `packages/server/src/**` — W2
- `packages/server/test/**` in its entirety — including `w2/**` (W2), `w3/**` (W3), and
  `db/**` (live migration-order gates). Tightened from the original packet at W2's request
  and granted by the full-program coordinator.
- `db/migrations/**` — W2
- `packages/contract/src/**` — frozen contract

A contract or server change is **reported for arbitration**, never made by W4. W4
integration tests live under `packages/cli/**` only; harnesses are copied or reimplemented
rather than taken from the server test tree.

---

## 2. Preflight — independently verified facts

Read-only preflight completed 2026-07-27 with zero edits, zero spawns, zero git, before any
worker was created.

### 2.1 Catalog digest — recomputed, not trusted

Recomputed from **built** `OPERATIONS` using the adapter's own recipe
(`sha256` over `JSON.stringify(OPERATIONS)`, per
`tools/conformance/src/foundations/generator.ts:330`):

| Property | Measured |
|---|---:|
| catalog rows | **101** |
| v1 | 99 |
| reserved | 2 |
| HTTP (non-WS) | 100 |
| WS | 1 |
| registerable v1 HTTP ceiling | **98** |

```text
digest  sha256:df96ff5a4c2d11e41ec1d7b9c5e460bdcb8ae8d9c2c99b140f59e08305f8d604   MATCHES
reserved  search.query, bridge.fetchBlob   (exactly two, forever 501)
```

Authority files on disk still match their recorded G0.1 hashes, so the binding authority is
intact and unmodified:

```text
b85a18304f3769ba88da67403a7d90331a17c6355df7b451d650b49990434805  W0-AMENDMENT-DOSSIER.md
fa2c304a5ee24ee7c5d9eb47e157c38eb8d5aa6145b8a4a99046ae0a21f11c60  W0-CONSISTENCY-MATRICES.md
```

### 2.2 Composed server surface — measured from source, correcting both evidence docs

`W2-PREFLIGHT-AND-INTEGRATION-EVIDENCE.md` and `W3-PUBLIC-AND-AGENTIC-EVIDENCE.md`
both record **62 implemented / 36 residual**. W2's own direct handoff message to W4 also
stated 62 and predicted tranche-v2 would reach 73.

**The tree has already passed that point.** Verified statically, without a DB run:

```text
packages/server/src/facade/index.ts:102
    registerW2EntitiesCommandsTrackingHandlers(registry, facade);   // G02 — COMPOSED

packages/server/test/w2/rolling-public.integration.test.ts:237   registry.size === 68   (facade)
packages/server/test/w2/rolling-public.integration.test.ts:405   { ok: true, operations: 100, implemented: 73 }
packages/server/test/w2/rolling-public.integration.test.ts:406   registry.size === 73   (68 facade + 1 events + 4 execution)
packages/server/test/w2/rolling-public.integration.test.ts:414   residual toHaveLength(25)
```

**Current truth: 100 mounted / 73 implemented / 25 residual / 2 reserved.**

**⚠ CORRECTED — `73` is REGISTERED, not behaviourally implemented.**

W2's tranche-v2 handoff reported, from a real production `bootstrap()` listener:

```json
{"ok":true,"server":"tm8-server","contractVersion":"0.1.0","operations":100,"implemented":73}
```

`/health implemented` reports **`registry.size`** — the count of **registered handlers**.
Registered is **not** the same as behaviourally implemented. The concrete instance:
`facade/index.ts:87` registers `'messages.post': messagesPost(facade)`, and
`handlers/messages.ts:175-182` is an **unconditional 501 stub**. It counts toward `registry.size`
and can never do work until G04 composes. **Registered 73; behaviourally implemented at most 72.**

The `73 + 25 = 98` identity was cited four times as independent corroboration. It held **only
because the two errors were equal and opposite** — the implemented count over-counted
registered-but-stubbed operations by exactly the amount the residual count under-counted them. A
tautology wearing the costume of a cross-check. The derivations that remain sound (G15's mechanical
catalog-join, C01's AST inventory) are sound because they count **registration** and were never
measuring behaviour.

**W4 binds nothing to a behavioural reading of 73.** W3 has withdrawn the implemented half pending
re-measurement with schema-valid bodies — its earlier classifier probed with **no body**, so a
command operation failed input-schema validation and returned 400 *before* the handler was reached,
reading "not 501" as "implemented" without ever touching the stub.

**This is exactly why §4.2's availability field takes an OBSERVED 501 as the per-operation signal
and uses `/health` only as a cache-invalidation epoch, never as a per-operation claim.** Registry
counts and the generated manifest were both refused as sources on principle; a real defect has now
been found in the alternative. That design is not to be weakened.

`operations: 100` (mounted) is unaffected. This is a *composition declaration*, explicitly **not** a
verification verdict — see §2.3.

**Replacement, not duplicate registration** — structural check contributed by the W3
coordinator (`sess_1785092163476_4on0tyohq`), which W4 had not derived:

```text
57 facade (tranche-v1)  +  19 registered (G02)  −  8 replaced  =  68 facade
68 facade  +  1 events  +  4 execution                          =  73 registry
```

W2 adds that `HandlerRegistry.register()` **throws on a duplicate name**, so a
merge-instead-of-replace could not have booted at all. Between the two, duplicate
registration is structurally excluded.

**What this leaves open, and it matters to W4:** the residual risk is *behavioural drift in
the 8 replaced operations*, which **no count can detect** — only a behavioural sweep can.
Consequently, if a W4 CLI test exercises one of those 8 and it behaves, that is **not**
evidence the replacement preserved semantics.

**Downstream consequence reported to W3, not acted on:** `test/w3/public-harness.test.ts:35`
and `test/w3/g15-public.test.ts:68,94` are pinned to `62` and will go **stale-red** against
the current tree. That is a superseded expectation, not a server regression and not a G15
honesty failure. W4 did not touch those files and proposed no fix; they are W3's.

### 2.3 Coverage W4 may claim

| Class | Groups / operations | W4 disposition |
|---|---|---|
| Composed + frozen + W3 PUBLIC **and** AGENTIC PASS | G01, G03, G05, G06, G07, G08, G09 — 47 operations | **Real-Server integration coverage claimable** |
| Composed, **zero W3 verdict** | G02 — 19 operations | Bind and exercise; label **"composed, not independently gated"**. Not counted as verified coverage until W2's tranche-v2 PUBLIC-READY handoff arrives |
| Mounted pre-W2, W3-ungated | `messages.list`, `messages.post`, `events.poll`, 4 × `execution.*` | Exercise with the same "not independently gated" label |
| Residual (25) + reserved (2) + WS (1) | G04, G10 `presence.get`, G12, G13, G14 | Contract binding only. **Honest 501 is expected, is not a defect, and is never filed against W2** |

W4 under-claims by policy rather than borrowing credit from a verdict W3 has not issued.

### 2.4 Substitution boundary with W3 — affirmed in both directions

Agreed on the record with the W3 coordinator (`sess_1785092163476_4on0tyohq`):

- A **W4 CLI test passing** against an operation **never substitutes** for W3's public verdict
  on it. It does not exercise the production HTTP boundary the way the W3 harness does, and it
  was not written by an independent verifier of the server.
- A **W3 public PASS never discharges** a W4 G4 obligation.

*"We widen each other; we do not substitute for each other."* W4 will never cite a W3 PASS as
CLI evidence, and will never offer CLI green as API evidence.

W3 independently verified W4's non-interference claim against a SHA-256 baseline of all 22
files in `packages/server/test/w3/**` — zero mismatches. The reciprocal standing offer is
accepted: if W4's tree is ever observed touching `packages/server/test/w3/**`, or claiming API
verification coverage, it is stop-the-line.

---

### 2.5 Server-side holds that change a CLI binding — carried from W2's tranche-v2 handoff

These are disclosed W2 holds, **not W4 defects and not to be filed against W2**. Each one
changes how a W4 group must be built, so each is recorded against the group that must honour
it.

| Hold | What it means for the CLI | W4 group |
|---|---|---|
| **Body-less DELETE is now `400 invalid_input`** — `entities.delete` and `entities.restore` are bound to `RequiredCommandContextSchema`. This is the established treatment for every row the matrices mark *unbound* (same as `edges.delete`, `savedViews.delete`, `spaces.taskAxes.delete`, `spaces.invites.revoke`, `projects.unlink`, `readMarks.upsert`). | `entity delete` / `entity restore` **must send a body carrying `clientMutationId`**. A body-less DELETE is no longer a silent success. Assert this deliberately rather than assuming it. | 3 |
| **`messages.delivery.get` (A10) silently truncates at 50** — it accepts and fingerprint-validates a `cursor`, but `MessageDeliveryView` has **no `nextCursor`** and the SQL uses `limit N` not `N+1`, so the cursor is unreachable by construction. Dossier amendment pending; no field was invented. | `message delivery` must **not** present a pagination affordance it cannot honour. Do not fabricate a cursor. | 5 |
| **X01 / embed placement — CONFIRMED, FIXED, FROZEN.** Migration 020's inverse allowlist is enforced at INSERT on `undo_tokens`, and `place_entity`'s `embed` branch mints a `messages.delete` token inside the same transaction as `post_message`. On the shipped chain the whole transaction rolled back with `23514` and `messagesAfter` was **0** — `placements.apply … embed` was **silently destroying the user's posted message**. Confirmed empirically by W2, independently confirmed fixed at the public boundary by W3. Migration 020 rotated. | The undo affordance for embed placement now genuinely exists. See §2.5.1 for the redemption semantics the CLI **must not** misrepresent. | 4 |
| **`tracking.refresh` 202-accepted-and-queued** is the frozen contract, not a stub; its provider queue consumer is a later owner. | `tracking refresh` must render 202 as a **success**, not an error or a pending-failure. | 3 |

#### 2.5.1 Undo redemption of a `messages.delete` token — the wording the CLI must get right

Redeeming a `messages.delete` undo token is a **state transition, not a destructive delete**:

- body becomes `[redacted]`
- mentions and attachments cleared
- `redacted_at` set
- `file → attached_to → message` edges removed
- pending deliveries cancelled with reason `message_deleted`
- exactly **one** `message.deleted` event
- **thread history survives**

**If the CLI ever describes this as "deleting a message", that is wrong in the direction that
matters** — it would tell an operator that history is gone when it is not, inviting a
destructive recovery action against data that was never lost. Help text, human rendering, and
confirmation prompts for `undo apply` and `placement apply … embed` must all say *redact /
state transition*, never *delete*. This binds groups 4 and 10 (help text).

### 2.5.2 Migration-chain identity — every W4 integration result is bound to one

**⛔ THE EARLIER RECIPE WAS BROKEN — cwd-dependent.** It hashed `shasum`'s *output lines*, which
contain the path **exactly as typed**, so it varied with the caller's working directory and glob
form. It was never a property of the directory. Verified by W4 against the same 28 byte-identical
files:

```text
from repo root         -> 2bbaf608880519ba
from packages/server   -> 41ae15d7b9890cc4
from $HOME (abs paths) -> 1650abd603a0a378
```

**CANONICAL RECIPE — verified cwd-independent from four starting directories, all giving the same
value:**

```bash
(cd <repo>/db/migrations && shasum -a 256 *.sql | shasum -a 256 | cut -c1-16)
```

It retains the property that motivated binding filenames: renaming a migration still rotates the
digest with no SQL byte changed, because the runner applies in **lexical** order.

**W4's arbitration confirmed determinism, not correctness.** Reproducing W2's recipe from an
uninvolved session established that it was deterministic and that both parties described the same
tree — it could not detect a recipe that faithfully measures the *wrong thing*. In the vocabulary
this program adopted, that reproduction was **replication** (same mechanism, different author), not
corroboration. The one experiment that would have caught it — running the same recipe from a
*different cwd* — was never performed, by anyone.

Standing rule: **a third party reproducing your number confirms determinism, not correctness.**

| Property | Value |
|---|---|
| files | **28** (`001`–`024`, `027`, `029`, `030`, `031`) |
| chain digest | **`6848bb5f20a21a8d`** |
| `030_w2_feed_context.sql` | `8bbc3e6043840cbc` |
| `027_w2_entity_kinds_profiles.sql` | `477c4dd6140f99a3` (rotated by G12's security fix) |
| `020_w2_collections_graph_undo.sql` | `33915548b445ddd3` (X01, unchanged since) |

All four recomputed independently by W4 and matching. `2a969baf9d98f300` is **two rotations stale**.
SEC-1's `031` will make it 28 — landing as a **new** migration rather than editing `016`/`007`,
because `db/migrate.mjs` enforces per-file immutability once applied.

**W4 independently verified W2's `030` retraction** rather than accepting a reversal in the
reassuring direction, on the principle that a retraction deserves the same scrutiny as the original
alarm:

```text
grep -nEi '^ *(alter|drop|create (table|index|trigger|policy|type)|grant|revoke)' \
  db/migrations/030_w2_feed_context.sql
  -> NO MATCHES   (120-line file)
```

Confirms two new `internal.` functions and nothing else; **`public.activity` is untouched**. The
earlier warning — that `030` would add a column and a BEFORE INSERT trigger to a shared table — no
longer applies: offered the choice between proving a trigger inert under three composed readers or
stamping from its own code paths, G13 removed the surface entirely. W4's unprompted naming of
`entities.activity` as the at-risk composed reader is what triggered that constraint.

W4 settled a two-way recipe dispute as the uninvolved third party by reproducing all four
candidates. W2's formula reproduced exactly; three obvious content-only variants did not match
the competing digest. The substantive argument for binding **filenames**: the official runner
applies migrations in **lexical** order, so a rename or renumber changes **execution order**
while changing no byte of SQL — a content-only digest would call that identical.

**Every W4 integration result records the chain identity it was measured against and is
re-run rather than carried forward across a rotation.**

#### The principle that makes this non-optional

> **Composition governs which HTTP routes are MOUNTED. It does not govern what the DATABASE
> ENFORCES.**

Formally retired as an invalid inference this session, after a *later* migration (020) broke an
*earlier* caller (018) through shared machinery, with the constraint enforced at write **inside
the caller's transaction** — silently destroying posted messages through five gates.

**Named consequence for W4 at the announced 26 → 27 rotation:** migration `030` adds
`activity.logical_operation_id` plus a recorder-owned BEFORE INSERT trigger on
`public.activity`. **`entities.activity` is a G02 operation — composed, mounted, implemented,
and bound by W4 group 3.** So `030` places a trigger on the write path behind an
already-callable read; its effects are observable through `GET /v2/entities/:id/activity`
without a single line of G13 being registered. Plausibly also in radius: `entities.get` /
`entities.children` if activity feeds `activityAt` on the entity envelope, and
`collections.query` (G05) under the `activityAt_desc` sort, which is in the frozen CLI grammar.

W4 therefore does **not** claim `entities.activity` coverage across the `030` boundary.

### 2.5.3 W4 finding — `clientMutationId` is published, not secret

Raised in response to a live security question: a pre-authorization `internal.ledger_replay`
return lets a caller who **knows** another principal's `clientMutationId` obtain that principal's
stored result. Both the program coordinator and W2 framed the decisive variable as *guessability*,
and asked W4 whether its derived mutation IDs are predictable.

**W4's mutation IDs are not the weak link.** Verified at source in
`packages/cli/src/mutation.ts`:

- root id = `uuidv7(Date.now(), randomBytes)` — `node:crypto` CSPRNG, **74 bits of entropy**
  (48-bit timestamp prefix is predictable; entropy is 74 bits, not 128)
- `deriveMutationId(rootId, stage)` = `sha256("tm8/mutation/" + rootId + "/" + stage)` → v8 UUID
- **No attacker-visible input enters the derivation** — no filename, checksum, entity ID,
  timestamp, or counter. Derived ids are as unguessable as the root.
- Caveat: the derivation is public and deterministic, so disclosure of one root yields all of that
  upload's stage ids.
- The `§4.10` "deterministically derived" requirement is a design-doc rule; the **specific function
  is a CLI implementation choice**, changeable on ruling.

**But guessability is the wrong axis.** Two frozen DTOs publish `clientMutationId` as an ordinary
readable field, and the dossier *mandates* the equality:

| Published as | Source | Dossier | Reachable today |
|---|---|---|---|
| `messageBatchId` on `CoreEntityState kind:'message'` | `contract.ts:93`, `schemas.ts:164,542` | `messageBatchId == clientMutationId` | **YES** — it is message *entity state*, so `messages.list`, `entities.get`, `entities.children`, `collections.query` all return it, and all are composed |
| `HandoffView.handoffId` | `schemas.ts:1280` | A05: `clientMutationId: string; // handoffId exactly` | latent — G04 uncomposed |

So the exploit precondition is **one ordinary read**, not a 74-bit guess. W4 verified only that the
contract publishes these ids; **public reachability remains W3's measurement** and still decides
real severity.

**Recommendation made — against W4's own convenience.** A proposed "`clientMutationId` MUST be
unguessable" law should **not** be adopted: it is unsatisfiable by construction against a dossier
that publishes the same value, and it is dangerous in the comfortable direction — it would read as
defence-in-depth while providing none, and would later license the inference "cmids are unguessable
per the law, so pre-authorization replay is low severity." Principal-pinning is not belt-and-braces
here; **it is the only belt**, and it is correct precisely because it does not depend on cmid
secrecy. The enforceable law is the inverse:

> `clientMutationId` is a **correlation identifier, not a capability**. It is published in read
> DTOs by design. **No authorization decision may depend on its secrecy.**

**W4 posture:** no CLI affordance will treat a cmid as secret; groups 5 and 10 carry an explicit
note that `messageBatchId` is a published correlation id and no surface may imply it is sensitive
or usable as an authenticator.

#### 2.5.3.1 Scope correction — "74 bits" is a CLI property, not a system property

W4's entropy measurement was correct **about the CLI** and stands. But it was delivered into a
thread about *system* severity, where it read as reassurance about the floor for cmids the server
**accepts**. It is not one, and that omission errs in the comfortable direction.

The missing sentence: *"this is the floor for cmids the CLI **generates**, and says nothing about
the floor for cmids the server **accepts**."*

Verified at source by W4:

```text
packages/ui/src/collab-v2/collections/graph/GraphCanvas.tsx:202
  clientMutationId: `cv2g_${draft.source.id}_${draft.target.id}_${type}`
```

A pure function of two **readable** entity UUIDs — zero entropy, fully computable, no guessing
required. Other shipped UI paths use `Date.now()` plus a counter that resets on page load, driving
`readMarks.upsert` (G08, **composed**).

And the contract constrains it **less** than reported elsewhere — at
`packages/contract/src/schemas.ts:613-645` the command-context sites are bare
`clientMutationId: z.string().optional()`: no `.min(1)`, no regex, no UUID check, no length bound.

This reinforces the adopted law from a second direction: *"clientMutationId must be unguessable"*
was not merely unsatisfiable going forward because the contract publishes cmids — **it was never
true of the system as shipped**. A law is not defence in depth when live code already violates it.

#### 2.5.3.2 Group 8 consequence — the CLI is the harvest tool when G10 composes

Four v1 read DTOs publish cmids by design, behind **three** uncomposed groups (G04, G10, G13). The
worst is `events.poll` / `events.subscribe`: `workspace_events_select` authorizes on **Space
membership only**, and the WS path broadcasts one `JSON.stringify` to every socket on the Space with
no per-subscriber redaction — real-time harvest, not after-the-fact read.

**Those two operations are W4 group 8.** `tm8 event watch` binds `events.subscribe`; `tm8 event
list` binds `events.poll`. When G10 composes, `event watch --format jsonl` would stream every Space
member every other principal's cmids, one per line.

Group 8 rules — **approved by the full-program coordinator as requirements, not preferences**:

- **Render server frames faithfully. Do NOT sanitize or strip `clientMutationId`.** Hiding a
  server-side disclosure in the client would make the defect invisible to the gate that must see it,
  and W3's negative has to observe it through the public surface.
- **But do not amplify it:** no caching of event frames to disk, no persisting cmids into any config
  or state file, no echoing them into help/discovery caches. Faithful rendering, zero retention.
- No `event watch` coverage is claimable until G10 composes **and** this is resolved. W4 supports
  extending the composition brake to **G10**, alongside G04 and G14 — for its own wave's surface.

Related: `ledger_replay`'s `23514` interpolates the cmid and the true owner's operation label into
message text that reaches the wire verbatim. The kernel renders server error text faithfully to
stderr — correct, and deliberately **not** sanitized. The CLI adds **no persistence**, so it does not
extend that oracle's lifetime beyond the terminal. **The interpolation is being removed
server-side** (SEC-1 Stage 1b), which is where it belongs: the client stays honest and the
disclosure is fixed at its source.

The governing principle, approved and generalized: **a client that conceals a server defect is worse
than one that displays it.** Sanitizing would hide the disclosure from the very gate that must
observe it through the public surface. Display, never extend.

**Incoming shared-machinery change, no W4 impact:** the principal check moves inside
`internal.ledger_replay` itself (migration `032`), closing the principal half of all 114 sites at
once, fail-closed, identity-only. It does **not** make the per-site resource work optional —
`ledger_replay` cannot know which resource the current request addresses. Expect a chain rotation
and rebind. W4's availability path and faithful-rendering rules are unaffected either way.

### 2.6 Wave-wide defect: `typecheck` covers no test file

`bun run typecheck` type-checks **no test file anywhere in the repo** —
`packages/server/tsconfig.json` sets `include: ['src']`, so `tsc -b` never sees `test/**`, and
vitest transpiles without type-checking. Not theoretical: a W2 worker type-checking its own
test files separately caught a real `TS2322` that both vitest and `bun run typecheck` passed.

**W4 confirmed the blind spot applies to its own packages** rather than assuming it from the
server report:

```text
packages/cli/tsconfig.json      "include": ["src"]    → test/** NOT type-checked
packages/prompt/tsconfig.json   "include": ["src"]    → test/** NOT type-checked
```

**Mandatory in every W4 worker packet from Slot A onward:** each worker type-checks its own
test files separately against `tsconfig.base.json` with a scratch config and reports it as its
**own named result**. No packet may claim "typecheck green" as covering tests. **No tsconfig
`include` may be widened** — that is a separate scoped task with its own gate, not a side
effect of this wave.

Related and already correct: `tsconfig.base.json` sets `noEmitOnError: true`, carrying a
comment recording a real prior incident — a full green verification was once run against a
`dist` emitted from a red build. W4 preserves that setting and never verifies against a
stale `dist`.

---

## 3. Authority stack and resolved conflicts

Four authorities govern the CLI and they disagree in five places. All five were resolved by
precedence and recorded; **none was silently normalized**.

**Precedence used:**

1. `packages/contract/src/catalog.ts` — frozen operation names and bindings
2. `W0-AMENDMENT-DOSSIER.md` §4/§7 + `W0-CONSISTENCY-MATRICES.md` §3 — DTOs, closed
   error taxonomy, per-row CLI command path, 12 detailed capability grammars
3. `CLI-GRAMMAR-REDESIGN.md` — global options, exit codes, output law, per-command flags,
   help/completion
4. `AGENT-HARNESS-AND-COMMAND-DISCOVERY.md` — help JSON shapes, byte caps, manifest,
   kernel, lazy discovery, trusted-control templates

| # | Conflict | Resolution |
|---|---|---|
| R1 | Dossier has **no `--json`** and treats the JSON envelope as unconditional; grammar §3 and the harness doc both use `--format human\|json\|jsonl` | Adopt **`--format`**; do **not** add `--json`. The dossier is *silent*, not prohibitive; two authorities specify `--format`. Legacy `--json` retired. |
| R2 | Dossier never blesses `--as`/`--space`; grammar §3 defines both as global options with a 4-step context resolution order | Adopt both from grammar §3. No conflict with the dossier's act-as rejections, which are narrowly A17–A20 + `session spawn --interaction-profile` requiring a human principal → implemented as hard `forbidden` / `profile_principal_required` negatives. |
| R3 | Dossier freezes only exit 0 and exit 11 | Not a gap — grammar §7.6 freezes the full table `0,2,3,4,5,6,7,8,9,10,11,130`. Adopted verbatim. |
| R4 | Grammar §4.16 requires `completion bash\|zsh\|fish` and `<command> --help`; harness §7.2 requires `--query <intent>` and `--operation <OperationName>` and specifies **neither** completion nor `--help` | **Union.** One help-first spine, additive not contradictory. All surfaces implemented. G4 names completion explicitly, so grammar §4.16 governs over harness silence. |
| R5 | Grammar §8 is an **81-row** coverage table and its conformance IDs D1/D2 say 81; the frozen catalog is **101** | Matrices §3 supersedes grammar §8 for coverage counting. The exhaustiveness gate asserts **101**. Recorded so a reviewer reading D1/D2 verbatim does not read 101 as drift. |
| R6 | `--timeout` has **no unit in any authority** | **Seconds** (curl/ssh convention for a user-facing CLI). No dossier amendment — matrices §3 governs CLI dispositions and this sits within it. **The unit must be explicit at every surface** (`--timeout <seconds>`): an unlabelled duration flag is how a 30-second timeout silently becomes 30 ms in a script, and the failure is silent on both sides. → O3 |
| R7 | Exit **6** merges `version_conflict`, `conflict`, and `invariant_violation` | **Keep the merge.** §7.6 names that row "version conflict or invariant violation" and offers no other slot for a generic 409. Reserving 6 strictly would require inventing a new exit code — inventing outside the dossier. Typed codes still distinguish them; only the shell category merges, exactly as the frozen table specifies. |
| R8 | `--json` refuses with a hint naming `--format json` | **Keep it.** This is D6 discovery-hint treatment identical to the retired verbs: it refuses, exits 2, writes nothing to stdout, puts nothing on the wire, and never routes the command. What is forbidden is a **silent alias** that quietly does the work; a refusal naming where the capability went is the opposite. |

### 3.0 R1 follow-on: what the DEFAULT format is

R1 settled *which flag exists* but not *what happens with no flag* — a detail that would
silently diverge across eleven groups and is directly in G4's line of fire ("JSON output
matching the contract"). Pinned centrally here rather than left to each worker:

- The dossier §7 sentence *"All commands use standard JSON envelopes, closed errors, exit 0
  success"* describes the **wire envelope** (`{data, requestId}` / the closed error body). It
  is not a statement about CLI stdout rendering, and must not be read as "the CLI prints JSON
  by default".
- Grammar §7.1 says *"`--format json` emits the exact contract DTO"* — phrased as something
  you **opt into** — and separately that *"human views are rendered from the same DTOs as
  JSON"*, i.e. human is a rendering **of** the DTO, not a different payload.

**Adopted:** `human` is the default; `--format json` opts into the exact contract DTO;
`--format jsonl` is for long-lived or explicitly paged streams. Human rendering is always
derived from the same DTO — never a second shape, and never a superset. **IDs required by a
follow-up command are never omitted from human output**, which is the one place a human
renderer is most tempted to drop a field.

### 3.1 Cardinality traps — a naive 1:1 generator gets these wrong

- `messages.post` is **one operation, two commands**: `message send` **and** `message reply`
  (composite; parent and anchor derived Server-side).
- `files.uploadInit` + `files.uploadComplete` + `files.uploadAbort` are **three operations
  behind one staged command** `file upload` (+ `file upload abort`). Each stage takes its
  **own** deterministically derived mutation ID; one ID may never be reused across stages.
- `entities.commands.complete|work|linkPr|linkCommit` are `entities.*` operations exposed
  under the **`task`** noun — the only noun/namespace divergence in the frozen set.
- **The two reserved rows are asymmetric.** `search.query` **gets** a `search query` command
  that returns honest unavailability. `bridge.fetchBlob` gets **no command at all**, but
  stays totally discoverable via `tm8 help --operation bridge.fetchBlob`. This is how
  "never hide them" is satisfied without inventing a command the matrix forbids.

### 3.2 B1 — no public prompt seam

`execution.prompt` has **no CLI form**, not even hidden or debug. Exact-operation help must
return `exposure='internal'`, `reason='use_message_send'`, and the `messages.post` public
composite, and must **never render an invocation syntax**. Every Member/Teammate/owner/admin/
session-token/act-as caller receives `forbidden` with `details.reason='use_message_send'`.
Legacy `whoami`, `report`, `progress`, and public `session prompt` must **fail with a
discovery hint** (conformance D6) rather than simply not existing.

---

## 4. The three orthogonal axes — and the availability ruling

The full-program coordinator ruled that per-operation availability is a **permanent
first-class field**, not a transitional scaffold, because per-node capability variation is a
designed concept (`PHASE-2-REMOTE-SERVER-INTEGRATION.md` §4.1, §5, §11).

W4's preflight finding is that **three orthogonal axes** are being conflated, and the
pipeline carries two of them well and the third not at all:

| Axis | Scope | Source | Status |
|---|---|---|---|
| **Exposure** | static, contract-level, node-independent — `public \| composite \| internal \| reserved` | frozen catalog + dossier | **Exists and is correct** (97 public, 1 composite, 1 internal, 2 reserved) |
| **Availability** | per-node, per-deployment — is it implemented on *this* node? | — | **No source today.** The ruling's new field |
| **Permission** | per-actor, per-target, per-epoch | `actions.list` → `DiscoveredAction.allowed` + `reasonCode` + `capabilityEpoch` | Exists, composed (G09), W3-PASSED |

**Permission cannot be made to answer availability.** Its `reasonCode` enum is exactly
`ROLE | STATE | TRUST | ASSOCIATION | POLICY` — there is no not-implemented member, and
adding one would invent a DTO value outside the dossier. The axes are also independent in
both directions: an operation can be implemented-but-forbidden, or unimplemented-but-permitted.

### 4.1 Why the generated manifest is not an availability source

Recorded because the artifact that *looks* most like one is stale by construction:

- `serverRegistries.unimplementedV1Http` = **70**, derived from
  `readHistoricalW1RegistrySnapshot()` — a deliberately **historical** W1 snapshot of 28
  handlers (98 − 28 = 70) — against a live residual of 25.
- `routes.http[].status = 'registered'` for 98 rows means **mounted**, read statically from
  the router source. Not implemented.
- It lives in `tools/conformance/**` (not W4 territory) and is frozen at `062ec620…`.
- A build-time constant structurally **cannot** describe a remote node — precisely the
  Phase-2 case the ruling says is permanent.

This is flagged as a **reader trap, not a defect**: the artifact is correct for what it
claims to be. It was reported to W2 as FYI so nobody misreads 70 as a regression against 25.

### 4.2 Adopted mechanism — **APPROVED** by the full-program coordinator for W4/G4

Zero Server change, zero new operation, zero dossier amendment:

```text
availability:       'available' | 'unavailable' | 'unknown'
availabilityReason: 'reserved' | 'not_implemented_on_node' | 'observed_ok' | null
availabilitySource: 'contract' | 'observed' | 'advertised'
```

Populated in strict source precedence:

1. **contract** — offline, node-independent: the 2 reserved rows resolve to
   `unavailable`/`reserved`. This alone satisfies the G4 clause "reserved operations are
   honestly unavailable" with **zero network**.
2. **observed** — the honest 501 *is* the per-operation signal, and it is free and safe to
   trust because W3 already proved 501 is pre-validation, reserves no `clientMutationId`,
   and partially applies nothing. Observation is a by-product of calls already made.
   **Mutations are never probed.**
3. **advertised** — reserved slot for a future node-advertised capability set, which becomes
   the **highest-priority source filling the same field**. Nothing is deleted at G3 or at
   Phase 2.

`/health` is used **only as a cache-invalidation epoch**, never as a per-operation claim:
when `{operations, implemented}` changes, the learned-unavailable set is dropped. The cache
converges as W2 composes while never asserting anything unobserved. This epoch is kept
**distinct from `capabilityEpoch`** so implementation is never conflated with authorization.

Default state is `unknown`, rendered as unknown, never guessed as available.

**Stated cost, not oversold:** this does not fully solve cold planning. An agent planning
from a cold cache still cannot tell which of the 98 mounted operations will do work, because
`unknown` is the honest answer before anything has been called. It converts an invisible
failure into a visible, typed, correctly-attributed one. **Only a node-advertised capability
set makes cold planning correct**, and that requires a Server change → arbitration, not a G4
blocker.

Two constraints imposed with the approval, both adopted:

- The `/health` epoch stays **distinct from `capabilityEpoch`**. Conflating them is exactly
  the axis-2 / axis-3 collapse refused in §4.
- `unknown` **renders as unknown** and is **never** optimistically shown as available. An
  honest "I don't know yet" is the entire value of the field.

### 4.3 W6 / Phase-2 handoff requirement — recorded, deliberately NOT actioned

Option B (a node-advertised capability set) is the **only** mechanism that makes cold
planning correct. Remote / Phase 2 is explicitly out of scope for W0–W5, so the full-program
coordinator directed that no arbitration case be opened now and that the requirement instead
be **recorded here so the next program inherits it rather than rediscovering it**:

> **REQUIREMENT FOR W6 / PHASE 2.** The Server must advertise a per-operation capability set
> so a cold client can determine availability without first calling an operation. This is
> already the written Phase-2 design — `PHASE-2-REMOTE-SERVER-INTEGRATION.md` §4.1 ("The
> Server advertises its stable identity, contract version, capabilities, and the Spaces
> visible to the authenticated account"), §5 ("`execution.spawn` — when capability permits",
> and "Capability availability" as a named change axis while operation names, DTOs, and the
> error taxonomy explicitly do **not** change), and §11 freeze-requirement 6 ("Capability
> discovery and contract-version negotiation").
>
> W4 has left the socket open at zero cost: `availabilitySource: 'advertised'` is already the
> highest-priority source in the precedence chain. A future implementation fills the existing
> field; **nothing built in W4 is deleted or reshaped** to accommodate it.

---

## 5. Group plan

| Group | Scope | Dependency | State |
|---|---|---|---|
| 1 | global grammar, auth/context, output, errors, mutation IDs | none — contract-driven | **Slot A, in progress** |
| 10 | kind/search/help/completion + generated discovery | Slot A output layer | queued (Slot B) |
| 11 | harness bootstrap, scoped credentials, lazy discovery, orchestration prompts | Slot A | queued (Slot C) |
| 2 | Space + identity/admin | G01 composed + W3-PASSED | integration-ready |
| 4 | edge/connection/placement | G03 composed + W3-PASSED | integration-ready |
| 6 | Project/file/bridge | G06 + G07 composed + W3-PASSED | integration-ready |
| 7 | inbox/read-mark/saved-view/action | G08 + G09 composed + W3-PASSED | integration-ready |
| 3 | entity CRUD/query/context/feed + task commands | G02 composed but ungated; `entities.feed`/`context` are G13 (501) | partial |
| 5 | message/reply/attachment/delivery/handoff | G04 not composed | contract-only |
| 8 | event/presence/watch | `presence.get` G10 (501); `events.subscribe` is a **WS skeleton** | contract-only |
| 9 | session/execution/profile | G12 not composed | contract-only |

Slots are package-disjoint inside `packages/cli/**`. Slot A must freeze first because Slots
B and C both depend on its exit/error/output/context layer.

### 5.0 Seam management — the rule that lets slots run in parallel

**Never hand a shared seam to two workers.** Applied twice, both times *before* spawning rather
than diagnosed after:

1. **`src/run.ts`** — Slots B and C would both naturally have edited it to register commands.
   Assigned to **Slot B exclusively**; Slot C is barred and hands the coordinator an exported
   handler to sequence after B freezes. Verified holding: `run.ts` mtime unchanged since Slot A
   while both slots ran concurrently.
2. **The `COMMANDS` array** — Slot A left registration as one inline array in `run.ts`. Groups 2–9
   are **eight more workers**, all of which would append to that one array in that one file. Slot B
   was asked, while it still owns the file, to compose `COMMANDS` from **per-noun modules**
   (`src/commands/<noun>.ts`) assembled in a `src/commands/registry.ts`.

   Result: a future domain slot adds **one file it exclusively owns** and touches nothing another
   worker is editing. The single shared line — the import and spread in `registry.ts` — becomes
   **coordinator-owned**, wired in as each group lands. No domain slot edits `registry.ts` or
   `run.ts` at all.

   Deliberately *not* solved with auto-discovery: dynamic scanning would break the closed-grammar
   property that both the EBNF and the help surface depend on. Static imports and a spread.

   Required invariant test: every registered command path is reachable through dispatch **and**
   present in the help projection — catching a future slot that wires a command it forgot to
   document, or documents one it forgot to wire.

### 5.0.1 Coordinator-owned artifacts

Two files are owned by the coordinator precisely because every domain slot needs them, and a file
every slot needs is a seam no slot may own.

| File | Why coordinator-owned |
|---|---|
| `src/commands/registry.ts` | the single composition point. Each slot exports a `CommandModule[]`; the coordinator adds the import and spread. Eight slots therefore never share a line. |
| `test/integration/harness.ts` | the real-Server harness. Written and verified once, consumed read-only, so there are not eight ways to start a Server and eight opinions about ports. |

**The harness spawns the built binary as a child process** rather than importing `bootstrap()`.
Importing the server would prove the CLI can call a *function*; it would not prove the CLI can talk
to a *Server*, and it would let a test quietly depend on server internals — the coupling the catalog
exists to prevent. It uses the **official** `db/migrate.mjs` runner on an isolated scratch database,
and registers nothing: an uncomposed operation is observed answering its honest 501, because a
harness that helped an operation answer would be measuring itself.

Three defects were found and fixed **in the harness, before any worker received it**:

1. **`psql` hung on stdin.** A Homebrew Postgres also answers on 5432 and requires a password for the
   login role — worse than being down, because `psql` then blocks silently until the hook times out
   120 s later with nothing explaining why. Fixed by targeting the dev sidecar (5442, role `tm8`) and
   adding **`-w`**, which turns a misconfiguration into an immediate legible error. `-w` is
   load-bearing, not tidiness.
2. **`TM8_PORT=0` is rejected** by `loadConfig`. The documented workaround overrides config after
   validation, which requires importing the server and forfeits the child-process property. Fixed by
   asking the OS for a free port via a probe socket. The narrow close-then-bind race is accepted
   deliberately; the alternatives are a fixed port (guaranteed collision between concurrent slots) or
   importing the server.
3. **The availability probe over-claimed** — see §5.0.2. This is the one that mattered.

### 5.0.2 The harness reproduced a known measurement-validity defect — caught before shipping

The first `isImplemented()` returned a **boolean** and reported `messages.post` as implemented.
`messages.post` is a **registered, unconditional 501 stub**. Measured on this host:

| Operation | Empty-body response | |
|---|---|---|
| `messages.post` — registered **stub** | 400 `invalid_input` | ← indistinguishable |
| `spaces.create` — registered, **live** | 400 `invalid_input` | ← indistinguishable |
| `entityKinds.create` — **not registered** | 501 `not_implemented` | distinguishable |

Handler lookup **precedes** schema validation, so an invalid body never reaches the handler and the
stub's own `throw not_implemented` never fires. A boolean probe therefore counts an unconditional stub
as implemented — **the exact defect an independent gate self-reported in its own classifier on this
program.** W4 reproduced it independently, in an artifact about to be handed to four workers as their
availability oracle.

Fixed by making the API **three-state**, matching §4.2's model:

```text
'unavailable' — 501 not_implemented. DEFINITIVE: no handler here.
'unknown'     — 400 invalid_input. Registered, but the handler never ran. UNOBSERVED.
'available'   — anything else. The handler ran.
```

Resolving `'unknown'` requires a **schema-valid** body, which is domain work belonging to the group
that owns the operation — not to a generic harness. The trap is pinned by assertion, so a future edit
that collapses `unknown` into either neighbour fails.

### 5.0.3 Bind coherence — added before spawning, not after losing a sweep

Migrations are landed by another wave *while* these tests run, and a scratch database is built from
whatever is on disk when it is created. A suite can therefore **straddle a landing** and produce a
count bound to two different trees — meaningless, and it reads exactly like a good result. Three other
waves discarded sweeps to this; one threw away an 87/87 green rather than report it.

`server.bindStart` records the chain identity at migration time and `assertBindCoherent()` throws if
it moved. Independently measured at spawn time: **28 files / `8c5227dfe17923c2`**, matching the
published identity. Workers are told a throw during a landing is **expected** — discard and re-run,
never report — and never to pin a digest in an assertion, since a batch landing is inbound.

### 5.1 Slot register

| Slot | Group | Task | Session | State |
|---|---|---|---|---|
| A — CLI kernel | 1 | `task_1785094128003_q4zs92825` | `sess_1785094133588_jtek65s91` | **FROZEN** (§8.1) |
| B — generated discovery | 10 | `task_1785094634129_eebw2hu9s` | `sess_1785095721757_hm2tfxh78` | **FROZEN** (§8.2) |
| C — harness | 11 | `task_1785094634574_nkm3u0yad` | `sess_1785095727465_ao1lpzrm2` | **FROZEN** (§8.2) |
| D — space + identity | 2 | `task_1785100351215_bj7y2cuw9` | `sess_1785100406108_snvkvvskq` | executing |
| E — edge + placement | 4 | `task_1785100351505_5e39ap7f8` | `sess_1785100409093_aw2ma36k7` | executing |
| F — project + file | 6 | `task_1785100351790_ibdjmdh5r` | `sess_1785100452403_xaxysrr51` | executing |
| G — inbox + saved-view | 7 | `task_1785100352187_j1vnzwa0i` | `sess_1785100413671_vd3oxl5y5` | executing |

Wave 2 (D–G) is the four groups whose server operations are **composed and independently
W3-PASSED**, so they can produce real G4 integration evidence rather than contract-only coverage.
Groups 3, 5, 8, 9 remain and are contract-only until W2 composes G02's fix, G04, G10 and G12.

**Seam ruling issued to Slot E before it wrote code:** `entity connections` returns `Page<EdgeView>`
and is edge-shaped, so Slot E registers `['entity','connections']` from its own module even though the
path sits under the `entity` noun. A noun is not an ownership unit here; a module is. Group 3's packet
will state the path is already taken. Slot E had correctly identified that `registry.ts` throws at
**import** on a duplicate — so a double registration is not a subtle test failure but a hard
import-time collapse of the whole suite for every slot at once.

Slot A's red-first target is a **genuine pre-existing production defect**, not a manufactured
one: `packages/cli/src/exit.ts` defines `EXIT_REFUSED = 3` ("the server refused") and
`EXIT_UNAVAILABLE = 4` ("unavailable"), while grammar §7.6 freezes **3 = unauthenticated** and
**4 = forbidden**. Same integers, different meanings — any consumer that learned the shipped
mapping breaks silently.

---

## 6. Environment and hygiene

- **Disk:** 11,985 MiB free on `/System/Volumes/Data` at preflight — well above the 150 MiB
  abort floor and 200 MiB escalation floor.
- **Postgres:** 18 running, accepting connections on `:5432`. Real-Server integration is
  feasible.
- **Official migration runner:** `db/migrate.mjs` (`status | up | up --dry-run | create-db |
  reset --force`). 26 migrations on disk (001–024, 027, 029).
- **Server startup:** `bun run build:server`, then
  `TM8_DATABASE_URL=<url> TM8_DATA_DIR=<absolute-private-dir> TM8_BIND=127.0.0.1
  TM8_PORT=4610 node --enable-source-maps packages/server/dist/index.js`.
  **Without `TM8_DATABASE_URL` the registry is empty and every operation returns 501** —
  that mode is not an implementation verdict and mistaking it for one invalidates a run.
- **`/health` is outside the envelope.** Never run it through an envelope extractor; W3 lost
  a cycle to exactly that.
- **Vitest:** `--no-file-parallelism` always, one vitest process per session, scratch
  databases torn down every run. There is no `vitest.config.ts`, so the flag must be passed
  every time.
- **DB slot: the serialized-slot regime was withdrawn by W2** once ~12 GiB was free and zero
  scratch-database leakage was verified. W4 may take it without asking. Hygiene still stands:
  `--no-file-parallelism`, one vitest process at a time, tear down every scratch DB, and
  announce long runs so no coordinator misreads another's transients.
- `timeout(1)` is **not installed** on this host.

---

## 6.1 Method — enforced on every W4 worker

**TDD, red first.** Every worker writes or tightens a genuinely failing test, records its
**exact red output**, implements, then runs the scoped suite plus build plus typecheck. A
worker reporting green with **no recorded prior red is rejected and rerun**. This coordinator
independently reruns each group's suite before freezing it; a worker's own green is entry
evidence, not a verdict.

**When a law already holds** and a production red cannot be obtained without breaking
production, a worker must do one of the following and **label honestly which**:

1. **Mutation-test** — deliberately break the production line under test, show the new test
   fails, revert, verify the revert restored green.
2. **Probe-red** — feed the assertion the input that *should* make it pass and show it fails,
   proving the assertion discriminates rather than passing vacuously.

Manufacturing a fake red, or claiming a bare pass, is not acceptable. This matters most for
exhaustiveness tests over the 101 catalog rows: a loop that silently iterates zero rows, or an
assertion comparing `undefined` to `undefined`, is the classic vacuous pass.

Knowing when the technique is **not** needed matters equally. Slot A's exit-code collision is a
genuine pre-existing production defect and produces an honest natural red; manufacturing
ceremony around it would be noise.

### 6.2 Cross-wave collision discipline

`bun run typecheck` and `bun run build:server` compile the **whole workspace**, so an
in-progress W4 edit is visible as red to two other waves. This is not hypothetical: at 01:04:40
Slot A's `exit.ts` rewrite dropped `EXIT_REFUSED`/`EXIT_UNAVAILABLE` while `client.ts` and
`run.ts` still imported them — 3 × `TS2305` + 1 × `TS2339` — and a W2 worker had to stop
mid-sweep to check whether it was their own regression. Resolved within minutes; W2 filed
nothing.

**Outbound rule.** An export change and **all** its call-site updates land in **one step**. W4
owns the whole package, so there is never a case where both cannot be done together. If a wide
window is genuinely unavoidable, it is announced to W2 and W3 *before* it opens.

**Inbound rule.** A typecheck or build failure pointing at a file W4 does **not** own is almost
certainly a sibling mid-edit, not a W4 regression. Re-run before reacting; report only if it
persists across **two** runs; **never** fix a sibling's file, not even a one-line obvious fix.

**Signature and technique.** Two identical sweeps disagreeing in their *failure count* is the
signature of concurrent edits, not flakiness. Rather than assume blame or innocence, **test
causation**: revert the local change, re-run, see whether the failures persist; restore, re-run
again. Adopted from W2's X01 worker, which used it to resolve a 13-vs-6 discrepancy.

---

## 6.2.1 ⛔ Account-wide session limit — wave 2 blocked, state preserved

All four wave-2 slots return verbatim, on every prompt:

```text
You've hit your session limit · resets 5:10am (Asia/Calcutta)
```

| Slot | Session | Observed |
|---|---|---|
| D space+identity | `sess_1785100406108_snvkvvskq` | 02:49:05, again 03:26:14 |
| E edge+placement | `sess_1785100409093_aw2ma36k7` | 02:49:13, again 03:26:12 |
| F project+file | `sess_1785100452403_xaxysrr51` | 02:48:56, again 03:26:02 |
| G inbox+saved-view | `sess_1785100413671_vd3oxl5y5` | 02:48:55, again 03:26:09 |

**Account-wide, not per-session:** all four hit it within 18 seconds of each other *before* any packet
was sent, and again on receipt. A per-session budget does not synchronise that way. **Respawning
therefore does not help** — a fresh session draws on the same exhausted budget. The four sessions are
deliberately **not killed**: they hold complete packets and can resume on a one-line prompt at reset.

**Why it is dangerous rather than merely annoying — it counterfeits progress.** A limited worker
accepts the prompt, writes nothing, touches no file, and sits there. That is indistinguishable from a
worker thinking, from the NEEDS-INPUT stall seen earlier in this wave, or from a worker mid-edit, and
`find -mmin` shows the same nothing in every case. **The distinguishing signal is the literal string
in the session log, not the absence of output:**

```bash
maestro session logs <sid> | grep -i "session limit"
```

Relayed to W2 and W3 unprompted, because it is materially worse for W2: it has three workers in
flight and has adopted batch landing, where nothing lands until all three handoffs are in hand — so a
limited worker presents as a slow author rather than a stopped one, while the directory is held open
for handoffs that cannot arrive.

**Coordinator's own capacity was deliberately not substituted for the workers'.** Taking over four
groups of domain implementation would put implementation and independent verification in one session
and forfeit the rerun property that has caught a real defect in every group so far — including two in
already-reported work. Escalated for an explicit ruling rather than resolved by convenience.

**Nothing is lost.** Tree green at the moment of the blocker: `packages/cli` 19 files / 288 tests,
`packages/prompt` 4 / 52, `build:cli` exit 0, workspace typecheck exit 0, separate test-file typecheck
exit 0. Wave-2 groundwork (§5.0.1–§5.0.3) survives the outage in full: the registry composition point,
the verified real-Server harness with three-state availability and bind-coherence checking, and four
complete delivered packets. No DB-backed run will start while blocked, so the migration directory
stays uncontested for W2's batch landing.

## 6.3 OPEN G4 OBLIGATIONS — must not be quietly forgotten before the gate

| # | Obligation | Owner |
|---|---|---|
| **O1** | **Exit 11 proven end-to-end** by `message send --wait settled` against a real Server. Implemented and unit-tested in the kernel; **behaviour unproven end-to-end by definition** until a command exercises it. | group 5 |
| **O2** | **Exit 130 proven** via a real interrupt path. Same status as O1. | group 1 + a long-running command |
| **O3** | `--timeout` rendered as **`--timeout <seconds>`** at every surface — help, completion, error text. | group 10 |
| **O4** | No CLI surface implies `messageBatchId` / `handoffId` / mutation ids are secret or usable as an authenticator. | groups 5, 10 |
| **O5** | Undo of a `messages.delete` token rendered as **redaction / state transition**, never "delete". | groups 4, 10 |

O1 and O2 are recorded as honest kernel-ready-but-unexercised states rather than papered over with
synthetic coverage.

## 6.4 M-1 spawn audit — coordinator-side and mechanical

The worker-side audit is **not mechanically verifiable**: `maestro whoami` / `status` expose only
`mode`, `sessionId`, `projectId`, `task` — no `provider`, `agentTool`, `model`, `reasoningEffort`,
or `accessMode`. A worker can only self-report. Ruled program-wide: **the M-1 obligation sits with
the spawning coordinator**, who can verify it, and the worker's self-report is corroboration only.

W4's audit of the team member backing Slots A, B and C:

```text
maestro team-member get tm_1785091987091_id0qite2j
  ID          tm_1785091987091_id0qite2j
  Name        tm8 Opus Impl xhigh
  Mode        coordinated-worker
  Model       claude-opus-5          ✓ M-1 compliant
  Agent Tool  claude-code            ✓ not provider=openai
  Status      active
```

## 7. Arbitration items — all four RULED

| # | Item | Ruling |
|---|---|---|
| Q1 | Ownership of `packages/prompt/**` | **GRANTED with one hard limit.** W4 owns `packages/prompt/src/**` **content**. W4 may **not** change the exported API surface `packages/execution` consumes — `composePrompt`'s signature and the exported types it depends on — and may **not** edit `packages/execution/**` at all (W2's G11 territory). A signature change goes to the full-program coordinator for arbitration, never negotiated with W2 directly. |
| Q2 | Home of the `OperationDiscovery` projection table | **Approved as proposed.** Build it in `packages/cli` with the cross-check test against the generated manifest on noun/exposure/reserved-set. Relocation to `packages/contract` is a recorded post-G4 item — record it, do not do it. |
| Q3 | Availability mechanism | **Option C APPROVED for W4/G4, no Server-side change.** Option B is **not** to be opened as an arbitration case; it is recorded as a W6/Phase-2 handoff requirement in §4.3. |
| Q4 | Operation→schema binding | **Approved.** CLI-owned binding with an exhaustiveness test. Do **not** import `packages/server/src/facade/input-schemas.ts`. |

### 7.1 The `packages/prompt` defect Q1 unblocks

`packages/prompt/src/index.ts` is the trusted-kernel composer. Its only consumer outside
`packages/cli` is `packages/execution/src/spawn/SpawnService.ts:14`, importing exactly
`composePrompt`; `SpawnService.ts:172` carries a deliberate comment that spawn uses the exact
composer "so the two can never drift". `packages/cli/src/prompt.ts` and `src/manifest.ts`
already re-export `@tm8/prompt` wholesale.

It currently emits, **verbatim into a spawned agent's first token**:

- `tm8 task report progress`, `tm8 task report complete`, `tm8 task report blocked`
- `tm8 session report complete "<summary>"`
- and, to coordinators: *"this CLI has no spawn or session-prompt verbs, so you cannot
  delegate or message siblings — do the work yourself and report it"*

Every one of those is **rejected vocabulary** under B1 and the noun-first grammar, and the
delegation claim is false against the adopted grammar, which includes `session spawn`. This is
the most load-bearing string in the system and it is now W4's to fix. **Priority item for
group 11.**

`commandSurface()` at `packages/prompt/src/index.ts:223` is the concrete emitter — line 225
literally returns `{ usage: 'tm8 whoami', … }`, followed by the `task report` and
`session report` rows.

#### 7.1.1 Exact frozen API surface — verified at source, narrower than "all exports"

W4 verified the coupling rather than inheriting it. `grep` across
`packages/execution/src`, `packages/server/src`, and `packages/ui/src` returns **exactly one**
import site:

```text
packages/execution/src/spawn/SpawnService.ts:14   import { composePrompt } from '@tm8/prompt';
packages/execution/src/spawn/SpawnService.ts:173  const envelope = composePrompt(manifest, { … });
```

**Frozen — Slot C may not change these:**

| Symbol | Why |
|---|---|
| `composePrompt(manifest, runtime) → PromptEnvelope` | the single external call site |
| `PromptManifest`, `PromptRuntime`, `PromptEnvelope`, `AgentMode` | the types in that signature |

**NOT frozen — fully rewritable by Slot C:** `commandSurface()`, `CommandDoc`, `instructionFor`,
`profileFor`, `AGENT_MODES`, and every prompt *string* in the package. These are consumed only
by `packages/cli`, which W4 owns on both sides.

This matters: the rejected vocabulary lives entirely in the **rewritable** half. Group 11 can
replace the whole command surface and every instruction string **without touching the frozen
signature at all**, so the Q1 hard limit costs W4 nothing and no arbitration is expected.

---

## 7.2 Coordinator boundary audit — Slot A, in flight

Run by the coordinator with `find -mmin` (never git), mid-execution rather than at report time.

**Slot A's own edits — all 11 inside `packages/cli/**`, zero out-of-bounds:**

```text
src/args.ts  src/client.ts  src/context.ts  src/errors.ts  src/exit.ts
src/index.ts src/mutation.ts src/output.ts  src/run.ts     src/commands/worker-init.ts
test/exit-codes.test.ts
```

**Files modified outside `packages/cli/**` in the same window — attributed, NOT charged to
Slot A.** `find -mmin` cannot attribute an edit to a session, so attribution was reasoned from
what W2 and W3 had each announced in advance:

| File | Owner | Announced work |
|---|---|---|
| `db/migrations/020_…`, `test/db/w2-x01-embed-undo-redemption.pg.test.ts` | W2 | X01 embed-undo fix + the empirical test closing the 018/020 fixture gap |
| `db/migrations/027_…`, `facade/services/w2/entity-kinds-profiles.ts`, `test/db/w2-profiles.pg.test.ts`, `test/w2/entity-kinds-profiles.test.ts` | W2 | G12 audit-and-complete |
| `test/w3/public-harness.test.ts`, `g15-public.test.ts`, `g03-public.test.ts`, `discovery-adapter.ts` | W3 | re-pinning after the composition drift |

**Verdict: no W4 boundary violation.** Recorded this way deliberately — a `find`-based audit
that reported "files changed outside my tree" without attribution would have been a false
accusation against two peer waves.

### 7.2.1 Confirmations picked up by the same audit

- **W3 re-pinned to exact literals**, as it said it would: `public-harness.test.ts:37`
  `implemented → 73`, `g15-public.test.ts:68` `implemented: 73`, `:85` residual
  `toHaveLength(25)`. This includes the **fourth pin W4 found and W3 had missed** — the
  baseline suite, where a red would most naturally have been misdiagnosed as "the composition
  failed to boot".
- **X01 is being closed empirically, not statically.** W2's new suite deliberately applies the
  **full repository migration chain in official order**, because applying only the migrations
  under test would reproduce the exact fixture blind spot that hid the defect. Its stated
  expectation is that the embed undo token must be **redeemable**. Until it closes, W4 group 4
  continues to treat `placement apply … embed` as unsettled and will not advertise
  `commands.undo` as universally applicable.

---

## 8. Group freeze ledger

No group is frozen. A worker's own green is **entry evidence, not a verdict**; this
coordinator independently reruns each group's suite before marking it frozen, and rejects any
worker reporting green with no recorded prior red.

| Group | Red-first evidence | Implementation | Scoped green | Coordinator rerun | Verdict |
|---|---|---|---|---|---|
| 1 — kernel | coordinator mutation test (§8.1) | complete | 140/140 | **yes — §8.1** | **FROZEN** |
| 10 — discovery | 3 collection reds, verbatim | complete | 285/285 | **yes — §8.2** | **FROZEN** |
| 11 — harness | 3 reds; 75 vocabulary hits | complete | 285 + 52 | **yes — §8.2** | **FROZEN** |
| 2–9 | — | — | — | — | not started |

### 8.2 Groups 10 and 11 — freeze evidence, obtained by the coordinator

Both slots delivered full reports. Everything below was run by the coordinator against a **settled
tree** after both declared done — a worker's green is entry evidence, the rerun is the verdict.

**M1 — executed behaviour**

| Suite | Result |
|---|---|
| `packages/cli` full | **18 files / 285 tests passed** |
| `packages/prompt` full | **4 files / 52 tests passed** |
| `bun run build:cli` | exit 0 |
| `bun run typecheck` (whole workspace, incl. `packages/execution`) | exit 0 |

Runner provenance: `vitest/2.1.9`, `bunx` from inside the package, every banner
`RUN v2.1.9 …/packages/{cli,prompt}`.

**M2 — causation under perturbation.** Two coordinator mutation tests, independent of the slots'
own:

```text
(a) the rejected-vocabulary guard — group 11's priority defect
    plant `usage: 'tm8 task report progress …'` into a LIVE instruction string
    -> Tests 1 failed | 5 passed        restore (24648 bytes) -> 52/52 green

(b) the availability default — group 10's permanent field
    flip  availability: 'unknown'  ->  'available'   (2 sites)
    -> Tests 6 failed | 11 passed       restore (10008 bytes) -> 285/285 green
```

Both guards **discriminate**. (a) proves the priority defect cannot silently regress; (b) proves
`unknown` is not optimistically reported as available.

**M3 — static type analysis.** Separate test-file typecheck, run the prescribed way after the `npx`
correction: `cd packages/cli && ./node_modules/.bin/tsc -p <absolute-config>`, **tsc 5.9.3**,
**exit 0**. cwd inside the repo, package-local binary, no tsconfig widened.

**G4 honesty behaviours — verified against the built binary, not the reports**

| Requirement | Observed |
|---|---|
| `search query` reserved + honest | exit **8**, "RESERVED row in the frozen operation catalog… not missing, and not a failure of this node" |
| `bridge.fetchBlob` discoverable, **no command** | `help --operation` → `exposure: reserved`, `availability: [unavailable: reserved]`, "has NO cli invocation"; `tm8 bridge fetch-blob` → exit **2** |
| `execution.prompt` internal, no invocation syntax | `exposure: internal`, `reason: use_message_send`, `use instead: messages.post`, **0** occurrences of "session prompt" |
| No public prompt/report/progress seam | `whoami`, `task report progress`, `session report complete`, `session prompt` → all exit **2** |
| `unknown` renders as unknown | `availability: [availability unknown] (source: contract)` |
| `composePrompt` frozen signature | byte-identical; `packages/execution` compiles against it |
| No live rejected vocabulary in the composer | all remaining hits are comments documenting the removal |
| Retired `TM8_AUTH_TOKEN` | present **only** as `RETIRED_BEARER_ENV`, the subject of the assertion that it is absent from artifacts |

**Coordinator ruling — Slot B's three-outcome exit discipline: RATIFIED.**

```text
tm8 entity get ent_1   -> exit 8  "in the tm8 grammar but is not implemented in this CLI build"
tm8 entity yeet ent_1  -> exit 2  "unknown command"
```

This was Slot B's own design call, flagged rather than assumed. It is correct and important: without
it, every not-yet-landed command from groups 2–9 would report "unknown command", **teaching an agent
that a capability does not exist when it simply has not landed**. Exit 8 is DEV-13's own code for
"catalogued, not implemented here". The closed-registry property is preserved — both lookups are
closed sets.

**Disclosed and accepted:** Slot B changed one line outside its named scope — `src/index.ts`, which
re-exported `COMMANDS` from `run.js`. Moving the registry made `index.ts` a **call site of its own
export change**, and the outbound rule requires landing an export change with all call sites in one
step. Disclosed explicitly rather than quietly. Accepted.

**Open inferences flagged by Slot B, not silently normalized:** noun-shard `schemaVersion`
(`tm8.help.noun.v1`, inferred — the doc freezes the other three and never names this one);
`errorRefs` rendered in the contract's **lowercase** taxonomy rather than the doc example's
uppercase, because an agent must be able to match the string against an error it actually receives;
`--limit <count>` naming its dimension per the units ruling.

**No git command was run** by the coordinator or either worker.

### 8.1 Slot A (group 1) — freeze evidence, obtained by the coordinator

**The worker never delivered a report.** Its session entered a `NEEDS INPUT` / no-text-output
state and cycled between tool calls and idle without producing the required packet, despite two
direct requests. The *code* was complete and correct; the *reporting* was not.

Rather than freeze on an absent report or discard correct work, the coordinator obtained the
evidence first-hand. This is recorded plainly because the distinction matters to a G4 reviewer:
**nothing below is a worker claim.**

**Independent verification, all run by the coordinator:**

| Check | Command | Result |
|---|---|---|
| Full suite | `cd packages/cli && bunx vitest run --no-file-parallelism` | **11 files, 140/140 passed** |
| Build | `bun run build:cli` | **exit 0** |
| Workspace typecheck | `bun run typecheck` | 1 error, **not W4's** — see below |
| **Separate test-file typecheck** | scratch config over `packages/cli/test/**` + `src/**` against `tsconfig.base.json`, `typeRoots` → `packages/cli/node_modules/@types` | **exit 0, CLEAN** |

The separate test-file typecheck is the check `bun run typecheck` structurally cannot perform
(`include: ["src"]`). It had not been run by anyone before this.

**Red evidence — coordinator mutation test.** The shipped defect could not be re-observed
directly because the defective file had already been replaced, so causation was tested instead:

```text
1. backup            packages/cli/src/errors.ts → 9180 bytes
2. MUTATE            not_implemented: EXIT_NOT_IMPLEMENTED  →  EXIT_FORBIDDEN
                     (reinstating the exact shipped collision: 501 reported as exit 4)
3. RUN               Test Files  4 failed | 7 passed (11)
                     Tests       5 failed | 135 passed (140)
                     test/exit-codes.test.ts:82  EXIT_BY_COMMAND_ERROR
                        -  "not_implemented": 8
                        +  "not_implemented": 4
4. RESTORE           9180 bytes, mapping verified back to EXIT_NOT_IMPLEMENTED
5. VERIFY REVERT     Test Files 11 passed · Tests 140 passed
```

This proves the suite **discriminates**: it is not vacuously green, and it specifically catches
the semantic collision that was the whole point of the slot. Five assertions across four files
detected it.

**Anti-vacuity of the 101-row exhaustiveness test**, verified by inspection rather than
assertion: the loop accumulates into a `visited` set and then asserts
`expect(visited.size).toBe(101)` *and* set-equality against `OPERATIONS`. A loop that iterated
zero rows cannot satisfy either. Non-vacuous by construction.

**Boundary audit:** all 11 changed files under `packages/cli/**`; zero out-of-bounds. Legacy
`whoami` / `task report` / `session report` command modules removed **and** replaced by a
`RETIRED_COMMANDS` discovery-hint refusal in `src/run.ts` covering `whoami`, `report`,
`progress`, and `session prompt` — conformance D6 satisfied, not merely "absent".
`test/verbs.test.ts` was **rewritten in place**, retaining end-to-end coverage and carrying an
explicit note that its stub server is Slot A scaffolding and **not G4 evidence**.

**The one workspace typecheck error is not W4's.** It persisted across two runs — meeting the
report threshold — and points at `packages/server/src/facade/services/w2/feed-context.ts:1037`
(`TS2339: Property 'rootSummaries' does not exist on type 'ContextRowSet'`). That is W2's G13
worker mid-edit on the feed/context service. Filtered check: **zero errors in `packages/cli` or
`packages/prompt`**. Per the inbound rule, it was reported to W2 and **not** fixed by W4.

**No git command was run** by the coordinator or the worker at any point.

#### 8.1.1 Correction — what actually carried this freeze

The freeze report originally claimed *"two separate lines agreeing is stronger than either alone"*
about the coordinator's rerun and the worker's late report. **That claim is withdrawn.**

Under the program-wide standard adopted after W2's `73 + 25 = 98` finding — *corroboration requires
**mechanism** diversity, not **author** diversity* — those two runs are **one mechanism with two
authors**. Both execute the same suite with the same runner against the same tree. Applying the
governing question, *"could they have disagreed, given how each was produced?"*, the answer is: only
via transcription or arithmetic error. The agreement ruled out exactly that and bought **zero**
additional confidence that the suite tests anything real. It was **replication**, not corroboration.

What actually carried the freeze is genuine mechanism diversity:

| # | Mechanism | What only it can see |
|---|---|---|
| 1 | executed behaviour — full suite, 11 files / 140 tests | that the code runs and passes |
| 2 | **causation under perturbation** — mutation test | that the suite **discriminates**. A suite can be green and vacuous; nothing else here detects that |
| 3 | static type analysis — separate test-file typecheck | that the test files themselves type-check. A suite can pass while its tests do not |

Those three **can** disagree with one another. The freeze stands, on better grounds than were
originally stated. The worker's report is correctly valuable as replication — it rules out
coordinator transcription error — and is labelled as such rather than promoted to corroboration.

Recorded rather than silently reworded: the freeze was already accepted, and a G4 reviewer should
see the corrected reasoning rather than only the stronger conclusion.

#### 8.1.2 Runner provenance — evidence integrity

`npx vitest` from the repo root resolves **1.6.1 from a sibling project outside the repository**
(there is no root-level vitest binary) and reports "no tests" for every file here — an artifact that
can **counterfeit a red**. Demonstrated concretely:

```text
npx vitest --version                              -> vitest/1.6.1     WRONG
ls node_modules/.bin/vitest                       -> No such file or directory
packages/cli/node_modules/.bin/vitest --version   -> vitest/2.1.9     correct
cd packages/cli && bunx vitest --version          -> vitest/2.1.9     correct

# the counterfeit, on a suite that is 7/7 GREEN under the correct runner:
npx vitest run --no-file-parallelism packages/cli/test/exit-codes.test.ts
  -> Test Files  1 failed (1)
     Tests       no tests
```

**Audit results — all clean.** Coordinator, Slot A, Slot B and Slot C all used `bunx vitest` from
inside a package (`RUN v2.1.9` banners, real failure counts with value diffs, which a
no-tests-found runner cannot fabricate). Every W4 packet now carries the correct invocation verbatim
and requires the runner version in the report.

**⛔ CORRECTED — the earlier "npx tsc is safe" claim was under-scoped.** It is safe only when
resolution *starts inside the repository*:

```text
# repo root
npx tsc --version   -> Version 5.9.3        real TypeScript, from node_modules/.bin/tsc

# a scratch directory OUTSIDE the repo
npx tsc --version   -> "This is not the tsc command you are looking for"
                       ~/.npm/_npx/…/node_modules/tsc  ->  name "tsc", version "2.0.4"
npx tsc -p <cfg>    -> exit=1
```

There is a real npm package literally named `tsc` — an unrelated, long-deprecated 2.0.4 — and
outside the repo `npx` **downloads and caches it**. It exits **1**, so it counterfeits a **red**,
not a green: a worker banks "typecheck red", investigates, and finds nothing wrong because nothing
was ever checked.

**This was reachable through W4's own instruction.** The packets say *"use a scratch config OUTSIDE
the package"* — written to stop workers widening a tsconfig include — which puts the config outside
the repo, so a worker that `cd`s to where its config lives gets the bogus binary.

**Corrected rule, superseding the earlier one:**

> `npx <tool>` resolves correctly **only** when resolution starts **inside** this repository **and**
> the tool is one of the exactly two binaries in the root `node_modules/.bin` (`tsc`, `tsserver`).
> Outside the repo, **every** tool including `tsc` resolves to — or downloads — something else.

Safest form, which removes the cwd variable entirely:
`cd <package> && ./node_modules/.bin/tsc -p <absolute-config-path>`.

**W4's own evidence is unaffected:** every run `cd`'d to the repo root first, resolved 5.9.3, and
emitted `TS2688` — a real TypeScript diagnostic the 2.0.4 package cannot produce.

#### 8.1.3 A pattern in this coordinator's own reporting

Two scope errors in one session, both in the **comfortable** direction:

| Claim | True of | Read as |
|---|---|---|
| "74 bits of entropy" | the CLI's *generated* cmids | the system's cmid floor |
| "npx tsc is safe" | invocation from the repo root | a property of the tool |

Both were correct measurements stated **without their conditions**, both landed as reassurance, and
both were propagated onward *because* they were reassuring and came with numbers.

Corrective question adopted: **"under what conditions did I measure this, and does my sentence say
so?"** A measurement without its conditions is not a finding — it is a rumour with a number
attached.

---

# 9. RESUMPTION #3 — preflight triage, 2026-07-27 ~05:56

**Read this section first if you are resuming W4.** §§1–8 are durable findings and law; this section
is the re-derived state. Everything here was measured from the tree and a real test run, not read
from a file's existence and not taken from the spawn packet.

## 9.1 Instruments — banners, not just commands

```text
cd /Users/subhang/Desktop/Projects/tm8/packages/cli && ./node_modules/.bin/vitest run --no-file-parallelism
  RUN  v2.1.9 /Users/subhang/Desktop/Projects/tm8/packages/cli
  Test Files  19 passed (19)      Tests  289 passed (289)      Duration 7.33s

cd .../packages/cli && ./node_modules/.bin/tsc --version
  Version 5.9.3                                   (real tsc, not the tsc@2.0.4 joke package)

packages/cli/node_modules/.bin = { tsc, tsserver, vitest }     <- vitest IS local here, unlike root

(cd db/migrations && shasum -a 256 *.sql | shasum -a 256 | cut -c1-16)
  28 files / 8c5227dfe17923c2      032 ABSENT
```

Inside the suite, the real Server came up and answered:
`[harness] http://127.0.0.1:57123 operations=100 registered=73` and
`[harness] chain bind-start 28/8c5227dfe17923c2`. **The real-local-Server harness works.** Disk 18 GiB.

**`./node_modules/.bin/vitest`, not `bunx vitest`.** The inherited slot packets said `bunx` and asked
workers to report the banner as the string `vitest/2.1.9`, **which the tool never prints**. Both were
corrected on resume. The banner to quote is the full first line *including the trailing path* — the
path is the load-bearing half, since a runner resolved from a neighbouring project prints a different
one, and a bare version number would not have caught it.

## 9.2 Corrected entry state — groups 2–9 are at ZERO lines

The handoff §17.3 and this ledger's §5.1 both show wave-2 slots D/E/F/G as *executing*. **They wrote
nothing.** `src/commands/` holds only `completion, help, kind, registry, search, worker-init`;
`registry.ts` still carries the eight domain spreads as a **comment**; no `src/commands/<noun>.ts`
exists for any domain noun. Every prompt those four sessions ever received was answered verbatim with
`You've hit your session limit · resets 5:10am`. The 289 green tests are entirely slots A, B and C.

Honest state: **3 of 11 frozen (groups 1, 10, 11); groups 2–9 at zero.**

**The `288` → `289` discrepancy is a record slip, not a foreign edit.** §6.2.1 recorded 288 at the
blocker. Mechanism check before reporting a cross-wave violation: the newest mtime anywhere under
`packages/cli` is `test/integration/harness.ts` at 02:43 — **43 minutes before** the 03:26 blocker —
and `packages/contract/src` is untouched since 07-26 14:41, so no catalog-driven test could have
regenerated. The +1 has **no mechanism in the tree**. Recorded so a later reader does not "discover" a
phantom W1–W3 edit into `packages/cli`.

## 9.3 The work inventory was incomplete — groups 5, 8 and 9 had no task

Eight tasks existed covering only **five** groups. The three exact duplicates are the smaller half of
the finding; the larger half is that **three of the eight remaining groups were absent from the work
list entirely** — and one of them, group 9, carries obligation **O2**.

| Group | Authoritative task | Collapsed duplicate |
|---|---|---|
| 2 | `task_1785100351215_bj7y2cuw9` (Slot D) | `task_1785109983686_zx82nzuxn` |
| 3 | `task_1785109986278_bm68ihagt` | — |
| 4 | `task_1785100351505_5e39ap7f8` (Slot E) | `task_1785109992625_71qn82hle` |
| 5 | `task_1785112278332_9j6qxbnz4` **created** | — |
| 6 | `task_1785100351790_ibdjmdh5r` (Slot F) | `task_1785109994739_fj4ybhenz` |
| 7 | `task_1785100352187_j1vnzwa0i` (Slot G) | — |
| 8 | `task_1785112281718_m2sp8q0lm` **created** | — |
| 9 | `task_1785112290901_9rdnmtwcc` **created** | — |

Collapse rule: in each duplicate pair the **Slot** task is kept, because it is bound to a live session
already holding a complete packet and Slot E's seam ruling is recorded against its task. The three
duplicates are reported `blocked` with a duplicate notice, never worked.

## 9.4 Slot map — the ownership unit is the MODULE, not the noun

| Grp | Files owned exclusively | Integration class |
|---|---|---|
| 2 | `commands/space.ts`, `identity.ts` | G01 composed + W3 PASS → **REAL**; A01–A03 are G14 residual → 501 |
| 3 | `entity.ts`, `task.ts`, `tracking.ts`, `graph.ts`, `undo.ts` | G05 **REAL**; G02 composed-**ungated**; `feed`/`context` G13 → 501 |
| 4 | `edge.ts`, `placement.ts` | G03 composed + W3 PASS → **REAL** |
| 5 | `message.ts`, `handoff.ts` | G04 residual → 501. **Carries O1.** |
| 6 | `project.ts`, `file.ts` | G06 + G07 composed + W3 PASS → **REAL** |
| 7 | `inbox.ts`, `saved-view.ts`, `action.ts` | G08 + G09 composed + W3 PASS → **REAL** |
| 8 | `event.ts`, `presence.ts` | `events.poll` ungated; `subscribe` WS skeleton; `presence.get` → 501 |
| 9 | `session.ts`, `interaction-profile.ts`, `teammate.ts` | 4 × `execution.*` registered-ungated; G12 → 501. **Closes O2.** |

### Seam rulings — all four issued BEFORE any slot wrote code

`registry.ts` throws at **import** on a duplicate path, so a double registration is not a subtle test
failure — it collapses the entire suite for every slot at once. That is why these are pre-rulings.

- **S1 — `['entity','connections']` → group 4.** Affirming the prior coordinator's ruling: the DTO is
  `Page<EdgeView>` and is edge-shaped. Group 3 is told the path is taken.
- **S2 — `['message','mark-read']` (`readMarks.upsert`) → group 7, NOT group 5.** It is G08 per-member
  read state, composed and W3-PASSED, while group 5's module is otherwise entirely uncomposed 501s.
  Leaving it under the `message` noun would strand a working operation in a module that cannot produce
  real evidence.
- **S3 — BOTH `*.interactionProfile.setDefault` rows → group 9, NOT group 2.** This **overrides Slot
  D's existing packet**, which claimed A20. Splitting a symmetric pair across two modules is precisely
  the drift the module-ownership rule exists to prevent, and A17–A20 share one principal rule. Churn
  cost is zero because D had written nothing.
- **S4 — `['file','upload']` binds TWO operations** (`files.uploadInit` + `files.uploadComplete`)
  behind ONE path — the §3.1 cardinality trap. Group 6 registers it **once**, and because one command
  spans two durable operations it is a composed multi-operation command: `deriveMutationId(root,
  stage)`, never one id reused across stages.

## 9.5 O1 and O2

**O1 — exit 11 end-to-end — OPEN, and stays open.** `messages.post` is still the unconditional 501
stub at `handlers/messages.ts:175-182` on this tree. No synthetic coverage will be built against it;
it is recorded as **OPEN-BEHIND-SEC-1** in the G4 statement. It belongs to group 5, which until this
resumption had no task.

**O2 — exit 130 — reassigned to group 9.** §6.3 lists the owner as "group 1 + a long-running command"
and the resumption packet called it *"Not blocked. Close it."* It is not gate-blocked, but it was not
closeable either: proving 130 needs a genuinely long-running command to interrupt, and the only
**registered** candidate is `session attach` (`execution.streams.attach`, one of the four mounted and
registered `execution.*`). `event watch` is a **WS skeleton**. So O2 was blocked by a **missing task**,
not by a gate — the third of the three groups the work list omitted.

**Fallback, ruled, and it must never be laundered into a clean close.** Exit 130 is fundamentally a
**signal-handling property of the CLI kernel**, not a property of any operation, so if
`streams.attach` proves unusable a **harness-injected slow transport with a real SIGINT** exercises the
same kernel path. That is a **RED SUBSTITUTE under §13 and must be labelled as one**, with its gap
stated: it proves *the kernel's signal path*, **not** 130 under interruption of a real in-flight server
operation. **Prefer the real interrupt.** Take the substitute only if the real one proves unavailable,
and **never record O2 as CLOSED without the qualifier attached**.

## 9.6 M-1 audit — coordinator-side, mechanical, before first use

```text
maestro team-member get tm_1785091987091_id0qite2j
  Name "⚙️ tm8 Opus Impl xhigh"   Model claude-opus-5   Agent Tool claude-code
  Mode coordinated-worker         Status active                        M-1 COMPLIANT
maestro team-member get tm_1785091987382_089qna7hk
  Name "🧪 tm8 Opus Tester"        Model claude-opus-5   Agent Tool claude-code
  Mode coordinated-worker         Status active                        M-1 COMPLIANT
```

**Stated with its conditions, per §8.1.3.** The record exposes `Model` and `Agent Tool`; it does **not**
expose `provider` or `reasoningEffort`. What is audited is exactly that, and no more. The superseded
`gpt-5.6` members are not used.

### 9.6.1 ⚠ M-1 IS WEAKER FOR A RESUMED SESSION THAN FOR A SPAWNED ONE

Ruled by the full-program coordinator on this resumption, and it applies to **exactly** slots D, E, F
and G. A **resumed** session produces **no fresh spawn-time launch-config echo**, so for those four
there is *no surface at all* — not the team-member record, not an echo — from which `provider` or
`reasoningEffort` can be read. What holds for them is `Model claude-opus-5` and `Agent Tool
claude-code`, **asserted from the team-member record**; `provider` and `reasoningEffort` are
**UNVERIFIABLE**.

**"M-1 compliant" must therefore never stand unqualified for a session this coordinator did not
spawn.** Slots spawned fresh (groups 3, 5, 8, 9) do produce a spawn-time echo and get the stronger
form. This is the §8.1.3 lesson applied to the audit itself: a measurement without its conditions is a
rumour with a number attached, and "audited" is a measurement.

## 9.6.2 ⚠ A SUCCESSFUL `session prompt` IS NOT EVIDENCE OF DELIVERY

**§6.2.1 is now FALSE where it says the four wave-2 slot sessions were "deliberately not killed" and
"can resume on a one-line prompt at reset."** They were `Status: stopped`. All four:

```text
maestro session info sess_1785100406108_snvkvvskq -> Status: stopped     (D, group 2)
maestro session info sess_1785100409093_aw2ma36k7 -> Status: stopped     (E, group 4)
maestro session info sess_1785100452403_xaxysrr51 -> Status: stopped     (F, group 6)
maestro session info sess_1785100413671_vd3oxl5y5 -> Status: stopped     (G, group 7)
```

Full delta packets were sent to all four. `maestro session prompt` returned `✔ Prompt sent` **every
time**. Nothing was delivered; no `▶` ever appeared in any target log. **`session prompt` reports
success against a stopped session** — it queues to a session with no running agent to consume it.

**Same defect class as the tracker-versus-spec error:** a PROXY was measured (the send succeeded) and
the PROPERTY was recorded (the worker received it). It is worse than the usual instance because it
**mimics a known-good explanation**: a stopped session and a capacity-limited session present
identically from outside — no output, no file changes, identical `find -mmin`. A ready-made
capacity-limit story fitted the evidence perfectly and was wrong. There was an earlier witness that was
under-read: session E's log carried an unanswered `▶` from 05:37, 26 minutes before W4 touched it.

**Defences, both now standing practice:**

1. `maestro session info <sid> | grep Status` before believing any prompt landed. Check the
   **instrument**, not the result.
2. Require a **one-line ACK** before work starts, and treat no-ACK as *diagnostic*. Note the ACK alone
   would have produced the RIGHT alarm with the WRONG diagnosis — "all four limited" rather than "all
   four stopped" — so the two defences are complements, not substitutes.
3. `maestro session logs` visibly **lags**; an empty log is not evidence in either direction.

**The ACK earned its keep immediately.** Group 2's ACK read: *"Noted seam ruling S3: A20 is NOT mine
(group 9); I will not register `['space','interaction-profile','set-default']` **despite my task
description listing it**."* The worker independently caught a contradiction between its packet and its
own maestro task description and named it rather than silently choosing. **An ACK that merely says "ok"
would not have surfaced that** — requiring the worker to state what it understood is what did.

## 9.7 Capacity discipline on resumption

Four slots resumed, not eight spawned. The account-wide session limit is what killed this wave, and
per §6.2.1 it **counterfeits progress** — a limited worker is indistinguishable from a thinking one.
The four warm sessions were resumed with delta prompts rather than respawned: they already hold
complete, high-quality packets, and respawning would re-burn the same budget for the same content.
Every delta prompt requires the worker to **report a capacity limit explicitly**, because silence and
a limit were indistinguishable for three hours last time.

Groups 3, 5, 8 and 9 are held for a second batch, spawned as the first four report.

### 9.7.1 The four live sessions — M-1 audited in the STRONG form

Because §9.6.2 forced a fresh spawn, each carries a **spawn-time launch-config echo** as well as the
team-member record, so all four M-1 fields are verifiable rather than three of five:

```text
Provider: claude · Model: claude-opus-5 · Intelligence: xhigh · Access: fullAccess     (all four)

group 2  sess_1785112693718_zj3fg3vxy  task_1785100351215_bj7y2cuw9  ACKed
group 4  sess_1785112702848_efykjhof6  task_1785100351505_5e39ap7f8  ACKed
group 6  sess_1785112711571_xj8rk5zme  task_1785100351790_ibdjmdh5r  ACKed
group 7  sess_1785112719859_1ykkfxu18  task_1785100352187_j1vnzwa0i  ACKed
```

**§9.6.1's qualified-resumption rule is KEPT even though this instance escaped it.** It is correct law,
it binds the next resumption, and withdrawing it because the outcome turned out reassuring is exactly
the retraction-in-the-comfortable-direction this program scrutinises.

## 9.8 Chain rotation is INBOUND — do not treat any chain-bound number as durable

The other wave is landing a **three-migration batch**: **`032`** per-site Stage 1b, **`033`** the
shared principal pin, **`034`** the `027` tier fix. **Note `033`, not `032`, for the pin** — the
full-program coordinator's own packet had that one renumbering out of date and was corrected. The
batch lands as one identity with one re-run each, and the new chain identity will be announced to W4
directly.

Until that announcement: **do not re-bind**, and after it, **no chain-bound number measured against
`28 / 8c5227dfe17923c2` is current**. Workers keep calling `assertBindCoherent()` and keep treating a
throw as *expected during a landing* — discard and re-run, never report, never pin a digest in an
assertion.

## 9.9 Group 5 is blocked from being PROVEN, not from being WRITTEN

Ruled, and it applies equally to the 501 halves of groups 8 and 9. Group 5's **grammar, argument
binding, help/completion projection, JSON shape and unit tests are contract-derived and provable
today**; only **integration** and **O1** wait on G04 composing. The group is not parked wholesale
behind O1.

The integration-class column in §9.4 is the mechanism that keeps this honest, and it goes **into every
packet** so a worker knows precisely which half of its own group it may claim — and so that **no
worker quietly upgrades "grammar green" into "operation works"**.


---

# 10. TRANCHE-v3 COMPOSITION — measured by W4, and what it cost

## 10.1 The measurement, and the second mechanism

The W1–W3 wave announced tranche-v3. **W4 did not take it on report.** Rebuilt and measured from this
wave's own harness — a real Server spawned as a **child process** on an isolated freshly-migrated
scratch database, not an imported `bootstrap()`:

```text
[harness] http://127.0.0.1:51619 operations=100 registered=97      (was 73)
[harness] chain bind-start 28/8c5227dfe17923c2                     (UNROTATED)
```

Identical to their `{"operations":100,"implemented":97}`. **G04, G12, G13 and G14 composed** —
`messages.post` is no longer the unconditional 501 stub, so **O1 is unblocked**. The chain did not move:
composition is a facade change, not a migration change, so every chain-bound W4 number stays valid.

**The second mechanism is not a count, which is why it is worth having.** The harness's three-state
probe went red on landing:

```text
AssertionError: expected 'unknown' to be 'unavailable'   at harness.smoke.test.ts:40
  // the assertion named entityKinds.create as an UNCOMPOSED operation
```

The row moved `unavailable` → `unknown`, which can only happen if the router stopped answering 501 for
G12. That is a **per-operation observation**, and it can see what a registry count structurally cannot:
**which** operation moved. The two instruments could have disagreed — that is what makes this
corroboration rather than restatement. `presence.get` was independently confirmed as the sole remaining
`unavailable` row, matching their `residual=1`.

**A red that is the instrument working.** The smoke test failed because the world changed, exactly as an
availability probe should. It was fixed immediately rather than left to pollute nine workers' full-suite
evidence as a foreign red, and all sessions were told to `bun run build:server` before measuring —
**a stale `dist` measures the OLD 501 surface and records it as current.**

## 10.2 ⚠ COMPLETING THE SURFACE DESTROYS THE ONLY LIVE WITNESS TO THE OBSERVED-501 PATH

Recorded now, while it is still visible, because the loss is **invisible by construction**.

`presence.get` is the only v1 operation still answering 501, and G10 is being implemented. When it
composes, **no v1 operation will exercise the `observed → unavailable` branch** of the availability
derivation. The only rows still answering 501 will be the two permanently reserved ones — and those
resolve through the **contract** source, not the **observed** source. The branch that turns an honest
501 into a per-operation `unavailable` verdict will then have **no end-to-end witness at all** and will
survive only in unit coverage.

**The general shape, which is the transferable part: an assertion whose subject gets FIXED stops testing
without ever going red.** It does not fail; it quietly stops proving anything. The endangerment is
therefore written into the assertion's own comment, so that whoever deletes that line has to confront it
rather than tidy it away.

**A demonstration was already lost this way and is recorded rather than quietly rewritten.** The smoke
test used the `messages.post` **stub** versus live `spaces.create` to prove a stub and a live handler are
**indistinguishable** from an invalid body — the measurement-validity trap of §5.0.2. With
`messages.post` now real, **there is no stub left to contrast against**; that demonstration is no longer
reproducible end-to-end and the claim now rests on unit coverage. Good news overall. Worth knowing it
moved rather than discovering later that the comment had become a lie.

## 10.3 Drift is the residual risk, and W4 is an independent vantage on it

Composition is structural **REPLACEMENT**: `HandlerRegistry.register()` throws on duplicates, so legacy
inline registrations were deleted and frozen handlers took over. **The residual risk is behavioural drift
in replaced operations, which no count can catch.** Propagated to every W4 session: a changed ordering, a
cursor that no longer resumes, or a different error code is a **REAL DRIFT FINDING** — report it, never
work around it, and **never hide it in the client**, because a client-side workaround makes a server
regression invisible to the gate that must see it.

**`messages.list` is the sharpest case in the tranche and it belongs to group 5** — already live with a
real working body, now a different implementation behind the same name.

## 10.4 O1 remains OPEN

Composition is **necessary, not sufficient**. O1 closes only when exit 11 is measured end-to-end via
`message send --wait settled` **on W4's own tree**. It will not be closed on another wave's measurement.

## 10.5 ARBITRATION OUTCOME — the contract was right and the projection was wrong

W4 escalated `savedViews.update` as a contract need. **Ruled: the contract is not defective; the
projection is.** No amendment, no G0.2, no dossier change. The version guard is **fictional at every
layer**, and the decisive layer is one W4 had not checked:

| Layer | Finding |
|---|---|
| `schemas.ts:961` `SavedViewInputSchema` | `.strict()`, no `expectedVersion` — W4 had this |
| **`schemas.ts:1705` `SavedViewSchema` (READ DTO)** | **NO version field — so no client could EVER populate the guard. Unreachable-by-construction.** |
| `db/migrations/024:77` `update_saved_view` | no expected-version parameter; no storage-layer guard to bind to |
| `W0-AMENDMENT-DOSSIER.md` | does not mention `savedViews` **at all** — nothing to amend |

Where the guard is real, the dossier says so (`:82`, `messages.edit` / `messages.delete`). The projection
author pattern-matched from a neighbouring guarded row.

**The escalation was still correct**: a self-contradicting projection that W4 could not fix under its own
ownership boundary, routed rather than guessed, with no worker permitted to invent a field. The answer
simply landed on W4's side of the line. Fix scoped as `task_1785113492194_xc39aw08h` — remove `ver`,
remove the flag, **and correct the summary**, since *"Redefine a saved view under a version guard"* is
itself the false claim and fixing the flag alone would leave a dishonest help surface.

**The sweep runs in BOTH directions, and the dangerous one is the inverse:**

- **Direction A** — projection declares `ver:`, schema has no field → CLI demands a flag `.strict()`
  would reject. **Loud.**
- **Direction B** — schema has a **REQUIRED** `expectedVersion`, projection omits `ver:` → the CLI never
  sends it and **every call 400s**, with no clue in help. **Silent, and worse.** B is not findable by a
  search that starts from `ver:`; it must start from the schema side.

**12 projection rows vs 11 schema sites is a HINT, never evidence.** A count cannot say *which*, and
would read identically if two rows shared one schema while a different row were missing — the
compensating-pair shape that let `73 + 25 = 98` pass as a cross-check while both halves were wrong.

## 10.6 A coordinator ruling was corrected by a worker

Group 7 reported three conflicts; the coordinator sorted them and **withdrew one wrongly**. The
disproof addressed a claim the worker was not making — that the flags would be **REJECTED** by
`.strict()`. The worker's actual claim was that `services/w2/saved-views-actions.ts:79-105` reads only
`spaceId` and returns a bare `SavedView[]` with no `nextCursor`, so `--limit`/`--cursor` would be
**SILENTLY IGNORED**. **Silently-ignored is worse than rejected for an agent: it pages forever and no
error ever fires.**

**The corroboration also did not transfer.** `spaces.list` was cited as an independent witness — it is a
**different service**, so it says nothing about this handler, and `client.ts` proves only that the CLI
*can send* query params. Two mechanisms aimed at the wrong question, wearing the costume of mechanism
diversity.

> *"I was reassured by my own disproof and stopped looking; the worker holding the uncomfortable position
> kept going."*

**§15.5's comfortable-results rule binds a coordinator's ruling exactly as it binds a worker's finding.**
Being settled by measurement with a discriminating assertion, reported as a server observation or a
disproof — never as a CLI design change.

## 10.7 The observation wiring — a coordinator suspicion RAISED, CHECKED, and DISPROVED

Recorded as a disproof, per §13, because a suspicion that dies quietly teaches nobody.

**The suspicion.** A cross-module grep showed `ledger.record(...)` called directly in only ONE command
module (`file.ts`), while `src/discovery/observe.ts` held the seam. The obvious reading: the `observed`
source is effectively **dead** — the CLI would answer `unknown` forever no matter how many calls it made
— and one module had reimplemented the seam inline, guaranteeing drift. That would have been a systemic
defect across every group, of exactly the kind only a cross-module vantage can see.

**It is false, on both halves.**

1. `observedInvoke` is used **universally**. Every landed module routes through it: `space.ts`,
   `identity.ts`, `edge.ts`, `placement.ts`, `inbox.ts`, `saved-view.ts`, `action.ts`, `event.ts`,
   `presence.ts`, `project.ts`, `file.ts`, `message.ts`, `handoff.ts`, `session.ts`, `kind.ts`. The
   observation path is fed by real command traffic, exactly as designed.
2. `file.ts`'s inline `ledger.record` is **not** a lazy duplicate. It is `observedDownload`, a deliberate
   parallel for the **raw-bytes** path — `files.download` returns bytes outside the `{data, requestId}`
   envelope and structurally cannot go through `client.invoke()`. Its own comment says so.

**The grep was a proxy for the property.** Searching for `ledger.record` measured *"who calls the
recorder directly"* and was recorded as *"who feeds the ledger"* — and those differ by exactly one
indirection, the one the design deliberately introduced. Same shape as the tracker-versus-spec error,
one layer down.

## 10.8 The `presence.get` endangerment is now LIVE — and its remedy, scoped precisely

G10 is being implemented, so §10.2's first instance is **no longer a forecast**. §10.7 narrows what is
actually at risk, and the narrowing matters:

- **NOT at risk:** the wiring. `observedInvoke` is universal and unit-covered
  (`discovery-availability.test.ts:76-83` drives the ledger directly).
- **AT RISK, precisely:** the **end-to-end** demonstration that a real 501 from a real Server travels
  transport → `observedInvoke` → ledger → an `unavailable` verdict on a **v1** row. After `presence.get`
  composes, the only rows still answering 501 are the two **reserved** ones, and `resolveAvailability`
  **short-circuits on the contract source before observation is ever consulted** — so they can never
  exercise the observed branch of the *derivation*.

**The remedy, which survives G10 and needs no operation left unimplemented:** split the claim in two, and
prove each where it can be proven.

1. **Wiring, end-to-end, against the real Server:** call a reserved row and assert
   `ledger.observed('search.query') === 'not_implemented'`. A reserved row DOES return a real 501 at the
   router, and `observedInvoke` DOES record it — the contract short-circuit affects only the *verdict*,
   never the *recording*. This proves the transport→ledger link survives, permanently.
2. **Precedence, at unit level:** the observed→`unavailable` verdict on a v1 row, already covered.

Recording the seam between them honestly is the whole point: **after G10, no single test proves both at
once, and that is a real reduction in coverage even though nothing goes red.** Written into the
assertion's comment, because the comment is the only place a warning survives a test that still passes.

---

# 11. REGISTRY WIRING — what it unblocked, and what it made dangerous

## 11.1 The wiring, and the exit-8 trap it removed

All sixteen domain modules were imported and spread into `src/commands/registry.ts` in one step by the
coordinator. Verified immediately: `bun run build:cli` clean, **no import-time duplicate throw**, and
dispatch reaches real commands.

**It unblocked two gate obligations at once.** Group 9's `session attach` (O2) and group 5's O1 evidence
were both stuck behind it — and group 5 named the reason precisely, which is a gate trap worth keeping:

> **Exit 8 has TWO different causes.** `run.ts`'s *"is in the tm8 grammar but is not implemented in this
> CLI build"* (the registry gap) and the Server's honest *501 not_implemented*. **Same exit code,
> different fact, distinguishable ONLY by stderr text.**

Before the wiring, an O1 measurement through the built binary would have measured the **registry gap**
and read as the **server**. The worker caught that itself, labelled its evidence mode explicitly, and
proved O1 in-process meanwhile so its suite would auto-upgrade to pure-binary evidence once wired.

## 11.2 ⚠ THE WIRING MADE A MANDATED SAFETY PROCEDURE DESTRUCTIVE — and nothing re-checked it

`event.ts` and `presence.ts` disappeared from the tree. `registry.ts` imports every domain module, so two
missing files broke `build:cli` with `TS2307 × 2` **for all nine sessions at once**, while eight of them
were running suites that would have banked the failures against their own work.

The coordinator un-wired the two imports within minutes — a **hold, not a removal**, commented as such —
restored the shared build, and asked the owning worker what happened rather than assuming.

**The cause was the §9 causation test, performed exactly as this coordinator requires it.** The worker saw
foreign reds, and to prove it was not the cause it **moved its own five files out of the tree**, re-ran,
and moved them back. A 90-second window.

> **The blast radius was the COORDINATOR's doing.** Move-your-files-out was mandated early. Wiring
> `registry.ts` hours later made that action destructive. **The instruction was never amended.**

**Amended technique, propagated to all nine:** answer *"are these foreign reds mine?"* by running **only
the foreign failing files**, so your modules are never loaded — same answer, no tree mutation, no blast
radius. **Never move, rename or delete a file you own while nine sessions build against the tree.** The
worker derived this itself, unprompted, in the same message that admitted the cause.

**The transferable shape, and it is a new named class:**

> **A safety procedure can be made unsafe by a later change somewhere else, and nothing re-checks it.**
> The technique was correct when written and destructive by the time it was used, and the instruction
> never moved.

That is the **procedural twin** of *"an assertion whose subject gets fixed stops testing without ever
going red."* Both change meaning silently because of progress elsewhere; **neither has anything that goes
red.** One is a test that stops proving; the other is an instruction that starts harming.

## 11.3 The honest casualty, declared rather than repaired quietly

The same worker found a real loss inside its own restore: `test/event.test.ts` and
`test/integration/event.test.ts` **share a basename**, both were moved into one flat scratch directory,
and the second **overwrote** the first. The integration content survived; the unit file's content was
gone from disk.

It **declared it rather than quietly fixing it**, is rewriting the lost file, and will **label it a
REWRITE, not the original**, proving equivalence by test count and test names against the run it had
already banked (33 tests). No source file was affected; the two `src` modules were restored byte-for-byte
and needed no reconstruction.

**Adopted as standard: a recovered file presented as an original is a fabricated artifact even when the
content is right.** If work is lost, rewrite it and say it is a rewrite.

## 11.4 The archived witness — captured before G10 destroys it

§10.8 flagged that the `observed → unavailable` path loses its last live end-to-end witness when
`presence.get` composes. **It was captured first.** Measured on the built binary against a real Server,
bind `28/8c5227dfe17923c2`, `assertBindCoherent()` coherent, `/health {operations:100, implemented:97}`:

```text
events.poll        probe 'available'    CLI exit 0   {"items": [], "nextCursor": "0"}
events.subscribe   probe 'unknown'      TRANSPORT fact (WS unreachable over HTTP), never 'available'
presence.get       probe 'unavailable'  CLI exit 8
  stderr: tm8: not_implemented: operation presence.get is not implemented on this node . requestId: req_3df2df_5
            this operation is catalogued but not implemented on this node (honest 501)
  derived: {availability: unavailable, availabilityReason: not_implemented_on_node, availabilitySource: OBSERVED}
```

**This is the artifact, and once G10 composes it can never be reproduced by anyone.** It is archived here
verbatim rather than left as a claim, and the worker is re-running it post-restore so the record does not
rest on a run whose tree had just been disturbed.

---

# 12. THE CHAIN FLAP — a coordinator announcement that four workers correctly refused

## 12.1 What happened

```text
28 / 8c5227dfe17923c2   ->   31 / 5ccfd55dceb1e1c6   ->   28 / 8c5227dfe17923c2
```

`032`, `033` and `034` were landed, **failed to apply**, and were reverted inside roughly five minutes.
The coordinator's file monitor caught the 31-file state, the coordinator **measured it directly and
confirmed it**, and then **announced a rotation to nine sessions and ordered them to re-bind.** By the
time the announcement was written, the batch had already been withdrawn.

**Four workers independently refused the order**, re-measured, and reported the disagreement *against*
the announcement rather than adopting its number. One stated the principle exactly:

> *A worker who re-binds on the coordinator's message rather than on its own measurement records an
> identity that does not exist — the proxy-for-property error arriving through the announcement channel
> itself.*

**Adopted: AN ANNOUNCEMENT IS EVIDENCE, NOT AUTHORITY. THE TREE IS THE AUTHORITY.** The measurement was
honest, and it was still wrong by the time it was acted on — a *fresh* measurement of a *moving* subject
is stale on arrival. Re-measure-never-predict binds the coordinator hardest, because a coordinator's
error is delivered to nine sessions at once with the weight of an instruction.

Retracted within minutes, and the retraction stated the error plainly rather than framing it as a
follow-up.

## 12.2 ⚠ A GAP IN THE COORDINATOR'S OWN RULE — this failure is NOT a bind-coherence throw

Workers were told to watch for `assertBindCoherent()` throwing. **That rule could not have caught this.**

Because the scratch database could not be **migrated at all**, `assertBindCoherent()` **never ran**. The
suite died in `beforeAll` and reported its tests as **SKIPPED** — measured at
`Test Files 9 failed | 37 passed (46)`, `Tests 854 passed | 159 SKIPPED (1013)`, with all nine failing
files being integration files at 100% skipped. **It looks exactly like a collection failure in the
worker's own work.**

**Added rule, propagated:** a DB-backed suite dying in `beforeAll` with
`Command failed: node db/migrate.mjs up`, or reporting a large block of SKIPPED integration tests, is a
**MIGRATION-LANDING EVENT, not a worker defect.** Measure `db/migrations` before concluding anything;
discard the run; report the measurement, not the failure. **Two distinct signatures: a THROW means the
chain moved mid-suite; a beforeAll migrate failure means the chain is currently unlandable.**

## 12.3 `033` could not be applied — traced from archived evidence, confirmed independently

```text
ERROR:  permission denied for table applied_migrations
db/migrate.mjs: migration 033_w2_sec1b_ledger_replay_principal_pin.sql failed —
the transaction was rolled back, nothing was applied
```

`applied_migrations` is the ledger `migrate.mjs` itself writes (`:142` creates, `:238` inserts). A W4
worker traced the mechanism from the archived output: **`033` contained `set role tm8_graph_owner;` with
no matching `reset role`**, so the runner's own ledger insert executed as the wrong role. The tell was a
contrast: **`031` is balanced — one `set role`, one `reset role`.**

**The worker labelled it a strong hypothesis, not a verified root cause, and refused to reconstruct a
file it could no longer read.** The other wave later confirmed independently: *"033 lacked a `reset
role` so the runner could not record into `applied_migrations`."* Two waves, independent evidence, same
answer — and the W4 side reached it **from archived output alone, after the file was gone**, which is
the entire argument for archiving a red before it becomes unreproducible.

## 12.4 ⚠ THE CURSOR CLASS — our mechanism was REFUTED, and the fix it implied would not have worked

W4 reported `messages.list` re-emitting its boundary row, with this mechanism: `e.created_at` is
**earlier** than `msg.created_at`, so the encoded cursor lands before the real sort key.

**That mechanism is false.** Both rows are inserted in ONE transaction (`019:452-458`) and both columns
default to `now()` = `transaction_timestamp()` — the transaction START, **identical for every statement
in it**. `e.created_at` EQUALS `msg.created_at`, the tuple compare is FALSE for the cursor's own row, and
the column mix-up **cannot be the live cause**. Real, but **latent**.

**The actual cause is MILLISECOND TRUNCATION.** `timestamptz` holds microseconds; node-pg parses to a JS
`Date` (milliseconds); `toISOString()` emits milliseconds. The cursor is **strictly less** than the
stored value, so the keyset **re-admits its own row** on the first tuple component. `06:34:13.421911`
becomes `.421Z`. Fires ~999 times in 1000.

> **Carrying the other column through — the obvious fix, and exactly what W4's mechanism implied — would
> have produced a clean reviewable diff AND LEFT THE BUG LIVE**, because truncation is *downstream* of
> which column is read.

### The lesson, and it is the most transferable thing in this section

> **AN UNEXPLAINED DETAIL INSIDE A CONFIRMED FINDING IS WHERE A WRONG MECHANISM HIDES.**

The tell was in W4's own report and **both waves read it backwards**: *identical reproduction across
different data.* W4's page1/page2 overlap and the other wave's two-database reproduction were banked as
**corroboration** when they were **evidence AGAINST any data-dependent mechanism** — against the very one
being proposed. **A defect that reproduces identically on unrelated data is telling you the cause is not
in the data.** Standard adopted: when confirming a finding, **state what your mechanism does NOT
explain.**

### ⚠ The inverse is strictly worse, and a terminates-only assertion is blind to it

```text
cursor rounded DOWN -> too SMALL -> RE-ADMITS the boundary row -> duplicates, loops.  LOUD.
cursor rounded UP   -> too LARGE -> SKIPS rows -> SILENT DATA LOSS. No error, no loop. INVISIBLE.
```

**A "terminates" assertion passes cleanly while rows are silently dropped.** Required of every W4 paging
row: an **exactly-once** assertion over a known full set — page through and require the union to EQUAL
the complete set, not merely to be duplicate-free — plus **full microsecond fidelity** read back off the
wire, which catches a reintroduced `Date` round-trip **at the point of truncation** rather than waiting
for a downstream symptom.

## 12.5 Provenance discipline held under temptation

W4's worker was **explicitly hunting composition drift** and found a real defect in the exact operation
it had been told to watch. It **declined to call it drift**, on the ground that
`handlers/w2/messages-handoffs.ts` re-registers the **same** `messagesList` function, so the operation
was never behaviourally replaced. Confirmed correct: pre-existing, merely newly exercised. **It reported
the evidence rather than the conclusion the assignment invited.**

It also **left two tests red asserting contract-correct behaviour and refused to soften them**, reasoning
that a test accepting the duplicate *"would go green today and fail the day the server is fixed."* The
server was fixed the same hour, and those reds now turn green on their own.

---

# 13. TWO COORDINATOR ERRORS CAUGHT BY WORKERS, AND THE RULE THEY ESTABLISH

## 13.1 The guard-flag table was wrong — and wrong in the exact class the coordinator had lectured on

The coordinator issued a table telling five groups which flag to implement for each version-guarded row.
A worker **introspected the frozen schemas, disagreed, and was right.** Verified by introspection:

| Row | Frozen field | Correct flag | Owner |
|---|---|---|---|
| `spaces.defaultChannel.set` | `expectedSettingsRevision` | `--expect-settings-revision` | 2 |
| `spaces.menu.update` | `expectedRevision` | `--expect-revision` | 2 |
| `projects.associations.correct` | `expectedArtifactVersion` | `--expect-artifact-version` | 6 |
| `handoffs.withdraw` | `expectedRecordVersion` | `--expect-record-version` | 5 |
| `interactionProfiles.retire` | `expectedVersion` | `--expect-version` | 9 |
| `teamMembers.interactionProfile.setDefault` | `expectedVersion` | `--expect-version` | 9 |
| `spaces.interactionProfile.setDefault` | `expectedSettingsRevision` | `--expect-settings-revision` | 9 |

**Three errors:** `spaces.defaultChannel.set` given `--expect-revision` (transposed);
`projects.associations.correct` given `--expect-version` (mis-derived); and **`spaces.menu.update`
omitted entirely** — a seventh guard-bearing row nobody had listed.

**The mechanism is the humiliating part.** `expectedRevision` and `expectedSettingsRevision` differ by
**one word**, and both rows belong to the **same group**. That is precisely the collapse the coordinator
had just described when explaining why a name-grep saw 11 of seventeen guard-bearing DTOs — **and the
corrective table was then built the same careless way.** The worker used runtime introspection, exactly
as instructed, and caught it.

> **AN INSTRUCTION IS EVIDENCE, NOT AUTHORITY. THE SCHEMA IS THE AUTHORITY.**

That now sits beside *"an announcement is evidence, not authority; the tree is the authority"* — the same
rule with a different subject. **Two coordinator errors caught by workers in one session, both because
someone checked the primary source instead of the message.**

One conflict deliberately left unresolved rather than guessed: the ruling says an authority naming a
spelling beats the derivation, and `projects.associations.correct` was reported as named in dossier §7
while its frozen field derives differently. **The owning group was told to read the dossier line itself
and report which, with the line quoted, rather than pick silently** — the coordinator had already
mis-sourced that row once.

## 13.2 Paging sweep results — one immune-by-construction, one silent-skip, one live

- **`spaces.leaderboard` — DISPROOF, filed as a disproof.** Encodes `[Number(score), actorId]`; the
  first component is an integer, so there is no `Date` to truncate. **Immune by construction.**
- **`edges.list` / `entities.connections` — immune, WITH the mechanism stated.** The cursor is formatted
  to microseconds **in SQL** (`to_char(... US"Z")`) and never passes through a JS `Date`. Verified at the
  mechanism: `nextCursor` decoded off the wire matches `/\.\d{6}Z$/`. **Latent leftover reported rather
  than suppressed:** both encoders carry a `?? iso(last.created_at)` fallback that *would* truncate,
  unreachable today because the microsecond column is always selected.
- **`spaces.awards` — the SILENT-SKIP variant, traced and honestly NOT reproduced.** Encodes
  `[iso(last.created_at), last.id]` over `order by created_at desc, id desc` with a `<` keyset.
  **Truncating DOWN in a DESC `<` keyset does not duplicate — it EXCLUDES every row in
  `(truncated, actual)`.** No duplicate, no loop, and a terminates+no-overlap suite passes cleanly.
  **Could not be reproduced** because `reason='award'` point events are minted only by the
  task-completion RPC and are unreachable from the CLI surface. **The test says so out loud and refuses
  to pass**, rather than comparing `undefined` to `undefined` and banking a vacuous green.
- **`inbox.list` — LIVE instance**, keyset `(created_at, id)` encoded via `iso(last.created_at)`.

**Standard set: assert the mechanism, add the exactly-once union check** (the union must EQUAL the known
full set, not merely be duplicate-free, because an UP-rounding skip hides from a no-overlap assertion),
**and probe-red the matcher itself** so it accepts `.421911Z`, rejects `.421Z`, and rejects
`new Date('.421911Z').toISOString()`.

## 13.3 Concurrent full-suite runs — a self-inflicted flakiness generator, stopped

Four sessions announced a FULL `packages/cli` suite within minutes of each other. The full suite includes
**every** slot's integration files, each spawning its own scratch database — roughly **36 concurrent
scratch databases** on one Postgres.

The resource cost is secondary. **The real cost is cross-run interference that looks exactly like a real
defect in the worker's own code** — and this wave had already burned a cycle on that signature (two
identical runs disagreeing in failure count with the red file set changing between them).

**Rule adopted:** iterate on **your own files only**; run the full suite **once**, for the final report,
**announced in advance so the coordinator can space them**. If runs do overlap, **the number is reported
with that condition attached** — a full-suite result produced under concurrent full-suite load is a real
measurement whose conditions were not stated, the same defect shape as a digest measured from the wrong
directory.

**And the specific trap it prevents:** a worker sees reds in files it does not own, correctly concludes
they are foreign, and reports them attributed to another slot — when nobody's code is broken and the
contention was the coordinator's failure to sequence. That wastes two sessions instead of one.

**Disk slope, reported as a slope:** 18 → 15 → 14 → 13 → 12.7 → **10.6 GiB**, with **8 scratch databases
live**. Far above the 150 MiB abort and 200 MiB escalation floors, but the slope is **steepening**, which
is the reason full runs are sequenced rather than a reason to abort.

---

# 14. THE PREDICTED ENDANGERMENT FIRED — recorded, not tidied away

§10.2 named a class: **an assertion whose subject gets FIXED stops testing without ever going red.**
§10.8 predicted its first instance would fire when `presence.get` composed, and wrote the warning **into
the assertion's own comment** so a future reader could not clean it away unknowingly.

**It fired.** Measured:

```text
[harness] http://127.0.0.1:63422 operations=100 registered=98
AssertionError: expected 'available' to be 'unavailable'   at harness.smoke.test.ts:53
```

G10 composed `presence.get`. **Zero 501s remain in the v1 surface.** The assertion went red **not because
anything broke, but because its subject was fixed** — the class landing on the coordinator's own file,
exactly as forecast.

**The remedy applied is the one prescribed, not a deletion.** The claim was **SPLIT**, because neither
half can carry it alone:

1. **WIRING — still provable end-to-end, and asserted.** A real 501 from a real Server does reach
   `observe()` and is classified `unavailable`; the reserved row proves the transport→classification link
   survives permanently.
2. **PRECEDENCE — unit coverage ONLY** (`discovery-availability.test.ts`, which drives the ledger
   directly).

**What is permanently lost, stated plainly:** no v1 operation can exercise the observed branch of the
**derivation** any more. The only rows still answering 501 are the two permanently reserved ones, and
`resolveAvailability` **short-circuits on the CONTRACT source before observation is ever consulted** for
those. **Nothing will ever go red about this again.**

`presence.get` composing is now asserted **positively**, so the transition is a **fact in the suite**
rather than a deletion in a diff. The archived witness — captured before G10 landed and now
unreproducible by anyone — is preserved verbatim in §11.4.

## 14.1 The optional-field class has a SECOND instance, and it is strictly worse

The `graphLayout` finding generalised: **an OPTIONAL schema field with no flag in the syn fails
SILENTLY** — it is never sent, and whatever is stored there is **overwritten with nothing**. The guard
sweep covered REQUIRED fields, where the failure is a loud 400.

**Instance 2 — `task transition` DESTROYS a stored work note.** Measured end-to-end **with a positive
control**, which is the load-bearing half because it proves there was something to lose:

```text
[g3] work note BEFORE transition: "handover: waiting on review"
[g3] work note AFTER  transition: null
```

Mechanism, cited: `WorkInputSchema` defines `note?` and `startedAt?` as optional; the frozen syn names
**neither**; and `set_work_state` (`007_rpc_catalog.sql:1876-1917`) does
`props = excluded.props` — a **wholesale replacement, not a jsonb merge** — so omitting `note` writes
`note: null` over it. Not inert: `entity-read.ts:665-676` surfaces it as `badges.workingActors[].note`.

> **STRICTLY WORSE THAN THE `saved-view` CASE: there an operator could at least pass the flag. Here there
> is NO FLAG, so any agent running `tm8 task transition` destroys a note left by the UI or an MCP client,
> unavoidably, with exit 0 — and the CLI cannot put one back.**

**Reported, not asserted:** `startedAt` is re-stamped on every transition. The worker explicitly declined
to call that a defect, since there is a defensible reading ("when did the CURRENT state start"), and
**refused to assert a verdict it could not justify.**

**And a self-correction worth more than the finding:** the worker's SQL-side name-grep for a note reader
found nothing and it **nearly recorded the field as inert**. It is read on the JS side as `w.props.note`.
That is the introspection-over-name-grep rule catching the *severity*, not just the existence — recorded
against itself.

## 14.2 Guard enforcement — proven, not assumed

The projection slot stated its own limit: *"`.strict()` proves the field is ACCEPTED, not ENFORCED — a
handler could parse `expectedRecordVersion` and never compare it."* That became a directive, and it is
now closed for four rows with **acceptance + stale-refusal + omission**, each with a positive control
proving the version actually moved first:

```text
interactionProfiles.retire                 stale v1  -> exit 6  version_conflict
teamMembers.interactionProfile.setDefault  wrong v98 -> exit 6  version_conflict
spaces.interactionProfile.setDefault       wrong r99 -> exit 6  conflict: Space settings revision conflict
projects.associations.correct              stale v1  -> exit 6  version_conflict   (1->2 re-read first)
```

One worker asserted the refusal **as a DIFFERENCE** (`wrong.code !== ok.code`) rather than as a bare
code, reasoning that **a parsed-but-ignored guard could not produce two different answers.** That is the
strongest form of the assertion and is adopted.

**And an acceptance result was strengthened rather than left comfortable:** `projects.associations.correct`
had been reported as handler-ran-only against a fabricated id; re-run, it returned `outcome: removed`,
meaning a materialised edge genuinely existed and was genuinely removed. **The worker superseded its own
weaker claim.**

---

# 15. G4 READINESS STATEMENT — W4 is the program's TERMINAL deliverable

**W5 is cancelled.** There is no independent verification wave and no G5. **Everything left open here is
open permanently**, and is recorded as such rather than rounded to done.

## 15.1 The coordinator verification run — independent, clean, unpiped

Taken after an announced quiesce, with a rebuild first and nothing else in flight:

```text
cd packages/cli && ./node_modules/.bin/vitest run --no-file-parallelism > log 2>&1 ; echo $?
RUN  v2.1.9 /Users/subhang/Desktop/Projects/tm8/packages/cli
Test Files   2 failed | 46 passed (48)
Tests        2 failed | 1114 passed | 1 skipped (1117)
REAL vitest exit = 1        (unpiped — not a pipeline's status)
build:server RC=0 · build:cli RC=0   (both unpiped)
```

**RE-TAKEN AFTER THE `035` ROTATION, and the numbers are IDENTICAL** — same 2 failures, same two named
witnesses, 1114 passed, 1 skipped:

```text
chain 32 / f7a9e137f01226f3     measured by the coordinator, cd-first, two stable samples
                                (previous 31 / 7e42a0d58f7b555d — this verdict is RE-BOUND, not carried)
```

**The `cd` is load-bearing, re-confirmed on the new chain:** the same 32 files give `f7a9e137f01226f3`
from `db/migrations` and `e856eb4232422249` from the repo root.

**The ONLY two failures are NAMED DELIBERATE WITNESSES, both asserting the contract-correct outcome, both
server-owned, both green on the merge fix:**

- `entity.test.ts` — *"a stored work note is destroyed by a transition"*
- `message.test.ts` — *"does an edit that cannot express mentions destroy stored mentions?"*

**Nothing else in `packages/cli` is red.** The 1 skip is deliberate and named.

### ⚠ G4's LITERAL CRITERION IS NOT YET MET, AND THIS RECORD DOES NOT SAY "GREEN"

M-2's text is *"all CLI group/unit/integration tests green against a real local Server."* **The suite
exits 1.** Both reds are named deliberate witnesses asserting the **contract-correct** outcome, both are
**server-owned**, and both go green on the other wave's merge fix — but **an honest disposition is not a
green, and the statement must not read as satisfied while the suite exits 1.**

**Disposition chosen: (a) — re-run after the merge fix lands and record the literal green.** It costs one
run, the fix exists and is being built, and it removes an asterisk from the program's terminal
deliverable. Until then, G4 is recorded as **MET EXCEPT FOR TWO NAMED SERVER-OWNED WITNESSES**, quoted in
full:

```text
× test/integration/entity.test.ts
    task transition wipes fields it has no flag for
      > WITNESS (deliberate red, server+projection): a stored work note is destroyed by a transition
× test/integration/message.test.ts
    coverage closure for the rows that were otherwise unit-only
      > SWEEP: does an edit that cannot express mentions destroy stored mentions?
```

**Neither is a CLI defect.** Each asserts what the contract requires and fails because the Server
performs a wholesale-replacement write. **Softening either would produce a green today that fails the day
the Server is fixed** — the argument that already paid off twice when two earlier witnesses went green on
their own fix.

## 15.2 Delivered

**All 8 command groups, 21 domain modules, registry wired, dispatch verified from the built binary.**
Every group produced a per-operation coverage declaration measured rather than inferred. Aggregate:

| Group | Rows | Real-Server | Not covered / partial, with reason |
|---|---|---|---|
| 2 space+identity | 22 | 22 | 2 pagination PATHS unexercised (single-member fixture; awards unreachable) |
| 3 entity/task/graph/undo | 23 | 23 | none |
| 4 edge/placement | 7 | 7 | placement intent `subtask` UNIT-ONLY — shares one code path with `reparent`, declared not implied |
| 5 message/handoff | 10 | 10 | fixture state seeded and labelled; `work_session` unreachable from CLI |
| 6 project/file | 12 | 11 | `bridge.fetchBlob` reserved by contract — no command exists |
| 7 inbox/saved-view/action | 8 | 8 | `inbox.markRead` REFUSAL path only — notifications minted by a trigger outside the slot |
| 8 event/presence | 3 | 2 | `events.subscribe` **UNREACHABLE BY CONSTRUCTION** — no client→server control message exists |
| 9 session/profile | 12 | 10 + 1 partial | `interactionProfiles.activate` never succeeded; `execution.prompt` correctly has no command |

**Guard flags: 7 rows, all proven ENFORCED — not merely accepted.** Acceptance + stale-refusal +
omission, each with a positive control proving the version actually moved first.

## 15.3 O1 — **BLOCKED-ON-G11**, NOT permanently open. CLI-COMPLETE / TRIGGER-ABSENT.

**Exit 11 cannot be produced on this node, and no synthetic one was manufactured.** Traced to a
terminating source:

```text
019_w2_messages_handoffs.sql:461     the RPC DOES emit a delivery intent for a work_session anchor
messages-handoffs.ts:326             the loop is wrapped in `if (this.options.messageDelivery)`
facade/index.ts:126                  registerW2MessagesHandoffsHandlers(registry, facade) — NO options
grep messageDelivery assignment      ZERO hits under packages/server/src
```

**The intent is emitted; the RESERVATION is unwired. That is G11.** Measured twice through the built
binary — task anchor and work_session anchor — both exit 0, zero delivery rows.

**Proven:** the exit-11 mapping at the kernel boundary, mutation-tested **in both directions** (flipping
the constant turned 11→0 *and* 0→11); the stored batch reaching stdout **before** the throw so
persistence is never misread as failure; and the settle loop run against a **real** `messages.delivery.get`
DTO carrying a real row, confirming the two fields it consumes.

**Not proven:** that this node ever emits exit 11 — because it cannot.

> ⚠ **CORRECTED FRAMING, ruled: this is BLOCKED-ON-G11, not PERMANENTLY OPEN.** G11 is being built now,
> and **B2 is the delivery budget — the same subsystem.** *"Permanently open"* and *"open pending a
> specific landing that is currently being built"* are **different facts**, and with no W5 the first is
> how a **closable** obligation gets recorded as unclosable.
>
> **The slot is HELD.** The moment the other wave reports `messageDelivery` wired, W4 re-measures through
> the built binary and closes it for real. **The reward for refusing to manufacture a synthetic exit 11
> should be the real proof if G11 delivers it — not a permanent asterisk.**

## 15.4 O2 — CLOSED, WITH THE QUALIFIER THAT MUST TRAVEL WITH IT

```text
argv: session attach <uuid> --mode view --timeout 120
peer observed POST /v2/entities/.../commands/streams-attach   ->   exit code=130  signal=null
```

Real built binary, real in-flight HTTP request at the real `bindPath` path, **arrival OBSERVED before the
signal** so in-flight is not raced, real SIGINT. **`signal=null` is load-bearing** — a process killed *by*
an unhandled SIGINT reports `signal='SIGINT'`. Reproduced across the chain rotation.

> ⚠ **LABELLED RED SUBSTITUTE. The peer holding the request open is a TEST DOUBLE, not the tm8 Server.**
> It proves 130 under interruption of a real in-flight **REQUEST**; **NOT** under interruption of a real
> in-flight **SERVER OPERATION**. O2 may never be recorded without this qualifier.

Why the fully-real path is unavailable, **shown rather than asserted**: attach needs a live work session;
`CreateEntityInputSchema` **excludes** `work_session` (it does **not** exclude `team_member` — a measured
asymmetry that later enabled the A19 fixture); and a successful spawn would start a real server-hosted PTY
running a real agent — **an outward-facing side effect the worker declined to create unilaterally.**

## 15.5 Open permanently — recorded, not glossed

1. **O1** — blocked on G11 delivery reservation.
2. **Four data-loss instances** of one class — *an optional field a caller cannot express, nulled by a
   wholesale-replacement write, failing silently at exit 0*: `graphLayout`, `note`, `startedAt`,
   `mentions`. **Ruled: the server-side merge is the fix**, with the constraint that **absent means leave
   alone, explicit null means clear** — a working reference implementation already exists at
   `007_rpc_catalog.sql:1039-1041`.
3. **Cursor truncation** — fixed at `messages.list` and `collections.query`; **`entities.feed` and
   `inbox.list` remain**, both DESC/`<` keysets, i.e. the **silent-skip** direction.
4. **`events.subscribe`** — unreachable until the client→server WS control protocol lands.
5. **`interactionProfiles.activate`** — never successfully activated.
6. **`promptExtra`, `confirmAgentGenerated` on A20** — unexpressible; no authority names a flag, and the
   latter cannot be added without a further kernel change.
7. **`entities.commands.pull`** — implementation stricter than the contract: `localId` is
   `.nullable().optional()` yet both omission and explicit null are refused.
8. **`operations.ts` note on `commands.undo` is INVERTED** — it says redemption *restores* a redacted
   message; migration 020 shows it **redacts**.

## 15.6 What this wave actually produced, beyond the modules

**Ten sessions delivered final reports carrying corrections against themselves.** The instrument defects
found today were found by workers auditing **their own records**, not by anyone checking the product:

| Defect | Reports | Rather than |
|---|---|---|
| piped exit status | the last pipeline stage | the command that failed |
| before/after hash bracket | same at both ends | unchanged throughout |
| inline backticks in a message | shell output | the literal text |
| unquoted `$var` as argv in zsh | one token | word-split arguments |
| name-grep over a schema | the name you thought of | the shape |

**None of them produces an error.** Every one is a real signal reporting on something other than what the
reader assumes.

**Two coordinator errors were caught by workers**, both because someone checked the primary source rather
than the message: a **stale chain announcement** four workers refused to act on, and a **guard-flag table
wrong on three of seven rows** — transposing two fields that differ by one word, the exact collapse the
coordinator had just lectured the wave about. Both produced standing law:

> **AN ANNOUNCEMENT IS EVIDENCE, NOT AUTHORITY. THE TREE IS THE AUTHORITY.**
> **AN INSTRUCTION IS EVIDENCE, NOT AUTHORITY. THE SCHEMA IS THE AUTHORITY.**

**And the class this wave named held all the way to the end:** *an assertion whose subject gets FIXED
stops testing without ever going red.* It fired on the coordinator's own file when `presence.get`
composed, on a projection sweep whose defect was fixed underneath it, and on a test asserting a parser
bug that had just been repaired. **The remedy that works is the EXACT-SET assertion that goes red in both
directions** — a new instance fails, and closing one without delisting it also fails.

## 15.7 A CORRECTION TO THIS LEDGER'S OWN CAUSAL CLAIM — the orphan did NOT explain load 66

While measuring quiescence, this coordinator found an orphaned `vitest` process (PID 60018, ~17h40m old,
92% of a core, predating both waves) and reported that it **"materially explains"** the load-average-66
event several workers had measured — the one that caused `tm8 --version` to cost 1.85-2.32 s and killed
integration tests at vitest's 5-second default.

**That causal claim was WRONG and it was mine.** Measured afterwards: load `10.78 / 15.81 / 33.52` and
**falling**, every other long-running node process at 0.0%, and PID 60018 accounting for **roughly one
core of eight — about 1.0 of load, not 66.**

> **The 66 was the two waves' own concurrent full-suite runs.** That is exactly what the workers
> diagnosed, and exactly what the full-suite sequencing rule fixed. **Nothing they concluded needs
> revisiting**, and the sequencing decision stands on its own merits — it was always justified by
> cross-run interference, never by load or disk.

The orphan is a genuine waste and a genuine contributor. **It is not the explanation.**

**This is the same failure as the disk-slope misattribution, recurring: a real observation handed a
causal role nobody measured.** Both instances were produced by a coordinator, not a worker, and both were
in the *satisfying* direction — a tidy single cause for a messy symptom. **A measurement without its
attribution is a rumour with a number attached**, and the rule has now had to be applied to this
program's own hygiene reporting **twice**.

## 15.8 The count-without-inspection class — four instances, both waves

    "20 vitest processes"     grep matched maestro SESSION COMMAND LINES containing the string
    "2 migrate.mjs"           same artifact, same cause
    "set=2 reset=1" on 035    "set role" is a SUBSTRING of "reset role" — fires on every BALANCED file
    (and independently, the other wave hit the identical vitest artifact)

**Every one was caught by looking at the matched LINES instead of trusting the COUNT.** Two nearly blocked
another wave's landing; one nearly filed a false defect against a correct migration. It is the same shape
as the name-grep that saw 11 of seventeen guard-bearing DTOs — **a count answers a question about the
pattern you wrote, not about the property you meant.**

The `035` instance is worth keeping for a second reason: the never-left-elevated lint it nearly impugned
**already had the negative control** — validated not only against all 32 landed files but against six
shapes it must NOT fire on, including `set role` inside a dollar-quoted body, a line comment, a block
comment and a string literal, plus `set local role` as transaction-scoped. **Those six are the difference
between a detector and a stuck alarm, and neither coordinator specified them.** The rule it implements is
**never-left-elevated, not count-equality** — because `015` legitimately carries set=1/reset=2 and a
counts-match lint would fire on correct code.

## 15.9 AMENDMENT TO THE VOID-RUN RULE — not a worker's footnote

The VOID-RUN rule was specified as *"hash the file under test immediately BEFORE and AFTER the run;
a mismatch voids the run."* **That is weaker than intended and is hereby amended.**

> **A before/after hash bracket proves the file is the SAME AT BOTH ENDS. It does NOT prove the file was
> UNCHANGED THROUGHOUT.** A probe, mutation, or any transient edit applied and byte-for-byte reverted
> *inside* the window passes the bracket and reports the run VALID. It is not.

**Amended requirement: no probe, mutation, or transient tree edit may run while a suite intended for
report is in flight.** Sequence them. Where that was violated, the run is not authoritative and a clean
re-run is. **Three sessions found this in their own records and withdrew their own numbers rather than
defend them** — one had additionally started a second vitest process from one session, violating
one-process-per-session, and said so plainly.

## 15.10 The EXACT-SET assertion discriminates — proven where a count cannot

The table-driven flag-to-field exact set was required because two adjacent guard rows had been
**transposed**, and a per-row review cannot see a swap. It was then shown to catch exactly that:

```text
M8  TRANSPOSITION: swapped the collision pair's fields (menu.update <-> defaultChannel.set)
    FIRED — and THE COUNTS STAYED IDENTICAL, 16 vs 16. Only the PAIRING detected it.
M9  THE TIDIER: "normalised" the one non-kebab row to --expect-artifact-version
    FIRED — so a future reader who tidies the dossier exception fails a test rather than passing review.
```

> **A COUNT CANNOT DETECT A PAIRING ERROR BY CONSTRUCTION, because a transposition is count-preserving.**

Same structural blindness as `73 + 25 = 98` and as the `12`-vs-`11` guard hint — **a third instance, in a
third subject.** The dossier exception is pinned **inside** the table citing §7:335 and §4:123-127 by
line, so the one legitimate deviation lives in one reviewable place rather than scattered as comments.

---

# 16. G4 — MET. Final gate run, fully green.

```text
build:server RC=0 · build:cli RC=0            (both unpiped)
RUN  v2.1.9 /Users/subhang/Desktop/Projects/tm8/packages/cli
Test Files  48 passed (48)
Tests       1150 passed | 1 skipped (1151)    REAL vitest exit=0
chain 34 / a799b7ef1b20a9b0 — measured cd-first, IDENTICAL before and after the run
```

**Zero failures.** M-2's literal criterion — *"all CLI group/unit/integration tests green against a real
local Server"* — **is met.** The one skip is `it.skipIf(unwired.length === 0)`, which skips **because
every command is wired**.

**Both deliberate witnesses went green ON THEIR OWN** when their server-side defects were repaired, with
no change to CLI code and no change to CLI tests. That is the whole argument for never softening a
witness: a softened test goes green immediately and fails the day the bug is fixed.

## 16.1 O1 — CLOSED

```text
[g5][O1-trigger] exit=11 mode=binary
real delivery DTO -> status "failed_permanent", settledAt "2026-07-27T08:00:58.610Z", targetWorkSessionId set
```

**A real reserved delivery row, SETTLED and NON-DELIVERED, produced exit 11** — the contract's **first
disjunct** (`exit.ts:44`, `GRAMMAR:1148`). No synthetic state, no fault injection, no live agent.

**The obligation was never "stored but unsettled."** That was a **narrowing introduced in restatement**
and carried by every packet for a day; the contract states a disjunction with *non-delivered* first, in
five places. **Recorded as restoration, not redefinition.**

**Why the first attempt measured zero rows:** the built binary **predated the wiring landing**. Four
hypotheses had been eliminated and nothing was left standing **because both waves were reasoning about a
code path absent from the artifact under test.**

**Condition on the green, which travels with it:** a **hand-supplied local credential** against a dev
cluster with TRUST auth — **a property of this cluster, not the product.** At default configuration the
variable is unset and *"no delivery rows"* means **UNCONFIGURED**, not undeliverable. **CORRECTED: the node now REFUSES TO START unless
the URL authenticates as a non-superuser `tm8_delivery_worker`** (`verifyDeliveryPrincipal`, awaited at
`main.ts:134` before `listen()`, checking `session_user` because it survives `set role`). The code still
cannot constrain **what an operator puts in the URL** — only whether this node will run with it. It is a
**mitigation, not a fix**: `015:1346-1347` still admits any principal permitted to *assume* the role, and
the durable fix is deliberately deferred because it would turn two DB test files red — **they pass
BECAUSE OF the hole.**

**This is the first and only observation in the program of B2's delivery path executing.**

## 16.2 O2 — CLOSED, qualifier attached

Exit 130 on a real SIGINT to a real in-flight request, arrival **observed** before the signal,
`signal=null` load-bearing. **Labelled RED SUBSTITUTE:** the peer is a test double, so it proves 130 under
interruption of a real in-flight **REQUEST**, not of a real in-flight **SERVER OPERATION**. The
fully-real path was **shown** unavailable, not asserted.

## 16.3 What remains open — permanently, and recorded

Cursor truncation at `entities.feed` and `inbox.list` (**silent-skip** direction) · the CLI can receive
presence but never announce it · `interactionProfiles.activate` never successfully activated ·
`promptExtra` and `confirmAgentGenerated`-on-A20 unexpressible · `entities.commands.pull` stricter than
its contract · the `resume.since` 2^53 ceiling · the clear-half of absent-means-merge being DB-reachable
but not API-reachable · and **prose has nothing that goes red**, for which no mechanism was found.

**Full detail, ordered for a first-day reader: `docs/history/program-w0-w5/W4-CLI-HANDOFF.md`.**

