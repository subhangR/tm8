# W5 Duo A — the two suites that passed BECAUSE OF the security hole

**Tester:** `sess_1785145055754_ttvv6jbim`. **Second reader:** Duo A developer,
`sess_1785145217566_qztz17b6h`. **Archived before the fix lands**, because the fix destroys the
ability to re-capture the assumed-role admission.

---

## 0. Instruments, re-measured not inherited

```
chain          34 files / a799b7ef1b20a9b0     (cd db/migrations && shasum -a 256 *.sql | shasum -a 256 | cut -c1-16)
empty control  e3b0c44298fc1c14                (printf '' | shasum -a 256)  -- differs, so the digest had input
```

Unchanged at close of this work. **No migration file was touched.**

---

## 1. Baseline, archived before any edit

```
RUN  v2.1.9 /Users/subhang/Desktop/Projects/tm8/packages/server
 ✓ test/db/w1-foundations.test.ts          (15 tests) 1728ms     EXIT=0
 ✓ test/db/w2-messages-handoffs.pg.test.ts  (5 tests) 1089ms     EXIT=0
```

---

## 2. The guard, from the catalog and not from the file

`019` redefines `reserve_session_message_delivery`, so the migration file is not the definition of
its own function. Read with `pg_get_functiondef` against a scratch database carrying the full
34-file chain:

- `internal.require_delivery_principal` has **exactly one** definition. It is `015:1339-1385` and
  it is **never redefined**. (Independently confirmed by the developer.)
- **Exactly three** functions call it (`prosrc` scan): `reserve_`, `claim_`, `settle_`.
- Those three are **exactly** the functions `tm8_delivery_worker` may EXECUTE. No granted door
  into the delivery surface bypasses the guard.

---

## 3. THE FINDING — the five-cell truth table

Discriminator is the **error text**, not the code: the role check and the tuple check both raise
`42501`, so a test asserting only the code cannot tell which limb fired.

- `message not found` = the guard was **PASSED** and the body was entered.
- `system delivery adapter database role required` = the **role check fired**.

| world | assumed role (superuser + `set local role`) | AUTHENTICATED as `tm8_delivery_worker` |
|---|---|---|
| **UNGUARDED** — role check deleted outright | **PASSES** → `message not found` | *(n/a)* |
| **GUARDED** — `015` as shipped, live today | **PASSES** → `message not found` | **PASSES** → `message not found` |
| **TIGHTENED** — `session_user` limb only | **REFUSED** `system delivery adapter database role required` | **PASSES** → `message not found` |

**Row 1 against row 2 is the finding.** Under the two suites' access pattern the unguarded world
and the guarded world produce the **identical observable**. The suites were green in both and
therefore carried **no information about which one they were in**. They were not weak tests of the
guard; they were **not tests of the guard**.

**Row 3 across is the acceptance evidence.** Red on the assumed principal, **green on the authentic
one, in the same world** — the tightening discriminates rather than refusing everyone. *A guard can
pass every negative ever written by refusing everyone; this one does not.*

---

## 4. Three of four obvious discriminators are FORGEABLE

Measured, both shapes, on the applied chain:

| | `session_user` | `current_user` | role GUC | `current_setting('is_superuser')` |
|---|---|---|---|---|
| authenticated worker | `tm8_delivery_worker` | `tm8_delivery_worker` | `none` | `off` |
| superuser + `set local role` | **`tm8`** | `tm8_delivery_worker` | `tm8_delivery_worker` | `off` |

`§24.2` names `current_user`. **`current_setting('is_superuser')` is a third value with the same
trap and was not previously written down**: `SET ROLE` to a non-superuser drops the flag, so
`is_superuser = off` is **not** evidence of a non-superuser connection.

**This is a near-miss, not a defect.** The production boot check
(`execution.ts:355-368`, `verifyDeliveryPrincipal`) correctly uses
`pg_roles.rolsuper WHERE rolname = session_user`. **Reported as a disproof.** The new test fixture
mirrors that exact predicate so the test's premise and the node's boot assertion cannot drift.

---

## 5. What the rewritten assertions CAN BE SATISFIED BY

