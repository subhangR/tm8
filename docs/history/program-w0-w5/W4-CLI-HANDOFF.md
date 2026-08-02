# tm8 CLI + Harness — Terminal Handoff

**For someone who was never here.** Read this first; it is the entry point to
`W4-CLI-IMPLEMENTATION-EVIDENCE.md` (~1,400 lines), not a summary of it.

Chain at close: **34 files / `a799b7ef1b20a9b0`**, measured from inside `db/migrations`.

---

### ⚠ READ THIS BEFORE YOU TRUST ANYTHING BELOW

**The artifacts transfer. The skepticism does not.**

The suites are on disk and re-runnable and will still be green next week without anyone remembering why —
that is what an artifact is for. **But the thing that produced this record was people opening files and
contradicting the person who outranked them**, and a document can *record* that it happened; it cannot
*cause* it.

**So the specific failure mode facing you is this: you will inherit these conclusions with MORE authority
than we held them with.** Ours arrived with their arguments attached and with someone available to
disagree. Yours arrive as a document. **Every figure that fell during this work fell while sitting in a
document, looking settled.**

That is why the sections below name their own limits in the text rather than trusting you to re-derive
them — why §9 says two suites are green *in both worlds*, why the O1 green carries its credential
condition inline, why "every operation is **mounted**; *implemented* is not *supported*", and why the
stale-restatement problem is recorded as an **open problem** rather than a solved one. **We could not
hand over the reading. We could only hand over the places we already know are worth re-reading.**

---

## 1. What exists and works

`packages/cli` — a noun-first CLI generated against the frozen 101-row contract catalog. **8 command
groups, 21 domain modules**, composed at one point (`src/commands/registry.ts`), dispatching from a built
binary at `packages/cli/dist/index.js`.

**Every path is bound via `bindPath(<operation>, params)`. There is not one hand-written URL literal in
the package and there must never be.**

`packages/cli/test/integration/harness.ts` spawns the **real Server as a child process** on an isolated,
freshly-migrated scratch database. It deliberately does not build (a harness that silently rebuilds masks
a broken build) and registers nothing (an uncomposed operation must be observed answering its own honest
501, or the harness is measuring itself).

**Coverage is declared per operation, measured, never inferred** — see evidence §15.2. ~97 rows exercised
against a real Server; every non-covered row carries a stated mechanism, not a shrug.

**Suite at close:** `Test Files 2 failed | 46 passed (48)`, `Tests 2 failed | 1114 passed | 1 skipped`.
The two reds are named deliberate witnesses (§2 below). **The record does not claim green.**

---

## 2. What is open — each with its reason and its unblock

| # | Open item | Unblock |
|---|---|---|
| 1 | **O1 — exit 11 never proven end-to-end** | Wiring **landed**; needs `TM8_DELIVERY_DATABASE_URL`, derived per-run. See below. |
| 10 | ⚠ **Delivery failure is SILENT by design** | A designed trade, recorded with its cost — see below. |
| 11 | ⚠ **Two DB suites are green whether the delivery guard exists or not** | **§9.** They pass *because of* the hole; the durable `015` fix must rewrite them first. |

### 10 — a working message path and a totally broken delivery path look identical from the caller

G04's loop **deliberately swallows dispatch failures**, so that a delivery outage cannot roll back or
disguise a **stored** message. **That is correct**, and it is also why a failure there surfaces nowhere.

> **Message durability is protected AT THE PRICE OF SILENT DELIVERY FAILURE**, and nothing above the
> swallow reports it. Whoever operates this needs to know that *"messages are working"* and *"delivery is
> completely broken"* are indistinguishable from the caller's side.

Recorded as a **trade with its cost named**, not as a defect.
| 2 | **Two witness reds** — work-note wipe, mentions wipe | The server-side **absent-means-merge** fix. |
| 3 | ⚠ **Cursor truncation: `entities.feed`, `inbox.list`** | Server fix. **Read §3 — this is the dangerous one.** |
| 4 | `events.subscribe` / `presence.get` verdicts | WS control protocol **landed**; a reopen slot is rebinding now. |
| 5 | `interactionProfiles.activate` never *succeeded* | Needs a validated artifact + matching hash no fixture could mint. |
| 6 | `promptExtra`, `confirmAgentGenerated`-on-A20 unexpressible | No authority names a flag; the latter also needs a kernel change. |
| 7 | `entities.commands.pull` **stricter than its contract** | `localId` is `.nullable().optional()`, yet omission *and* explicit null are both refused. |
| 8 | `operations.ts` note on `commands.undo` is **INVERTED** | It says redemption *restores*; migration 020 shows it **redacts**. One-line fix. |
| 9 | ⚠ **The "clear a field deliberately" half is DB-reachable but NOT API-reachable** | See below — a migration cannot close this one. |

