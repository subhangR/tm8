# W5 — Duo Structure and Work Division

**Single source for the W5 division. Reference this; do not restate it into packets** (§23.13 —
a restatement can diverge, a reference cannot).

**W5 was cancelled and is now RESTARTED by user direction.** Sessions through W4 are closed. Chain at
restart: **34 / `a799b7ef1b20a9b0`** — measure it yourself, do not trust this figure
(`cd db/migrations && shasum -a 256 *.sql | shasum -a 256 | cut -c1-16`).

---

## 1. The duo model

**Each duo is one TESTER session and one DEVELOPER session.** The tester finds and gates; the developer
fixes. They talk **to each other**, directly, and come to the W5 coordinator only when **decisive authority**
is required. The coordinator escalates to the full-program coordinator only for contract changes, dossier
amendments, and gate decisions.

**This is a stronger form of the independence law, not a relaxation of it.** §8: *independence is enforced by
session.* Within a duo:

- **The developer never edits the tester's test files.** Not to fix a red, not to "correct an assertion",
  not ever. A red that the developer believes is wrong is **argued, not edited**.
- **The tester never edits production source.** A fix it believes obvious is **described, not written**.
- **The tester's red is the acceptance criterion for the developer's fix**, and it must be **archived before
  the fix lands** if the fix would destroy the ability to re-capture it (§19.4).
- **Neither owns the other's verdict.** The developer cannot declare itself green; the tester cannot declare
  a fix adequate without re-measuring.

**Why a duo rather than a queue:** the program's most expensive class was *non-transfer of knowledge that
already existed* (§2 of the close document). A duo has a two-session-wide memory and one shared surface,
which is the smallest unit where a finding and its fix cannot drift apart.

---

## 2. The six duos

Divided by **surface**, not by defect list, because surface disjointness is what prevents collisions.

### Duo A — SQL authorization, replay, and concurrency
**The largest body of work and the only one carrying live security defects.**
- 81 class-D resource-confusion sites, plus `entities.patch`'s **eleven doors** (recorded **UNMEASURED, NOT
  SAFE** — not "probably fine"). Enumeration exists at `W2-SEC1-STAGE2-ENUMERATION.md`.
- `015`'s `require_delivery_principal` assumed-role `AND` — **and the two suites that block its fix because
  they pass BECAUSE OF the hole** (`test/db/w1-foundations.test.ts`,
  `test/db/w2-messages-handoffs.pg.test.ts`). **Tests that pass because of a security gap are their own
  finding**; fix them first or the guard cannot be tightened.
- `019` teammate-authored → exited/failed target: throws, writes **zero rows**, and
  `w2_delivery_fallback` sits *below* the raise so **the fallback is unreachable for the entire class it was
  written for**.
- **The independent concurrency harness that was never built** — 92 unpinned sites. This is the **tester's**
  deliverable specifically, and it is the seat that must build it, because the existing evidence rests on
  its author's own two-connection test.

**Tester owns:** `packages/server/test/w5/sql/**`, `packages/server/test/db/**` (new files).
**Developer owns:** migration candidates **authored OUTSIDE the repository** — see §4.

### Duo B — Cursors and the silent-skip class
- `entities.feed` and `inbox.list` truncation, **both in the SILENT-SKIP direction** — they lose rows with
  no error, which is the direction nothing detects.
- Complete the cursor sweep. **Mechanism assertions are primary, symptom assertions secondary** (§23.2):
  sequential fixtures report clean green across every defective site, so *exactly-once* alone is worthless.
  Six-digit fidelity read off the wire cannot be fooled by fixture luck.
- The `iso()` trap: it truncates on **both** branches, so **formatting microseconds in SQL is not sufficient
  for immunity** — verify the **full call path to the wire**.

**Tester owns:** `packages/server/test/w5/cursors/**`. **Developer owns:** `facade/entity-read.ts` and the
cursor-encoding sites.

### Duo C — API surface truth
**This duo answers the question the program could not.**
- **Build the schema-valid stub sweep of all 98 operations** — the missing instrument. For each, send a body
  that *passes* its `INPUT_SCHEMAS` entry (or none where it has none) and record which return 501 **from the
  handler** rather than from the router. **Until this exists, "every v1 operation is implemented" is
  unsupported.** Cheap 80%: operations with no schema entry are already handler-reached; minimal valid
  bodies for the rest can be **generated from the Zod schemas** rather than hand-written.
- **The never-gated surface**: G04's `messages.delete`, attachments add/remove, `delivery.get`, all three
  `handoffs.*`; G12's behavioural branches beyond strict-input; G13's feed branch matrix;
  `interactionProfiles.propose` and `updateDraft` strict-input (**UNPROVEN, and explicitly not folded into
  the eight passing verdicts**).
- `interactionProfiles.activate` — **never successfully activated** by anyone.

**Tester owns:** `packages/server/test/w5/surface/**`. **Developer owns:** the handlers those probes reach.