Two assertions in `w1-foundations.test.ts` look like guard evidence and are not. Both survive the
tightening; neither is evidence about `require_delivery_principal`. Recorded inline in the file.

| site (**current**) | site (**pre-edit**) | measured refusal | satisfied by | survives guard deletion? |
|---|---|---|---|---|
| `:637-643` `tm8_app` denied | *was* `:572-578` | `permission denied for function reserve_session_message_delivery` | the EXECUTE revoke (`015:2201-2204`, `019:1352-1354`) | **yes** |
| `:668-670` worker cannot read the table | *was* `:596-599` | `permission denied for table session_message_deliveries` | the table revokes (`015:2191`) | **yes** |

> **CITATION DRIFT, SELF-CAUGHT AND RECORDED RATHER THAN SILENTLY REPAIRED.** The pre-edit
> column is kept because I quoted `:572-578` and `:596-599` to the developer and the coordinator
> **before my own edits moved them**. They were correct when sent and expired underneath the
> message — the stale-caveat class (§24.2), produced by me, inside the work that names it. Both
> ranges re-derived from the tree after the edits; the pre-edit numbers are retained so anyone
> holding the earlier message can reconcile rather than conclude I cited a line that never existed.

---

## 6. The knowledge already existed and did not transfer

`test/db/w2-execution.pg.test.ts:321-324` **already** authenticates as the worker and asserts
`session_user` at `:395`. Its header comment at `:30-37` names this exact defect in these exact two
files:

> *"Every existing pg test reaches the three delivery RPCs by running as the SUPERUSER `tm8`, which
> may assume any role. That proves nothing about the production principal."*

**The defect was written down, in the repository, by the author of the correct pattern, and the two
suites it describes were never fixed.** That is §2 of the close document — non-transfer of knowledge
that already existed — and it is why the shared helper is a module rather than a third open-coding.

---

## 7. What changed

| file | status |
|---|---|
| `test/db/delivery-principal.ts` | **NEW.** Authenticating principal pool. Asserts its own premise in-band on every transaction. |
| `test/db/w1-foundations.test.ts` | 4 delivery sites converted; premise test added; two "satisfied-by" limits recorded inline. |
| `test/db/w2-messages-handoffs.pg.test.ts` | 1 helper (`asDelivery`) converted; premise test added. |
| `test/w5/sql/delivery-principal-guard.pg.test.ts` | **NEW.** Defect pin + acceptance criterion. |

**No conditional skip anywhere.** An unreachable delivery principal is a **red with a reason**, not
a skip — *a conditional skip that currently passes is invisible to every skip count anyone runs.*

The tightened guard in the detector is **derived from the live function text at runtime**, never
hard-coded, so it cannot drift from whatever the developer lands. If `015`'s condition ever changes
shape the derivation fails to match and the file **fails loudly** rather than silently testing a
function nobody has.

---

## 8. Both halves of every detector — mutation-proved

Mutants run on **copies**; the originals were hashed before and after and were byte-identical
(void-run rule).

| mutation | expected | observed |
|---|---|---|
| **M1** defect pin aimed at the tightened chain | pin goes red | **1 failed / 7 passed** — targeted, and the failure text carries the inversion instruction |
| **M2** `SHIPPED_CONDITION` made unmatchable | derivation refuses to run | **file failed, 8 skipped**, `cannot derive the tightened guard: ...` |
| **M3** derived guard computed but never applied | acceptance criterion goes red | **2 failed / 6 passed** |
| **M4** `PAST_THE_GUARD` widened to `/.*/` | discriminator collapse caught | **1 failed / 7 passed** |

---

## 9. Results, as run

```
RUN  v2.1.9 /Users/subhang/Desktop/Projects/tm8/packages/server
 ✓ test/db/w1-foundations.test.ts                    (16 tests) 2003ms
 ✓ test/db/w2-messages-handoffs.pg.test.ts            (6 tests) 1492ms
 ✓ test/w5/sql/delivery-principal-guard.pg.test.ts    (8 tests) 2925ms
 Test Files  3 passed (3)      Tests  30 passed (30)      EXIT=0

whole directory, for collateral:
RUN  v2.1.9 /Users/subhang/Desktop/Projects/tm8/packages/server
 Test Files  26 passed | 2 skipped (28)
      Tests  286 passed | 10 skipped (296)      EXIT=0
```

