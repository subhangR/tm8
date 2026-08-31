# DEAD-FEATURES — tm8 platform audit

**Date:** 2026-08-31 · **Branch:** `calm/integrate` (6 commits ahead of origin) · **Node:** tm8-server
**Live prod:** `https://127.0.0.1:7777` → nginx → `127.0.0.1:17777`, PID 1770944, `/opt/tm8/prod/packages/server/dist/index.js`
**Live prod DB:** `tm8_prod` @ `127.0.0.1:5442` (**not** `tm8_stable` — see F13)

Everything below was verified read-only. No database was written, no service restarted, nothing built or
deployed. **Two files were authored — this one and `db/migrations/176_repo_slug_from_url_ownership.sql`
(NOT applied). No existing file was modified.** Note this worktree is shared and was already dirty on
arrival; the modified files under `packages/tm8_ui_2.0/` are a sibling's in-flight work, untouched here.

## What "does not work" means here

This audit separates four things that look alike in a grep and are not alike at all:

1. **Dead** — no importer, no route, no dist, no rows, no reader. Delete it.
2. **Broken** — it is wired, it runs, and it fails every time. Fix it.
3. **Hollow** — a reader with no writer, so a real surface renders permanently empty and reads as
   "no data" rather than "not built". Fix or label.
4. **Honestly incomplete** — a stated refusal, a reserved operation, a documented inert marker.
   **This is correct behaviour and is NOT reported as a defect.** This codebase does a lot of it
   deliberately and well; three of the four supplied leads turned out to be this.

**F-numbers are stable labels, not priority.** The ranked table at the end of this document carries the
ordering by code and user-visible surface. (F7 grew substantially late in the audit and outranks its
number.)

---

# Part 1 — CONFIRMED

## F1 · `packages/tm8-ui` — 278,796 lines of dead code sitting under a load-bearing production path

**Size:** 1,013 files · 278,796 loc · **342 test files that never run**

**What it claims to be:** the product UI. It has `index.html`, `vite.config.ts`, a PWA shell plugin,
`dev`/`build`/`preview` scripts, and a complete application.

**Evidence it is dead:**

- No `dist/`, `build/`, `out/`, or `.vite/` anywhere in the package. `tsconfig.json` sets
  `"noEmit": true`, so `tsc` *cannot* emit; only `vite build` could, and nothing invokes it.
- **Zero importers.** `grep -E "(from|import\(|require\()\s*['\"](tm8-ui|@tm8/ui)"` across all
  `.ts/.tsx/.mjs/.js` (node_modules excluded) → 0 hits. No `package.json` in any workspace declares it
  as a dependency. No boundary-crossing relative import (`../../tm8-ui/...`) exists. No dynamic import.
- **Not in any build or gate.** Root `build` script omits all UI packages.
  `tools/ci/check.sh:136-141` explicitly excludes it and says why (it declares React 18 against a
  workspace pinned to 19). It is not in `TEST_PACKAGES` (`check.sh:172-198`), so its 342 test files are
  unreachable from CI — a large corpus of tests that **cannot fail**.
- `scripts/lib/ui.mjs:25-28` names it in terms: *"The frozen pre-Astryx 1.0 snapshot. Not served, not
  built, not gated."* — and the constants `UI_1_0_DIR` / `LEGACY_UI_DIR` it exports are themselves
  never imported anywhere.
- `git log` confirms the fork: `672df036 refactor(ui): relocate the product UI to packages/tm8_ui_2.0;
  freeze tm8-ui as the 1.0 snapshot`. `tm8_ui_2.0` is a full **copy**, not a re-export — no alias, no
  `paths`, no `references`, no cross-package CSS `@import`.

**⚠ THE TRAP — read this before deleting anything.** The package's *source* is dead. Its *directory
path* is what production is serving from **right now**:

```
/proc/1770944/environ → TM8_UI_DIR=/opt/tm8/prod/packages/tm8-ui/dist
/opt/tm8/prod/packages/tm8-ui/dist -> ../tm8_ui_2.0/dist        (symlink, created Aug 29 04:49)
readlink -f                        =  /opt/tm8/prod/packages/tm8_ui_2.0/dist

curl -s http://127.0.0.1:17777/ | sha256sum   ad9f1c4a…1200a
…/tm8_ui_2.0/dist/index.html                  ad9f1c4a…1200a   ← MATCH
…/tm8-ui/dist.pre532.20260829-044915/index.html  cf903b40…f38fcb  ← the retired 1.0 bundle
```

`deploy/prod/env.sh:79` is *correct* (`…/tm8_ui_2.0/dist`), but the running process does not use it —
it reads root-owned `/etc/tm8/prod.env`, which still names the old path. An operator bridged the gap
with a symlink one minute after the last start rather than edit a root-owned file and restart.
`deploy/utho/deploy.sh:332-334` already contains the codified `sed` fix for `/etc/tm8/prod.env`; it has
**not** taken effect on this box.

**Consequence:** deleting `packages/tm8-ui` breaks nothing at build time, but the next deploy that
re-syncs `/opt/tm8/prod` removes the symlink, `TM8_UI_DIR` then points at nothing, and **the entire
production UI 404s while the API stays green** — a silent, total, hard-to-diagnose outage.

**Recommendation: DELETE — but strictly in this order.**
1. Fix `/etc/tm8/prod.env` to `packages/tm8_ui_2.0/dist` (needs root).
2. Restart `tm8-prod` — **note this SIGTERMs every agent terminal on the box** (`KillMode=control-group`),
   so it must be scheduled, not done casually.
3. Verify `/proc/<newpid>/environ` shows the new value.
4. *Then* delete the package and drop it from `bun.lock` workspaces.

Deleting first is the failure mode. Also note it still drags a React 18 tree into `bun install` against
a root `overrides` pin of 19.

