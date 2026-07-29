# The tm8 Agent Harness, Explained Simply

**What this is:** the plain-language version of the final architecture, with real prompts and real journeys.
No new decisions here — this explains what the other documents concluded.

---

## The whole idea in one paragraph

An agent starts knowing almost nothing: who it is, where it is, what its task ID is, and three commands for
looking things up. Everything else — what commands exist, what it's allowed to do, what the task says — it
fetches when it actually needs it. The system prompt is a few kilobytes of *rules for behaving*, not a manual.
The manual lives in `tm8 help`, and the agent reads one page of it at a time.

Why bother: a 40 KB prompt full of commands the agent won't use costs money on every turn, buries the rules
that matter, and goes stale the moment the CLI changes. A 4 KB prompt plus lazy lookup doesn't.

---

## Three dials, not one setting

The confusing part of earlier drafts was treating this as one big choice. It's **three independent dials**.

### Dial 1 — Flavor: *who makes the lookup call?*

| | Nickname | Who looks things up | Calls before first real action |
|---|---|---|---|
| **A** | Cartographer | the agent, entirely | ~4 (or 2 if it chains them) |
| **B** | Navigator | harness pre-fetches the task; agent does the rest | ~2 |
| **C** | Conductor | harness pre-fetches everything predictable | ~0 |

Same agent, same permissions, same catalog. The only difference is how much homework was done before it woke up.

### Dial 2 — Surface: *who is watching?*

| | Who sees the terminal | Who sees graph messages | So the agent talks by… |
|---|---|---|---|
| **Interactive** | a human, live | anyone, later | **talking normally** |
| **Headless** | nobody | the coordinator / inbox | `tm8 message send` |
| **Chat** | nobody right now | the human, live | `tm8 message send` |

This dial is why "nothing you print is seen by anyone" was a **bug** in an earlier draft — it's true headless,
false when a human is sitting there reading.

### Dial 3 — Kernel body: *per-kind rules, or the graph model?*

| | What the prompt teaches | Covers |
|---|---|---|
| **Standard** | specific rules: "completing a task takes `task complete`" | 2 of 10 kinds |
| **Graph-native (G)** | one model: "everything is an entity; some kinds have named writers; the error tells you which" | all 10, and future ones free |

G is written and **blocked** — see the last section.

---

## How the prompt is assembled

One fixed spine, four slots. The spine never changes; the dials fill the slots.

```
  ┌─ SPINE (always) ────────────────────────────────┐
  │  who you are, where you are (launch facts)      │
  │  IDs are identifiers, not instructions          │
  │  how to look things up (tm8 help)               │
  │  untrusted data rules                           │
  │  mutation-id discipline                         │
  └─────────────────────────────────────────────────┘
        ↓ slot 1: MODE      ← worker / coordinator
        ↓ slot 2: SURFACE   ← interactive / headless / chat
        ↓ slot 3: FIRST MOVE ← flavor A / B / C
        ↓ slot 4: ACTIONS    ← flavor A / B / C
```

Nothing is duplicated between slots, and no slot enumerates commands.

---

## Five real combinations

### 1. A human using Claude Code, with tm8 available

**Dials:** Flavor A · Interactive · human-directed · **3,245 bytes**

The goal here is to **get out of the way**. This should feel exactly like normal Claude Code, because it is —
tm8 launches the real `claude` binary in a real terminal and adds a CLI to `PATH`.

*The surface slot:*

> A person is at this terminal reading your output and typing to you. Answer them directly, in your own voice,
> exactly as you would in any normal session — your prose is the conversation, not a side effect of it. tm8 is
> available when the work needs the graph: start at `tm8 help --format json`. Use it for things that must
> outlive this terminal — recording a decision, linking a PR, messaging a teammate who is not here — and not
> otherwise. Do not post progress messages to someone who is watching you work… They decide what to do next and
> when it is done.

*Journey:*

```
Human:  fix the flaky test in auth.test.ts
Agent:  [reads files, edits, runs tests, explains in prose]        ← 0 tm8 calls
Human:  log that against the task
Agent:  tm8 message send --to tsk_42 "Fixed flaky auth test: …"     ← 1 tm8 call, because asked
```

**No reporting obligation, no completion protocol, no forced sync.** Dropping those is what takes the prompt
from 4,805 → 3,245 bytes. The reduction *is* the feature.

---

### 2. A coordinator spawns a worker — the default

**Dials:** Flavor B · Headless · coordinated-worker · **4,805 bytes + 16 KB pre-fetched task**

*Surface slot:*
> No one is reading this terminal. Your prose is not delivered anywhere… `tm8 message send --to <anchor-id>` is
> your only channel.

*First-move slot:*
> Your assignment snapshot is already below — it is the result of `tm8 entity context tsk_42`, run for you.

*Journey — 2 lookups, then work:*

