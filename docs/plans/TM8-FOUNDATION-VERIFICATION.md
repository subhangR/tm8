# TM8 Foundation — live-DB verification of the seven cross-cutting claims

Author: foundation worker (`sess_1785455553256_u3iijo8gq`), 2026-07-31.
Companion: `docs/plans/TM8-BUILD-ORDER-AND-OWNERSHIP.md` (the manifest the three
feature lanes follow) and `db/migrations/052_edge_guard_multi_kind.sql` (the
shared prerequisite migration, landed and behavior-proven below).

Every claim below was executed against a **live database built from the current
tree's full migration chain** — not read from source. Where the claim is about a
silent failure, the red case was observed, not inferred.

## The invocation that worked

The 5442 sidecar was already up and auth worked first try (no PG18 locale
refusal encountered this session; the two-clusters hazard is real — always give
psql the full URL, never bare `psql`):

```bash
PATH=/opt/homebrew/opt/postgresql@18/bin:$PATH \
  psql "postgres://tm8@127.0.0.1:5442/<db>" -c "select 1"   # proves auth, not just pg_isready
```

Scratch databases (never touch `tm8_dev` — booting or resetting it is a write
against live sessions):

```bash
PATH=/opt/homebrew/opt/postgresql@18/bin:$PATH \
TM8_DATABASE_URL=postgres://tm8@127.0.0.1:5442/tm8_foundation_verify \
  node db/migrate.mjs reset --force        # 52 migrations ok
```

Claims-bound writes used `db/test/helpers.mjs` (`buildWorld`, transaction-local
`set_config('tm8.identity_id'/'tm8.actor_id'/'tm8.w1_writer', …, true)`) — the
same binding the server uses. Full driver:
`/private/tmp/claude-503/…/scratchpad/foundation-verify.mjs` (scratchpad is
volatile; every result is transcribed here in full).

---

## V1 — the snapshot debounce overwrites history. **VERIFIED, and stronger than claimed.**

Setup: `create_task` through the real RPC (version 1, one snapshot row), then two
direct detail-table writes as the **same actor** inside the 5-minute window.

Observed:

| step | `entities.version` | `entity_versions` rows |
|---|---|---|
| after create | 1 | `[1]` |
| after write 1 | 2 | `[2]` — the **creation snapshot was renumbered**, not appended |
| after write 2 | 3 | `[3]` — one row total, title `debounce write two` |

Integer versions **1 and 2 exist with no snapshot row behind them**. The claim
said a second write renumbers the previous write's snapshot; in fact the window
also swallows the *initial creation* snapshot (`record_initial_version` writes
`changed_by = actor`, so the first edit debounces against it). A pinned
`pinnedVersion = 1` or `= 2` here dangles immediately.

Configurability: **not configurable, per kind or otherwise.**
`internal.version_debounce_window()` is a zero-argument `immutable` SQL constant
(`select interval '5 minutes'`), defined once in 001 and never redefined
(verified via `pg_get_functiondef` against the live chain, per the rule that a
migration file is not the definition of its own function). Worktrees §2.4's
consequence (rapid `active → merged → deleted` under one actor collapses to one
snapshot row) stands exactly as written, and applies to the *creation* snapshot
too.

## V2 — `authored_from` has three gates, not one. **VERIFIED — all three observed individually.**

Substrate: real message + work_session entities; edges inserted as owner with
claims bound (the guard reads the `tm8.w1_writer` claim, not the role, so owner
inserts exercise it identically).

1. **Writer ownership**: legal kinds (`message → work_session`), no writer token →
   `SQLSTATE 42501: edge type authored_from is recorder/configuration owned`.
   Widening `src_kinds` alone is provably not sufficient.
2. **One-per-source unique index**: with the correct writer token, a second
   `authored_from` from the same src → `SQLSTATE 23505: duplicate key value
   violates unique constraint` (post-052 the index is
   `edges_authored_from_source_idx`; predicate unchanged).
3. **`props.origin` is server-owned**, two halves:
   - sending `origin` on a non-recorder-owned type (`copy_of`) with no writer →
     `SQLSTATE 42501: edge props.origin is Server-owned` (isolated — on
     `authored_from` itself the recorder gate fires first, so this half can only
     be observed on another type);
   - with a valid writer, a client-sent `origin: "forged"` is **silently
     overwritten**: the stored edge came back `origin = materialized`.

