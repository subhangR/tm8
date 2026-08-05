# HANDOVER - T0-4 SUBTREE ARCHETYPE BODY (task detail)

status-as-of: `756a9b0` (working tree, uncommitted) - worker sess_1785273194024_ov9xa9gjd, 2026-07-29 02:56 IST

FILE-OWNERSHIP NOTE: my brief granted exactly three files. THIS file is a fourth,
created on the coordinator's explicit user-ordered quiet-protocol instruction
("write your FULL handover to packages/tm8-ui/src/panels/bodies/HANDOVER-<YourBody>.md").
Flagged rather than assumed. It is a non-source artifact inside `src/`, which the
brief's rule 7 would normally place OUTSIDE `src/`; the path was named for me, so I
followed it. Neither package guard scans `.md` (both filter to .ts/.tsx/.css), so it
adds no control surface - verified by re-running both after writing it.



SCREEN + ORACLE REGION
SubtreeBody, the `subtree` archetype Content body. Oracle: "T0-1 workspace structure review (1)/T0-4 Entity Detail Panels Hi-Fi.dc.html".
  - anatomy frame Z3 task panel, L59-L76 (grid L60-L64, SUBTREE eyebrow+rows L67-L71, RUNS eyebrow+card L74-L75)
  - 12-kinds TASK card, L162-L181 (grid L163-L167, description L168, ACCEPTANCE L170-L177, combined SUBTREE/RUNS L179-L180)
  - Z4 SUBTREE map, L950-L975 (the "+ add child..." row L955, LINKED chips L1016-L1020)
Cross-read for the LINKED chip bytes: L605-L607 and L648-L652 (same chip markup on other kinds).

