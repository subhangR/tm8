# AO vs tm8 — Component Analysis

**Status:** DESIGN / durable capture. No implementation follows from this document alone.
**tm8 analysis base:** `3edf470f034cce6228aac98aa78ef1eb03239ae3` (`origin/main`, "Merge pull request #506").
**AO reference:** `github.com/Untrivial-ai/agent-orchestrator` @ `d4ae9b3`, Go 1.25.7.
**Sibling:** [`HARNESS-REGISTRY-DESIGN.md`](HARNESS-REGISTRY-DESIGN.md) — the design that follows from §9.

---

## 0. Why this document exists, and what it is allowed to claim

A prior analysis compared AO against tm8 and lives only as chat messages in a Space
with no repository attached. Messages are not a durable capture: they cannot be
diffed, they cannot be reviewed against a commit, and they cannot be corrected in
place. This file is that analysis moved somewhere it can be held to account.

**Two evidence classes, and they are not equal.**

| Class | Source | Status |
|---|---|---|
| **tm8-side claims** | Read directly from the tree at `3edf470f` | **Verified.** Every number below carries a file:line. |
| **AO-side claims** | Carried forward from the prior analysis | **NOT re-verified.** The AO repository is not available on this node. |

Every AO figure in this document is therefore reported as *claimed*, not as measured.
Where the two sides are compared, the comparison is only as good as its weaker half,
and the weaker half is always AO. This is stated once here rather than hedged in
every row.

**A note on the base, because it nearly went wrong.** Two worktrees had already been
cut for this task, both pinned at `1156f07a`. That commit is **161 commits behind**
`origin/main` (`git rev-list --count 1156f07a..origin/main` = 161). An analysis
written against it would have described a tm8 that stopped existing weeks ago. The
work was re-cut from `3edf470f` before any file was read. The prior analysis's own
reference point, `8e6e1527`, is likewise behind `3edf470f`; §10 records every place
where its figures no longer reproduce.

---

## 1. The one-sentence difference

> **AO is a supervisor for agent *sessions*. tm8 is a collaborative *graph* in which
> `work_session` is one entity kind among twenty-one.**

AO's atomic unit is the session. tm8's is the `team_member`. Everything downstream —
persistence shape, API surface, what a "status" is, what realtime means — follows
from that one choice, and most of the apparent disagreements between the two systems
dissolve once it is held in view.

The corollary is the part that matters for planning: **AO's session-supervision depth
is not a competitor to tm8's graph, it is a component tm8 does not have.** A thing
tm8 could adopt without moving its centre.

---

## 2. Language, runtime, distribution

| | AO | tm8 |
|---|---|---|
| Backend | Go 1.25.7, ~300k LOC *(claimed)* | TypeScript / Node, 9 packages |
| Frontend | Electron + React, ~148k LOC *(claimed)* | React (`tm8-ui`, `ui`), browser-served |
| Distribution | Desktop app on the user's machine | Server binary; browser client |
| Trust posture | The operator's own laptop | Multi-member shared host |

tm8's packages at `3edf470f`: `cli`, `contract`, `execution`, `mcp`, `prompt`,
`pty-protocol`, `server`, `tm8-ui`, `ui`.

The distribution difference is the root of §8. A desktop app and a shared server are
not two implementations of one product; they are answers to different questions about
who is on the other side of the process boundary.

---

## 3. Persistence

**tm8 — envelope + typed detail (class-table inheritance).** One `entities` envelope
row carries the universal capabilities (discuss, link, parent, react); each core kind
gets a typed SQL detail table where its constraints and invariants live. Custom kinds
get a registry row plus a row in one shared jsonb detail table validated on write
(T-L4, `docs/architecture/01-LAWS.md:31`).

Verified at `3edf470f`:

- **158 migration files** in `db/migrations/`, highest ordinal `168_teammate_delivery_without_a_source_session.sql`.
- **Two roles, and the application role cannot write.** `tm8_app` is granted
  `execute` on the concrete contract RPCs and nothing else — e.g.
  `db/migrations/018_w2_edges_placements.sql:407-409` grants exactly
  `write_edge` / `update_edge` / `delete_edge`, and
  `017_w2_entities_commands_tracking.sql:668` states the rule in a comment: *"grant
  only the concrete contract RPCs to `tm8_app`."*
