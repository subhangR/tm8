# Entity Graph: derived edges — what we can know for sure

Analysis for task `019fbbab-2d21-750f-9168-de9d0601a29a`. Written 2026-08-01.

Every count here was measured against the live `tm8_stable` database
(127.0.0.1:5442), not inferred from code. Code claims carry `file:line`.

---

## 0. The headline

The graph has **31 registered edge types**. **9** have ever been written.

The session dimension the task asks about — "which session created this" — is
**designed into the schema in four independent places and written by none of
them**:

| Designed slot | Purpose | Live rows |
|---|---|---|
| `edges.type = 'authored_from'` (`015:41`, widened `052:49`) | "Immutable Server-recorded work-session provenance" | **0** |
| `activity.work_session_id` — column + index + validation trigger (`015:283-287`, `015:842-858`) | per-event session attribution | **0 non-null of 421** |
| `edges.type = 'shared_into'` (`015:37`) | entity → session projection | **0** |
| `edges.type = 'participates_in'` (`015:39`) | teammate → session | **1** |

So the premise in the task — *"I think we are storing the session ID created by
session ID"* — is **not correct as stated**. `entities.created_by` exists and is
`NOT NULL`, but it is an **actor** FK, never a session:

```
kind          created_by_kind   count
message       member            165
message       team_member         4
work_session  member            151
task          member             53
doc           member             39
...           member            all the rest
```

`information_schema` has exactly **one** column anywhere that binds a session to
an entity event — `activity.work_session_id` — and it is empty. There is no
`created_by_session_id` on `entities`, on `messages`, or anywhere else.
Entity→session provenance is carried *exclusively* by the `authored_from` edge,
which is why its unique index is load-bearing (`052:66-72`).

**The consuming side is already built.** This is what makes the gap
load-bearing rather than merely unfinished. The `session_chat_v1` feed declares
four membership terms (`feed-context.ts:99-104`), two of which read the empty
slots:

```sql
-- feed-context.ts:146-154
authored: … join public.edges g on g.src_id = m.entity_id and g.type = 'authored_from'
           where g.dst_id = $1
caused:   select 'activity', a.id, … from public.activity a where a.work_session_id = $1
```

`caused` reads a column nothing writes; `authored` reads an edge nothing writes.
`feed-context.ts:566` and `:584` project `sourceWorkSessionId` → always `null`.

---

## 1. Why it is empty: seven independent breaks

The session id *is* available to the agent process. It is never transmitted, and
even if it were, the write would still be refused. Each of these fails on its
own:

1. **The env has it.** `TM8_SESSION_ID` is injected at spawn
   (`packages/execution/src/spawn/manifest.ts:565`), one of three mandated vars.
2. **The CLI reads it.** `packages/cli/src/context.ts:81` → `ctx.sessionId`.
3. **The CLI sends it exactly once.** `ctx.sessionId` reaches a request body in
   **one** place in all 32 command files:
   `packages/cli/src/commands/session.ts:152` —
   `body.parentSessionId = cmd.ctx.sessionId` on `session spawn`. Not
   `entity create`, `message send`, `edge create`, `task complete`, `doc`,
   `artifact publish`, or anything else.
4. **No header either.** The client sets only `accept` / `content-type` /
   `authorization` (`packages/cli/src/client.ts:215-217`).
5. **The envelope has no slot.** `CommandEnvelope` is
   `{ actorId?, clientMutationId? }` (`facade/context.ts:32-45`;
   `contract.ts:719`). And every input schema is `.strict()`, so an extra
   `sessionId` is **rejected**, not ignored.
6. **The DB claim surface has no slot.** Exactly four claims —
   `tm8.identity_id`, `tm8.actor_id`, `tm8.node_admin`, `tm8.request_id`
   (`identity/claims.ts:37-42`; `db/client.ts:75-79`).
