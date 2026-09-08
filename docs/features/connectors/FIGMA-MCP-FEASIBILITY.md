# Figma MCP connector in the Task panel — feasibility plan

- **Task:** `01a080a8-e76e-7c31-8bd7-bdeb04ce56d9` — "Feasibility Check: Figma MCP Connector to be added in the Task Panel"
- **Author:** CLI & Prompt Ergonomics Planner (plan only — no source edits)
- **Date:** 2026-09-08. External facts (Figma docs, rate limits) were read on this date and can drift; Figma explicitly reserves the right to change limits.
- **Citation key:** a bare `file:line` was opened first-hand while writing this plan. A citation marked `(s)` comes from the repo survey pass and should be re-verified by the executing agent before relying on the exact line.

## Verdict

**Feasible, and cheaper than it looks.** tm8 already contains every mechanism required — an `mcpServers` config writer, a harness adapter that passes `--mcp-config`, per-identity Claude credential homes, and a registry-driven task panel with an exact precedent section (GIT). None of it is wired into the **work-session** spawn path, which is the only path a Task launches. The work splits into a zero-code pilot that can run **today**, and a contained tm8-native build (~10–14 files, **zero new catalog operations**, so zero digest/count-pin churn) for the per-task toggle the task title asks for.

The one hard external constraint: Figma's official remote MCP server is **OAuth-only** (no personal-access-token support), so every identity that should reach Figma needs a one-time interactive login — after which headless reuse works — or the Figma connector on the operating claude.ai account, which evidence shows **has already connected at least once** in this deployment.

---

## 1. External facts (verified 2026-09-08)

### 1.1 Two official servers

| | Remote (recommended by Figma) | Desktop |
|---|---|---|
| Endpoint | `https://mcp.figma.com/mcp`, HTTP transport | `http://127.0.0.1:3845/mcp` served by the Figma **desktop app** in Dev Mode |
| Auth | **OAuth only** — interactive browser sign-in. PATs in an `Authorization` header are rejected (`Unauthorized`); PAT support is an open feature request on Figma's forum | Local app session |
| Availability | All seats and plans (but see rate limits) | Dev or Full seat, paid plans only |
| Features | Broadest: design context extraction, code generation from frames, canvas writes, Code Connect, Make resources | Selection-based input, local design tokens |