Post-052 the writer equality is a per-type set: `memory_recorder` and
`artifact_publisher` were observed **accepted** (origin stamped `materialized`),
`worktree_manager` observed **refused** on `authored_from` (correct — it was
claimed for `in_worktree` stamping, not recorder ownership).

## V3 — `internal.entity_content()` falls through to `{}` silently. **VERIFIED as a mechanism, with one correction to the folklore.**

Red case, observed: in a rolled-back transaction, seed an `entity_kinds` row for
a kind with no arm (`worktree`, simulating exactly the feature-lane omission),
create an entity of it, call the function:

```
entity_content for arm-less kind worktree: {}      -- nothing raised
```

Correction: **every currently-seeded kind has an arm.** The live definition is
017's (15 arms incl. `project` → `project_projection_details` and
`interaction_profile`; verified via `pg_get_functiondef`, and my scratch driver's
first run mischaracterized this — corrected by reading the actual definition). A
real project entity returned real content, not `{}`. So the hazard is entirely
**prospective**: it fires for the three new kinds if a lane forgets its arm, and
nothing will raise. Each feature migration must carry its `entity_content()` arm
(the worktrees design already names this; memories and artifacts must too).

## V4 — the append-only edge trigger vs. the entity purge cascade. **REFUTED. The cascade does NOT survive; purge breaks at its last step.**

Modelled the memories design exactly (D2): `edge_types.append_only` column +
`before update or delete` row trigger on `public.edges` raising `23514` for
flagged types; flagged `copy_of`; created a `doc —copy_of→ task` edge.

- Red case for the trigger itself: direct `UPDATE` → `23514`; direct `DELETE` →
  `23514`. The trigger works.
- **The claim under test**: `delete from public.entities where id = <src>` (as
  the table owner, superuser even) →
  `ERROR: 23514 edge type copy_of is append-only` — **the purge was refused and
  the edge row survived.**

A FK `on delete cascade` fires the referencing table's row triggers as part of
the same statement; who owns the table is irrelevant because the trigger checks
the edge type's flag, not the role. "The cascade fires as the table owner rather
than `tm8_app`, so it still works" is false at the mechanism level.

**What this invalidates, by name:**

