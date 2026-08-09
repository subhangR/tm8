# 1 — Rehearsal: how a session is spawned today

> Design document, exported from the tm8 graph at entity `019fdc8d-51f2-7441-a01c-d8ade5845314` v2.
> The graph entity is the source of truth; this file is the reviewable copy.

# 1 — Rehearsal — how a session is spawned today

*Sub-document of “Design: per-member credential management in sessions”. Basis: `origin/main` @ `7631e08`, 2026-08-07.*

## Part 1 — Rehearsal: the spawn path as it exists today

### 1.1 The call chain

```
POST /v2/… execution.spawn
  packages/server/src/facade/execution-handlers.ts:1246
    resolveOwner()                     → LoopbackOwner (node auto-owner)
    claimsFor(owner, ctx, envelope)    → facade/context.ts:67
        identityId = bearer?.identityId ?? owner.identityId   ← WHO ASKED. Already correct.
        actorId    = bearer?.actorId ?? envelope.actorId      ← which persona
    spawnService.spawn(claims, request)

  packages/execution/src/spawn/SpawnService.ts:351
    1. graph.loadSpawnContext(auth, …)         persona + project + tasks
    2. inheritedPosture(auth, request)         parent session posture (child spawns)
       resolveLaunchConfig(request, ctx, this.env, inherited)   manifest.ts:252
       resolveCommandNetworkPolicy(…)                           manifest.ts:156
       nativeSessionId = randomUUID()          Claude only, pre-minted for --resume
       resolveWorkdir(request, context, …)     manifest.ts:300 — cwd from projects.working_dir ONLY
    3. graph.createWorkSession(…)              public.execution_spawn, one tx
    4. graph.issueWorkSessionAgentToken(…)     migration 074 — per-run tm8 bearer
       buildAgentCommand(launch, this.env, {claudeSessionId})   manifest.ts:389
       composeManifest({…})                                     manifest.ts:940
       composePrompt(manifest, …)              @tm8/prompt → {system, task}
       withAgentPrompt(baseCommand, {system, task}, …)          manifest.ts:585
       composeEnv(manifest, manifestPath, baseUrl, this.env, journalPath, agentToken)   manifest.ts:721
       assertAgentRuntime(…)                   refuse if binary missing (avoids silent exit 127)
       writeManifestFile() + graph.recordManifest(auth, …, envVarNames, prompts)
       trustClaudeWorkspace(cwd, this.env) / trustCodexWorkspace(cwd, this.env)   workspace-trust.ts
    5. pty.spawnIfAbsent({sessionId, command, cwd, env, cols, rows})
    6. graph.transition(auth, {status: 'running'})
```

### 1.2 What the two agents are actually launched as

`buildAgentCommand` (manifest.ts:389) resolves a binary from
`AGENT_TOOL_BINARIES = {'claude-code':'claude', codex:'codex', 'echo-agent':…}`, overridable
node-wide by `TM8_AGENT_CMD`.

**Claude:**
```
claude --permission-mode <auto|acceptEdits|plan|default>   (or --dangerously-skip-permissions)
       --model <m> [--effort <e>] --session-id <uuid>
       --append-system-prompt '<tm8_system_prompt…>'  '<task positional>'
```
**Codex:**
```
codex  --model <m>
       --ask-for-approval <never|untrusted> --sandbox <workspace-write|danger-full-access>
       -c sandbox_workspace_write.network_access=true
       -c features.network_proxy.enabled=true
       -c 'features.network_proxy.domains={"127.0.0.1"="allow","localhost"="allow"}'
       -c features.network_proxy.allow_local_binding=false
       --no-alt-screen [-c model_reasoning_effort=…]
       -c 'developer_instructions="<system>"'  '<task>\n<tm8_session_id>…</tm8_session_id>'
```

Both are launched **verbatim as the tm8 OS user** — there is no wrapper, no `env -i`, no
`setpriv`, no namespace.

### 1.3 The manifest

`composeManifest` (manifest.ts:940) is pure. It records persona, launch config, workdir, project,
interaction-profile pin, tasks. It is written to
`<dataDir>/manifests/<sessionId>.json` (0600, dir 0700) and to `public.session_manifests`.

`session_manifests` (`db/migrations/006_execution_side.sql:22`) stores
`manifest jsonb` + `env_var_names text[]` — **names only**. A trigger
(`internal.guard_manifest_secrets`) hard-fails the write if the manifest text matches
`sk-…|ghp_…|xox[abpr]-…`. That is invariant **S15** (`docs/architecture/10-SECURITY-MODEL.md:57`):
*"Secrets never enter Postgres."*

### 1.4 The terminal

`PtyHostService.spawn` (PtyHostService.ts:394):
```ts
const shell = env.SHELL || process.env.SHELL || this.defaultShell || '/bin/bash';
const proc  = pty.spawn(shell, ['-c', command], { name:'xterm-256color', cols, rows, cwd, env });
// "The caller supplies the COMPLETE allowlisted child environment. Never merge process.env here"
```

**This is the single injection seam. There is exactly one, and it already takes a complete
caller-built environment.** That is the good news: no plumbing has to be invented.

### 1.5 `composeEnv` — what is in the child env today (manifest.ts:721)

| group | keys |
|---|---|
| session contract | `TM8_SESSION_ID`, `TM8_MANIFEST_PATH`, `TM8_BASE_URL`, `TM8_SPACE_ID`, `TM8_MODE`, `TM8_AGENT_TOOL`, `TM8_TEAM_MEMBER_ID`, `TM8_ACTOR_ID`, `TM8_TASK_IDS`, `TM8_PROJECT_ID`, `TM8_MODEL`, `TM8_JOURNAL_PATH`, `TM8_AGENT_TOKEN` |
| `SAFE_BASE_ENV_KEYS` copied from server env | **`HOME`**, `USER`, `LOGNAME`, `SHELL`, `PATH`, `LANG`, `LC_ALL`, `TERM`, `COLORTERM`, `TMPDIR`, `XDG_CONFIG_HOME`, `XDG_CACHE_HOME` |
| `AUTH_ENV_KEYS` copied from server env | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `GOOGLE_GENAI_USE_VERTEXAI`, `GOOGLE_GENAI_USE_GCA` |
| scars | `CLAUDE_CODE_ENTRYPOINT=''`, `CLAUDECODE=''`, `DISABLE_AUTOUPDATER=1`, `NODE_USE_ENV_PROXY` (codex proxy only) |
| PATH surgery | prepend `packages/cli/dist` (the `tm8` binary), append `/opt/homebrew/bin`, `/usr/local/bin`, `$HOME/.local/bin`, `$HOME/.bun/bin`, `$HOME/.volta/bin` |

**Measured, PID 2027909 (a live tm8-spawned `claude`, direct child of the server):**
```
CLAUDECODE=            HOME=/home/tm8         LOGNAME=tm8     USER=tm8
DISABLE_AUTOUPDATER=1  SHELL=/bin/bash        LANG=C.UTF-8    TERM=xterm-256color
PATH=/opt/tm8/prod/packages/cli/dist:/usr/lib/postgresql/16/bin:…:/home/tm8/.local/bin
TM8_* (13 vars)        TM8_AGENT_TOKEN=tm8s_…
```
No `ANTHROPIC_API_KEY` (this node has none), no `GH_TOKEN`. **The allowlist works exactly as
designed.** And that is the point of the next section.

---
