# tm8 W0–W5 Program Close — START HERE

**Status: BOTH WAVES CLOSED.** W4's gate criterion is met literally — 48 files, 1150 passed, 1 skipped,
exit 0. W1–W3 closed with G3 readiness recorded conditionally. The program stops here: **W5 was cancelled,
so there is no independent CLI verification wave and no G5.**

**This document is the entry point.** The program produced ~7,000 lines of ledger across four documents.
Those are the evidence and they are authoritative — but they are chronological, they accreted over a
single very long day, and nobody who was not present can use them as a starting point. Read this first,
then go to the ledgers for detail. **Nothing here restates a ledger; everything points at one.**

| Document | Lines | What it is |
|---|---|---|
| `TM8-W0-W5-HANDOFF-STATE.md` | ~2,800 | Program law, amendments M-1…M-5, every ruling, every finding |
| `TM8-W4-CLI-IMPLEMENTATION-EVIDENCE.md` | ~2,400 | CLI/harness evidence + the CLI terminal handoff section |
| `TM8-W3-PUBLIC-AND-AGENTIC-EVIDENCE.md` | ~1,000 | Independent API verification, the §4 acceptance matrix |
| `TM8-W2-PREFLIGHT-AND-INTEGRATION-EVIDENCE.md` | ~900 | API implementation by catalog group |

**Governing authority, unchanged:** `TM8-W0-AMENDMENT-DOSSIER.md` + `TM8-W0-CONSISTENCY-MATRICES.md`.
When any document disagrees with the frozen contract, **the contract wins and the document is a
proposal** (§21.3). This rule was broken repeatedly, including in a full-program ruling, and it is the
single most useful thing to internalise before reading anything else here.

---

## 0. How to read this — the warning that governs everything below

**THE ARTIFACTS TRANSFER AND THE SKEPTICISM DOES NOT.** This document can record that **every coordinator
figure that was challenged fell** — to workers who opened a file. **It cannot cause that to happen again.**

**⚠ AND THIS SENTENCE USED TO CARRY A NUMBER, WHICH IS WHY IT NO LONGER DOES.** It said *fourteen* here and
*thirteen* in §7 — same document, neither carrying provenance, **unresolvable by construction.** The tally
was incrementing all day, so both were true when written and neither was re-derived. **A stale figure in the
opening paragraph of the section warning you about stale figures.** Found by the session briefed on this
document's own failure catalogue, which is the cheapest possible demonstration that the catalogue is real.
**What survives is the claim that can be checked without a count: no coordinator figure in this program
survived a worker challenge.**

**And the specific hazard is that you will inherit these conclusions WITH MORE AUTHORITY THAN THE PEOPLE WHO
WROTE THEM HELD THEM WITH.** Ours came with arguments attached and someone available to disagree. Yours
arrives as a document. **Every figure that fell today fell while sitting in a document, looking settled.**

That is why the limits here are stated **inline, next to the claims they qualify**, rather than gathered in
a section you might not reach — and **it applies to this document too.** Two hours before close, the CLI
handoff's own header still read a chain figure from two migrations earlier: **a stale number in the first
six lines of a document whose entire subject is stale numbers.** Its author reported it rather than quietly
fixing it, *"because that is the whole method and it should be the last thing on the record as well as the
first."*

**This file carries no chain digest for exactly that reason** — a wave argued the full-program coordinator
out of printing one, and that argument is what kept the same defect out of the entry point. **The recipe is
here; the number is not. Go measure it.**

---

## 1. The three rules that decide most arguments

Each was learned the expensive way, each cost a real defect, and each is stated as a comparison because
the failure mode is always mistaking one side for the other.

> **AN ANNOUNCEMENT IS EVIDENCE, NOT AUTHORITY. THE TREE IS THE AUTHORITY.** (§22.4)
> A coordinator announced a chain rotation from a monitor reading that had already been reverted, and
> ordered nine sessions to re-bind. Four workers refused and re-measured. Announce to *trigger* a
> measurement, never to *supply* the number.

> **AN INSTRUCTION IS EVIDENCE, NOT AUTHORITY. THE SCHEMA IS THE AUTHORITY.** (§23.3)
> A coordinator's hand-built table of version-guard fields was wrong on three of seven rows. Runtime
> introspection was right. **Grep finds the name you already thought of; introspection finds the shape.**

> **VERIFYING THE ARTIFACT IS NOT VERIFYING THE ARTIFACT'S DELIVERY.** (§22.1)
> A migration passed its own suite 15/15 and could not be applied by the real runner, because the suite
> applied it a different way than production does. **The applier is a third thing, and nobody was testing
> it.**

