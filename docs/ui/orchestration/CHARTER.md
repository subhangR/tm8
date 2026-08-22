# tm8-ui Program Charter

Shared law for the three coordinators building tm8's new UI. Read this fully before your own brief. The master coordinator (the user's primary session) spawned you; report to it and to your maestro task.

## What is being built

tm8 is a collaboration workspace shared by humans and AI agents, built on an entity graph, with real agent execution (server-side PTY sessions). The backend is DONE (W4): `packages/contract` is THE LAW (101 catalog rows / 99 v1 operations / 2 reserved — FE-measured 2026-07-28, D11; supersedes the W5-relayed 98/3 split), `packages/server` (node, :4610) owns Postgres+RLS storage, a transactional-outbox event log (`workspace_events`, per-space `seq`), a WS broadcast path (`/v2/ws`, subscribe/resume-by-seq) and `events.poll` fallback. The OLD UI (`packages/ui`, dev :4611) is the retired design — it runs as a behavioral oracle and is **READ-ONLY for this program**.

The new UI is built from an approved design suite in **`packages/tm8-ui`** (new package). Design ground truth: `/Users/subhang/Desktop/Projects/tm8/docs/design-canvases/2026-07-28-round-2/` — 18 `.dc.html` canvases (open beside `support.js` in a browser; Round 1: T0-1…T10, Round 2: T3-3, T5-1, T5-2, T5-3, T5-5/T5-6, T5-7) plus the binding requirements package at `uploads/tm8-ui-design/` in that folder: `01-REQUIREMENTS-AND-BRIEF.md` (constraints C1–C9), `02-LAYOUT-SPEC.md`, `03-DESIGN-LANGUAGE.md` (ATELIER), `05-DESIGN-SYSTEM/tokens.css` (ground truth, use verbatim), `08-SPECS/WORKSPACE-LAYOUT-AND-TERMINOLOGY.md` (v2.11, THE governing spec) and `08-SPECS/TM8-UI-SPEC-FINAL.md` (engineering spec: component tree, state ownership, harvest/condemn lists). The Round-2 request rationale: `/Users/subhang/Desktop/Projects/tm8/docs/design-canvases/2026-07-27-round-1/DESIGN-REQUESTS-ROUND-2.md`.

## Rulings ledger (user-issued; do not relitigate)