### Duo D — CLI verification: the composed groups
Real-Server verification of CLI groups **2 (space/identity), 3 (entity/task/tracking/graph/undo), 4
(edge/placement), 6 (project/file), 7 (inbox/saved-view/action)** — the groups whose operations hold public
verdicts, so a CLI red here is a **CLI** defect rather than an unproven API.
- **The legacy stub-Server tests are not evidence.** Real local Server only.
- Consume W4's **per-operation coverage declaration** (`EXERCISED-REAL-SERVER | UNIT-ONLY | NOT-COVERED`)
  and gate what it marks unit-only.
- `note: null` on the work command: **accepted with 200 and silently does nothing.** The contract question is
  arbitration; **a worked correct example of the fix already exists twelve files away** at
  `messages-handoffs.ts:377-379`.

**Tester owns:** `packages/cli/test/w5/d/**`. **Developer owns:** its 14 command modules by name.

### Duo E — CLI verification: the thin groups
Groups **5 (message/handoff), 8 (event/presence), 9 (session/interaction-profile/teammate)** — the least-gated
surfaces, therefore the most work.
- `events.subscribe` and the **half-duplex presence capability**: the CLI can *receive* presence and can
  never *announce* it, so on a node whose only writers are CLI clients `event watch --presence` receives **a
  channel nothing ever feeds** — and an agent **waits forever, unable to distinguish that from a quiet
  channel**.
- Unexpressible inputs: `promptExtra`, `confirmAgentGenerated` on A20.
- `entities.commands.pull` **stricter than its contract**.
- The **inverted `commands.undo` note** in `operations.ts` — it says redemption restores; migration `020`
  shows it redacts.
- The delivery path: **exercised exactly once in the program's history**, against a hand-supplied credential
  on a TRUST-auth dev cluster. **Not a default configuration.** Recipe: **rebuild, THEN read the boot line**
  — it cannot distinguish a stale binary from an unset variable.

**Tester owns:** `packages/cli/test/w5/e/**` — a path, not a prose promise. **Developer owns:** its 7
command modules by name.

### Duo F — Agentic discovery and harness use
**W5's second mandate, and the one that is not a test suite.** Can an agent find and correctly use these
commands from generated help and completion **alone**, with no prior knowledge?
- Groups **10 (discovery/help/availability) and 11 (harness) ONLY.**
  **⚠ CORRECTED: group 1 (the kernel) was originally assigned here and that was a BUILD-ORDER DEFECT.**
  W4 evidence `:626-628` records that groups 10 and 11 both **depend on** group 1, and W4's own rule is
  *"Slot A must freeze first because Slots B and C both depend on its exit/error/output/context layer."*
  Assigning the shared floor to the read-mostly verification duo — and staging that duo last — inverted a
  constraint that was already written down. **F's mandate needs the kernel STABLE, not OWNED.**
- The **per-operation availability** projection: `available | unavailable | unknown` with precedence
  contract → observed → advertised. **Default is `unknown`, never optimistically `available`.**
- **Stated limitation to verify, not assume:** an agent planning from a **cold** cache still cannot tell
  which mounted operations will do work.
- `test/w2/reserved-honesty.test.ts` has **drifted from the shipping composition** and under-reports by
  exactly one (97/1 against a production 98/0) — it builds a registry without a presence source.

**Tester owns:** `packages/server/test/w5/agentic/**` and harness probes. **Developer owns:** the discovery
and harness surfaces.

---

## 3. Not assigned to a duo

- **G5** — a **fresh, evidence-only** gate session that never implemented and never verified. Not a duo, not
  the coordinator, and spawned only when the coordinator declares readiness.
- **G0.2 amendment batch** — dossier text. Coordinator collects candidates; **routes to the full-program
  coordinator.** Any dossier edit rotates the approved hash and needs a fresh narrow gate.
- **64 skipped tests across SIX files** — measured by the runner, which is authoritative on what actually
  skipped: `events/poll.pg` 11, `facade/loop` 22, `facade/contract-shapes` 15, `events/loop-visibility.pg` 6,
  `db/claims` 7, `db/loopback` 3 = **exactly 64**. The previously-named seventh file
  (`sidecar/lifecycle.live`) ran **12 passed, zero skipped**. **And the more interesting half: a skip-construct
  grep finds NINE files — two carry a construct that NEVER FIRES. A CONDITIONAL SKIP THAT CURRENTLY PASSES IS
  INVISIBLE TO EVERY SKIP COUNT ANYONE RAN.** The grep is a name grep and therefore a **lower bound** —
  `ctx.skip()` or `runIf` would be invisible to it. **Report, do not unskip blind.**
- **92 type errors in W3 test files** — triaged, no verdict downgraded (42 of 44 in assertions are
  `unknown`-typed, which *refuses* operations rather than silently permitting them). **Enabling test
  typechecking would hand over a red CI**; it travels as one item with its inventory.

---