- **Artifacts design §5.1**, the load-bearing note on `artifact_bundle_revisions`
  ("The cascade fires as the table owner rather than `tm8_app`, so it still
  works — but the migration's own test must prove that"). The test it demanded
  now exists and proves the opposite. An unconditional append-only trigger on
  revisions makes artifact-entity purge fail at its last step.
- **Memories design D2** (the `public.edges` trigger, §"Enforcement is a
  row-level trigger"): same mechanism, and *worse* reach — `spaces → entities`
  and `entities → edges` are both `on delete cascade` **today**, so once the
  trigger lands, deleting a **space** that contains any append-only edge fails,
  not just some future entity purge.

**Required correction (both lanes):** the trigger needs an explicit purge
exemption — e.g. permit `DELETE` when `pg_trigger_depth() > 0` (a cascaded
delete runs inside the FK's internal trigger; a direct client delete runs at
depth 0), or a dedicated writer claim set only by the purge/space-delete door —
**plus a red/green pair**: cascade-succeeds test AND direct-delete-refused test.
Neither design currently budgets this.

## V5 — snapshot triggers are per-table opt-in; 015 attaches none. **HALF REFUTED.**

- **Verified**: `internal.snapshot_entity_version` is attached to **exactly 11**
  tables (live `pg_trigger` query): `channels, collections, commits,
  custom_entities, documents, files, pull_requests, skills, spells, tasks,
  team_members`. No event trigger, no registry-driven attachment; neither of
  015's detail tables is in the list. Per-table opt-in confirmed.
- **Refuted**: "015 never calls `record_initial_version`, so `project` entities
  have **no `entity_versions` rows at all**." True of 015 in isolation; false in
  the live chain: **migration 021 rebuilt the projection materializer and calls
  `internal.record_initial_version` (021:159)**. Observed: the project entity
  has `entities.version = 1` and **exactly one** `entity_versions` row.
- The consequence half survives in weakened form: with no snapshot trigger on
  `project_projection_details`, a project entity's version never advances past
  creation.

Invalidates the precedent citation in the worktrees seam memo (W2: "015 also
never calls record_initial_version, so a project entity has no entity_versions
rows at all") and its restatement in the worktrees design. The lane's *plan* is
unchanged — detail table with literal `entity_id`/`updated_at` columns, the
snapshot trigger, and `record_initial_version` in the create door are all still
required — but cite 021, not 015, as the projection-kind precedent.

## V6 — the entity-read/projector parity gap. **CONFIRMED — and the live asymmetry is the mirror image of the claim.**

No test enforced parity: only prose comments (`projector.ts` titleOf doc:
"The other one is `titleOf` in `facade/entity-read.ts`") and a two-kind spot
check (`w1-contract-compat.test.ts:338`, project + interaction_profile only).
Confirmed by grep and by reading both files' dispatch sites.

The actual gap today runs the **other way**: `projector.ts` dispatches all 15
committed kinds; `entity-read.ts` dispatches 11 — **`spell`, `skill`,
`pull_request`, `commit` fall to its `default:` arms** (title = the raw kind
string, no typed state) over REST while rendering fully in the event feed.

Live catch during this verification: **`voice_channel`** entered the
`CoreEntityKind` union mid-session (the in-flight voice-channels lane,
`task_1785455843956_v7p4zpymk`) with an arm in **neither** file — exactly the
bug class the brief predicted, caught in real time.

**Deliverable landed**:
`packages/server/test/events/projector-entity-read-parity.test.ts` — parses the
union from contract source (no runtime kind array exists, and vitest does not
type-check, so `satisfies` tricks would be read by nobody), extracts `case`-arm
kinds from both files, and asserts: every union kind is in the projector; read ⊆
projector; projector ⊆ read modulo a **frozen** 4-kind legacy set that may only
shrink; and a named **in-flight** exception (`voice_channel` → its owning task)
that a dedicated test evicts the moment both arms land. 6/6 green
(`RUN v2.1.9 …/packages/server`), typechecked separately via scratch tsconfig
(probe-verified: an injected type error was reported, then removed).

## V7 — does the conformance manifest snapshot function bodies? **REFUTED — no regeneration needed for the guard swap.**

`tools/conformance/generated/w1-conformance-manifest.json` contains **zero**
occurrences of `guard_w1_edge`, `create or replace function`, `plpgsql`, or any
`internal.` name. Its `migration` section is: `sha256` of the **015 file** plus
object **names/counts** only (tables, kind seeds, edge-type seed names, index
and trigger *counts*, RPC names). `migration-inventory.ts` freezes 015's file
digest — a **new** migration replacing the function touches neither.

So: **replacing `internal.guard_w1_edge` in 052 requires no manifest work**, and
no design needs the unbudgeted regeneration the brief worried about. What *does*
force regeneration is `catalogDigest = sha256(JSON.stringify(OPERATIONS))` — any
catalog row addition. That lands on the artifacts lane (+6) and on the voice
lane (+1, currently mid-sweep and red — see the build-order doc §catalog).

---

## Bonus findings (not in the brief, discovered while verifying)

1. **The tree's `db/test` suite is red before any of this work**: 17 of 61 tests
   fail (`node --test db/test/*.test.mjs`), failure family = `post_message` —
   migration **019 deliberately revoked** `public.post_message` from `tm8_app`
   (019:1321-1324, replaced by the `w2_post_message_batch` door) and the suite
   still calls it, dragging down the event-seq/rls/loop suites that post
   messages. `HOW-TO-TEST.md` §4's "76 passed" is stale. **052 attribution is
   clean**: two fresh databases, chain-with-052 vs chain-without, produce
   **byte-identical failure name sets** (17 = 17, diff shows only timings).
2. **The catalog moved mid-session**: 111 in the tree as of this writing
   (106 committed + 4 `attentionRequests.*` + 1 `voice.token.create`), and the
   voice lane's count sweep is incomplete — 12 failures in `packages/cli`
   (catalog-exhaustiveness et al. still assert 110; the conformance digest
   cross-check disagrees). Details and the delta-based gate rule are in the
   build-order doc.