### 9 — the clear half exists in SQL and no client can reach it

The absent-means-merge fix ships `p_clear_note` on `set_work_state`, so **deliberate clearing is possible
in the database**. But **the server passes six positional arguments and the CLI grammar has no such
flag**, so **no client can drive it.**

> *"A caller may clear deliberately"* is **true of the database today** and becomes **true of the API only
> when a client is taught to pass it.**

This matters because the whole point of the merge fix was that **absent means leave alone, explicit null
means clear** — otherwise a silent-destroy is traded for a **silent-cannot-erase**. Half of that
condition is currently unreachable from any client. **A test that extends the work-note witness to the
clear half will not be able to drive it from the CLI.** The migration author volunteered this rather than
letting it be discovered in a red.

**Closing it needs a server parameter AND a CLI flag** — and the flag is only restoration if an authority
names one, which for `--note` it does not (see the `note`-versus-`graphLayout` asymmetry: no authority
names a note flag, so building one would be invention).

### O1 — ✅ CLOSED. Exit 11 measured end-to-end on the built binary.

```text
[g5][O1-trigger] exit=11 mode=binary
[g5][O1] real delivery DTO -> [{"deliveryId":"019fa297-64e3-…","targetWorkSessionId":"019fa297-64e3-…",
          "status":"failed_permanent","attemptNo":1,"settledAt":"2026-07-27T08:00:58.610Z", …}]
29 passed (29) · chain 34 / a799b7ef1b20a9b0 bracketed identical · commandMode=binary
```

**A real reserved delivery row, SETTLED and NON-DELIVERED, produced exit 11** — the contract's **FIRST
disjunct**, exactly as `GRAMMAR:1148` specifies and as `exit.ts:44` reads. **No synthetic state, no fault
injection, no live agent required.**

**Why the earlier run measured zero rows** — and it was never a defect in anyone's code: **the built
binary predated the wiring landing.** A `dist` built before it has no `messageDelivery` at all, never
calls `reserve`, throws nothing, and returns exit 0 with zero rows — **which is every observation in the
first report.** The server author named that hypothesis; a rebuild closed it.

**The trigger is NOT provisional, and this was verified rather than assumed.** The row is
`failed_permanent` / `session_not_live` from the exited-target branch — the branch an earlier defect
report warned against. **That warning was over-broad.** The discriminator is **whether the message has a
SOURCE SESSION**:

```text
MEMBER-authored   -> source null, pair_ columns null  -> constraint satisfied -> ROW WRITTEN. Works.
TEAMMATE-authored -> source non-null, pair_ still null -> 23514 pair_shape    -> ZERO rows. Broken.
```

**A CLI `message send` is MEMBER-authored** — confirmed from the captured DTO,
`"sourceWorkSessionId": null`. So this green rides the branch **working as designed**, and **it survives
the `019` repair**, which only adds the missing pair columns for the Teammate case.

⚠ **The half that IS broken matters later, not here:** a **Teammate-to-Teammate wake** — *the only path
B2 exists to govern* — always raises, and `w2_delivery_fallback` sits **below** the raise, so **the
fallback for undeliverable Teammate messages is unreachable for exactly the class it was written for.** A
Member can always get a record of a dead target; **a Teammate never can, until `019` lands.**

**Condition on the green, stated because it changes what it means:** the run used a **hand-supplied local
credential** (`TM8_DELIVERY_DATABASE_URL` as `tm8_delivery_worker`) against a dev cluster whose
`pg_hba.conf` is TRUST for `127.0.0.1/32` — **a property of this cluster, not of the product.** At default
configuration the variable is unset and **"no delivery rows" means UNCONFIGURED, not undeliverable.**
A real deployment must supply a real credential.