7. **`RequestContext` has no session field.** `RequestIdentity` carries
   `kind | identityId | actorId | token` (`http/types.ts:22-30`); `RequestContext`
   adds `op, params, query, body, requestId, identity, headers, method, path`
   (`types.ts:33-55`). Nothing else.

Consequently `resolveAuthoredFromWorkSessionId`
(`services/w2/messages-handoffs.ts:89`) is a declared optional hook with **no
door at the composition root** — `facade/index.ts:92` exposes only
`messageDelivery`. That absence is **pinned by a compile-time test**:

```ts
// packages/server/test/w5/surface/composition-seams.test.ts:105-112
const NO_DOOR_AUTHORED_FROM: Door<'resolveAuthoredFromWorkSessionId'> = false;
const HAS_DOOR_MESSAGE_DELIVERY: Door<'messageDelivery'> = true;   // negative control
```

So the gap is deliberately fenced. Closing it means updating that tripwire —
which is the correct design, but means this is a known-and-recorded gap, not an
oversight.

### 1a. The blocker that survives fixing all seven

Even with the session id plumbed end to end, **the write would still be
refused.** All three `authored_from` recorders require a `participates_in` edge
from the acting actor to the session:

```sql
-- db/migrations/056_entity_memory.sql:499-514  (message: 019:437; artifact: 055:476)
if p_work_session_id is not null then
  perform 1 from public.entities e … where e.id = p_work_session_id …
     and exists (select 1 from public.edges edge
                  where edge.src_id = actor and edge.dst_id = p_work_session_id
                    and edge.type = 'participates_in')
  …
  if not found then
    raise exception 'authored_from provenance does not match the acting session'
      using errcode = '42501';
```

**`execution_spawn` never creates that edge.** It writes `working_on`
(session→task) and `relates_to` (session→team_member)
(`048_work_session_spawn_parent.sql:90-100`). `participates_in` is written by
only two things — the one-shot 015 backfill (`015:1896`) and the admin RPC
`repair_w1_foundations` (`015:1936`) — and **nothing in `packages/server/src` or
`packages/execution/src` calls either.** Measured: **1 row in the whole
database**, `origin: backfill`.

And it would fail on kind anyway: `participates_in.src_kinds = ['team_member']`
(`015:39`), while the acting actor today is the owner's `member` row (§1b).

There is a matching latent inconsistency: `guard_w1_edge` enforces that *a live
work session must retain one participant* (`052:166-180`) — but only on
UPDATE/DELETE. Since spawn never creates one, all 7 running sessions violate the
intended invariant silently.

### 1b. The identity half is broken too, independently

`tm8 identity get` from inside this very agent session:

```json
{ "displayName": "Owner", "isOwner": true, "actingAs": null }
```

`actingAs` is a built impersonation seam that is null. `composeEnv`
(`manifest.ts:565`) sets `TM8_TEAM_MEMBER_ID` but **not `TM8_ACTOR_ID`**, and
never mints `TM8_AGENT_TOKEN` — both of which the CLI already reads
(`context.ts:83, 85`). So every mutation body omits `actorId` and writes
attribute to the loopback owner. The data shows the damage: **165 of 169
messages attribute to a human member**; only 4 to any `team_member`.

This matters for derivation twice over: it is *why* `participates_in`'s kind
guard would reject the actor, and it means **the actor dimension cannot
distinguish agent work from human work** for existing rows either.

### 1c. Partial plumbing already exists on three operations

Three inputs already accept a session id on the wire, and the CLI never
populates any of them:

- `ArtifactsCreateInput.sourceWorkSessionId` (`schemas.ts:1067`)
- `ArtifactsPublishInput.sourceWorkSessionId` (`schemas.ts:1078`)
- memory `content.workSessionId` (`schemas.ts:695`;
  `entities-commands-tracking.ts:1046`)

`PostMessageInput` has no provenance field at all — it is meant to be
server-derived. So the wire-level pattern is already chosen for two of the three
kinds that can carry `authored_from`; only the caller is missing.

---

## 2. What the graph records today (measured)

