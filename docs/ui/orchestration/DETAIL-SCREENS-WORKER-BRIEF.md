# DETAIL-SCREENS WORKER BRIEF — the remaining T0-4 entity detail archetypes

**status-as-of:** `26bd036` · Author: fe-coordinator (`sess_1785177979583_6diu9i7j1`) · 2026-07-29

You are building the remaining entity detail screens in `packages/tm8-ui`, one at a time, to the exact fidelity of the screens the user has already accepted. The outer shell, the panel chrome, the stacking, the theme system — all of it exists and works. Your job is the INTERIOR of each detail archetype, and your constraint is that every law below was paid for tonight with a real defect. USER-STATED INTENT, verbatim scope: "the same exact design … other entities details also to be implemented, with the learnings of this design, the specifics, and the not to do mistakes."

## 0. Read these before writing anything

1. This file, whole.
2. `packages/tm8-ui/DECISIONS.md` — the ledger, D1–D62. Binding. If a choice you face is ruled there, the ruling wins; if you think a ruling is wrong, say so to the coordinator — never silently deviate.
3. `packages/tm8-ui/PARITY-LEDGER.md` — how a parity record is kept (note its `status-as-of:` convention; yours will use it too).
4. The oracle: `T0-1 workspace structure review (1)/T0-4 Entity Detail Panels Hi-Fi.dc.html` (repo root — note the ` (1)` directory). Cross-read `T0-2 T0-5 Terminal & Live Session Hi-Fi.dc.html` where a session surface is referenced, and `T5-5 T5-6 Launch & Authoring Flows Hi-Fi.dc.html` ONLY for launch-flow surfaces. Never diff a surface against the wrong canvas — the sheet-commit-button lesson: a surface answers to ITS OWN oracle file, and checking it against a neighbor's is how drift gets ruled in.
5. The built precedents, as CODE: `src/panels/EntityDetailPanel.tsx`, `src/panels/detail/`, `src/panels/bodies/TerminalBody.tsx`, `src/domain/registry.ts`. The task and work_session details are the two accepted archetypes — your screens sit beside them, same idioms, same registry shape.

## 1. Scope

- Enumerate the archetypes the T0-4 oracle actually draws (expect: doc, channel/board, teammate, member, project, collection, custom kind `c:ritual`, message-anchored surfaces — but ENUMERATE from the oracle, do not trust this list; report the enumeration to the coordinator as your first deliverable, with the order you propose).
- Build ONE screen at a time. A screen is DONE when §4's whole checklist passes. Report it done (§5) and wait for the coordinator's ack before starting the next — the ack is usually fast, and the ceremony/captures happen per-screen so the user reviews incrementally.
- Fixtures: if a kind lacks fixture entities rich enough to exercise the screen (empty states, full states, refusal states), extend `src/fixtures/` (yours to edit) — NEVER `src/data/` (see §3).

## 2. Design laws (each one bought with a defect)

1. **Values are EXTRACTED from the oracle's inline styles, never eyeballed.** Every color, size, radius, padding you introduce cites its oracle line in a comment. The ink-chip fix shipped with the oracle's exact bytes (`#23201B`/`#F4F2EC`/r7/4px 10px/12px 600); the eyeballed version would have been close and wrong.
2. **Colors are tokens, and the package guard is armed.** `src/hex-ban.test.ts` fails the build on any raw hex outside the two legal homes (`styles/tokens.css`, `styles/canvas-extra.css`). A NEW canvas-measured color goes into `canvas-extra.css` as a `--pn-x-*` custom property, with the comment stating MEASURED (oracle line cited) or DERIVED (formula + why). Its first find was a real defect: a hand-typed hex one digit off a real token, rendering one imperceptible shade wrong. Do not fight the guard; it is younger than you and already right once.
3. **Micro type sizes are D5-verbatim.** The canvas-measured literals (8.5/9/9.5/10/10.5/11/11.5/12/12.5px family) stay as-is in source. Global scale is handled by ONE lever (`zoom: 1.1` on `.cv2-root`, user-ruled). If letters look small, the answer is never a per-element bump — that destroys canvas-diff comparability and violates D5.
4. **The hairline rule (D-ledgered, decidable):** `--pn-line` BOUNDS a component (panel headers, action bars, tab strips, chips, cards); `--pn-x-hairline-soft` SEPARATES repeated siblings inside one (list rows, field rows, activity rows). The oracle's own dark pairing derives the dark value from `--pn-hover`. When unsure, ask which side of the boundary the divider sits on — the rule predicts cases its author didn't reason about, which is what makes it a rule.
5. **Registry-driven, no kind literals.** `panels/no-branching.test.ts` fails the build on `kind ===` in panel code. A detail interior is registry DATA (blocks, sections, rowActions, badges) rendered by ONE component. "Tasks" and "Sessions" look completely different and are the same code path — keep it that way for every new archetype.
6. **Deferred = disabled-with-reason (charter R7).** Any control whose action isn't wired yet renders disabled with `{cause, remedy}` — never hidden, and NEVER a live control that silently does nothing. The R5 finding "I click run and nothing happens" turned out to be five dead verbs, a class, not an instance. If a dispatch is optional in the type, the component must throw or disable — the silent-optional-dispatch mechanism was ripped out and must not return.
7. **Two-source honesty.** A liveness VERDICT outranks a stored record at every consumer; liveness comes EXCLUSIVELY from `seam.liveness.statusOf` — never derived in a panel. A screen that says "1 live" above a row saying "not running" is the defect artifact preserved in gate-evidence; look at it once.
8. **Dark theme is free if you use tokens.** Ink/paper invert; always-dark regions (terminal family) open a nested dark scope rather than restating hexes. If you write a per-theme override for a new surface, you have probably mis-tokenized it.
9. **Empty states never tax the primary surface.** The terminal-dominant ruling generalizes: a collapsed one-line summary carrying its facts (including honest absences, styled quieter — an absence is stated, not shouted) beats an expanded empty section stealing height.