⚠ **CORRECTED — an earlier draft of this caveat said the code cannot check the role. IT NOW CAN.**
`verifyDeliveryPrincipal` is awaited at `main.ts:134` **before `server.listen()`** and asserts the
delivery connection's **`session_user`** is `tm8_delivery_worker` **and** that role's `rolsuper` is false,
**throwing and failing the boot** otherwise. `session_user` specifically, because it is **the one value
that survives `set role`** — as superuser, after `set local role tm8_delivery_worker`, `current_user`
reads `tm8_delivery_worker` while `session_user` still reads `tm8`, so a check written against
`current_user` **would pass in precisely the case it exists to catch.**

**The accurate sentence:** the code cannot constrain **what an operator puts in the URL**, but the node
**refuses to start** unless that URL **authenticates as** a non-superuser `tm8_delivery_worker`.

**And the residual, which the correction must not inflate away:** it is a **mitigation, not a fix**, and
it protects **this wiring only**. `015:1346-1347` is an AND and still admits any principal *permitted to
assume* the role — a maintenance script, a second node, a `psql` session. **The durable fix in `015` is
deferred — see §9, which is the reason it will be hard whenever anyone attempts it.**

**The TRUST-auth point is unaffected:** the guard checks **which role the connection authenticated AS**,
never **how** it authenticated. Different questions; only the first is enforced.

### SUPERSEDED — the earlier disposition, kept because the reasoning is the record

**Not discharged. Not "unwired" either.** The honest record:

> **Reachable in principle, delivery wiring configured and authenticating, reservation nonetheless
> throwing and being swallowed.**

Measured on the built binary, delivery configured, bind coherent at `34 / a799b7ef1b20a9b0`:

```text
[g5][O1-trigger] exit=0 mode=binary
[g5][O1-trigger] reserved delivery rows: ""          <- ZERO. Exit 0, not 11.
```

**Four causes eliminated before reporting** — this is a traced negative, not a bare one:
the intent **is** emitted (`019:461-465`, anchor was a `running` work_session, **not** an exited one);
the role **does** authenticate (`select current_user` → `tm8_delivery_worker`); the harness derives the
URL from **this run's scratch database** so it is not reserving against the wrong one; and
`reserve_session_message_delivery` **INSERTS**, so zero rows means **the call threw**.

**⚠ The throw is silently swallowed** — `messages-handoffs.ts:350-355` wraps the reserve/dispatch loop in
`catch { }` with no diagnostic. **This is the SECOND time that catch bit in one day**: it was already
known to swallow a startup assertion, which is why the `session_user` check was moved to boot. It then
swallowed the real failure it was never meant to hide. Stored-first is correct and is not disputed. But **from outside, a broken
delivery path is indistinguishable from a healthy node with nothing to deliver** — the same
measurement-validity class as a boolean availability probe, and precisely why the terminating cause
cannot be named from the CLI side. **A single log line in that catch would answer it.**

**Environment, stated because it changes what any green would have meant:** the run used a hand-supplied
local credential against a dev cluster whose `pg_hba.conf` is TRUST for `127.0.0.1/32` — **a property of
this cluster, not of the product.** At default configuration the variable is unset, and *"no delivery
rows"* then means **UNCONFIGURED**, not undeliverable. **Those were the same statement this morning and
are no longer.**

### O1 — the wiring, and why no CLI change is needed

```text
019_w2_messages_handoffs.sql:461   the RPC DOES emit a delivery intent for a work_session anchor
messages-handoffs.ts:326/338       the consuming loop is gated on `if (this.options.messageDelivery)`
facade/index.ts:126                registerW2MessagesHandoffsHandlers(registry, facade) — NO options
grep messageDelivery assignment    ZERO hits under packages/server/src
messages-handoffs.ts:96            /** G11 owns contact authorization, B2, and the existing reserve RPC. */
```

**The intent is emitted; the reservation is unwired.** So `message send --wait settled` correctly exits 0
with zero delivery rows and **exit 11 cannot be produced on this node.** No synthetic one was manufactured.

> **The moment `options.messageDelivery` is supplied, a work_session-anchored send with `--wait settled`
> exercises the real exit-11 path with NO change to CLI code and NO change to CLI tests.** The mapping is
> already mutation-tested in *both* directions (flipping the constant turns 11→0 *and* 0→11), the stored
> batch already reaches stdout *before* the throw, and the settle loop has already been run against a real
> `messages.delivery.get` DTO. **Just re-measure through the built binary.**