- **`SECURITY DEFINER` is the write path.** 70 occurrences across 40 migration files.
  A representative function opens with `perform internal.require_identity();` then
  `perform internal.require_space_member(row.space_id);`
  (`103_forge_observer_facts_and_nudges.sql:123,128`).
- **RLS reads per-transaction claims.** `009_claim_accessor_grants.sql:46` grants
  `execute on function internal.claim_text(text) to tm8_app`, because policy
  expressions evaluate *as the querying role* — the comment at line 12 says exactly
  that. Identity binds with `SET LOCAL` inside each transaction (T-L11,
  `01-LAWS.md:78`), never via a self-minted service token.
- **Trigger-owned derived data and uuidv7 keyset pagination**, per T-L11/T-L12.

**AO** *(claimed)* encodes relationships as foreign keys and Go structs.

**The honest comparison.** AO's equivalent safety story is *"it is on loopback and it
is your machine."* That is not a weaker version of tm8's story — **it is a correct
answer to a different threat model.** On a single-user desktop app, the operator
already has every privilege the database could withhold; RLS there buys ceremony, not
safety. On a shared server with multiple members and agents acting under
`can_act_as`, the process boundary is the only thing between one member's data and
another's, and it has to be real. Neither posture is scored here. They are answers,
and they are answers to different questions.

---

## 4. Relationship modelling — T-L3 and T-L4

**T-L3** (`01-LAWS.md:25`): side tables are legitimate in four flavours (ledgers,
per-member state, config, operational), but *"side tables never encode relations;*
***edges are the only relationship mechanism***.*" It explicitly forbids hand-rolled
relationship arrays — the named V1 Firestore failure mode `pulledByUids[]`,
`assigneeUids[]`.

**T-L4** (`01-LAWS.md:31`): *"Kinds are data — including user-defined kinds."* One
`KindRegistry` entry per kind in the UI, one `entity_kinds` row per kind in the DB.
Custom kinds are created **at runtime**. It forbids `if (kind === '…')` outside the
registry, and it forbids dynamic DDL.

**Consequence, stated plainly:** tm8 can grow a noun without a release. AO cannot —
a new relationship is a new FK and a new struct, which is a migration and a binary.
This is the single largest structural difference between the two systems and it is
not a matter of maturity or effort; it is what each one decided a "kind" *is*.

**Core entity kinds at `3edf470f`** (`packages/contract/src/contract.ts:31-47`) — **21**:

```
channel · task · message · member · team_member · doc · file · spell · skill
pull_request · commit · work_session · collection · project · interaction_profile
voice_channel · memory · artifact · worktree · loop · graph
```

plus `CustomEntityKind = \`c:${string}\`` for the runtime-registered ones
(`contract.ts:49`).

---

## 5. API surface — T-L12

**T-L12** (`01-LAWS.md:84`): *"HTTP facade, CLI, and MCP tools are projections of one
operation catalog — never parallel APIs."* With it travel the canonical
`WorkspaceEvent` as the only event shape any consumer sees, uuidv7 keyset cursors, the
closed error taxonomy, universal idempotency (`clientMutationId` + command ledger),
capability discovery (`capabilities` + `/actions`), and **`501 not_implemented` as the
honest feature gate**.

Verified at `3edf470f`, `packages/contract/src/catalog.ts`:

- **172 operations** in `OPERATIONS`.
- **170** carry `status: 'v1'`; **2** carry `status: 'reserved'`.
- Largest families: `spaces` **30**, `entities` 21, `execution` 20, `projects` 19,
  `auth` 10, `messages` 7.

A reserved slot answers an honest `501`, never a `404` —
`packages/server/src/facade/index.ts:12` describes the registry's purpose as
*"answering an honest `501 not_implemented` (DEV-13)"*, and
`input-schemas.ts:11` notes that a reserved operation answers `501` **before**
validating its input, because validating first would leak a schema for something that
does not exist.