---

## F2 · `packages/ui` — 53,381 lines that nothing imports but the merge gate still typechecks

**Size:** 353 files · 53,381 loc · **86 test files that never run**

**Evidence:** no `dist` (in the worktree or in `/opt/tm8/prod/packages/ui/`), `"noEmit": true`, zero
importers by any of the same tests as F1, not in the root `build`, not in `TEST_PACKAGES`. Nothing
launches its vite config. `scripts/lib/ui.mjs:25-26` calls it *"The legacy collab-v2 oracle. Not
served, not built, not started."*

**Its one thread of life is real and must not be missed:** `tools/ci/check.sh:124-130` runs
`tsc -b packages/ui` as a **failable merge-gate stage**, and root `bun run typecheck` calls
`typecheck:ui`. So 53k lines of unreachable code are typechecked on every merge — the gate pays for it
and no user ever benefits. Deleting the package deletes a gate stage (it falls to check.sh's `skip`
branch) and drops `react-mentions`, `@xyflow/react`, `dagre`, `@dnd-kit/core` from the install graph.

**Recommendation: DELETE.** It is the single cheapest large win in this audit — no production path
depends on it (unlike F1), so it carries none of F1's ordering risk.

---

## F3 · `tracking.forge-watcher` — 100% failure for 13 days · PR tracking is frozen · **root-caused, fix authored**

**This is the most consequential live defect found.** It is the only genuinely failing job on the node.

**Correction to the brief:** three jobs were reported failing. Only one is.
`/health` right now:

| job | runs | failures | verdict |
|---|---:|---:|---|
| `tracking.observer` | 1845 | 1 | healthy (transient) |
| `tracking.commit_recorder` | 1822 | 2 | healthy (transient) |
| **`tracking.forge-watcher`** | **1231** | **1231** | **100% — never once succeeded** |

`lastError: "permission denied for function repo_slug_from_url"`.

**Root cause — a Postgres ownership bug, reproduced exactly:**

Almost every function in `public`/`internal` is created inside `set role tm8_graph_owner; … reset role;`
(`001_core_graph.sql:68`/`:1230`, restated in ~40 files). **`148_pr_owning_session_space_scope.sql`
omits it.** Postgres therefore made the migration runner — `tm8`, a **superuser** — the owner of the
function that file creates, and 148's grant names only `tm8_app`:

```
 nspname  |        proname         |      owner      | secdef |               proacl
----------+------------------------+-----------------+--------+--------------------------------------
 public   | observer_watch_targets | tm8_graph_owner |   t    | {tm8_graph_owner=X/…,tm8_app=X/…}
 internal | pr_owning_session      | tm8_graph_owner |   f    | (default)
 internal | repo_slug_from_url     | tm8             |   f    | {tm8=X/tm8,tm8_app=X/tm8}   ← wrong owner
```

The failing chain, in full:

```
loops.ts:107  db.rpc('public.observer_watch_targets', …)      ← NOT inside any try/catch
  → public.observer_watch_targets     SECURITY DEFINER, owner tm8_graph_owner
    → internal.pr_owning_session      STABLE, not secdef → still runs as tm8_graph_owner
      → internal.repo_slug_from_url   owner tm8, no grant to tm8_graph_owner
        → ERROR 42501
```

Reproduced read-only against prod:

```sql
=> set role tm8_graph_owner; select internal.repo_slug_from_url('https://github.com/acme/forge.git');
ERROR:  permission denied for function repo_slug_from_url

=> select has_function_privilege('tm8_graph_owner','internal.repo_slug_from_url(text)','execute');
 f
```

**148 reasoned the grant out loud and reasoned it in the wrong direction** (`148:113-116`):
*"tm8_app needs it because `pr_owning_session` is STABLE, not SECURITY DEFINER — the nested call runs
as whoever called the outer function."* True — but the outer function `observer_watch_targets`
**is** SECURITY DEFINER (`103:400`), so "whoever called" is its *definer*, `tm8_graph_owner`, which is
the one role 148 did not grant.

**User-visible consequences, measured in prod:**

- The throwing `rpc` is the **first statement** of the tick, above the per-target try/catch
  (`loops.ts:130-141`) *and* above the nudge drain's own try/catch (`loops.ts:150-158`). So the entire
  tick dies before doing anything.
- **52 open/draft PRs carry a `tracks` edge** and are therefore in the watch list. None is polled.
  PR state, CI status and mergeable state on the UI are frozen at whatever the on-demand observer last
  happened to fetch (`max(pull_requests.fetched_at) = 2026-08-29 18:23`).
- `public.pending_session_nudges` — the queue the drain exists to empty:

  | status | count | oldest | newest | max attempts |
  |---|---:|---|---|---:|
  | delivered | 14 | 2026-08-13 | **2026-08-15** | 1 |
  | retired | 11 | 2026-08-13 | 2026-08-15 | 0 |
  | **pending** | **3** | **2026-08-17** | 2026-08-28 | **0** |

  `attempts = 0` on every pending row is the signature: delivery never *failed*, it was never
  *attempted*, because the drain is unreachable. **The last nudge ever delivered is dated 2026-08-15 —
  three days before migration 148 was applied (2026-08-18 18:14 UTC).** That is the causal fingerprint.

**Recommendation: FIX. Migration authored, NOT applied:**
`db/migrations/176_repo_slug_from_url_ownership.sql`

It changes an owner and a grant, no bodies (following the precedent of `162_set_session_done_grants.sql`),
and carries a `do $verify$` block asserting exactly what it establishes. Number **176** was chosen
because 169, 170, 173, 174 and 175 are all already claimed on other branches — picking from
`origin/main` alone would have collided and hard-failed `migrate.mjs`. All three VERIFY predicates were
validated read-only against prod before the file was written.