**TYPECHECK OF TEST FILES — a distinct named result.** `bun run typecheck` type-checks no test file
anywhere. Scratch config extending `tsconfig.base.json`, `typeRoots` pinned absolutely:

```
tsc -p tsconfig.w5a.json   ->  EXIT=0, zero diagnostics
```

**Probed, because exit 0 is indistinguishable from "never compiled":** one deliberate
`const x: number = "string"` injected into **each of the four** files produced **four** distinct
`TS2322` diagnostics at four distinct line numbers. Probes removed; hashes byte-identical to before
injection. All four files are genuinely compiled.

**Migrations applied by these fixtures**, built from `migrationFiles()` and never a hand-listed
slice: `w1-foundations` applies **001-015** (so its RPCs are `015`'s definitions, not `019`'s);
`w2-messages-handoffs` applies **001-019**; the new guard detector applies **all 34**.

---

## 9a. THE FIRST LANDING ATTEMPT FAILED MY DETECTOR, AND THE DEFECT WAS MINE

`039` was copied in, the gate ran, and it was reverted. My file was one of five failures — **and it
failed in the wrong way.** Reproduced locally by simulating `039`'s exact effect on a scratch chain,
rather than inferred from the gate output.

| | v1, post-`039` | v2, post-`039` |
|---|---|---|
| result | **file failed, 8 SKIPPED** | **1 failed, 7 passed** |
| the failure is | a `beforeAll` derivation throw | **the defect pin itself** |
| `"INVERT THIS…"` in output | **0 occurrences** | **2 occurrences** |
| acceptance criterion | **never ran** | **ran and PASSED** |
| `Called end on pool more than once` | 1 | **0** |

**The `beforeAll` derivation guard threw first and silenced the pin it was protecting.** The
instruction written for exactly that moment printed zero times, and — worse — the acceptance
criterion never ran, so at the one moment it mattered the file gave **no positive confirmation that
`039` worked**. The coordinator recorded it as "the loud-failure design working." It was not: it was
loud about the wrong thing, at the cost of everything it existed to say.

**The class is mine and it is this program's own.** I wrote the file for the world it was written in
and never asked what it would do **in the world it was creating** — §24.3 verbatim, produced inside
the archive that cites §24.3. The v1 mutation tests (§8) covered *does the pin flip* and *does the
derivation refuse a changed shape*; **none covered the one transition the file exists to survive.**

**The teardown artifact was mine too.** `w1-pg.ts:111` `pool.end()` reached twice — the `beforeAll`
catch-destroy **and** `afterAll`. It masked nothing (the real error printed in full alongside), but
it made an error nobody could attribute at a glance. Root cause: the catch-destroy was redundant,
because **vitest runs `afterAll` even when `beforeAll` throws** — proven by the reproduction, since
the double-end could only have come from `afterAll` running after the catch. `afterAll` is now the
sole teardown.

**v2 is a different design, not a patch.** It **classifies** the live guard and pins **both** worlds
— a `permissive` (two-limb) and a `tightened` (one-limb) database, one of which is the shipped chain
and the other derived from it in whichever direction is needed. Exactly one test asserts *which one
the shipped chain is*. The known-bad half therefore **survives the fix**: after `039` the permissive
database is reverse-derived, so the detector can still see the hole it was built for. *A detector
that loses its known-bad half at the moment of the fix cannot prove it would still catch a
regression.*

