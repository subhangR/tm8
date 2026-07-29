# tm8 W0 Gate Report

**Date:** 2026-07-26  
**Wave:** W0 — design closure, adoption, and amendment dossier  
**G0 status:** **APPROVE** — fresh Claude Opus 5 session `sess_1785036862149_jx2k5cx86`; 0 unresolved blockers, 0 unresolved majors  
**G0.1 status:** **APPROVE if and only if** fresh Claude Opus 5 session `sess_1785040472762_0wsb78pdj` returns APPROVE with zero unresolved blockers and zero unresolved majors against the exact §10 hashes; that session's final task verdict is incorporated into this record by reference  
**Implementation status:** no production/package/migration/UI/Remote Phase-2 code changed; no git command was run by the W0 coordinator

## 1. Delivered W0 tree

Created:

- `docs/plans/TM8-W0-AMENDMENT-DOSSIER.md`
- `docs/plans/TM8-W0-CONSISTENCY-MATRICES.md`
- `docs/plans/TM8-W0-GATE-REPORT.md`
- `docs/plans/TM8-W0-W5-HANDOFF-STATE.md`
- `docs/plans/TM8-W0-G0.1-AMENDMENT-REPORT.md` (W0-E)

Amended canonical authorities:

- `TM8-FINAL-DESIGN-SET.md`
- `TM8-FINAL-DESIGN-SET-REVIEW.md`
- `WORKSPACE-LAYOUT-AND-TERMINOLOGY.md`
- `WORKSPACE-LAYOUT-REVIEW.md`
- `DOMAIN-ARCHITECTURE-DECISIONS.md`
- `TM8-API-CATALOG-GROUPED-GUIDE.md`
- `TM8-CLI-GRAMMAR-REDESIGN.md`
- `TM8-SESSION-COMMUNICATION-MODEL.md`
- `TM8-AGENT-HARNESS-AND-COMMAND-DISCOVERY.md`
- `TM8-CURRENT-BACKEND-BRIEFING-FOR-CHAT-TEMPLATES.md`
- `TM8-CHAT-UI-AND-LAYOUT-DESIGN.md`
- `docs/tm8-architecture/05-DECISIONS.md`

No file under `packages/`, `db/migrations/`, UI source, or Remote Phase 2 was edited.

## 2. Closure outcome

`TM8-FINAL-DESIGN-SET-REVIEW.md` §7 records each B1/B2, M1–M7, and m1–m13 disposition and exact owning text. Highlights:

- B1 is enforced in design at the only meaningful boundary: frozen v1 `execution.prompt`, Server-internal delivery principal only, `forbidden/use_message_send` for every Member/Teammate before queue admission, zero PTY bytes.
- B2 is universal at reservation: every Teammate-authored top-level/reply live attempt uses one durable locked unordered pair; no thread root; four admitted reservations; provenance-derived Member reset; retry consumption; permanent fallback; bounded cleanup.
- `interaction_profile` has a total registry, route, projection, capability, menu, and migration disposition.
- DOMAIN owns K/L entities, relations, storage, API and current/target status.
- Harness has an explicit adversarial closure table and new M10/M11/M12/S6 cases.
- The ledger has documentary voice, current masthead, Round-1 boundary, Round-9/11 finality labels, and twenty PARTIAL successor chains.
- Default channel, named feed policy, non-pinnable request `default`, anchor-derived read auth, message-batch correlation, current token/grammar, Project cap/admin repair, and capability separation are exact.
- Vega adoption and the public-route T-D20/R17 reversal are recorded as T-D23.

## 3. Source and matrix evidence

Read-only parser result:

```json
{
  "catalog": 81,
  "status": { "v1": 79, "reserved": 2 },
  "method": { "GET": 31, "POST": 32, "PATCH": 8, "DELETE": 6, "PUT": 3, "WS": 1 },
  "http": 80,
  "registerableHttp": 78,
  "handlers": { "facade": 23, "execution": 4, "events": 1, "total": 28 }
}
```

The matrix parser reports:

```text
matrix_baseline_rows=81 F=23 X=4 E=1 WS=1 R=2 semantic=28
matrix_additive_rows=20
migration CREATE TABLE statements=43
```

The baseline matrix operation names are an exact set bijection with `packages/contract/src/catalog.ts`; rows are sequential 1–81. Additive rows are sequential A01–A20 and their name sets are identical in the dossier, grouped API guide, and operation matrix. The first inventory worker supplied a correct aggregate handler count but mislabeled eight row-level handlers; direct registry inspection caught and corrected `messages.list`, `messages.post`, `collections.query`, and `projects.list/create/get/update/link` to facade-handler status before G0.

Exact commands:

```sh
node <<'NODE'
const fs=require('fs');
const c=fs.readFileSync('packages/contract/src/catalog.ts','utf8');
const rows=[...c.matchAll(/\{\s*name:\s*'([^']+)'[^\n]*method:\s*'([^']+)'[^\n]*status:\s*'([^']+)'/g)]
  .map(m=>({name:m[1],method:m[2],status:m[3]}));
const by=k=>rows.reduce((a,r)=>(a[r[k]]=(a[r[k]]||0)+1,a),{});
console.log(rows.length,by('status'),by('method'));
NODE

rg -ni 'create\s+table' db/migrations/*.sql | wc -l

awk -F'|' '$2 ~ /^[[:space:]]*[0-9]+[[:space:]]*$/ {n++; h=$6; gsub(/[[:space:]]/,"",h); if(h=="F") f++; if(h ~ /^X/) x++; if(h=="E") e++; if(h=="WS") ws++; if(h=="R") rr++} END {print n,f,x,e,ws,rr,f+x+e}' docs/plans/TM8-W0-CONSISTENCY-MATRICES.md
```

## 4. Canonical adversarial searches

The final pre-G0 sweep searched for:

```sh
rg -n 'thread_root_message_id|threadRoot,unordered|Review-ready design|pending Vega adoption|execution\.prompt.*user-authored' docs/plans
rg -n 'use_message_send|automated_wake_limit|session_wake_budgets|canMessage|canContactSession|canHandoffEntity' docs/plans docs/tm8-architecture/05-DECISIONS.md
rg -n 'TM8_AUTH_TOKEN|TM8_AGENT_TOKEN|message send --anchor|--reply-to' docs/plans/TM8-AGENT-HARNESS-AND-COMMAND-DISCOVERY.md
rg -n 'scope=default|direct_v1|session_chat_v1|message_batch_id|Default-channel amendment' docs/plans
rg -n -i 'now (introduces|recompute|takes|inherit)|Scratch execution has|The lease survives|markWarm fires|verified holding|correctly removes' docs/plans/WORKSPACE-LAYOUT-REVIEW.md
rg -n '^## (16|17|18|19)\. Round' docs/plans/WORKSPACE-LAYOUT-AND-TERMINOLOGY.md
```

Normative files contain no thread-root budget key, no public/user-authored prompt claim, no stale harness status, and no prohibited indicative-mechanism phrases. Historical review evidence intentionally retains the original failing literals and failure scenario. Harness `TM8_AUTH_TOKEN` appears only in S6 as a negative regression assertion; the manifest uses `TM8_AGENT_TOKEN`. The CLI `event watch --anchor` filter is unrelated to the retired message grammar.

## 5. Worker and provider audit

| Child | Task/session | Launch audit | Result |
|---|---|---|---|
| Source/matrix inventory | `task_1785035034468_oytues72q` / `sess_1785035089902_t87o41uml` | provider=openai, model=gpt-5.6-terra, reasoningEffort=xhigh, fullAccess | complete, read-only |
| Harness adversarial review | `task_1785035043837_ujbboy6c0` / `sess_1785035108286_t22oenptu` | intentional provider=claude, model=claude-sonnet-5, fullAccess | complete, read-only |
| Ledger trace audit | `task_1785035052259_fn3cp0wse` / `sess_1785035123456_egyhu2ksx` | provider=openai, model=gpt-5.6-terra, reasoningEffort=xhigh, fullAccess | complete, read-only |
| G0 gate | `task_1785036815303_y8ppsa5zj` / `sess_1785036862149_jx2k5cx86` | intentional provider=claude, model=claude-opus-5, fullAccess | **APPROVE**, read-only, zero edits/git |

