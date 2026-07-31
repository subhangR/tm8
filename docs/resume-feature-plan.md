# tm8 Session Resume — Implementation Plan

**Date:** 2026-07-31 · **Status:** IMPLEMENTED (same day — see the Implementation Record below; the plan's Part C is superseded in ONE respect) · **Basis:** deep-trace of maestro's working resume feature + full map of tm8's spawn architecture (both verified against source on this machine).

## Implementation Record (2026-07-31, working tree, uncommitted)

**The design decision C0 proposes (resume = new session entity) was overruled by the owner in favor of maestro's same-session model**: `tm8 session resume <id>` resurrects the SAME work_session (`exited`/`failed` → `spawning` → `running`) via a dedicated RPC, `public.execution_resume`, leaving `work_session_transition`'s sink law untouched. Everything else landed as planned.

What exists now:
- **Migration `062_session_resume.sql`** — `work_sessions.native_session_id` (write-once via `public.execution_record_native_session`), and `public.execution_resume` (persona `can_act_as`, concurrency cap, status gate, clears exit evidence under the single-writer guard flag, ledger op `execution.resume`, activity verb `restored` + `{action:'resumed'}` — `resumed` is NOT in `activity_verb_check`'s closed set). Applied+proven on a scratch chain through `db/migrate.mjs`; **staging/prod still need `node db/migrate.mjs up`**.
- **Claude pre-mint** — `SpawnService.spawn` mints `randomUUID()` for claude-code, records it before the PTY exists, and `buildAgentCommand` passes `--session-id`. Every new Claude session is resume-capable from birth.
- **Codex marker + capture** — the composed task turn gets `<tm8_session_id>…</tm8_session_id>` appended (codex only); `native-session.ts` scans `~/.codex/sessions/**/*.jsonl`, accepts ownership ONLY from a user message, ranks by cwd then timestamp, fail-closed.
- **`execution.resume`** through the whole amendment chain: catalog row (`POST /v2/entities/:id/commands/resume`), `ExecutionResumeInput(+Schema)`, discovery row, `tm8 session resume`, server handler, `SpawnService.resume` + `withAgentResume` (claude: `--resume <id>` + re-applied system prompt, NO task positional; codex: `codex resume … <id>`, never `--last`; wrappers/echo-agent/gemini/hermes refused).
- **Gates green**: contract 67/67, execution 56/56 (incl. new `session-resume.test.ts`), CLI 1035/1036 (1 pre-existing skip) after reconciling all catalog pins to 119 (this landed interleaved with another lane's `spaces.counts` — both rows counted together) and regenerating the conformance manifest; `tsc -b` clean.
- **Live-proven for Claude** (scratch DB + tree server on :4655, real haiku agent): spawn → native transcript file named by the pre-minted uuid, agent computed `42021` → terminate (`exited`) → `tm8 session resume` → same row `running`, exit evidence cleared, live process argv ending `--resume 9e2b351c-…` with no task turn, and the reattached PTY rendering `42021.` from the restored conversation.
- **NOT proven**: a live Codex resume (builder+capture are unit-tested only); resume of `idle` sessions (deliberately excluded by the status gate); worktree-mode workdir restore (worktree still isn't in the public contract).

The plan below is retained as the design rationale and the map of both codebases.

---

## Part A — How maestro does resume (the reference design)

Maestro (source: `~/Desktop/Projects/maestro/agent-maestro`) resumes agents by capturing or pre-minting each agent's **native, provider-owned session id** and re-invoking the provider's own resume flag. The two providers are fundamentally asymmetric, and this asymmetry is the central design fact to carry over:

| | Claude Code | Codex |
|---|---|---|
| **Id origin** | Maestro **pre-mints** a `randomUUID()` at spawn and forces Claude to adopt it via `--session-id <uuid>` (`claude-spawner.ts:137-147`, `sessionRoutes.ts:1947`) | Codex mints its own rollout id; cannot be pre-seeded |
| **Capture** | None needed — deterministic | Scan `~/.codex/sessions/**/*.jsonl`; native id = `session_meta.payload.id` in the rollout head (`LogDigestService.ts:104-117`) |
| **Linkage** | Stored at creation (`session.claudeSessionId`, top-level field) | Ownership proven by finding the maestro session id inside the rollout's **first user-message** — maestro injects `<session_id>sess_…</session_id>` into every initial prompt (`prompt-composer.ts:122`); matched via regex, accepted *only* from a user-message envelope (raw substring match is wrong — coordinator tool calls mention child ids in unrelated rollouts) |
| **Resume command** | `claude <base config> --append-system-prompt <role> --resume <uuid>` | `codex resume <base config> -c developer_instructions=<role> <id>` |
| **Missing-id behavior** | Legacy no-id session downgrades to fresh init | **Fail closed**: HTTP 409 before any state change; never `--last` (cwd-scoped "most recent" resumes the wrong thread) |

Other load-bearing maestro decisions:

1. **Resume restores history, not invocation config.** `--resume`/`codex resume` restore the conversation; the *static* layer (role/system prompt, model, permission mode, sandbox, reasoning effort, cwd/worktree) is NOT restored and must be re-applied from persisted launch config. The **dynamic task turn is deliberately not re-sent** — it's already in the restored conversation.
2. **No fork/continue semantics** — only exact-id continuation. `--continue` (Claude) and `--last` (Codex) are explicitly rejected as ambiguous.
3. **Provider isolation** — a Codex child must never see the Claude session id env var; maestro strips it at three layers with an explicit `removeEnvKeys` deletion list (its persistence merges env, so deletion must be explicit).
4. **Idempotent PTY re-attach** — on resume, spawn the PTY only if no live PTY exists; killing a live PTY resets the output stream to offset 0 and desyncs attached clients.
5. **Resume allowed from any status** — maestro found status unreliable as a gate (stranded ~24% of sessions when gated).
6. **Eager + lazy capture** — Codex id captured eagerly when the rollout is first located, and re-resolved (and corrected if stale) at resume time.

---

## Part B — What tm8 has today (verified 2026-07-31)

- **No native-id anything.** Exhaustive grep: no `--resume`/`--continue`, no JSONL/rollout parsing, no hooks config, no `~/.claude/projects` / `~/.codex` reads, no storage field. All three legs (capture, storage, injection) must be built.
- **The seam is already named.** `PtyHostService.spawn()` is documented as "deliberately destructive for the agent resume path, which intends to replace the process" (`packages/execution/src/pty/PtyHostService.ts:508`). `spawnIfAbsent()` is the idempotent client-reattach path.
- **Session row:** `public.work_sessions` (`db/migrations/001_core_graph.sql:694-718`) — has `agent_tool`, `model`, `mode`, `workdir_mode/path`, `status` (single-writer via `internal.guard_work_session_status`, R29; **`exited`/`failed` are sinks — never back to `spawning`**), `exit_code`, `transcript_doc_id` (tm8 doc FK, always null, unrelated). No native id column.
- **Spawn path (single, reused for everything):** CLI `session spawn` → `execution.spawn` op → `execution-handlers.ts:736` → `SpawnService.spawn` (6 steps: load context → resolve launch config+workdir → `public.execution_spawn` RPC → manifest file → PTY spawn → transition running). Command built by `buildAgentCommand` (`manifest.ts:259-323`, claude-code/codex/echo-agent only), prompt appended by `withAgentPrompt` (`manifest.ts:368-393`) — Claude: `--append-system-prompt` + positional task; Codex: `-c developer_instructions=` + positional task. Env via `composeEnv` (`manifest.ts:485-567`) — **`HOME`/`XDG_CONFIG_HOME` are forwarded**, so `~/.claude` / `~/.codex` state persists under the server's home and is capturable/resumable.
- **Workdir is graph truth** (`resolveWorkdir`, `manifest.ts:170-199`): project → `projects.working_dir`; projectless → `<dataDir>/scratch/<sessionId>`. Worktrees exist (057, `WorktreeManager`) but the contract `workdir` union is `project|scratch` while the DB CHECK is `project|worktree` — worktree not yet exposed publicly.
- **Prompt delivery:** initial prompt is baked into argv; later prompts only via internal `execution.prompt` (public route is a pure refusal, R17).
- **Amendment pattern** (proven by liveness/artifacts/worktrees): migration → `catalog.ts` OPERATIONS row (order pinned by `w1-amendment.test.ts`) → Zod schema + TS type + index export → `discovery/operations.ts` entry (else catalog-exhaustiveness fails) → CLI command + registry → server handler.
- **Migrations:** highest on disk **061**; next free **062** — re-verify at implementation time (parallel-session number races are a known hazard here, and `create or replace` lets a later file silently win).

---

## Part C — The plan

### C0. Core design decision: resume creates a NEW work_session entity

Maestro revives the same session record (status any → spawning). tm8 **cannot**: `work_session_transition` makes `exited`/`failed` terminal sinks, and that single-writer invariant (R29) is load-bearing across audits, ghost reconciliation, and the exit path. Weakening it would ripple everywhere.

Instead: **resume = spawn a new work_session that adopts the prior session's native conversation.**

- New columns on `work_sessions`: `native_session_id text` (the provider-owned id) and `resumed_from uuid references entities(id) on delete set null` (lineage).
- The new session copies persona, project, tasks, mode, model, agent_tool, workdir from the original; `native_session_id` is copied forward, so a lineage resumed N times still points at one native conversation and the JSONL scan is only ever needed once (first Codex capture).
- This composes cleanly with the existing 8-session concurrency cap, spawn parentage, event capture, and ghost reconciliation — zero changes to the status machine.
- Trade-off (accepted): "one conversation" spans multiple session entities. The `resumed_from` chain + shared `native_session_id` is the join; UI can collapse lineages later.

### C1. Phase 1 — Identity: mint, capture, store

**Migration `062_session_resume.sql`** (re-verify next-free number first):
1. `alter table public.work_sessions add column native_session_id text, add column resumed_from uuid references public.entities(id) on delete set null;` (+ index on `resumed_from`).
2. Extend `public.execution_spawn` with two nullable params: `p_native_session_id text default null`, `p_resumed_from uuid default null` — using the 048 pattern (drop exact old signature → recreate → `revoke all from public; grant execute to tm8_app`). Persist both onto the new row; when `p_resumed_from` is set, record activity with a `resumedFrom` payload (or a new `resumed` verb).
3. New writer RPC `public.execution_record_native_session(p_session_id uuid, p_native_session_id text)` — sets the column iff currently null (write-once), server-principal only (loopback auth model). This is the Codex capture sink.
4. Hazards: no new entity kind (so no `entity_content` copy-forward needed), but the `execution_spawn` signature change must drop the **exact** current signature; verify with `pg_get_functiondef` on a scratch chain. Note db/test has 17 pre-existing reds — diff, don't count.

**Claude: pre-mint (deterministic, no capture).** In `SpawnService.spawn` step 2, when `agentTool === 'claude-code'`, mint `randomUUID()`; pass it to `execution_spawn` as `p_native_session_id`; `buildAgentCommand` appends `--session-id '<uuid>'`. Done — resume-ready from birth.

**Codex: capture from the rollout file.** Codex can't be pre-seeded, so port maestro's mechanism:
1. **Marker injection:** `@tm8/prompt`'s composed task prompt must embed the tm8 session id in a recognizable envelope, e.g. `<tm8_session_id>{uuid}</tm8_session_id>`, in the initial task turn. (tm8 ids are bare uuids — the tag, not a prefix, is the discriminator. The agent already receives `TM8_SESSION_ID` in env, but env never appears in the rollout; the marker must be in the *prompt*.)
2. **Extraction module** (new, `packages/execution/src/spawn/native-session.ts`): walk `~/.codex/sessions/**/*.jsonl` (bounded head reads); parse `session_meta` head line → `payload.id`, cwd, timestamp; parse first **user-message** envelope for the marker — ownership accepted only from a user message, never a raw substring (maestro learned this: coordinator tool output mentions child session ids in unrelated rollouts). Candidate ranking: cwd match → newest timestamp.
3. **Capture timing:** eager attempt from the existing boot-settlement watcher (retry a few times — the rollout file appears within seconds of Codex boot); retry once in `handlePtyExit`; lazy re-resolve at resume time (correcting a stale stored value, maestro-style). Write via `execution_record_native_session`.
4. **Fail closed:** if resume is requested for a Codex session with no recoverable id → typed refusal (`codex_resume_id_unavailable`) *before any state change*. Never fall back to `codex --last` or a silent fresh start.

*(Rejected alternatives: SessionStart hooks — Claude doesn't need them once pre-minted, Codex has none; stdout scraping in `PtyHostService.onData` — brittle across TUI redraws.)*

### C2. Phase 2 — Contract amendment: `execution.resume`

Follow the proven chain exactly:
1. **Catalog** (`packages/contract/src/catalog.ts` execution block): `{ name: 'execution.resume', method: 'POST', path: '/v2/execution/resume', kind: 'command', status: 'v1' }` — appended additively; `w1-amendment.test.ts` pins order.
2. **Schema** (`schemas.ts`, near `:1491`): `ExecutionResumeInputSchema = z.object({ clientMutationId, spaceId, sessionId, confirmUntrusted?: literal(true), title?: string }).strict()`. Deliberately minimal — model/persona/workdir/access mode come from the original session row, not the caller (maestro re-applies stored launch config; overrides can be a v2 amendment). + TS type in `contract.ts`, export in `index.ts`.
3. **Discovery** (`packages/cli/src/discovery/operations.ts:937-989` execution block): entry with `cmd: ['session','resume']` — required or catalog-exhaustiveness fails.
4. **CLI** (`packages/cli/src/commands/session.ts`): `tm8 session resume <sessionId>` handler + `SESSION_COMMANDS` registration.
5. **Server** (`execution-handlers.ts`, near `:736`): `registry.register('execution.resume', …)` → `SpawnService.resume`, reusing `assembleCommandResult` / error mapping; add the typed `codex_resume_id_unavailable` refusal.

### C3. Phase 3 — Execution: `SpawnService.resume` + resume command builder

**`SpawnService.resume(request)`** — mirrors `spawn()`'s 6 steps, reusing them wherever possible:
1. Load the **original** session row (+ persona, project, task edges). Validate: `agent_tool ∈ {claude-code, codex}` (echo-agent/gemini/hermes → typed refusal, maestro-style 400-equivalent); resolve `native_session_id` (Claude: must exist — it's pre-minted, missing means pre-062 legacy → refuse with a clear "not resume-capable" error rather than maestro's silent fresh-init downgrade; Codex: stored value or lazy JSONL resolve; fail closed).
2. Resolve workdir **by original mode**: `project` → recompute from `projects.working_dir` (graph truth — the project dir may legitimately have moved); `scratch` → **reuse the original session's scratch path verbatim** (`<dataDir>/scratch/<originalSessionId>` — deriving from the *new* session id would orphan the conversation's files; store/copy `workdir_path` rather than re-deriving); worktree (when exposed) → re-lease the same `worktree_allocations` row, never allocate anew.
3. Call `execution_spawn` with `p_native_session_id = <inherited>`, `p_resumed_from = <original entity_id>` → new session entity, all existing authz/cap/idempotency/replay machinery applies unchanged.
4. Compose manifest as usual, but build the command via a new **`buildAgentResumeCommand`** in `manifest.ts`:
   - **claude-code:** base config (permission mode, model, effort — from `buildAgentCommand`) + `--append-system-prompt '<system>'` + `--resume '<native_id>'`. **No positional task prompt** (`withAgentPrompt` is skipped for the task turn — it's already in the restored history). **No `--session-id`** on the resume invocation.
   - **codex:** `codex resume <base config> -c developer_instructions=<json system> <native_id>`. No positional task. No `--last`, ever.
   - `TM8_AGENT_CMD` operator override: pass through verbatim as today, but document that a wrapper must forward args for resume to work.
5. Env via `composeEnv` with the **new** session id (boot contract stays coherent); `HOME` forwarding already guarantees the native state is visible. No cross-provider id leakage is possible since tm8 builds argv directly and never puts native ids in env — keep it that way.
6. PTY: use `spawnIfAbsent` semantics for the new session id (it's a fresh entity, so no live PTY exists; the maestro idempotency concern maps onto tm8's existing client-reattach machinery for free). Boot-settlement watcher + `running` transition as in spawn.

### C4. Phase 4 — Surface polish (separable)
- **Events/UI:** the new session emits standard created/status events; add `resumedFrom` to the spawn activity payload so timelines can render "resumed from ⟨title⟩". tm8-ui: a "Resume" affordance on exited/failed sessions where `agent_tool` is resumable and (Claude) `native_session_id is not null`. UI work should follow the tm8-ui plan's re-consensus register — keep it out of the core feature's critical path.
- **`session list` / projection:** expose `nativeSessionId?`, `resumedFrom?` in the session read projection (`entity-read.ts`) so the CLI can show resumability.

### C5. Testing & gates (use the instruments memory — each fails silently the obvious way)
1. **Unit:** `buildAgentResumeCommand` snapshot tests (both tools; assert no task positional, no `--session-id`, no `--last`); rollout-head extraction tests with fixture JSONL (marker in user message; marker in tool output must NOT match; multiple candidates ranked by cwd/timestamp); write-once semantics of `execution_record_native_session`.
2. **Migration:** scratch-chain apply + `pg_get_functiondef` diff of `execution_spawn` (old arms preserved); chain hash updated; parity test.
3. **Contract:** `w1-amendment` ordering, catalog-exhaustiveness, discovery-honesty — all must stay green.
4. **Integration (harness):** spawn echo-agent → assert resume refusal is typed; spawn claude-code with a stub `TM8_AGENT_CMD` recorder → assert `--session-id` at spawn and `--resume <same uuid>` + no task positional at resume; Codex capture path with a fixture `~/.codex/sessions` tree under a temp `HOME`.
5. **Live proof (the real gate):** spawn a real Claude session against the dev stack, let it answer, terminate, `tm8 session resume` → verify the agent recalls the prior conversation. Then the same for Codex, including the capture write landing in `work_sessions.native_session_id`. Remember: status=running is not a started agent — read the PTY bytes.

### C6. Risks / open questions
1. **Migration number race** — 062 may be taken by a parallel session by implementation time; re-check `ls db/migrations | tail` immediately before writing.
2. **Legacy sessions** (spawned before 062) have no native id: Claude ones are permanently non-resumable (explicit refusal, honest error text); Codex ones are *recoverable* via the marker scan **only if** the prompt marker ships before they were spawned — i.e., not recoverable retroactively. Accept this; don't build forensic backfill.
3. **`claude --resume` with no positional prompt** boots into interactive resume and waits — exactly the desired PTY behavior (maestro-proven on this machine), but verify against the installed claude binary version during live proof.
4. **Scratch-workdir reuse** requires persisting/copying `workdir_path` rather than re-deriving from session id — called out in C3.2; easy to get silently wrong.
5. **Idempotency default is OFF** (`TM8_IDEMPOTENCY_ENABLED`) — resume replay tests must set it or cmid assertions will look like flakes.
6. **Worktree lease semantics on resume** (re-lease vs. exclusive lease held by a dead session) need a small design pass when worktree mode is exposed in the contract; out of scope for v1 (contract union is still `project|scratch`).

### Suggested build order
1 → Migration 062 + Claude pre-mint + storage (small, self-contained, makes every new Claude session resume-ready immediately)
2 → Contract amendment + CLI + server handler + `SpawnService.resume` + `buildAgentResumeCommand` (Claude-only resume working end-to-end, live-proven)
3 → Codex marker + rollout capture + fail-closed resume (the only genuinely new machinery)
4 → Projection/UI polish + lineage rendering.