**AO's answer to the whole of this** *(claimed)* is `packages/cloud-client`: a typed
client for routes that live in a different repository. That is a reasonable shape for
a desktop app talking to somebody else's backend. It is not a catalog, and it cannot
be projected onto a CLI or an MCP surface, because there is no single definition to
project.

---

## 6. Execution and session lifecycle

This is AO's home ground and the section where tm8 is genuinely behind.

### 6.1 What tm8 has

`packages/execution/src/spawn/` — 6,655 lines across 13 modules:

| Module | Lines |
|---|---|
| `SpawnService.ts` | 2,292 |
| `manifest.ts` | 1,332 |
| `types.ts` | 839 |
| `worktree-reconcile.ts` | 412 |
| `worktree-provisioning.ts` | 230 |
| `workspace-trust.ts` | 213 |
| `sandbox-probe.ts` | 172 |
| `native-session.ts` | 170 |
| `agent-credentials.ts` | 163 |
| `codex-network-preflight.ts` | 130 |
| `skills.ts` | 130 |
| `index.ts` | 108 |
| `secret-redaction.ts` | 84 |
| `checkout-branch.ts` | 29 |

with 34 test files in `packages/execution/test/`.

The lifecycle is deep where it exists. Three examples, each of which encodes a defect
that actually happened on the prod node:

- **Pre-minted native session id.** `--session-id <uuid>` forces Claude to adopt
  tm8's uuid as its conversation id, which is what makes exact-id `--resume`
  possible without ever parsing a transcript (`manifest.ts:522-529`).
- **Prompt delivery is a channel distinction, not a string concat.** The system
  prompt *configures*; the task prompt is the agent's *first user turn*. Conflating
  them put the task inside `--append-system-prompt`, emitted no positional argument,
  and every tm8-launched agent booted to an idle REPL while reporting `running`
  (`manifest.ts:718-731`). *"A session row that exists is not an agent that started."*
- **Sandbox honesty is probed, not inferred.** `sandbox-probe.ts:1-45` records that
  codex ships its own bwrap, so "is bwrap on PATH" gets the *wrong* answer; the real
  blocker on this node was AppArmor's `unprivileged_userns` profile, and the two
  sandbox shapes failed at different depths for different reasons. Only running the
  provider's own `codex sandbox -- <cmd>` predicts it.

### 6.2 What tm8 does not have

Verified absent at `3edf470f`:

- **No runtime reaper loop.** No `processalive` / `sessionguard` equivalent; grep for
  process-liveness probing (`kill(pid, 0)`, `isProcessAlive`) in
  `packages/execution/src` returns nothing.
- **No worktree file watching.** No `chokidar`, no `fs.watch`, no `watchFile`
  anywhere in `packages/`. AO's fsnotify → edge-triggered invalidation has no
  counterpart.
- **No activity hooks.** No `PreToolUse` / `PostToolUse` / `hooks.json` handling.
  tm8 infers activity from **stream silence** instead —
  `PtyHostService.ts:1030-1053` resolves once the PTY has produced no output for
  `idleMs`, and `types.ts:160` reasons about ten seconds of silence from a PTY.
  *(The activity-signal problem is out of scope here; it is the subject of the
  sibling design `ACTIVITY-SIGNAL-DESIGN.md`, owned separately.)*
- **No served systemcheck.** Only the offline CLI `packages/cli/src/commands/doctor.ts`.
  There is no endpoint that answers "is this node healthy" to a client.
- **No model discovery.** `packages/contract/src/launch-models.ts` is nine hardcoded
  entries with no probe and no cache. See §9.
- **No reviewer agents / auto-review.** The only match for reviewer-pane vocabulary
  in `packages/` is an unrelated e2e spec.

---

## 7. Status derivation and realtime

**tm8: the server owns derived truth.** T-L12 is explicit — blocked rollups,
`PullState`, auto-tabs, counters, titles are *"computed once, delivered identically to
every consumer."* A client never re-derives a status; it renders one. The canonical
`WorkspaceEvent` is the only event shape any consumer sees, which is what makes HTTP,
CLI and MCP able to agree about what just happened.