DIVERGENCES - RULED (each cites its authority)
R1. REGION ORDER = grid -> description -> SUBTREE -> RUNS -> LINKED, per D48.1's enumeration. The oracle disagrees with ITSELF: the anatomy frame draws the description ABOVE the grid (L59), the 12-kinds task card draws it BELOW (L163 then L168). The ledger order wins rather than a coin toss. SubtreeBody.tsx:14-17.
R2. ACCEPTANCE region EXCLUDED (oracle L170-L177). D30 + D48.2 - T0-4-only depth, A2. Not silently absent: this body renders `notice` blocks, and I am proposing the registry text below so the panel says it out loud.

    R2 IS REVERSED, 2026-08-05, by D73 (PR #16). Left above verbatim rather than
    edited, because the reason it fell is the reason it should stay readable. The
    ACCEPTANCE region IS drawn. The clause "not silently absent" rested on the
    `notice` block PROPOSED at item 1 of "D-ENTRY / REGISTRY TEXT I AM PROPOSING"
    below - and that proposal was never taken up. `src/domain/registry.ts`'s task
    row declares no `panel.blocks` at all, so the `notices` filter in this body has
    always been empty and the panel never said anything out loud. The deferral was
    invisible, not disclosed, for as long as it stood. D73 carries the full ruling
    and the three consequences that came with it (the collection/`overwrite()`
    hazard, the corrected concurrency rationale, and the `doneBy`/`doneAt` owner).
R3. Run-row trailing word is the REGISTRY's liveTreatment label ("running", "stale"), not the oracle's literal "live" (L75, L180). domain/types.ts LiveTreatment.label states it verbatim: "`live` is the live-session BAR's count word, never a row's" (D22). SubtreeBody.tsx:376-382.
R4. Run-row dot is SOLID; the oracle draws animation:pnPulse 1.6s (L75). LiveTreatment.dot is 'solid' and pulse belongs to the sec-9.2 activity signal gated on a live verdict (F1, D6). This body is handed no activity source, so an animated dot would present a second fact nobody measured. SubtreeBody.tsx:358-366 + subtree-body.css run-dot block.
R5. RUNS eyebrow reads "RUNS - N - LIVENESS UNVERIFIED" when no verdicts were supplied, never "0 LIVE". Brief 2.7 + the hollow-value law: 0 claims a measurement nobody took. With verdicts it reads "RUNS - N - k LIVE" exactly as the oracle (L74). SubtreeBody.tsx:325-337.
R6. No rule between body regions. Reusing .pn-section would have added a --pn-line bottom border the oracle does not draw; the oracle's separation is the 12px .pn-body gap (L59). Hairline rule (brief 2.4) applied as: subtree ROWS separate on --pn-x-hairline-soft (oracle #F0EDE4, L69), the run CARD is bounded by --pn-line (oracle #E7E3D9, L75). subtree-body.css:16-22, :27-35.

DIVERGENCES - DRIFT (my rulings, made alone; ratify or reverse)
D-1. Priority tag renders the full uppercased value (URGENT / MEDIUM); the oracle draws "MED" (L62, L165). An abbreviation is a WORD and D22 puts words in the registry - inventing one in a render path is how two surfaces come to disagree. Proposed fix below. SubtreeBody.tsx:151-159.
D-2. Run-row meta omits the recency the oracle draws ("running - 2m - claude-sonnet", L75); built meta is the model only. There is no shared relative-time formatter in the panel lane, and graph/GraphView.tsx:82 has a private `timeAgo` that is not exported. I did not add a second one. Recommend exporting one - your call.
D-3. Avatars are 15px; the oracle's run-row avatar is 17px (L75 width:17px;height:17px). kit/Avatar's size union is 15|20|22|32 (the canvas-measured set) and I do not own the kit, so I took the nearest smaller rather than widening someone else's type.
D-4. "+ add child..." IS rendered even though T0-4's Z3 task frames do NOT draw it (only the Z4 map does, L955). D48.1 rules it gate anatomy off T0-1's Z3, so I built it - disabled-with-reason (R7) whenever no onAddChild dispatch is passed or capabilities.canAddChild is false. If you read D48.1 as Z4/T0-1-only, delete SubtreeBody.tsx:264-277; it is self-contained.
D-5. STATUS_FIELD (StatusSource -> EntityState member) is duplicated VERBATIM from detail/chrome.tsx:194-201, which does not export it and which I may not edit. Two copies of one mapping can drift. Proposed fix below. SubtreeBody.tsx:428-437.

FILES (mine only; all three NEW)
  NEW packages/tm8-ui/src/panels/bodies/SubtreeBody.tsx        516 +++
  NEW packages/tm8-ui/src/panels/bodies/subtree-body.css       282 +++
  NEW packages/tm8-ui/src/panels/bodies/SubtreeBody.test.tsx   252 +++
  3 files changed, 1050 insertions(+), 0 deletions. Nothing outside this list was touched. No git add, no git commit.

NOT MINE, DIRTY IN THE TREE at 02:56 IST - stated so you do not read the wide number as mine: four sibling bodies are being written into the SAME directory concurrently - HubBody.tsx/.test.tsx/hub-body.css, ReaderBody.*, ProfileBody.*, SessionAnatomy.*. ProfileBody.test.tsx is RED (13 tests) against a 658-byte ProfileBody.tsx, i.e. that seat is mid-write.

RED-FIRST RECORD (measured, not claimed)
1. Absent-module red, 02:51:32 IST: "Error: Failed to resolve import ./SubtreeBody from src/panels/bodies/SubtreeBody.test.tsx. Does the file exist?" -> Test Files 1 failed (1), Tests: no tests.
2. Green after the component landed, 02:54:58 IST: Tests 19 passed (19).
3. RESTORED-BROKEN red (the rowsFor precedent) - I put the two-source defect BACK to prove the assertions bite. Patch: RunRow derives the verdict from the record (state.status === 'running' ? 'live' : 'not-running') and the eyebrow always prints "k LIVE".
     x shows the VERDICT word over a record that claims otherwise
         AssertionError: expected 'Sscout - fixture sweepclaude-sonnet-5running' to contain 'stale'
     x counts LIVE from the verdicts, and says UNVERIFIED rather than 0 when none were supplied
         AssertionError: expected 'RUNS - 1 - 0 LIVE...' to match /UNVERIFIED/i
     x leaves the row verdict HOLLOW when no verdict reached it
     Tests 3 failed | 16 passed (19)
   Reverted from a byte copy; re-run 19 passed (19).

WIDE CHECK
  timestamp   2026-07-29 02:55:39 - 02:56:28 IST
  scope       packages/tm8-ui, --exclude 'src/terminal/**'
  instrument  bunx vitest, banner "RUN v4.1.10 /Users/subhang/Desktop/Projects/tm8/packages/tm8-ui", run FROM packages/tm8-ui
  result      Test Files 1 failed | 41 passed (42);  Tests 13 failed | 792 passed (805)
              ALL 13 failures are src/panels/bodies/ProfileBody.test.tsx - the sibling seat's in-flight file. My three files: 19/19 green.
  typecheck   bunx tsc --noEmit -> exit 0, zero output, 02:56:19 IST
  guards      src/hex-ban.test.ts + src/panels/no-branching.test.ts -> 10 passed (10), 02:56:28 IST. Both scan my new files (bodies/ is under panels/; subtree-body.css is a package .css). Zero raw hex in my css; zero kind literals in my tsx.
  INSTRUMENT NOTE: my first attempt ran with the shell cwd left in the oracle folder and printed "RUN v1.6.1 .../T0-1 workspace structure review (1)" + "No test files found". Exactly D62's fourth axis. Every number above is from the v4.1.10 banner.

INTEGRATION NOTE (your wiring; my three files need no edit)
- Component: `SubtreeBody`, named export, packages/tm8-ui/src/panels/bodies/SubtreeBody.tsx. The CSS is imported BY the tsx, so main.tsx needs no new line.
- Switch, beside the terminal arm in EntityDetailPanel.tsx PanelBody:
    if (config.panel.archetype === 'subtree') {
      return <SubtreeBody detail={detail} blocks={config.panel.blocks} livenessOf={...} onOpenEntity={onOpenEntity} />;
    }
- Registry: the task row's panel.archetype is ALREADY 'subtree' (registry.ts:297). No registry change is required to light this up.
- PROPS I CONSUME: detail (state scalars, content.description|body, hierarchy.parent, hierarchy.children.items/.total, connections.outgoing/.incoming edges, capabilities.canAddChild, id, title-of-peers), blocks (NOTICE ONLY - see below), livenessOf, onOpenEntity, onAddChild.
- PROPS I DO NOT CONSUME: every other member of EntityDetailPanelProps.
- BLOCKS: this archetype is NOT block-composed - its regions come from the entity's own structure. It renders exactly one block kind, `notice`. The task row currently declares NO blocks, which is correct. A test in the gap asserts that every subtree-archetype registry row declares only `notice` blocks, so adding a `fields` block to the task row turns the suite red instead of the region silently vanishing.
- livenessOf: (sessionId: string) => SessionLiveness | undefined. The panel today holds ONE `liveness` for the entity itself; a task's RUNS rows are OTHER entities, so a per-id lookup is needed. `undefined` means NOT MEASURED and renders hollow. Please do NOT pass `() => 'unknown'` to fill it - that is a verdict the seam did not give. If the shell has no per-session snapshot, pass nothing and the screen says "LIVENESS UNVERIFIED" honestly.
- onAddChild: absent => "+ add child..." renders disabled-with-reason (R7). Wire it when a dispatch exists.

D-ENTRY / REGISTRY TEXT I AM PROPOSING (I did not write DECISIONS.md - it is yours)
1. Acceptance-honesty notice on the task row, so D48.2's "ruled-not-missed" is on screen and not only in the ledger:
     blocks: [{ block: 'notice', params: { text: 'Acceptance criteria are not rendered in this panel yet - T0-4 draws them, the composed T0-1 canvas does not, and they land in A2 (D30, D48.2).' } }]
   This keeps the gap test green (it is a notice block).
2. Export STATUS_FIELD from panels/detail/chrome.tsx and delete my duplicate (D-5).
3. A shared relative-time formatter so the run row can carry the oracle's "2m" without creating a second source (D-2).
4. Registry-carried SHORT LABELS for priority so the tag reads MED per the oracle instead of MEDIUM (D-1).

FIXTURE NEEDS (I edited no fixture - src/fixtures/** is not mine)
1. There is NO EntityDetail for taskGuideLines - the oracle's own specimen task ("Session tree guide lines", T-114). fixtureDetails carries exactly ONE task detail, taskUuidTitle. The screen you will look at is therefore the UUID-title worst-case row, not the oracle's task.
2. NO task detail has CHILD TASKS. taskUuidTitle.hierarchy.children is [sessionStale] - a single work_session - so on the live screen SUBTREE renders its honest empty and RUNS renders one row. The SUBTREE region is exercised ONLY by locally-composed children in my test file. To see it at :4612 you need a task detail with 2-3 child TASK summaries, at least one carrying a closed workStatus.
3. NO task summary has workStatus 'done'. The only closed-status task is taskTombstone ('cancelled', deletedAt set), which my test uses as the struck-row specimen because it is the only one that exists. A plain `done` child would be the better fixture.
4. NO task has a LIVE session attached - sessionStale is the only session hanging off a task, so the green "1 LIVE" state cannot be seen on screen without a fixture attaching sessionLive to a task.
5. NO task has a PROJECT parent. taskUuidTitle's parent is channelDesign, so the grid cell reads "Channel # design" where the oracle reads "Project [glyph] tm8-ui". The cell is registry-labelled and behaving correctly; it simply cannot show the oracle's case with today's fixtures.

READY FOR CAPTURE once the switch is wired.

NOT CHECKED - said plainly
- I have NOT looked at this screen in a browser. It is unreachable until you wire the switch; per the brief my DoD is code + tests + handover and you and the user close the pixel loop.
- NO dark-theme check of any kind. Every colour is a token and my css has no per-theme override, so it should invert for free - that is an argument, not a measurement.
- NO narrow-width / 320px-floor check. The grid is a hard 2-column `1fr 1fr` per the oracle with no breakpoint; long assignee lists or a long parent title may crowd at the floor, and jsdom cannot see it.
- NO zoom/vh interaction check (D63.3).
- NO reduced-motion check. There is no animation in my css so there is nothing to reduce, but I did not render it to confirm.
- I did not confirm in a browser that `.sb-row:last-of-type` drops the last hairline correctly with the add-child control following the rows. The control is not an .sb-row so it should, but jsdom paints no borders.
- I did not experimentally establish that my files are innocent of the sibling ProfileBody red. My three files are imported by nothing but my own test - that is an argument from the import graph, not an experiment.
- I did not read every one of the 62 D-entries; I read D30, D41, D44, D47-D51, D56, D60-D63 and the D48 split in full, plus the brief whole.
