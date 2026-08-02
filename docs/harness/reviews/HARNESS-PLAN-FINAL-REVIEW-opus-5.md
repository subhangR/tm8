# Final Adversarial Review — `HARNESS-FLAVORS-AND-ORCHESTRATION-PLAN.md`

**Reviewer:** Claude Opus 5 (`claude-opus-5`), acting as the last reviewer before this document becomes
implementation authority. Not a consumer review — an adversarial one. My brief was to find where the plan is
wrong, where it is unfalsifiable, and where it invented a number or a mechanism and then reasoned from it as
if established.

**Date:** 2026-07-26
**Documents read, in order:** `AGENT-JOURNEY-WALKTHROUGH.md` → `reviews/HARNESS-REVIEW-sonnet-5.md` →
`reviews/HARNESS-REVIEW-haiku-4.5.md` → `HARNESS-FLAVORS-AND-ORCHESTRATION-PLAN.md`.
**Ground truth verified against source**, not against docs: `packages/contract/src/{catalog,contract,schemas}.ts`,
`packages/server/src/facade/services/w2/saved-views-actions.ts`, `packages/prompt/src/index.ts`,
`packages/cli/src/`, `packages/execution/src/spawn/`, `db/migrations/`.

---

## VERDICT: APPROVE-WITH-CHANGES

The plan's **reasoning spine is sound and better than what it replaces.** Four moves are correct and should
proceed: kernel v2's one-job-per-sentence discipline (§7), actions-first sequencing (§8), shard metadata as
tool description (§9), and the invariant floor (§6). The measurement regime (§11) is the best part of the
document — it is the only section that could falsify the rest of it, and it exists.

The plan is also, in three places, **better than its own reviewers**: it correctly refuses to dilute the trust
boundary for a leaner tier, it correctly refuses Haiku's `firstNoun` hint (`actions[]` really is the
authoritative version of that idea), and it correctly identifies that a self-reported skip rate is not fixable
by rewording.

What blocks implementation is narrower than the plan's scope and, usefully, is confined to the two flavors the
rollout already sequences last:

- **Flavor C cannot fit the 32 KiB combined-initial cap it is required to obey.** Arithmetic, self-contained.
- **`actions[]` as actually implemented is structural availability, not authorization** — and Flavor C's kernel
  text tells the agent that absence means denial. That converts a UI-palette affordance list into a permission
  claim, which is the exact inversion invariant-floor #4 exists to prevent.
- **Flavor C's prefetch predicate is not evaluable** — it keys on two fields that do not exist, and for the
  primary entity kind (`task`) its "exactly one" condition can never be satisfied.
- **F7's guard is self-contradictory**, not merely insufficient: §5.3 *does* choose an operation.

Rollout steps 1–3 may proceed with the §7 arithmetic corrected (Major-1). Steps 4–6 are blocked on B1–B4.

**Findings: 4 BLOCKER, 8 MAJOR, 6 MINOR.** Ranked within class. Every blocker and major carries a concrete
alternative.

---

## Part I — Ground truth: what I verified, and what it changes

I checked the plan's claims about the contract before attacking its arguments, because several findings below
depend on the delta between what the plan assumes and what the working tree contains. Three of these
corrections are load-bearing.

### GT-1. The catalog has 101 operations, not 81 — and the amendments the walkthrough lists as unshipped have partly landed

`packages/contract/src/catalog.ts` contains **101** operation bindings. The uncommitted diff adds 20,
including exactly the ones the walkthrough §12 lists as pending amendments: `entities.context`,
`entities.feed`, `handoffs.{send,list,withdraw}`, `messages.delivery.get`, `messages.attachments.*`, and the
full `interactionProfiles.{propose,updateDraft,validate,preview,activate,retire}` family plus
`{teamMembers,spaces}.interactionProfile.setDefault`.

So walkthrough amendment #15 ("Interaction Profile operations are outside the frozen 81") is **already
resolved in the working tree**, and amendment #6 ("no shared catalog operation backs `entity context`") is
**also resolved** — `EntityContextView` exists in `contract.ts:1186` with `actions: PaletteAction[]`, and
`entities.context` is served at `saved-views-actions.ts:202`.

This is good news for the plan's §8 — its central factual premise ("`entity context` already returns
`actions[]`") is **true**, which I want to record plainly because I attack what that premise supports, not the
premise itself. But it also means the plan's repeated "81 operations" (§6 floor item 3, §5.1 by inheritance,
§11 gate) is stale, and the "frozen 81" framing is now false. See Major-6.

### GT-2. `actions.list` computes *structural availability*, not authorization

This is the single most consequential thing I found, and it is not visible from any of the four documents.

`saved-views-actions.ts:260-279` — `isAvailable()`:

```ts
if (params.length === 0) return true;           // every parameter-free op, unconditionally
if (!row) return false;
if (params.every((p) => p === 'spaceId')) {
  return !ADMIN_SPACE_OPERATIONS.has(operation) || row.is_space_admin;
}
return structurallyAvailable(operation, row);   // kind / deleted_at / work_status / is_space_admin
```

`structurallyAvailable()` (lines 193–258) branches on **entity kind, soft-delete state, `work_status`, and a
space-admin boolean.** It does not invoke the per-operation capability check. It is an affordance filter — it
answers "is this operation *shaped* for this entity?", not "may this actor do it?"

The supporting evidence that this is a UI palette DTO being repurposed:

- The type is `PaletteAction` (`contract.ts:762`), documented as *"palette action descriptors."*
- `kind: 'navigate' | 'create' | 'link' | 'pull' | 'status' | string` — `navigate` is a UI concept with no
  meaning to a headless agent.
- `label: operation.replaceAll('.', ' ')` (line 362) — labels are mechanically derived, so the "label" for
  completing a task is the string `entities commands complete`.
- `helpRef: \`tm8://help/operation/${operation}\`` (line 369) — a synthesized string in a namespace that has
  no resolver anywhere in the tree.
- There is **no `allowed` field**, no `deniedReason`, no `sideEffect`, no `idempotency`.

I counted what a non-admin actor actually receives for one `task`: **20** parameter-free operations
(unconditional `true`, including `execution.spawn`, `spaces.create`, `entities.create`, `messages.post`,
`commands.undo`, `projects.create`), **13** of the 22 `spaceId`-only operations, and **18** task-specific
structural ones — approximately **51 entries**, of which exactly five are task-lifecycle mutations.

Consequences appear in Blocker-2 and Blocker-3.

### GT-3. `capabilityEpoch` is a hash of the answer, not a policy epoch

`saved-views-actions.ts:307-325` computes it as
`sha256({actorId, target:{id,spaceId,kind,version,admin,status}, operations})`.

The epoch is a fingerprint of the response. It changes when — and only when — the answer has already changed.
It therefore **cannot signal staleness in advance**, which is the job the walkthrough's cache table assigns it
("Invalidated by … epoch change") and the job the plan's defense of the 30 s TTL assumes ("a bound on
staleness between capability epochs"). See Major-8.

### GT-4. Claims about `packages/prompt` and the spawn manifest: confirmed, verbatim

`packages/prompt/src/index.ts` (400 lines) advertises `tm8 whoami`, `tm8 task report progress|complete|blocked`,
`tm8 session report *` — all explicitly rejected — and at line 163 literally tells coordinators *"CLI does not
yet carry spawn or session-prompt verbs, so you cannot delegate."* `packages/execution/src/spawn/manifest.ts`
emits `manifestVersion: '1'` carrying persona, memory, skills, and directive. `packages/cli/src/commands/`
contains exactly four commands: `whoami`, `task-report`, `session-report`, `worker-init`.