**tm8: realtime is announced through the graph, delivered on sockets.** T-L10
(`01-LAWS.md:68`) — a `work_session` entity carries the LIVE/share flag and viewers
are discovered via membership, but the bytes always flow client↔home-server over the
WS bridge, relayed by a gateway as a dumb pipe. *"Live bytes never pass through
storage."* The database is forbidden from any streaming hot path, and ambient
live-terminal visibility is forbidden — sharing is an explicit act.

The xterm frame *inside* a `work_session` panel is explicitly exempt from the
entity-component contract at the frame level (T-L10, R16): the panel around it is an
entity component; the canvas inside it is not.

**AO** *(claimed)* derives status in the supervisor and pushes to an Electron
renderer over IPC — coherent for one process pair, with no cross-transport agreement
problem to solve because there is only one transport.

---

## 8. The correction: tm8's PR/CI observation surface

**This section exists because the original analysis got it wrong, and the correction
is more interesting than the error.**

**What was claimed:** that tm8 had no PR/CI observation surface at all.

**What is true:** `packages/server/src/tracking/` is **2,941 lines** across 8 modules
(`observer.ts`, `github.ts` 731, `nudges.ts`, `loops.ts`, `github-write.ts`,
`commit-recorder.ts`, `git-local.ts`, `pr-projection.ts` 205), backed by
`db/migrations/103_forge_observer_facts_and_nudges.sql`.

**Why the error is worth recording rather than quietly fixing.** The claim was made
from the *absence of a name*: nothing in the tree is called `scm/` or `forge/` or
`github-observer/`, so a search shaped around AO's vocabulary found nothing and
concluded there was nothing. That is a failure mode with a general form — **searching
a codebase for the other system's nouns and reporting the absence of the noun as the
absence of the capability.** The fix is not "be more careful"; it is to search for the
*behaviour* (what writes `ci_status`?) rather than the *label*. Every other absence
claimed in §6.2 was re-derived that way before being written down.

### The four axes on which tm8's tracking out-designs a larger SCM observer

**1. The semantic diff is computed inside Postgres, in the same statement that
overwrites.** `apply_pull_request_facts`
(`103_forge_observer_facts_and_nudges.sql:115-190`) takes `select … for update`, holds
the pre-update row in `row`, performs the `update`, and then returns the *transition*:

```sql
'state',                  coalesce(p_state, row.state),
'previousState',          row.state,
'mergeableState',         coalesce(p_mergeable_state, row.mergeable_state),
'previousMergeableState', row.mergeable_state,
'changed', (coalesce(p_title, row.title) is distinct from row.title or …)
```

The comment at line 169 names the discipline: *"The SEMANTIC diff, not 'did any byte
move'."* Because the read and the write are the same statement under a row lock, **the
two-observer race is closed by construction** rather than by a lock the application
layer has to remember to take. Two observers cannot both see the same transition,
because the second one's `row` already holds the first one's write.

**2. Dedup is durable, and it is the database's job.** `nudges.ts:31-33`:
*"DEDUP IS DURABLE AND IT IS THE DATABASE'S JOB (103 §J). The signature is computed
here — content, hashed — and `claim_session_nudge` decides.* ***A Map in this process
would be dedup that a deploy erases.***" The enqueue is an
`insert … on conflict (pr_entity_id, loop_kind, scope_key, coalesce(head_sha,''))
where status = 'pending' do nothing` (line 165-166). An in-memory map survives until
the next restart; this survives the restart.

The keying is careful in a way that matters: `pr_check_facts` is keyed on `head_sha`,
not on the PR alone, because *"a check named `build` is red on commit A and green on
commit B, and a table keyed only by name would let the push that fixed it silently
overwrite the evidence that it was ever broken — which is fine for display and fatal
for a diff"* (`103:197-201`).

**3. GraphQL for review-thread resolution, because REST cannot express `isResolved`.**
`tracking/github.ts:331` states it directly, and the implementation queries
`/graphql` (line 365) for `reviewThreads { isResolved }` (lines 617, 411). This is not
a preference for GraphQL; it is the only surface that answers the question. An
observer that could only reach REST would have to treat every thread as unresolved
forever, and *"an unanswered reviewer does not become more unanswered every sixty
seconds"* (`nudges.ts:28-29`).