---

## 2. The finding underneath all the others

**This program's recurring failure is not ignorance. It is NON-TRANSFER OF KNOWLEDGE THAT ALREADY EXISTS
IN THE TREE. A comment prevents the bug in the file it is written in, and nowhere else.**

Measured, not argued. **Two handlers, one repository, one defect class, landed in one migration, and they
diverge:**

```
w2_edit_message   messages-handoffs.ts:377-379   input.mentions === undefined ? null : …
                  PRESERVES the distinction. All three branches reachable, gated 4/4.
set_work_state    handlers/commands.ts:38        input.note ?? null
                  COLLAPSES absent and explicit-null. The API cannot clear — and returns 200 when asked to.
```

**And the edit handler's own comment at `:369-375` names the exact trap the work handler fell into** — that
`?? []` would collapse *"said nothing"* into *"clear"* before the RPC sees it. **One author wrote the hazard
down and avoided it. The other hit it — same class, same landing, same repository, twelve files away.**

**It unifies every recurrence recorded separately in the ledger, and every one was known by somebody here
before it recurred:**

| Recurrence | Where the knowledge already was |
|---|---|
| microsecond `to_char` idiom | applied correctly at **3 sites**, missed at **8** |
| replay principal guard | **independently invented 4 times**, never generalised |
| exact-microsecond edge cursor | **named as a requirement** in the acceptance matrix |
| `set role` / `reset role` balance | **learned in W1.B2**, repeated 18 migrations later in `033` |
| absent-versus-null | **written down in a comment**, hit 12 files away in the same migration |

**⚠ AND W5 PRODUCED A STRICTLY BETTER INSTANCE THAN ANY ABOVE, because the knowledge was not merely
written down — IT WAS EXECUTABLE AND GREEN.** A migration candidate independently derived to repair a
delivery defect turned out to be **byte-for-byte identical** to repair text that
`packages/server/test/db/w2-execution.pg.test.ts` **applies transiently and reverts on every run**.

> **The correct SQL had been sitting in the test directory, applied and green, demonstrating its own
> sufficiency for an entire wave — and nobody landed it.** The evidence was also in the author's own first
> minute: an archived artifact whose *filename* names the exact constraint its candidate repairs, in the
> directory it was reading.

**The method failure is the transferable part.** Asked which files *reach* the function, it answered
exhaustively; it never asked what those files *assert* about it. **REACHABILITY IS NOT EXPECTATION.**

**Not one was a gap in understanding.** And it held at the coordination layer too, not just in code: a
ruling that closed one two-door label correctly was never asked whether it generalised, and two more labels
stayed open because of it; an obligation was narrowed in restatement and every downstream packet inherited
the narrowed version; both waves independently hit the same timestamp format-lock defect.

> **This is why detectors beat rules — a fact adopted empirically here long before the mechanism was
> understood. A RULE IS KNOWLEDGE THAT MUST TRANSFER TO THE WORK. A DETECTOR IS KNOWLEDGE COMPILED INTO
> SOMETHING THAT FIRES WHETHER OR NOT ANYONE READ IT.** It is the same reason a comment in the right file
> cannot help the wrong file, and the same reason a caveat that lived only in a test name died to a rename.

**If you take one thing from this program: when you learn something, do not write it down — wire it to
something that fails.**

### ⚠ 2.1 — and W5 then found that rule failing on its own terms

**A remedy the W4 handoff ranks as its own top recommendation does not work, and it was implemented.** The
recommendation: *make the cursor column required in the row types and delete the fallback, so a future
producer that omits it fails to compile — converting an invariant held by author discipline into one held by
the compiler.* It shipped, with comments saying so.

```
db/types.ts:45   query<R = Record<string, unknown>>(sql, params): Promise<R[]>
```

**`R` is a caller-supplied assertion with no relationship to the SQL text. The compiler never sees a SELECT
list.** Measured, both halves, with the probe probed: an **object-literal** producer omitting the required
field errors `TS2741`; a **raw-SQL** producer omitting the same field compiles clean, **exit 0**, file
confirmed in the checked set.

> **THE MECHANISM IS REAL EXACTLY WHERE IT CANNOT HELP AND BLIND EXACTLY WHERE THE BUG IS.**

**"Wire it to something that fails" was followed — and the thing it was wired to cannot fail.** And the
comment is now worse than no comment: **it asserts compiler enforcement that does not exist, so the next
reader has been told not to check.**

**The pattern that does work is already in-tree and is a RUNTIME REFUSAL:** `collections.ts:192-203` throws
`upstream_unavailable` when the key is absent, null, or not exact text — it would have caught the live defect
on the first request. Three spellings of one invariant coexist (one throws, one silently returns null, one
does neither), **and this time one of the three is load-bearing and correct.**

