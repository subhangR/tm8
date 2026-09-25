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

### 8.2 Also next run (schema 4)

- `blindFetchBytes` is structurally 0 in fixture v2 (an entry's `bytes` is its index line, ≤ 655 B; no body > 4.5 KB). Redefine it on the read's RESULT bytes, and add a fixture body > 20 KB.
- Decision D6 (report-time, already in report.mjs): read D2 beside `silent context failure` (needle not inlined and never opened) and success. On index-off arms an entry-level miss on a stress needle is a recovery.