**4. Nudge content contracts inline the evidence, because the agent cannot open a
browser.** `nudges.ts:14-29` — the CI log **tail** travels in the nudge (*"the last
hundred lines are almost always the error"*), unresolved review threads travel with
their thread IDs **and comment bodies** so the agent can reply and resolve without
another round trip, and merge-conflict nudges are **suppressed when the PR is stacked
on an open parent** (`pr_is_stacked_on_open_parent`), because *"it is not the author's
conflict to fix… Nudging anyway teaches the agent that conflict nudges are noise,
which costs the loop its credibility for the case where the conflict IS real."*

That last one is the difference between a notification system and a system designed
for a reader who has no hands. A human observer clicks through to the log. An agent
cannot, so the log has to come to it — and every nudge that is technically true but
not actionable is a direct tax on the credibility of the ones that are.

### Where tm8's tracking is genuinely narrower

**One provider is implemented — but the seam exists and refuses honestly.**
`observer_watch_targets` carries a `provider` column, and `observer.ts:128-132`:

```ts
// Only GitHub is implemented. A row naming another provider is recorded
if ((target.provider ?? 'github') !== 'github') {
  problems.push(`${target.entityId}: provider ${String(target.provider)} is not implemented`);
```

A GitLab row is **recorded as a problem, not crashed on** — the behaviour is covered
by `packages/server/test/tracking/forge-watcher.test.ts:484-487`. This is the same
discipline as T-L12's honest `501`: the shape is present, the answer is "not
implemented", and nobody is told a lie. AO's claimed 5.7k LOC across github + gitlab +
multi is more *implemented providers*; it is not obviously a better *seam*.

---

## 9. The capability gap

Carried from the prior analysis, with the tm8 side re-verified at `3edf470f` and
corrected where it did not reproduce. **AO figures are claimed, not measured** (§0).

| Capability | AO *(claimed)* | tm8 @ `3edf470f` | Verdict |
|---|---|---|---|
| Agent harnesses | 26 | **2 real + 1 stub.** `AGENT_TOOL_BINARIES` = 3 entries (`manifest.ts:495-499`) | ✅ reproduces |
| Reviewer agents / auto-review | ~2.4k LOC, 24 panes | **none** | ✅ reproduces |
| Model discovery | `modelcatalog` 607 + `authprobe` 134, fingerprinted cache | **none** — `launch-models.ts` is 9 hardcoded entries | ✅ reproduces |
| Token / cost accounting | `domain/usage.go` + migration `0102_canonical_usage` | **partial, not none** — see below | ⚠️ **corrected** |
| Multi-provider SCM | github + gitlab + multi, 5.7k LOC | **1 provider implemented, seam present, honest refusal** | ⚠️ **refined** |
| Runtime reaper loop | 5s probe + `processalive` + `sessionguard` | **none** | ✅ reproduces |
| Served systemcheck | `service/systemcheck` + endpoint | **none** — only offline `cli/src/commands/doctor.ts` | ✅ reproduces |
| Worktree file watching | fsnotify → edge-triggered invalidation | **none** — no `chokidar`/`fs.watch` in `packages/` | ✅ reproduces |
| Activity hooks | `hooksjson` 465 + `hookutil` 116 + TUI interpretation | **none** — stream-silence timers (`PtyHostService.ts:1030`) | ✅ reproduces |

**The token-accounting correction.** "None" is too strong. `SessionTranscriptStats`
carries `inputTokens` / `outputTokens` / `cacheReadTokens`
(`contract.ts:4157-4159`), and `packages/tm8-ui/src/transcript/session-stats.ts`
renders them under a rule worth quoting, because it is the same
absence-is-not-a-verdict discipline that governs `pr-projection.ts`:

> *"HOLLOW IS NOT ZERO … the null is LOAD-BEARING: it means* ***the provider did not
> report****, which is a different claim from* ***the provider reported nothing was
> spent****."*

What tm8 actually lacks is **accounting**, not measurement: the numbers are
transcript-derived, per-session, and display-only. There is no usage ledger, no cost
model, no rollup across sessions or members, and no migration corresponding to
`0102_canonical_usage`. The accurate row is *"per-session token display, no cost
accounting"* — which is a smaller gap than "none" and a differently-shaped one.

**≈26k LOC total**, and the important claim about it survives: **it is not a rewrite.**
None of the nine rows fights a tm8 law. Every one of them is a component that would
sit inside the existing architecture — which is exactly why the harness registry
(§10 sibling doc) is worth doing first: it is the one row that is *already* required
by the laws rather than merely permitted by them.

---

## 10. Where tm8 leads, and AO does not compete

Not a scoreboard — a statement of what each system chose to be about.

**tm8 has, and AO has no equivalent to:** spaces (30 catalog operations) ·
membership + RLS + `can_act_as` · docs · channels · messages · inbox · attention
requests · collections · saved views · presence · artifacts · runtime-created custom
entity kinds (T-L4) · the edge-type registry · handoffs · interaction profiles · an
MCP surface · and a **172-operation catalog projected identically to HTTP + CLI +
MCP** (T-L12).

**AO's answer to all of it** *(claimed)* is `packages/cloud-client` — a typed client
for routes in a different repository. That is not a smaller version of the above; it
is the boundary at which AO stops being the system and starts being a consumer of one.

This asymmetry is the reason the gap in §9 is worth closing and the gap in this
section is not worth AO closing. tm8 is missing components from a category it already
has the architecture for. AO is missing a category.

---

## 11. Corrections against the prior analysis

Recorded rather than silently applied, per §0.

| # | Prior claim | At `3edf470f` | Note |
|---|---|---|---|
| 1 | Analysis base `8e6e1527` | `3edf470f` | Pre-cut worktrees were at `1156f07a`, **161 commits** behind. Re-cut before reading. |
| 2 | "no PR/CI observation surface" | **2,941 lines** in `packages/server/src/tracking/` | The original error. See §8 — searched for AO's noun, not tm8's behaviour. |
| 3 | `work_session` is "one kind among **fifteen**" | **21** core kinds (`contract.ts:31-47`) | |
| 4 | **163**-operation catalog | **172** (`170` v1 + `2` reserved) | |
| 5 | spaces = **24** catalog operations | **30** | |
| 6 | tracking = **2,904** lines | **2,941** | |
| 7 | `agentTool` appears **455** times | **463** (`.ts`/`.tsx`, all packages) | |
| 8 | Token accounting: **none** | **Per-session display exists; accounting does not** | §9. Corrected, not merely re-counted. |
| 9 | Multi-provider SCM: **GitHub only** | **One provider implemented; provider seam present; non-GitHub refused honestly** | §8. Refined. |
| 10 | `agentTool` is a **literal union** to be widened | **Already `string` on the wire and in `ResolvedLaunchConfig`** | The material finding for the sibling doc. See `HARNESS-REGISTRY-DESIGN.md` §3. |
| 11 | Credentials: an **anthropic/openai ternary** to be generalised into a provider table | **The provider table already exists** (`agent-credentials.ts:48`); the ternary is a drifted duplicate | See `HARNESS-REGISTRY-DESIGN.md` §6. |

Rows 3–7 are drift: the prior figures were correct at their base and the tree moved.
Rows 2 and 8–11 are **substantive** — they were wrong at any base, and rows 10 and 11
change the shape and cost of the work proposed in the sibling document.

---

## 12. Impact

**What executes if this document is adopted: nothing.** It is an analysis, not a
plan, and saying so plainly is more useful than manufacturing a blast radius for a
Markdown file. The concrete accounting:

| Axis | Impact |
|---|---|
| Packages / files | **None.** Adds two files under `docs/harness/`, plus index rows in `docs/harness/README.md`. |
| Contracts | **None.** No operation added, removed, or re-typed; no catalog revision. |
| Migration | **None.** |
| Existing callers | **Nothing breaks.** No runtime artefact reads these files. |
| `claude-code` / `codex` | **Zero.** No spawn path, argv, credential path, or manifest field is touched. |

**Where the real impact lands is downstream, and it is not zero.** Three things
change once these findings are accepted:

1. **Eleven prior figures are superseded (§11).** Anything that reused the old numbers
   — a roadmap slide, a sizing estimate, another design doc — is now citing figures
   this document contradicts. Five are harmless drift. **Four are substantive**, and
   two of those (rows 10 and 11) directly re-size the sibling design: Phase 1 from
   ~400 to ~150 LOC, Phase 2 from ~300 to ~200 LOC. Anyone who budgeted from the old
   table budgeted ~450 LOC of work that does not exist.
2. **Two gap-table rows must stop being quoted as "none".** Token accounting is
   *partial* and multi-provider SCM is *one implemented behind a working seam*. Both
   were used as evidence of absence; neither supports that weight any more. A plan
   built on "tm8 has no forge observer at all" is built on the one claim §8 exists to
   retract.
3. **The `tracking/` correction changes what should be built next.** If tm8 had no
   PR/CI observation surface, porting AO's 5.6k-LOC SCM observer would be a
   priority. It is not — the surface exists, is smaller, and is better on four axes.
   The honest remaining gap there is **provider breadth**, which is a much smaller and
   differently-shaped job than "build an observer."

**Cost of adopting it:** the review time to check the citations. Every tm8-side claim
carries a `file:line` against `3edf470f` specifically so that this cost is bounded and
the document can be re-verified rather than re-argued.

**Cost of not adopting it:** the analysis stays in chat messages in a Space with no
repo attached — undiffable, uncorrectable, and already carrying two substantive errors
that nothing in that medium can retract.

---

## 13. Self-critique

The strongest honest arguments against this document, in the order a reviewer is most
likely to raise them.

### 13.1 The AO half is unverified, and that is a real limit — not a caveat

**This is the weakest thing here and it is structural.** The AO repository is not
available on this node (checked; no local checkout, no vendored copy). **Every AO
figure in this document is carried forward from a prior analysis I could not
re-run:** 26 harnesses, ~2.4k LOC of reviewer agents and 24 reviewer panes,
`modelcatalog` 607 + `authprobe` 134, `domain/usage.go` + migration
`0102_canonical_usage`, 5.7k LOC across github + gitlab + multi, the 5s probe +
`processalive` + `sessionguard`, `service/systemcheck`, fsnotify invalidation,
`hooksjson` 465 + `hookutil` 116, `packages/cloud-client`, ~300k backend LOC, ~148k
Electron/React LOC, and the ≈26k total.

**That is roughly half of every comparison in this file.** The document is honest
about it — §0 declares the two evidence classes and each figure is marked
*(claimed)* — but labelling a number does not verify it. Concretely:

- **A comparison is only as strong as its weaker half**, so §9's "verdict" column is
  really "does the *tm8* side reproduce", not "is the comparison sound". The column is
  named accurately but reads stronger than it is.
- **The prior analysis has a demonstrated error rate.** §11 catches four substantive
  mistakes and five drifts on the tm8 side. There is no reason to assume its AO side
  was more careful — and unlike the tm8 side, nobody has checked. If ~2.4k LOC of
  reviewer agents is really ~800, the §9 gap narrows and the ≈26k total is wrong.
- **The one AO claim doing the most work is the least checkable:** "26 harnesses."
  The entire framing of the sibling design's product question (§8 there) rests on it.
  If AO's 26 includes aliases, deprecated entries, or thin wrappers over the same two
  CLIs, the number that makes 26 sound ambitious is doing so on false pretences.

**What would fix it:** a checkout of `d4ae9b3` and one re-grep pass. Until then, **no
decision should rest on an AO figure alone.** The tm8-side absences in §6.2 are safe
to act on — they were derived here, from this tree, by searching for behaviour.

### 13.2 "The absence claims are proven" is the claim most likely to be wrong

§8 names the failure mode — searching for the other system's nouns — and then asserts
that every other absence was re-derived by behaviour instead. **That assertion is
weaker than it sounds.** Proving a negative in a 9-package monorepo by grep is
exactly the method that already failed once, on `tracking/`.

The absence claims are not equally strong:

- **Strong:** no `chokidar` / `fs.watch` / `watchFile` anywhere in `packages/` — a
  file watcher must call one of them, so the negative is nearly closed.
- **Weaker:** "no runtime reaper loop." I searched for `processalive`, `isProcessAlive`,
  `kill(pid, 0)`. A liveness reaper implemented via PTY exit codes, a `setInterval`
  over session rows, or an exit-classification path would not match any of those —
  and `pty-exit-classification.test.ts` exists, so *something* in this area does. The
  honest claim is "no AO-shaped reaper", not "no liveness handling".
- **Weakest:** "no reviewer agents / auto-review." Searched for reviewer-pane
  vocabulary. If tm8 spawns review sessions through the ordinary spawn path with a
  reviewer persona, it would be invisible to that search and would arguably count.

A reviewer who knows the tree will falsify one of these, and the reaper row is where
I would put my money.

### 13.3 The `tracking/` section may be too flattering

§8 says tm8's 2,941 lines "out-design" AO's claimed 5.6k on four axes. **That framing
is doing more than the evidence supports.** The four axes are real and verified in the
SQL and the comments, but:

- **They are the four axes on which tm8 is strong.** I found them by reading tm8's
  code and noting what it does well. That is selection by construction, and a list
  chosen that way will always favour the system it was read from. The axes AO might
  win on — provider breadth, webhook ingestion vs. polling, rate-limit handling at
  scale — are not in the comparison, and I did not look for them.
- **"Out-designs" invites a scoreboard the document elsewhere refuses.** §3 correctly
  declines to score AO's loopback threat model against tm8's RLS. §8 then scores the
  observer. That is an inconsistency, and the §3 posture is the better one.
- **Line counts are not design quality in either direction.** The document says
  2,941 < 5,600 and calls it a win. It would have rejected that reasoning if the
  numbers ran the other way.

The defensible claim is narrower: **tm8's tracking makes four specific design choices
that are correct and non-obvious, and their correctness does not depend on how AO's
compares.** I would accept an edit to that.

### 13.4 The base is fresh; the freshness argument is one-sided

The document opens by rejecting a base 161 commits stale. Fair — but `3edf470f` will
be stale too, and sooner than the document's tone implies. There is no mechanism here
that makes the figures self-checking: the next reader gets a table of numbers with a
commit hash and no way to re-derive them except by hand.

**The mitigation that is missing:** the greps that produced §9 and §11 are described
in prose but only one is written out as a runnable command. A short appendix of the
exact commands would let any future reader re-run the whole table in a minute. I did
not add one, and I think a reviewer should ask for it.

### 13.5 What would falsify the document's central claim

The central claim is: **AO's session-supervision depth is a component tm8 could adopt
without moving its centre — "it is not a rewrite."**

It is falsified if any §9 row turns out to require a change to a tm8 law. The nearest
candidate is **activity hooks**: if reading a provider's hook output requires tm8 to
treat harness-specific event shapes as first-class, that pushes against T-L12's
canonical `WorkspaceEvent` as *"the only event shape any consumer sees."* I asserted
that none of the nine rows fights a law **without designing any of them**, and for
activity hooks specifically that assertion is being made about work that is explicitly
out of scope here and owned by a sibling design. It is the row I am least confident
about, and if `ACTIVITY-SIGNAL-DESIGN.md` concludes otherwise, this document's
"it is not a rewrite" needs qualifying.

---

## 14. What follows from this

1. **The harness registry is not on this list as a feature.** It is the one item the
   laws already require. → [`HARNESS-REGISTRY-DESIGN.md`](HARNESS-REGISTRY-DESIGN.md).
2. **The activity-signal problem is real and separately owned.** tm8 infers activity
   from stream silence; AO reads hooks. → `ACTIVITY-SIGNAL-DESIGN.md` (sibling task).
   See §13.5 — this is also the row most likely to falsify §9's closing claim.
3. **The remaining seven rows of §9 are candidates, not commitments.** Each is a
   component that fits tm8's architecture; none is urgent on architectural grounds
   alone. Prioritising them is a product decision, and this document does not make it.
4. **Verify AO before spending against an AO number.** §13.1.