Every GPT-5.6 child used OpenAI/Codex with xhigh reasoning and full access. No GPT model was launched through Claude. The G0 gate is intentionally Claude Opus 5.

## 6. Process observation

At 08:37:14 the W0-B narrative referred to an “uncommitted M in git status.” The worker and coordinator audited this immediately. W0-B ran **zero git commands**; the status/branch block was automatically pre-supplied harness context, not a Bash invocation. Disclosed commands were `wc -l`, `grep`, `sed -n`, `which maestro`, `maestro whoami`, and file reads. W0-B made no file edits and no repository mutation. The ambiguous wording is recorded here as a process deviation/observation, not a design blocker. Its temporary scratch report was not treated as authoritative; all accepted findings are synthesized into tm8-local dossier/gate evidence.

The W0 source worker row-label discrepancy is also recorded: aggregate 28 was correct, but the first detailed mapping omitted eight facade registrations. The coordinator resolved it by direct source inspection and the matrix now totals exactly 28 per row.

## 7. Final hashes and G0

Final G0-bound hashes:

```text
b852e62bf6da09aaa9adb65e21c80362082c083db77b87ea829d27f0a1e5c278  TM8-W0-AMENDMENT-DOSSIER.md
fa2c304a5ee24ee7c5d9eb47e157c38eb8d5aa6145b8a4a99046ae0a21f11c60  TM8-W0-CONSISTENCY-MATRICES.md
```

The dossier hash rotated mid-review from `a2e8c39b…` to `b852e62b…` after a pre-verdict correction made `default` API-only and kept CLI/profile scopes concrete. A clarification accompanying that rotation incorrectly said the dossier contents and hashes were unchanged; this record corrects that process statement. Opus read the original cut, re-read the 426-line current cut, mechanically diffed A01–A20, and verified that the delta was confined to §6.3 line 299 and §7 line 325, where the two scope statements were strictly narrowed to repair the already-logged CLI inconsistency. The reviewer explicitly bound APPROVE to the final hash above. No post-verdict dossier or matrix edit occurred.

**Reviewer:** `sess_1785036862149_jx2k5cx86`  
**Verdict:** **APPROVE**  
**Unresolved blockers:** **none**  
**Unresolved majors:** **none**  
**Reviewer activity:** evidence-only, read-only, zero edits, zero git  
**G0:** **RECORDED** against dossier `b852e62b…c278` and matrices `fa2c304a…1c60`

## 8. Residual implementation-preparation risks

These are explicit later gates, not W0 design defects:

- UI-specific measured responsive/reference-capture breakpoints and supported-browser shortcut receipt remain outside W0–W5; they are not W4 work;
- implementation validation of byte caps where the dossier names a prototype gate;
- the current in-memory live event publisher must be replaced/reconciled with stored per-Space replay during W2 API implementation, then independently verified through public HTTP/WS in W3 before durability is claimed;
- the current public prompt handler violates B1 until W2 implements the internal-only guard under TDD; W3 independently verifies the public Member/Teammate/act-as negatives and zero-queue/zero-byte outcomes;
- all A01–A20 operations and profile/menu/project/delivery foundations remain unimplemented: W1 owns contract/schema/migration/conformance foundations, and W2 owns catalog-group API implementation including B1/B2;
- the target CLI and harness remain unimplemented: W4 owns their implementation and integration against a real local Server, and W5 owns independent real-Server CLI-group verification plus agentic CLI discovery/use;
- W1 is paused at a safe pre-edit authority boundary for G0.1; W2–W5 remain unstarted. UI implementation and Remote Phase 2 remain excluded; after fresh G5 APPROVE the program stops and records only the W6 handoff.

### Opus non-blocking W1 packet

Opus listed documentation restatement/cross-reference minors only and expressly found that no contract ambiguity survives the authority order. W1 must read them before edits:

1. add an explicit sanitized `interaction_profile` row/cross-reference at workspace §5.7 rather than relying on generic projection fallback;
2. date/narrow or re-derive DOMAIN §9 scores after the K/L delta;
3. expand DOMAIN §7.2 proposed API-family ownership beyond `interactionProfiles.*`;
4. continue DOMAIN proposed-voice labeling at remaining project/message/profile mechanism paragraphs;
5. restate in the backend briefing that `default` is API-request-only and never pinnable;
6. reword Chat-UI C1 disposition so its three-value API request enum is not called a CLI application;
7. extend SCM B1 acceptance case 30 with bare Member and act-as principals;
8. mark matrix row 47 `messages.delete` as unbound when W1 regenerates source metadata;
9. remove the stray `read` word from matrix A16 binding metadata when W1 regenerates it;
10. de-duplicate the API guide profile table presentation and label A01–A20;
11. make workspace §7.6 explicitly say retire is the profile deletion analogue;
12. finish two residual ledger documentary-voice restatements;
13. refresh moved workspace §8.2 anchor citations.

Items 8–9 are deliberately not patched after verdict because they would rotate the approved matrix hash. W1 regeneration must correct them while producing its new source-derived hash/evidence.

## 9. Polling override

W1–W5 wave coordinators use a five-minute scheduled polling interval, propagated only through coordinator packets. Ordinary workers/reviewers retain their existing event-driven packet with scheduled polling no more frequent than once per 120 seconds. The active Opus reviewer was not reprompted. Immediate blocker/gate/completion reports remain immediate; the 10-minute program heartbeat is unchanged.

## 10. W0-E narrow G0.1 amendment and binding

W1's pre-edit authority check stopped before contract/schema/migration implementation and found two literal contradictions in the G0-bound dossier. W0-E resolved only those contradictions:

1. A20 now has exact typed storage at `spaces.default_interaction_profile_id`, an `integer` Space settings revision baseline, typed FK/index, human-owner/admin and same-Space/live/active-validation/not-retired writer checks, profile-first lock order for non-null selection, null backfill/core fallback, no-op/replay behavior, member-only projection, and forward rollback semantics. It adds no table, entity, operation, binding, or catalog row.
2. `system_delivery_adapter` may execute exactly the three named database RPCs `reserve_session_message_delivery`, `claim_session_message_delivery`, and `settle_session_message_delivery`. The single governed PTY `proc.write` effect is non-database. No fourth expiry/recovery/cleanup/notification operation is authorized or implied.

The former and candidate binding hashes are:

```text
b852e62bf6da09aaa9adb65e21c80362082c083db77b87ea829d27f0a1e5c278  TM8-W0-AMENDMENT-DOSSIER.md (former G0)
b85a18304f3769ba88da67403a7d90331a17c6355df7b451d650b49990434805  TM8-W0-AMENDMENT-DOSSIER.md (G0.1)
fa2c304a5ee24ee7c5d9eb47e157c38eb8d5aa6145b8a4a99046ae0a21f11c60  TM8-W0-CONSISTENCY-MATRICES.md (unchanged G0/G0.1)
```

The matrix is byte-identical because A20's operation name, method/path, kind, input/output names, handler binding, CLI disposition, and test ownership did not change. The source catalog remains 81 rows, the dossier/matrix additive set remains A01–A20, and the target remains 101 only after W1 implementation. The read-only package/migration tree digest before and after W0-E is `143f7b14879a29506f2390899ab72983d9139971debd674fdb86aa9754f83cc9`; W0-E made no package, migration, test, UI, Remote, or git change.

Fresh evidence-only Claude Opus 5 session `sess_1785040472762_0wsb78pdj` is the binding G0.1 adjudicator for the exact final artifact hashes attached to task `task_1785040440249_kuqduf24g`. It was staged before the final hash calculation and read no file before freeze. Its final verdict is incorporated by reference: APPROVE with zero blockers/majors records G0.1 and permits the paused W1 coordinator to resume from its preserved boundary; any other verdict leaves W1 paused. No artifact may be edited after that verdict without rotating its hash and obtaining a different fresh reviewer.