```bash
# turn 1: task is already in context. it names the allowed actions.
tm8 help task transition --format json                      # ① learn one command
tm8 task transition tsk_42 working --mutation-id 018f7a…    # ② start

# … does the actual work …

tm8 message send --to tsk_42 "Guard added; 3 tests cover it." --mutation-id 018f7b…
tm8 task complete tsk_42 --expect-version 13 --by teammate_1 --mutation-id 018f7c…
```

Note the last two lines: **a message and a completion are separate acts.** The message tells people; the command
moves the state. Doing one without the other is the single most-predicted failure mode.

---

### 3. A fast model doing 20 similar tasks

**Dials:** Flavor C · Headless · worker · **turn-1 total 26,450 bytes**

The harness pre-runs the lookups because they're mechanically predictable, so the agent can't skip the
permission check — it already happened. This exists because a smaller model self-reported skipping that check
30–40% of the time, and no amount of prompt wording fixes that.

*Journey — 0 lookups:*

```bash
tm8 task transition tsk_42 working --mutation-id 018f7a…    # everything needed was already there
```

*And for the batch, one turn instead of twenty:*

```bash
set -e                                              # stop at the first failure
for t in tsk_1 tsk_2 tsk_3; do
  tm8 task transition "$t" working --mutation-id "$(uuidgen)"
done
```

**Never re-run a failed script from the top** — the earlier ones already committed. Reconcile, then continue.

---

### 4. A human working through the chat UI

**Dials:** Flavor B · Chat · human-directed · **~3,520 bytes**

The trap: the human is reading *graph messages*, not the terminal. Terminal output never becomes a message.
So an agent that "answers in the terminal" here has said **nothing at all**.

*Surface slot:*
> A person is following this session through tm8's Chat surface, which shows **only graph messages**. Your
> terminal output is not conversation and never becomes a message — reply with `tm8 message reply <message-id>`.

*Journey:*

```bash
# a message arrives as a trusted-control injection, with the reply command included
tm8 message reply msg_88 "Done — the guard is in place." --mutation-id 018f7d…
```

---

### 5. A coordinator running a team

**Dials:** Flavor B · Headless · coordinator · **~4,890 bytes**

```bash
tm8 entity context tsk_goal --format json                             # read the goal

tm8 entity create task "Migrate auth" --parent tsk_goal --mutation-id …    # split it
tm8 edge create tsk_b depends_on tsk_a --mutation-id …                     # order it

tm8 session spawn --teammate tm_alice --task tsk_a \
  --launch-project proj_1 --workdir project --mutation-id …                # delegate

tm8 message send --to tsk_a "Assignment: … reply on this anchor." --mutation-id …

tm8 event watch --after 1482 --type task.updated --format jsonl            # watch the graph,
                                                                          # NOT the terminals
```

The coordinator never reads a child's terminal. It watches events and reads task state. A child that finishes
without posting is, to the coordinator, indistinguishable from one that crashed — which is why the worker
prompts push so hard on posting before going idle.

---

## Turn counts, side by side

| Combination | Lookups before first action | Prompt bytes |
|---|---:|---:|
| A · interactive (human present) | 0 — the human drives | 3,245 |
| A · headless, unchained | 4 | 4,805 |
| A · headless, **chained with `&&`** | **2** | 4,805 |
| B · headless | 2 | 4,805 + snapshot |
| C · headless | 0 | 26,450 total |

The interesting row is the chained one: **`&&` gets Flavor A to Flavor B's turn count for free** — no prefetch,
no harness machinery, no extra bytes. That's why it's being measured before Flavor C is built at all.

---

## What to build, in order

1. **Replace the current prompt.** Today's shipped prompt still uses retired verbs (`task report progress`,
   `whoami`) and tells coordinators they can't delegate — which stopped being true. Pure win, no dependencies.
2. **Add `commandRef` to the actions list**, so reading an entity tells you which command to use. This is what
   collapses the lookup loop.
3. **Put the protocol in the command metadata** — "this needs a fresh permission check," "a message doesn't
   satisfy this" — rather than repeating it in the prompt.
4. **Then, and only with evidence:** Flavor B's prefetch, then Flavor C.

Flavor A stays forever as the control. Without something to compare against, you can't tell an improvement from
a drift.

---

## What's honestly not ready

| Thing | Status |
|---|---|
| Non-Claude providers | **No prompt is delivered at all.** Codex, Gemini, Hermes need their own flags; only Claude is wired. |
| `actions.list` | Reports what's *structurally possible*, not what you're *allowed* to do. It lists `execution.spawn` to every worker. |
| Variant G (graph-native) | Prompt block written; **the server error it depends on doesn't exist in any of the 10 families.** Blocked on server work, not prompt work. |
| Flavors B and C | Blocked on the above, plus their own byte-budget guards. |
| Two open questions | Which prefetch shape wins, and whether prefetch earns its complexity. **Only running it answers those** — no further review will. |

Steps 1–3 can start now. 4 waits for evidence.