31 edge types registered; these 9 exist:

| type | src → dst | n | `props.origin` |
|---|---|---:|---|
| `relates_to` | work_session → team_member | 151 | *(unstamped)* |
| `in_project` | work_session → project | 136 | `spawn` (135), `backfill` (1) |
| `working_on` | work_session → task | 111 | *(unstamped)* |
| `working_on` | member → task | 2 | *(unstamped)* |
| `completed_by` | task → team_member (14) / member (5) | 19 | *(unstamped)* |
| `selected_profile` | work_session → interaction_profile | 14 | `materialized` |
| `attached_to` | doc → task (8), doc → work_session (2), memory → team_member (1) | 11 | *(unstamped)* |
| `tracks` | task → pull_request (1) / commit (1) | 2 | *(unstamped)* |
| `supersedes` | memory → memory | 1 | *(unstamped)* |
| `participates_in` | team_member → work_session | 1 | `backfill` |

**22 edge types have never been written**, including every one that would carry
provenance or intent: `authored_from`, `assigned_to`, `about`, `based_on`,
`remembers`, `shared_into`, `in_worktree`, `equips`, `contains`, `depends_on`,
`member_of`, `visible_to`, `pulled`, `copy_of`, `disputes`, `verifies`,
`approved_by`, `approval_requested_from`, `defaults_to_profile`, `likes`,
`dislikes`, `stars`.

### 2a. Three live defects visible in that table

- **`relates_to` is doing `participates_in`'s job, backwards.** Spawn writes 151
  `work_session —relates_to→ team_member` edges. The registry has
  `participates_in` (`team_member → work_session`) for exactly this, with 1 row.
  So the session↔teammate relation lives in the generic escape-hatch type, in
  the wrong direction, indistinguishable from a user-drawn "these are vaguely
  related" link — **and its absence is what blocks `authored_from` (§1a).**
- **Only `in_project` gets stamped.** The origin-stamping branch covers
  `in_project`, `participates_in`, `in_worktree` (`052:137`). Spawn also writes
  `working_on` and `relates_to`, neither in that list, so **264 machine-written
  edges are indistinguishable from hand-drawn ones.** You cannot currently ask
  "which edges did the system derive?"
- **`working_on` is 38 short.** 151 sessions have manifest tasks; 111
  session→task edges exist.

### 2b. Hierarchy is clean and is not a substitute

`entities.parent_id` is populated 54 times and is **strictly homogeneous**:
doc→doc (24), task→task (13), work_session→work_session (10), message→message
(7). Zero heterogeneous parentage — the validator requires **same kind**
(`001:379-421`), and `memory` is refused hierarchy outright (`056:98-109`).

So **every cross-kind relation must be an edge or a side table; `parent_id` will
never carry one.** The one session relation it does carry is spawn parentage
from `--parent-session` (`048:81-83`) — the single derived session-relation that
works end to end today.

---

## 3. Tier 1 — derivable *right now*, from data already in Postgres

No new capture. Backfill + a trigger. Each count measured.

| # | Source of truth | Derived edge | Available | Edge type? |
|---|---|---|---:|---|
| 1 | `messages.anchor_id` | message → anchor | **170** | **no** |
| 2 | `messages.mentions[]` | message → mentioned actor/entity | **26** | no (`relates_to` fits) |
| 3 | `session_message_deliveries` (src,dst session) | session → session | **0** ⚠ see §3b | **no** |
| 4 | `session_manifests.manifest.agent.teamMemberId` | `participates_in` | **151** | **yes — and §1a depends on it** |
| 5 | `session_manifests.manifest.tasks[]` | `working_on` | 151 | yes (111 written) |
| 6 | `work_sessions.project_id` | `in_project` | 136 | yes — **already done** |
| 7 | `session_handoffs.source_entity_id → target_work_session_id` | `shared_into` | 0 today | **yes, exact match** |
| 8 | `worktree_allocations.lease_session_id` | `in_worktree` | 0 today | **yes, exact match** |
| 9 | `work_sessions.transcript_doc_id` | session → doc | 0 today | no |
| 10 | `attention_requests` (`requested_by`, `entity_id`) | actor → entity | 2 | no |
| 11 | `artifact_bundle_revisions.published_by` | actor → artifact | 1 | no |