**Also stale at the work-queue level: that handoff's number-one ranked item — the two silent-skip cursors —
was ALREADY FIXED** at both headline sites before W5 opened. A duo would have spent its entire allocation
writing witnesses for a repaired defect. **A stale example in a PRIORITY LIST, not in a comment.** It
survived because the ledger row had three citations and **two of the three were exact: a partially-correct
citation is more durable than a wholly wrong one.**

**And a third forgeable identity check, not previously written down:** `current_setting('is_superuser')` has
the same trap as `current_user` — **`SET ROLE` to a non-superuser DROPS the flag**, so `is_superuser=off` is
**not** evidence of a non-superuser connection. **Three of the four obvious discriminators read identically
in both worlds; only `session_user` survives `SET ROLE`.** Production is already correct — this is recorded
as a **disproof**, because it is the plausible-looking simplification that would silently reintroduce the
class.

## 3. The defect class this program actually found

Not a bug — a *shape*, which recurred in a new subject roughly every hour and was never once predicted in
advance:

> **A CONDITION SATISFIABLE BY SOMETHING OTHER THAN THE THING IT IS CHECKING FOR.**

Confirmed instances, all measured:

- **`73 + 25 = 98`** — four independent derivations agreed. All four counted *registration*. Four authors,
  one mechanism: **a tautology wearing the costume of a cross-check.** (§15.5)
- **A lint that fires on everything** passes its mutation test exactly as well as a correct one, because
  a mutation test proves the detector **responds**, never that it **discriminates**. **Every detector needs
  a negative control — green on the known-good baseline — not only red on the known-bad case.** (§23.1)
- **An exactly-once paging assertion walked over a proven-defective site and reported green**, because
  the defect only manifests when two rows share a millisecond *and* straddle a page boundary. **Sequential
  fixtures report clean green across every defective paging site in the catalog.** (§23.2)
- **An unscoped `pg_locks` barrier** satisfiable by any unrelated lock anywhere on the host — *cannot*
  produce a false green of the security property, *can* produce a false claim of race coverage. A
  sequential test wearing a concurrency label. (§23.14)
- **Implicit-`any` inside an assertion** — `expect(x).toBe(y)` where both sides drifted to `any` compares
  things the author believed were type-constrained. (§23.15 / the 92)
- **A count cannot detect a pairing error**, because a transposition is count-preserving. Caught by an
  exact-set assertion at **16 vs 16 identical counts**. (§23.3)
- **A test named for a defect that only fires when BOTH halves of the defect are present is weaker than its
  name implies.** Mutating one half alone — a defaulted cursor, with seeding left intact — turned only one
  test red, while the test literally named *"a bare subscribe delivers NO history"* **stayed green**,
  because seeding masked it. Found by a worker mutating its own passing suite, and reported instead of the
  more flattering combined figure.

- **A caveat stored in a mutable identifier is deleted by a rename.** The probe's test was named *"the N v1
  bindings that refuse an EMPTY probe"* — the word `EMPTY` was the entire caveat, and a re-pin renamed the
  test and dropped it. The measurement stayed correct; **its scope stopped being written down anywhere.**
- **A FILE THAT ANSWERS "I CANNOT TELL YOU" WHEN THE ANSWER IS AVAILABLE IS NOT A WORKING DETECTOR.** A
  defect pin's `beforeAll` guard threw in the post-fix world, so all 8 tests **skipped**, the inversion
  instruction written for exactly that moment printed **zero times**, and the acceptance criterion never ran
  — so at the one moment it mattered the file gave **no positive confirmation that the fix worked.** Its
  mutation tests covered *does the pin flip* and *does the derivation refuse a changed shape* — never **what
  happens when the FIX lands**, which is the single transition the file exists to survive.
- **A reassuring number from a single sample of a bursty process is the sample, not the rate.** A two-sample
  CPU delta read 25% of one core; a second reader's sample read 62%, and the lifetime average agreed with
  the *higher*. The process was phasic — which its measurer predicted **in the same message, against its own
  conclusion**, reporting both figures rather than the one that suited the argument. *The full-program
  coordinator made this exact error one report earlier, ruling on a single 7.4% sample.*
- **An unrun test file is not inert.** It has no baseline, so **its first execution is a baseline arriving
  inside somebody else's verdict.** And a **file-level abort cannot be subset-matched** against a named
  expected-failure set — it produces no test names at all — so it is an automatic gate failure.