---

## 3. ⚠ The traps that will bite you

**Flagged hardest: the silent-skip cursor.** `entities.feed` and `inbox.list` encode cursors through
`iso()` (`facade/entity-read.ts:179`), which round-trips a `timestamptz` through a JS `Date` and **loses
microseconds**. Both are **DESC `<` keysets**, so truncating *down* does **not** duplicate — it **EXCLUDES
every row between the truncated value and the true boundary**.

```text
cursor rounded DOWN, ASC  -> re-admits the boundary row -> duplicates, loops.   LOUD.
cursor rounded DOWN, DESC -> SKIPS rows -> silent data loss. No error, no loop. INVISIBLE.
```

**A "terminates + no duplicates" assertion passes cleanly over this.** Measured: `collections.query`
walked **6/6 exactly-once while its cursor was provably truncated**. Assert the **mechanism** — decode the
cursor off the wire and require six fractional digits — and add an **exactly-once union check against a
known full set**, not merely duplicate-freeness.

**And `iso()` truncates on BOTH branches, including the string branch.** A fix that only changes SELECT
lists to `to_char(... .US"Z")` will **miss any call site that then passes the result through `iso()`.**
The correct pattern already exists in-tree: `edges.list`, `entities.connections`, `entities.activity`.

**Other traps, briefly:**

- **Exit 8 has two causes** — `run.ts`'s *"not implemented in this CLI build"* vs the Server's honest
  **501**. Same code, different fact, **distinguishable only by stderr text.** (Currently 0 of 98 commands
  are unwired, so the first branch has no live example — that will change if anything is ever unwired.)
- **`npx <tool>` from the repo root resolves OUTSIDE this repository.** `npx vitest` finds 1.6.1 from a
  neighbouring project and reports "no tests" for every file here. From outside the repo, `npx tsc`
  downloads an unrelated package named `tsc@2.0.4`. **Use `cd packages/cli && ./node_modules/.bin/<tool>`
  and quote the full RUN line including its trailing path** — the path is the load-bearing half.
- **`bun run typecheck` type-checks NO test file** (`include: ["src"]`). Check tests separately against an
  absolute scratch config — **and probe it**: a sibling's syntax error aborts the compile before your file
  is reached, so *exit 0 with zero diagnostics* is indistinguishable from *your file was never compiled*.
- **A piped exit status reports the last stage.** `vitest … | tail` returns **tail's** status — a failing
  suite reads as exit 0. Read the printed `Test Files` / `Tests` lines. (The background task runner has
  the same trap.)
- **A before/after hash bracket proves *same at both ends*, not *unchanged throughout*.** Never run a
  probe or transient edit while a suite you intend to report is in flight.
- **Backticks in an inline double-quoted `--message` are executed by the shell.** Send from a file via a
  quoted heredoc.
- **`cd db/migrations` before hashing the chain.** The same 32 files give `f7a9e137f01226f3` from there and
  `e856eb4232422249` from the repo root — `shasum` hashes its own output lines, which carry the path.

**⚠ A STALE EXAMPLE PROPAGATES FURTHER THAN A STALE CONCLUSION**, because it looks like *supporting
detail* rather than a claim. **Nobody audits an example.** It rides inside an argument that is otherwise
being checked and inherits the credibility of the claim it illustrates. Three instances found here: a
worker's *"`messages.post` is still a registered 501 stub"* (inherited from a pre-tranche packet), the
`event.ts` disclosure text, and the projection's "skeleton" note. **All were true when written.**

**⚠ A CHANGE IS ONLY AS GOOD AS THE NARROWEST POINT ON ITS PATH — and BOTH the layer above and the layer
below count as the path.** Three instances in one day:

```text
to_char microseconds in SQL   undone by   iso() downstream       (cursor precision)
NULL-means-absent in the RPC  undone by   ?? [] upstream         (mentions wipe)
a validator on resume.since   never sees  the pre-rounded value  (2^53 ceiling)
```

The third is a **new** member of the class: the others were checks satisfiable by the wrong thing; this
one is **a check that never sees the thing at all** — precision dies at the JS number boundary, upstream
of every validator. **Refusing beats rounding**, because rounding *down* duplicates loudly and rounding
*up* skips silently.