Both the walkthrough and the plan are accurate here. But note the scope this implies for the plan's §13
rollout: **there is no `tm8 help`, no `tm8 entity`, no `tm8 action`, no `tm8 message`, and no semantic index
anywhere in the tree.** See Minor-2.

### GT-5. The plan's kernel byte measurement reproduces

I rendered the §7 spine with realistic ULID-length launch facts and an absolute manifest path:

| | Plan claims | I measure | Delta |
|---|---:|---:|---:|
| Flavor A rendered | 3,112 | **3,179** | +67 |
| Flavor C rendered | 3,222 | **3,293** | +71 |
| % of 6,144 cap (A) | ~52% | **51.7%** | — |

Within 2%, fully explained by ULID and path length choices. **The plan's measurement is honest and
reproducible.** I say so explicitly because I attack the *inference* drawn from it (Major-1, §F below), and the
measurement itself deserves credit.

---

## Part II — BLOCKERS

### BLOCKER-1 — Flavor C exceeds the 32 KiB combined-initial cap. Its own CI gate would fail it.

Pure arithmetic, internal to the plan.

The walkthrough §8.1 sets **Combined initial injected material = 32 KiB hard**. The plan's §6 floor item 1
keeps hard byte caps "at every layer, no exceptions," and §11's CI gate says *"combined initial ≤32 KiB — per
flavor, fail on regression."* F3 gives the two new injection kinds *"the byte caps of the commands they wrap"* —
16 KiB for `tm8.assignment-snapshot` (entity context, capped to the 16 KiB initial-snapshot budget) and 16 KiB
for `tm8.prefetched-shard` (command shard cap).

Flavor C turn 1:

| Material | At caps | Realistic |
|---|---:|---:|
| manifest | 4,096 | 4,096 |
| kernel v2-railed | 6,144 | 3,293 |
| `tm8.worker-bootstrap` | ~700 | ~700 |
| `tm8.assignment-snapshot` | 16,384 | 16,384 |
| `tm8.prefetched-shard` | 16,384 | 16,384 |
| **total** | **43,708** | **40,857** |

**Flavor C is over its own hard cap by ~8.5 KiB realistically and ~11.5 KiB at caps.** Flavor B lands at
~24.4 KiB and is fine.

This also falsifies §4's summary sentence: *"Byte cost across the three flavors is nearly flat — the deltas are
hundreds of bytes of kernel and one-to-two pre-injected shards."* Those two clauses contradict each other. A
shard is 16 KiB; "one-to-two pre-injected shards" is a 16–32 KiB delta against a 32 KiB budget — a 100–300%
increase in initial payload, not "nearly flat." Flavor A's turn 1 is ~8 KiB; Flavor C's is ~41 KiB.

**In fairness to the plan:** measured *cumulatively to first mutation*, the flavors really are close — A pays
4 + 3.2 + 32 (default `entity context`) + 16 (shard) ≈ 55 KiB, while B and C pay ≈ 40 KiB. The plan's
intuition is defensible on cumulative bytes. It is the **initial** cap that breaks, and that is the one the
invariant floor and CI gate name.

**What I would do instead.** Do not raise the cap — it is an invariant-floor item and raising it to accommodate
a convenience feature is exactly the trade the floor exists to refuse. Instead ship a **shard digest** rather
than a shard:

> `tm8.prefetched-shard` carries only the decision fields — `syntax`, `sideEffect`, `idempotency`,
> `versioning`, `requiresFreshActions`, `notSatisfiedBy[]`, `siblingVerbs[]`, `onVersionConflict`,
> `onTransportTimeout`, plus `helpRef` for the full shard. **Cap: 2 KiB. No examples, no `errorRefs`, no
> `trustNotes`, no schema bodies.**

That is the part of the shard the agent uses to construct one mutation; the remaining 14 KiB is reference
material it can fetch on the exception path. Flavor C then lands at ~26.5 KiB realistic / ~29.3 KiB at caps —
inside the cap with genuine headroom, and the "nearly flat" claim becomes *true* rather than aspirational.
Secondary benefit: a 2 KiB digest is far less likely than a 16 KiB document to read as a directive
(Blocker-4, §C).

---

### BLOCKER-2 — Flavor C's `ACTIONS_CLAUSE` tells the agent that a structural affordance list is an authorization boundary

The Flavor C slot text (§7 per-flavor table):

> *"Allowed actions are refreshed for you before each mutation and appear as trusted control. **If an action you
> intended is absent, it is currently denied — do not attempt it.**"*

And §5.3: *"The agent physically cannot reach a `FORBIDDEN` it should have predicted."*

Against GT-2, both sentences are false, and the first is *harmfully* false in three independent directions:

1. **Present ≠ allowed.** `actions[]` passes structural availability only. An agent obeying this clause will
   attempt operations the server then refuses. Flavor C's headline guarantee — the thing that justifies its
   complexity as "the direct architectural answer to Haiku's 30–40% skip rate" — does not hold. It removes the
   *check* while leaving the *failure*, which is strictly worse than Flavor A: the agent has been told it may
   stop reasoning about permission, and it still gets `FORBIDDEN`.

2. **Absent ≠ denied.** Sixteen entity-targeted operations return `false` from `structurallyAvailable`'s
   `default:` arm (line 255) merely because they are unenumerated. An agent instructed "absent means denied, do
   not attempt it" will refuse operations it is fully authorized to perform, and — worse — will report to its
   coordinator that it is *blocked on authority* when it is not. That is a false blocker propagating up an
   orchestration tree, and §10 explicitly tells the coordinator to read `BLOCKED` as evidence of flavor
   mis-selection, so the misdiagnosis compounds.

3. **This is invariant-floor #4 violated by prompt text.** Floor #4: *"No flavor's prompt, prefetch, template,
   or binding grants an operation."* The clause does not grant an operation in the server's ledger, but it
   installs in the agent a belief that presence in a harness-supplied list *is* the permission answer. Floor
   #4's purpose is to keep the permission answer in one place. This moves it. The plan asks (correctly, at
   §12) that F7 be "guarded hardest" against becoming a shadow authority; this clause makes the *kernel* the
   shadow authority, without touching F7.

I will also answer the question behind claim B directly, since it bears on the same clause. **`actions[]`
solves neither intent selection nor permission.** It does not solve permission, per the above. It does not
solve intent selection either: for one task the agent receives ~51 entries whose labels are
`operation.replaceAll('.', ' ')`, of which ~20 are parameter-free globals with no relationship to the task —
including `execution.spawn`, `spaces.create`, and `commands.undo`. §8's claim that "the entity told it which
commands apply" is not what the implementation does; the entity told it which operations are *shaped* for its
kind, plus every global.

So the answer to "if `actions[]` lists 12 allowed actions, has the agent been helped or handed a different
guessing problem?" is: **it lists ~51, and it is a different and worse guessing problem** — worse because
`help --query "mark my task as being worked on"` returns ≤5 *intent-ranked* candidates while `actions[]`
returns ~51 *unranked* ones. Actions-first, as a sequencing change, is still right — it removes the
starting-noun guess and it hands over version and target. But its ranking claim is inverted: `help --query` is
the better intent selector and should not be demoted to "fallback" on the strength of an argument that the
implementation contradicts.

**What I would do instead.** Three changes, in dependency order:

1. **Do not ship the Flavor C `ACTIONS_CLAUSE` as written.** Until `actions[]` carries a real authorization
   verdict, no kernel in any flavor may state or imply that presence/absence answers permission. Replace with:
   *"Allowed actions are refreshed for you before each mutation and appear as trusted control. The list is
   scoped to this entity but is not the final permission answer — the server re-checks on invocation. If the
   action you need is not listed, discover it normally rather than assuming it is denied."* This is longer and
   weaker, and that is correct: the strong version is a lie.