- **A FAILURE MODE THAT MIMICS THE DETECTOR'S OWN POSITIVE SIGNAL.** The two vitest timeout settings are
  configured independently and fail in **opposite** directions against an exact-set gate: `afterAll`
  (10s default) produces a **file-level abort with every test passing and no failing test name**, while
  `testTimeout` (5s default) produces a **NAMED failure** — which a subset check matches against the set,
  finds absent, and calls a regression. *"The failure mode my criterion was least able to see through,
  because it looks exactly like what the criterion detects."* A gate must therefore assert **zero timeouts
  of either spelling** as a separate property, not infer it from the failure set.
- **AN IDIOM COPIED "IN SPIRIT" SILENTLY SKIPS THE SITE THAT DIFFERS — the mirror of the non-transfer
  class.** A resource-binding packet asserted that eleven doors all bound against a uniform first parameter.
  Measured false by the implementer: each binds against **its own** first argument, and copying the shape
  rather than re-deriving it per site **would have bound ten and skipped the eleventh with no signal.**
  Non-transfer is knowledge that failed to travel; **this is knowledge that travelled as a SHAPE instead of
  as a DERIVATION, and was wrong at exactly the site that mattered.**

- **AN ASSERTION WHOSE PREMISE EXPIRES.** Two agentic tests assert `residual >= 6`. Residual is now
  **zero** — they sample residual operations to prove they refuse honestly, and **there are none left to
  sample.** Re-pinning them to `>= 0` produces **a green that describes nothing.** Third instance of the
  class; the gate **declined to author the fourth** and recorded PREMISE EXPIRED instead. **A red with a
  recorded reason beats a vacuous green** — and a two-line edit at the close would have produced a clean
  sweep that nobody would have questioned.

**THE CLOSING SYNTHESIS, and it is the most compressed true thing this program produced: THE EXPENSIVE
ERRORS WERE NEVER WRONG FACTS. THEY WERE CORRECT MEASUREMENTS WHOSE SCOPE OUTRAN WHAT PRODUCED THEM.**

| The measurement | What it actually established | What it was read as |
|---|---|---|
| residual count | operations **mounted** | operations **implemented** |
| a true database size | disk **occupied** | disk **reclaimable** |
| an accurate all-quiet | quiet **at that instant** | a **standing state** |
| a correct migration | the DB **can** express it | the **API** can |
| a role-check control | safe as a **query** | safe as a **boot** |
| a green test run | the **binary** works | the **source** works |

**Every one was a true sentence with a false neighbour, and the neighbour is what got acted on.**

**The purest instance came last, and its detection is the argument for running two waves.** A defect was
filed as *"every wake aimed at an exited session returns an invariant violation."* The **causation test was
always correct** — it used a Teammate-authored message, and red/repair/green/revert/red held throughout.
**The prose over-generalised from a sound test: the scenario that was run got described as the whole
class.** It was caught only because the other wave produced a green the description made *impossible* —
a `failed_permanent` row on attempt 1 could only come from the branch the defect claimed always threw. **So
either the defect was wrong or the green was.** The filer went and measured rather than picking.

> **TWO WAVES' OUTPUTS CONTRADICTING EACH OTHER CAUGHT AN ERROR NEITHER WAVE COULD HAVE CAUGHT ALONE.**
> Without that row, the over-broad scope ships. This is corroboration's useful inverse: **disagreement
> between independently-produced results is a detector, and it exists only if the results were produced
> independently.**

**And that reframes the rule the whole program ran on.** Independence was enforced as a **fairness** rule —
no session verifies its own work, no implementer edits the test that judges it. **It paid off as an
INSTRUMENT.** The contradiction that caught the over-broad scope was *available at all* only because the
green and the defect were produced by sessions that could not see each other's reasoning.

> **INDEPENDENCE ENFORCED FOR INTEGRITY TURNS OUT TO BE INDEPENDENCE ENFORCED FOR DETECTION** — and the
> detection is the larger return. If you keep one structural rule from this program, keep that one, and keep
> it for the second reason rather than the first.

- **`current_user` vs `session_user` — the check that would pass in exactly the case it exists to catch.**
  As a superuser, after `set local role tm8_delivery_worker`, **`current_user` reads
  `tm8_delivery_worker` while `session_user` still reads the superuser.** A role guard written against
  `current_user` is therefore satisfied by the very impersonation it was added to detect. Only
  `session_user` survives `SET ROLE`.
- **A boot log that cannot distinguish "not configured" from "running a stale binary."** Both print the
  same line, because a binary predating the feature has no feature code to report on. **The recipe is
  REBUILD, THEN READ — in that order.** The line answers *which world is this binary in*, never *is this
  binary current*. Stated by the author of the line, about the line, unprompted.