- **R1** New package `packages/tm8-ui`; old `packages/ui` untouched, kept as oracle until parity.
- **R2** Data layer is **WS-first** (subscribe/resume-by-seq) with `events.poll` as catch-up/fallback.
- **R3** Server deltas are **minimal**: (a) generic mapper passthrough arm for RPC-authored events, (b) a session-liveness read, (c) real WS/events end-to-end tests. Nothing else server-side without master approval.
- **R4** Contract amendments are **ADDITIVE ONLY**: new ops/shapes/fields allowed, existing APIs never change. Nothing breaks.
- **R5** Gating: the FE LLD is gated by a spawned Fable-5 adversarial reviewer. **THE GATE** for the whole group: the complete T0-1 master screen — the entire browser screen (tab bar, menu rail, both list panels, ink-stage center with live-session bar, panel stack, session panel with terminal chrome), interactive, light+dark, on fixtures — pauses for USER review before screens fan out. Milestone screenshots go to the master throughout.
- **R6** Git: everyone on `main`, strict path ownership (below), small frequent commits.
- **R7** Deferred (render disabled-with-reason, never hidden, never built): graph canvas, undo/version-history/handoff-withdraw, leaderboard/awards, saved-views/axes control, search results view.
- **R8** NEEDS YOU and presence: designed-but-dormant. UI states exist; no server detection in this program.
- **R9** Terminal is a **verbatim transplant** — transport stack (`ptyTransport`, `visibilityDriver`, `writeScheduler`, vendored pty-protocol) and byte-handling are a black box. Layout/mounting may adapt; byte handling may not. The chrome strip follows the T0-2 canvas.
- **R10** Phase-2 (seams reserved, not built): session `Terminal|Chat` switch (toolbar seam stays), server rail (build the rail per design, wire ONLY the local server).
- **R11** Design ambiguity: FE coordinator decides within ATELIER + the governing spec, logs every call in `packages/tm8-ui/DECISIONS.md`; user reviews the ledger at the gate. No mid-run user pings.
- **R12** Parallelism: each coordinator runs 2–4 workers at peak, dependency-sequenced.
- **R16** Model policy (user, 2026-07-28): coordinators are Fable 5 (`claude-fable-5`); ALL worker spawns from this ruling forward use Opus 5 (`claude-opus-5`, agent-tool claude-code). Applies to new spawns only — live seats and Jul-30 resumers keep their existing model.
- **R17** The shared-index rule (bridge/FE incident, 2026-07-28, post-baseline): **staging-by-enumeration protects your ADD, not your COMMIT** — `git commit` commits the whole index, and the index is shared by every lane in the worktree; two enumerated lanes racing produced cross-contamination in BOTH directions (one commit swept the other's staged files; the index-only correction then destroyed the other's in-flight staging, firing an empty commit). Binding protocol: **one seat in the worktree's git at a time**, via LOCK/RELEASE announcements between the three coordinators (master arbitrates contention only); `git diff --cached --name-status` read immediately BEFORE every commit (the index is the truth, your enumeration is the intent — diff them); `git show --name-only` audit immediately AFTER; a correction commit is itself a commit and takes the lock. **Refinement (FE, corpus-recorded): for CONTENT commits use the pathspec form — `git commit -- <paths>` — which is structurally immune to index pre-population (how 55d7471 survived a live race); plain-commit-with-pre-diff is for INDEX-state commits (corrections) only. Each form is blind to what the other commits: pick by which state you mean to commit, never by habit.**
  **Contention protocol (bridge + FE, composed after the first live crossed-claim, all three behaviors exercised organically before being written):** (1) PREVENTION — a lock claim is not HELD until both other coordinators ACK it (claim-ack, the same discipline as every safety signal); (2) SETTLEMENT — a claim that still crosses resolves by which claim the THIRD coordinator received first (a two-party crossing is invisible to its own parties; the third seat is the natural arbiter); (3) PROTECTION — never countermand a GO already issued to a possibly-staging seat; let the bounded window complete and resequence at its RELEASE. During any contention check, HOLDS replace commits — no lane touches the index while a claim is unresolved.
  **Amendment (FE, after the protocol's first real failure; SO co-sign): a settlement ACKed by both claimants is FINAL.** Later cessions — however well-meant — do not reopen it; an order CHANGE requires the same claim-ack ceremony as a claim. *Politeness is not a protocol move.* (Incident: a settled SO-first order re-opened by SO's user-latency cession; the crossing left both lanes believing self-first and two commits fired into an index holding eight staged sibling files — zero contamination, solely because the pathspec form held. The mechanical layer must never be the only one that holds.)
  **Amendment (bridge, from the same incident's diagnosis): per-pair counters cannot establish CROSS-PAIR causality — on this channel, order-critical exchanges are OPERATIVE only when all three seats have ACKed the same order text under one order-id.** Two-party convergence provably cannot survive reordering; a cession REVOCATION is itself a safety-critical signal requiring the same three-way ACK before either party acts.
  **Amendment (SO, its own accountability entry): only an OBJECTIVE rule ends an oscillation — substantive-fact arguments (latency, priority, courtesy) enter BEFORE settlement or not at all.** Post-settlement, the only moves are execute or full-ceremony change.

## Ownership map (hard boundaries)

| Coordinator | Owns (writes) | Never touches |
|---|---|---|
| fe-coordinator | `packages/tm8-ui/**` except `src/data/` and `src/terminal/` | `packages/server`, `packages/ui`, `packages/contract` |
| PTY Owner (Track P, autonomous, 2026-07-28) | `packages/tm8-ui/src/terminal/**` (works UNCOMMITTED until milestone landings; its in-flight tests may be red — exclude the dir from other lanes' suite globs and packaging until landed) | everything else in tm8-ui except a flag-gated host mount; frozen trees; git |
| Graph Designer (user-rescoped to build, 2026-07-29) | `packages/tm8-ui/src/graph/**` (uncommitted; FE ceremonies land it) | everything outside its carve-out — WorkspaceView/menu/fixtures touches go by broker through master → FE review + dual attribution; contract touches need master's R4 review; no git |
| bridge-coordinator | `packages/tm8-ui/src/data/**` + the seam types file(s) agreed with FE | server internals, UI components |
| server-owner | `packages/server`, `db/migrations`, `packages/contract` (additive), `packages/execution` (liveness seam only), `tools/conformance` | `packages/tm8-ui`, `packages/ui` |

## Environment facts

- Ports: tm8-server **4610** · old UI dev **4611** · **new tm8-ui dev server: 4612** · sidecar Postgres **5442**. Data dirs `~/.tm8/` (prod) `~/.tm8-dev/` (dev).
- Runtime split: `packages/server` + `packages/execution` run **node** (never bun); UI packages may use bun/vite.
- Verification is scoped per-package (`bun run typecheck`, `bun run test`); do not
  substitute a bare compiler command for the package gate. **Never run parallel vite
  builds.** `HOW-TO-TEST.md` at repo root is the test manual — follow it literally.
- STATE.md is historically stale; trust the tree, not STATE.md.

## Protocol

- Report milestones: `maestro task report progress <yourTaskId> "<message>"`; blocked/error likewise. Completion only when your track's gate deliverable is accepted.
- Cross-coordinator: `maestro session siblings` to find each other, `maestro session prompt <sessionId> --message "..."`. The Facade seam and any cross-boundary interface change require the affected coordinators' explicit consensus (message exchange recorded in your task progress).
- Workers: spawn via `maestro team-member create` (model `claude-fable-5`, agent-tool `claude-code`, mode worker) + `maestro task create` + `maestro session spawn --task <id> --team-member-id <tm>`. Give workers self-contained briefs (file paths, not summaries).
- Escalation: conflicts, scope questions, or anything touching another coordinator's ownership → message the master session (it will identify itself when it prompts you), do not improvise across boundaries.

## R13 — Message reliability (user-reported: session prompts are LOSSY)

`maestro session prompt` sometimes silently fails to submit — "sent" is not "delivered." Standing discipline for every seat:

- **ACK everything of consequence.** Any directive, ruling, hold, release, or report that changes what someone does requires an explicit ACK naming the item. No ACK = assume NOT delivered.
- **Resend on silence** after a reasonable interval, marked `RESEND:` and otherwise verbatim. Recipients treat duplicate RESENDs as no-ops (idempotent).
- **Number your stream per peer** (`[n]` counter per sender→recipient pair) so a gap is detectable by the receiver, not just the sender.
- **Safety-critical signals** (quiet calls, W5 window OPEN/CLOSE, GO-EDIT, baseline-landed) are never acted on as delivered until the ACK arrives — the sender keeps resending; the receiver never infers them from silence.
- **Durable state lives in files, not messages.** Anything a lost message would orphan (rulings, holds, scope) gets written to this charter or your task docs; peers re-read files when a stream gap is detected.
- **A shared file is not shared state until every reader has a reason to re-read it** (FE incident, 2026-07-28: a worker's direct append to DECISIONS.md was a silent cache invalidation — a sibling's held recitation went stale with no message lost anywhere). Discipline: the FILE is the record, messages about it are doorbells — writers announce every append to known readers; readers re-read at every audit point, stream gap, and phase transition. This applies to every durable doc in the program (DECISIONS.md, Track S standing-state, LLD files).
- **Durable is a property of the mount, not the intention** (2026-07-28: the machine REBOOTED at 11:04:12 — kern.boottime, measured by W5 — and macOS clears /private/tmp on reboot; every claude scratchpad was destroyed. The 11:13–11:38 timestamps first reported as "the wipe" were the CREATION times of freshly recreated replacement directories — the mtime of a replacement reports when it was built, not when the original died. Track S lost standing state, playbook, and GO-EDIT drafts; W5 lost both staged migrations, recovered byte-identical from ~/.claude transcripts ONLY because digests existed to match against. The maestro docs registry stores paths only, so every registration pointed at nothing). Discipline: session scratchpads are NOT durable storage. Program artifacts live on non-tmp mounts (in-repo docs, or `~/.tm8-<track>/`); anything registered by path gets its mount verified at registration; the failsafe itself is re-verified after every stall. The W5 evidence package lands on durable storage the moment it arrives, before anything else is done with it.

## R14 — Verified quiet (supersedes every "pause within a minute" phrasing)

A quiet state is MEASURED, never announced on a timer — announcing a quiesce is not being in one. When the master sends a QUIET CALL (for W5's landing window or any future gate):

1. **Stop everything, including what you already started.** A freeze covers in-flight work: abort running suites/installs/builds; dev servers are **STOPPED, not merely undriven** (a watcher does CPU work on every file event).
2. **Inventory your own processes** (`ps` — check for your node/vitest/vite/bun/tsc strays; remember the process table can echo your prompts' words — verify by PID behavior, not by name match alone) and **prove the kill left nothing**.
3. **Reply with a verified-quiet line in your own words**: what you stopped, what the inventory showed, when. The master relays program-wide all-quiet ONLY after holding every seat's line; W5 starts its gate only after holding the master's line. Taking four minutes is information, not a delay.

**A landing gate needs a pre-landing run of the same gate** (W5's lesson, paid in forensics at its own CLOSE, 2026-07-28: one red fell outside its enumerated expected-failure set and only direct causation evidence — a 17-hour-old mtime — averted a false revert). Without a pre-landing baseline, every pre-existing red is indistinguishable from a regression. Binding on Track S: every GO-EDIT delta runs its affected suites BEFORE the edit, and the baseline commit is preceded by the full re-verify it already plans.

Standing rule while a gate window is pending (now → W5's CLOSE): **start no long-running work you cannot abort in seconds without corruption.** Installs are the named worst case — permitted only if killable and cleanly re-runnable, and they get aborted before your quiet line, never raced against it.

## R15 — Instrument output discipline (adopted from W5's wrong-session-ID incident)

W5 sent every message to a nonexistent session for hours; the CLI 404'd loudly every time, but `>/dev/null 2>&1` discarded the diagnostics and its own echoed "sent" reported intent as outcome. Two rules, binding on every seat:

1. **Never suppress an instrument's error stream.** Not once, not for tidiness. A muted channel doesn't become quiet, it becomes unobservable — indistinguishable from where you sit. If output is noisy, FILTER it; never discard it. And **filtering is not safe merely because it is not discarding: filter by CONTENT, never by POSITION** — success lines print last, so positional filters (`tail -1`, `tail -2` — both retired, master's and W5's) keep exactly the reassuring line and drop exactly the diagnostic, indistinguishable from a healthy channel while blind to every failure. The honest instrument is the exit code (the maestro CLI exits nonzero on a bad target) or a content match for both success AND error patterns.
2. **An echoed success message is a fact about the echo.** Confirmation comes from the actual command's exit status or its own printed output — never from a line you wrote yourself after it.

Corollary (W5's re-offense, named by them): **two symptoms that look alike are not the same defect until the mechanism is established.** Attaching your unexplained symptom to a confirmed mechanism manufactures corroboration and suppresses the scrutiny that would find your real cause — the countermeasures can differ completely (ACKs fix loss; reading exit codes fixes muted 404s).