> **I did not apply it and did not run the real-DB tests for it** — both are DB writes and out of scope
> for this audit. It needs a run of `packages/server/test/db/*.pg.test.ts` before it lands.

---

## F4 · The capabilities register manufactures 50 phantom gaps

**Where:** `packages/ui/src/real/capabilities.ts` — 163 lines. A TypeScript data table, not a doc.

**What it claims** (lines 2-5): *"The honest gap register. tm8 mounts 80 catalog operations and
implements 28 of them. The other 52 answer a truthful `501 not_implemented` rather than pretending."*

**Ground truth, and it reconciles perfectly:**

- `packages/contract/src/catalog.ts` declares **172** operation rows.
- `router.ts:81` filters `method !== 'WS'` → **171** mounted (the one WS row is `events.subscribe`).
- `registry.size` = **169** implemented. `/health` reports exactly `"operations":171,"implemented":169`.
- The **2** unimplemented are `search.query` (`catalog.ts:129`) and `bridge.fetchBlob` (`catalog.ts:181`),
  both `status: 'reserved'`. `registry.ts:41-46` makes implementing them by accident *impossible*
  (it throws at registration), and `test/w2/reserved-honesty.test.ts:234-256` pins that they return
  `501 not_implemented`, `retryable: false`, routed so 404 is impossible.
  **These two are Category 4 — honest refusals, not defects.**

So the header is wrong by **50 phantom gaps**, and its denominator is off by 91. Of the 32 entries in
`UNIMPLEMENTED`, **30 are outright false** — the backing operation is v1 and registered
(`entities.versions`, `inbox.list`, `inbox.markRead`, `spaces.settings`, `savedViews.list`,
`files.uploadInit`, `entities.move`, `entities.delete`, `edges.patch`, `graph.query`, `tracking.refresh`, …).
The `uploadFile` entry is the costliest: 24 lines of prose asserting handlers that all shipped, still
gating `SessionTerminal`'s clipboard image paste shut.

**It was true when written, and rotted structurally.** `git blame`: the header is `462a1886`,
2026-07-25, when the catalog had exactly 81 rows = 80 HTTP + 1 WS. The catalog then grew 81 → 172 over
five weeks. Two engineers corrected individual *entries* (2026-08-07, 2026-08-20) while walking past the
summary three lines above. Two structural causes: its self-sync instruction points at
`http://127.0.0.1:4620/health`, a port only its original author had; and `packages/ui` is absent from
`TEST_PACKAGES`, so its `mapping.test.ts` has never run in CI — **a stale comment typechecks fine.**

**Severity is contained:** it renders to a user via `ModeBanner.tsx:106` — *"{32} operations not built
on this node"* — but `packages/ui` is never served (F2), so no user ever reads it.

**Note the half that is still right:** `HOLLOW_FIELDS` (12 entries) remains substantially **accurate** —
verified against current server source: `entity-read.ts:1915` `autoTabs: []`, `:1350` `taskDoneCount: 0`,
`:1947` `transcriptDoc: null`, `handlers/spaces.ts:55` `unreadTotal: null`, `events/projector.ts:1098`
`liveWork: null`. That is a genuine Category-3 list and it is doing its job.

**Recommendation: DELETE with `packages/ui` (F2).** Do not regenerate it — regenerating from `/health`
would emit an *empty* `UNIMPLEMENTED` list, which would be newly wrong in the opposite direction: all 32
names are still true statements about `RealFacade` (`RealFacade.ts:312` really does `return emptyPage()`;
`:505-544` really do `return notImplemented(…)`). The register's actual error is that it attributes a
**UI wiring gap to the server**. If the package is kept instead, the minimal honest edit is three lines:
the docblock, the type comment at line 28, and `ModeBanner.tsx:106` → *"facade methods not wired in this
UI"*. `mapping.test.ts` asserts membership, never counts, so it stays green either way.

*I deliberately did not make that 3-line edit: patching prose in a package this audit recommends
deleting adds diff noise to a branch with 6 unpushed commits, and the string is not reachable by any user.*

---

## F5 · Production talks to GitHub anonymously — and one PR fact type can never be collected

**Evidence:**

`resolveGithubToken()` (`packages/server/src/tracking/github.ts:727-731`) reads **process env only**:

```ts
return env.TM8_GITHUB_TOKEN?.trim() || env.GITHUB_TOKEN?.trim() || env.GH_TOKEN?.trim() || undefined;
```

`/proc/1770944/environ` contains **none of those three**. Its only two callers are
`loops.ts:105` and `observer.ts:89` — i.e. every server-side GitHub call in production is
**unauthenticated, at GitHub's 60 requests/hour anonymous ceiling** instead of 5,000.

**Two distinct consequences:**

1. **REST degrades silently** (`github.ts:136` — the `authorization` header is simply omitted). This is
   the mechanism behind a failure already recorded in prod data. From
   `public.tracking_refresh_requests`:
   `"stopped by operator (backfill): 98 targets cannot finish inside the observer's 120s job timeout
   (~58 targets/tick observed)"` — and a second row `"retired after 5 attempts"`. Rate-limit state is
   surfaced nowhere.

2. **GraphQL refuses outright** — `github.ts:360-361`:
   `if (!this.token) return { ok: false, reason: 'unauthorized', detail: 'graphql requires a token' }`.
   Review threads are GraphQL-only (`github.ts:352`, called from `loops.ts:295`). The table proves it:

   | table | rows |
   |---|---:|
   | `pr_check_facts` | 76 |
   | **`pr_review_thread_facts`** | **0** |
   | `provider_etags` | 107 |

   Checks (REST) work. **Review threads have never produced a single row in production.** The writer
   exists and is correct; it can never run on this node's configuration. That is a
   schema-with-an-unreachable-writer.