- **Running the wrong artifact produces silence that looks exactly like a result.** `dist/main.js` only
  *defines* `main()` and exits silently; `dist/index.js` is the entrypoint. One step from concluding *"the
  built binary produces no boot log."*

**The general countermeasure that emerged: state what a check can be satisfied by, not what it asserts.**

**And its harder sibling, which this program hit twice on the last day:** *a wrong number gets caught; a
**right** number carrying a wider scope than its mechanism supports does not.* Both times the figure was
never wrong — only the sentence around it. **IMPLIES IS NOT STATES.**

---

## 4. What exists, measured

```
migration chain     MEASURE IT — do not trust a digest written in a document
                    (cd db/migrations && shasum -a 256 *.sql | shasum -a 256 | cut -c1-16)
                    THE cd IS LOAD-BEARING — shasum hashes its own output lines, which carry the path
                    as typed. Four cwds give four different digests for byte-identical files. (§21.8)
contract catalog    101 rows = 99 v1 + 2 reserved · 100 HTTP + 1 WS
                    digest sha256:df96ff5a4c2d11e41ec1d7b9c5e460bdcb8ae8d9c2c99b140f59e08305f8d604
                    (stable since W1; unlike the chain, this one did not move)
composed surface    every v1 non-WS operation is MOUNTED — residual enumerated empty.
                    MOUNTED IS NOT IMPLEMENTED. See the caveat below; the distinction is not closed.
CLI                 8 groups · 21 domain modules · registry wired · dispatch verified on the built binary
                    final gate: 48 files / 1150 passed / 1 skipped / exit 0
                    the ONE skip is `it.skipIf(unwired.length === 0)` — it skips BECAUSE every command
                    is wired, which is the only skip in this program that means its own opposite
server suite        excluding test/w3: 65 files / 702 tests / zero failures · contract 42/42
migrations landed   032 resource binding · 033 the shared principal pin (92 sites, fail-closed on the
                    NULL cells proven reachable) · 034 tracking fan-out · 035 event-seq grant AND policy
                    · 036 eleven doors + two repairs of bindings we had FALSELY CLAIMED · 037 absent-
                    means-merge + the unauthenticated ledger write + claim_text.
                    Each gated BEFORE announcing. Two attempts failed and were reverted inside their
                    windows, costing nobody a poisoned verdict.
```

**No chain digest is printed here deliberately.** It moved four times during the program's final hours and
would be stale on the day you read this. **The recipe is the durable content; the digest is not** — which
is this program's own rule that an announcement supplies a *trigger*, not a *value* (§22.4).

**The "mounted ≠ implemented" caveat — READ THIS BEFORE QUOTING ANY SURFACE NUMBER.**

**What is soundly established: every v1 non-WS operation is MOUNTED.** The probe omits the request body,
which is sound *for mounting* because of router ordering, verified in code rather than from a header
comment: handler **lookup** at `server.ts:163-164` (throws `notImplemented` if absent) precedes **schema
validation** at `:166` precedes **handler execution** at `:182`. An unregistered operation therefore returns
501 regardless of body, because it never reaches validation — **a no-body probe cannot miss an unmounted
operation.**

**What is NOT established: that every operation is IMPLEMENTED.** A *registered* operation whose handler
throws `not_implemented` is **invisible** to that probe whenever the operation has an `INPUT_SCHEMAS`
entry — the empty body fails validation at `:166` and returns **400 before the handler runs** at `:182`.
**That is exactly the original `73/25` defect's shape (§15.3), surviving in the half of the pipeline this
probe cannot see.**

**THE SWEEP HAS NOW BEEN RUN, AND IT IS HALF-DISCHARGED — record it in exactly these words:**

> **Every v1 non-WS operation reaches handler code under a schema-valid body, and none answers 501 from any
> of the three origins.**

**"Mounted is not a 501 stub" is CLOSED. "Refuses is not implemented" is OPEN.** The gap is concrete:
**84 of 98 are refusals and 45 of those are 404 against a UUID that does not exist — and a fully
implemented handler and a registered-but-hollow one produce the SAME 404, because no row was ever seeded
for either to find.** Proving *implemented* needs a different instrument: **seeded rows where a correct
handler MUST return data and a hollow one still 404s.** Not built.

*This constraint was sent upward by the sweep's own developer, acting as second reader against its own
tester's green — because this section records that "every v1 operation is implemented" was almost shipped
once, and a green sweep is exactly what tempts someone to write it again.*