**Desktop is ruled out** for tm8: the host is headless Linux (no GUI — see the memory note on this host's missing GTK libs), the desktop app cannot run there, and a server on a user's laptop binds 127.0.0.1 on *their* machine, unreachable from tm8-spawned sessions without a tunnel nobody should build.

**Client allowlist:** Figma only accepts clients in its MCP Catalog — VS Code, Cursor, **Claude Code**, etc. tm8 work sessions *are* Claude Code (§2.1), so tm8 qualifies without pretending to be anything.

### 1.2 Rate limits (developers.figma.com → Figma MCP server → "Rate limits & access")

Read tools are limited; `whoami`, `create_new_file`, `add_code_connect_map` are exempt.

| Seat on the OAuth'd account | Starter | Professional | Organization |
|---|---|---|---|
| View / Collab | 20/month | **6/month** | 6/month |
| Dev / Full | 200/day, 10/min | 200/day, 15/min | 600/day, 20/min |

Consequences for tm8:
- **The Figma account whose OAuth is used must hold a Dev or Full seat**, or agents get 6–20 calls a month — unusable.
- All sessions authenticated as the same Figma account share one daily budget. A design-to-code task plausibly spends 5–20 tool calls; 200/day supports roughly 10–40 such tasks/day across the whole deployment. The 10–20/min cap can throttle a single fast agent loop — worth one line of prompt guidance (§6.4).
- MCP access is scoped to files the authed Figma account can view/edit.

### 1.3 Claude Code mechanics (verified against docs + this host)

- MCP OAuth tokens are stored per endpoint in the identity's credential file, **silently reused by later headless runs, auto-refreshed**. There is **no non-interactive OAuth path** (no device flow, no header/env injection for the official server). One-time interactive auth per credential home is mandatory: `claude mcp add --transport http figma https://mcp.figma.com/mcp` then `/mcp` → authenticate (or `claude plugin install figma@claude-plugins-official`, which also ships Figma skills).
- If a refresh token later dies, headless sessions see the server's tools as *unavailable* (degraded, not fatal) until someone re-authenticates interactively.
- `--mcp-config <file|inline-json>` attaches servers to a single invocation; `--strict-mcp-config` makes that set exclusive. **Unverified corner:** whether a server declared via `--mcp-config` shares the stored OAuth token with the same endpoint registered via `claude mcp add`. Spike item S2 (§5).

### 1.4 Evidence from this deployment (first-hand, identity `fa66226d`)

- Work sessions launch as (read from a live process's `/proc/<pid>/cmdline`):
  `claude --dangerously-skip-permissions --model <model> --effort max --session-id <uuid> --append-system-prompt <tm8_system_prompt…>` — **no `--mcp-config`, no `--strict-mcp-config`, permissions bypassed.** So (a) MCP tools need no allow-listing on this path, and (b) anything registered at user scope in the identity's config dir — or arriving as a claude.ai connector — flows into every spawned session already.
- Each tm8 identity gets its own `CLAUDE_CONFIG_DIR` under `/home/tm8/prod-data/credentials/id_<uuid>/anthropic` (six identities exist today), containing `.claude.json`, `.credentials.json`, `settings.json`, `plugins/` (the official marketplace is installed), and `mcp-needs-auth-cache.json`.
- That identity's `.claude.json` has `claudeAiMcpEverConnected: ["claude.ai Figma", "claude.ai higgsfield"]`, and the needs-auth cache lists two other claude.ai connectors. **A claude.ai Figma connector has connected successfully in a session under this identity at least once.** Current sessions expose no Figma tools — the connector is presently disconnected or disabled on the claude.ai side — but the mechanism demonstrably reaches spawned sessions, and its OAuth happens in the operator's own browser on claude.ai: **no browser needed on the tm8 host at all.**

### 1.5 Third-party alternative

Community MCP servers wrap the Figma REST API with a personal access token (e.g. `figma-developer-mcp`, a.k.a. GLips/Figma-Context-MCP). Fully headless, but: third-party code running inside sessions that hold `--dangerously-skip-permissions` (a real supply-chain decision), REST-only feature set (file/node reads, rendered images — no Dev Mode `get_code`, no Code Connect, no canvas writes), and tm8 would own PAT storage. Kept as Option D (§4), not recommended first.

---

## 2. What tm8 already has (the reusable seams)

### 2.1 A complete MCP path — on the chat lane only

- `packages/server/src/chat/compose.ts:252-284` writes a per-thread `<chatId>.mcp.json` (dir `0700`, file `0600`, token minted per start) whose shape is exactly the file a Figma entry would join: `{ mcpServers: { tm8: { command, args, env } } }`. It returns `mcpConfigPath` on the launch config (`compose.ts:286-296`).
- `packages/execution/src/runtime/ClaudeHeadlessAdapter.ts:401-403` passes `--mcp-config <path> --strict-mcp-config` to headless chat Claude. Test pin: `packages/execution/test/claude-headless-adapter.test.ts:170-172` (s).
- `packages/execution/src/runtime/types.ts:88-104` — the runtime input already carries `mcpConfigPath`, and its `env` doc comment literally anticipates this feature: *"Per-thread additions such as CLAUDE_CONFIG_DIR or MCP auth material."*
- `packages/mcp/*` is tm8's own MCP **server** (tm8 tools exposed *to* chat). It is not needed for Figma, but proves the org already operates MCP in production.

### 2.2 The work-session spawn path (where the gap is)

- `packages/execution/src/spawn/manifest.ts:551-616` `buildAgentCommand()` — the Claude branch (`:606-615`) emits permission flag, `--model`, `--effort`, `--session-id`, nothing else. This is **the single insertion point** for a `--mcp-config` flag; anything added must pass `shellQuote` (the return is a shell string, `:615`).
- `manifest.ts:695-734` `withAgentResume()` wraps the previously built base command and appends `--append-system-prompt` + `--resume`. Resume rebuilds from the base `command`, so the connector state must be available and honored **again at resume time** (call sites `SpawnService.ts:1597`/`:1721` (s)) or the connector silently vanishes on first resume. The `TM8_AGENT_CMD` operator-wrapper escape hatch (`manifest.ts:585`) bypasses flag construction entirely — the connector must degrade honestly there (resume already refuses under a wrapper, `manifest.ts:702-709`).
- `packages/execution/src/spawn/SpawnService.ts:1054-1068` — credentials are resolved (`resolveCredentialHome`, `resolveGitHubCredential`) and folded into `composeEnv`; `manifest.ts:1084-1098` shows the per-identity credential home applied with provider-scoped env suppression. **The per-identity `CLAUDE_CONFIG_DIR` that would hold the Figma OAuth token is already plumbed.**
- `SpawnService.ts:1084-1094` — the manifest is persisted to the graph with env **names only**, because secret values there would outlive rotation. Any Figma secret must follow the same law (§7).
- `packages/execution/src/spawn/types.ts:245-269` — `TaskContext` carries no `axes` and no metadata bag: per-task state does not currently flow into spawn, so any per-task toggle needs `loadSpawnContext` (`packages/server/src/facade/execution-handlers.ts:269` (s)) to start selecting it.

### 2.3 The Task panel (UI precedent)

- The panel is registry-driven; the task kind declares `gitSection: true` at `packages/tm8-ui/src/domain/registry.ts:835-837` (*"A registry field, so the panel never asks the kind"*), and the body renders the opaque, self-fetching section at `packages/tm8-ui/src/panels/bodies/SubtreeBody.tsx:256-267`.
- The one adapter is `packages/tm8-ui/src/views/taskGitSection.tsx:15-30` (`taskGitSectionFor`), mounted at five hosts: `views/WorkspaceView.tsx:501`, `views/EntityView.tsx:844`, `views/auxPanel.tsx:110`, `views/ChannelView.tsx:253`, `graph/GraphScreen.tsx:232` (all (s)).
- The cheaper UI surface: `packages/tm8-ui/src/panels/launch/LaunchQuickConfig.tsx:291-310` — the access-mode chip toggle. A "Connectors: Figma" toggle beside it is a few dozen lines and no panel plumbing.
- Live UI is `packages/tm8-ui` only. `packages/ui` and `packages/tm8_ui_2.0` are legacy/parallel chains — do not build there (s).

### 2.4 Credential storage precedent

- Per-account encrypted string credential: `db/migrations/093_account_git_credentials.sql:33-53` — AES-256-GCM sealed columns, `unique (account_id, provider)`, but the CHECK pins `provider = 'github'` (`:42-43`) and the same pin recurs in the RPCs (s). Widening `CredentialProviderName` (`packages/contract/src/contract.ts:1924-1930`, a closed six-value union) ripples into the "always all six" status view, UI provider cards, and per-provider env suppression tables — a **new** `account_connector_credentials` table modelled on 093 is cheaper than widening, if Option D is ever built.
- `packages/contract/src/schemas.ts:3827-3842` `isSecretLookingEnvKey` — the container lane already refuses secret-shaped env names (`FIGMA_TOKEN` would trip `TOKEN`) with *"secrets reach a container through the credential path, not spec.env"*. The same doctrine applies here.

---

## 3. The gap, stated precisely

A Task-spawned session today gets **no MCP configuration of any kind**: `buildAgentCommand` emits no `--mcp-config`, no config file is written on the spawn path, and `TaskContext` carries no field a toggle could ride. Everything else — config-file shape, harness flag handling, credential homes, panel section pattern — exists and is copyable from an adjacent lane.

---

## 4. Options, costed

### Option A — zero-code pilot (recommended **now**)
Enable Figma for the deployment without touching the repo, choosing one of two auth roads:
- **A1, claude.ai connector:** the operator (re)connects Figma on the claude.ai account the identities run under. OAuth happens in their browser on claude.ai; spawned sessions inherit the connector's tools. Evidence it reaches sessions: §1.4. Best when identities share one claude.ai account.
- **A2, user-scope registration:** for each identity that should have Figma, run once with that identity's config dir: `CLAUDE_CONFIG_DIR=/home/tm8/prod-data/credentials/id_<uuid>/anthropic claude` → `claude mcp add --scope user --transport http figma https://mcp.figma.com/mcp` → `/mcp` → authenticate. Headless spawns reuse the token thereafter (§1.3).

**Cost:** ~30 min operator ceremony (per identity for A2). **Limits:** identity-wide, not per-task — every session of that identity sees Figma tools; no Task-panel affordance; token death needs a manual re-login (§8 R3).

### Option B — prompt/ergonomics layer on top of A (cheap, my territory)
One conditional guidance line so agents use the tools well (fetch the node the task names; don't re-pull whole files; mind the per-minute cap). Delivery paths, cheapest first: (1) per-launch `promptExtra` (`packages/contract/src/contract.ts:4150`, already end-to-end); (2) task description convention (paste the Figma link — the tools take URLs/node ids); (3) a mode-instruction sentence in `packages/prompt/src/index.ts` — this trips the catalog byte-sync (`packages/prompt/test/catalog.test.ts:94-149` (s)) and must keep `packages/prompt/src/catalog.ts` in step; wording-only, so the frozen verb grammar in `compose.test.ts` is not at risk (Figma MCP tool names are not tm8 CLI verbs).
**Cost:** hours. No digest churn (prompt wording and `operations.ts` `notes:` edits don't move `CATALOG_DIGEST`).

### Option C — tm8-native per-task/per-launch connector (the feature the task names)
The contained build, **no new catalog operations** (so none of the ~15-file count-pin sweep — the tax is documented at `packages/cli/src/commands/registry.ts:84` (s)):

1. **Contract:** one additive-optional field on `ExecutionSpawnInput` (`contract.ts:4103-4151`), e.g. `connectors?: Array<'figma'>`, plus its zod schema. Additive fields here are the house pattern (`credentialSources`, `promptExtra` sit exactly there).
2. **Spawn:** when the flag is present, write `<sessionId>.mcp.json` next to the manifest (lift the writer shape from `compose.ts:252-284`; content is just `{ mcpServers: { figma: { type: "http", url: "https://mcp.figma.com/mcp" } } }` — **no secret in the file** in the OAuth model, the token stays in the identity's credential home). Thread the path into `buildAgentCommand` (`manifest.ts:606-615`) as `--mcp-config <shellQuoted path>` — **without** `--strict-mcp-config`: chat's closed world is correct for chat, but on work sessions strictness would silently disable operator-configured user-scope servers. Honor the same state on the resume path (§2.2) and record the path on `Tm8Manifest.launch` for debuggability.
3. **UI, two sizes:**
   - *Cheap (recommended v1):* a Connectors toggle in `LaunchQuickConfig.tsx` beside the access chip (`:291-310`) → rides the spawn input. Per-launch, no persistence.
   - *Thorough (v2, if the toggle should stick to the task):* a registry-declared `connectorsSection` cloning the `gitSection` chain — `domain/types.ts` `PanelConfig` → `registry.ts:837` → `EntityDetailPanel` prop → `SubtreeBody.tsx:256`-style block → `views/taskConnectorsSection.tsx` adapter → the five mount sites. Persistence for v2: prefer a task **axis** (`figma: on|off`) — axes are already contract-typed and validated per space (`db/migrations/001_core_graph.sql:553-583` rejects unknown axis names, so the space first defines the axis — a settings act, not code), at the cost of the axis appearing as a filter/grouping chip; then `loadSpawnContext` + `TaskContext` grow the read. A dedicated task column is the expensive third choice and buys little at this stage.
4. **Prompt:** Option B's line, injected only when the connector is on.

**Cost:** spike 0.5–1 day (§5), then ~2–4 engineer-days for v1 (contract field + spawn + quick-config toggle + tests), +2–3 days for the v2 panel section. Auth remains Option A's ceremony — **C scopes tool availability; it does not create an auth path.**

### Option D — PAT-based third-party server managed by tm8
Only if headless independence from claude.ai/OAuth becomes a requirement: new `account_connector_credentials` table (modelled on 093, reusing `secret-box.ts`/`credential-key.ts` (s)), a `ConnectorCredentialPort` beside `GitHubCredentialPort` (`packages/execution/src/spawn/types.ts:148` (s)), PAT injected only into the `0600` mcp.json's `env` block, plus vetting/pinning a community package that will run inside bypass-permissions sessions. **Cost:** +3–5 days plus a real security review. Feature loss vs. official server (§1.5).

---

## 5. Spike checklist (half a day, before committing to C)

- **S1:** With one identity's config dir, do A2; then launch a headless `claude -p "call mcp__figma__whoami"` — confirm token reuse with no browser. (`whoami` is rate-limit-exempt.)
- **S2:** Same identity, server *not* registered at user scope, passed only via `--mcp-config` — does it pick up the stored OAuth token for the endpoint? This decides whether C injects config per-session (preferred) or falls back to A2-always-on plus per-task `--disallowed-tools mcp__figma__*` when the toggle is off.
- **S3:** Reconnect the claude.ai Figma connector and verify its tools appear in a spawned work session (validates A1; §1.4 shows it connected before).
- **S4:** Confirm which Figma seat the org account holds (Dev/Full needed — §1.2), and roughly measure tool-token weight per call for prompt guidance.

## 6. Recommended sequence

1. **Now:** Option A pilot (A1 if one claude.ai account serves the identities; else A2 for one identity), plus S1–S4.
2. **Next:** Option C v1 (launch-time toggle) with Option B's prompt line.
3. **Then, if demanded:** C v2 (panel section + task-axis persistence).
4. **Only on hard requirement:** Option D.

## 7. Security notes

- In the OAuth model no Figma secret ever enters tm8 storage: the token lives in the identity's Claude credential home (`.credentials.json`), already isolated per identity (`manifest.ts:1084-1098`). Nothing secret goes in the per-session mcp.json, the manifest (persisted with env *names only*, `SpawnService.ts:1084-1094`), or the graph.
- If Option D ever lands, remember the honesty note at `ClaudeHeadlessAdapter.ts:408-432`: a token in a `0600` config file **is readable by the agent that runs beside it** (`cat` is a tool call), and redaction is not a control. That is an accepted trust posture for the session's own credential, but it belongs in the review.
- Figma MCP responses are third-party content entering bypass-permissions sessions — standard untrusted-data posture applies (the worker prompt already states it).

## 8. Risks

| # | Risk | Exposure | Mitigation |
|---|---|---|---|
| R1 | OAuth-only auth (no PAT) on the official server | Blocks fully-unattended provisioning | One-time ceremony per identity (A2) or claude.ai connector (A1); D as last resort |
| R2 | Seat/plan gating | View/Collab seat = 6–20 calls/**month** | S4 before anything else; Dev seat on Org plan for scale |
| R3 | Refresh-token death mid-fleet | Sessions silently lose Figma tools | Degraded-not-fatal (§1.3); document the re-login runbook; consider a doctor-style probe later |
| R4 | Resume drops the flag | Connector vanishes after first resume | Explicit resume-path work item in C; test it |
| R5 | `--strict-mcp-config` copied from chat | Would disable operator's own user-scope servers on work sessions | C explicitly omits it; states why in code |
| R6 | Shared daily rate budget across all agents | Fleet-wide throttling at 200/day | Prompt guidance (B); Organization plan (600/day) if heavy |
| R7 | S2 fails (no token sharing via `--mcp-config`) | Per-session injection can't carry auth | Fallback wiring named in S2 |

## 9. Open questions for the requester

1. Should the toggle live **per launch** (v1, cheap) or **persist on the task** (v2, axis-backed)? The task title says "Task panel", which suggests v2 eventually — v1 still ships the capability first.
2. One shared Figma account for all identities, or per-member Figma identities? (Changes nothing structurally; changes whose seat/rate budget is spent and who runs the ceremony.)
3. Is "only Figma" firm? Everything in Option C is written so a second connector is another array literal, but nothing here builds generic-connector UI.

## Appendix: sources

- help.figma.com — "Guide to the Figma MCP server" (article 32132100833559); Figma MCP collection (section 35280374295831); desktop setup (article 35281186390679)
- developers.figma.com — /docs/figma-mcp-server/ (hub), /remote-server-installation/, /rate-limits-access/
- forum.figma.com — PAT-support threads 47465 and 55558 (OAuth-only confirmation)
- Claude Code docs via research agent: MCP OAuth persistence/refresh, `--mcp-config`/`--strict-mcp-config`, headless behavior when a server needs auth (v2.1.196+ note)
- First-hand host evidence: §1.4 (process argv, identity credential dirs, `claudeAiMcpEverConnected`)
