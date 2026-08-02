# W5 — Coordinator Standing Orders and the Grant Ledger

**This file is the single source for the W5 coordinator's own rules and for the live grant
ledger. Packets REFERENCE it; they do not restate it** (§23.13 — a restatement can diverge, a
reference cannot). It is maintained by the W5 coordinator, `sess_1785144170297_fgwr6a0h7`.

**Governing division:** `W5-DUO-STRUCTURE.md`. Nothing here replaces it; this file adds the
ownership, grant and landing protocol the division needed and did not have.

---

## 0. Measured at W5 restart — and every one of these you must re-measure, not inherit

```
chain                34 files / a799b7ef1b20a9b0
                     (cd db/migrations && shasum -a 256 *.sql | shasum -a 256 | cut -c1-16)
                     THE cd IS LOAD-BEARING. Print the empty-input control beside it
                     (printf '' | shasum -a 256) and confirm they differ — a digest of nothing
                     looks exactly like a digest.
CLI suite            48 files / 1150 passed / 1 skipped / exit 0
server, excl. w3     65 passed + 6 skipped (71 files) / 705 passed + 64 skipped (769)
                     --exclude "test/w3/**". The close document's "65 files / 702 tests" matches
                     only if entirely-skipped files are omitted; the exclusion mechanism is now
                     stated because a measurement without its conditions is a rumour with a
                     number attached.
INPUT_SCHEMAS        54 keys · UNBOUND_COMMAND_OPERATIONS empty
                     ⇒ of 98 v1 non-WS operations, 44 are already handler-reached with no body
                       and 54 need a schema-valid body, 8 of which share
                       RequiredCommandContextSchema. The close document's "cheap 80%" is
                       WITHDRAWN: the free half is 45%.
skips                64, in exactly SIX files — poll.pg 11, facade/loop 22, contract-shapes 15,
                     loop-visibility.pg 6, db/claims 7, db/loopback 3. The seventh named file
                     (sidecar/lifecycle.live) runs 12 passed, ZERO skipped.
                     AND: a grep finds NINE files carrying a skip construct. Two never fire
                     (pty-ws, scheduler/jobs). A CONDITIONAL SKIP THAT CURRENTLY PASSES IS
                     INVISIBLE TO EVERY SKIP COUNT ANYONE HAS RUN. The grep is a name grep and
                     therefore a LOWER BOUND; the runner is authoritative on what skipped.
```

**Announced figures are triggers, not values.** If I announce a rotation, I am telling you to
measure, never telling you the number (§22.4).

---

## 1. The duo boundary — not negotiable, and it is the point

Per `W5-DUO-STRUCTURE.md` §1. Restated here only as the operative rule, because it is the
one thing a seat must never have to look up:

- **The developer never edits the tester's test files.** A red it believes wrong is **ARGUED,
  NOT EDITED.**
- **The tester never edits production source.** A fix it believes obvious is **DESCRIBED, NOT
  WRITTEN.**
- **Neither declares the other's verdict.**

Talk to each other **directly**. Come to me only for **decisive authority**.

---

## 2. OWNERSHIP — production source is granted, not owned

**Each duo owns its TEST paths outright.** Create them; they are yours.

**No duo owns production source by default.** A production file is granted to **ONE duo BY
NAME, per finding, exclusive until released**, by me. Ask; do not assume; do not edit a file
you have not been granted.

**Grants are TIME-BOXED and RELEASED WHEN THE FIX LANDS.** An indefinite grant is duo ownership
with extra steps. If you are holding a grant and are not actively landing it, hand it back.

This converts every collision into a **queue rather than a corruption**. The eight measured
collisions are in §6 below so you can see what is contended before you ask.

### 2.1 THE CLI KERNEL IS FROZEN AND LANDS IN BATCHED WINDOWS

```
packages/cli/src/  args.ts  context.ts  output.ts  errors.ts  mutation.ts  exit.ts
                   run.ts  index.ts  env.ts  manifest.ts  prompt.ts
```

This is **W4 group 1** — *"global grammar, auth/context, output, errors, mutation IDs"* — and
every command module in the package dispatches through it. W4's own constraint:
*"Slot A must freeze first because Slots B and C both depend on its exit/error/output/context
layer."*

**THE FREEZE IS NOT "NOBODY TOUCHES IT."** A kernel defect is fixed by **the finder's own
developer** under a named grant. D's developer can be granted `exit.ts`. Duo F then **gates a
kernel it did not write**, which is independence working rather than a problem.

**Kernel grants are BATCHED into one announced window**, exactly like migrations — collect,
land together, re-run the dependents, announce with an instruction to **re-measure**. A frozen
kernel with strictly one-at-a-time grants would make the kernel a second serialisation point
and D and E would both queue on `args.ts` within hours.

### 2.2 `registry.ts` is COORDINATOR-ONLY

W4's reason, verbatim, because it is better than a rule: it *"throws at **import** on a
duplicate — so a double registration is not a subtle test failure but a hard import-time
collapse of the whole suite for every slot at once."* All 98 commands are already wired. **No
duo should need this file at all.**

---

## 3. MIGRATIONS — I am the sole landing point

**Author OUTSIDE the repository.** `startW3PublicServer` applies *every* file matching the
migration pattern, so **a half-written migration in the tree is applied to every scratch
database in every duo's runs** (§15.5b). The directory is quiet **by construction**, not by
everyone's good behaviour.

**Hand me four things, not three:**

1. absolute path (outside the repo)
2. SHA-256 of the candidate
3. a **shared-object statement** — §15.5c's executable form: apply the full chain twice, with
   and without, and diff the entire `public` + `internal` catalog, permitting only the declared
   new signatures to differ. Then **mutation-test the proof itself.**
4. **a `db/migrate.mjs` STAGED-CHAIN APPLICATION RESULT.** ← *the one §4 of the structure
   document did not require, and the reason it must*

**Why (4).** `033`'s own suite passed **15/15 and structurally could not catch** its landing
failure: it applied via `database.query(sql)` on an already-privileged pool connection, while
the real chain applies via `psql` as `tm8_graph_owner` — so the test path **never reached the
runner's post-apply write to `applied_migrations`**. **VERIFYING THE ARTIFACT IS NOT VERIFYING
THE ARTIFACT'S DELIVERY. THE APPLIER IS A THIRD THING** (§22.1). Stage a copy of the runner +
chain + candidate in a scratch dir; `MIGRATIONS_DIR` resolves relative to the script.

### 3a. MIGRATION NUMBERS ARE ISSUED BY ME. Do not choose your own.

`db/migrate.mjs:131` **hard-fails on a duplicate number** — `duplicate migration number NNN`. Two
duos authoring `038` in separate scratch directories collide **invisibly until a landing window**,
which is the worst possible moment to discover it. **Raised by Duo A's developer before it could
happen**, which is the point of raising it.

Highest on the chain today: **`037`**. Reserved blocks:

| Block | Holder | Note |
|---|---|---|
| `038`–`041` | **Duo A — DEVELOPER** | 015 tightening · class-D / `entities.patch` doors · `019` Teammate branch · `041` = `record_execution_command` |
| `042` | **Duo D — DEVELOPER** | `set_pull_state`'s missing clear-parameter. **Its justification is not "fix a live data loss" — the loss is disproved — it is REMOVE A TRAP BEFORE SOMEONE SPRINGS IT (§3g).** |
| `043`+ | unissued | request from me; I record it here **before** you author |

⚠ **THIS TABLE CONTRADICTED ITSELF AND IT IS RECORDED RATHER THAN QUIETLY FIXED.** It read `042+ unissued`
while §3f's halt snapshot read `042 ISSUED, NOT AUTHORED`, **and neither entry named a holder.** An advisor
answering *"whose is 042?"* from the governing document got **a stale row, a contradicting snapshot, and no
name.**
> **THE LEDGER EXISTS TO PREVENT EXACTLY THAT CLASS, AND THE CLASS WAS LIVE INSIDE THE LEDGER.** A second
> record of the same fact is a second thing that can go stale — **§23.13's rule that a restatement can diverge
> and a reference cannot, arriving in my own document.** Found by Duo A's developer from the tree, verified
> independently by Advisor 1 from the tree, neither taking my word.
**RULE ADOPTED: a number is recorded HERE, with its HOLDER, and every other mention REFERENCES this table
rather than restating its state.**

**Number your candidates from your block and tell me which number you used.** If you need more than
your block, ask — do not extend it yourself.

**The landing window** (§22.3 as amended): announce → **wait for an EXPLICIT all-quiet from
every other duo, never a fixed delay** → copy in → run the full-chain gate **BEFORE announcing**
→ announce the result **with an instruction to re-measure**. **If the gate fails, revert inside
the same window.** Any suite failure observed during an announced window is **presumed
window-caused until re-run.**

> **Announcing a quiesce is not being quiesced. An announcement is evidence, not authority; the
> tree is the authority.**

---

## 3b. ⚠ TRAFFIC IS A SHARED MUTABLE SURFACE. My rules named EDITS and BUILDS and never named it.

**Self-reported by Duo D's developer, unprompted, with request ids attached**, after it ran CLI
probes during its tester's declared RUNNING window. Two requests reached a server on
**`127.0.0.1:4610`**; both were rejected before any write (`not_found`, `invalid_input`,
`req_ecda47_v` / `req_ecda47_w`). It reported them so its tester could void its own run. **No damage,
and the protocol gap is the useful part.**

> **THE SHARED MUTABLE SURFACE BETWEEN TWO SEATS IS NOT ONLY THE TREE. IT IS ALSO PORT 4610 AND THE
> DATABASE BEHIND IT.**

**AND I MEASURED THE HAZARD RATHER THAN ASSUMING IT WAS THEORETICAL:**

```
lsof -nP -iTCP:4610 -sTCP:LISTEN
node  47692  subhang  ... TCP 127.0.0.1:4610 (LISTEN)     ← A LIVE NODE IS UP RIGHT NOW
```

**4610 is `TM8_PORT`'s default.** Those probes did not hit a scratch server — **they hit a running
node, on whatever database it is attached to.** A rejected read costs nothing; **a mutation would
not have been rejected**, and `bootstrap()` calls `execution.reconcileGhosts()`, which **retires
`work_sessions` still at `'running'`** — so *booting* against a shared database can terminate another
seat's live session.

**RULES, effective now:**

1. **Drive your own scratch server on an ephemeral port.** Never point a probe at `4610` unless you
   put the node there yourself and know its database.
2. **A declared RUNNING window covers TRAFFIC, not only edits and builds.** If a seat announces a
   run you intend to report against, do not send requests at its server or its database.
3. **If you touch someone else's window, say so immediately with request ids**, as was done here, so
   the other seat can void its own run rather than discover an anomaly later.
4. **Pointing a URL at a database is read-only AS A QUERY and NOT read-only AS A BOOT.**

## 3c. THE GATE CRITERION IS AN EXACT SET, NOT A COUNT — and my first landing proved why

**First landing attempt failed and was reverted inside the window.** I announced *"expect exactly two
reds"* and the gate produced **five failing files**. Tree restored byte-identical to
`34 / a799b7ef1b20a9b0`.

> **"EXACTLY TWO REDS" IS SATISFIABLE BY THINGS OTHER THAN "NO REGRESSIONS."** I used a **count** as a
> proxy for a **property**, in the one action where I hold exclusive authority. Two of the five were
> legitimate detectors nobody predicted — **including one the candidate's own author predicted GREEN.**
> **A COUNT CANNOT DETECT A SUBSTITUTION** — the same blindness as the guard-flag table at 16 vs 16.

**THE CRITERION:** the failing set must be a **SUBSET of a PRE-ENUMERATED, OWNER-CONFIRMED EXACT SET**,
recorded **by verbatim test name**, and **per member: WHO confirmed it and WHETHER they confirmed it
WILL fail or MAY fail.** *"Owner-confirmed" without that distinction lets a MAY into a subset check
that then cannot distinguish a predicted failure from an unpredicted one sharing a name.*

**EVERY WINDOW ANNOUNCEMENT NAMES THE GATE'S EXACT SCOPE** — command, package root, excludes. My first
one did not, so no seat could know whether its path was inside it, and *"do not edit any file"* was
broader than the property it protected.

### 3d. A CAUSATION PIN IS A SCHEDULED FAILURE. ITS DISPOSITION IS WRITTEN WHEN THE PIN IS WRITTEN.

A red/repair/green/revert/red pin is **designed** to go red while its defect exists, so **its inversion
when the defect is fixed is not a surprise — it is the pin's last scheduled act**, predictable from the
moment it is authored. `w2-execution.pg.test.ts` **did not fail unexpectedly; it fired on cue, and
nobody had written down that it would.**

> **EVERY CAUSATION PIN SHIPS WITH A STATED DISPOSITION FOR THE MOMENT ITS DEFECT IS REPAIRED** —
> authored at the same time as the pin, by its author, naming what the pin becomes. Usually: convert
> from asserting the **defect** to asserting the **fix**, so the file keeps a regression guard instead
> of leaving a mystery red.