**⚠ REBUILD BEFORE YOU MEASURE — A STALE ARTIFACT IS A CODE PATH THAT IS NOT IN THE THING UNDER TEST.**
O1's first measurement produced zero delivery rows, and four hypotheses were eliminated before it was
reported. **The real cause was a `dist` built before the wiring landed** — it never calls `reserve`,
throws nothing, and returns exit 0 with zero rows, **which is every observation with no remainder**.
Eliminating four hypotheses left nothing standing **because both sides were reasoning about a code path
that was not in the artifact under test.** A rebuild produced exit 11 immediately.

**⚠ AND CHECK YOU ARE RUNNING THE RIGHT ARTIFACT.** `packages/server/dist/main.js` only *defines* `main()`
and exits **silently**; the real entry is `dist/index.js`, which invokes it. Running the wrong one
**produces silence that looks exactly like a result** — one author was a step from reporting *"the built
binary produces no boot log"*. Same family as the wrong test runner reporting "no suite found", the
`grep -c` that matched session command lines, and the digest of empty input.

**⚠ WHOEVER CHANGES THE INSTRUMENT DOES NOT TAKE THE READING.** The independence rule this program
applies to implementers and their acceptance tests applies **one level down, to harness edits** — and
nobody had said so until the last day. When the coordinator had to modify
`test/integration/harness.ts` to make O1 measurable, the measurement went to a different session, with
an explicit instruction to **disbelieve the change rather than confirm it**. That session reviewed it
before use and caught the detail that mattered: the derived value must be spread **last**, or the
inherited one leaks through.

**⚠ A DIGEST OF NOTHING LOOKS EXACTLY LIKE A DIGEST.** A worker's owned-files hash printed
`e3b0c44298fc1c14` — the SHA-256 of **empty input**. Bad quoting meant `shasum` read no files at all, and
the output was indistinguishable from a real result. **Print the empty-input control alongside every
digest** (`printf '' | shasum -a 256`) so a hash of nothing can never pass as a hash of something. Same
family as a `grep -c` that matched session command lines and a `cd`-less chain hash: **the number is real
and it is answering a different question.**

### The naming-authority rule — it settled every dispute here

> **contract over design doc · schema over instruction · tree over announcement**

Three findings routed as server defects were **not defects**: `projectEntityId` appears in exactly one
place in the repo (the grammar doc, zero occurrences in the contract), `reasonCode` appears **zero** times
in the contract schema file, and `savedViews.list` genuinely specifies an **unpaginated** list. **A stale
or aspirational document is an instrument too.**

**Never sweep a schema by name-grep.** The version guard is spelled **five** ways, so a grep for
`expectedVersion` sees **11 of seventeen** guard-bearing DTOs — and the six it misses are exactly where the
silent defects live. **Grep finds the name you thought of; runtime introspection finds the shape.**

### The one non-kebab flag — and why "fixing" it fails a test

`projects.associations.correct` uses **`--expect-version`** while its frozen field is
**`expectedArtifactVersion`**. Every other guard flag kebab-cases its field. **This is deliberate:** the
dossier writes the field correctly at §4:123-127 and then names the shorter flag at §7:335. The authority
chose it knowingly.

**It is pinned in a table-driven EXACT-SET assertion with those two line citations inside the table.** A
future reader who "normalises" it **fails a test rather than passing review** — verified by mutation. That
same table caught a **transposition where the counts stayed identical at 16 vs 16**: a count cannot detect
a pairing error, because a transposition is count-preserving.

---

## 4. What I would do first, given one more day

1. **Fix the two silent-skip cursors** (`entities.feed`, `inbox.list`). *Ranked first because it is the
   only open item that loses data with no error, no loop, and no failing test.* Everything else is either
   loud, expressiveness-only, or already witnessed. Make the cursor column **required** in the row types
   and **delete the `?? iso(...)` fallback**, so a future producer that omits it **fails to compile** —
   converting an invariant held by author discipline into one held by the compiler.
2. **Land the absent-means-merge fix**, and verify **both** halves: absent = leave alone, explicit null =
   clear. *A merge that cannot clear trades silent-destroy for silent-cannot-erase.* Reference
   implementation already in-tree at `007_rpc_catalog.sql:1039-1041`. This greens two witness tests
   automatically and closes four data-loss instances.
