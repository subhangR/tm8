# context-eval — design (decisions only)

Task E1 01a0d93b-122f · advisor task 01a0d777-7b11 · builds on `tools/rigs/context-measure` (I10a, #799/#809/#811/#813).
Every table is marked **AUTHORITY** (quoted from code / a decision), **SPEC** (this doc decides), or **SUMMARY** (paraphrase; copy from the source, not from here).

## 1. What the eval answers

One question, re-askable after every improvement: *for a given model and launch arm, what does a lane get sent, does it still find what it needs, does it finish the task, and what does that cost?* Rows are comparable across runs because the fixture is versioned, task keys are stable, and the report reads two run files as a diff.

## 2. Matrix — SPEC

| axis | values | key in a row |
|---|---|---|
| model | `sonnet5` = catalog seed "Sonnet 5 Teammate" (`claude-sonnet-5`), `haiku45` = "Haiku 4.5 Teammate" (`claude-haiku-4-5-20251001`); `opus55` = "Opus 5.5 1M Teammate" is wired but not in any slice | `model` |
| arm (node env) | `lean` = `TM8_HARNESS_SURFACE=minimal`, index off (today's default) · `index-derived` = minimal + `TM8_CONTEXT_INDEX=on`, no authored headers · `index-authored` = same + `headers.mjs` on the fixture docs · `inherit` = `TM8_HARNESS_SURFACE=inherit`, index off | `arm` |
| family | `needle` (fee, category, rounding), `replica` (3 real 7778 tasks, frozen into the fixture), `stress` (stress30: 30 links, needle at 20; stress60: 60 links, needle at 30), `memory` (mem-fee: 12 memories ≈ 17 KiB so Q1's 12 KiB cap collapses the lowest-ranked; the alias fact lives in the memory that collapses first), `multiturn` (turn-fee: a change request injected at the lane's first idle, then terminate + `session resume`) | `family`, `taskKey` |
| reps | 2 per cell in the first run (`--reps`) | `rep` |

Catalog seed names and model ids — **AUTHORITY** `packages/contract/src/launch-models.ts:162-176`: `seedName: 'Sonnet 5 Teammate'` / `model: 'claude-sonnet-5'`; `seedName: 'Haiku 4.5 Teammate'` / `model: 'claude-haiku-4-5-20251001'`.

Why stress30's needle sits at 20: past the assignment snapshot's 16-title `linked` list (`LINKED_MANIFEST_MAX = 16`, design §2.2) but inside the 32-link spawn read, so the arms can differ. stress60 keeps I10a's shape (needle at 30, inside the read, past the 8 KiB reference cap) so its numbers stay comparable with #809.

Jev is parked: no Jev arm. Opus: same rig, `--models opus55`, later.

## 3. Slices — SPEC

A slice is **one arm**, both models, every family, `--reps` reps. One arm = one node env, so a coordinator never restarts its node mid-slice, and the four arms run side by side on four nodes at the same wall-clock time (better balance than I10a's sequential ABAB blocks).

| slice | arm | node | db | lanes at reps=2 |
|---|---|---|---|---|
| c1 | lean | 4621 | tm8_eval1 | 2 models × 10 task keys × 2 = 40 |
| c2 | index-derived | 4622 | tm8_eval2 | 40 |
| c3 | index-authored | 4623 | tm8_eval3 | 40 |
| c4 | inherit | 4624 | tm8_eval4 | 40 |

Budget check (SUMMARY of #809): Opus lanes ran a median 107 s wall + ~60 s spawn/measure. 40 lanes × ~3 min ÷ 2 concurrent ≈ 60–80 min, inside the 3 h ceiling with room for a third rep or re-runs.

## 4. Fresh task copy per lane — SPEC (reviewer finding on #809, msg 01a0d908-4d44)

`fixture.mjs` creates TEMPLATE entities once per node (docs, file, skills, memories, distractors, template tasks with their edges) and records them in `fixtures/node-<port>.json`. A lane never runs on a template: `lanes.mjs` copies the template task (title, content with every criterion unticked) and re-creates its edges in the recorded order, then spawns on the copy. The row carries both `taskId` (the copy) and `templateTaskId`. Fixture content is `fixtures/fixture-v2.json` (`schemaVersion: 2`), committed; a content change bumps the version and the report refuses to diff across versions.

## 5. Measures per row — SPEC (mechanics imported from context-measure)

| group | fields | source |
|---|---|---|
| identity | `buildSha`, `node {port, db, arm, env}`, `model`, `teammateId`, `family`, `taskKey`, `rep`, `sessionId`, `taskId`, `templateTaskId`, `uptimeStart`, `uptimeEnd`, `laneTm8` | lanes.mjs; node registry |
| size (bytes) | `components.bytes`: `tm8Kernel` (tm8 system block minus the index), `assignmentSnapshot` (turn-1 user bytes), `contextIndex` total + per group (references/skills/teammates/memories = Σ `entries[].bytes` by group, collapsed states), `memoriesExpanded` (`budgets.memoryInjection.used`), `harness.{skillListing, deferredToolsDelta, mcpInstructionsDelta, agentListingDelta, chrome, systemOther}`, `remainder` (estimated: tool schemas etc.) | `measureLane` (context-measure/measure.mjs) + manifest |
| size (tokens) | `components.tokens`: each component's share of `firstRequestTokens`, remainder = `firstRequestTokens × CHARS_PER_TOKEN − measured chars` (CHARS_PER_TOKEN in `pricing.mjs`, marked estimate) | derived |
| resident | `residentTm8Bytes`, `residentHarnessChars` (bytes × requests) | measure.mjs |
| accuracy | `success {committed, checks, closeout, ticked, success}` + `rubric {family, score 0..1, items[]}` deterministic per family (below) | `laneSuccess` (context-measure/success.mjs, given the fixture's checks) |
| misses (D2) | `miss.entry.count`, `miss.header.count`, `expand.rate`, `blindFetchBytes`, `needleState`, `needleOpened` | measure.mjs |
| efficiency | `requests`, `toolCalls`, `usage {input, cacheCreation, cacheRead, output}`, `wallSeconds`, `costUsd` (pricing.mjs; one table, per-model $/Mtok, VERIFY-marked) | measure.mjs + pricing |
| failures | `ended` (idle/done/timeout/no-transcript/spawn-error/resume-failed), `excluded {reason, by}` — counted per arm × model, never dropped; a row that is neither measured nor excluded fails the report | lanes.mjs |

D2 — **AUTHORITY** (decision msg 01a0d77b-ef4d): "ENTRY-level miss (gated): the lane read an id that was ABSENT from the prompt … HEADER-level read (reported, not gated) … the rate is per LAUNCH … promote needs missed launches < 5% AND task success not worse than the off arm". Implemented by `missLevel()` in context-measure/measure.mjs, imported unchanged.

Rubric per family (deterministic; no LLM judge; a Haiku judge is 'later' and would be marked `judge: 'haiku'`):
- needle / stress: hidden checks at the committed head (all pass), closeout posted by the lane's actor, every criterion ticked, needle doc opened. Score = passed items / 4.
- memory: the needle items + the alias export check (`<fn>2` behaves as `<fn>`), which only a lane that expanded the collapsed memory can pass. Score = / 5.
- multiturn: the needle items + the injected change's check + `resumed` (the resume relaunched and reached idle). Score = / 6.
- replica: no hidden deliverable; closeout posted + criteria ticked + committed (when the copy carries criteria). Score = items / 3. Reported separately, never pooled with needle.

## 6. Report — SPEC

`report.mjs results/<run>.jsonl [--baseline results/<prior>.jsonl]` → `<run>.md` + `<run>.json`:
1. per model × arm × family: median [min–max] n for first-request tokens, tm8 kernel, index bytes, harness chars, resident bytes, requests, wall, cost $; 
2. D2 gate rows per model × arm: launches with an entry-level miss / launches, exact one-sided 95% upper bound (Clopper-Pearson), header-level read share with the >25% flag;
3. accuracy: success rate and mean rubric score per family; 
4. cost deltas vs `lean` for the same model (tokens and $, median);
5. start failures / hangs per arm × model (set aside, with reasons);
6. DELTA vs baseline: same cells, baseline → current, with n on both sides; refuses a baseline with a different `fixtureVersion`.
Exit 1 on zero rows, an arm with zero rows, or an unmeasured row that is not excluded.

## 7. Run protocol — SPEC

1. `dev-node.sh up <port> <db> <datadir> <build-dir> [ARM=…]`: creates the DB if absent, migrates, starts under `env -i` with `TM8_LAUNCH_BOOTSTRAP=1` and `TM8_DELIVERY_DATABASE_URL` as `tm8_delivery_worker` (required for the multi-turn family; a superuser URL is refused at boot), claims the owner, creates the space (that seeds the catalog teammates), the project and the fixture repo, writes `<datadir>/t8` (owner CLI wrapper) and the node registry `nodes/<port>.json`. Idempotent: `up` on a claimed node only restarts it under the given ARM.
2. `node fixture.mjs --node <port>` builds the templates once per node (skips when `fixtures/node-<port>.json` matches the fixture version).
3. `node lanes.mjs --slice c1 --node <port> --out results/<run>.jsonl [--reps 2] [--models …] [--only key,…] [--concurrency 2]`: refuses a node whose registered arm is not the slice's; records uptime before/after each lane; does not start a lane while the 1-min load is above 80 (waits, logs); ≤ 2 lanes concurrent.
4. `node report.mjs results/<run>.jsonl --baseline results/<prior>.jsonl`.

Isolation (next run; decision D9, from C1 msg 01a0d98b-abf7; designer's wording msg 01a0d98c-3bb6). In the first run, lanes' worktrees sat on the same host as the shared build and the operator's `gh` login. Replica lanes ran `git fetch` in the build tree and read the REAL GitHub, and one ticked a criterion because the real PR #800 had merged. The build was also a git WORKTREE of the operator's main tm8 repo, so git run there reached the operator's real branches. The tree was verified intact; SPEC for the next run:
- (a) The build directory a node runs from is READ-ONLY to lanes. dev-node.sh copies the built dists into `<datadir>/build-<sha>`, owned by the node, runs `chmod -R a-w` after the copy, and the node registry records that path. A lane then cannot alter the code under test, and the four nodes never share a writable tree. The build is a standalone copy, never a worktree of the operator's repo. The same rule covers the WORKING TREE of `<datadir>/fixture-repo` (designer msg 01a0d98d-aad5, from C1 msg 01a0d98d-6e34): after dev-node.sh commits the fixture skills it runs `chmod -R a-w` on everything except `.git`. The fixture-main guard already catches a commit, and a stray write then fails loudly instead of being cleaned up by the lane (C1's Sonnet fee#2 wrote `test/fee.test.js` into the main fixture checkout, removed it, and redid the work in its worktree).
- (b) Lanes run WITHOUT the host's GitHub credential. The node starts with `GH_TOKEN` unset and `GH_CONFIG_DIR=<datadir>/gh-empty`, and the fixture project's repo-url is `none`, so `gh` in a lane fails fast instead of reading real PRs.
- (c) A row records `reachedOutside: true` when its tool calls name a path outside its worktree and `<datadir>`, or run `gh` / `git fetch` against a remote. It is computed at report time from the transcript, reported per model × arm as a behaviour column, and never scored.
- (d) Fixture v3 replica bodies must not name real PR numbers or repo paths that exist on the host (part of §8.3's "checkable inside the fixture repo" rule).

PRODUCT finding (for the advisor, not a rig item): with the index OFF, a worktree lane's skill pointers name the MAIN checkout, e.g. `<project working dir>/.claude/skills/<name>/SKILL.md`. Verified on a c1 lean manifest, where every `skills[].loadPointer` / `sourcePath` is under `/private/tmp/ctxeval/node1/fixture-repo`. The lane itself runs in a worktree that carries the same committed files. A lane that follows the pointer lands in the main tree and may start working there. The fix belongs in the launch: resolve `loadPointer` / `sourcePath` against the lane's cwd when the project is checked out as a worktree. It is measurable here: split `reachedOutside` into "via a skill pointer" vs other.
- (e) Owner material never lives under a path a lane can derive from its own cwd (designer msg 01a0d98f-06aa, from C3 msg 01a0d98e-7fa0). Lanes run as the same OS user as the node, so file modes cannot fence them; only placement and detection can. dev-node.sh writes `owner-token`, `owner-password`, `claim.json` and the `t8` wrapper to `$CTX_EVAL_HOME/owner/<port>-<8 random hex>/` (outside `<datadir>`, outside the build, name unguessable), records that path in `nodes/<port>.json` as `cli`, and leaves nothing but the server's own files in `<datadir>`. The node registry file moves beside it (it names the cli path), and so does the setup-token copy once claimed. In the first run, C3's haiku45 replica-01a0d780#1 walked up to `<datadir>`, found `t8`, and posted with the OWNER token.
- (f) Detection, at report time, in the `reachedOutside` column. `identityEscalation` = a tool call that invokes a path matching the owner wrapper or reads an `owner-token` file, or a message on the lane's task whose author is not the lane's actor. The report footnote states that `success.closeout` counts ONLY messages authored by the lane's teammate, so an owner-token post never scores as a closeout.
- (g) This run: coordinators post, per slice, the count of messages on lane task copies authored by anyone but the lane (RUNBOOK §6 has the command).
- (h) Cross-lane contamination (designer msg 01a0d98f-5988, from C2 msg 01a0d98e-a956). Concurrent lanes on one node share a space, so a lane can list another's session and message it; C2's two Haiku replicas coordinated an escalation.
  1. `crossLane`, inside `reachedOutside`, at report time: any tool call that names another lane's session id, task-copy id or worktree from the same run (the results file has all of them), or a message whose anchor is another lane's session. Flagged rows print as a pair, count once in independence-sensitive stats (the D2 gate n, success n), and the pair is footnoted.
  2. The replica family runs at concurrency 1 (replicas are the lanes that go looking); the other families keep the load-tiered 2.
  3. v3 runner option `--isolate-space`: one throwaway space per lane (catalog teammates are seeded per space, so the teammate id is looked up by seed name per space). Default off until the seeding cost per space is measured.
- (i) Shared /tmp. dev-node.sh cannot set a per-lane TMPDIR (the launch env is the server's), so this is a LAUNCH item, task 01a0d991-1570: the execution layer sets `TMPDIR=<worktree>/.tm8-tmp` (created, gitignored) for every spawned lane. Until then `reachedOutside` prints /tmp writes as `scratch`, a benign class, not an escape.
- (j) `gh auth status` leaking the host login into a transcript is (b) again: with `GH_TOKEN` unset and `GH_CONFIG_DIR` empty it prints "not logged in" and nothing else.
- (k) Lanes must not share a project memory (decision D11; designer msg 01a0d995-1c4c; C3 msg 01a0d994-59e7). Claude Code keys auto-memory to the PROJECT root (`~/.claude/projects/<slug of the fixture repo>/memory/`), so one lane's notes loaded into every later lane's first request on that node. In the first run: node3 (38 KB, 4 lanes), node1 (9 lanes), node4 (6 lanes). The guard is in lanes.mjs since 7cc832d4: the dir must be absent or empty before every spawn, or it is moved to `<datadir>/evidence/` and the row records it. report.mjs flags `wroteAutoMemory` and sets aside `contaminated {by, via: 'auto-memory'}` rows. `reachedOutside` gains `memoryWrite`.
- (l) PREVENTION, probed on Claude Code 2.1.280. The env `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` and the setting `autoMemoryEnabled: false` (via `--settings`) BOTH switch auto-memory off. With either one, a seeded marker memory was not loaded (0 hits vs 1 in the control), and the prompt carried NO memory instructions (0 mentions of the memory dir vs 4), so a lane is neither given memory nor told to write it. dev-node.sh adds `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` to the server's `env -i` (lanes inherit the server's env, as USER already proves); it takes effect at the next `up`. Alternatively, a per-lane/per-node HOME with the operator's `.claude` config copied.
  RULING (advisor, D11): next run, dev-node.sh sets `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` in the node env BY DEFAULT, recorded in `node.env` on every row, with the guard (k) kept as the backstop. The private-config-dir option (a per-lane/per-node `.claude`) replaces the switch once the launch seam exists. Why the numbers differ: the switch removes the memory block from the harness prompt, so harness chars are comparable ACROSS ARMS of a run but not with 7778 lanes, which carry that block.

Harness noise (for the consolidated read, not a rig item): the mid-turn commit-attribution reminder is Claude Code's own. A model that flags it as injected is being careful; every Claude lane sees it on every arm, so it cancels across arms.
Never 7778. Nodes only on 4620–4624 / tm8_eval0..4. No fleet default flipped. The rig's own CLI arguments instruct and warn; they never reject content.

## 8. Later (not built for the first run)

Opus arm; a Haiku judge; a second injected message after resume; Jev arms (parked); per-`source` expand split (manifest records none); live-7778 mode (real manifests, no copy) — the D5 staged rollout would use context-measure's summarize on 7778 manifests directly.

### 8.1 Fixture v3 / schema 4: the memory family — SPEC (approved by the advisor, 01a0d777-7b11; designer's text, msg 01a0d97b-ac62)

Why: in fixture v2 the equipped naming-conventions skill CONTRADICTS the alias memory (`HEAVY_MEMORIES[0]`: export every helper under a `<name>2` alias), and neither the spec doc nor the criteria mention the alias. So `aliasCheck` measures whether a lane trusts a memory over a conflicting skill and over the task text, not whether the memory was delivered. A careful model SHOULD refuse it: C1's Sonnet mem-fee#1 on lean flagged the memory as possibly injected, and the same model passed it in another lane, so the item is stochastic by construction.

1. Split the memory family into two items, each measuring one thing.
   - `memoryOpened` (index-on arms only): the lane opened the collapsed memory (`row.memoryExpands > 0`). This is the delivery question Q1 exists for. n/a on lean/inherit, where nothing collapses.
   - `memoryFollowed` (every arm): the lane acted on a memory-only fact that NOTHING else contradicts.
2. Replace the alias fact with a non-conflicting, low-cost convention that only the memory states and the deterministic checker can see at the committed head. The new test file must be named `test/<fn>.test.js`, and its first line must be the comment `// spec: <needle doc title>`. The check: the file exists at the committed head with that first line.
3. The CONFLICTING variant may come back later as its own optional family (`memory-vs-skill`, marked as an instruction-following measure), never pooled with delivery.
4. `success.success` applies the rubric's n/a rule: an item that is n/a on an arm is not a gate on that arm either.
5. Fixture v3 = `schemaVersion` 3 (so `contentHash` changes); v2 and v3 runs never diff against each other (report.mjs refuses).

THIS run (fixture v2), decision D7 (report-time, no remeasure, report.mjs): the alias item is printed with k/n as "alias memory trusted over conflicting skill", and it and its two hidden checks are out of the rubric mean AND out of success / deliverable correct on EVERY arm. Delivery on index arms is read from `memoryExpands` / the header-level read.

### 8.3 Fixture v3 replicas — SPEC (designer, msg 01a0d97e-0233; advisor D8)

- Fixture v3 replicas carry `deliverableKind: doc | message | code | none`, frozen with the task. The rubric applies only the items that kind allows:
  - doc → a doc created or attached on the task by the lane's actor since lane start;
  - message → closeout;
  - code → committed + hidden checks;
  - none → sizes only.
- Replicas are chosen, or their bodies trimmed, so the deliverable is CHECKABLE INSIDE THE FIXTURE REPO. A code replica names a change to ledger-lite, never to tm8; a doc replica's references resolve to entities the copy carries. The alternative is to run replicas against a tm8 checkout at the source sha.
- "Asked the human" (ended idle, ≤ 2 requests, no deliverable) is a named outcome, reported, never scored 0.
- Any replica whose body cannot be made checkable stays a size-and-miss-only row (`deliverableKind: none`).

THIS run (fixture v2), decision D8 (report-time, no remeasure): `committed` is n/a on all three replicas. `ticked` applies to replica-01a0d742 and replica-01a0d780 only (replica-01a0d778 has no criteria). `closeout` applies to all. The map is `REPLICA_ITEMS` in report.mjs, printed in §3. Replica accuracy is labelled "not a context measure in fixture v2" and dropped from every success comparison. "Asked the human" is counted per model × arm and kept out of the replica mean and success.

### 8.4 Subagent measurement — SPEC (schema 4; designer msg 01a0d98e-a1a4, approved; from C4 msg 01a0d98e-3268)

A lane that delegates writes its subagent transcripts to `<transcript-dir>/<native-session-id>/subagents/agent-<id>.jsonl` (plus `.meta.json`), a sibling of the lane's `<native-session-id>.jsonl`. The first-run rig reads only the main file, so a delegating lane undercounts requests, tokens, tool calls, reads and $.
1. measure-row reads the main transcript AND every `subagents/agent-*.jsonl` beside it. Each row gets a new `subagents: { count, requests, toolCalls, usage {input, cacheCreation, cacheRead, output}, reads, costUsd }`.
   - The lane's existing totals (`requests`, `toolCalls`, `usage`, `costUsd`, `expand`, `miss`, `blindFetchBytes`) INCLUDE the subagents. A subagent's read of a linked or dropped id is the lane's read, since the lane chose to delegate it.
   - `firstRequestTokens` and every first-request component stay the MAIN transcript's: the launch context is what is measured there. A subagent's first request is its own harness context, recorded under `subagents.firstRequestTokens[]` for the record, never pooled with the lane's.
2. Report §1 gains "lanes that delegated" (a count) and prints requests/tokens/$ as lane totals (subagents included). A per-arm × model "of which subagents" line keeps delegation cost visible.
3. `remeasure --all` recomputes it from disk; a row measured before schema 4 is refused by the floor as usual.
4. Test: a synthetic lane with one subagent file.
   - Positive control: the subagent's usage is added.
   - Negative control: a subagent read of a dropped id counts as the lane's entry-level miss; removing the file drops it.
5. `reachedOutside` is split into main lane vs subagent (§7 (h)). `gh` failing inside worktrees ("no git remotes found") is the fixture repo-url=none rule already working; the build dir was the only path to a remote.

### 8.5 Runner control — SPEC (advisor, msg 01a0d996-4105 area; from three coordinators' PID-killing watchers)

lanes.mjs has no graceful stop, and three coordinators each wrote a PID-killing watcher to stop at a lane boundary; each lost one in-flight row. Next run:
- `--drain` / a stop file (`<datadir>/lanes.stop`): finish the in-flight lanes, start none, exit 0 with a summary of the unstarted cells.
- `--exclude-families <list>`, the complement of `--families`.
- `--rep-start <n>`: a re-run of one cell carries the right rep label, instead of repeating rep 1.

### 8.2 Also next run (schema 4)

- `blindFetchBytes` is structurally 0 in fixture v2 (an entry's `bytes` is its index line, ≤ 655 B; no body > 4.5 KB). Redefine it on the read's RESULT bytes, and add a fixture body > 20 KB.
- Decision D6 (report-time, already in report.mjs): read D2 beside `silent context failure` (needle not inlined and never opened) and success. On index-off arms an entry-level miss on a stress needle is a recovery.