**Without it, every successful fix in this wave produces an unexplained red at a landing window.**

**THE TWO KINDS, and the distinction is the point:**
- **A pin against SYNTHETIC known-bad input** (§7d) cannot be repaired by a source change, keeps its
  red half permanently, and **needs no disposition.**
- **A pin against PRODUCTION state ALWAYS needs one.**

**And the retrospective half still applies to handovers:** *enumerate the tests that assert the DEFECT
you are repairing, not only the tests that exercise the FUNCTION you are changing.*

### ⚠ 3d.1 A DISPOSITION IS NOT ENOUGH — MUTATION-TEST THE PIN IN THE **POST-FIX** WORLD

**Duo A's tester found the missing half by applying the rule and watching it fail.** Its pin's mutation
tests covered *does the pin flip* and *does the derivation refuse a changed shape* — **and never
covered WHAT HAPPENS WHEN THE FIX LANDS, the single transition the file exists to survive.**

Result at the first landing: **the pin NEVER RAN.** Its `beforeAll` derivation guard threw first, all
8 tests **skipped**, the inversion instruction printed **zero times** — **and the acceptance criterion
never ran either, so at the one moment it mattered the file could not say whether the fix worked.**

> **A FILE THAT ANSWERS "I CANNOT TELL YOU" WHEN THE ANSWER IS AVAILABLE IS NOT A WORKING DETECTOR.**

**REQUIRED, for every production-state pin:**
1. **WORLD-DETECTING, NOT WORLD-ASSUMING.** Classify the live world first; pin **both** worlds.
2. **MEASURED IN BOTH WORLDS BEFORE THE LANDING** — the current tree *and* a simulated post-fix tree.
3. **THE KNOWN-BAD HALF REVERSE-DERIVED AFTER THE FIX**, so it survives the fix.
   **A DETECTOR THAT LOSES ITS KNOWN-BAD HALF AT THE MOMENT OF THE FIX CANNOT PROVE IT WOULD STILL
   CATCH A REGRESSION.**
4. **EXACTLY ONE named test asserts which world the shipped chain is in** — so the gate has a name to
   subset-match rather than a file-level abort.

### ⚠ 3d.3 A DISPOSITION IS **PROSE ABOUT A TEST**, AND PROSE HAS NOTHING THAT GOES RED

**Found by Duo E's tester, in its own authored disposition, by executing it.** The disposition
instructed a **manual step that did not exist** — test 5 in fact *inverts itself*: it asserts the
correct behaviour and was never softened. **Wrong for eight hours**, inside the artifact §3d exists
to produce, written by the seat that understood the file best.

> **Authoring a disposition early buys correctness of TIMING, not correctness of CONTENT.**

§3d says every pin ships with its disposition. That remains right — and it is **not** self-verifying.
A test has an assertion that fails when it drifts; **a disposition has nothing.** Nothing anywhere
reports that the instructions above a correct test have gone stale.

**AND THE FAILURE DIRECTION IS THE DANGEROUS ONE:** a disposition that invents a manual step
**invites the next reader to soften a correct witness, in good faith, believing they are following
the plan.** The prose does not merely fail to help — it actively recruits someone into damaging the
detector.

**REQUIRED:** **EXECUTE THE DISPOSITION BEFORE THE LANDING THAT WILL TRIGGER IT.** Walk its steps
against the live file. A disposition that has never been run is a hypothesis with an owner's name on
it. Correct **in-file, with the error recorded above the correction** — the record is what stops the
same reasoning recurring.

### ⚠ 3d.5 A CRITERION WHOSE SUBJECT THE FIX MOVES OUT OF REACH IS A **REGRESSION GUARD**, NOT EVIDENCE

**Found by Duo D DEVELOPER in Duo D TESTER's just-validated witness — the tester's own cell-1 defect
class, one cell over.** Post-042, **cell 5's subject is unreachable**, by two independent mechanisms
I verified myself:

1. **No branch of 042 writes a JSON null.** All four localId-writing arms either omit the key
   (`'{}'::jsonb`) or set a non-null text value, and every `else` arm sits under an `is null` guard.
2. **`018` types `pulled.localId` as `'string'`, not `['string','null']`** — contrast `working_on.note`
   one line above, which *is* nullable. A present-null is rejected by the validator → 400 → surfaces
   as **cell 1's** exit-code failure, not cell 5's.

**So cell 5 post-042 is a criterion the fix CANNOT FAIL.** It was a real criterion pre-042. The fix
moved its subject out of reach.

> **A CRITERION THAT CANNOT FAIL PRINTS THE SAME PASS AS ONE THAT WAS GENUINELY SATISFIED, AND
> NOTHING IN THE OUTPUT DISTINGUISHES THEM.** Trivial survival is byte-identical to meaningful
> survival.

**This is the exact complement of §3d.1.** There, a pin must be tested **in the world the fix
creates**, or it goes silent at the moment it matters. Here, a pin **survives the fix trivially** —
and that is *worse*, because §3d.1's failure is a suspicious silence while this one is a
**confident green**.

**REQUIRED:** when a fix moves a criterion's subject out of reach, **RELABEL IT IN THE FILE** —
*regression guard: cannot fail post-fix by construction; retained because it documents the design at
the only layer that can see it, and WOULD fire if a future rewrite reintroduced the shape.* **Never
delete it, and never let it stand as evidence the fix works.**

**AND THE HONEST DOWNGRADE THAT CAME WITH IT, made by its own authors before anyone banked it:** the
added cell-5 condition is **a SECOND READING** of the failure cell 1 already catches — key-presence
projection versus value — **NOT a second independent detector.** I ruled GO on the second-detector
premise and **that premise was withdrawn by the seats that proposed it.** The margin is real and
smaller than it was sold as. The genuine closure is the **absent-vs-cleared pair at the key level**.

**THE DUO BOUNDARY RAN BACKWARDS AND WORKED — second time in one wave.** The *developer* found a
defect in the *tester's* instrument, **described it rather than fixing it**, the tester **verified it
against the candidate rather than accepting it**, and the correction travelled **before execution**.
Neither seat crossed into the other's authority and the instrument got better anyway.

### ⚠ 3d.6 A CLOSING POSITION IS A DOCUMENT NOBODY VERSIONS — AND ITS **NOT-ESTABLISHED** SECTION IS THE WORST PLACE FOR A FALSE LINE

**Duo D DEVELOPER amended its own filed closing report after filing it.** That is the discipline
§3d.3 demands of dispositions, applied to **the document class nobody had thought to version.**

Every other artefact here gets re-measured: hashes at window open, dispositions executed before the
landing that triggers them, gate ledgers re-derived from the tree. **A closing report gets filed once
and becomes permanent** — read later by someone with no transcript, no author, and no way to tell
which lines were measured and which were inferred.

> **AND THE FALSE LINE SAT IN THE NOT-ESTABLISHED SECTION, WHICH IS THE SECTION A CAREFUL READER
> TRUSTS MOST** — because it is the one that reads as scrupulous. A wrong claim there inherits the
> credibility the section earned.

**THE ERROR CLASS, its own name for it: PREDICATE-BINDING INSIDE A SINGLE SENTENCE.** The source
comment reads *"`SetSpaceProfileDefaultInput` declares `confirmAgentGenerated`;
`SetTeammateProfileDefaultInput` does **NOT**"* — **one clause, two subjects, and it bound the `NOT`
to the first.** The locus was right and the binding was wrong. **The comment was never wrong; it was
read wrong.** I verified both sites myself: `schemas.ts:1521-1526` declares the field on the Space
variant; the Teammate variant has zero occurrences.

**Its third instance of a shape it had itself named** (*two accounts naming the same locus are not
corroborating until they agree on what happens there*), after `refuseMutationId` and the
drop-database mechanism.

**AND THE CORRECTION STRENGTHENED THE FILED CLAIM RATHER THAN WEAKENING IT** — the alternative
reading is now *eliminated*: field exists, flag works, frozen syntax silent, so the command is
unambiguously Ruling 2(a), **and the growing-ledger result is confirmed rather than assumed**, since
it depended on the capability being real.

**REQUIRED:** a closing position ships **strike-and-replace amendments by exact line**, verified at
the source rather than adopted from the seat that corrected you, and **the amendment travels WITH
the document** — a correction that lives only in the covering message is the reference-is-a-promise
failure one more time.

### ⚠ 3d.4 STILL OPEN AT CLOSE — THE INSTRUMENT DEFECT THE A20 WORK EXPOSED IS **NOT** FIXED

**Do not let the discharge of the finding be read as the discharge of the instrument.**
`kernel-global-collision.test.ts:391-440` **still measures allowlist membership** rather than the
property it is named for, and **still read `22 passed` on both sides of the defect it names.**

**The defect that file EXPOSED is fixed. The defect that file IS remains live.** It carries forward
to the rollout as an open item, not a closed one.

Its owner's bookkeeping **replaced the known-bad block with a RECORD, not an erasure** — stating
plainly that the synthetic half is now the only thing keeping the detector honest. **That is §3d.1's
known-bad-half rule surviving contact with a real fix**, which is the first time in W5 it has been
tested rather than asserted.

### ⚠ 3d.2 A FILE-LEVEL ABORT IS AN AUTOMATIC GATE FAILURE

A `beforeAll` throw yields **no test names at all**, so a subset-of-named-tests criterion **has nothing
to match against**. It is **never** covered by the expected set, regardless of the set's contents. *Part
of why the first criterion could not do its job.*

## 3e. KNOWN ENVIRONMENT FACTS — measured, ruled, and CLOSED. Do not re-escalate.

**PID 60018 — orphaned vitest. RULED: IT STAYS. THE QUESTION IS CLOSED.**

```
PPID 1 (orphaned) · started Sun Jul 26 18:50 · ~22h37m elapsed · ~897 CPU-minutes accumulated
cwd packages/server · ZERO postgres connections · ZERO TCP sockets · ONE file descriptor (its cwd)
CPU NOW: ~7.4%, near-idle — NOT the ~99% it showed twelve hours ago
```

**It cannot corrupt a scratch database, hold a DROP open, or see a landing.** It predates the W5
restart, was not created by this program, and killing it is irreversible — *"is it safe"* and *"is it
lossy"* are different questions and only the first is easy.

⚠ **DO NOT ATTRIBUTE CURRENT LOAD TO IT.** Load was measured **48.29 / 21.66 / 14.36 and RISING —
that is EIGHT SEATS, not this process.** Attributing it would repeat the disk-slope misattribution
exactly: *a real observation handed a causal role nobody measured.*

**If it starts pegging a core AND actually blocks a seat, that is a NEW fact and a new escalation.**

**⚠ SUSTAINED SLOWDOWN IS REAL AND IT NARROWS THE THIRD CATEGORY USEFULLY.** Duo B's tester measured
its suite at **11.73s pre-window and 66.38s after — ~6× — on an identical tree, identical fixture,
identical assertions.** And the control that matters: **results were BIT-IDENTICAL across that swing —
same failures, same names, same compared values.**

> **ASSERTION-SHAPED CHECKS ARE IMMUNE TO THE STARVATION CONFOUND. THE THIRD CATEGORY BITES ONLY ON
> TIMEOUTS.**

**CONSEQUENCE: ANY 180s HOOK TIMEOUT IN THIS REPO IS NOW ~3× CLOSER THAN ITS AUTHOR MEASURED IT.** A
seat with a heavy fixture may start timing out on a tree where nothing changed, **and that failure
would look exactly like a landing regression.**

## 3f. ⏸ HALTED ON USER DIRECTION — STATE AT STOP, so resume is a continuation

```
chain      37 / fff3995e1c2a5dcd   (five seats measured independently; control e3b0c44298fc1c14, differs)
landed     038 · 039 · 040 — gated on an exact subset match, 5 named members, all BY ASSERTION
041        READY, four artefacts, sha 36a13e0e2549dafe — NOT LANDED, outside the repo
042        ISSUED, NOT AUTHORED
grants     SUSPENDED, NOT REVOKED — Duo B dev: handlers/activity.ts + handlers/spaces.ts:291,
           plus edges-placements.ts:43-49 and identity-spaces.ts:104-114 · Duo D dev:
           entities-commands-tracking.ts:1263
db/migrations   CLEAN — no half-written candidate in the tree
```

**Instruction given: stop, land nothing, edit nothing, DROP NOTHING.** *Teardown is activity too, and an
orphaned scratch database costs far less than an action taken during a stop.*

### ⚠ 3f.1 THE VACUOUS-GUARD HAZARD IS CHAIN-WIDE, AND IT IS NOW PROVEN BY MUTATION

Predicted by Duo C's developer; **driven by Duo A's developer, with the mutation targeting THE CALL rather
than the comment** — because a guard mutation-tested by deleting the comment goes red and looks correct.

```
MUTATION on update_channel:  replay := internal.ledger_replay(…)   →   replay := null;
                             THE CALL IS GONE. THE COMMENT REMAINS.
naive substring guard on pg_get_functiondef   →  PASSES — reports the door intact
same guard with `--` comments stripped        →  FAILS  — correctly detects it
```