3. ~~Wire `options.messageDelivery` and re-measure O1.~~ **DONE — O1 closed.** Replaced by: **repair
   `019`'s Teammate-authored exited-target branch.** *It is the only path B2 exists to govern, it always
   raises, and `w2_delivery_fallback` sits below the raise — so the fallback is unreachable for exactly
   the class it was written for. A Member can always get a record of a dead target; a Teammate never
   can.*
4. **Fix the inverted `commands.undo` note.** *Trivial, and it currently tells an operator that redemption
   restores a message when it redacts one — a wrong belief about data recovery is worse than no belief.*
5. **Sweep the optional-field class server-side** — every RPC doing `props = excluded.props` or an
   equivalent whole-column overwrite. *Four instances were found from the CLI side by asking "which
   optional fields can a caller not express"; the SQL side tells you which of those are reachable as data
   loss rather than theoretical.*

**What I would NOT spend the day on:** re-running suites that are already measured, or chasing the
expressiveness gaps (`promptExtra`, read-only filter gaps). They cannot lose data, and inflating the
data-loss class with them would make the count meaningless.

---

## 5. One thing worth knowing about how this was built

**Five instrument defects were found here, and every one was found by a worker auditing its own record
rather than by anyone checking the product.** None of them produces an error. Each is a real signal
reporting on something other than what the reader assumes.

The habits that produced that, in order of how much they returned:

- **State what your mechanism does NOT explain.** An unexplained detail inside a confirmed finding is
  where a wrong mechanism hides. One `messages.list` diagnosis was *right about the defect and wrong about
  the cause*, and the fix it implied would have shipped a clean diff and left the bug live. The tell was in
  the report: identical reproduction across different data is evidence **against** a data-dependent cause.
- **Positive controls first.** A wipe means nothing unless you proved something was there to lose. A stale
  guard means nothing unless you proved the version actually moved — one no-op fixture nearly filed a real
  guard as fictional.
- **Report disproofs as disproofs.** Several rows are immune *by construction*, and saying why is worth as
  much as a finding.
- **Never soften a witness to match a defect.** Tests left red asserting contract-correct behaviour went
  green on their own when the server was fixed. A softened test would have gone green immediately and
  failed the day the bug was repaired.

---

## 6. The one problem this wave named and did NOT solve

Tests have probe-reds, mutation tests and exact-set quarantines. **Prose has nothing that goes red.**

Three shipped-false statements were found in a single day, **all three true when written**:

- `event.ts:193` told an agent the contract defines *"no client→server control message"* — falsified when
  the WS control protocol landed.
- `operations.ts` called `events.subscribe` *"an upgrade SKELETON"* — falsified by the same landing, so
  `tm8 help event watch` described a command that genuinely subscribes as a skeleton.
- A worker's own report claimed *"`messages.post` is still a registered 501 stub"* — falsified when G04
  composed.

The worker who found all three put the problem better than I can:

> **"A restatement has no owner: the original moves and the copy does not, and nothing in the copy
> records what it was copied FROM. My probe-red discipline protects assertions; it does nothing for
> prose. The only thing that caught all three was someone re-deriving the claim from the source."**

**And the tree actively sets this trap.** `packages/server/src/facade/handlers/messages.ts:191` still
defines `messagesPost`, which throws `not_implemented` and carries `messages.post`'s name — **with ZERO
call sites**; the live registration is `handlers/w2/messages-handoffs.ts:18`. Anyone who greps
`not_implemented` reaches the wrong conclusion from the *current* tree, and the stub's own message
explains that the real one is elsewhere, which reads as documentation of a live seam rather than an
epitaph. **Trace the call graph from the registration seam; do not grep for handlers.**

**The same class hit the program's own governance**: obligation O1 was restated in every packet as
*"exit 11 via `--wait settled`"*, dropping the contract's first disjunct — **non-delivered** — which is
stated first in five places including `exit.ts:44` and named in the canonical acceptance scenario at
`GRAMMAR:1148`. Everyone downstream, including this coordinator, built on the narrowed version for a day.

**No mechanism was found for this.** Cite the contract line rather than the restatement; re-derive a
claim from its source before repeating it; and treat any sentence describing *the current state of the
world* — rather than a contract fact — as something that will expire without notice. **That is guidance,
not a guard, and the distinction is the point.**


---