**Disposition (production-state pin, per the coordinator's rule):** on `039` landing the expected
value changes `'PERMISSIVE'` → `'TIGHTENED'`, before/after recorded, converting the file from
asserting the **defect** to asserting the **fix** and leaving a permanent guard against a silent
revert. The assertion message carries this in full, so the reader of the red needs no other document.

---

## 9b. LANDED — `039` is in, and both pins are disposed

**Chain measured by me after the landing: `37 files / fff3995e1c2a5dcd`**, empty-input control
`e3b0c44298fc1c14`, differs. Was `34 / a799b7ef1b20a9b0`. All three candidate hashes match handover.
Guard re-derived from a **freshly-migrated scratch database**, never from a migration file: the
two-limb condition appears **0 times**, and there is still exactly **1** definition.

**MEMBER 1 — inverted, and it is now a regression guard.**

| | before | after |
|---|---|---|
| expects | `'PERMISSIVE'` — asserted the **defect** | `'TIGHTENED'` — asserts the **fix** |
| chain | 34 / a799b7ef1b20a9b0 | 37 / fff3995e1c2a5dcd |
| gate observation | `expected 'TIGHTENED' to be 'PERMISSIVE'` — fired on cue | 8/8 green |

Mutation-proved in the new direction: simulating a **revert of `039`** turns it red — **1 failed / 7
passed**, targeted — with a diagnostic naming close-document §5.4 as reopened.

**My classifier survived a hazard neither of us predicted.** `039` carries an in-body comment
mentioning `current_setting('role')`, and `pg_get_functiondef` **returns comments** — so a substring
detector reads the removed code's signature as the code. The developer's own post-landing check
reported `039` as PERMISSIVE for exactly this reason. Mine matches the **full two-line condition**
including the `and coalesce(...)` continuation, which the comment does not contain; the reverse
round-trip hits the code at offset 532 before the comment at 351. **Verified, not assumed** — and it
is why the full-condition form must be kept if that classifier is ever edited.

**MEMBER 5 — both acts, because they are different acts.**

1. **Recorded EXPIRED**, naming `040`, citing the archived red
   (`w2-execution-pre-019-pair-shape-red.txt`, whose filename carries the constraint). Not re-pinned
   to pass: weakening an assertion until it goes green produces a green that describes nothing.
2. **A regression guard authored** — a Teammate wake at an exited target must write **exactly one**
   `failed_permanent`/`session_not_live` row **with its three `pair_*` columns populated**, and the
   pair must be the unordered `{source, target}` identity. The `pair_*` columns are asserted
   individually **because the status pair alone was already reachable for a Member-authored message
   before `040`** — that half was never broken, so a status-only assertion would be satisfied by it.

**KNOWN-BAD HALF THAT SURVIVES `040`**, which is what makes the guard worth anything: a
`team_member`-authored message with **no `authored_from` edge**. Measured on the landed chain via
`pg_get_functiondef` — that raise sits **above** the `target_status in ('exited','failed')` branch
`040` rewrote, so `040` cannot repair it. A real production guard producing a real refusal, not a
synthetic mutation.

Both halves proved by simulating a **revert of `040`**: the known-good half goes **red**, the
known-bad half **stays green** — 1 failed / 10 passed, targeted.

Post-landing: `test/db` + `test/w5/sql` = **295 passed, 10 skipped, EXIT=0**. Typecheck EXIT=0 via
the resolved in-repo `tsc` (bare `tsc` resolves into `agent-maestro`).

---

## 10. My false-positive rate

**Findings filed: 3. False findings filed: 0. Self-caught errors before filing: 2. Errors caught by
my second reader: 2.**

Caught by me, before acting:
1. Assumed `current_setting('is_superuser')` would discriminate. Measured; it does not. The premise
   died before anything rested on it.
2. Planned to add the helper to `test/db/w1-pg.ts` — which is imported by **27 files including
   `test/w3/public-harness.ts`**, and `test/w3/**` is frozen. Switched to a new module.

Caught by my second reader, not by me — **the more informative half**:
3. My evidence for "`w2-execution.pg.test.ts` is safe" was **insufficient**. I enumerated routes I
   could think of; the developer closed it **by construction** (one port construction, one
   `deliveryUrl` assignment, nine `boot()` call sites all passing it) and named the route that
   defeats a literal grep: `PgW2DeliveryRpcPort.withPrincipal` issues `set local role`
   *inside production code*, so a test could be a full assumed-role path **with no `set local role`
   literal in the test file at all**. **The claim was right and my reasoning for it was not.**
4. I enumerated **four** files touching the delivery surface. The set is **five** —
   `w1-migration-runner.test.ts` (names only, no call site, not a blocker). *An undercount is
   invisible until someone else counts.*

---

## 11. Instrument certifications

**`grep -a` really does defeat the wrapper's `-I`** — measured, not inherited from the corrected
standing order. The shell `grep` is a function execing `ugrep 7.5.0` with `-I` baked in.

```
known-bad file, known-present string ("spaceId" in presence.ts):
  wrapper grep -a   -> 8, rc=0        wrapper grep (no -a) -> silent, rc=1
  /usr/bin/grep -a  -> 8, rc=0        rg -a                -> 8, rc=0
negative control (absent string in a TEXT file): rc=1, empty  -- byte-identical to the -I silence
```

And over **my actual completeness sweep**, not merely one file: wrapper / `/usr/bin/grep` / `rg`
each returned **76 lines, byte-identical by `diff`**. `-a` is weaker in *diagnostics* — it never
says why — but it is **not weaker in coverage**. My banked completeness claim stands.

**NUL certification, safe spelling.** Re-run with `b.count(bytes([0]))` — no escape anywhere, so
no authoring path or JSON tool boundary can corrupt the counter — with byte length and sha256
printed beside every headline number:

```
0 NUL   8792B  sha256:5284eb8d3681  test/db/delivery-principal.ts                    (I authored)
0 NUL  14579B  sha256:f989f5a78947  test/w5/sql/delivery-principal-guard.pg.test.ts  (I authored)
0 NUL  61857B  sha256:a5102134f3a6  test/db/w1-foundations.test.ts                   (I edited)
0 NUL  33369B  sha256:d53e4c7615e8  test/db/w2-messages-handoffs.pg.test.ts          (I edited)
2 NUL   5909B  presence.ts   POSITIVE control, offsets 2566/2713 — reproduces the coordinator's figure
1 NUL          entity.ts     POSITIVE control, offset 21457 — reproduces Duo D's figure
0 NUL  10540B  http/server.ts   NEGATIVE control
```

Both control halves reproduce independently-established values, which is what proves the counter
matched **bytes and not literal characters**. All 49 files I read or quoted from: **zero NULs**.
`presence.ts` appears in my scans **only as a control** — I never read or quoted it. That is the
check, not the reassurance.

**I authored two source files through a JSON tool boundary** — the exact mechanism that produces
this hazard — and checked my own output rather than reasoning that my files contain no such
escape. `file(1)` reports all of them as UTF-8 text.

**Port 4610 / traffic.** I sent **no HTTP traffic of any kind**; this seat's work is `psql` and
DB-backed vitest only, over uniquely-named `tm8_w1_*` scratch databases, all of which I dropped.
A node **is** listening on 4610. Sampling `pg_stat_activity` on the 5442 cluster showed no backend
but my own — **and I am deliberately not drawing the tempting conclusion from that.** A single
sample cannot distinguish "the node is on another cluster" from "the node's pool was idle at that
instant"; an idle pool holds no backend. Probed the probe: with a known holder connection open the
same query returned it, so the empty reading was a genuine absence at that instant and nothing
wider. *A sound measurement described in language wider than the measurement* is the failure this
program is named after.

That sampling also observed **another seat's scratch database live** during my session
(`tm8_w1_w5_home_activity_...`). Recorded per standing order: if an anomaly appears, ask who else
was running before filing it.

**Type-level enforcement was never proposed here.** The premise assertion in
`delivery-principal.ts` is a **runtime refusal that throws**, not a required field — the pattern
the coordinator endorses. A row type cannot constrain `q.query<Row>(sql)`, and this fixture's
premise is a connection fact that no type could have expressed anyway.

---

**The `grep -a` retraction applies to me too.** My completeness sweep rested on an **absence**, and
`packages/server/src/events/presence.ts` is byte-classified `data` and sits inside a directory I
swept. **Re-run with `-a` before banking: results identical.** The coordinator's notice said Duo A
has no binary files in its surfaces; that is narrowly wrong, and it changed nothing here only
because it was re-run.
