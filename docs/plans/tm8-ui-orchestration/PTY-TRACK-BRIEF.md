# Track P — PTY / Spawn / Terminal Owner (autonomous)

You are the PTY-track coordinator (Opus 5, user-ordered seat). You work ALONE: no check-ins, no chatter with other coordinators, no questions to the master unless you are truly blocked. You report exactly twice (milestones below) plus hard blockers. Everything you need is in this brief; where it isn't, measure the tree — do not ask.

## Mission

Make the session-spawn flow REAL in the new UI (`packages/tm8-ui`, served at http://localhost:4612): a launch configured in the UI spawns a real agent session with **correct team member, model, agent tool, prompts/manifest, project, and profile**; the session appears in the UI; its terminal **streams live** in the session panel; typing works; and session messages / prompts inject into the PTY. The gold standard for every PTY/streaming behavior is **maestro main** — it works beautifully; when tm8's ported code and maestro main disagree, **maestro main wins**.

## The two milestones (user-defined; report each, then continue/stop)

**MILESTONE 1 — configured spawn + live terminal.** Run/launch from the UI → real spawn with the full config honored → session visible in the workspace UI → live streaming xterm in the session panel → keyboard input reaches the PTY (and the exit-terminal chip works). Verify config fidelity by MEASUREMENT: read the spawned work_session entity fields, the composed manifest, and the child process env/argv — never assume. Report: `MILESTONE 1 READY — you can test:` + exact click-path steps.

**MILESTONE 2 — message/prompt injection.** The session-message path (`messages.post` → delivery saga → `pty.deliverPrompt`) lands text into the live PTY, honestly surfaced (delivery facets). This is maestro's `session prompt` equivalent; maestro main carries a RECENT FIX for session prompting — find it (`git -C /Users/subhang/Desktop/Projects/maestro/agent-maestro log --oneline -20` + the prompt-path files) and carry its behavior. Report: `MILESTONE 2 READY — you can test:` + steps.

Report channel: `maestro task report progress <yourTaskId> "..."` AND `maestro session prompt sess_1785169357925_9lxt5n0vs --message "MILESTONE N READY — ..."`.

## Test-spawn policy (user-ruled, exact)

1. Terminal bring-up: spawn **codex** sessions — no usage limit; abuse freely until spawn+streaming is rock-solid.
2. Once the terminal is confirmed working: switch to **claude-code with a Haiku model** (`claude-haiku-4-5`) for config-fidelity verification.
3. Full/expensive claude spawns: only as the final proof before a milestone report.
If codex isn't registered in tm8's agent-command config, register it in your lane (execution config is yours).

## Gold standard — maestro main (read before writing anything)

`/Users/subhang/Desktop/Projects/maestro/agent-maestro`, branch main:
- `maestro-ui/src/SessionTerminal.tsx` (1019 LOC) · `maestro-ui/src/platform/terminal.ts` (762) · `maestro-ui/src/services/terminalVisibilityDriver.ts`
- `maestro-server/src/application/services/PtyHostService.ts` (842) · `maestro-server/src/infrastructure/websocket/PtyWebSocketServer.ts` (339)
- `maestro-pty-protocol/src/index.ts`
Byte-handling laws (NEVER adapt, only port): `_received` raw-arrival offset snapped to `attached.next`; epoch compared by equality only; persistent per-session TextDecoder; fail-closed MAX_PENDING_BYTES 256KB / MAX_PENDING_ENTRIES 1024; flush-before-suspend; eviction = full teardown + offset-0 requestFullReplay on return. Layout/mounting may adapt; byte handling may not.
Known drift items tm8 must ADOPT from maestro main (documented in `T0-1 workspace structure review/uploads/tm8-ui-design/08-SPECS/TM8-UI-SPEC-FINAL.md` §0.1): (a) `cursorBlink: false` everywhere; (b) PTY-WS protocol-level heartbeat ping/pong to reap dead subscribers (tm8's port explicitly lacks it); (c) commit `0539726` legs — bounded broadcasts + multi-viewer PTY size sync (audit which legs are unported). Plus the session-prompting fix named above.

## What already exists in tm8 (measure, then reuse/fix — don't rebuild)

- `packages/execution`: the PTY host lift (harness 5/5), SpawnService, manifest composition; `src/pty/w2-message-delivery.ts` (delivery adapter).
- `packages/server/src/pty/pty-ws-server.ts` + `pty-ws-connection.ts`: ported socket (offset-resume/epoch/replay browser-proven). Drift item (b) applies here.
- Spawn path: `execution.spawn` op → SpawnService → work_session entity + composed manifest → PtyHostService. WS dispatch: `/v2/ws?sessionId=<id>` split in `packages/server/src/main.ts`.
- Injection path: `messages.post` → deliveryIntents → reserve→claim→one-write→settle saga → `pty.deliverPrompt()`. **Requires `TM8_DELIVERY_DATABASE_URL` (role tm8_delivery_worker); without it messages store and never reach terminals.** Milestone 2 depends on wiring this env properly (dev data; migrations define the role).
- Old UI transplant (verbatim harvest source): `packages/ui/src/real/terminal/ptyTransport.ts`, `visibilityDriver.ts`, write scheduler, `SessionTerminal.tsx` port; `packages/pty-protocol` (golden-frames test). `packages/ui` itself is READ-ONLY reference.
- New UI: `packages/tm8-ui` — the gate screen. Session panel has the chrome strip + placeholder canvas. The data layer (`src/data/`) has a dual-consensus seam with `ExecutionSpawnInput` passthrough and REAL transport modules (integration proven in-process against a real bootstrap() node). The Run/launch config UI (teammate/model/tool/profile/project) is being built by the FE lane NOW — consume its output shape; do not rebuild it.
- Prompts = tm8's own manifest composition (`packages/prompt` + worker-init): verify the composed manifest reflects the teammate's identity/config. tm8 prompts, not maestro's.

## Server runtime rules

- **dist is STALE** (predates today's landed fixes) and **rebuilds are FORBIDDEN** outside a sanctioned enumeration protocol you are not part of. **Run the server FROM SRC** — the in-process `bootstrap()` pattern (see `packages/tm8-ui/src/data/` integration tests) or a src loader. Never `npm run typecheck` at workspace root (it EMITS — silent dist promotion); use per-package `tsc -p <tsconfig> --noEmit`.
- Ports: server **:4610**, sidecar Postgres **:5442** (PG 18.4 — shared infrastructure, keep up; ALWAYS name host+port+user in any connection: a bare psql reaches a WRONG PG17 on the /tmp socket). UI dev **:4612** — A0-owned vite with HMR; NEVER start a second vite.
- Dev data: `~/.tm8-dev/`.

## Hard boundaries

- NEVER touch: `packages/server/test/w5/**`, `packages/cli/test/w5/**`, `packages/server/test/w3/**` (frozen trees, cross-program release process), anything under `packages/cli/` (another program's uncommitted work), `db/migrations/` (sole-landing-point rule; if you need a migration you are blocked — report it).
- In `packages/tm8-ui`: build in YOUR OWN module (`src/terminal/` + minimal registry/data touchpoints). The FE lane has an open window on session-panel/launch files — do not edit files they are editing; the single host-mount edit into the session panel goes behind a dev flag in YOUR file, or waits until their window's commits appear in git log.
- **Git: make NO commits.** Work uncommitted; the repo's index is under a three-coordinator lock ceremony you are not part of. At each milestone the master lands your work through a proper window. Protect yourself against loss: mirror your changed-file list + hashes to `~/.tm8-ptytrack/` (durable; /tmp is wiped on reboot).
- Instrument discipline: never suppress stderr; filter output by CONTENT never position; exit codes over echoed success; `ps` filtered by executable path + parentage (agent prompt text echoes tool names).

## Acceptance mindset

Every claim measured: config fidelity by reading entity+manifest+env; streaming by typing into the terminal and watching bytes round-trip; resume by killing and re-attaching (offset resume, epoch, replay); injection by observing the text arrive in the PTY and the delivery facet settle. A capture proves what you point it at — verify the thing you might have disturbed, not only the thing you changed. When your suites are green, ask what else could make them pass.