**⚠ AND ONE OF THOSE TWO EXAMPLES WAS MIS-SPECIFIED HERE — corrected 2026-07-27.** This section previously
offered *"`entities.create`, 501 on an unsupported kind"* as the model **honest conditional refusal**, which
is the reference example for the very axis the sweep turns on. Measured on this tree:
`services/w2/entities-commands-tracking.ts:940` throws `CollabError('forbidden')` → **403**, while
`:1018`'s **structurally identical** default arm — same `!kind.startsWith('c:')` test — throws
`not_implemented` → **501** for `entities.patch`. **So the 501-on-kind belongs to `patch`, not `create`.**
The only `entities.create` 501-on-kind is `handlers/entities.ts:511`, gating on an allow-list
(`SUPPORTED_CREATE_KINDS`, `:57`) rather than the live prefix test — **a different mechanism in a
zero-call-site path.** The example was very likely read off the dead file.
**Whether `create`'s 403 is correct is an open empirical question one probe pair settles, not a defect
claim** — a lifecycle owning the kind is arguably *forbidden* rather than *unimplemented*. **The mis-stated
example is the recorded error here; the asymmetry is a question.** A stale example propagates further than a
stale conclusion, because it reads as supporting detail rather than as a claim.

**A 501 HAS THREE ORIGINS, NOT TWO, and any sweep must separate them:** the **router**
(`http/server.ts:164`, before validation), the **handler** (the sweep's actual target), and **Postgres** —
`SQLSTATE 0A000` mapped to `not_implemented` in **two** places (`http/errors.ts:56`,
`identity/pg-store.ts:80`). All three arrive as `error.code = "not_implemented"`. **Booking a database-side
`feature_not_supported` as a handler stub would put a FALSE entry into the one instrument this program
lacks** — worse than a missing entry, because someone would then "fix" a handler that was never broken.
Discriminate by `pg_catalog` on RPC names, never by message text.

**The missing instrument is specified in the handoff so the next person does not start from scratch:** for
each of the 98 v1 non-WS operations, send a body that *passes* its `INPUT_SCHEMAS` entry (or no body where
it has none) and record which return 501 **from the handler** rather than from the router. The cheap 80% —
operations with no `INPUT_SCHEMAS` entry are already handler-reached by the existing probe, and minimal
valid bodies for the schema-bound ones can be **generated from the Zod schemas** rather than hand-written.

*This was nearly written into this document as "every v1 operation is implemented." It was caught by asking
which instrument produced the number — see §7 item 2.*

**W0** closed the design with a fresh Opus gate (G0, then G0.1). **W1** built contract, migrations,
conformance and identity foundations; **G1 was USER-WAIVED, not approved — no Opus verdict exists for
W1.** **W2** implemented and composed the API by catalog group. **W3** independently verified much of it at
the public boundary — **not all of it; see §6.** **W4** built the CLI and harness. **W5 does not exist.**

---

## 5. What is open — read this before changing anything

**Volatile: this section is accurate as of program close. Verify against the tree before acting.**

**Standing open at close, in severity order. None of it blocks reading the code; all of it blocks
shipping.**

1. **A `clientMutationId` is harvestable** through five composed read routes. Nobody may write that cmids
   are unharvestable — that was measured false.
2. **Same-principal resource confusion beyond the bound sites** — 81 class-D sites plus `entities.patch`'s
   eleven doors, recorded **UNMEASURED, NOT SAFE**. Enumerated in `TM8-SEC1-STAGE2-ENUMERATION.md`.
3. **`note: null` is accepted with a 200 and silently does nothing** — and a *worked correct example of the
   fix sits twelve files away* at `messages-handoffs.ts:377-379`.
4. **`015`'s `require_delivery_principal` still admits an assumed role** for every client except the one
   wiring that now asserts `session_user` at boot. **Stated exactly, because both an over-claim and an
   under-claim of this were caught in the last hour:** the code **cannot** constrain *what an operator puts
   in the URL*, but the node **refuses to start** unless that URL **authenticates as** a non-superuser
   `tm8_delivery_worker` — asserted before `listen()`. It is a **mitigation, not a fix: it protects THIS
   WIRING ONLY.** `015:1346-1347` is an `AND` and still admits any principal *permitted to assume* the role
   — a maintenance script, a second node, a `psql` session. And the guard checks **which role the connection
   authenticated AS, never HOW it authenticated**; the TRUST-auth environment caveat is a separate,
   unaffected fact.
   **⚠ THE DURABLE FIX IS BLOCKED BY A FINDING OF ITS OWN: tightening `015` turns
   `test/db/w1-foundations.test.ts` and `test/db/w2-messages-handoffs.pg.test.ts` RED, because they reach
   the delivery RPCs by `set local role` from the SUPERUSER scratch pool and PASS BECAUSE OF THE HOLE.
   TESTS THAT PASS BECAUSE OF A SECURITY GAP ARE THEIR OWN FINDING**, and they must be fixed before the gap
   can be.
5. **`019`: TEAMMATE-authored deliveries to an exited or failed target throw and write NO row.** Rescoped
   by its own filer in the program's last hour — **narrower than filed in one direction, worse in the
   other.** *Member*-authored deliveries to a dead session work correctly and record `session_not_live`;
   the discriminator is `source_work_session_id`, which is null for a Member and non-null for a Teammate,
   so one branch satisfies the `pair_shape` constraint and the other violates it. **The broken half is the
   worse half: Teammate-to-Teammate is the only path B2 exists to govern**, a Member can always get a record
   of a dead target and **a Teammate never can** — and `w2_delivery_fallback` sits *below* the raise, so
   **the fallback written to catch an undeliverable Teammate message is unreachable for the entire class it
   was written for.**
6. **No independent race harness was ever built** (see §6), 64 skipped tests nobody established the gating
   for, and the **never-gated surface**: G04's `delete`/attachments/`delivery.get`/handoffs, G12's
   behavioural branches, G13's feed matrix.

- **`TM8-W4-CLI-HANDOFF.md`** — the CLI/harness handoff, written for a first-day reader: what exists, what
  is open with each unblock, the traps that will bite you, and what its author would do first given one
  more day. **Read it before touching `packages/cli`.** Evidence detail lives in
  `TM8-W4-CLI-IMPLEMENTATION-EVIDENCE.md`; the handoff points at it rather than restating it.
- **See `TM8-W0-W5-HANDOFF-STATE.md` §19.2** for the pre-ship blocker list, and **§23.9** for the two
  gaps that are **permanent** because no later wave exists to close them.

**The security posture, stated once, plainly.** Nothing is deployed and there is no user data. The program
**measured** — did not infer — a working cross-Space read primitive on the public API, assembled from two
facts each of which had been separately assessed as low severity:

1. A `clientMutationId` is **harvestable** off five composed read routes (§23.8).
2. Replaying one at an unbound site returned **another Space's entity under a 201** (§23.12).

Every step is same-principal, so the principal pin does not fire.

**THE CHAIN IS NOW BROKEN AT ITS SECOND LINK, NOT ITS FIRST — and the distinction is the whole point.**
Migration `036` bound eleven doors of `entities.create` plus two bypassable delivered bindings. The gate
that authored the acceptance criterion re-measured it at the public boundary: **before `036`, 201 leaking
Space A's projection; after, 409 `invariant_violation` with nothing leaked** — and, crucially, its
**positive control passed on the landed chain**, asserting *ahead* of the negative that a same-principal,
same-cmid, **same-Space** replay still returns the identical entity. So the refusal is **resource-scoped,
not blanket** — proven by an assertion written *before* the fix existed and unchanged since. *A guard can
pass every negative ever written by refusing everyone;* this one does not.

**What that supports, and what it does not.** The **measured** defect is closed at 13 sites. **The CLASS is
not closed.** Stage 2 enumerates **81 class-D sites**, and `entities.patch` is **eleven more doors,
explicitly declined as scope and recorded UNMEASURED, NOT SAFE** — see
`TM8-SEC1-STAGE2-ENUMERATION.md`. **Do not read this as "resource confusion closed."**

**Link 1 is untouched and still true: a `clientMutationId` remains harvestable.** `036` binds the
*resource* half and does nothing about *publication*. **So the next unbound resource-bearing site re-forms
the chain without anything new having to be discovered** — which is exactly why the pre-ship list matters
more than the fix does.

**The lesson survives the fix and is the reason to keep this paragraph:** the severity of a composed chain
is not the maximum of its parts, and **a residual accepted in isolation must be re-read whenever a second
residual lands near it.** Two of the five read routes did not exist until this program composed them — the
transition from "true tomorrow" to "measured true" took about four hours, **by the program's own deliberate
act**, which was the right way to take a known risk *provided the moment of transition is recorded as
loudly as the prediction was*. It is, here. **The next residual pair will not have been predicted.**

**Do not ship without closing the pre-ship list.** *Must be fixed before anything ships* was misread once
as *must be fixed before anything composes*; those are different gates and only the first is real (§19).

---

## 6. Honest limits of this program's evidence

Stated because a handoff that omits them is worse than none:

- **W3's public verification does NOT yet cover everything composed.** The per-branch acceptance matrices
  for **G04, G12 and G13 are incomplete**; G14 is done and green. A reader who takes §3's "independently
  verified at the public boundary" as covering the whole composed surface will be wrong about three of the
  four groups in the final tranche.
- **`bun run typecheck` type-checks no test file anywhere.** Every "root typecheck green" claim in every
  packet was **overstated as to tests** and is not withdrawn as to `src`. **Zero errors in
  `packages/server/src`; 92 in W3 test files, never seen by any routine anyone runs.** (§11.2, §23.15)
  **Triaged, and the result is better than it sounds — but read its limits.** 44 of the 92 sit inside
  assertion expressions, 48 in fixture/setup. **None can produce a vacuous pass:** 42 of the 44 are
  `unknown`-typed, and `unknown` is TypeScript's **safe** top type — it *refuses* operations rather than
  silently permitting them. Only 2 are implicit-`any`. Of all 44, three use a matcher a drifted `undefined`
  could plausibly satisfy, and that matcher is `toBeNull()`, which is strict — `undefined` **fails** it.
  **No W3 verdict is downgraded.** *Limits that travel with that conclusion:* it is a **static
  matcher-shape analysis, not a mutation test**; it had **no second reader**; and **these suites passing is
  not evidence, because a vacuous assertion passes too.**
- **`test/w2/reserved-honesty.test.ts` has drifted from the shipping composition and under-reports by
  exactly one.** It prints `mounted=97 residual=1 presence.get` because it builds a registry **without a
  presence source**, while `main.ts` always constructs one; production measures **98 / residual 0**. Both
  readings are correct and they measure **different configurations** — but this is the detector both waves
  quoted, so a future reader comparing it against production will see a phantom residual.
- **Per-group PG fixtures are isolation proofs, not coverage proofs.** *Migrations apply* + *each group
  passes against its own migration* **⇏** *operations work under the full chain.* Cross-migration
  constraint interactions live exactly in that gap. (§11.4)
- **A verdict binds to the composition and the chain it was measured against.** Several W3 verdicts are
  coverage holes rather than false verdicts — the distinction is preserved deliberately (§15.6).
- **G1 was waived.** W1 has no gate verdict.
- **64 tests skip, and NOBODY IN THIS PROGRAM ESTABLISHED WHAT THEY ARE GATED ON.** Seven named files carry
  skip constructs — `test/db/claims.test.ts`, `test/db/loopback.test.ts`,
  `test/events/loop-visibility.pg.test.ts`, `test/events/poll.pg.test.ts`,
  `test/facade/contract-shapes.test.ts`, `test/facade/loop.test.ts`, `test/sidecar/lifecycle.live.test.ts`
  — while **six** files skip *entirely*. **The two sets overlap heavily and are NOT proven identical**: a
  file with *some* skips reports as passed-with-skips, so "files containing a skip" and "files skipped" are
  different measurements. The count has been stable since W1.
- **No independent executable race harness was ever built** — a trade made deliberately to buy the
  tranche-v3 composition, and **permanent**, because no later wave exists. The assertion the existing
  suites use to claim race coverage **was** unscoped and **has since been tightened** to pin both backend
  pids and the lock key; it was re-run and **the claim survived**, so that evidence was
  **under-evidenced, not wrong**. **Both halves still have to be read together: a better-scoped assertion
  inside the implementer-adjacent suites IS NOT AN INDEPENDENT HARNESS**, and "tightened and green" must
  not be read as the gap being closed. (§23.9, §23.14)

---

## 7. For whoever picks this up

1. **Read the frozen contract before any document.** Three coordinators wrote proposal language into
   rulings as though it were contract.
2. **Re-measure anything with a number attached.** No coordinator figure in this program survived a worker
   challenge — **not one, across every challenge made** (see §0 on why no count appears here). The workers
   were right every time, and they were right
   because they read the source instead of the message.
3. **Ask what a green can be satisfied by.** That question found more real defects here than any amount of
   additional testing.
4. **A comfortable finding gets more scrutiny, not less.** Every misattribution recorded here ran in the
   reassuring direction, and each survived because nobody wanted to re-derive good news.
5. **Weigh a finding by the filter that produced it, and demand that filter be published.** The
   verification seat closed with **seven confirmed findings against ten self-caught false reds** — it killed
   more hypotheses than it sent. That denominator is why all seven were acted on without re-derivation.
   **Seven findings from a seat that sends everything are worth far less than seven from a seat that killed
   ten, and you cannot tell them apart from the findings alone.** Publish your own false-positive rate
   beside your results; almost nobody does, and it is what makes results usable by someone who cannot
   re-check them.