**Recommendation: FIX — configuration, not code.** Set `TM8_GITHUB_TOKEN` in `/etc/tm8/prod.env`.
Then consider surfacing rate-limit state on `/health`, since today an exhausted quota is indistinguishable
from "nothing to do".

**Two parts of this lead did NOT hold up — recorded so the register is straight:**

- **`credentialSource: "node"` is not a silent bypass.** `SpawnService.ts:429`
  (`if (source === 'node' || !this.gitHubCredentials) return null;`) is documented at `:420-424`
  (*"`node` deliberately skips it… degrading to the node's machine login is an attribution bug, not an
  availability feature"*). The port **is** wired at both composition roots
  (`execution-handlers.ts:1336`, `:1493`, `DbGitHubCredentialStore`). And empirically it is not used:
  of 609 rows in `session_manifests`, `launch.credentialSources.github` is `member` for 7 and **NULL for
  602** — and NULL takes the resolving branch. **Zero sessions use `node`.** Category 4.
- **The `github/` home on disk has a reader.** `/home/tm8/prod-data/credentials/id_*/github/`
  (3 present, with `config.yml` + `hosts.yml`) is read via
  `packages/server/src/credentials/agent-credential-home.ts:113,125` →
  `credential-env.ts:84` (`github: 'GH_CONFIG_DIR'`) → `manifest.ts:1050-1051`, which sets
  `GH_CONFIG_DIR` on spawned agent terminals so their `gh` CLI is authenticated. **Wired and working.**

  The real asymmetry is narrower and worth stating: *spawned agents* get a real GitHub identity;
  *the server's own tracking jobs* do not. Separately, `account_git_credentials` (2 rows) stores an
  AES-256-GCM token, and the only reader — `credential-catalog.ts:284` — selects `provider, login`
  and **never the ciphertext**. So the "GitHub connected" card is truthful about a credential that the
  tracking subsystem structurally cannot use.

---

## F6 · `verifies` — a complete reader, a plpgsql guard, a prompt marker, and no way to write one

**This is the sharpest Category-3 finding: the expensive half of a two-sided protocol is the half
nobody can perform.**

Live rows: `memories` **32** · `remembers` **31** · `supersedes` **15** · `disputes` **13** ·
**`verifies` 0** · `copy_of` **0**.

- **Readers are live and reach a real prompt.** `execution-handlers.ts:306-308` sets the `verified`
  flag that becomes a literal `[verified]` marker in every spawned agent's injected context
  (`:200-207`, landing in the manifest at `packages/execution/src/spawn/manifest.ts:1305`).
  `entity-read.ts:886-897` parses `verifies.props.answers / pinnedVersion / independenceBasis`;
  `:1647` picks the latest verify into `EntityStaleness.verified`.
- **Enforcement is deployed.** `internal.guard_verifies_semantics()` exists in `pg_proc`
  (`db/migrations/056_entity_memory.sql:267-350`) and demands a current version pin, `answers` entries
  that are real `disputes` edge ids on the same target, and a checked independence basis.
- **No writer in any client.** The UI's mark vocabulary is closed at two —
  `packages/tm8_ui_2.0/src/domain/memory.ts:215`: `export type MemoryMarkKind = 'supersede' | 'dispute';`
  There is no `verifies` verb in `packages/cli/src`. The only path is a hand-built generic `edges.create`.
- **The UI could not display one if it existed.** `domain/memory.ts:12-31` documents this as *"MEASURED
  DIVERGENCE 1 — 'verified' IS NOT OBSERVABLE FROM A READ"*: `EntityStaleness` is omitted wholesale when
  `reasons` is empty, so `verified` alone never reaches the wire.

**Net effect: all 13 disputes in production are permanently unanswerable.**

**Recommendation: FIX** — add a `verify` mark to `MemoryMarkKind` and its authoring path, and stop
omitting `EntityStaleness` when only `verified` is set. **Or LABEL HONESTLY** if the verify half is
deliberately deferred — but it is not labelled that way today; it is labelled as shipped.

**Same class, lower value: `copy_of`.** Seeded `001_core_graph.sql:914`, read as a version-pin basis
(`entity-read.ts:736`, `:863-869`, feeding `basisMoved`/`basisDeleted`) and given display labels in two
UIs (`handlers/entities.ts:109`, `tm8_ui_2.0/src/data/project/domain-store.ts:685`). **No writer in any
package. 0 rows.** Recommendation: **DELETE** the reader branches, or write the edge where copies happen.

---

## F7 · Ten fields the live UI renders that the server hardcodes empty — two of which state falsehoods that production data disproves

**The broadest user-visible defect in this audit** (see the ranked table — it is #2 by surface).
Every member panel, every teammate panel, every channel and every work session is affected.

All ten live in **one function**, the facade's only detail/summary assembler
(`packages/server/src/facade/entity-read.ts`), as **literal constants**. This is why a
"does the server set this field?" grep answers *yes*: the key is always present, it just never carries
data. Two are also hardcoded on the event path.

| # | field | site | value | UI reader |
|---|---|---|---|---|
| 1 | `state.member.taskDoneCount` | `:1350` | `0` | `registry.ts:1359` stat tile "tasks done"; `tile-badges.ts:359` |
| 2 | `state.team_member.liveWork` | `:1358` | `null` | `registry.ts:1396`, `:1405`, `:1426` block → `ProfileBody.tsx:533` |
| 3 | `content.channel.pinned` | `:1912` | `[]` | `ChannelView.tsx:333-345` |
| 4 | `content.channel.autoTabs` | `:1915` | `[]` | `ChannelView.tsx:193-196`; `HubBody.tsx:85` |
| 5 | `content.member.teamMembers` | `:1930` | `[]` | `registry.ts:1366` "TEAMMATES OWNED" |
| 6 | `content.member.work` | `:1930` | `[]` | `registry.ts:1371` "CURRENT WORK" |
| 7 | `content.team_member.equipped` | `:1938` | `[]` | `registry.ts:1430-1438` "EQUIPPED" |
| 8 | `content.team_member.work` | `:1939` | `[]` | teammate panel |
| 9 | `content.work_session.workingOn` | `:1946` | `[]` | session panel |
| 10 | `content.work_session.transcriptDoc` | `:1947` | `null` | `SessionAnatomy.tsx:364` |

Fields 1 and 2 are literals on the **event projector** too (`projector.ts:1098`), so no read path of any
kind can populate them.

### Two of these assert things production data proves false

**`liveWork` — "Nothing recorded in progress" while 15 sessions are working.**
The data exists in the graph and the server simply never attaches it to the teammate. Counted read-only:

```
working_on edges                                        650
   … whose session status is spawning/running/idle       15
```

The live task *"Work on: Dreamer daily sweep"* carries `badges.workingActors` naming team_member
Dreamer with an active `sessionId` (7 of 60 sampled tasks carry one) — assembled by the *same server*
from the *same edges*. Open Dreamer's own panel and it prints **"Nothing recorded in progress."**

**`teamMembers` — "Owns no teammates." from members who own dozens.** From `public.team_members`,
grouped by the `owner_member_id` the server *does* populate on the inverse relation:

```
 owner_member_id                       | owns
 019fbd5a-3c5d-787d-a353-1e9fad4053e1  |   33
 01a025f3-e80f-7205-8222-322da438ce50  |   11
 019ff490-bf79-776c-a871-b1e807a69544  |   11
 019fea87-7f2e-7ceb-ad0b-a6319eea2436  |   11   (+2 more at 11)
```

Every one of those profiles returns `teamMembers: []` and renders **"Owns no teammates."** beside a
**"teammates: 0"** stat tile.

**`transcriptDoc` is the worst-behaved of the ten.** `SessionAnatomy.tsx:366-377` renders a
`DisabledAction` whose reason asserts *"the record carries no transcript document"* — an affirmative
claim about a record the server never consults. `null` at `:1947` is its only occurrence server-wide.

This is precisely the failure the UI's own design law forbids. `panels/bodies/GenericBody.tsx:802-805`:
*"A designed empty, not an accidental one… must read as 'nothing here yet', never as a failed load."*
For these ten it is inverted — an accidental empty wearing a designed empty's clothes.

### The honest register exists, is accurate, and never reaches the UI

`packages/server/src/events/projector.ts:1296-1313` keeps `KNOWN_GAPS`, a maintained machine-readable
list, with a prose table at `:1289-1295` (*"`state.team_member.liveWork` — null. Needs the live
`working_on` join"*). It is genuinely kept current — the comments record `state.channel.unreadCount`
and `state.collection.itemCount` being **removed** as they became computed — and a test guards it
(`test/events/projector-entity-read-parity.test.ts:137-142`). The codebase is doing the right thing.

**But `KNOWN_GAPS` never reaches the wire.** `grep -rn "KNOWN_GAPS"` across all packages returns only
the server's own comments and that one test — nothing in `contract`, `cli`, or any UI. And it covers
only the **event** path, so it does not even mention the eight fields hardcoded solely in the **read**
path. The UI therefore cannot distinguish "no data" from "not built", and renders the second as the first.

### This bug class is already recognised and was half-fixed

`tm8_ui_2.0/src/domain/registry.ts:1645-1650` records the **identical** defect for spell/skill panels —
*"the `items` block read `content.equipped`, which the server never composes — so the section said
'Nothing here yet.' forever"* — and migrates those panels to `peer-rows` over real `equips` edges.
**The `team_member` panel at `:1430-1438` was left behind on the old path.** The fix pattern is in-repo,
proven, and simply not applied here.

### Scope discipline — what I am NOT claiming

The other six `KNOWN_GAPS` entries (`badges.blocked`, `badges.pulls`, `badges.workingActors`,
`badges.staleness`, `state.channel.workingAgentCount`, `state.doc.childCount`) are gaps **only on the
projector/event path**; the facade *does* compute them (`entity-read.ts:1314` `workingAgentCount`,
`:637/:685` `childCounts`, 15 references to `blocked`). Those are a live-update **parity** issue with a
parity test already on them — not permanently hollow. Only the ten above are hardcoded in the read path.

Also, `autoTabs` (#4) carries an honest in-code comment (*"an empty list is honest, an invented one is
not"*). That comment is correct **as engineering** and invisible **as product**: the user still sees an
empty tab strip with no signal that it was never built.

**Recommendation: FIX #2 and #5 first — they are cheap and they are lying.** The server already
assembles the exact `LiveWork` shape for `badges.workingActors`, and already populates
`team_member.state.owner`, which is the inverse of `member.teamMembers`. Both are a join it is already
doing, attached to the wrong entity. Then **LABEL the rest**: put `KNOWN_GAPS` on the wire, extend it to
cover the read path, and have the registry render a "not built" affordance instead of a designed-empty.
Anything asserting a fact about the record — `transcriptDoc`'s disabled reason above all — must stop
doing so until it is wired.

---

## F8 · `contextRefreshInjection` — a prompt template whose only consumer is a help screen

**Where:** `packages/prompt/src/templates.ts:561-590` — `ContextRefreshFacts` +
`contextRefreshInjection()`, emitting `<trusted_control type="tm8.context-refresh" version="1">` with
`<invalidated>actions, entity-context, unread-routing</invalidated>`.

**Evidence it never runs:** its only non-test caller is a **documentation catalog** —
`packages/prompt/src/catalog.ts:401`, entry `control.context-refresh`, invoked with literal placeholders
(`'{spaceId}'`, `'{snapshotSeq}'`, `'{a bounded JSON snapshot of the focused entities}'`). That catalog
is rendered to humans at `tm8_ui_2.0/src/prompts/PromptsScreen.tsx`, mounted by `help/HelpScreen.tsx:345`.

`composePrompt` (`packages/execution/src/spawn/SpawnService.ts:19`) does not use it. The server imports
only `incomingMessageInjection` and `dispatchRequestInjection` from `@tm8/prompt`
(`messages-handoffs.ts:23`, `execution-handlers.ts:61`). **None of its five declared reasons —
`event-gap`, `version-conflict`, `resume`, `capability-change`, `profile-change` — has an emitter.**

So the help screen documents, to users, a control the runtime never sends.

**Recommendation: DELETE, or wire one emitter.** `resume` is the obvious candidate and would make the
other four cheap. Leaving it documented-but-unsent is the one outcome to avoid.

---

## F9 · 28 functions owned by a superuser, and no CI guard for the convention that prevents it

F3 is one symptom of a class. Across `public` + `internal`: **419 functions owned by `tm8_graph_owner`,
28 owned by `tm8` — and `tm8` is a superuser** (`pg_roles.rolsuper = t`).

15 migrations omit the `set role tm8_graph_owner` wrapper: **142, 144, 145, 148, 153, 154, 156, 158,
161, 162, 163, 165, 166, 168, 171.** (Most are harmless: `create or replace` preserves the *original*
owner, so only files that CREATE a new function drift. That is exactly the 28.)

**Two separable problems:**

- **Availability** (F3): a non-secdef function beneath a `tm8_graph_owner` definer → `42501`.
  `repo_slug_from_url` is the only one in that position today; I checked the other three candidates
  (`w2_addressing_kind`, `w2_task_conversation_sessions`, `node_is_claimed_unsafe`) and found no
  `tm8_graph_owner`-owned definer calling them — `signup_via_invite` only *mentions* one in a comment.
- **Privilege** (latent, security): **21 of the 28 are `SECURITY DEFINER`**, including
  `execution_spawn`, `execution_resume`, `w2_post_message_batch`, `work_session_transition`,
  `start_shell_session`, `claim_node`. They work — because they execute **as a superuser**, bypassing
  RLS entirely. Any logic flaw inside them escalates further than it should.

`tools/ci/migrations-check.sh` asserts **nothing** about `set role`. That is why 15 files drifted without
a single red.

**Recommendation:**
- **FIX (cheap, high value):** add a `set role tm8_graph_owner` check to `migrations-check.sh` for any
  migration containing `create function` / `create or replace function`. This is the durable fix.
- **FIX (own PR, own test run):** re-own the other 27. Deliberately **not** bundled into migration 176 —
  it changes the authority 21 SECURITY DEFINER doors execute *with*, which is a real blast radius that
  deserves its own review and its own real-DB run.

---

## F10 · `restricted` visibility is inert exactly as suspected — but is offered to nobody

**Mechanism: CONFIRMED. Impact: REFUTED. Not a shipped control — a latent trapdoor.**

The live `entities_select` policy body (`internal.entity_row_visible`, source
`db/migrations/159_flatten_rls_predicates.sql:101-127`, verified byte-identical to what is deployed):

```sql
) and (
  p_visibility = 'space'
  or ( p_visibility = 'restricted'
       and p_kind = 'project'
       and exists (select 1 from public.project_links link
                   join public.space_projects active_link
                     on active_link.space_id = link.space_id
                    and active_link.project_id = link.project_id
                   where link.project_entity_id = p_id and link.space_id = p_space_id) )
)
```

For `kind <> 'project'` the second arm is unconditionally false — invisible to **every identity,
including `created_by`**. The `project` arm keys on whether a link is live, not on who is asking, so it
is not an ACL either. The intended grant was designed and never wired: the `visible_to` edge type is
registered (*"Registered now, inert in v1"*) with **0 edges, 0 pg_proc references, 0 policies**, and
`internal.has_visible_to_edge` does not exist. `db/migrations/080_channel_members.sql:81` says it flatly:
*"`restricted` visibility on this node means invisible to everyone and is not an access-control list."*

**But nothing is stranded and nothing offers it.** 10,479 rows are `space`; **14 are `restricted`, all
`kind='project'`**; all 13 live ones satisfy the carve-out and are visible now; the 1 that does not is
already tombstoned. No contract operation input accepts an entity visibility (`VisibilitySchema` appears
once, at `schemas.ts:569`, in an **output** shape). No write RPC in `public` takes one except
`create_space`/`update_space`, which are the unrelated `spaces.visibility` column (`private|public`).
The live UI has no visibility control; `restricted` there is a **panel archetype name**
(`EntityDetailPanel.tsx:1606`), which is why grep makes this look like it has surface. The sole writer is
`internal.materialize_project_projection` (`021_w2_projects.sql:150,164`), machine-only.

**Recommendation: LABEL HONESTLY, plus one cheap guard.** The real gap is that the CHECK constraint is
broader than the predicate can serve. Narrowing it to `visibility = 'space' OR kind = 'project'` costs
nothing today (that state has never existed in prod) and makes the one data-loss outcome unrepresentable.
It matters because there is **no write path back**: per `159:56-60`, `entity_readable` also guards
`security definer` write RPCs, so such a row would be unwritable as well as unreadable — no UI, CLI, or
API route to undo it.

The working pattern to copy is `saved_views` (`008_rls_policies.sql:163-168`): the load-bearing
difference is a second disjunct that keeps the **owner** resolving even at `share_mode='private'`.
`entities.visibility='restricted'` has no such clause. That is the whole defect.

---

## F11 · 428 test files that cannot fail

Aggregating F1 and F2: `packages/tm8-ui` has **342** test files and `packages/ui` has **86**, and
`TEST_PACKAGES` in `tools/ci/check.sh:172-198` contains neither (contract, server, execution, cli,
tm8_ui_2.0, conformance). `.github/workflows/ci.yml` runs only `tools/ci/check.sh --no-migrations`, and
there is no root `vitest.workspace`, so nothing sweeps them up.

**428 test files provide zero signal.** They are worse than absent: they make coverage look larger than
it is, and F4 is a direct consequence — `mapping.test.ts` would have caught the register's rot in
2026-07 had it ever run. **Recommendation: DELETE with their packages.**

---

## F12 · The liveness sweep is a control that cannot fail

The audit harness itself belongs in this report, because a check that always passes is exactly the
category this document is about — and this one was about to launder a false clean bill of health.

`packages/tm8_ui_2.0/scripts/liveness-sweep.mjs` decides a route rendered by counting DOM elements
against a `< 60` threshold (`:92`). Driven against `https://127.0.0.1:7777`, **every** route renders a
refusal card — *"The node refused this Space. cross-origin request from https://127.0.0.1:7777 refused
(S3 exact-origin allowlist)"* — but the shell still mounts **204 elements**, comfortably over the
threshold. The sweep reports every route healthy and enumerates 11 controls, all global nav. At the
script's default origin the same route yields **2310 elements and 186 controls**. **The threshold cannot
distinguish "rendered" from "rendered a refusal."**

Three further limits, each proven:

1. **Attribute- and CSS-only effects are invisible.** `snapshot()` (`:82-87`) captures url, element
   count, innerText and testids — nothing else. So the theme toggle is reported `NOTHING HAPPENS` on
   every route. Driven manually in Firefox it plainly works: `.cv2-root` gains `data-theme=dark`,
   `colorScheme` light→dark, body background `rgb(241,245,249)`→`rgb(15,17,21)`. **A false positive —
   and precisely the kind this audit must not repeat.**
2. **It would misreport honest refusals as defects.** It treats a disabled control as reasoned only if
   it carries a `title` attribute (`:105`, `:116`), but `panels/honesty/DisabledWithReason.tsx`
   deliberately uses `aria-describedby`. The package's entire refusal vocabulary — the Category-4
   behaviour this codebase is *right* to prefer — would be reported as "DISABLED, NO REASON".
3. **Chrome-first ordering starves the content.** The 10 nav controls sort first, so a low `--limit`
   never reaches a real control. At ~13s/control, 186 controls is over an hour on a contended box.

**Recommendation: FIX before this harness is trusted again.** Three small changes: assert the absence of
the refusal card rather than an element count; extend `snapshot()` to diff `data-*`/`class`/computed
background; and read `aria-describedby` alongside `title`. Until then its "NOTHING HAPPENS" verdicts
carry no weight — as F13 records, none of this report's findings rests on them.

---

## F13 · `deploy/prod/env.sh` defaults to a database that does not exist

`deploy/prod/env.sh` sets
`TM8_DATABASE_URL="${TM8_PROD_DB_URL:-postgres://tm8@127.0.0.1:5442/tm8_stable}"`. **`tm8_stable` does
not exist on this cluster** — prod actually runs on `tm8_prod` (from `/proc/1770944/environ`), supplied
by `TM8_PROD_DB_URL` in root-owned `/etc/tm8/prod.env`.

The fallback is therefore a trap: anyone sourcing `env.sh` without `/etc/tm8/prod.env` gets a hard
connect failure naming a database nobody will find. Cosmetically related:
`scripts/start.mjs:96` prints *"no web UI bundle at packages/ui/dist"* while actually checking
`tm8_ui_2.0` — a wrong string, not a wrong path.

**Recommendation: FIX** — change the default to `tm8_prod`, or drop the default so the variable is
required and fails loudly.

---

# Part 2 — CHECKED AND FOUND HEALTHY

Recorded because a clean negative is a finding, and because two of these were supplied as leads.

**Interaction profiles are NOT dead — the lead was wrong, as the requester already determined, and I
confirm it.** `packages/server/src/profiles/w2-profile-resolver.ts:19-37` defines `tm8.chat.core@1` as a
**static, code-defined** template — *"Closed shipped assets. There is deliberately no registration or
mutation API."* The settings screen performs a genuine `seam.query()` read, `packages/execution/src/spawn`
consumes the manifest, and this session runs under that template at `pin_revision 3`. The two DB tables
(`interaction_profiles`, `interaction_profile_versions`) have **0 rows**, but that is *correct*: they
hold **custom** profiles reached via `spawn_override` / `teammate_default` / `space_default`, and with
none defined every launch resolves to `core_default`. Zero rows here means "nobody has customised",
not "nothing works". **No action.**

**The epistemic layer is largely live — the lead was substantially false.** 32 memories (newest written
2026-08-30), 31 `remembers`, 15 `supersedes`, 13 `disputes`. Written through `public.create_memory` /
`update_memory` (`056_entity_memory.sql:449`, `:568`) via
`entities-commands-tracking.ts:1094`, `:1217`, and via the live UI's
`tm8_ui_2.0/src/authoring/useMemoryMarks.ts`. Read into **every spawned agent's prompt**
(`execution-handlers.ts:295-325` → `manifest.ts:1305`), with superseded memories dropped from injection.
~808 lines of SQL and ~1,140 lines of live UI, all working. It adds **zero** contract operations — it
rides `entities.create`/`patch` and `edges.create` — which is precisely why a catalog-based gap audit
would miss it. Only the `verifies` and `copy_of` slices are hollow (F6). For scale: **22 of 38 registered
edge types have 0 rows**, so "0 rows" is the norm here and is not by itself evidence of death.

**The two unimplemented operations are honest.** `search.query` and `bridge.fetchBlob` are `reserved`,
structurally unregisterable (`registry.ts:41-46` throws), routed so 404 is impossible, and pinned by
`test/w2/reserved-honesty.test.ts` to return `501 not_implemented`. Category 4. **No action.**

**A prior note of mine was stale and is corrected here:** `MenuRail` is **not** dead code on this
branch. `src/main.tsx` → `src/App.tsx:4` → `views/GateApp.tsx:16,1909` renders it whenever `railConfig`
is non-null. Reported so the correction lands in the artefact rather than only in conversation.

**No dead controls were found in the live UI — and that appears to be by construction.** This was the
audit's primary hypothesis and it did not hold. `tm8_ui_2.0/src/domain/actions.ts:266-281` **throws** if
an action renders as available with no dispatcher wired (it replaced an older silent `ctx.dispatch?.()`),
which structurally forbids the "renders and does nothing" class. Mechanically: no `onX={() => {}}` in
shipped code (the `AuthBoard`/`SettingsBoard` hits are dev-only surfaces marked *"NEVER product"*);
**zero** `useState` values set-but-never-read across the whole package; and every optional callback with
no pass site (`onShare`, `onRunAction`, `onSectionChange`, `onStanceChange`, `onPopped`) is an *observer*
hook rather than the control's own effect. **No action.**

One stale comment found while checking: `panels/bodies/SessionAnatomy.tsx:347-351` claims
`EntityDetailPanel` renders `TerminalBody` without `onOpenTranscript`, leaving *"an enabled button that
silently does nothing"*. That is **no longer true** — `EntityDetailPanel.tsx:1437` supplies it and
`terminal/SessionFallback.tsx:131` disables when absent. The comment is out of date, not the code;
worth deleting so it stops seeding false leads (it seeded one here).

**`tracking.observer` and `tracking.commit_recorder` are healthy** (1 and 2 failures across 1845/1822
runs). The observer's on-demand path works end to end — its last completion, 2026-08-29 18:23:59, is
exactly `max(pull_requests.fetched_at)`.

---

# Part 3 — SUSPECTED, NOT PROVEN

- **`unreadTotal: null`** (`handlers/spaces.ts:55`) is confirmed hollow on the server but was not traced
  to a UI surface, so it is not counted among F7's ten. Likely the same shape; unknown visibility.
  (Everything else from the old `HOLLOW_FIELDS` list is now confirmed and promoted into F7.)
- **The command palette's ACTIONS group can never appear.** `views/GateApp.tsx:2596-2608` is the sole
  `CommandPalette` mount and passes neither `actions` nor `onRunAction`, so `actions` defaults to `[]`
  (`CommandPalette.tsx:95`) and the palette's advertised third group has no rows. The same mount omits
  `statusOf`, so entity rows never show a status word. This is **not** a dead control — no row renders
  to press — but it is an advertised feature that cannot occur. Not driven end-to-end, hence suspected.
- **The other 27 misowned functions** (F9) are proven misowned and proven superuser-owned; I did **not**
  prove any of them is currently *failing*. I checked the three plausible candidates and found no live
  break.

---

# What I did not get to

- **Exhaustively driving the live UI.** The Firefox sweep ran, but see **F12**: at the reachable origin
  every route renders a refusal card the harness scores as healthy, and its snapshot cannot see
  attribute- or CSS-only effects. **No finding in this report rests on a sweep verdict** — F1–F13 are
  source-, schema-, or production-data evidence, and the dead-control conclusion in Part 2 is from
  static tracing plus the `actions.ts:266-281` invariant, not from pressing 186 controls. At ~13s each
  that run was not feasible on a contended 4-core box. **The dead-control class is argued, not swept.**
- **`packages/cli` (21k), `packages/execution` (17k), `packages/mcp`, `packages/pty-protocol`** — not
  swept for dead surface.
- **The other ~150 migrations** — not read. Only the ownership convention was checked across all of them.
- **No test suite was run.** Migration 176 is unexercised; it needs a real-DB run before it lands.

## Ranked recommendation

| # | Finding | Action | Size | Risk |
|---|---|---|---|---|
| 1 | F3 forge-watcher `42501` | **FIX** — apply `176` after a real-DB run | 1 migration | low; unblocks 52 PRs + 3 nudges |
| 2 | F7 `liveWork` + `teamMembers` | **FIX** — both are joins the server already does | small | low; stops two false statements |
| 3 | F2 `packages/ui` | **DELETE** | 53,381 loc | low — no prod path |
| 4 | F1 `packages/tm8-ui` | **DELETE** — *after* re-pointing `/etc/tm8/prod.env* | 278,796 loc | **high if ordered wrong** |
| 5 | F5 GitHub token | **FIX** — config only | 1 env var | low |
| 6 | F7 the other eight fields | **LABEL** — put `KNOWN_GAPS` on the wire, extend to read path | small | low |
| 7 | F12 liveness-sweep harness | **FIX** — 3 changes; untrusted until then | ~20 lines | low |
| 8 | F9 CI guard for `set role` | **FIX** | ~10 lines | low |
| 9 | F6 `verifies` authoring | **FIX** or **LABEL** | moderate | medium |
| 10 | F4 capabilities register | **DELETE** with F2 | 163 loc | low |
| 11 | F8 `contextRefreshInjection` | **DELETE** or wire `resume` | ~30 loc | low |
| 12 | F13 `env.sh` default DB | **FIX** | 1 line | low |
| 13 | F10 `restricted` CHECK | **LABEL** + narrow constraint | 1 constraint | low |
| 14 | F11 428 unreachable test files | **DELETE** with F1/F2 | 428 files | low |
