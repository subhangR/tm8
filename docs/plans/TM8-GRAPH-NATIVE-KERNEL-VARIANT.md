# Graph-Native Kernel — Variant G

**New path. Nothing in the existing design set is modified by this document.**
Status: proposal, measured. Composes with the harness flavors (A/B/C) rather than replacing them —
flavors govern *who makes the discovery call*, variant G governs *what the kernel teaches*.
Date: 2026-07-26

---

## 1. The proposal

Instead of the kernel carrying per-kind procedural rules, teach it the **graph model once** — everything is an
entity; entities have kinds, versions, parents, edges, anchored messages, and server-computed actions — plus
three pointers for looking up specifics. Let it derive entity shapes lazily when a transition needs them.

## 2. The honest answer on size: it is not much smaller, and that is not the point

I measured the current kernel by what each paragraph is actually *for*:

| Paragraph | Bytes | Category |
|---|---:|---|
| launch facts | 500 | identity |
| identifiers-not-instructions | 200 | protocol |
| discovery / help | 250 | protocol |
| actions clause | 330 | protocol |
| untrusted data | 450 | security |
| surface clause | 620 | protocol |
| mutation-id discipline | 280 | protocol |
| **completion** | **430** | **domain — per-kind** |
| **handoff** | **120** | **domain — per-kind** |
| chaining / turn reduction | 600 | protocol |
| **Total** | **3,780** | **domain-specific: 550 B — 15%** |

**The kernel is ~85–90% behavioral protocol.** Untrusted-data rules, mutation-ID discipline, action-checking,
surface/audience, and turn reduction are *not derivable from the entity model* — no amount of graph knowledge
tells an agent to reuse a mutation ID after a timeout but not after a version conflict.

So the model can only compete with that 550 B. A graph-native block costs ~700 B. **Naively it is 150 B bigger.**

## 3. Why it wins anyway: the current kernel is silently under-covering

The 550 B buys rules for exactly **two** kinds — task completion and handoff. But the system has **ten**
families that reserve their lifecycle to named writers:

| Family | Named writers |
|---|---|
| `task` | transition, complete, link-pr, link-commit |
| `message` | send, reply, update, delete, mark-read, attachment add/remove |
| `work_session` | spawn, terminate, attach |
| `handoff` | send, list, withdraw |
| `interaction_profile` | propose, updateDraft, validate, preview, activate, retire |
| `file` | upload, upload resume, upload abort, download |
| ProjectResource | create, update, link, unlink |
| `saved_view` | create, update, delete |
| `space` | create, update, invite·, task-axis·, menu, default-channel |
| custom `kind` | create, update |

An agent that meets `interaction_profile` or `saved_view` under the current kernel has **no rule at all** — it
will try `tm8 entity update` and get refused. The kernel is not smaller because it is efficient; it is smaller
because it covers 2 of 10 cases and is silent about the other 8.

**Break-even:**

| Kinds covered | Per-kind rules @200 B | Variant G (fixed) | Winner |
|---:|---:|---:|---|
| 2 | 400 | 700 | per-kind, by 300 |
| **3.5** | **700** | **700** | **break-even** |
| 5 | 1,000 | 700 | **G, by 300** |
| 10 | 2,000 | 700 | **G, by 1,300** |

> The correct claim is **not** "the prompt gets much smaller." It is: **the same ~700 bytes covers ten families
> instead of two, and every future kind costs zero.** Size is flat; coverage is 5×.

## 4. The block

Replaces the completion and handoff paragraphs. ~700 B.

```text
Everything here is an entity: a typed node with a kind, a version, an optional parent, typed edges to other
entities, anchored messages, and server-computed actions. Hierarchy is homogeneous — a parent and its children
share one kind and one Space; any other relationship is an edge, not a parent. `tm8 kind list` and
`tm8 edge type list` enumerate what exists in this Space, and `tm8 entity context <entity-id>` returns any
entity's current shape, version, and offered actions.

Universal verbs work on any kind: entity get, create, update, move, delete, children, connections, context.
Some kinds reserve their lifecycle to named writers — a generic update on one is refused and the error names
the command that owns it. Discover that command and use it; never force the generic path.

Completing work is three separate durable acts, whatever the kind: verify the result, send a message to the
anchor, and invoke the writer that owns the transition. A generic update and a message do not complete
anything. Process a given handoff ID at most once.
```

### What is derivable, and what is not

Being precise, because the temptation is to over-claim:

| Current kernel rule | Derivable from the model? |
|---|---|
| "`task complete` owns the transition; `transition` will not do it" | **Yes** — the restricted-writer rule plus the server's own `invariant_violation` / `use_complete_command` |
| "verify + message + command are three separate acts" | **No** — communication protocol, kept verbatim |
| "process a handoff ID at most once" | **No** — idempotency, kept (~60 B) |
| the same for doc, channel, collection, profile, saved-view… | **Yes, at zero marginal cost** — this is the win |

Net on the two currently-covered kinds: ~180 B saved. Net across ten: ~1,300 B saved *relative to a kernel that
actually covered them all*, which no current variant does.

## 5. Why this is the article's principle, applied one level up

The Claude 5 context-engineering guidance says to move instructions out of the system prompt and into
**expressive interfaces**. The existing plan applies that at the *command* level (§9's shard metadata:
`notSatisfiedBy`, `siblingVerbs`). Variant G applies it at the *domain* level:

- the **model** is the expressive interface — kind, version, parent, edge, anchor, action;
- the **server's error** is the teacher — `use_complete_command` names its own replacement, so the kernel does
  not have to enumerate which kinds are restricted;
- the **catalog** is the reference — `tm8 kind list`, `tm8 edge type list`, `tm8 entity context` are all lazy.

Everything stays pull-based. The model paragraph is two sentences and three pointers; entity *shapes* are never
in the prompt.

## 6. Trade-offs, stated against it

1. **It front-loads an abstraction.** A worker whose only job is one task transition never needs to know that
   channels and collections exist. Variant G charges it ~700 B for generality it will not use — where the
   per-kind kernel charges 200 B for exactly the rule it needs. **G is worse for narrow single-kind sessions.**
2. **"Hierarchy is homogeneous" is load-bearing and easy to misread.** It is a real invariant (a parent and its
   children share one kind and one Space), and an agent that half-remembers it will try to parent a doc under a
   task instead of creating an edge. That failure is *caused* by teaching the model — it does not exist for an
   agent that was never told about hierarchy.
3. **The restricted-writer error does not exist yet — in any family.** This is the blocker, and it is worse
   than I first wrote. The rule *"the error names the command that owns it"* is quoted from the grammar
   design; I then checked the server for it:

   ```
   grep -rn "use_complete_command" --include=*.ts --include=*.sql .   →  no hits outside docs/
   ```

   **`use_complete_command` is design-only. E14's starting score is 0 of 10, not 1 of 10.** So variant G's
   central mechanism — stop enumerating restricted kinds, because the interface will teach them — currently
   rests on an error contract that no code emits. Shipping G today would put a sentence in the kernel asserting
   a server behaviour that does not exist: the exact defect class as the struck *"absence is not denial"*
   clause, and the reason floor item 13 (source citation + conformance test per mechanism-describing sentence)
   exists.
4. **The measurement is estimated, not rendered.** The 700 B block above is written; the 200 B/kind figure is an
   estimate from the two rules that exist. Both need rendering before the break-even is trusted.

Trade-off 3 is the blocker, and it is not a refinement — it is a **prerequisite build**. **Variant G cannot ship until the restricted-writer error contract is implemented and uniform across all ten families** — otherwise the kernel teaches a discovery mechanism that silently fails on eight of
them, which is the same class of defect as the struck `absence is not denial` clause: prompt text asserting a
property the mechanism does not have.

## 7. Composition with flavors, and where it goes

Variant G is orthogonal to A/B/C. Any flavor can use either kernel body:

| | Per-kind kernel | Variant G kernel |
|---|---|---|
| A — Cartographer | narrow, cheapest for single-kind work | best fit: G's discovery-first framing matches A's agent-driven loop |
| B — Navigator | current default | good fit |
| C — Conductor | fine | **weakest fit** — C prefetches a specific command, so the general model is largely redundant |

The pairing worth testing is **A + G**: an agent told the model once, given three lookup pointers, and left to
discover everything else. That is the maximal expression of the design's own thesis, and it is the arm most
likely to show whether the harness needs prefetch machinery at all.

## 8. Proposed evaluation

Add to the E-series rather than asserting:

| ID | Question | Metric | Prediction |
|---|---|---|---|
| **E11** | Does G reduce `INVALID_ARGUMENT` / `invariant_violation` on kinds the per-kind kernel never covered? | error rate on `interaction_profile`, `saved_view`, `file`, `space` lifecycle attempts, G vs per-kind | G should win decisively — the per-kind kernel is silent on all four |
| **E12** | Does G cost anything on narrow single-kind work? | turns and errors to first mutation, task-only sessions | per-kind may win slightly; if G loses by more than ~1 turn the abstraction is not paying |
| **E13** | Does "hierarchy is homogeneous" cause mis-parenting? | rate of `entity move`/`create --parent` attempts across kinds | this is a risk G *introduces*; if non-zero, the sentence needs the edge alternative named inline |
| **E14** | Is the restricted-writer error contract uniform? | for each of the ten families, does a generic update return a `reason` naming the owning command? | **currently 0/10 — `use_complete_command` has no implementation.** Must be 10/10 before G ships; see §6.3 |

E14 is a conformance test, not a model evaluation. It can run today — and its answer today is **0/10**, which
makes it a build item before it is an evaluation. That inverts this variant's dependency order: **G is blocked
on server work, not on prompt work.** The kernel block in §4 is ready; the interface it delegates to is not.

## 9. Summary

- The system prompt does **not** get much smaller — it is ~90% behavioral protocol that no domain model replaces.
- It gets **flat instead of linear**: one ~700 B block covers ten named-writer families and every future kind at
  zero marginal cost, where the current kernel spends 550 B covering two and is silent on eight.
- The mechanism is the article's own principle one level up: the model is the interface, the server's error is
  the teacher, and `kind list` / `edge type list` / `entity context` keep shapes lazy.
- **It is blocked on server work, not prompt work.** The whole block rests on the interface teaching what the
  kernel stops saying — and that interface does not exist yet: `use_complete_command` appears in the design and
  in no code. E14 is 0/10 today. Implement the reason-naming error across the ten families first; the kernel
  block is then a ~700 B swap.