**#4 is the highest-leverage item in this document.** It is pure backfill from
data already stored, it costs nothing, and it is the precondition that unblocks
`authored_from` for all three recorder kinds (§1a). Nothing else in Tier 2 can
land before it.

### 3a. #1 is the biggest hole in the graph

170 messages exist. Every one has a `NOT NULL` `anchor_id` FK to an entity. **No
edge represents it, and no edge type exists that could.** Measured:

```
$ tm8 graph query --focus <channel with 14 messages> --hops 2
  nodes: 1   edges: 0
```

A channel — the most conversation-dense kind there is — is a **graph isolate**.
Its 14 messages are unreachable by traversal. The task in the sibling space
carrying 17 messages has 11 edges, none of them message edges.

This is the concrete answer to the task's own example ("a session creates a doc
and attaches it to a task"). Attachment of *docs* works (`attached_to`, 8 rows).
Attachment of *conversation* — where nearly all agent output actually lands —
does not exist in the graph at all.

### 3b. #3 — CORRECTED: the coordination graph is not recorded at all

My first pass claimed 67 deliveries across **25 distinct session pairs**. That was
wrong, and the error is worth naming: `count(distinct (a,b))` counts a `(NULL, x)`
row constructor as a value, so it counted **25 distinct targets with no known
sender**. Measured properly, `source_work_session_id` is **NULL in all 67 rows**.

The reason is the punchline: that column is fed by
`resolveAuthoredFromWorkSessionId` (`messages-handoffs.ts:307` → `:325`) — the
same unwired composition-root seam that keeps `authored_from` empty. **One seam,
two symptoms.** So session→session is not a Tier 1 derivation at all; it belongs
in Tier 2. Migration 065 registers the `messaged` edge type and its trigger
anyway, so the delegation graph starts populating the moment that resolver is
wired, with no further migration.

### 3c. What is *not* derivable in Tier 1, despite looking like it is

- **`about` (memory → subject).** `memories.subject_scope` is **prose**, e.g.
  *"The tm8 CLI as of 2026-07-31, for every command, now that more than one
  instance exists on the machine."* It names no entity id. All 8 memories are
  like this; `about` has 0 rows. Deriving it needs NL extraction — **not a "for
  sure" derivation.** Do not put it in a trigger.
- **`based_on` (memory → evidence, version-pinned).** Nothing stores the
  evidence set. New capture at authoring time only.
- **`assigned_to`.** `tasks` has no assignee column — assignment *is* the edge,
  and the edge has 0 rows. Nothing to derive from; a missing feature, not a
  missing projection.
- **`entity_versions.changed_by`** (148 distinct actor↔entity pairs) and the 421
  `activity` rows are a complete *event* log and should stay events. An "actor
  edited entity" edge would be an unbounded, low-signal edge class. `activity`
  already carries `verb`, `ref_id` and `summary` — `{type, dstId}` for the 15
  `linked` rows, i.e. **`activity` is already a complete edge-creation log.**

---

## 4. Tier 2 — derivable only once the session reaches the server

This is the task's actual ask. Once §1's breaks are closed, **one universal rule**
becomes available:

> Every entity created by a request carrying a verified session id gets
> `entity —authored_from→ work_session`, `props.origin = 'materialized'`,
> writer-owned and immutable.

**The mechanism already exists and is fully reasoned.** The 052 guard implements
a writer-token model (`SET LOCAL tm8.w1_writer`, `015:310-316`) plus
`props.origin` stamping, with a deliberate split between

- **immutable provenance** — `authored_from`, `shared_into`, `selected_profile`,
  `defaults_to_profile`: recorder-owned, one per source, unique-indexed
  (`052:117-127`), and