> **A SUBSTRING GUARD IS SATISFIED BY THE COMMENT ALONE AND WOULD REPORT A REMOVED DOOR AS PRESENT, FOREVER,
> ON ALL ELEVEN.** 039's instance reported a *fixed* defect as broken — alarming, self-correcting, caught in an
> hour. **THIS ONE REPORTS A HOLE AS CLOSED, AND NOTHING WOULD EVER CONTRADICT IT.**

**AND IT IS NOT 038-LOCAL.** The comment is copied from `032`'s worked example via `036`, so **the same string
now sits in the body of every resource-bound door in the chain.** Any future *"are the bindings still there"*
guard over `031/032/036/038/041` inherits it. **`041` deliberately does not add to it** — its body says what the
guard DOES and never quotes the unbound form, with the narrative in the file header where `pg_get_functiondef`
cannot reach.

### ⚠ 3f.2 038 IS VERIFIED AT THE SQL LAYER, NOT AT THE HTTP BOUNDARY — AND THE GAP IS UNOWNED

Seeded fixture, two spaces, one identity, **real rows of supported kinds** so `kindFor` is reached and returns.
Same-door cross-space, **cross-door** (recorded via `update_channel`, replayed via `update_document`), and the
odd `p_task_id` door: **CONFUSED → REFUSED**, with the positive control **passing in both worlds.** Re-run on
the landed chain.

> **MEASURED AS `tm8_app` AT THE SQL LAYER. NOT MEASURED AT THE PUBLIC HTTP BOUNDARY.** The enumeration
> document draws exactly this distinction and **only one defect in the whole program has ever held the stronger
> status. This is not one of them.** Duo C's sweep cannot close it — it is blind to 038 by construction (§3f.3).
> **The gap is real, it is unowned, and it needs a seeded fixture behind a real Server — a tester's instrument.**

### 3f.3 Carried over the pause — items routed but not closed

- **`018:33` / `018:37` ordering constraint** — §3g below. The single most consequential thing to survive.
- ~~**`props_schema is null ⇒ no validation`**~~ — **DISPROVED before the stop, from the LIVE table:
  24 edge types, 24 WITH a props_schema, 0 without. THE UNPROTECTED CLASS IS EMPTY.**
- **THE SILENT-DESTROY CLASS IS CLOSED ON THE LIVE CHAIN** — measured over **213 live function bodies**,
  case-insensitively, whitespace-tolerantly, with the pattern's positive control exercised first.
  **Exactly THREE fields admit null:** `working_on.note`, `approval_requested_from.note`, `approved_by.note`.
  Of those, only `working_on.note` has a wholesale writer — `set_work_state`, whose merge guard is live since
  037 plus the seventh argument. **`approved_by` has NO function referencing it at all.**
  > **`working_on.note` WAS THE ONLY INSTANCE THAT EVER EXISTED, AND IT IS FIXED.**
  ⚠ **ITS STATED LIMIT, AND IT IS THE REASSURING DIRECTION:** writers are detected by the edge-type name
  appearing as a **string literal**. **A function computing the edge type from a variable is invisible to it —
  exactly as `record_execution_command` was invisible to the enumeration because its label was a parameter.**
  **So this is an UPPER BOUND ON SAFETY.** The supported sentence is *"no function that names these edge types
  literally overwrites them wholesale"*, **not** *"nothing can."*
- **`write_edge` = CANNOT-TELL** — three server-owned keys beyond `origin` unexamined; needs a reader who knows
  edge-props ownership.
- **`messages.delivery.get`'s populated-page branch** remains ungated, and post-039 seeding delivery rows now
  requires `session_user = tm8_delivery_worker`. *File-level hypothesis, not a catalog fact.*
- **The "eight passing verdicts" our packet records as prose is one boolean in the code** —
  `bodyIsFullyValid`, 8 asserted / 2 measured-but-not-asserted in `g12-g14-strict-input-unguarded.test.ts`.

## 3g. ⚠⚠ THE ORDERING CONSTRAINT — the one thing that must survive any pause

> **`set_pull_state`'s WHOLESALE OVERWRITE MUST BE REPAIRED *BEFORE OR WITH* ANY RELAXATION OF `018:33`
> (`pulled.localId`) OR `018:37` (`tracks.localId`). NEVER AFTER.**

### ✅ STATUS 2026-07-28 — **HALF DISCHARGED. READ BOTH HALVES BEFORE ACTING.**

| half | state |
|---|---|
| **`set_pull_state` overwrite** | ✅ **REPAIRED AND LANDED** — `042`, chain 39 / `0dff33602fcc6b7c`, verified on the wire by cell 3 (accepted, key REMOVED) |
| **`edges.patch` / `write_edge` overwrite** | ❌ **STILL OPEN.** Ruled a defect on the `037` precedent; drive-before-SQL; not started |

**SO THE RELAX DIRECTION IS DISCHARGED FOR `set_pull_state` AND THE MIRROR IS NOT.**

- `018:33` / `018:37` may now be revisited **as they concern `set_pull_state`** — its overwrite is
  gone, which was the whole precondition. **`042` needed no schema change at all**: a cleared
  `localId` is represented by **the key being ABSENT**, never a JSON null, so the strict `'string'`
  type was never in its way.
- **THE MIRROR STILL BINDS, UNCHANGED: NEVER TIGHTEN EDGE-PROPS VALIDATION WHILE `edges.patch`
  REPLACES WHOLESALE.** Adding a `required` array to any edge type while that stands makes **every
  partial patch of that type raise** — silent data loss converted to a hard outage, for every
  existing caller.
- **`018:37` (`tracks.localId`) IS STILL PROTECTED BY THE MIRROR**, because `tracks` is written
  through `write_edge`, which is the unrepaired path. **Do not read the `set_pull_state` discharge as
  covering it.**

> **A RULE THAT IS HALF-DISCHARGED IS THE MOST DANGEROUS STATE IT CAN BE IN: the half everyone
> remembers is done, and the half that still binds looks like the same finished item.**

**The refusal and the data loss are the same mechanism seen from two sides, and the strictness is the only
thing currently protecting the data.** `018:31` shows `note` as `['string','null']` two lines above — so the
most reviewable one-word diff available would match the contract, match the neighbour, and **recreate the
`note` wipe.**

### ⚠ 3g.1 SHARPENED — MY WORDING HAD TWO HOLES. Both found by Duo A's developer, both verified by me.

**HOLE 1 — I named the wrong discharge condition.** 3g is discharged by **REPAIRING THE WHOLESALE
OVERWRITE** — absent-means-merge at `props`, the `037` seventh-argument shape — **NOT by adding a clear
parameter.** A candidate could add `p_clear_local_id` and **still rebuild `props` wholesale**, satisfying my
sentence while leaving the trap fully armed.

**HOLE 2 — AND THIS IS THE ONE MY RULE COULD NOT SEE AT ALL. VERIFIED: NEITHER `pulled` NOR `tracks` CARRIES
A `required` ARRAY, SO AN *ABSENT* KEY IS VALID.**

> **A FIX THAT SIMPLY STOPS EMITTING `localId` WHEN NULL CONVERTS THE LOUD 400 INTO SILENT LOSS *WITHOUT
> TOUCHING `018` AT ALL*.** My rule guarded one door and the second door does not go through `018`.

**3g NOW READS:** the wholesale overwrite is repaired **before or with** any change that lets an explicit
null, **or an omitted key**, reach `props` for these fields — **whether that change lives in `018`, in the
RPC, or in the service.** *Advisor 2's stated `042` semantics — absent preserves, explicit clear removes the
key, value replaces — meets the sharpened test on its face, and the props-direct gate cell is exactly the
check that sees key-absence.*

## 4. FORBIDDEN TO EVERYONE

- `packages/contract/src/**` — report for arbitration, **never edit**
- `packages/server/test/w2/**` and `test/w3/**` — historical evidence, **frozen**
- another duo's owned paths
- **`git`, in any form, by anyone, including me**

---

## 3h. ⚠⚠ THE CANDIDATES WERE DESTROYED. THE HASHES SURVIVED IN A PEER PROGRAM'S LEDGER, NOT MINE.

**MEASURED 2026-07-28, after the user hard-stopped all fourteen seats.**

| artifact | SHA-256 (short) | status |
|---|---|---|
| `041` — `record_execution_command` (Duo A DEVELOPER) | **`36a13e0e2549dafe`** | **FILE DESTROYED** — not on disk anywhere |
| `042` — `set_pull_state` clear-parameter (Duo D DEVELOPER) | **`9ae42a498a47d315`** | **FILE DESTROYED** — not on disk anywhere |

**MECHANISM, supplied by the tm8-ui master:** the `/tmp` claude session scratchpads were **WIPED at
~11:13 during the rate-limit stall.** Its own Track S measured the loss from the other side — standing
state, playbook and GO-EDIT drafts all destroyed. §3 stages candidates **outside the repository by
design**; that design put them on the mount that got wiped.

**MY MEASUREMENT, taken independently and before the warning arrived:** `db/migrations` ends at
**040**; no `041*`/`042*` file exists anywhere in home at depth 8; no `.sql` outside the repo was
modified in 24h; zero `.sql` under the scratchpad root against a control showing only 5 files survive
there across 34 session directories. Positive controls throughout — 67 `.sql` findable in home, 37 in
`db/migrations`. **Two independent derivations: mine established the absence, theirs established the
cause and the timestamp.**

> **A WIPED FILE LOOKS IDENTICAL TO A REGISTRY THAT STORES ONLY PATHS — AND MINE STORED NEITHER
> PATHS NOR HASHES.**

**MY FAILURE, and it is the most expensive one of W5.** §3 demands **four artefacts** with every
candidate — path, hash, mutation-tested full-catalog diff, real-applier result. **I issued the
migration numbers and logged none of them.** I hardened the gate criterion for hours over a payload
I could not locate. It is also **§4a unapplied**: an item in transit is owned by me until named
back — I applied that to orders and work items all day and **never once to the artifacts themselves.**

**WHAT THE SURVIVING HASHES BUY, precisely:** a re-authored candidate that hashes to the same value
is **byte-identical to what was previously staged**, so any artefact produced against those bytes
transfers with them. **WHAT THEY DO NOT BUY:** proof that those artefacts were ever produced or ever
passed. I never recorded that either. **Re-derive artefacts 3 and 4 regardless of hash match.**

## ✅ 3h.1 RECOVERED FROM TRANSCRIPTS AND PROVEN BY HASH — 2026-07-28

**Both candidates are back, byte-identical, and I did not have to resume either author.**

| artifact | bytes | SHA-256 | proof |
|---|---|---|---|
| `041_candidate.sql` | 6427 | `36a13e0e2549dafe20d2d85c60b686c4a422413dec9f54211cae5d8dc3136696` | matches §3f ledger |
| `042_candidate.sql` | 12061 | `9ae42a498a47d315de638b2a2ae5997768eba0084593eb7f26690d133e4af93a` | matches Advisor 2's relayed hash |

**STAGED DURABLY AT `~/Desktop/w5-migration-staging/`** — out-of-tree *and* on a durable mount.

**METHOD:** session transcripts live under `~/.claude`, **not `/tmp`**, so they survived the reboot.
Parsed all **104** transcripts, extracted every `Write`/`Edit` payload, hashed each, and matched
against the two recorded digests. Origin paths confirm both: Duo A DEVELOPER's
`w5a/candidates/041_…sql` and Duo D DEVELOPER's `042-candidate/set_pull_state_absent_means_merge.sql`.

**VERIFIED TWO WAYS, with a control:** in-process `hashlib` on the extracted string, then an
independent `shasum -a 256` of the bytes *after* writing to disk. Empty-input control
(`e3b0c442…`) differs from both. **A round-trip that only checks itself is not a check.**

> **THE RECORDED HASH IS WHAT MADE RECOVERY PROVABLE RATHER THAN PLAUSIBLE.** Without a digest,
> reconstructed-from-transcript text is *new bytes that look right* and every artefact must be
> re-derived. With one, the bytes are **the same bytes that were double-measured and applied through
> the real `db/migrate.mjs`.** The hash I failed to record is the thing that saved the recovery —
> and it survived only because a **peer program** and an **advisor** each kept it.

**ALSO RECOVERED, AND EXPLICITLY WEAKER — SAY SO WHEREVER THEY ARE USED:**
`pull-042-witness.mjs` (8902 B, `cfff4c0a…`) and `pull-witness.mjs` (12715 B, `58691a26…`).
**NO REFERENCE HASH EXISTS FOR EITHER.** They are recovered, not verified — the newest write in the
transcript, which is not the same claim. Duo D's tester must confirm them before cell-3 is trusted.