## 3. Boundaries (hard, all of them someone else's lane)

- `src/data/**` — bridge lane, seat CLOSED by the user. READ-ONLY, no exceptions. If a screen needs a seam capability that doesn't exist, STOP and report; the coordinator brokers it.
- `src/terminal/**` and `src/terminal-dev.tsx` — Track P's. Read to learn, cite, never edit.
- `packages/server`, `packages/contract`, `packages/cli`, `db/` — off-limits (reading contract for types is fine).
- `src/styles/tokens.css` — byte-guarded by the twin at `test-references/tokens.reference.css`; changes only via coordinator ruling, value+twin+guard in one commit.
- `packages/tm8-ui/DECISIONS.md` — coordinator-committed. You AUTHOR D-entries (send the text); you never stage the file. The pre-commit grep control fails loud on it, and it has caught a seat once already.
- **You never run `git add` or `git commit`.** Handover is §5; the coordinator holds the seat under R17.

## 4. Definition of done, per screen (the not-to-do list, distilled from tonight's misses)

1. **Fires-red-first.** New tests run against the absent/broken state before the fix; record the red. A green that was never red is a claim, not a measurement. (When the fix is already in your tree, RESTORE the broken state to make the red — the rowsFor precedent.)
2. **The wide check is part of done.** After every change: `cd packages/tm8-ui && bunx vitest run --exclude 'src/terminal/**'` AND `bunx tsc --noEmit`. The narrow check that proves YOUR change is not the check that proves it's SAFE — four seats including the coordinator paid for this in one night. **From `packages/tm8-ui`, never the repo root** — root `bunx` resolves vitest 2.x against this v4 tree and every file dies at collect with a phantom `TypeError … reading 'config'`. The banner's trailing path (`RUN v4.1.10 …/packages/tm8-ui`) is the control.
3. **Where you cross a seam, one test lives in the gap.** Declaration → data → implementation → CALL: four links can each verify green while the feature is dead because nobody asserted the caller passes the argument (four sessions rendered as twelve, through four green suites). If your screen reads through a shell hook, assert the real hook delivers what your panel consumes.
4. **The screen is verified by LOOKING at it** — real browser, `:4612`, BOTH themes, hard reload first. jsdom cannot see layout: a percentage max-height that silently never resolves, a clipped label, an off-screen section all pass "the element exists". Every defect that reached HEAD tonight was found by rendering the thing; none by a suite. Request captures through the coordinator (the capture seat protocol has hash discipline you don't need to replicate — just flag "ready for capture").
5. **State reports carry timestamp + scope + instrument.** "716 passed" means nothing without when, what was excluded, and which runner from which directory. Three seats mis-stated the tree in twenty minutes with honest, correct, unreconcilable numbers.
6. **Status prose uses `status-as-of: <sha>` stamps, never tense.** A status section describes the world, and the world moves without touching the file — the parity ledger rotted inside the very commit that carried it. A sha stays true forever and can only become incomplete, which a reader can see.
7. **A ruling that creates a file names the controls that will see it.** New CSS file? The hex guard scans it. New test file? Check the include globs and environment (jsdom needs its localStorage story — the stub in `realSeamFlag.test.ts` is LOAD-BEARING, docblock explains; copy its pattern, do not retire it). New non-source artifact? It goes OUTSIDE `src/`.
8. **A mechanism you already know is not evidence about the case in front of you.** When a symptom names a subsystem, search your own logs for that subsystem's name before reaching for a familiar diagnosis — the correct suspect was on-screen in two seats' transcripts while an articulate wrong theory won. And retiring a workaround IS the verification of its fix, never a tidy-up.
9. **Comments state constraints, not predictions.** "Never shipped" written in the voice of a measurement closed a question wrongly for hours. If you haven't measured it, the comment says so.

## 5. Handover, per screen

Send to the coordinator (`maestro session prompt sess_1785177979583_6diu9i7j1 --message "…"` — or the no-shell send if your message carries backticks/quotes: write the message to a file and use `python3 ~/.tm8-fleet/send.py sess_1785177979583_6diu9i7j1 <file>`):

- Screen name + oracle region it implements; divergences found, each labeled RULED (cite the D-entry) or DRIFT (with oracle value, built value, file:line).
- File list + diffstat (your files only; note anything dirty in the tree that is NOT yours rather than assuming the coordinator knows).
- Red-first record (the failing output, then the passing), wide-check results with timestamp+scope+instrument, and "ready for capture".
- Any D-entry texts you are authoring (registry additions, new tokens, rulings you had to make — flag rulings you made alone so the coordinator can ratify or reverse them).
- Anything you did NOT check, said plainly. A NOT-CHECKED section is worth more than a confident silence — the appetite selects for unwitnessed work, and the only defense is witnessing it yourself, out loud.

Report progress on your task (`maestro task report progress <taskId> "…"`) as you go; report blocked the moment you are, with what you tried.

## 6. Sequencing

First deliverable (before any code): the archetype enumeration from the T0-4 oracle + proposed build order + for each screen a one-line note on what fixture gaps you foresee. The coordinator confirms the order; then screen 1 begins.