- **mutable association** — `in_project`, `in_worktree`: stamped with origin but
  correctable through generic `edges.create` / `edges.delete`, because
  *"putting it here would freeze filing errors into permanent facts"*
  (`052:111-116`).

That is exactly the right distinction for derived edges, already written down,
with `in_project` at 135 `origin: spawn` rows as the working precedent. **The
framework is built; almost nothing is plugged into it.** The designed fix is
also already specified — `TM8-IDENTITY-DESIGN.md:104` adds `workSessionId?` to
the envelope, `:124` adds a `tm8.work_session_id` claim, `:205` has `composeEnv`
export `TM8_ACTOR_ID`.

**One registry change is unavoidable.** `authored_from.src_kinds` is
`{message, memory, artifact}` (`052:49-54`). A doc, task, channel, collection,
file, spell, skill, PR or commit **cannot carry an `authored_from` edge at all** —
`internal.validate_edge` (`001:806-812`) refuses it. So "every entity knows its
session" requires widening `src_kinds`, not just wiring a resolver.

### 4a. Retroactive backfill is impossible — do not plan for it

I tested time-overlap attribution against `work_sessions.started_at … exited_at`
(populated: 106 exited, 38 failed, 7 running):

| kind | total | inside exactly 1 live session | inside ≥2 (ambiguous) | inside 0 |
|---|---:|---:|---:|---:|
| message | 170 | **9** | **154** | 7 |
| task | 53 | 12 | 32 | 9 |
| doc | 39 | 1 | 24 | 14 |
| memory | 8 | 0 | 8 | 0 |
| artifact | 1 | 0 | 1 | 0 |

Peak concurrency is **49 simultaneous sessions**. ~90% of history is permanently
unattributable.

The ledgers do not rescue it either: `command_ledger` has
`client_mutation_id, identity_id, actor_id, operation, result` — **no session
column** — and a **24-hour** TTL (`004:151-159`). `workspace_events` (3293 rows)
has no actor and no session, and a **7-day** TTL (`003:404-412`).

**Session provenance is forward-capture-only.** Any plan assuming a backfill
will reconstruct the past is wrong.

---

## 5. Tier 3 — the second-order derivations (the "multiple interactions" question)

These need no new storage beyond Tier 1+2. They are joins. This is the honest
answer to *"what can we derive for sure"*.

**Session-rooted:**

1. **Blast radius of a session** — every entity `authored_from` it. The unit of
   "what did this agent actually do". *Blocked on Tier 2.*
