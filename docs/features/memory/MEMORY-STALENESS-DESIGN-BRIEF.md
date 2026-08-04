# Design Brief — Entity Memory, Staleness, and Context Engineering

**This is a REQUIREMENTS AND EVIDENCE brief, not a design.** It contains the problem, the empirical
evidence for it, the constraints, and the user's stated direction. **The design is yours to produce.**
Where this document sketches a shape, it is labelled as a *sketch from the briefer* and you should feel free
to discard it — the evidence is the durable part, the sketches are not.

**Scope:** design and planning only. **No implementation, no migrations, no contract edits, no git.**

---

## 1. What the user asked for, in their words

> "we have to add that option, staleness of entities, so that we dont rot the context, and agentically
> invalidate. atleast so that agents have that capability"

> "i want to also support entities memory, worktree, maintaining a memories, and we have to attack the
> foundation problems of how we keep the memory updated, and mark old ones stale."

And the framing that started it:

> "one of the main reasons of this graph architecture is to have these entities marked as stale
> automatically if an agent finds it stale. hence the next agents inherit the graph."

**Four deliverables are implied and you should treat them as one problem, not four:**

1. **Entity staleness** — a fact in the graph can be marked stale, by an agent, with evidence.
2. **Entity memory** — entities carry durable memory that survives the session that wrote it.
3. **Worktree** — entities associated with an isolated working copy (relationship to memory is **an open
   question you should answer**, not a settled one).
4. **The foundation problem** — how memory stays *correct* over time, not just *present*.

**The user's core claim, which this brief exists to support: the next agent should inherit the GRAPH, not a
document.** Everything below is evidence for why that matters and what it has to get right.

---

## 2. Why this brief exists: a program just failed at exactly this, in a measurable way

A W0–W5 implementation program closed on 2026-07-27 after roughly one day of ~20 concurrent agent sessions
across two coordinated waves. **It produced ~4,000 lines of handoff documentation and a catalogue of
failures that are almost entirely context-rot failures.** Read
`docs/history/program-w0-w5/PROGRAM-CLOSE.md` first (it is the entry point, ~400 lines), then
`W0-W5-HANDOFF-STATE.md` §§15, 21–24 for the detail.

**The single most important sentence that program produced about itself:**

> **The expensive errors were never wrong facts. They were CORRECT MEASUREMENTS WHOSE SCOPE OUTRAN WHAT
> PRODUCED THEM.**

**And its explanation of why they recurred:**

> **The recurring failure is not ignorance. It is NON-TRANSFER OF KNOWLEDGE THAT ALREADY EXISTS IN THE
> TREE. A comment prevents the bug in the file it is written in and nowhere else.**

**Fourteen coordinator-level figures were challenged during that program. Fourteen fell. Every one fell to
somebody opening a file** — not to somebody reasoning. That is the base rate your design has to improve on.

---

## 3. THE EVIDENCE — every coordination failure, classified

This is the section to design against. Each row is a real, measured incident from a single day. **Group
them yourself if you find a better taxonomy; the classification below is the briefer's and is a sketch.**

### 3.1 Class A — SUPERSEDED: a successor exists, the copy did not move

| Incident | Detail |
|---|---|
| Chain digest in a document header | A handoff header read `chain 32 / f7a9e137…` two migrations after the chain reached 34. **A stale figure in the first six lines of a document whose entire subject was stale figures.** |
| A coordinator broadcast a rotation from a monitor reading | It had *already been reverted*. Nine sessions were ordered to re-bind to a state that no longer existed. **Four workers refused and re-measured.** |
| An "all-quiet" confirmation | Accurate at the instant given, then treated as a **standing state** during a landing window. |

**Detection: automatic in principle** — writing the successor implies the predecessor is superseded.
**Nothing in this program did that automatically.**

### 3.2 Class B — EXPIRED: true when written, subject changed underneath it

