# context-eval — the reusable context-pipeline eval

Re-run it unchanged after every improvement and read the report as a diff.
Design (decisions, marked AUTHORITY / SPEC / SUMMARY): `DESIGN.md` (entity doc 01a0d941-e2ac). Coordinator commands: `RUNBOOK.md`.
Task E1 01a0d93b-122f; builds on `../context-measure` (I10a, #799/#809/#811/#813) and IMPORTS its measurement: `measure.mjs` (bytes, tokens, expand / miss / blind-fetch, D2 `missLevel`), `success.mjs` (hidden checks at the committed head, closeout, criteria), `lane.mjs` (lane process probes), `dev-cli.mjs` (the one door to a dev node), and its fixture content.

**Dev nodes only (ports 4620–4624, DBs tm8_eval0..4). Never 7778. No fleet default is flipped.**

| file | what |
|---|---|
| `dev-node.sh` | `up <port> <db> <datadir> <build-dir> [ARM=lean\|index-derived\|index-authored\|inherit]` / `stop <port>` / `status <port>`. DB + migrate + server under `env -i` (delivery wired as `tm8_delivery_worker`, `TM8_LAUNCH_BOOTSTRAP=1`) + owner claim + space (seeds the catalog teammates) + project + ledger-lite fixture repo + `<datadir>/t8` wrapper + registry `$CTX_EVAL_HOME/nodes/<port>.json`. |
| `fixture-data.mjs` | v2 content: the I10a needle tasks (imported), stress30/stress60, the heavy memory set (Q1), the multi-turn change request, per-family rubric items. |
| `build-fixture.mjs` | Emits `fixtures/fixture-v2.json` (schemaVersion + contentHash) from fixture-data + `fixtures/replicas-v2.json`. |
| `snapshot-replicas.mjs` | Freezes real tasks (read-only `entity get` on the source) into `fixtures/replicas-v2.json`. |
| `fixture.mjs` | `--node <port>`: creates the TEMPLATE entities on that node → `fixtures/node-<port>.json` (ignored by git; per node). Authored headers only on an `index-authored` node. |
| `lanes.mjs` | `--slice c1..c4 --node <port> --out results/<run>.jsonl`: the slice runner. Interleaved order, load-tiered concurrency (2 < 40, 1 at 40–80, wait > 80), FRESH task copy per lane, multi-turn injection + resume, measure + judge, one JSONL row per lane. |
| `components.mjs` | Context size by component (bytes) and its estimated token share. |
| `pricing.mjs` | The one $/Mtok table (VERIFY-marked) and `CHARS_PER_TOKEN`. |
| `report.mjs` | `results/<run>.jsonl [--baseline <prior>.jsonl]` → MD + JSON: per model × arm × family tables, D2 gate rows (exact 95% UB), accuracy, cost deltas vs lean, start failures, per-slice load, DELTA vs baseline. Exit 1 on zero rows, an arm with no measured rows, or an unmeasured row that is not excluded. |
| `exclude.mjs` | Set a row aside with a reason (never deleted; counted in §5). |
| `report.test.mjs` | `node --test tools/rigs/context-eval/*.test.mjs`: positive control, NEGATIVE control (a mutated miss level reds the gate row), refusals, rubric, Clopper–Pearson, components, pricing. |
| `node-registry.mjs` | Arms, their env, and the node registry reader. |
| `results/` | One JSONL per run, plus the report MD/JSON. |

## The matrix (DESIGN.md §2–3)

models `sonnet5`, `haiku45` (`opus55` wired) × arms `lean` / `index-derived` / `index-authored` / `inherit` × families `needle` (fee, category, rounding) / `replica` (3 frozen real tasks) / `stress` (stress30, stress60) / `memory` (mem-fee) / `multiturn` (turn-date) × reps. A slice is one arm on one node: c1 lean 4621, c2 index-derived 4622, c3 index-authored 4623, c4 inherit 4624.

## Row schema (`context-eval.row.v1`)

identity (`slice, arm, node{port,db,env}, buildSha, fixtureVersion, model, teammateId, family, taskKey, rep, sessionId, taskId, templateTaskId, worktree, base, laneTm8`) · timing/load (`startedAt, endedAt, ended, wallSeconds, uptimeStart, uptimeEnd, loadAtStart, waitedSeconds`) · measure.mjs fields (`system, firstUserBytes, attachments, firstRequestTokens, requests, usage, expand, miss, blindFetchBytes, needleState, needleOpened, memoriesCollapsed, memoryExpands, toolCalls, modelId, residentTm8Bytes, residentHarnessChars`) · `components {bytes, tokens}` · `costUsd` · `success` (context-measure) · `checkResults[] {expr, set: base|alias|turn, pass}` · `rubric {family, items[], score, judge:'deterministic'}` · `turn` (multiturn) · `excluded {reason, by, at}` / `measureError` / `judgeError`.

## Known limits

- The token split by component is an estimate (chars ÷ `CHARS_PER_TOKEN`); `firstRequestTokens` itself is measured. About 12k tokens of `inherit`'s harness (tool schemas) are not in the transcript and land in `remainderEstimated`.
- Four arms on one Mac share wall-clock time; every row carries `loadAtStart`, `uptimeStart/End` and `node.port`, and report §5 shows per-slice load so a slow slice reads as load, not as the arm.
- `resumed` is judged from the session's state after `session resume` (ran or reached idle), not from the transcript.
- Prices in `pricing.mjs` are VERIFY-marked; $ is a comparative estimate.
- `blindFetchBytes` is structurally 0 in fixture v2, so read it as no evidence rather than a clean result. measure.mjs gates it on a manifest entry's `bytes` > 20 KB, but an entry's `bytes` is its INDEX LINE (or snapshot row), at most 655 B across all 34 eval manifests. And no fixture body exceeds 4.5 KB. Redefining it (e.g. an unpaged read whose RESULT exceeds 20 KB) changes the measurement: a next-run item under the schema freeze at 703db99a.