2. **Session → project, two ways** — declared (`in_project`, 136) vs inferred
   (`working_on` → task → task's project). Disagreement is a detectable bug.
   ⚠ **Trap:** `TM8_PROJECT_ID` is a `projects.id` (node-global), **not an
   entity id**. One `projects.id` maps to **many** `project_entity_id`s —
   `019faef9-…` ("workspace") maps to 3 project entities across 3 spaces.
   Derivation must route through `project_links`, never assume the manifest id
   is an entity. (Also note the **cap of 16** live `in_project` associations per
   session, `052:208-211`.)
3. **Session lineage** — parent (works today, `parent_id`), sibling (same task),
   peer (`session_message_deliveries`, Tier 1 #3). Gives the delegation tree.

**Task-rooted:**

4. **Everything a task produced** — task ← `working_on` ← sessions →
   `authored_from` ← docs/messages/artifacts/memories. Today: 0 recoverable.
5. **Task effort** — Σ (`exited_at` − `started_at`) over sessions `working_on`
   it. **Derivable today** (111 edges + populated timestamps). Nothing consumes it.
6. **Task handoff chain** — sessions on one task ordered by `started_at`: who
   picked it up, who dropped it, where it stalled. **Derivable today.**
7. **Task conversation** — messages anchored to the task. *Blocked on Tier 1 #1.*

**Actor-rooted:**

8. **What a teammate actually did** — teammate → sessions → entities. Reachable
   today only through the mis-typed `relates_to` hop, and poisoned by §1b.
9. **Teammate collaboration** — teammates whose sessions shared a task or
   exchanged deliveries.

**Cross-cutting:**

10. **Machine vs human provenance** — `props.origin` partitions the graph, *if*
    stamping extends past `in_project` (§2a).
11. **Independent-verification invariant.** This one is stronger than I expected:
    the guard is **already implemented**. `internal.guard_verifies_semantics`
    (`056:267-350`) requires two-tier independence — `independenceBasis` must be
    `'session'` when both sides carry `authored_from` and `'actor'` when either
    is missing, with the evidence's authoring session required to differ from the
    target's. Because `authored_from` is empty, it **permanently degrades to the
    weaker actor tier**, and §1b means even that collapses (everyone is Owner).
    Tier 2 upgrades a coded-but-toothless invariant into a real one.
12. **Project rollup for every entity** — transitively via the authoring
    session, instead of only sessions/PRs/commits/artifacts being in a project.

---

## 6. What is not derivable at all, and needs new capture

State this plainly so nobody plans around it:

- **Causation between commands.** No session id and no parent/causation id
  anywhere in `command_ledger` or `workspace_events`. You cannot reconstruct
  "this write happened because of that one", and you cannot use the ledger as a
  fallback for Tier 2. (Both are also TTL'd — 24h and 7d.)
- **Agent vs human authorship of existing writes.** Lost (§1b).
- **Memory subject and evidence links** (§3c) — authoring-time capture only.
- **Task assignment** — the feature does not exist.

---

## 7. Recommended order, smallest correct step first

**Independent of session plumbing — can land immediately:**

1. **Backfill `participates_in` from `session_manifests`** (Tier 1 #4, 151 rows).
   Cheap, pure projection, and **the precondition every `authored_from` recorder
   already checks** (§1a). Also fixes the silently-violated
   "live session retains one participant" invariant. Do this first.
2. **Have `execution_spawn` write `participates_in` going forward**, so #1 is a
   one-time backfill rather than a recurring one. Note the src_kind is
   `team_member`, which forces §1b to be addressed for agent-actor writes.
3. **Register a message→anchor edge type and backfill 170 rows** (§3a). Highest
   graph-value-per-unit-effort in the whole list.
4. **Register a session→session type and backfill 25 pairs** from
   `session_message_deliveries` (§3b).
5. **Retire `relates_to` for session↔teammate, and add `working_on` /
   `relates_to` to the origin-stamping list** (`052:137`), so derived edges are
   labelled as derived (§2a).

**Requires the session on the wire:**

6. **Add `workSessionId` to the envelope + a `tm8.work_session_id` claim**, and
   have the CLI send `TM8_SESSION_ID` on every mutation. The server must
   **verify** the claim against `participates_in`, not trust it — today any
   caller could claim any session because everyone is the owner. This should
   land with, or behind, the agent-token work (§1b). Design already exists at
   `TM8-IDENTITY-DESIGN.md:104,124,205`.
7. **Open the `resolveAuthoredFromWorkSessionId` door** at `facade/index.ts` and
   update the compile-time tripwire at `composition-seams.test.ts:105`. Populate
   `activity.work_session_id` on the same path — the sole writer
   `internal.record_activity` (`003:47-54`) just needs the parameter.
8. **Widen `authored_from.src_kinds`** beyond `{message, memory, artifact}`
   (§4). Without this, most kinds still cannot carry provenance.
9. Then the empty-but-exact mappings: `shared_into` from `session_handoffs`,
   `in_worktree` from `worktree_allocations`.

Steps 1–5 are worth doing regardless of whether 6–9 are ever scheduled.

---

## Appendix — full registry, for reference

**19 entity kinds** (registry table `entity_kinds`; there is no CHECK constraint
on `entities.kind`): `channel, task, message, member, team_member, doc, file,
spell, skill, pull_request, commit, work_session, collection` (all `001:312-324`),
`project`, `interaction_profile` (`015:30-31`), `voice_channel` (`053:51`),
`artifact` (`055:45`), `memory` (`056:54`), `worktree` (`057:41`). Custom kinds
are namespaced `c:*` and space-scoped.

**31 edge types** (`tm8 edge type list`), src → dst:

```
about                    memory -> *
approval_requested_from  task -> member,team_member
approved_by              task -> member,team_member
assigned_to              task -> member,team_member
attached_to              task,member,team_member,doc,file,spell,skill,pull_request,
                         commit,work_session,collection,memory,artifact -> *
authored_from            message,memory,artifact -> work_session
based_on                 memory -> *                      [append_only]
completed_by             task -> member,team_member
contains                 collection -> *
copy_of                  * -> *                           [append_only]
defaults_to_profile      team_member -> interaction_profile
depends_on               * -> *                           [acyclic]
dislikes                 member -> *
disputes                 message,memory -> *              [append_only]
equips                   task,team_member,work_session -> spell,skill
in_project               task,work_session,pull_request,commit,artifact -> project
in_worktree              task,work_session,pull_request,commit -> worktree
likes                    member -> *
member_of                team_member -> team_member
participates_in          team_member -> work_session
pulled                   member,team_member -> channel,task,doc,file,spell,skill,collection
relates_to               * -> *
remembers                member,team_member,work_session -> memory
selected_profile         work_session -> interaction_profile
shared_into              * -> work_session
stars                    member -> *
supersedes               memory -> memory                 [acyclic, append_only]
tracks                   task -> pull_request,commit
verifies                 message,memory -> *              [append_only]
visible_to               * -> member,team_member
working_on               member,team_member,work_session -> task
```

**Every edge type is directed** — one `(src_id, dst_id)` row, no materialized
inverse. `relates_to` and `member_of` are conceptually symmetric but stored
one-way; read paths pick a direction per type (`entity-read.ts:501-502`).
Unregistered types are allowed **only** under the `x:*` namespace, and get **no
endpoint-kind constraints at all** (`001:806-812`).

**`edges` schema** (`001:751-776`): `id, space_id, src_id, dst_id, type,
props jsonb, created_by, created_at, updated_at`. No `deleted_at`, no
`metadata`, no ordering column — `contains` ordering lives in `props.position`.
Unique on `(src_id, dst_id, type)`, plus partial unique indexes on `src_id` for
`authored_from`, `selected_profile`, `defaults_to_profile`, and on
`(src_id, dst_id)` for `participates_in`. Append-only via
`edges_append_only_guard` (`056:172-193`), with a `pg_trigger_depth() > 1`
exemption for the purge cascade. RLS gives `tm8_app` **SELECT only**; all writes
go through SECURITY DEFINER RPCs (`write_edge` / `update_edge` / `delete_edge` /
`place_entity`).

**13 triggers**, alphabetically ordered on purpose: `edges_props_schema` <
`edges_validate` < `edges_verifies_semantic_guard` < `edges_w1_guard`.

**Cardinality rules:**

| rule | mechanism |
|---|---|
| ≤1 edge per `(src,dst,type)` | `edges_src_id_dst_id_type_key` (`001:772`) |
| `participates_in`: ≤1 per (src,dst) pair, any type | `edges_participates_pair_idx` (`015:293`) |
| `participates_in`: ≥1 per live session | `guard_w1_edge` (`052:166-180`) |
| `authored_from`: **exactly one per source entity, globally** | `edges_authored_from_source_idx` (`015:295` / renamed `052:73`) |
| `defaults_to_profile` / `selected_profile`: one per source | `015:297` / `015:299` |
| `in_project`: ≤16 live per work_session | `guard_w1_edge` (`052:208-211`) |
| `in_worktree`: no limit, deliberately | `057:171` |
| `depends_on`, `supersedes` | registry `acyclic = true` → `prevent_edge_cycle` |