## 7. Late corrections, recorded because they were made against their authors' own interest

**Both witnesses went green on their own** — the work-note wipe when `037` landed, the mentions wipe when
the service line was repaired. **Neither needed a change to CLI code or CLI tests.** That is the entire
payoff of never softening a witness to match a defect: a softened test would have gone green immediately
and failed the day the bug was fixed.

**The mentions fix is the sharpest instance of the narrowest-point rule.** Migration `037` correctly
taught the RPC that `NULL` means absent — and it was **inert**, because
`messages-handoffs.ts:368` did `input.mentions ?? []`, converting absent into empty array in the *service*
before the RPC could ever see `NULL`. **A correct fix, a clean reviewable diff, and the bug still live.**
The repair threads absent *around* the normaliser (`input.mentions === undefined ? null : uniqueIds(...)`)
rather than through it, and the shape was then **swept rather than spot-fixed**: every `?? []` and `?? {}`
in the facade triaged with a stated reason — read-side projections are meaningless for absent-versus-empty,
`completerIds` is additive, and coalescing on **create** is correct because there is no prior value to
destroy.

**`B2` has three states, not two, and the record must not say "enforced."** Its storage, locks, RPCs,
adapter and budget logic are built and proven; the production path now **exists and is reachable**; and it
is **inert unless `TM8_DELIVERY_DATABASE_URL` is supplied**. On every node today, including the gate, the
variable is unset and the node behaves exactly as before. The implementation's own header says so; the
authorization that approved it overstated the effect, and that was corrected rather than left standing.

**Consequence for O1's evidence, and it is a downgrade:** *"no delivery rows, exit 0"* now has **two
causes — unconfigured and undeliverable — and the test cannot distinguish them.** This morning the same
observation meant "the reservation is unwired," which was a strong claim. It is now strictly weaker, and
it is recorded that way rather than left to ride on its old meaning.

---

## 8. Do not replace a retired tripwire with an inverse assertion

When the projection was corrected, the tripwire that had announced the divergence went red **as
designed** and was deleted. **Nothing was put in its place, deliberately.**

The tempting replacement — *"the notes no longer say skeleton"*, or *"the notes now mention the control
protocol"* — is **the same mistake pointed the other way: a test matching PROSE.**

> Pinning wording converts *"goes stale silently when the world moves"* into **"goes red when an owner
> legitimately rewords their own file"** — and the second is worse, **because it punishes the correct
> action.**

What the surviving tests assert instead is **structural agreement**, which cannot rot that way: the
command paths the projection names, the operations it binds, and `sideEffect:'none'` — and that last one
is checked **where it actually constrains behaviour**, in the test proving `event watch` never sends a
`presence.set` write, rather than as a standalone string comparison. **Facts with a mechanism behind
them, not sentences.**

A comment was left where the test used to be, explaining **why the gap is empty**, so the next reader
does not helpfully fill it.

---

## 9. ⚠ TWO DB SUITES CANNOT DISTINGUISH THE DELIVERY GUARD WORKING FROM THE GUARD ABSENT

**This is a durable property of the tests, not a schedule note.** It is filed on its own because the
deferral it explains will expire and **this will not**.

```text
test/db/w1-foundations.test.ts
test/db/w2-messages-handoffs.pg.test.ts
```

Both reach the delivery RPCs by doing **`set local role` from the SUPERUSER scratch pool**, and
`internal.require_delivery_principal` (`015:1346-1347`) is an **AND** that admits any principal
*permitted to assume* the role. **So both suites pass BECAUSE OF the hole.**

> **Tightening `015` turns them RED — not because the tightening is wrong, but because the suites were
> written against the permissive shape. They are green in the guarded world AND in the unguarded world,
> so they carry no information about which one they are in.**

**That is this program's both-halves failure living in the TESTS instead of in the schema:** a check
satisfiable by the wrong thing, one layer over. Whoever attempts the durable fix must **rewrite those two
suites to authenticate as the role rather than assume it** — that is the actual cost, and it is why the
fix is hard rather than merely deferred.

**Consequence, so nobody reads the deferral as low risk:** the boot-time `verifyDeliveryPrincipal` guard
protects **this node's wiring only**. Anything else reaching the delivery RPCs — a maintenance script, a
second node, a `psql` session — is still admitted by `015`, and **no test would notice.**