| Incident | Detail |
|---|---|
| *"the wiring cannot enforce that the URL authenticates as the right role"* | **True when written that morning; falsified when a guard landed mid-investigation.** Written one paragraph *after* quoting the guard that falsified it. **The FALSE clause was the one phrased as a durable limitation, so it is the one that would have survived into the handoff.** |
| A standing risk note | Named a problem that had been *solved*, and thereby **masked the live defect sitting behind it** (a durable publisher with no production caller). It misdirected three coordinators. |
| A stale example inside a correct argument | *"`messages.post` is still a 501 stub"* — true that morning, false by afternoon, inherited from an older packet. **A stale example propagates further than a stale conclusion, because it looks like supporting detail rather than a claim.** |
| A caveat stored in a test name | The test was named *"the N bindings that refuse an **EMPTY** probe."* The word `EMPTY` was the entire caveat. **A re-pin renamed the test and deleted it.** The measurement stayed correct; its scope stopped being written down anywhere. |
| An assertion whose *premise* expired | Two tests asserted `residual >= 6`. Residual reached zero — they **sample** residual operations, and there were none left to sample. Re-pinning to `>= 0` would produce **a green that describes nothing.** |

**Detection: derivable, but only if the dependency was recorded.** None were.

### 3.3 Class C — MIS-SCOPED: still true, and the claim built on it was wider ⚠ LARGEST CATEGORY

| Incident | Detail |
|---|---|
| `residual = 0` | **Soundly established that every operation is MOUNTED. Was read as IMPLEMENTED.** The probe sent no request body; an unmounted operation returns 501 before validation, so the probe is sound for mounting — but a *registered* handler that throws is invisible to it. **This was nearly written into an entry-point document as "every v1 operation is implemented."** |
| `73 + 25 = 98` | Four independent derivations agreed. **All four counted the same thing.** Four authors, one mechanism: a tautology wearing the costume of a cross-check. |
| A true disk measurement | Correct bytes, framed as **reclaimable**. Led to an irreversible deletion of 20 databases. |
| A defect filed as *"every wake to an exited session fails"* | **The causation test was always correct.** The *prose* over-generalised from a sound test: the scenario that was run got described as the whole class. The real scope was one authorship path in four. |
| "74 bits of entropy" | A **CLI** property, stated as a **system** property. The shipped UI generated the same identifiers with **zero** random bits. |

**Detection: NEVER automatic. Nothing decayed.** A staleness flag will not fire on any row in this table,
and **this is the category that cost the most.** If your design only handles A and B, it addresses the
minority of the evidence.

### 3.4 Class D — STRUCTURAL: the same knowledge existed and did not travel

| Incident | Detail |
|---|---|
| A replay-authorization guard | **Independently invented four times** in four migrations by four authors, never generalised. A fifth site had no accidental survivor and was exploitable. |
| A timestamp-precision idiom | Applied **correctly at 3 sites, missed at 8.** |
| An exact-microsecond edge-case requirement | **Named in an acceptance matrix**, never generalised to the sites that needed it. |
| A `set role` / `reset role` balance rule | **Learned in one migration**, repeated 18 migrations later, and both times found by the runner rather than by any test. |
| Absent-vs-null handling | **Written down in a comment that names the exact trap** — and the same trap was hit **twelve files away in the same landing.** One author wrote the hazard down and avoided it; another hit it. **Neither author was careless.** |
| An item held in two contradictory states | Recorded as a *permanent gap* upward and *live scope* downward. **Neither reader saw both halves, so there was nobody for whom the contradiction was visible.** Structural cause: every status had two audiences by construction. |

**This class is the user's thesis, stated as evidence: the knowledge was in the tree and did not reach the
work.**

### 3.5 Class E — INSTRUMENT: the measuring apparatus reported on something else

Grouped because they share one shape: **a condition satisfiable by something other than the thing it is
checking for.**

- **A typecheck that checked no test file**, so every "typecheck green" claim in every packet was overstated
  as to tests for the program's entire life.
- **A test runner invoked from the repo root resolved outside the repository** and reported "no tests found"
  for every file — a worker could bank a *red* that was really *wrong tool found nothing*.
- **A lint that fires on everything passes its mutation test exactly as well as a correct one.** A mutation
  test proves a detector *responds*; it never proves it *discriminates*. **Every detector needs a negative
  control — green on known-good — not only red on known-bad.**
- **An exactly-once pagination assertion walked over a proven-defective site and reported green**, because
  the defect only manifests when two rows share a millisecond *and* straddle a page boundary. Sequential
  fixtures report clean green across every defective site.