## 4. Hard boundaries

**MIGRATIONS: the W5 coordinator is the SOLE landing point.** Developers author **outside the repository**
and hand over path + SHA-256 + a shared-object statement. §15.5b: `startW3PublicServer` applies *every* file
matching the migration pattern, so **a half-written migration in the tree is applied to every scratch
database in every wave.** The directory is quiet by construction, not by everyone's good behaviour.

**THE EXCLUSIVE LANDING WINDOW** (§22.3, amended): announce → **wait for an explicit all-quiet from every
other duo**, never a fixed delay → copy in → run the full-chain gate → announce the result **with an
instruction to re-measure**. If the gate fails, **revert inside the same window.** Any suite failure observed
during an announced window is **presumed window-caused** until re-run.

**Announcing a quiesce is not being quiesced. An announcement is evidence, not authority; the tree is the
authority.**

**THE CLI KERNEL IS FROZEN AND COORDINATOR-GRANTED.** `args.ts`, `run.ts`, `exit.ts`, `output.ts`,
`errors.ts`, `mutation.ts`, `context.ts`, `index.ts`, `env.ts`, `manifest.ts`, `prompt.ts`, `client.ts` —
group 1, the floor every command module stands on. **No duo owns it. A defect is fixed by the FINDER'S
developer under a named, time-boxed grant**, and F then *gates* a kernel it did not write, which is
independence working. **Kernel grants are BATCHED into announced windows exactly as migrations are** —
otherwise the kernel becomes a second serialisation point and D and E both queue on `args.ts` in the first
hours. `registry.ts` is **coordinator-only**: it throws at import on a duplicate, so a double registration is
a hard import-time collapse of every slot's suite at once. All 98 commands are already wired.

**PRODUCTION SOURCE IS NOT DUO-OWNED.** Each duo owns its **test** paths outright; a production file is
granted to **one duo by name, per finding, exclusive until released, and time-boxed** — an indefinite grant is
duo ownership with extra steps. Publish the grant ledger where contending duos can read it.
`facade/entity-read.ts` is a **three-duo file** (B's `iso()` at `:179`, E's `localId` at `:679`, D's `note` at
`:701`) and is where the queue will actually bite.

**FORBIDDEN TO EVERY DUO:** `packages/contract/src/**` (report for arbitration, never edit),
`packages/server/test/w2/**` and `test/w3/**` (historical evidence — frozen), another duo's owned paths, and
**git**, in any form, by anyone.

---

## 5. Instrument rules — non-negotiable, each cost a real defect

- `cd <package> && ./node_modules/.bin/vitest run --no-file-parallelism <path>`. **Capture the full RUN line
  including the trailing path** — the version alone is consistent with the wrong runner. `npx` from the repo
  root resolves **outside the repository**.
- **A separate typecheck of your own test files** against `tsconfig.base.json`, reported as a distinct
  result. `bun run typecheck` type-checks **no test file anywhere**.
- **Every detector needs BOTH halves: red on known-bad AND green on known-good.** A detector that fires on
  everything passes a mutation test exactly as well as a correct one.
- **Fixtures build their chain from `migrationFiles()`**, never a hand-listed slice, and **every packet states
  which migrations its fixture applies.** Per-group fixtures are **isolation proofs, not coverage proofs.**
- **VOID-RUN RULE:** hash the file under test immediately before and after a run; **a mismatch is a void run,
  not a result.** And no probe, mutation, or transient edit may run while a suite intended for report is in
  flight.
- **A measurement of a built artifact is not a measurement of the source**, and nothing in a successful exit
  distinguishes them. **Rebuild before measuring.**
- **`pg_catalog` over file grep** for any completeness claim about database behaviour; **runtime schema
  introspection over name grep** for any claim about schema shape. *Grep finds the name you already thought
  of; introspection finds the shape.*

---

## 6. Method — the rules that fell out of the last wave

- **Verify, then file.** Trace a hypothesis to its terminating source before reporting, and **report a
  disproof as a disproof.**
- **Any claim that a site is SAFE requires a named second reader.** Alarming findings attract scrutiny;
  reassuring ones do not. **Every misattribution in the previous program ran in the reassuring direction.**
- **A sound measurement described in language wider than the measurement** was that program's dominant
  failure. State what your check **can be satisfied by**, not what it asserts.
- **Publish your own false-positive rate beside your findings.** One seat closed with seven confirmed
  findings against ten self-caught false reds; **that denominator is why all seven were acted on without
  re-derivation.**
- **A red with a recorded reason beats a vacuous green.** An assertion whose **premise has expired** is not
  re-pinned to pass; it is recorded as expired.
- **An unresolved question is pinned by a test, not described by a sentence.**
- **Frozen literals stay literal.** A stale exact-literal assertion is a **detector working** — update it to
  new exact literals with before-and-after recorded, never to a range or a live-computed value.
- **When you learn something, do not write it down — wire it to something that fails.**