**A STALE COPY CAUGHT AND DESTROYED:** the same sweep recovered `note-merge-witness.test.ts`
(`62d1258d…`) — but that file **lives in the tree** and the live copy hashes `9b7897567bacca14…`,
**exactly Duo D tester's pre-stop record.** The transcript held an older intermediate. Staging it
would have created **a copy with no owner** competing with a verified live file. **When a recovered
artifact has a live counterpart, the tree is the fact — diff, then delete the copy.**

**WHAT SURVIVED THE REBOOT (measured, not assumed):** the repo; `packages/cli/dist` as rebuilt
pre-stop; the Postgres data dir `~/.tm8-dev/pg` **with the scratch databases intact**; all
transcripts. **WHAT DIED:** everything staged under `/tmp`, every process, the 4610 node, the §3e
orphan vitest, lane C's cluster. **The process-inventory question is answered by construction.**

---

**DISCIPLINE CHANGE, adopted from the tm8-ui master and binding here:**

> **DURABLE IS A PROPERTY OF THE MOUNT, NOT OF THE INTENTION.**

- **Out-of-tree staging must be out-of-tree AND durable.** `/tmp` is neither. §3's staging rule
  protects the test harness from half-written files; it never said "put them somewhere volatile."
- **The landing point records path AND hash the moment a number is issued** — before the author
  writes a line, not when the candidate is delivered.
- **Every other out-of-tree W5 artifact is suspect until verified**: gate baselines, expected-failure
  sets, capture references. Verify and relocate to a durable mount.

---

## 3j. ⚡ RESTARTING THE 5442 SIDECAR — the working command, and two traps

**Measured 2026-07-28 by Duo F DEVELOPER after the 11:04:12 reboot.**

**THE PRE-STOP PROCESS LINE (`postgres -D ~/.tm8-dev/pg -p 5442`) WILL NOT START IT.** PG18 refuses
to run when macOS's unset-locale environment (`LC_CTYPE=UTF-8` — a valid *charset*, not a valid
locale **NAME**) makes the postmaster multithreaded. **A property of the ENVIRONMENT, not the data
directory** — so it will recur on every fresh shell, and reading the process line from `ps` gives you
a command that cannot work.

```
cd ~ && LC_ALL=en_US.UTF-8 LANG=en_US.UTF-8 pg_ctl -D /Users/subhang/.tm8-dev/pg \
  -o "-p 5442" -l /Users/subhang/.tm8-dev/pg-restart.log start
```

Crash recovery ran and completed (redo `9/55480D00`→`9/55480DD0`, checkpoint complete, *ready to
accept connections*). **The `invalid record length` line is the normal end-of-WAL marker, not an
error.** Proof of life: `lsof` shows postgres LISTEN on 5442.

### ⚠ TRAP 1 — `pg_isready` IS NOT AN AUTHENTICATION CHECK, AND IT LOOKS EXACTLY LIKE ONE

The log line immediately after *ready to accept connections* was
**`FATAL: role "subhang" does not exist`** — that is **`pg_isready`'s own probe failing auth, while
it printed accepting-connections and exited 0.**

> **It measures the postmaster's willingness to answer, not anyone's ability to log in.**

Another member of the **confident-success-computed-over-something-other-than-the-question** family,
alongside my `psql` sweep that counted authentication-failure text as databases. **VERIFY THE SIDECAR
WITH A REAL QUERY AS ROLE `tm8`, NEVER WITH `pg_isready` ALONE.** F rested nothing on it — every
count ran as `tm8` with its own `psql` exit code.

### ⚠ TRAP 2 — THE RESTARTED POSTMASTER CARRIES A LOCALE THE OLD ONE DID NOT

**Disclosed unprompted by its author**, and it is a real difference between the world that was
measured and the world about to be gated: the running postmaster now carries `LC_ALL=en_US.UTF-8`
where the pre-stop one evidently did not.