- **A synchronization barrier satisfiable by unrelated activity elsewhere on the host** — could not produce
  a false green of the security property, *could* produce a false claim of concurrency coverage.
- **A role check written against the wrong identity function** would have passed **in exactly the case it
  existed to catch** (one function reflects an assumed role; the other survives role assumption).
- **A green measured against a stale build artifact.** Two waves reasoned for two cycles about a code path
  that was not in the binary under test. **A measurement of a built artifact is not a measurement of the
  source, and nothing in a successful exit distinguishes them.**
- **A digest recipe that was cwd-dependent** — the same byte-identical files produced four different digests
  depending on the directory it ran from. A third party reproducing the number **confirmed determinism, not
  correctness.**

### 3.6 Class F — PROSE: the unsolved one, named by a worker

> **A restatement has no owner — the original moves and the copy does not, and NOTHING IN THE COPY RECORDS
> WHAT IT WAS COPIED FROM. Probe-red discipline protects assertions; it does nothing for prose. Tests have
> probe-reds; PROSE HAS NOTHING THAT GOES RED.**

Three instances crossed one worker's desk in a day and **all three were true when written.**

**The user's observation is that this describes a missing edge.** The graph already ships a `copy_of` edge
type (`db/migrations/001_core_graph.sql`) — **it is not used for this.**

The only partial countermeasure the program actually demonstrated: **every correction that landed came from
someone reading a source, and the restatements that survived challenge were the ones carrying a
`file:line`.** A cited restatement is not self-checking, but it is *checkable in seconds*; one carrying only
the claim is not checkable at all without reconstructing where it came from. **Strictly less than what tests
get, strictly more than what prose had.**

---

## 4. Rules that program adopted empirically — treat as findings, not opinions

Each cost a real defect. **Your design should either satisfy these or explain why it supersedes them.**

- **AN ANNOUNCEMENT IS EVIDENCE, NOT AUTHORITY. THE TREE IS THE AUTHORITY.** Announce to *trigger* a
  re-measurement, never to *supply* a value.
- **AN INSTRUCTION IS EVIDENCE, NOT AUTHORITY. THE SCHEMA IS THE AUTHORITY.** *Grep finds the name you
  already thought of; introspection finds the shape.*
- **VERIFYING THE ARTIFACT IS NOT VERIFYING ITS DELIVERY.** The applier is a third thing, and nobody was
  testing it.
- **A RULE IS KNOWLEDGE THAT MUST TRANSFER TO THE WORK; A DETECTOR IS KNOWLEDGE COMPILED INTO SOMETHING
  THAT FIRES WHETHER OR NOT ANYONE READ IT.** *Operational form: when you learn something, don't write it
  down — wire it to something that fails.*
- **A caveat stored in a mutable identifier is deleted by a rename.**
- **An unresolved question should be PINNED BY A TEST, not described by a sentence.** (One gate did this
  well: it asserted the law *and* measured the open behaviour, so whichever answer was live could not drift
  silently.)
- **Comfortable results get MORE scrutiny, not less.** **Every** misattribution in the program ran in the
  reassuring direction, and each survived because nobody wanted to re-derive good news.
- **A claim that something is SAFE requires a named second reader.** Alarming findings attract scrutiny;
  reassuring ones do not.
- **Corroboration requires MECHANISM diversity, not author diversity.** Before banking agreement, ask
  *could these have disagreed, given how each was produced?*
- **DISAGREEMENT between independently-produced results is a DETECTOR** — and it exists only if the results
  were produced independently. *Independence enforced for integrity turns out to be independence enforced
  for detection, and the detection is the larger return.*
- **A red with a recorded reason beats a vacuous green.**
- **Archive a red before the fix that destroys it lands.** One suite could never have re-captured its own
  red after the fix it justified.
- **Weigh a finding by the filter that produced it, and demand that filter be published.** One verification
  seat closed with **seven confirmed findings against ten self-caught false reds** — that denominator is why
  all seven were acted on without re-derivation.
- **THE ARTIFACTS TRANSFER AND THE SKEPTICISM DOES NOT.** *The next reader inherits conclusions with more
  authority than the people who wrote them held them with* — theirs came with arguments attached and someone
  available to disagree; yours arrives as a document. **Every figure that fell fell while sitting in a
  document, looking settled.**