2. **Add `allowed: boolean` + `deniedReason?: string` to `PaletteAction`, computed from the same capability
   path the mutation handler uses** — not from a kind table. Make this a hard precondition of documenting
   actions-first as the default journey (§8's "Recommendation"), and of Flavors B and C. This is a new
   amendment; call it **F12**. It is larger than F4 and it is the real cost of §8.

3. **Split the list.** Add `scope=target` to `entities.context`'s actions section so parameter-free globals are
   excluded, and separate `lifecycleActions[]` (`sideEffect: durable`, target-scoped) from `readActions[]`.
   Without this, "the agent never has to guess" is false regardless of how good the `allowed` flag becomes:
   ~46 of the 51 entries are noise at the moment of intent selection. Call it **F13**.

Recommend also that §8 be reworded to claim what it can support: actions-first eliminates the *starting-noun*
guess and supplies target version and command refs. It does **not** eliminate intent selection, and
`help --query` should remain a co-equal route, not a fallback.

---

### BLOCKER-3 — Flavor C's prefetch selection rule is not evaluable, and for `task` it can never fire

§5.3's rule:

> *"If `actions[]` contains exactly one `allowed: true` action whose `sideEffect` is `durable` and whose
> operation matches the task's current lifecycle position, prefetch that action's shard. Otherwise prefetch
> nothing and log the miss."*

The plan then says: *"That is a real prediction with a real hit rate, not a static bundle — which is what makes
it measurable (§11, E4)."* It is not measurable, for four independent reasons:

1. **`allowed` does not exist** on `PaletteAction` (GT-2). Under F12 above it could.
2. **`sideEffect` does not exist** anywhere in the contract. I grepped `packages/contract/src/` for
   `sideEffect`, `idempotency`, `intentTags`, and `OperationDiscovery`: **zero hits.** It is specified only in
   the walkthrough's §7.3 shard sketch. It would arrive with F5.
3. **"Exactly one" is never satisfied for a task.** `structurallyAvailable` returns `true` for *both*
   `entities.commands.work` (line 220, any live task) and `entities.commands.complete` (line 218, any live task
   with `work_status !== 'done'`) simultaneously, plus `entities.patch`, `entities.commands.linkPr`, and
   `entities.commands.linkCommit`. That is five candidate durable operations on a normal in-progress task. For
   the primary entity kind of the primary use case, the predicate's antecedent is **always false** — hit rate
   ≈ 0, and E4 would measure that and conclude Flavor C is not worth its complexity, correctly but for the
   wrong reason.
4. **The disambiguating clause is undefined and carries the entire rule.** "whose operation matches the task's
   current lifecycle position" is the only clause that could resolve (3), and it names no mapping, no source of
   truth, and no representation. It is doing all the work and it is not specified. This is the clearest
   instance in the plan of the pattern I was asked to look for: a mechanism invented in a subordinate clause
   and then reasoned from as established ("a real prediction with a real hit rate").

**Dependency error, separately.** §12's table lists F7 as blocking C and F5 as blocking only "§9." But the rule
above reads `sideEffect`, which arrives with F5, and §13 sequences shard metadata (step 3) before Flavor C
(step 5) — so the *order* is accidentally right while the *stated dependency* is wrong. That matters because
F5 is the amendment most likely to be descoped (it is eight new generated fields plus a build gate), and
nothing in §12 records that descoping it kills Flavor C.

**What I would do instead.**

- Replace the prose rule with a **declared, contract-generated transition table**:
  `(entityKind, workStatus) → nextLikelyOperation | none`, e.g. `(task, pending) → entities.commands.work`;
  `(task, working) → none` (genuinely ambiguous: complete, patch, or link); `(task, in_review) → entities.commands.complete`.
  Generated from the same `OperationDiscovery` metadata as F5 so the build gate covers it, versioned, and with
  an explicit `none` outcome that is a *first-class result*, not a miss.
- **Require the table to emit `none` for more than half the states.** If it does not, it is guessing. A
  prediction that always fires is a static bundle wearing a rule's clothes — which is precisely the thing §4
  rejects Haiku's tier for being.
- **Add F5 to Flavor C's blockers in §12**, and add the transition table as **F14**.
- **Log the selection rule ID and its inputs in the injection envelope** (see Blocker-4), so E4 can attribute
  a miss to the rule rather than to the flavor.

---

### BLOCKER-4 — Prefetch selection *is* an operation choice. F7's guard is self-contradictory, not merely insufficient.

Answering claim C head-on.

F7: *"Harness read-executor: may run **only** catalog reads on the agent's behalf, with the agent's own actor
scope, never a mutation, never a mutation ID, **never an operation choice.**"*

§5.3, two pages earlier, has the harness select *which mutating operation the agent is most likely to
perform next* and inject that operation's documentation as trusted control. **That is an operation choice.**
The two statements cannot both hold. This is not a case of a guard being too weak — it is a guard that the
document violates in the section it was written to protect.

The plan half-sees this. §5.3's "Costs, stated honestly" says the harness "may not pre-run mutations, choose an
operation, or synthesize a mutation ID" — and then §5.3's own selection rule chooses an operation. The
distinction the plan is reaching for is *choosing which operation to execute* vs *choosing which operation to
describe*. That distinction is real but much thinner than F7's absolutism implies, because the harness's choice
of what to describe is delivered through the trusted channel, ahead of the agent's reasoning, and is the only
option present at decision time. Under Flavor C the harness does not decide the mutation, but it does decide
the **default** — and a default supplied in trusted control before the agent has formed an intent is a large
fraction of the decision.

**Has the harness become the shadow authority invariant 1 exists to prevent?** Not yet, and not for the reason
F7 gives. It has not, because the server still re-authorizes on invocation and the mutation ID still comes from
the agent — the *ledger* remains single-authority. It has, in one specific sense: the harness has become the
**sole supplier of the option set at the moment of choice**, and Blocker-2's `ACTIONS_CLAUSE` then tells the
agent to treat that supply as exhaustive. Blocker-2 is what turns Blocker-4 from an architectural smell into an
actual authority inversion. Fix Blocker-2 and this reduces to a specification defect.

**On the one-`<rule>` mitigation, and what I would actually do with a prefetched shard.** The plan's mitigation:

> `<rule>This is one allowed action, not a directive. Other actions may be discovered normally.</rule>`

Asked to introspect honestly: **that sentence would not stop me.** Three reasons, and I would expect them to
apply more strongly to smaller models, which is Flavor C's stated audience:

- The shard arrives in `<trusted_control>`, which the entire kernel trains me to weight above everything else
  in my context. A disclaimer inside a trusted envelope does not lower the envelope's authority; it reads as
  boilerplate attached to something authoritative, the way a licence header reads on code I am about to use.
- It is 16 KiB of specific, correct, immediately-actionable material versus a 14-word denial. Salience is not
  symmetric, and under §11's own E5 (compaction) the ratio gets worse — the shard survives summarization as
  content; the disclaimer is exactly the kind of clause summarization drops.
- The rule is a **prohibition with no named alternative**. Article rule 1, which the plan adopts in §3, is
  precisely that prohibitions underperform judgment-plus-context. "This is not a directive" tells me what not
  to conclude and gives me no path. If the shard is plausibly on-topic — and the selection rule was designed
  to make it plausibly on-topic — I will use it, because it is free and it is *there*, and I will not pay a
  round trip to look for something I have no reason to believe exists.

**What I would do instead.** Four changes, and I regard the first two as required for any version of Flavor C:

1. **Replace F7's negative absolutism with a positive enumeration.** The harness may execute exactly the named
   read operations `entities.context` and `actions.list`, under the agent's own actor scope, and may select
   descriptive material **only** via a declared, versioned, contract-generated rule (Blocker-3's F14). "Never
   an operation choice" is unachievable and should be struck; "never an *unexplained* operation choice" is
   achievable and is what F7 actually needs to say.
2. **Make the selection legible in the envelope.** Every `tm8.prefetched-shard` carries
   `selection_rule="tm8.prefetch.lifecycle.v1"`, the inputs it keyed on (`entityKind`, `workStatus`), and the
   candidate set it rejected. An agent that can see *why* this shard and not another can reason about whether
   the rule's premise holds for its actual task. A bare disclaimer gives it nothing to reason with; a rule and
   its inputs give it a falsifiable claim. This is the plan's own article-rule-2 move — make the interface
   expressive instead of adding a prohibition — applied to the hazard the plan calls dominant.
3. **State the fallback path positively, in the kernel, not just the envelope** (see §F below): *"If the
   included shard is not the command you need, run `tm8 action list --for <id>` then
   `tm8 help <noun> <verb>`."* ~140 bytes. A named alternative is what turns "not a directive" from an
   assertion into an available action.
4. **Ship the 2 KiB digest, not the 16 KiB shard** (Blocker-1). Independently motivated, and it directly
   reduces the salience asymmetry that makes the disclaimer ineffective.

---

## Part III — MAJOR findings

### MAJOR-1 — §7's "Net: smaller than v1" is false. Kernel v2 is 20–24% *larger*.

I rendered both kernels with identical launch-fact values:

| Kernel | Rendered bytes |
|---|---:|
| v1 (walkthrough §3.3) | **2,657** |
| v2 Flavor A | **3,179** (+522, **+19.6%**) |
| v2 Flavor C | **3,293** (+636, **+23.9%**) |

§7's closing line — *"Net: smaller than v1, and it closes five of the seven convergent findings"* — is wrong on
its first clause. The second clause is right, and is the real achievement.

The plan's own accounting also understates: *"What was added, at a cost of roughly 400 bytes."* The cuts total
~595 bytes (Interaction-Profile sentence ~220, Phase-1 paragraph ~330, the dropped
`interactionProfile=…@version` launch fact ~45). Net +522 therefore means additions of **~1,117 bytes** — about
2.8× the stated figure.

This does not change any conclusion: 3,179 bytes is 51.7% of the cap, and the plan's own headroom argument (§7,
and my §F below) says bytes are not the binding constraint. That is exactly why the misstatement matters — the
claim was **unnecessary**. "Smaller and safer" is a rhetorically attractive pairing that the plan reaches for
and has not earned, in a document whose central discipline is refusing unearned claims. §9's corollary states
the honest version: the kernel gets smaller *later*, once shard metadata lets general rules be deleted.

**What I would do instead.** Replace the line with: *"Net: +522 bytes (3,179 rendered, 52% of cap), and it
closes five of the seven convergent findings. The kernel gets smaller only after §9's shard metadata ships and
the corresponding general rules can be deleted — that reduction is a step-3 outcome, not a step-1 one."* Add
the rendered-byte figures per flavor to §11's CI gate as recorded baselines so the number cannot drift
un-noticed.

### MAJOR-2 — Actions-first is presented as byte-free; the plan's own table shows +8 KiB

§1: *"the common path collapses from four discovery calls to **two** — **with no added bytes**, and no guessing
the starting noun."* §8's table, twenty lines later:

```
BEFORE  = 4 calls, ~40 KiB          AFTER = 2 calls, ~48 KiB, zero guessing
```

+8 KiB, by the plan's own arithmetic, in the section the summary is summarizing. §8 then repeats the claim:
*"This requires no new operation and no new bytes."*

The trade is probably still worth taking — 8 KiB against two round trips and the removal of the
starting-noun guess is a reasonable price. But E6's stated metric is *"discovery calls **and bytes** to first
mutation"*, so E6 as specified would record a **regression** on one of its two axes while the plan predicts a
clean win. An eval that the plan's own summary has pre-committed to misreading is worse than no eval.

**What I would do instead.** State it as a trade in both places: "two calls instead of four, at +8 KiB." Split
E6 into E6a (calls, predicted 4→2) and E6b (bytes, predicted +8 KiB, accepted). Then record the reason the
trade is good — fewer decision points, not fewer bytes — which is the plan's actual thesis and is stronger for
being stated in its own terms rather than borrowed from the byte argument.

### MAJOR-3 — The tier reframe is a genuine insight, but it is used to avoid the byte arithmetic rather than to answer it, and its evidence base is two self-reports

Answering claim A.

**The reframe is real.** "Tiers vary by who makes the discovery call, not by how many bytes the agent is
handed" is a better axis than bytes, for a reason neither consumer review states and the plan does not either:
the failure modes the reviews actually predicted — cross-verb schema generalization, skipping `action list`,
first-call guessing — are **sequencing and decision-point failures, and none of them is fixed by handing over
more bytes.** Sonnet's #1 failure mode would get *worse* under a larger bootstrap: more fetched siblings means
more surfaces to generalize from. That argument is available to the plan and it does not make it; it is the
strongest defense of the reframe and it should be in §1.

**But the reframe is then deployed as an excuse.** Having established that the axis is not bytes, the plan
stops doing byte arithmetic — and that is exactly where Blocker-1 lives. "Byte cost across the three flavors is
nearly flat" is asserted, not computed, and it is false for initial injection by a factor of five. The reframe
did not license skipping the arithmetic; it only licensed not *organizing the tiers around* the arithmetic.

**And the evidence base is weak in the way the brief suspected.** Both consumer reviews are self-reports about
model behavior. The plan treats their convergence as strong evidence (§2: *"Where they agree, treat it as
signal"*) — but on preloading they converge on a claim about *their own counterfactual token economics*, which
is the category of self-report models are worst at. Haiku's argument is the weaker of the two and the plan
leans on it: *"the time is dominated by the actual work, not the CLI calls."* That is an argument against
Flavor C's latency rationale as much as against preloading, and the plan cites it for one and ignores it for
the other. Haiku also *proposed* the preload tier before arguing against it, which the plan reports (§4) as if
self-reversal strengthened the rejection. It does the opposite: it shows the reviewer was uncertain.

**Would a straightforwardly larger bootstrap in fact beat all three flavors?** I do not believe so, and my
reason is not the reviewers' — it is Blocker-1's arithmetic turned around. Flavor C already ships ~41 KiB of
initial material, of which 16 KiB is one predicted shard. A "straightforwardly larger bootstrap" carrying the
five task-lifecycle shard digests (~2 KiB each ≈ 10 KiB) would be **smaller than Flavor C**, need no prediction
rule, need no read-executor, need no F7, and have a 100% hit rate on the operations it covers. That is a
serious competitor to Flavor C specifically — and the plan never considers it, because §4's "why not a fourth
flavor" only considers the *16 KiB top-10 full-schema* version that both reviewers rejected. The plan
demolished the weak form of the preload argument and treated the strong form as covered.

**What I would do instead.** Add a fourth measured arm, not a fourth shipped flavor:

> **A+ (static digest bootstrap):** Flavor A's kernel and manifest plus the ~10 KiB of lifecycle shard digests
> for the target entity's kind. No prefetched assignment, no read-executor, no prediction rule.

Then E4 becomes a three-way comparison — C (predicted shard) vs A+ (static digests) vs B (no shard) — and the
question "does prediction earn its complexity?" gets an answer against the right control. My prediction on
record: **A+ beats C on every axis except assignment-sync round trips, and B+digests beats both.** If that is
right, F7, F14, and the whole read-executor can be dropped, which is a large simplification the plan currently
has no way to discover. This is cheap: A+ is a fixture, not a mechanism.

Also: soften §2's framing. Convergence between two self-reports is weak evidence for a claim about
counterfactual token economics and strong evidence for a claim about what confused them while reading. Use it
for the second (which is where findings 1–6 come from, and they are good) and not the first.

### MAJOR-4 — Multi-agent orchestration: four gaps, none covered by any of the three documents

Answering claim E. The plan inherits the single-worker frame and §10 is about *choosing* a flavor, not about
running many agents. Verified against source:

**(a) No single-writer discipline on tasks. Any reader can complete another agent's task.**
`db/migrations/001_core_graph.sql:735` enforces a single writer for `work_session.status` — the execution
transition function. **Nothing equivalent exists for `task.work_status`.** And `structurallyAvailable` returns
`true` for `entities.commands.complete` on *any* live non-done task (line 218) — no assignee check. The
`assigned_to` edge type exists (`001_core_graph.sql:902`) and is not consulted. So worker B, spawned on a
sibling task, sees `entities.commands.complete` in its `actions[]` for worker A's task and may invoke it.
`expectedVersion` protects the **row** against lost updates; it does not protect the **intent** against a
different agent's. Walkthrough amendment #11 names the generic-patch half of this and misses the
`commands.complete` half.

**(b) `coordinated_by` / `spawned_by` do not exist.** I grepped `packages/` and `db/`: the edge types present
are `in_project`, `participates_in`, `authored_from`, `shared_into`, `defaults_to_profile`. So
`coordinatorSession={{coordinatorSessionIdOrNone}}` in kernel v2's launch facts is a **prompt-only assertion of
a relationship** — precisely what walkthrough amendment #10 exists to forbid ("must be backed by a real
relationship, **not prompt text**"). The plan carries the launch fact forward into kernel v2 and does not carry
amendment #10 forward into §12. Its §10 coordinator model then assumes the relation is queryable.

**(c) Flavor mismatch is invisible across the coordinator/child boundary.** A Flavor C child operating under
the Blocker-2 clause believes absent ⇒ denied. When it reports `BLOCKED`, the blocker message carries no
profile key and no pin hash — `PostMessageInput` has no such field, and §7.2/§7.4's envelopes do not add one.
So a Flavor A coordinator reading "blocked: not authorized to transition tsk_X" cannot distinguish a real
authority block from a flavor artifact. §10 makes this worse by instructing the coordinator to read `BLOCKED`
as evidence of flavor mis-selection — a correct instruction with no data to act on.

**(d) A stuck child is indistinguishable from a thinking child, and nudging it is rate-limited to four.**
`WorkSessionStatus` is `spawning | running | idle | exited | failed` (`contract.ts:792`). There is no
heartbeat, no last-progress timestamp, no "waiting on input" state visible to the coordinator — `idle` covers
both "finished its turn" and "hung." Invariant 8 forbids addressing the terminal. The coordinator's only probe
is `message send --notify-source live`, which reserves against the pair wake budget capped at
`consecutive_agent_wakes between 0 and 4`. So: four nudges, then `failed_permanent` /
`automated_wake_limit`, then the inbox — i.e. **escalation to a human.** That is arguably the correct design,
and it is stated nowhere; a coordinator will read four failed deliveries as "child crashed" (Haiku predicted
exactly this at its §6.3) and may re-spawn duplicate work on the same task, which (a) then permits.

**What I would do instead**, cheapest first:

1. **Add `profileKey` + `pinRevision` to the server-owned provenance of every message** authored by a work
   session (the `authored_from` edge already exists; this is a projection, not a new relationship). Fixes (c)
   for ~40 bytes per message and makes the §10 escalation instruction actionable. Call it **F15**.
2. **State the stuck-child protocol explicitly in §10** and give the coordinator a rule with a number it can
   act on: `idle` + no `message.created`/`task.updated` event for the child's task for N minutes ⇒ the
   coordinator's obligation is **one** live nudge, then inbox escalation to the spawning Member — *not* three
   more nudges and not a re-spawn. Add `nextAction` to the `automated_wake_limit` envelope naming human
   escalation, extending F8 to the coordinator-facing case (F8 currently only names the inbox fallback).
3. **Decide (a) explicitly, in writing.** Either add an assignee precondition to `entities.commands.complete`
   and `entities.commands.work` (`structurallyAvailable` already reads `work_status`; reading an `assigned_to`
   edge is the same shape of query), **or** state plainly that concurrent workers on one task are out of scope
   in Phase 1 and that a coordinator must not spawn two children against one task. Silence here is the worst
   option, because Flavor C actively surfaces `entities.commands.complete` in every child's `actions[]` and
   Blocker-2's clause tells them it means they may.
4. **Carry walkthrough amendment #10 into §12** as a blocker of the §10 coordinator model, or remove
   `coordinatorSession` from kernel v2's launch facts until the edge exists. A launch fact asserting an
   unbacked relationship is the same category error the kernel's own second paragraph forbids.

### MAJOR-5 — `providerToolRegistrationAllowlist` is typed `OperationName[]`. F11's rename premise is contradicted by source.

`contract.ts:1215`: `providerToolRegistrationAllowlist?: OperationName[]` — **tm8 catalog operation names.**

Haiku's flag was *"tm8 is itself the provider tool… the answer (narrow provider-native tool registration only)
doesn't make sense."* The plan's F11 accepts the premise Haiku doubted and proposes a rename: *"Its real
purpose is narrowing provider-native tool registration (e.g. restricting Claude's own Bash/Write) — not tm8
operations. If that is the intent, rename to `providerNativeToolAllowlist`."*

**The source says the opposite.** The type is `OperationName[]`, so the field narrows *which tm8 operations get
registered as provider-native tools* — Haiku's reading of the architecture was right and the walkthrough's
gloss (which the plan inherited) was wrong. Renaming it to `providerNativeToolAllowlist` while it remains
`OperationName[]` would make the name assert something the type refutes, which is worse than the current
misleading name because it would look settled.

**What I would do instead.** Drop it in Phase 1. Nothing in `packages/server` or `packages/execution` reads it,
Phase 1 registers no provider-native tools (the walkthrough §11 is explicit that Claude launches as top-level
interactive `claude` with the full CLI, not with registered tools), and an unread policy field on a
hash-pinned closed structure is pure migration liability. If it must stay, keep the current name — it is
accurate to the type — and document it in one line as *"narrows which tm8 operations are registered as
provider-native tools; cannot make an operation exist or become allowed."* Either way, **strike F11's premise**;
it reasons from a claim the type contradicts.

### MAJOR-6 — "81 operations" is stale; the number is a moving target and should not be written down

The plan inherits "81 operations" into §6 floor item 3 (*"for all 81 operations"*), and §11's CI gate. The
working tree has **101** (GT-1). The walkthrough's own rule already anticipated this: *"Any amendment that
adds/removes operations changes the catalog digest and requires re-running the reachability gate."* Twenty
operations were added and there is no reachability gate yet to re-run.

A count in an invariant is a maintenance trap. Worse, it invites the reader to believe a gate exists that has
been run against a number, when neither the gate nor the number is current.

**What I would do instead.** Replace every occurrence of "81 operations" with *"every operation in
`catalog.ts` at the current catalog digest"*, and make §11's gate assert the set equality the walkthrough §19
already specifies (catalog names == CLI projection keys == exact-help keys == semantic-index keys == coverage
fixture keys) with **no count anywhere**. Add one CI assertion that the count *changed* since the last
recorded digest ⇒ the gate must re-run — which is the actual invariant.

### MAJOR-7 — The ~60% prefetch threshold is invented, and it is set against the wrong quantity

Answering the first half of claim D.

§11 E4: *"Below ~60% hit, Flavor C is not worth its complexity."* §13 step 5: ship C only if *"E4 shows
prefetch hits above ~60%."* No derivation appears.

I tried to derive it. On **bytes**, a hit saves one ≤16 KiB shard fetch and a miss wastes one ≤16 KiB
injection, so byte break-even is **50%**, not 60. On **latency**, Haiku's own argument — which the plan cites
approvingly in §1 — is that wall-clock is dominated by real work, so latency cannot move the threshold much
either. So on both quantities the plan could price, ~60% is roughly the right order and slightly conservative.

The problem is that **the threshold is set against the wrong quantity.** The plan itself names Flavor C's
dominant cost, and it is not bytes: *"a prefetched shard reads as an instruction. **This is Flavor C's dominant
hazard.**"* A 60% hit rate means **40% of Flavor C turns open with a wrong operation's documentation presented
in trusted control**, guarded by one 14-word disclaimer that Blocker-4 argues will not hold. If the dominant
cost of a miss is a wrong *durable mutation*, then a 40% miss rate is not a marginal efficiency question — and
no hit-rate threshold, however derived, is the right gate.

**What I would do instead.** Make the E4 gate two-part, and make the second part dominant:

> Ship Flavor C only if (i) hit rate exceeds the **byte break-even of 50%**, *and* (ii) the measured rate of
> **wrong durable mutation following a prefetch miss is zero** across the E8 red-team suite plus the E4 miss
> population. State the 50% derivation inline (one shard saved per hit vs one shard wasted per miss).

Then add the corresponding metric to E4, which currently measures *"prefetch hit rate; wasted prefetch bytes;
miss→fallback latency"* — all three byte/latency quantities, none of them the hazard the plan calls dominant.
That omission is the finding: E4 was designed to measure the cost the plan could quantify rather than the cost
it had identified as dominant.

### MAJOR-8 — The 30 s action TTL is defended with a bound that the implementation makes vacuous; in Flavor C it is inert

Answering the second half of claim D.

§2.3 keeps the number and adds the rationale: *"It is a bound on staleness between capability epochs, not a
performance tuning knob."* Two problems, one from source and one internal.

**From source (GT-3):** `capabilityEpoch` is `sha256({actorId, target-row snapshot, operations})` — a
fingerprint of the response. It changes if and only if the answer already changed. "A bound on staleness
between capability epochs" therefore bounds nothing: there is no epoch transition to be between, because the
epoch is not an independent clock. The 30 s TTL is the *only* staleness control, and what it bounds is the
window in which a stale **allow** may be acted on. That is a real and statable bound — *"an action believed
allowed may be at most 30 s out of date with policy"* — and it is not the one the plan states.

**Internal:** §5.3 says the Flavor C harness *"re-runs `action list --for <target>` if the cached result is
older than the TTL"* before **every** mutation. If the check runs before every mutation, the TTL governs
nothing in Flavor C — it is a cache-reuse window inside a single turn. So the number is simultaneously
under-derived and, in the flavor that leans on it hardest, inert. And F5 then *propagates* it into generated
shard metadata as `freshActionsMaxAgeMs: 30000`, so the undocumented constant is now duplicated in a generated
artifact — mildly against anti-bloat rule 2's no-duplication-across-layers principle, and a second place it
can drift.

**What I would do instead.**

1. **Fix the epoch, then the bound becomes true.** Derive `capabilityEpoch` from a monotonic
   policy/membership/role version counter — not from the response contents. Then epoch-change invalidation
   works as the walkthrough's cache table already claims, and 30 s becomes a genuine ceiling on how long a
   revocation can go unobserved. Call it **F16**. This is a small change with disproportionate payoff: it makes
   an already-documented invalidation mechanism actually function.
2. **State the bound in the form that is checkable**, in one line beside the number: *"an action believed
   allowed may be at most 30 s stale with respect to policy; a revocation is therefore observable within 30 s
   without an event."* That is a claim a conformance test can assert.
3. **Single-source the constant.** `freshActionsMaxAgeMs` should be generated from one server constant, not
   written into F5's field list as a literal.
4. **Say plainly that Flavor C does not use the TTL** — it re-checks unconditionally — so a reader does not
   infer a 30 s staleness window that Flavor C does not have.

---

## Part IV — Complete inventory of invented numbers (claim D)

Asked for every number that is asserted rather than derived, and which ones matter.

| # | Number | Where | Derived? | Matters? |
|---:|---|---|---|---|
| 1 | **~60% prefetch hit threshold** | §11 E4, §13 step 5 | **No.** Byte break-even is 50%; measured against the wrong quantity entirely | **YES — gates shipping Flavor C.** Major-7 |
| 2 | **30 s action TTL** | inherited; §2.3 "keep the number, add the rationale" | **No.** The stated rationale is vacuous given GT-3, and inert in Flavor C | **YES — the only staleness control.** Major-8 |
| 3 | **"prefetch missed twice ⇒ repin to B"** | §10 Escalation | **No.** Two is arbitrary, and repin atomically invalidates all profile-governed caches and injects a policy-change notice — plausibly more disruptive than continuing to miss | **Moderate.** Derive from the E4 miss distribution or drop the trigger until E4 has data |
| 4 | **`prefetchShardMaxCount: 1`** | §5.3 | **No**, but conservative and self-limiting | Low. Keep |
| 5 | **`freshActionsMaxAgeMs: 30000`** | §9 | Inherits #2, and duplicates it into a generated artifact | Low on its own; see Major-8 |
| 6 | **"roughly 400 bytes" added to kernel** | §7 | **No, and wrong** — actual ~1,117 | **YES.** Major-1 |
| 7 | **"Net: smaller than v1"** | §7 | **False** — +522 / +636 | **YES.** Major-1 |
| 8 | **"no added bytes" (actions-first)** | §1 | **Contradicted by §8's own table** (+8 KiB) | **YES.** Major-2 |
| 9 | **"~48 KiB" after actions-first** | §8 | Roughly right (32 KiB context default + 16 KiB shard) — but silently uses the 32 KiB *default* while Flavors B/C cap the same payload at 16 KiB | Low, but makes the table incomparable across flavors |
| 10 | **"81 operations"** | §6, §11 | **Stale** — 101 in tree | **YES.** Major-6 |
| 11 | **"2,600 bytes as a template"** | §7 | I measure 2,809 for the spine. Within tolerance given placeholder handling | Low |
| 12 | **"~52% of cap / ~2.9 KiB headroom"** | §7 | **Verified: 51.7%, 2,965 bytes.** Reproducible | None — this one is right, and it is the load-bearing one for §F |
| 13 | **"30–40% skip rate"** | §2.2, §5.3, E2 | Haiku's **self-report**, correctly labeled as a prediction to be tested. Not the plan's invention | None — handled honestly. Worth noting the plan gets this right |
| 14 | **"~4 / ~1–2 / ~0 discovery calls"** | §4 | Follows from the journeys. Fine | Low |
| 15 | **"variance HIGH/MEDIUM/LOW"** | §4 | Unmeasured and unmeasurable as stated | Low — but E-series should either define variance or drop the row |

**Which actually matter: #1, #2, #6, #7, #8, #10.** Four are arithmetic or staleness errors with concrete fixes
(Majors 1, 2, 6). Two gate implementation decisions (Majors 7, 8). The rest are cosmetic. Note that #12 — the
one number the plan's most consequential argument rests on — **is correct and reproducible.** The plan's
numeric discipline is good where it measured and poor where it estimated; the pattern is estimation presented
in the register of measurement.

---

## Part V — Claim F: kernel v2 as its recipient, and what I would add

The plan's §7 argument: 3,112 rendered is ~52% of cap, therefore *"the binding constraint on kernel content is
signal-to-noise, not bytes"*, therefore the 2.9 KiB of headroom *"must not be spent"* except on *"procedural
clauses that a reviewer-predicted failure mode proves are load-bearing."*

**The principle is correct and I endorse it.** It is the best-reasoned paragraph in the document. Both
reviewers rejected the Interaction-Profile and Phase-1 sentences because no action followed from them, not
because they cost bytes — and that is dispositive. Signal-to-noise is the right constraint, the plan identified
it from the evidence rather than asserting it, and the headroom measurement is reproducible (GT-5).

**But the plan applies its own bar inconsistently.** It sets the bar at "a reviewer-predicted failure mode
proves it load-bearing," and then declines three additions that clear that bar — while spending nothing on the
hazard it calls dominant. That is where "signal-to-noise, not bytes" stops being a principle and starts being a
reason not to decide.

Reading the §7 text as its recipient, three things are missing:

**(a) The error-code → action table. ~250 bytes. Clears the bar; Sonnet asked for it by name and gave the
mechanism.** *"Tables are something I parse and hold onto more reliably than a general rule I have to
re-derive per error code."* The plan's answer is §9: put `onVersionConflict` / `onTransportTimeout` in each
command shard, per article rule 4, *"present exactly when relevant."* **That answer fails for the errors that
matter most.** `FORBIDDEN`, `EVENT_GAP`, `CATALOG_MISMATCH`, `NOT_FOUND`, `RATE_LIMITED` are cross-command and
frequently arrive on operations whose shard I never fetched — a `CATALOG_MISMATCH` arrives precisely when my
cached shards are invalid, and an `EVENT_GAP` is not attached to any operation at all. §9's corollary
("because the shard now carries the protocol, the kernel can drop the corresponding general rules") holds for
per-command semantics and does not hold for protocol-level errors. Seven rows, ~250 bytes, and it is the
single highest-value use of the headroom.

**(b) The worker state-machine vocabulary. ~120 bytes. Both reviewers asked; the plan silently dropped it.**
Sonnet §1: the state machine *"is entirely absent from the kernel… the discipline of the design is enforced by
hoping I reinvent the sequencing."* Sonnet §5 lists it as one of three things it wants preloaded. Haiku §4
asks for "a single-line sketch." §2.1's convergent-findings table has **no row for it**, and §7's "what was
cut" list does not mention rejecting it. It is the only convergent request in either review that the plan
neither adopts nor argues against — it just vanishes. One line: *"You are a worker: sync, discover, work,
verify, complete. A refresh returns you to sync for the focused entity only, not to the start."* The value is
not decoration: after a `tm8.context-refresh` injection, the vocabulary is what lets me recognize that I am
re-syncing rather than restarting — which is exactly the confusion rule 8's replace-not-append semantics
create.

**(c) Flavor C only: the fallback *procedure*, not the disclaimer. ~140 bytes.** Blocker-4's argument in
positive form. *"If the included shard is not the command you need, run `tm8 action list --for <id>` then
`tm8 help <noun> <verb>`. The included shard is one option among those."* The plan's mitigation is a
prohibition with no named alternative, which is the exact pattern article rule 1 — which the plan adopts in §3
— says underperforms. Naming the path costs 140 bytes and converts an assertion into an available action.

Total: **~510 bytes.** Flavor C would render at ~3.8 KiB, **62% of cap.** All three clear the plan's own stated
bar. Blocker-1's digest change frees far more than this.

**And what should NOT be added, which the plan is right to refuse:**

- **The noun glossary** (Haiku's +100 bytes) — superseded by actions-first, and it is *content*, not procedure.
  Refusing it is correct even though it fits.
- **`firstNoun`** — the plan's reasoning ("a guess about a guess") is exactly right.
- **The five completion receipts in full** — §9's `notSatisfiedBy` is the better home, and this one genuinely
  is per-command.
- **Anything about entity kinds, the operation table, product background, or the Interaction Profile
  architecture** — no action follows, and the reviewers proved it by skimming past it.

So my answer to claim F: **"signal-to-noise, not bytes" is right, and the plan should be held to it rather
than protected by it.** The headroom question is not "should we spend it" but "does this clause change what I
do." Three clauses do; the plan declined them without argument, and left its self-identified dominant hazard
funded at 14 words.

---

## Part VI — MINOR findings

**MINOR-1 — F4 names a type that does not exist and describes a field that does not exist.** F4: *"`DiscoveredAction`
must populate `commandRef` **and** `helpRef` (already specified — make it required, not optional)."* The type is
`PaletteAction` (`contract.ts:762`); there is no `DiscoveredAction` anywhere in the tree. `helpRef: string` is
**already required**. `commandRef` **does not exist at all** — so "already specified" is wrong, and F4 is an
addition, not a tightening. Fix the type name and split F4 into "add `commandRef`" (new field, needs a
CLI-form derivation) and "helpRef is already required" (no work).

**MINOR-2 — Rollout step 2's cost is understated by an order of magnitude.** §13: *"Actions-first (§8) + F4. Two
DTO fields and a doc change… Expect the largest ratio of benefit to effort in this whole plan."* Against GT-4:
there is no `tm8 entity` command, no `tm8 action` command, no `tm8 help` command, and no resolver for the
`tm8://help/operation/*` namespace that `PaletteAction.helpRef` already synthesizes. Step 2 requires the CLI
noun surface plus a help-ref resolver (walkthrough amendment #13), neither of which appears in §12. The
benefit/effort ratio may still be the best in the plan — but the effort is a CLI package, not two fields.

**MINOR-3 — F2's "built-in core profile keys" have no host in the implemented shape.** Source shows Interaction
Profiles as Space-scoped entities with a `propose → updateDraft → validate → preview → activate` lifecycle,
where `ActivateInteractionProfileInput` requires `validatedVersion`, `validatedHash`, and `confirm: true`
(`contract.ts:1247-1263`). A "built-in core profile" registered server-side is a distinct code path — not a row
produced by that lifecycle — and F2 reads as registration of three keys. Say which: server constants
validated against the same schema, or seeded rows per Space.

**MINOR-4 — F1 mutates a hash-pinned closed structure with no migration story.** `ClosedPromptPolicy` and
`ToolDiscoveryPolicy` are closed by name and design; `InteractionProfileDraft` carries `templateKey` +
`templateVersion`, and activation pins a `validatedHash`. Adding five fields to `ToolDiscoveryPolicy` changes
the resolved hash for every already-activated profile. F1 should state the `templateVersion` bump and whether
existing pins are re-validated, invalidated, or grandfathered. Related: the walkthrough's rule that a pin
revision change *"invalidates all profile-governed caches atomically and injects one bounded policy-change
notice"* means an F1 rollout is a fleet-wide cache flush.

**MINOR-5 — §11's CI gate needs an explicit exemption for Flavor C.** *"No bootstrap fixture in any flavor
contains the operation table."* A prefetched shard is a slice of that table. Under Blocker-1's digest proposal
the exemption is easy to write precisely: *"≤1 operation's decision fields, ≤2 KiB, no operation enumeration."*
As written, a literal implementation of the gate fails Flavor C, or is quietly loosened to pass it — and the
second is how anti-bloat gates die.

**MINOR-6 — `actions[]` labels are mechanically derived and §8 overstates what they convey.** `label:
operation.replaceAll('.', ' ')` yields `entities commands complete`. §8: *"the entity told it which commands
apply."* It told the agent 51 dotted operation names with the dots removed. Populating `commandRef` with the
CLI form (`task complete`) and using it as the label is the cheap fix, and it is the same work F4 needs anyway
— worth noting that `commandRef` is doing more work in §8's argument than F4's one-line framing suggests.

---

## Part VII — What the plan gets right, recorded deliberately

An adversarial review that lists only defects misrepresents the artifact. Five things here are better than
what they replace, and two are better than the reviews that prompted them:

1. **Kernel v2's one-job-per-sentence discipline, and the diagnosis behind it.** The mapping from the article's
   *contradiction* finding to the tm8 analogue (*"doing double duty… and it fails at the second job"*) is the
   sharpest analytical move in the document, and it correctly identifies ambiguity as costing what
   contradiction costs.
2. **The invariant floor (§6) and the refusal to dilute it for a leaner tier.** §14's *"Flavors are policies
   over reads, ordering, and prefetch — never over authority"* is the right line in the right place. My
   Blocker-2 is a report that the plan crossed its own line, not a disagreement with the line.
3. **§9, shard metadata as tool description.** `notSatisfiedBy` and `siblingVerbs` + `siblingSchemasDiffer` are
   genuinely better than the prohibitions they replace — expressive interface over prohibition, article rule 2
   applied literally, exactly as claimed. `siblingVerbs` in particular answers Sonnet's #1 failure mode with a
   mechanism instead of a sentence, which no amount of kernel rewording could have done.
4. **§11.** Eight falsifiable hypotheses with predictions on record, including predictions that would embarrass
   the plan if wrong (E4's own kill threshold, E2 as the sole justification for Flavor C's existence). The plan
   states *"None of the three flavors is asserted to be best"* and then actually behaves that way in §13 by
   gating C on evidence. Rare, and it is what makes this document reviewable at all.
5. **§3's deliberate divergence from article rule 1.** *"A model's judgment is not a substitute for a
   permission boundary, and tm8's threat model includes untrusted repo content authored by other agents."*
   Correct, and correctly labeled as a divergence rather than smuggled in as compliance.
6. **Refusing `firstNoun`** — better than Haiku's proposal, for the stated reason.
7. **Refusing the preload tier's weak form** — better than Haiku's proposal, and Sonnet's independent rejection
   is real corroboration. My Major-3 is that the *strong* form was never considered, not that the refusal was
   wrong.

---

## Findings summary, ranked

| Rank | ID | Class | Finding | One-line fix |
|---:|---|---|---|---|
| 1 | B1 | **BLOCKER** | Flavor C is ~8.5 KiB over the 32 KiB combined-initial cap; §11's own gate would fail it | Ship a 2 KiB shard **digest**, not a 16 KiB shard |
| 2 | B2 | **BLOCKER** | `actions[]` is structural availability, not authorization (verified); Flavor C's kernel says absent ⇒ denied | Strike the clause; add `allowed`+`deniedReason` (F12) and `scope=target` (F13) before actions-first is the default |
| 3 | B3 | **BLOCKER** | Prefetch predicate keys on two non-existent fields, and "exactly one" can never hold for `task` | Contract-generated `(kind, status) → op \| none` table (F14); add F5 to C's blockers |
| 4 | B4 | **BLOCKER** | F7's "never an operation choice" is contradicted by §5.3; one `<rule>` will not hold | Positive enumeration + `selection_rule` in the envelope + named fallback in the kernel |
| 5 | M1 | MAJOR | "Net: smaller than v1" is false (+522 / +636 B, +20–24%); "~400 bytes" understates ~2.8× | State actual bytes; move the shrink claim to post-§9 |
| 6 | M4 | MAJOR | Four multi-agent gaps: no task single-writer; `coordinated_by` absent; flavor invisible across the boundary; stuck child unobservable | F15 (profile key in provenance); explicit stuck-child protocol; decide (a) in writing |
| 7 | M7 | MAJOR | ~60% threshold undelivered and measured against bytes, not the dominant hazard | Two-part gate: ≥50% (derived) **and** zero wrong-mutation-after-miss |
| 8 | M8 | MAJOR | 30 s TTL's stated bound is vacuous (epoch is a hash of the answer) and inert in Flavor C | F16: derive epoch from a policy version counter; restate the bound checkably |
| 9 | M3 | MAJOR | Tier reframe is right about the axis, then used to skip the arithmetic; evidence is two self-reports; strong-form preload never considered | Add **A+** static-digest arm to E4 as a third comparison |
| 10 | M2 | MAJOR | Actions-first billed as byte-free; §8's own table shows +8 KiB; E6 would read as a regression | State the trade; split E6 into calls / bytes |
| 11 | M5 | MAJOR | `providerToolRegistrationAllowlist` is `OperationName[]`; F11's rename premise is refuted by the type | Drop the field in Phase 1; strike F11's premise |
| 12 | M6 | MAJOR | "81 operations" is stale (101 in tree); a count in an invariant is a trap | Replace with "every operation at the current digest"; assert set equality, no count |
| 13 | F-a/b/c | MAJOR (aggregate) | §7's own bar is met by three declined additions; the dominant hazard is funded at 14 words | Add error table (~250 B), state-machine line (~120 B), Flavor C fallback (~140 B) |
| 14 | m1–m6 | MINOR | F4 type/field errors; step 2 understated; F2 has no host; F1 hash migration; CI-gate exemption; mechanical labels | See Part VI |

---

## Consensus protocol

I expect the author to respond to each finding as **accepted**, **rejected with reasons**, or **modified**. My
commitments for that round:

- I will drop or downgrade any finding given a good counter-argument, and say so explicitly rather than
  quietly.
- I will not soften a finding to be agreeable.
- Where we do not converge, I would rather record **explicitly-unresolved, with both positions stated**, than
  manufacture an agreement.

**Where I expect genuine disagreement**, flagged in advance so the author can aim at it:

- **B2's severity.** The author may argue the fix belongs to `actions.list`'s implementation (a W2 defect) and
  not to this plan. I would partly accept that — but the plan *documents actions-first as the default journey
  in all three flavors* and writes a kernel clause asserting the authorization semantics, so it takes on the
  dependency. If the author adds F12/F13 as explicit blockers of §8's recommendation, B2 downgrades to MAJOR
  and I will say so.
- **B4.** The author may hold that "choosing what to describe" is categorically different from "choosing what
  to execute." I accept the distinction is real; I do not accept that F7's current text expresses it. If F7 is
  reworded to the positive enumeration, B4 is resolved.
- **M3's A+ arm.** The author may reasonably say this expands the measurement matrix at real cost. My
  counter: A+ is a fixture, not a mechanism, and it is the only way to discover that F7 + F14 + the whole
  read-executor are unnecessary. If the author commits to running A+ *before* rollout step 4 rather than as a
  fourth arm throughout, I am satisfied.
- **F-a/b/c.** Judgment about my own behavior, and therefore the weakest evidence in this review by exactly
  the standard I applied to Sonnet and Haiku in M3. I hold (a) and (c) firmly — (a) because the shard-carries-
  the-protocol argument has a structural gap for cross-command errors, and (c) because the plan's own
  dominant-hazard framing demands more than a disclaimer. On (b) I hold only that the plan should **state a
  rejection** rather than let a convergent request disappear; if the author rejects the state-machine line with
  a reason, that is a resolved finding, not an unresolved one.

**Where I expect no disagreement:** B1, B3, M1, M2, M5, M6, and Minors 1–6 are arithmetic or source checks. If
any of them is wrong, it is because I misread the source, and I would like to be shown where.