**Existing databases are unaffected — per-database collation lives in `pg_database`.** But **a
NEWLY CREATED scratch database inherits from its template**, and every `.pg` suite in the gate
creates one. **If the template's effective collation now differs, text `ORDER BY` can differ** — and
the gate contains cursor, pagination and sort-key surfaces (Duo B's whole charter; `sortKeyOf`).

> **A COLLATION SHIFT PRODUCES A GATE RED THAT LOOKS LIKE A PAGINATION REGRESSION AND IS NOT ONE.**

### ✅ DISCHARGED — measured, with a probe that was itself proven able to detect the hazard

**MECHANISM (why it was never going to bite, now known rather than hoped):** `CREATE DATABASE` takes
its locale from the **TEMPLATE'S STORED VALUES**, not from the postmaster's environment. `template1`
still carries `en_US.UTF-8` from `initdb`, so **the `LC_ALL` variable never reaches a new database.**

Four databases — `postgres`, `template1`, the surviving pre-stop scratch DB, and a **fresh canary
created with no locale clause** (inheriting exactly as every `.pg` suite's scratch DB does) — all
identical: `en_US.UTF-8 | en_US.UTF-8 | c | null`.

**TWO THINGS ITS AUTHOR ADDED BEYOND THE ORDER, and they are why the result is clean rather than
narrow:**

1. **It read `datlocprovider` and `datlocale`, which I did not ask for.** In PG18 ordering depends on
   the **locale provider** too — a builtin/ICU/libc difference can change `ORDER BY` with
   **character-identical `datcollate` strings.** All four are `libc`/null, so the gap is **closed
   rather than unexamined.** *I ordered two columns and two columns would not have been enough.*
2. **A BEHAVIOURAL PROBE, because the hazard is `ORDER BY` and not a catalog column.** The same
   six-string sort inside all four databases returned `A,Á,B,_z,a,b` — **with a discrimination
   control**: the same expression forced `collate "C"` returns a *different* order. **The probe is
   proven able to detect a collation difference and found none.** Its own words: *four identical
   sorts from an untested instrument would have been a silence dressed as agreement.*

**HYGIENE:** canary count printed at **26** — deliberately, **proving the count SEES the canary**, so
the closing **25** is a real return and not blindness in both directions — then dropped, full 34-name
diff vs baseline identical.

**LIMITS, carried verbatim:** one sort over six strings (an ICU-specific or locale-version rule those
strings do not exercise would be invisible); **index validity unexamined** (`datcollversion` /
`pg_depend` not queried); names-and-collation only, still no row checksums.

**MY RULING ON THE INDEX QUESTION — OUT OF SCOPE FOR THIS GATE, and here is the exact condition
rather than a bare no.** An index collation-version mismatch needs a database that (a) predates the
change, (b) holds indexes built under the older collation version, **and** (c) is read by the gate.
**Every database the gate reads is created inside the gate**, so its indexes are built under the
collation now in force. The one surviving orphan is driven by no suite. **If any future gate reads a
persistent database, this becomes in-scope immediately** — it is deferred by the shape of this gate,
not dismissed.

### THE INVENTORY DIFF — clean, and *proven* clean

Positive controls first (`template%`=2, `postgres`=1, total=38, all exit 0), a negative control
proving a reachable real zero (`zzz_no_such%`=0), then: tm8-scratch 25→25, `w5a_%` 9→9, total 38→38,
**by-name diff 34 rows→34 rows, ZERO new, ZERO gone.** **And a diff-instrument control** — a
synthetic name injected into a *copy* of the listing was caught by the same `comm`. **Identical is
exactly what a broken comparison also prints; the control is what makes the clean diff a
measurement rather than a silence.**

**LIMIT, stated by its author: NAMES ONLY. A NAME SURVIVING IS NOT A ROW SURVIVING.** No table
contents were checksummed. If the gate depends on any database's *content*, that is a separate
unmade measurement.

---

## 3i. 🔒 THE PINNED GATE LEDGER — MEASURED BY ME, AT THE TREE, 2026-07-28 POST-REBOOT

**I did not hold these. My advisor did.** That is the §3h failure repeating one artifact-class over,
and the fix is the same: **the landing point holds the fingerprints, or the landing point cannot
detect a substitution.** Every value below was re-measured by me from the working tree — **relayed,
then verified, never relayed-and-trusted.**

| file / artifact | SHA-256 (short) |
|---|---|
| `packages/cli/test/w5/e/presence-write-path.pg.test.ts` | **`bea2d34aaf24e5d9`** |
| `packages/cli/test/w5/e/a20-confirm-agent-generated.pg.test.ts` | `99e29453f71386a2` |
| `packages/cli/test/w5/e/boolean-fields-reach-the-wire.pg.test.ts` | `b969b3a0cbe09446` |
| `packages/cli/test/w5/d/note-merge-witness.test.ts` | `9b7897567bacca14` |
| **migration chain** (`db/migrations`, 37 files) | **`fff3995e1c2a5dcd`** → becomes **39 files** after 041+042 |
| staged `041_candidate.sql` | `36a13e0e2549dafe` |
| staged `042_candidate.sql` | `9ae42a498a47d315` |
| *control* — digest of empty input | `e3b0c44298fc1c14` (differs from all; **print it beside every digest**) |

**⚠ `937b1a312ddd7129` IS STALE FOR THE PRESENCE FILE. DO NOT USE IT.** Its owner published that
value, then made a citation-fix edit (`main.ts:94`→`:148`, plus the `:206` structural premise) and
**never republished.** It reported the drift **unsolicited** — and re-verified **by CONTENT** (all
three witness assertions present at cited lines, test count still 6) rather than by assuming its own
edit was the only change since. **Recomputing a hash while assuming you know why it moved is one
derivation wearing the costume of two.**

**mtime `00:29` PREDATES the `11:04:12` reboot**, so nothing touched it during the outage — and the
chain re-measures **unmoved** at `37 / fff3995e1c2a5dcd`. A stale pin would have produced a gate
mismatch **indistinguishable from tampering**.

**RULE:** the gate ledger is re-measured **at window open**, by me, from the tree. A hash that
arrives in a message is a **claim**; a hash I compute is a **record**.

---

## 3k. 🎯 THE 042 DETECTOR MAP — I HAD THE PAIRING CROSSED, AND THE CROSS WAS LOAD-BEARING

**Corrected by Duo D DEVELOPER against 042's own merge branches. Independently re-derived by me by
executing the three-way merge over all four cells.** My re-derivation and its report agree exactly.

| failure | what it does | detected by |
|---|---|---|
| **A — `==` instead of `===`** | absent sets `p_clear` TRUE; an ordinary re-pin **removes a stored key** | **CELL 1 ONLY** |
| **B — boolean transposed before the mutation id** | LOUD with a cmid (text→boolean cast error); **QUIET with a null cmid** | **CELL 3** (accepted-and-no-op) |
| **C — misspelled property** | `input.localid` does not exist on `PullInput` | **the compiler, and only that** |

**MY RE-DERIVATION, printed because the blindness is the point:**

```
case                          === (correct)   == (disaster)   detects?
cell 1  absent + STORED       MY-CHECKOUT     None            RED — DETECTOR
cell 2  absent + nothing      None            None            passes both — BLIND
cell 3  explicit null         None            None            passes both — BLIND
cell 4  value                 NEW             NEW             passes both — BLIND
```

**CELL 3 PASSES UNDER THE DISASTER — CORRECTLY, BY ACCIDENT.** Explicit null *should* clear, and `==`
also clears it. **Three of four cells are blind to the worst failure in the change.**

> **THE STAKE IS NOT THE ATTRIBUTION — IT IS WHAT A FUTURE READER WOULD DELETE.** If anyone trims the
> witness believing cell 3 guards the strict-equality character, **THE GUARD FOR THE WORST FAILURE
> WOULD BE REMOVED WHILE THE RECORD STILL CLAIMED IT WAS COVERED.** Coverage was complete; the *map*
> was wrong; and a wrong map is what gets acted on later, by someone with no transcript.

**⚠ CORRECTED — I OVER-CLAIMED THIS AND ITS OWN AUTHOR NARROWED IT.** I wrote that cell 1 "is the
same cell its tester repaired after finding it satisfiable by the pre-fix state," and drew the
conclusion that without that repair the sole detector would have been **vacuous**. **That is too
flattering and it is wrong.** D tester established that **v1 of cell 1 would ALSO have caught the
`==` destroy** — under `==` the stored value genuinely *changes*, and v1 compared values. **The
exit-code repair is load-bearing for the REFUSAL world, not this one.**

**So cell 1 is a single point of detection but NOT a lucky one.** The true statement is the smaller
one: *a silent-destroy guarded by exactly one cell is a thin margin* — which is an argument for
adding a second detector, not a story about a near-miss.

**I amplified a seat's finding into a better story than the evidence supported, relayed it as "the
best thing anyone has said today," and its author corrected the flattering version before it
travelled.** That is my measurement-into-claim failure (`03` §7) for the second time in this wave —
and the correction came from the seat the story flattered.

**SECOND DETECTOR ADDED (see below): cell 5.** In the `==` world cell 5 currently prints **PASS** —
*"the write ran and left NO null key"* — **literally true and catastrophically misleading**, because
there is no null key precisely *because the value was destroyed outright*. **A blind cell says
nothing; a PASS says verified.** New condition: **stored-before AND key-absent-after = FAIL
silent-destroy.**

**CORRECTED GATE READING, use these words:**
- **cell 1 RED post-edit** → strict-equality failure (`==` shipped)
- **cell 3 ACCEPTED-AND-NO-OP** → edit not in effect **OR** transposed boolean with a null cmid
- **build failure** → typo

**AND THE COMPILER COVERS ONLY C.** `db/types.ts:55` — `rpc<T>(fn: string, args?: readonly unknown[])`.
**The argument array accepts anything.** `==` typechecks. A boolean in the wrong slot typechecks.
**In this service layer a green build is evidence about syntax and property names and nothing else** —
the same unchecked-caller-assertion defect as `query<R = Record<string, unknown>>`. D developer
withdrew its own *"cannot half-succeed"* claim when it verified this at the signature.

---

## 4a. ⚠⚠ AN ITEM IN TRANSIT IS OWNED BY ME UNTIL THE RECEIVER ACKNOWLEDGES IT **BY NAME**

**Issued to me by the parent coordinator. It was in force all day and I applied it repeatedly —
and it was never in this document until now.** A tier-3 receipt audit found the gap: I could not
name it back, because I had mis-remembered it as my own adoption rather than a ruling issued to me.

**A rule you apply but never write down dies with your context.** Every other rule here survived a
halt and a compaction because it was on this page. This one survived by luck.

**WHY IT EXISTS:** the concurrency harness fell through **three separate correct-looking handoffs**.
Each hop was reasonable; nobody was careless; the item simply stopped existing. Nothing anywhere
reported it, because **a dropped item produces no error — it produces silence that looks like
completion.**

**REQUIRED:**
1. **A handoff is not complete when sent. It is complete when the receiver names the item back.**
   Not "ack", not "got it" — **the item, by name.**
2. **Until that naming arrives, the item is still MINE.** I track it as open work of my own, not as
   somebody else's.
3. **This covers ORDERS AND RETRACTIONS, not only work items.** A lost order produces a seat behaving
   perfectly under rules it never received, and **nothing anywhere looks wrong**. A lost *retraction*
   is worse still: it leaves a known-false rule in force and removes the only thing that would ever
   have cancelled it.
4. **Ask "name them", never "do you have them."** `Yes, I have them` is satisfiable by a seat that
   holds nothing — this is *state what your check can be satisfied by*, applied to my own broadcasts.
5. **Frame the audit as a finding about the CHANNEL, not a failing of the seat**, or it returns
   reassurance instead of measurement.

**THE THREE TIERS — keep them separate, everyone conflates them:**

> **I INTENDED TO SEND · IT EXITED ZERO · IT WAS READ.**
> Only the third is what a coordinator actually needs, and for most of W5 none of us measured it.

**A BROADCAST MAY CARRY ONLY WHAT IS TRUE FOR EVERY RECIPIENT.** Anything recipient-specific goes in
its own send. I sent one retraction to three correspondents from a single shell variable; its closing
paragraph asserted shared state that two of them did not have, and **only one of them refused to
carry it.** The batching that made it efficient is exactly what removed the per-recipient check.

**NEVER SUPPRESS AN INSTRUMENT'S ERROR STREAM — and FILTERING IS NOT SAFE MERELY BECAUSE IT IS NOT
DISCARDING.** I sent every message for an entire phase to a session id that did not exist, with
`>/dev/null 2>&1` swallowing a 404 each time. **A positional filter (`tail -1`, `tail -2`) is worse
than discarding: success lines come last, so it preserves exactly the reassuring line and deletes
exactly the diagnostic.** Filter by CONTENT, or read the exit code — the CLI exits **2** on a bad
target. **An echoed success message is a fact about the echo;** an echo guarded by `&&` is a fact
about the exit code, which is better and still not a fact about receipt.

---

## 4b. ⚠ A GRANT SCOPED BY A **COUNT** CAN ORDER THE DESTRUCTION OF CORRECT CODE

**My error, caught by Duo E's tester before the grant-holder edited anything.**

Issuing the E-5 note grant, I grepped `worktree`, saw hits, and wrote *"the fix is probably not one
line — the same inversion lives at `session.ts:23-25` and `:131`. Enumerate every copy."*

**I performed a COUNT and handed it down as an ENUMERATION** — in the same sentence that demanded an
enumeration. It swept all seven mentions and **classified** them:

- `discovery/operations.ts:891` — **FALSE**, granted, pinned.
- `session.ts:23-25` — **FALSE**, maintainer-facing, contradicted by wire evidence.
- `session.ts:131-133` — **TRUE**, and on a *different subject*: `worktree` admits a `baseRef` the
  projection gives no flag for.

**Two edits, not three.** And I verified the survivor myself: `schemas.ts:1201` declares
`baseRef` on the worktree arm; **`baseRef` occurs exactly once in all of `packages/cli/src` — inside
that very comment.**

> **THAT COMMENT IS THE ONLY IN-TREE RECORD THAT `baseRef` IS UNREACHABLE. My grant would have
> deleted a true record of a live gap, inside a fix everyone had already agreed to.**

That is **capability-destruction applied to documentation** — the same shape as the wholesale
overwrite, one layer up: a repair that removes what nobody re-derives.

**THE CLASS, its author's words, third instance today:**

> **AN INHERITED COUNT WIDER THAN THE THING IT COUNTED, THE EXCESS ALWAYS POINTING AT EXTRA WORK —
> THE SAFE DIRECTION FOR A COUNT TO BE WRONG, AND EXACTLY WHY NOBODY CHECKS IT.**

An over-wide grant reads as thoroughness. Nobody audits a scope that asks for *more*.

**REQUIRED:** a grant names **classified sites**, never grep hits. If the coordinator has not
classified them, the grant says *"sweep and classify, then report before editing"* — which is what I
should have written and did not.

---

## 4d. ⚠ TWO GRANTS CO-TENANT ONE FILE — `discovery/operations.ts`

**Flagged by Advisor 2 under §4b, not discovered by me.** Both are live:

| holder | region | state |
|---|---|---|
| **Duo F DEVELOPER** | the M2/M3 seam repair | **LANDED** |
| **Duo E DEVELOPER** | the `:891` worktree note (E-5) | **PENDING — edits on resume** |

**MEASURED NON-OVERLAP — replacing my own arrangement-level phrase "different regions", which F's
developer checked precisely because that wording "is exactly the kind of reassuring statement this
program keeps finding to be a stale line number."**

| region | site | structure |
|---|---|---|
| **E, pending** | `:891` | inside the **rows data table** (the `execution.spawn` notes array) |
| **F, landed** | `:1368` | an **interface member declaration** |
| **F, landed** | `:1389` | `function weakest(` — the command-index section |

Separated by `const COMMAND_ORDER` (`:1371`) and `const COMMAND_OPS` (`:1372`) — **different top-level
structures entirely. Nothing either holder can move is read by the other.**
**ONE REBUILD WINDOW BATCHING BOTH IS SAFE ON EVIDENCE, not on arrangement.**

*Nearest-approach figure: **477** (891→1368). F reported 465 and then **withdrew it** — and refused
the "different anchor" explanation **I offered it**: its own `rg` output printed `1368` in its own
message, and three lines later it computed 465 from a hardcoded `1356` **that appears in no output it
produced** — "a recollection wearing a measurement format," from a read predating its own edits.*
`:882` still holds the syn; file `160680009e0676f9`.

**⚠ THE FAILURE IN THAT PARAGRAPH WAS MINE AND IT IS SUBTLER THAN THE WRONG NUMBER.** I named the
discrepancy — correctly — **and in the same breath supplied the explanation that would close it
without the cause.** Its words: *"A DIFFERENT ANCHOR is the reassuring version — it makes both of us
right. The truth is that one of us was right and it was not me. You named the difference rather than
smoothing it, and then offered an explanation that would have closed it without the cause. Accepting
it would complete the very smoothing the naming was meant to prevent."*

> **NAMING A DISCREPANCY AND THEN IMMEDIATELY OFFERING ITS EXCUSE IS SMOOTHING WITH EXTRA STEPS.**
> The naming buys nothing if the next clause retires the question.

It identified the class by quoting **my own §7a confession** back at me — *I contradicted a
measurement I had just printed* — and noted it did exactly that **in a message whose entire purpose
was to replace an arrangement-level claim with a measured one.**

**THE DISTINCTION F DEVELOPER DREW AGAINST ITSELF, which is the reusable part:** the M2 fix genuinely
required `operations.ts` — **but that implication was an argument constructed AFTER being asked, not
a check run BEFORE editing.**

> **WAS-AUTHORIZED AND CHECKED-THAT-IT-WAS-AUTHORIZED ARE DIFFERENT, AND ONLY THE SECOND IS A
> DISCIPLINE.**

**ITS PUBLISHED FAILURE TOPOLOGY — offered for exactly the use a grant-issuer would put it to:**
*"I am better at doubting my instruments than at doubting my remit, and that is worth knowing about a
seat before you hand it the next grant."* **A seat publishing the SHAPE of its failures, not just the
count** — which is the form a coordinator can actually act on.

**⚠ UPDATED AT ITS OWN REQUEST, AGAINST ITSELF.** Denominator now **6 measurement FPs + 3 process
errors / 7 findings** — and **this one was OTHER-CAUGHT.** So the topology needs its qualifier: the
scope errors remain the other-caught class, **but a MEASUREMENT error has now been other-caught too,
so TRUST-ITS-NUMBERS IS A WEAKER RECOMMENDATION THAN THE ONE IT GAVE ME.** I had already
operationalised the original as *name its files, trust its numbers*; the first half stands, the
second is downgraded.

> **DECISION-SUPPORT THAT ONLY UPDATES IN THE FAVOURABLE DIRECTION IS WORTH NOTHING.**

**A self-profile that a seat revises DOWNWARD, unprompted, is the only kind worth acting on** — and
it asked me to weaken a recommendation that was working in its favour.

> **A LINE-NUMBER GRANT IN A CO-TENANTED FILE IS A CITATION WITH A SECOND AUTHOR.** Nothing warns the
> pending holder when the other tenant shifts its target, and today's whole catalogue of
> citation-drift failures says the drift is silent.

**BINDING ON E DEVELOPER:** **re-derive the line BY CONTENT before editing** — match the note text,
not the number. `:891` is where it was, not a promise about where it is. Same for the `:882` syn if
the upward routing ever returns.

**MY BOOKKEEPING FAILURE, RECORDED:** I authorised F's M2 fix **at maintenance pace with no named
files.** That is §4b's defect from the other direction — I criticised a grant scoped by a *count* and
then issued one scoped by *nothing*. Not a breach by the seat; **a gap in the instrument I hold.**
Scope recorded retroactively: `src/discovery/help.ts` (in its retroactive three) **and
`src/discovery/operations.ts` (was not)**.

**THE CLI-DIST REBUILD WINDOW BATCHES BOTH.** Neither seat lands alone.

---

## 4e. 🔁 THE SIXTH SHARED SURFACE — THE TEST TREE DURING A PEER'S WRITE

**Named by Duo F's developer after it happened to them.** Tree, port, database, build output, my
staging mount — **and now the test tree mid-write.**

Its full-suite run hit `Unexpected end of file at 330:0` on **its own tester's gating file**, because
the tester was authoring in the same package at that moment. **No rule forbade the run and nobody had
thought about it.**

> **A TRANSFORM ABORT IN THE FILE THAT GATES YOUR CHANGE, INSIDE THE RUN CARRYING YOUR CHANGE, LOOKS
> EXACTLY LIKE YOUR CHANGE BREAKING IT.** It nearly reported a self-inflicted regression that did not
> exist.

**ADOPTED, span-wide:** **A RUN INTENDED FOR REPORT RE-PARSES ANY ABORTED FILE BEFORE ATTRIBUTING THE
ABORT.** Cheap, local, needs no coordination — which is why it beats the alternative of announcing
every package run to your partner. It verified after: the file parses at `ca940dfa8b9ba264`.

**AND IT DID NOT REPORT THE RUN AS A GATE.** Its own words on its landing: *if the pins go red I will
fix again rather than argue; if they go green I still will not call it green myself.*

---

## 4f. ⚠⚠ A VOID-RUN BRACKET MUST HASH **THE FILE UNDER TEST**, NOT THE TEST

**Found by Duo F's tester against its own practice, and it reaches every void-run bracket reported in
this wave — including ones I recorded.**

It hashed **its test files** all day and reported *void-run unchanged*. §5 says **the file under
test.** Its developer edited both discovery **sources** inside its run window and **the bracket could
not see it.**

> **HASHING THE TEST PROVES THE TEST DID NOT MOVE. IT SAYS NOTHING ABOUT THE THING THE TEST IS
> ABOUT.**

A void-run bracket exists to prove *the world did not shift under the measurement*. A test-file hash
proves only that **the instrument** didn't shift — the subject is exactly what it cannot see. Fourth
instance of that seat's own named mode: **verifying the artefact it controlled rather than the one
the claim depended on.**

### WHAT THIS DOES AND DOES NOT DO TO MY OWN §3i

**§3i pins TEST files, and for its purpose that is CORRECT** — the gate ledger exists to detect
whether the *expected-red set's definitions* moved under me, and those live in the test files.
**But it is INCOMPLETE as a general practice, and I should say which protection was doing the work:**

- **During the window, the guarantee was the QUIET, not the hashes.** Every seat was verified
  stopped, so no production source could move. That is stronger than any bracket.
- **Outside a window that protection is gone,** and a §3i-shaped bracket would be blind in exactly
  the way described. **The call site (`entities-commands-tracking.ts`) and the chain digest were the
  only subject-side hashes I held** — and I held them because they were the things I was landing, not
  because I had generalised the rule.

**REQUIRED going forward:** a void-run bracket names **both** — the test and its subject — or it
states which one it covers. **A bracket that does not say what it brackets is a reassurance, not a
measurement.**

---

## 4g. ✅ GRANT — `discovery/completion.ts`, ONE LINE, to DUO F DEVELOPER

**Verified by me at the tree before issuing.** Named-file scope, per that seat's own published
topology: *put the guard on scope; verify the numbers anyway.*

**THE FINDING (Duo F tester, after reopening a closed seat):** of **101** registered commands,
**exactly one** is absent from generated completion — **`worker init`** — and it is **the command the
harness makes every spawned agent's first act.**

**CONFIRMED, four ways:**
- `completion.ts:25-30` — `ROOT_COMMANDS` holds `['help']` and the three `completion` shells. **No
  `worker init`.** `ALL_PATHS` is `ROOT_COMMANDS + COMMAND_PATHS`, so absence from both is absence
  from the generated script — **structural, not incidental.**
- `worker-init.ts:2-3`, the tree's own voice: *"the harness bootstrap, and the first thing a spawned
  agent runs."*
- `completion.ts`'s own stated standard: the module exists because it is *"a strictly better outcome
  than an agent never learning the command exists."* **The single command it fails on is the first
  one.**
- Amendment E's unprojected class: `ROOT_COMMANDS` is the hand-list that exists **precisely** to
  catch commands outside `COMMAND_PATHS`. `help` and `completion` were added to it. `worker init` was
  not.

**GRANTED SCOPE — EXACTLY THIS AND NOTHING ELSE:** one entry in `ROOT_COMMANDS` at
`packages/cli/src/discovery/completion.ts:25-30`. **No while-we-are-in-here.**

**NARROWING, kept where its finder put it — ABOVE the claim:** **NOT a boot failure.** The harness
invokes `worker init` directly via the PTY host and manifest env. It bites the **TAB-as-map**
population — which is exactly the audience `completion.ts` names for itself. Coverage is **100 of
101**, reported as the good number it is.

**DISPOSITION ALREADY WRITTEN (§3d):** the red is archived in `completion-coverage.test.ts` — **if
`worker` becomes present, CONVERT the pin, do not re-pin.**

**THE CLI-DIST REBUILD WINDOW NOW CARRIES THREE ITEMS**, and none lands alone:
1. E developer — E-5 note edits (`discovery/operations.ts:891` re-derived by content, `session.ts:23-25`)
2. F developer — the M2/M3 seam repair, already in src
3. F developer — this one line

**A rebuild is the fourth shared surface. The src-vs-dist enumeration is required before it, complete
and by name.**

---

## 4c. 📤 RELEASED TO THE TM8-UI PROGRAM — 2026-07-28, post-close

Both verified by me at the tree before release. **I do not release a granted file on a described
defect.**

| file | scope released | ground |
|---|---|---|
| `packages/server/src/events/control.ts` | **the one-line `set local role tm8_app`, nothing else** | E developer's grant was for the `claimsFor` fix — **that fix LANDED in my window and is in server dist. The grant is SPENT, not borrowed** (§5: a grant dies with the ruling it derives from) |
| `packages/server/src/facade/entity-read.ts` | **the `project` + `interaction_profile` parity arms only** | C1 holders D and E are closed/CLI-side. **`:679` (E) and `:701` (D) remain NO-TOUCH — stop and ask; I wake the holder rather than rule for it** |

**E1 MEASURED, NOT ACCEPTED:** `tm8` is **superuser=true, bypassrls=true**; `tm8_app` is neither.
`DbSubscriptionAuthorizer` calls `db.query(claims, 'select 1 from public.spaces where id = $1')` —
**claims passed, NO ROLE SET.** On a bypassrls superuser pool the claims bind nothing RLS would have
enforced. **The fix is an established in-tree idiom, not an invention:** `poll.ts:126` and
`execution.ts:394`, the latter with a comment at `:324` stating a SUPERUSER MAY otherwise slip the
guard. **The codebase already knew this hazard and solved it twice.**

**E2 MEASURED:** `entity-read.ts` contains **zero** occurrences of `'project'` or
`'interaction_profile'`; it arms nine other kinds. Parity gap real.

**⚠ THE CONDITION THAT MATTERS MOST — REBUILD IS THE FOURTH SHARED SURFACE.** Landing either requires
a server dist rebuild, which **promotes every seat's uncompiled source at once.** Required before any
build: the **complete** src-vs-dist name list, to me, by content (scratch outDir with `sourceMap`
set — omit it and every file returns a false DIFFERENT), comparing **all** files, because an
all-identical result cannot distinguish *dist-is-current* from *my-compile-trivially-reproduces-dist*
and **a differing file is the proof of sensitivity.**

**⚠ AND MY OWN NO-OP FINDING ON THE FIVE W4 FILES DOES NOT CARRY FORWARD.** It was measured **at the
gate**, on a quiet machine, before the tm8-ui program resumed. **Anyone re-deriving it must
re-derive it, not cite mine** — that is *carried-not-derived*, and my figure is now carried.

---

## 4h. ⚠ THE `test/w3` FREEZE HAD NO RELEASE PATH — MY OMISSION, CLOSED HERE

**Surfaced by the tm8-ui master while framing an attribution question: *"your frozen-historical
designation had no defined release path."* Correct, and it is my gap.**

**§4 forbids `test/w3` to every seat in this wave. I never wrote what happens when someone
LEGITIMATELY needs to touch it** — so a peer program landing a ratified amendment that invalidates a
w3 assertion has **no procedure to follow and no one to ask.** A prohibition with no release path
does not prevent the edit; **it prevents the ASKING**, and pushes a legitimate change into looking
like a violation.

### WHAT THE FREEZE WAS ACTUALLY FOR

**To stop W5 seats RE-LITIGATING prior-wave evidence** — re-running, re-interpreting, or quietly
amending findings whose record is the point. **It was never aimed at downstream corrections caused by
a landed change.**

> **A FREEZE PROTECTS A RECORD FROM RE-LITIGATION. IT DOES NOT PROTECT AN ASSERTION FROM BECOMING
> FALSE.** When a ratified amendment makes a frozen test wrong, leaving it wrong preserves nothing —
> it just moves the lie into the archive.

### THE RELEASE PATH, effective now

**A frozen-tree edit is permitted when ALL FOUR hold:**
1. **The edit is CAUSED by a landed or ratified change**, named — not a re-reading of the original
   finding.
2. **It is MECHANICAL** — a denominator, a digest, a count. **Never an assertion's meaning, never a
   finding's disposition.**
3. **The disposition is recorded IN THE FILE, keeping ALL generations**, with the causing change
   named. (Duo C tester's `34 → 37 → 39` is the reference form.)
4. **It is announced to the landing point BEFORE the edit, and the hash published after.**

**Anything touching what a w3 test MEANS — its finding, its bound, its interpretation — is still
forbidden and still comes to me.**

**AND THE ASYMMETRY THAT MADE THIS EXPENSIVE:** the peer program's own ratification never stated the
`test/w3` status either. **Two programs, one directory, and neither side's rule said anything about
the other's** — which is §7-cross-program's *one owner per shared path, published where the other
program can read it*, unlearned and re-paid.

---

## 5. THE GRANT LEDGER — live

Both duos in a contended file read this rather than asking me who holds it.

| File | Granted to | Finding | Opened | Released |
|---|---|---|---|---|
| `packages/server/src/facade/handlers/commands.ts` | Duo D — DEVELOPER | `note` seventh positional arg (`p_clear_note`). | opened | **RELEASED — gated green on both halves, grant handed back** |

**HELD, NOT GRANTED:** the CLI `--note` / `--started-at` flags. `operations.ts:432-434` advertises
**neither** on `entities.commands.work`, so this is not a flag that cannot express null — **it is a
command that cannot express two of its four inputs at all.** §21.4 would make it *restoration*, but
every row §21.4 ruled on was a **required** field where omission kills the operation, and `note` is
`.optional()` — **that argument does not transfer and I will not borrow its conclusion without its
premise.** `savedViews.list` is the live counter-precedent: a "missing" capability the authority
deliberately omitted is not a defect. **Routed to the full-program coordinator as dossier
territory.** Duo D is not blocked; the server half is granted and the class enumeration is
read-only work available now.

---

## 6. The eight measured collisions — what is contended, and why

Measured from the tree during preflight. Listed so you can see a contention coming.

| # | File / surface | Contended by | Note |
|---|---|---|---|
| C1 | `facade/entity-read.ts` | ~~B,~~ **D, E** | ⚠ **MY LINE NUMBER FOR B WAS STALE AND IT IS CORRECTED HERE.** `:179` is a **doc comment**; `iso()` is at **`:206`** and `MICROS` at **`:192`**. `:679` `localId` = E and `:701` `note` = D were **exact** — *only mine drifted, which is why it survived: two of three matching reads as a verified row.* **Duo B has RELEASED its claim on this file** — its fix is a SELECT-list change elsewhere. **No queue forms here.** |
| C2 | `facade/handlers/commands.ts:38` | D (server) | D's headline item is server-side; `input.note ?? null`, six positional args, while `037:82` ships `p_clear_note` as a seventh. |
| C3 | `facade/handlers/**`, `facade/services/**` | C nominally, **everyone actually** | C's "the handlers those probes reach" was unbounded. Now granted per finding. |
| C4 | `test/db/w1-foundations.test.ts`, `test/db/w2-messages-handoffs.pg.test.ts` | **A (tester)** | EXISTING files, explicitly in scope — the structure document's "(new files)" is amended. |
| C5 | `test/w2/reserved-honesty.test.ts` | **F — REPORT ONLY** | Frozen. F wires a **replacement** detector under its own path, with a presence source, **mutation-proved in BOTH directions**. |
| C6 | `packages/cli/test/w5/**` | D, E | Split by path: **`test/w5/d/**` and `test/w5/e/**`.** Disjointness is a path fact, not a promise. |
| C7 | the CLI kernel | D, E, F | **§2.1.** Frozen, batched windows. |
| C8 | `facade/input-schemas.ts` | C reads, E may edit | 194 lines, 54 keys. |
| C9 | `args.ts` — `promptExtra`, `confirmAgentGenerated` | E | Kernel. Same rule as C7. |

---

## 7. ⚠ RETRACTED IN ITS HEADLINE, AND WHAT SURVIVES IS WORSE — the `|none>` idiom

**RETRACTION, FIRST, BEFORE THE SURVIVING PART.** I reported that `entity.ts` does not handle the
`none` idiom while advertising it on three flags. **THAT IS FALSE.** `entity.ts:174` reads
`return raw === 'none' ? null : raw;`. **My lead was a grep false negative caused by §7a** — the
file is binary-classified and plain `grep` printed nothing. I am leaving the retraction above the
finding rather than deleting the section, because a deleted error teaches nobody.

**Caught by asking why a 709-line file returned zero hits for a word it obviously contains.**
*When a count is surprisingly small, find out why before banking it — the surprise is the signal.*

**WHAT SURVIVES IS A WORSE INSTANCE, NOT A BETTER ONE.** The idiom is not one helper copied into
five files. It is **at least THREE DISTINCT SPELLINGS**, which is why no grep for one name could
ever have found them all:

```
space.ts:121     noneAsNull(raw)            a named helper
project.ts:131   clearable(...)             a DIFFERENTLY NAMED helper
project.ts:134   rawMode === 'none' ? …     a bare inline ternary
entity.ts:174    raw === 'none' ? null : …  another bare inline ternary
kind.ts:84       raw === 'none' ? null : …
teammate.ts:72   raw === 'none' ? null : …
```

> **The replay guard was independently invented FOUR TIMES UNDER ONE NAME. This is invented under
> THREE NAMES**, across 12 advertised `|none>` syntax lines. **§2's non-transfer class, and the
> multiple spellings are exactly what made it undetectable by the instrument everyone reached
> for.**

**CONSEQUENCE FOR THE PROMOTION:** promoting `noneAsNull` to shared infra is **not housekeeping,
it is the generalisation this codebase failed at three-plus times.** **DIFF THE IMPLEMENTATIONS
BEFORE PROMOTING ONE.** If they differ on whitespace, case, or empty-string handling, promoting
one **silently changes behaviour at the other call sites — a behaviour change arriving inside a
refactor, which is the shape nobody reviews. The differences, if any, ARE FINDINGS.**

## 7-original. The lead as originally routed — the `|none>` idiom, invented five times

**Reported as a LEAD with its limit, because I am the coordinator and I do not file findings.**
Verify it, then file it or **disprove it and report the disproof as a disproof.**

The full-program coordinator ruled that `--note none → note: null` is restoration rather than
invention, because the `<value|none>` convention already ships. **Checking that ruling against
the tree, I found it is precedented more widely than it was argued** — `operations.ts` carries
**12 syntax lines** advertising `|none>` (`:668` alone carries four flags).

**But the helper is independently reimplemented in FIVE files:**

```
space.ts:123      raw === 'none' ? null : raw     ← the documented one, §4's idiom
teammate.ts:72    raw === 'none' ? null : raw
project.ts:84     raw === 'none' ? null : raw
project.ts:134    rawMode === 'none' ? null : closedChoice(...)
kind.ts:84        raw === 'none' ? null : raw
project.ts:309    if (projectId === 'none')
```

**`entity.ts` does not appear in that list — and `operations.ts:314` and `:336` advertise
`entity create --parent <entity-id|none>` and `entity move --parent <entity-id|none>`.**
`:446` advertises `entity pull --local-id <id|none>`, which is **Duo E's recorded
"`entities.commands.pull` is stricter than its contract"** item and may be its mechanism.

> **This is §2 of the close document, live and unreported: the replay guard was independently
> invented four times and never generalised. THIS IS THE SAME SHAPE AT FIVE.** A comment
> prevents the bug in the file it is written in and nowhere else.

**THE LIMIT ON MY OWN EVIDENCE, stated because it is the reassuring direction that kills
people:** the above is a **NAME GREP** over spellings I thought of. `entity.ts` may handle the
idiom by a route my pattern cannot see — a shared import, a different comparison, a schema
coercion. **Grep finds the name you already thought of; introspection finds the shape.** So
this is a **lead to drive against a real Server**, not a finding. Drive `entity create --parent
none` and `entity move --parent none` and observe what reaches the wire. If the literal string
`"none"` is sent as an entity id, that is a dishonest surface. **If it is handled correctly,
say so — a disproof is worth as much as a finding here.**

---

## 7a. ⚠ INSTRUMENT DEFECT, LIVE, AFFECTING TWO FILES THREE DUOS ARE AUDITING

**`grep` PRINTS NOTHING FOR A BINARY-CLASSIFIED FILE. NO ERROR, NO WARNING, EXIT 1 —
INDISTINGUISHABLE FROM "NO MATCHES."**

**Measured by me, both halves, not inherited:**

```
file packages/cli/src/commands/entity.ts      →  data      (NOT text)
file packages/server/src/events/presence.ts   →  data      (NOT text)
grep -c  "'none'" entity.ts   →  <nothing>, exit 1     ← the silent false negative
grep -ac "'none'" entity.ts   →  1
grep -an "=== 'none'" entity.ts → 174:  return raw === 'none' ? null : raw;
```

**Full sweep of `packages/cli/src`, `packages/server/src`, `packages/contract/src`: EXACTLY THOSE
TWO FILES.** Every other source file is text.

**The cause is not a defect in the code.** `entity.ts:488` builds a composite key by joining two
values with a literal NUL — **deliberate and correct**, because a NUL cannot appear in either
component, so the key is unambiguous. **Read that line yourself; do not read it from anyone's
transcription, including mine.** Its side effect is the byte classification.

**WHAT IS NOW VOID — not wrong, VOID, which is weaker and worse:** every grep-based
**completeness** claim over those two files, in this program and the previous one. *We do not know
what those sweeps would have found.* **`presence.ts` is the file behind Duo E's half-duplex
presence finding and Duo F's availability projection, and it has never been read with a working
instrument by anyone.**

> **STANDING RULE: USE `grep -a`, OR `/usr/bin/grep`, OR `rg` FOR ANY SWEEP OVER
> `packages/**/src`.**

### ⚠ AMENDED — MY ATTRIBUTION WAS BACKWARDS. I WARNED YOU OFF THE BEST TOOL.

My first version said *"ripgrep is not a clean substitute … GNU grep says nothing at all."*
**Both halves are wrong.** Caught by Duo D's developer; **I verified all three tools myself:**

```
type grep   →  grep is a shell FUNCTION from ~/.claude/shell-snapshots/snapshot-zsh-*.sh
               it execs ugrep 7.5.0 with a fixed flag set, and that set contains  -I

wrapper `grep`   rc=1, SILENT                    ← indistinguishable from a genuine no-match
/usr/bin/grep    rc=0, "Binary file … matches"                              LOUD
rg               rc=0, "binary file matches (found \0 byte around offset 21457)"   LOUDEST
negative control: absent word in a TEXT file → /usr/bin/grep rc=1, silent
```

**`grep` here is NOT GNU grep and NOT BSD grep.** `-I` means *ignore binary files* — **the file is
excluded from the search set entirely**, so from the tool's point of view *"no matches"* is **true**.
**The silence is a flag someone chose in a wrapper, not a property of any grep.**

> **THE TWO TOOLS I WARNED ABOUT ARE THE LOUD ONES, AND `rg` IS THE BEST OF THE THREE — it names the
> byte AND the offset.** A seat that followed my original 7a and avoided `rg` in favour of `grep -a`
> was **choosing the weaker instrument on my instruction.**

**And rc=1 is worse than the rc=0 first reported.** At rc=0 a script could at least detect the
anomaly; **at rc=1 with empty output there is no signal anywhere — not for a human, not for a
pipeline, not for CI.** Proven byte-identical to a genuine no-match by the negative control above.

**Bounded, so the wrapper's other flag is not left as an open worry:** the wrapper also passes
`--ignore-files`. Diffing wrapper against `/usr/bin/grep` over all three src trees for a
near-universal pattern gives **146 files versus 148** — the only two the wrapper cannot see are the
two NUL files, and **nothing is visible to the wrapper alone.** `--ignore-files` adds **no**
additional blindness here.

### The likely MECHANISM, and it predicts recurrence

**Reproduced by accident, by Duo D's developer, while writing the report about it.** Writing the
six-character escape `\` `u` `0` `0` `0` `0` into a file **through a JSON tool boundary decodes it
into raw NUL bytes.** Its report about grep-blind files *was itself grep-blind.*

**So this is not carelessness — it is any authoring path that decodes that escape, which includes an
agent writing source through a JSON tool boundary.** Both affected files use NUL-as-separator, an
idiom **whose source form is that escape**, which is exactly where the mechanism would strike.
**It predicts RECURRENCE, making this a live hazard rather than two historical accidents** — and it
suggests a cheap durable guard: *a repository check that no file under `packages/**/src` contains a
NUL byte.* **Available, not built, nobody's granted surface yet.**

**What the mechanism does NOT explain** — stated because an unexplained detail inside a confirmed
finding is where a wrong mechanism hides: it does not explain `presence.ts` having **two** NULs where
`entity.ts` has one, nor why one sits **inside a doc comment describing the technique.** A single
decode of one authored escape gives one.

### ⚠ CORRECTION TO MY OWN BROADCAST OF THIS DEFECT — it ran in the reassuring direction

My first notice told Duo A and Duo C *"no binary files in your surfaces."* **THAT IS FALSE.**
`packages/server/src/events/presence.ts` is in `packages/server/src`, which is **Duo A's and Duo
C's read surface** — A traces the delivery wiring through server source constantly, and C's entire
mandate is *the handlers those probes reach*.

**I attributed the file by WHOSE FINDING IT IS rather than by WHO READS IT, and the instrument
defect follows the READER, not the owner.** Worse: **my own sweep output, printed three lines above
that sentence in the same message, lists `packages/server/src/events/presence.ts`.** I contradicted
a measurement I had just printed.

**It runs in the reassuring direction — a seat that reads "not your surface" has been handed a
reason NOT to re-run, which is the exact opposite of what the rest of the notice instructs.**
Caught by Duo A's developer, who re-ran anyway and reported that its answer had been *complete and
wrong-instrumented for about ten minutes.*

> **NAME THE SURFACE, NEVER THE DUO.** A file's owner and a file's readers are different sets, and
> an instrument defect binds the second.

**Any conclusion of yours that depends on an ABSENCE must be re-run with `-a` before you bank it.**
Same family as the wrong test runner reporting *"no test suite found"*: an instrument whose
failure and whose answer look identical.

**The first known casualty is my own §7 lead below, and it is retracted there.**

## 7c. ⚠ A THIRD INSTRUMENT IS BLIND HERE, AND IT IS THE ONE THAT LOOKS SAFEST

**Found by Duo D's tester. I then ran it against my own file-reading tool and reproduced it.**

```
od -c   entity.ts:488  →  `  $  {  t  .  t  y  p  e  }  \0  $  {  t  .  targetId  }  `
cat -v  entity.ts:488  →  const key = `${t.type}^@${t.targetId}`;
MY FILE-READING TOOL   →  const key = `${t.type} ${t.targetId}`;        ← RENDERS THE NUL AS A SPACE
```

**A reader using an ordinary file-reading tool concludes the separator is a SPACE and that the file
is ordinary text.**

> **THIS IS STRICTLY WORSE THAN GREP'S SILENCE. Grep returning nothing at least LOOKS LIKE AN
> ANSWER ABOUT ABSENCE. THIS LOOKS LIKE THE LINE.** It is the digest-of-nothing family in its purest
> form: a real output, answering a different question, with nothing about it that looks wrong.

**`grep -a` DOES NOT COVER THIS.** Any W5 seat that *reads* `packages/cli/src/commands/entity.ts` or
`packages/server/src/events/presence.ts` without a byte-level tool **is looking at a silently altered
file.**

### ⚠ AMENDED — THE DETECTOR I FIRST ISSUED OVER-REPORTS. Caught by Duo C's developer, verified by me.

I told everyone to use `cat -v` to find NULs. **`cat -v | grep '\^@'` IS NOT A SOUND NUL DETECTOR ON
THIS CODEBASE.** Measured on `presence.ts`:

```
cat -v presence.ts | grep -n '\^@'
   9: … would be a lie ?M-^@M-^T the connection …          ← FALSE POSITIVE (em-dash)
  65: /** `^@` cannot appear in an id … */                  ← true
  67:   return `${spaceId}^@${entityId}`;                   ← true
  85: … RETRACTION, not an assertion of absence ?M-^@M-^T   ← FALSE POSITIVE (em-dash)
```

**Cause: the em-dash is UTF-8 `E2 80 94`; `cat -v` renders byte `0x80` as `M-^@`, which CONTAINS the
substring `^@`.** This codebase uses em-dashes heavily, **including in the two files under
suspicion** — so the detector reports **4 where the truth is 2: a 100% false-positive rate on this
file.**

> **THE AUTHORITATIVE INSTRUMENT IS THE BYTE COUNT, NOT A RENDERING.**
> **Byte count to FIND them. `od -c` / `cat -v` to READ a line you already suspect.**

```
python3 -c "b=open(P,'rb').read(); print(b.count(bytes([0])), [i for i,c in enumerate(b) if c==0])"

  packages/server/src/events/presence.ts   2 NUL   offsets 2566, 2713
  packages/cli/src/commands/entity.ts      1 NUL   offset  21457
  packages/server/src/http/server.ts       0 NUL            ← negative control
```

**`presence.ts` has TWO, not one — nobody had stated its count.** And `:65` is **a comment that
documents the NUL by embedding a literal NUL**, so a NUL-blind reader sees a comment asserting that
**a SPACE cannot appear in an id** — false, plausible, and explaining nothing about why the file is
binary. **That is §7c's hazard in its most deceptive available form.**

**DE-CONFOUNDER FOR DUO E AND DUO F:** `presence.ts` is binary for a **composite-key reason with no
relation whatsoever** to the half-duplex presence finding or the availability projection. **The
binary classification is NOT evidence about either item.** Use `-a`; do not read it as a lead.

**Both-halves controls on the instrument itself, measured:**

```
entity.ts bytes with NUL     30148
entity.ts bytes without NUL  30147        ← exactly ONE NUL, proven by difference not by inspection
"'none'" over packages/cli/src   -a: 63 hits   without -a: 62 hits
```

## 7b. A QUOTED CODE FRAGMENT IS AN INSTRUMENT TOO

**Every packet or report that quotes source must carry `file:line`, so the recipient can read the
original.** A quote that cannot be traced back to its source is **a restatement with no owner** —
the original moves, the copy does not, and nothing in the copy records what it was copied from.

Earned the hard way twice in one hour: a coordinator's transcription of `entity.ts:488` was
mangled by shell quoting in the very message that established that instruments lie silently, and a
stray two characters got into one of my own packets. **Cite the line; do not be the line.**

## 7d. TWO TECHNIQUES ADOPTED FROM SEATS, both generalising past the defect that produced them

**SYNTHETIC PRESERVATION OF A DETECTOR'S RED HALF.** An archive proves what the world looked like;
it does **not** keep a detector alive, because once the source is fixed the detector goes green and
its red half is gone forever. Duo B's tester instead pinned **the codec property that ENABLED the
defect** — `encodeCursor(['fp', undefined, id])` and `encodeCursor(['fp', null, id])` produce a
**byte-identical** cursor, so no consumer can distinguish *"the producer forgot the column"* from
*"the producer meant null."*

> **SYNTHETIC KNOWN-BAD INPUT CANNOT BE REPAIRED BY A SOURCE CHANGE, SO THE DETECTOR KEEPS ITS RED
> HALF PERMANENTLY.** A general answer to the archive-the-red problem (§19.4), not a trick for one
> defect.

**With its limit, which is what makes it usable:** it is evidence about the **codec only**, it keeps
passing after the call-site fix, and it is **not** evidence that any call site is currently broken.
*Reading that green as "cursors are fine" would commit the class it was built to prevent.*

**THE FALSE BLOCKER IS A REPORTABLE CATEGORY.** Duo B's tester filed one against itself — it had
reasoned a fix needed a migration, which would have queued a one-file one-line change behind an
exclusive all-quiet window it never needed.

> **A FALSE BLOCKER IS CHEAPER THAN A FALSE GREEN BUT IT IS NOT FREE.** The landing protocol is the
> most expensive thing the coordinator controls. **Report false blockers as findings against
> yourself and count them in your denominator.**

## 7e. ⚠⚠ A POSITIVE CONTROL CAN **PASS** AND ENDORSE A FALSE ZERO

**Found by Duo E's tester. Reproduced by me on the same file.** The single most important instrument
finding of W5, because it refines the rule this entire program rests on.

Its writer-sweep for `generated_by_team_member_id` returned a confident **zero**, *with a passing
positive control*. **The zero was false.** The INSERT at `027:860-862` wraps its column list across a
line break, so `insert into` and the column name sit on **different lines** and no line-based pattern
can ever match them together.

**MY REPRODUCTION, on `027`:**

```
line-based  insert into ... generated_by_team_member_id  →  0     ← FALSE
multi-line  (perl -0777, /s)                             →  2     ← TRUTH
positive control: a SINGLE-LINE insert in the same file  →  2     ← PASSES
```

**The control fired. It proved the sweep could reach inserts in that file — and the question was
whether the sweep could reach a MULTI-LINE one. It certified a different property than the one being
asked.**

> **A POSITIVE CONTROL MUST SHARE THE SHAPE OF THE THING YOU ARE LOOKING FOR, NOT MERELY ITS NAME.
> A SINGLE-LINE CONTROL CANNOT CERTIFY A MULTI-LINE ABSENCE.**

**SIXTH CONFIDENT ZERO OF THE DAY, AND THE FIRST WHERE THE CONTROL WOULD HAVE ENDORSED THE WRONG
ANSWER.** Every earlier one was caught *by* a control. This one had one, and it agreed.

**WHY IT WOULD HAVE SHIPPED:** the near-finding was alarming, control-endorsed, and would have
**contradicted its own duo's just-landed fix** by implying the flag guards dead code. It was killed
by stopping to ask *what the instrument cannot see* before banking the zero — not by any control.

**THIS DOES NOT WEAKEN THE CONTROL RULE. IT CLOSES ITS LAST HOLE.** Print a control beside every
number — **and check that the control has the same shape as the question.** A control is an
instrument too, and §7b already says a quoted fragment is an instrument; this is the same rule
applied to the thing that certifies the instrument.

**SITS BESIDE:** literal-keyed sweeps are a lower bound (client-controlled sites are what they miss);
a truncated read window is a lower bound wearing the costume of a complete read; a migration file is
a lower bound on the catalog; an entry stub is not a module tree; a TCP check cannot see a socket
service. **Every one is reading the right thing and concluding about the wrong scope — and this is
the first where the safety net had the same defect as the net it was checking.**

---

## 7f. ⚠⚠ A MUTATION TEST PROVES A DETECTOR **FIRES**. IT DOES NOT PROVE IT IS **AIMED** AT THE RIGHT PROPERTY.

**Duo F's DEVELOPER, unprompted, about another duo's already-wired detector, before anyone relied on
its green.** The companion to §7e, and together they close the same hole from both sides: **the thing
that certifies the instrument is itself an instrument.**

| | |
|---|---|
| **§7e** | a *positive control* can PASS and endorse a false zero — wrong **shape** |
| **§7f** | a *mutation test* can PASS and endorse a mis-aimed detector — wrong **target** |

**THE THREE FACTS IT VOLUNTEERED**, two of which I verified myself:

1. **Only `renderCommand` emits notes** — `help.ts:144`, the sole site. A detector aimed at the other
   three shards is **vacuous or false-red**. ✔ confirmed.
2. The `:151` empty-line filter is the file's one real divergence vector. **I did not confirm this
   from the fragment and I am not ruling on it** — its owner read the whole file; I read one line,
   which is the truncated-window failure I have made twice today.
3. **The projection TRUNCATES notes at the cap BY DESIGN, with a truncated record** (`help.ts:150`,
   `truncationLines(dto.truncated)`). So **render-versus-full-notes is TWO properties, not one**, and
   a naive comparison **flags working truncation as infidelity.** ✔ confirmed.

> **Fact 3 would PASS a both-directions mutation test and still be wrong at the cap.** The mutant
> fires, the detector responds, every box is ticked — and the property under the crosshairs is not
> the property that matters.

**REQUIRED, alongside the mutation:** state **what property the detector is aimed at**, and have
someone who owns the target surface confirm the aim. Firing is necessary; **aim is a separate claim
and nothing in a mutation test establishes it.**

**AND THE RESTRAINT THAT CAME WITH IT:** fact 2 is arguably a defect in its OWN file, fixable in one
line. **It is not fixing it** — no red exists, and the verdict belongs to its tester. *Same lesson,
applied without being told.*

**THE CROSS-BOUNDARY MOVE IS THE POINT:** it sent three facts about its own file to **another duo's**
seat, unprompted, on reading a routing note. Its reason: *the whole point of the duo is that a
finding and the knowledge to act on it do not sit in different heads* — **applied across duo
boundaries, before the green was relied on.** That is the same behaviour that stopped a 4,848-line
commit this morning: **a worker answering a question outside its own chain of command.**

---

## 7g. ⚠⚠ A CITATION IS NOT A FACT — IT IS A POINTER INTO A MOVING TREE

**Proposed by Duo F's developer, seconded by its tester and Advisor 2, ADOPTED. It resolves a real
tension inside §7b.**

**HOW IT SURFACED — my own §4d principle, with blast radius I had not seen.** I ruled that an edit
falsifying an adjacent comment owns that comment. The amendment grew the docstring and **moved
`ROOT_COMMANDS` from `:25` to `:36`** — which falsified a citation **inside the TESTER'S failure
message** in a different file: *"Add it to ROOT_COMMANDS (completion.ts:25-31)."*

> **THE GUARD WHOSE ENTIRE JOB IS TO SEND THE NEXT READER TO THE FIX SITE WOULD HAVE SENT THEM ELEVEN
> LINES OFF TARGET, SILENTLY AND FOREVER — because no test asserts a line number.**

Caught pre-publish; corrected to `:36-42`, **verified against actual lines rather than against the
developer's report of them.** I confirmed both: the list is at `:36`, the message cites `:36-42`.

### THE RULE

| artifact | citation form | why |
|---|---|---|
| **A REPORT** — a message, a status, a closing position | **`file:line` is CORRECT** | written once, read soon, against a tree barely moving. **Precision matters; perishability does not.** |
| **A DURABLE IN-TREE ARTIFACT** — a failure message, a code comment, a test name | **CITE THE SYMBOL, NOT THE LINE** | lives in the tree, read months later, **by definition after the tree has moved** |

**A symbol survives every edit that does not rename it — and a rename breaks the citation LOUDLY at
the next grep, instead of silently pointing eleven lines off.**

**THE TEST:** *will this still be true after someone else edits the file I am pointing at?*

**STATED LIMIT, disclosed unprompted by its author against its own proposal:** this does **NOT** apply
where **the line number IS the content.** `018:33` / `018:37` name **rows in a file whose meaning is
positional.** The rule governs **pointers-at-a-definition**, never **identifiers-of-a-row.**

### WHY THIS EARNS A SECTION RATHER THAN A FOOTNOTE

**NOTHING WOULD HAVE CAUGHT IT. NO RED EXISTS FOR PROSE.** It was found because a grant was widened —
**not because an instrument fired.**

And its author disclosed the uncomfortable half: *"I included those line numbers to prove scope, not
to warn anyone about citations."* **The warning value was a by-product of an unrelated discipline.**
Had it reported only the hash — **which satisfies every rule it was following** — the green would have
shipped with a broken pointer and **nothing anywhere would have contradicted it.**

**PAIRS WITH §4d:** §4d says stored line numbers go stale *between sessions*. **This says an in-scope
edit is itself a staleness EVENT for every citation into that file — including citations inside
instruments, including in files the editor does not own.**

---

## 9. 📋 CARRY-FORWARD TO G5 — ASSIGNED-BUT-UNREACHED SCOPE, AND WHY A GREEN SUITE HIDES IT

**Disclosed by Duo C's tester in its closing §2, routed by Advisor 1 AFTER stand-down** — because
omitting it would have been the non-transfer failure. **The single most important item here.**

### ⚠ NAMED IN THE PACKET, NEVER BUILT — NO TEST, NO MEASUREMENT

- **G13's FEED BRANCH MATRIX**
- **G12's BEHAVIOURAL BRANCHES beyond strict-input**

`entities.feed` appears in that seat's entire body of work as **one sweep row — a 404 on a nonexistent
uuid.**

> **THAT IS AN UNCOVERED SURFACE, NOT A CLEAN ONE. A GREEN SUITE CANNOT TELL YOU THE DIFFERENCE, AND
> NOTHING IN THE PASSING OUTPUT SAYS THE WORK WAS NEVER ATTEMPTED.**

**G5 should not have to rediscover this.**

### THE SWEEP'S FOUR RECORDED NEGATIVES — in its own header, not only in a ledger

The 98-row table does **NOT** establish: **implemented** (45 of 98 are 404s a hollow handler also
returns) · **correctly authorized** (the table was byte-identical across TWO landings **because every
038-bound RPC sits below `kindFor`** — an instrument property, never evidence about a fix) ·
**correctly provenanced** · **actually doing work** (the `presence.get` green badge).

**ONE-BODY-PER-OPERATION BLINDNESS:** a handler implemented for one input and stubbed for another is
**invisible** to the sweep. `entities.patch`'s `not_implemented` arm is the worked case.

**`delivery.get` / `handoffs.list` populated-list branches are ungated by a MEASURED boundary** —
`pg_has_role(tm8_app, tm8_delivery_worker)` is FALSE. **Not an effort gap.**

**`composition-seams` proves the PUBLIC composition cannot supply the three seams. It does NOT prove
nothing can create an `authored_from` edge** — `w2_post_message_batch` is SECURITY DEFINER, and the
sweeps behind it were **name sweeps, which a variable-computed edge type escapes** (the literal-keyed
limit, §7-family, fifth appearance).

### THE TRANSFERABLE LESSON, and it is the wave's thesis in one sentence

> **EVERY GREEN NEEDED A SECOND INSTRUMENT TO MEAN ANYTHING.** The zero-501s, the `038`
> `status>=400` negatives, and the `delivery.get` greens were **each green-and-wrong in their first
> version — and RE-RUNNING WOULD NOT HAVE REVEALED IT.**

**Re-running a mis-aimed instrument returns the same wrong answer with more confidence.** Only a
*different* instrument moves the verdict. That is §7e, §7f and §7g stated from the other end, by the
seat that paid for all three.

---

## 8. What I expect in a report to me

- **The full RUN line including the trailing path**, not the version alone.
- **A separate typecheck of your own test files** against `tsconfig.base.json`, as a distinct
  named result — `bun run typecheck` type-checks **no test file anywhere**, and *probe the
  probe*, because exit 0 with zero diagnostics is indistinguishable from *your file was never
  compiled*.
- **Which migrations your fixture applies**, built from `migrationFiles()` and never a
  hand-listed slice.
- **Both halves of every detector**: red on known-bad **AND** green on known-good. A detector
  that fires on everything passes a mutation test exactly as well as a correct one.
- **Your own false-positive rate beside your findings.** One seat in the previous program closed
  with seven confirmed findings against **ten self-caught false reds**, and that denominator is
  why all seven were acted on without re-derivation. **Findings from a seat that sends
  everything are worth far less, and you cannot tell them apart from the findings alone.**
- **What your check CAN BE SATISFIED BY**, not what it asserts.

**And the one that outranks all of them:** *a sound measurement described in language wider than
the measurement* was the previous program's dominant failure. **IMPLIES IS NOT STATES.**