---

## 5. The user's design points from the conversation

Recorded as stated, separated from the briefer's additions:

- Staleness exists **so that context does not rot.**
- Invalidation is **agentic** — an agent that finds a thing stale marks it. Automatic where derivable.
- **"Hence the next agents inherit the graph"** — the graph, not a document, is the transfer medium.
- **"At least so that agents have that capability"** — capability first; full automation is not the bar.
- Memory, worktree, and staleness are **one foundation problem**, not three features.
- The problem is keeping memory **updated and correct**, not merely stored.

---

## 6. Briefer's sketches — LOW CONFIDENCE, discard freely

Offered only so you know what has already been considered. **None of this is decided.**

- **Three states, not one boolean**, because the evidence has three shapes: superseded / expired /
  mis-scoped. Class C needs a different primitive from A and B.
- **A fact node might carry what produced it, not just what it says** — `mechanism`,
  `supports`, `does_not_support`, `measured_against`. The `does_not_support` field is the only sketched idea
  that addresses Class C at all: *every Class C error was a true value with a false neighbour, and the
  neighbour lived in prose beside it.*
- **State rather than boolean**: `current | suspect | superseded | expired | withdrawn`, with who, why, and
  against what evidence. The program had a claim correctly marked *unproven* for two hours that then
  **upgraded on measurement** — a boolean cannot express "unverified right now."
- **An asymmetry, derived from the fact that every misattribution ran reassuring:** marking something
  suspect should be **cheap** (one agent, evidence attached); marking it **current again** should be
  **expensive** (fresh measurement plus a named second reader). Wrongly suspecting a good fact costs a
  re-measurement; wrongly clearing a bad one costs everything downstream.
- **Reads must surface suspicion inline, or this is just another record.** A flag nobody reads is precisely
  the stale risk note that misled three coordinators. Whether a suspect fact should *block* a read or merely
  annotate it is **an open question** — blocking is the only version that reliably works and the only one
  annoying enough to get switched off.
- **Probably no TTL.** Noise trains agents to dismiss flags, which is worse than no flag. Expiry via
  dependency change or explicit action only.
- **Existing primitives to consider before adding any:** `depends_on`, `copy_of`, `contains` are shipped
  edge types; entities already carry versions; a command ledger already records what ran.

---

## 7. Hard constraints

- **The contract catalog is FROZEN** at 101 rows with a published digest. **A new operation costs a dossier
  amendment plus a fresh narrow gate review.** Strongly prefer a design that adds **zero catalog rows** —
  fields, existing edge types, and projection changes. If your design genuinely requires a new operation,
  say so explicitly and justify it; do not smuggle it.
- **Read-path changes are delicate.** The program found a viewer-relative field frozen into a
  byte-identical replay snapshot — per-viewer computation and byte-identical replay are contradictory.
  Anything you add to a projection must be checked against that.
- **W5 was cancelled and both waves are closed.** There is no verification wave. This is **W6/Phase-2**
  design work.
- **Never run git.**

---

## 8. What to deliver

A design document at `docs/features/memory/MEMORY-AND-STALENESS-DESIGN.md`:

1. **Your taxonomy of staleness**, with §3's incidents mapped onto it. If §3.1–3.6 is the wrong cut, say so
   and re-cut it — that is a real contribution, not a detour.
2. **The primitive set**, with an explicit answer on each: is staleness a property of an *entity* or of a
   *claim about* an entity? Is memory a kind, a projection, or an edge? What is a worktree's relationship to
   memory — and **is it actually part of this problem, or did it get bundled in?** Answer that honestly.
3. **How Class C is addressed**, specifically. If your answer is "it cannot be", say that plainly and
   explain what partial coverage is available — an honest boundary is worth more than an optimistic
   mechanism.
4. **What FIRES**, not just what is recorded. Cite the rule in §4 that makes this the crux.
5. **A sequencing plan** with the frozen-catalog constraint respected, and each phase's cheapest useful
   increment named.
6. **The open questions you could not close**, with what would close each.

**State your own limits inline, beside the claims they qualify** — §4's last rule is about documents exactly
like the one you are about to write, and this brief is not exempt either.
