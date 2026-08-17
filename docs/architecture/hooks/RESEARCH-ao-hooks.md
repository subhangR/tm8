# RESEARCH — Agent Orchestrator's hook pipeline, mechanism by mechanism

Status: RESEARCH (findings, not a proposal)
Subject: `github.com/Untrivial-ai/agent-orchestrator` @ `bfb69fb`, local clone `/Users/subhang/Desktop/scratch/agent-orchestrator`
Audience: the tm8 session designing tm8's hook foundation
Method: read the Go source. Every factual claim below carries a `path:line` citation relative to the clone root. Claims I could not verify are listed in §12 and are marked as unverified inline.

> Note on AO's own docs: `DESIGN.md` at the repo root is a stray document for a **different** application and is not AO's design spec. Nothing in this report is sourced from it. Everything here comes from `backend/internal/**/*.go` and the two embedded asset files.

---

## 0. One-paragraph mechanism

AO installs, at workspace-preparation time and per session, a small set of agent-native hook entries whose command is the literal string `ao hooks <agent> <event>`. The command line is **identical for every session** — it carries no identity. When the agent fires a hook, the agent's child process inherits the environment AO gave the agent's PTY, which contains `AO_SESSION_ID`. The `ao hooks` subcommand reads that env var, reads the agent's native JSON payload from stdin, maps `(agent, event, payload)` to one of five activity states through a per-adapter deriver, and `POST`s `{state, event, toolName, toolUseId, agentSessionId, launchId}` to `http://127.0.0.1:<port>/api/v1/sessions/<AO_SESSION_ID>/activity` with **no authentication of any kind**. A lifecycle reducer applies the signal under a set of correlation rules (launch-generation fence, tool-use precedence, sticky states), writes exactly two durable columns (`activity_state`, `is_terminated`) plus a `FirstSignalAt` receipt, and the display status is derived on read and never stored.

---

## 1. Q1 — How hook configuration is written into a workspace at spawn

### 1.1 Where it happens in the spawn sequence

`session_manager` calls the adapter's `GetAgentHooks` from `prepareWorkspace`, **before** the runtime (tmux/conpty pane) is started:

```go
// backend/internal/session_manager/manager.go:2860-2867
agent.GetAgentHooks(ctx, ports.WorkspaceHookConfig{
    SessionID, WorkspacePath, DataDir, Env, SystemPrompt, SystemPromptFile,
})
```

The config struct is `backend/internal/ports/agent.go:234-243`:

```go
type WorkspaceHookConfig struct {
    Config           ...
    DataDir          string
    Env              map[string]string
    SessionID        domain.SessionID
    SystemPrompt     string
    SystemPromptFile string
    WorkspacePath    string
}
```

`GetAgentHooks(ctx, cfg WorkspaceHookConfig) error` is a required method on the `Agent` interface (`backend/internal/ports/agent.go:49-51`). Harnesses with no native hook surface inherit a no-op from the embedded base (`backend/internal/adapters/agent/agentbase/agentbase.go:34-37`).

**Critical detail:** `cfg.SessionID` is passed in but is **not written into the hook file**. It is used only for auxiliary paths (e.g. the system-prompt file). The hook command string is a compile-time constant per adapter. Identity travels by environment — see §4.

### 1.2 Three install strategies

| Strategy | Adapters | Artifact |
|---|---|---|
| Matcher-group JSON file in the worktree | claude-code, grok, droid, goose, qwen, cursor, copilot, kiro, autohand, cline | a JSON settings file |
| Bespoke JSON writer (same shape, own code) | agy | `.gemini/hooks.json` |
| TOML file | vibe | `hooks.toml` |
| Launch-command `-c` session flags (no workspace file at all) | codex | argv only |
| Embedded TypeScript plugin | opencode, kilocode | `.opencode/plugins/ao-activity.ts` |
| Instructions-file only (no hooks) | kimi (`AGENTS.md`), amp (`ao-system-prompt.ts`) | not an activity pipeline |

Per-adapter paths and command prefixes, all verified:

| Agent | File path (relative to worktree) | Command prefix | Timeout |
|---|---|---|---|
| claude-code | `.claude/settings.local.json` | `ao hooks claude-code ` | `30` |
| grok | `.claude/settings.local.json` | `ao hooks grok ` | (n/a in const block) |
| droid | `.factory/<hooks file>` | `ao hooks droid ` | — |
| goose | `.agents/plugins/ao/hooks/hooks.json` | `ao hooks goose ` | `30` |
| qwen | `.qwen/settings.json` | `ao hooks qwen ` | `30000` |
| cursor | `hooks.json` | `ao hooks cursor ` | — |
| copilot | `ao.json` | `ao hooks copilot ` | — |
| kiro | `agents/ao.json` | `ao hooks kiro ` | — |
| cline | `.clinerules/…` | `ao hooks cline ` | — |
| autohand | `config.json` | `ao hooks autohand ` | — |
| agy | `.gemini/hooks.json` | `ao hooks agy ` | — |
| vibe | `hooks.toml` | (TOML) | — |
| opencode | `.opencode/plugins/ao-activity.ts` | `ao hooks opencode ` | `30_000` ms |
| kilocode | `.kilocode/…/ao-activity.ts` | `ao hooks kilocode ` | — |
| **codex** | **none — argv `-c` flags** | `ao hooks codex ` | `5` |

Citations: `claudecode/hooks.go:12-15`; `grok/grok.go:52-53,255`; `droid/hooks.go:12,17,46`; `goose/hooks.go:15-24,46-48`; `qwen/hooks.go:12-21,48`; `cursor/hooks.go:21,34`; `copilot/hooks.go:21,33`; `kiro/hooks.go:23-29`; `cline/hooks.go:27,32`; `autohand/hooks.go:18,23`; `agy/hooks.go:17-20`; `vibe/hooks.go:17`; `opencode/hooks.go:25,33,44`; `kilocode/hooks.go:23,31,42`; `codex/hooks.go:31,36,40`; `kimi/hooks.go:17`; `amp/hooks.go:18`.
(All paths are under `backend/internal/adapters/agent/`.)

Note the qwen timeout of `30000` versus claude's `30` — the same field means milliseconds in one harness and seconds in another. That asymmetry is per-harness contract, not an AO abstraction.

### 1.3 The shared matcher-group installer — exact content produced

`backend/internal/adapters/agent/hooksjson/hooksjson.go` is the shared writer. Its wire types (`:27-48`):

```go
type HookEntry struct {
    Type    string `json:"type"`
    Command string `json:"command"`
    Timeout int    `json:"timeout,omitempty"`
}
type MatcherGroup struct {
    Matcher *string     `json:"matcher,omitempty"`
    Hooks   []HookEntry `json:"hooks"`
}
type HookSpec struct{ Event, Matcher, Command ... }
```

`Install` (`hooksjson.go:73-108`) is **read-preserving**: `readHooksFile` (`:207-230`) keeps every top-level key it does not own, `reconcileHook` (`:287-302`) removes every existing copy of AO's command and re-adds it under its declared matcher (so a matcher or timeout change never duplicates an entry), `removeManaged` (`:319-334`) strips by command prefix and drops emptied groups, and `writeHooksFile` (`:234-257`) serialises with `json.MarshalIndent(topLevel, "", "  ")`, appends `'\n'`, and writes via `hookutil.AtomicWriteFile(path, data, 0o600)`.

So for claude-code the file AO produces at `<worktree>/.claude/settings.local.json` is exactly (shape verified from the types plus `claudeManagedHooks` at `claudecode/hooks.go:37-47`; the concrete rendered bytes are inferred from `MarshalIndent`, not captured from a run):

```json
{
  "hooks": {
    "SessionStart": [
      { "matcher": "startup",
        "hooks": [ { "type": "command", "command": "ao hooks claude-code session-start", "timeout": 30 } ] }
    ],
    "UserPromptSubmit": [
      { "hooks": [ { "type": "command", "command": "ao hooks claude-code user-prompt-submit", "timeout": 30 } ] }
    ],
    "PreToolUse":         [ { "hooks": [ { "type": "command", "command": "ao hooks claude-code pre-tool-use", "timeout": 30 } ] } ],
    "PostToolUse":        [ { "hooks": [ { "type": "command", "command": "ao hooks claude-code post-tool-use", "timeout": 30 } ] } ],
    "PostToolUseFailure": [ { "hooks": [ { "type": "command", "command": "ao hooks claude-code post-tool-use-failure", "timeout": 30 } ] } ],
    "PermissionRequest":  [ { "hooks": [ { "type": "command", "command": "ao hooks claude-code permission-request", "timeout": 30 } ] } ],
    "Stop":               [ { "hooks": [ { "type": "command", "command": "ao hooks claude-code stop", "timeout": 30 } ] } ],
    "Notification":       [ { "hooks": [ { "type": "command", "command": "ao hooks claude-code notification", "timeout": 30 } ] } ],
    "SessionEnd":         [ { "hooks": [ { "type": "command", "command": "ao hooks claude-code session-end", "timeout": 30 } ] } ]
  }
}
```

`claudeStartupMatcher = "startup"` (`claudecode/hooks.go:20`) is the only matcher AO sets; everything else uses the nil matcher (key omitted).

### 1.4 Two operational details worth stealing outright

**Atomic write.** `hookutil.AtomicWriteFile` (`hookutil/hookutil.go:67-90`) writes a temp file in the *same directory*, then Write → Chmod → Sync → Close → Rename. An agent reading the settings file concurrently never sees a half-written file.

**Self-ignoring `.gitignore`.** `hookutil.EnsureWorkspaceGitignore` (`hookutil/hookutil.go:30-54`) writes `<dir>/.gitignore` containing a sentinel line plus `/.gitignore` plus each managed file name:

```
# managed by agent-orchestrator: AO hook files stay out of git status
```
(`hookutil/hookutil.go:17`)

The rationale is at `hookutil/hookutil.go:21-25`: `git worktree remove` without `--force` refuses to run when **any** untracked file exists. AO's own hook config would therefore block its own teardown. If a `.gitignore` already exists at that path and does not carry the sentinel, AO leaves it alone and the install proceeds anyway (`:30-54`) — the worktree stays dirty and teardown will need `--force`, which is the deliberate safe degradation.

### 1.5 Codex is the exception that proves the rule

`codex/hooks.go:16-28` states plainly: Codex 0.136+ **never loads hook config from AO's per-session worktrees** — project-local `.codex/` only loads for trusted projects, and for linked worktrees Codex sources config from the *root* checkout, not the worktree. So AO installs codex hooks as launch flags:

```go
// backend/internal/adapters/agent/codex/hooks.go:78-84
flag := fmt.Sprintf(`hooks.%s=[{hooks=[{type="command",command=%s,timeout=%d}]}]`,
    spec.Event, codexTOMLBasicString(spec.Command), codexHookTimeout)
*cmd = append(*cmd, "-c", flag)
```

plus a trust flag for both the literal and the symlink-resolved workspace path (`codex/hooks.go:97-111`):

```
-c projects={'<path>'={trust_level="trusted"}}
```

and `--dangerously-bypass-hook-trust`. `GetAgentHooks` for codex now only calls `removeLegacyWorkspaceHooks` (`codex/hooks.go:160-171`) — it deletes what older AO versions wrote and installs nothing.

**Lesson for tm8:** the workspace-file install strategy is not universal. At least one major harness requires the config to ride the *launch command*. A hook foundation that assumes "write a file into the workspace" will fail on that class of agent.

### 1.6 The opencode plugin — exact embedded content

`opencode/hooks.go:68-69` embeds the asset:

```go
//go:embed assets/ao-activity.ts
var opencodePluginSource string
```

It is written verbatim to `<worktree>/.opencode/plugins/ao-activity.ts`, via `AtomicWriteFile` (`opencode/hooks.go:114`) followed by the gitignore call (`:117`). If a file already exists at that path and does **not** begin with the sentinel `agent-orchestrator: managed opencode activity plugin` (`opencode/hooks.go:38`), the install **fails loudly rather than overwriting** (`opencode/hooks.go:99-109`). That is a good pattern: AO refuses to silently destroy a user's plugin.

The plugin's own shell-out (`opencode/assets/ao-activity.ts:37-39`):

```ts
const hookCmd = (hookName: string) => ["sh", "-c",
  `if ! command -v ao >/dev/null 2>&1; then exit 0; fi; exec ao hooks opencode ${hookName}`];
```

and its invocation (`ao-activity.ts:69-75`):

```ts
Bun.spawnSync(hookCmd(hookName), {
  cwd: directory,
  stdin: new TextEncoder().encode(JSON.stringify(payload) + "\n"),
  stdout: "ignore",
  stderr: "pipe",
  timeout: HOOK_TIMEOUT_MS,   // 30_000, ao-activity.ts:24
});
```

The choice of **synchronous** spawn is documented at `ao-activity.ts:54-66`: it guarantees ordering, and `opencode run` exits on idle — an async spawn would be killed before it delivered.

---

## 2. Q2 — The full event vocabulary, per agent

The `<event>` token in `ao hooks <agent> <event>` is **AO's own kebab-case name**, not the harness's native event name. The adapter's install table maps native event → AO token; the adapter's deriver maps AO token → activity state. Both live next to each other on purpose (see the comment at `droid/activity.go:15-18`).

### 2.1 claude-code — the full nine

`backend/internal/adapters/agent/claudecode/hooks.go:37-47`:

| # | Native event | AO token | Derived state | Source |
|---|---|---|---|---|
| 1 | `SessionStart` (matcher `startup`) | `session-start` | *(none)* — metadata only | `claudecode/activity.go:19-52` |
| 2 | `UserPromptSubmit` | `user-prompt-submit` | `active` | `:20-21` |
| 3 | `PreToolUse` | `pre-tool-use` | `active` | `:22-27` |
| 4 | `PostToolUse` | `post-tool-use` | `active` | `:22-27` |
| 5 | `PostToolUseFailure` | `post-tool-use-failure` | `active` | `:22-27` |
| 6 | `PermissionRequest` | `permission-request` | **`blocked`** | `:28-31` |
| 7 | `Stop` | `stop` | `idle` | `:32-33` |
| 8 | `Notification` | `notification` | *depends on payload* | `:34-35` → `:73-88` |
| 9 | `SessionEnd` | `session-end` | *depends on payload* | `:36-37` → `:97-108` |

Two payload-sensitive derivations:

```
notificationState(notification_type)   // claudecode/activity.go:73-88
  "idle_prompt"       -> idle
  "agent_completed"   -> idle
  "agent_needs_input" -> waiting_input
  "permission_prompt" -> blocked
  otherwise           -> (no signal)

sessionEndState(reason)                // claudecode/activity.go:97-108
  "clear"  -> (no signal)   // same AO session continues
  "resume" -> (no signal)
  anything else -> exited
```

The default arm of `DeriveActivityState` returns `("", false)` (`claudecode/activity.go:19-52`) — an unrecognised event reports nothing rather than guessing.

`grok` reuses claude-code's deriver verbatim (`activitydispatch/dispatch.go:33`) and installs the identical nine events (`grok/grok.go:64-74`).

### 2.2 Every other adapter

| Agent | Installed events (AO tokens) | Deriver | Notable |
|---|---|---|---|
| claude-code | session-start, user-prompt-submit, pre/post/post-failure-tool-use, permission-request, stop, notification, session-end | `claudecode.DeriveActivityState` | only harness with the full tool trio |
| grok | same nine | `claudecode.DeriveActivityState` | `grok/grok.go:64-74` |
| codex | session-start, user-prompt-submit, permission-request, stop | `codex.DeriveActivityState` | `codex/hooks.go:69-74` |
| droid | session-start, user-prompt-submit, stop, notification, session-end | `droid.DeriveActivityState` | `droid/hooks.go:28-34` |
| agy | session-start, session-end, before-agent, after-agent, after-tool | `agy.DeriveActivityState` | different native vocabulary entirely; `agy/hooks.go:42-48` |
| goose | session-start, user-prompt-submit, stop | standard | "Goose has no permission/approval lifecycle event yet" — `goose/hooks.go:27-29` |
| devin | session-start, user-prompt-submit, stop, session-end | standard | `devin/hooks.go:17-22` |
| qwen | session-start, user-prompt-submit, permission-request, stop | standard | `qwen/hooks.go:31-36` |
| opencode | session-start, user-prompt-submit, stop | `opencode.DeriveActivityState` | `opencode/hooks.go:74` |
| cursor, copilot, kimi, cline, kiro, kilocode, autohand | (per-adapter; standard set) | standard | `activitydispatch/dispatch.go:38-47` |
| vibe | — | `vibe.DeriveActivityState` | TOML install |
| fake | — | `fake.DeriveActivityState` | test harness |

The shared "standard" deriver (`activitystate/activitystate.go:24-37`) is name-only, payload-blind:

```
session-start       -> active
user-prompt-submit  -> active
stop                -> idle
permission-request  -> waiting_input      // NOT blocked
default             -> (no signal)
```

The rationale for `permission-request → waiting_input` instead of `blocked` is given in that file: *none of the sharing adapters install the pre/post-tool-use trio, so a `blocked` state could never be cleared before the turn ends.* This is a deliberate downgrade of fidelity to preserve safety of clearing — see §5.

Droid's variant is even more explicit about the fidelity loss (`droid/activity.go:20-28`): Droid's `Notification` payload has no `notification_type` discriminator, and Droid fires it both for permission decisions *and* after 60s idle-awaiting-input. AO cannot tell them apart, so every Droid notification maps to `waiting_input` — which suppresses automated nudges in both cases, while avoiding a `blocked` that would linger to the turn boundary and reject legitimate user sends at a safe prompt.

Agy's deriver (`agy/activity.go:12-27`): `before-agent → active`, `after-agent → idle`, `after-tool → active`, `session-end → exited`, `session-start → (none)`.

### 2.3 The registry

`activitydispatch/dispatch.go:29-50` is the single map from the `<agent>` token to a deriver. The package comment (`:1-8`) states the invariant bluntly: *"Every adapter that installs `ao hooks <tok>` callbacks must have a deriver registered here — otherwise the adapter writes callbacks that nothing on the receiving side understands, so its activity is silently never reported."* There is no compile-time check enforcing this; it is a convention held by review.

---

## 3. Q3 — What the hook command actually executes

`backend/internal/cli/hooks.go`, 259 lines. It is a **hidden** cobra command:

```go
// backend/internal/cli/hooks.go:121-131
Use:    "hooks <agent> <event>",
Hidden: true,
Args:   cobra.ExactArgs(2),
```

### 3.1 The full path, `runHook` (`hooks.go:133-181`)

1. **Read identity from env, validate, bail silently if absent:**
   ```go
   sessionID := strings.TrimSpace(os.Getenv("AO_SESSION_ID"))
   if !sessionIDPattern.MatchString(sessionID) { return nil }   // :134-140
   ```
   `sessionIDPattern = regexp.MustCompile("^[A-Za-z0-9_-]+$")` (`hooks.go:24`). A hook fired outside an AO session is a no-op with exit 0. This also bounds what can reach the URL path.

2. **Read the agent's native payload from stdin:** `payload, err := io.ReadAll(c.deps.In)` (`hooks.go:141`).

3. **Derive:** `state, hasActivity := activitydispatch.Derive(agent, event, payload)` (`hooks.go:152`).

4. **Extract correlation metadata from the payload** — `activityMeta` (`hooks.go:63-76`) unmarshals `tool_name` and `tool_use_id`; `hookAgentSessionID` (`hooks.go:82-104`) accepts any of `session_id`, `sessionId`, `conversation_id`, `conversationId`. Fields longer than `maxActivityMetaLen = 256` (`hooks.go:56`) are **dropped entirely, never truncated** — a truncated tool-use id would correlate to the wrong tool, which is worse than no correlation.

5. **Build the path and body:**
   ```go
   path := "sessions/" + url.PathEscape(sessionID) + "/activity"        // :164
   req := setActivityAPIRequest{
       State:          state,          // omitted when hasActivity == false
       Event:          event,
       ToolName:       toolName,
       ToolUseID:      toolUseID,
       AgentSessionID: agentSessionID,
       LaunchID:       validLaunchID(os.Getenv("AO_RUNTIME_LAUNCH_ID")),
   }                                                                    // :165-171
   ```
   The body type (`hooks.go:43-50`):
   ```go
   type setActivityAPIRequest struct {
       State          string `json:"state,omitempty"`
       Event          string `json:"event,omitempty"`
       ToolName       string `json:"toolName,omitempty"`
       ToolUseID      string `json:"toolUseId,omitempty"`
       AgentSessionID string `json:"agentSessionId,omitempty"`
       LaunchID       string `json:"launchId,omitempty"`
   }
   ```

6. **POST:** `c.postJSON(ctx, path, req, nil)` (`hooks.go:175`).

7. **Never fail the agent:** on error it calls `reportHookFailure` and then `return nil` (`hooks.go:175-181`). **The hook process always exits 0.**

### 3.2 The transport — and the absence of auth

`backend/internal/cli/client.go`:

- `postJSON` → `doJSON` → `doJSONPath(ctx, method, "/api/v1/"+path, ...)` (`client.go:67-69, 90`).
- It loads AO's config, reads the daemon's run-file for the live port, and refuses if the daemon PID is not alive (`client.go:107-120`).
- URL construction (`client.go:130`):
  ```go
  url := fmt.Sprintf("http://%s:%d%s", config.LoopbackHost, info.Port, path)
  ```
- Headers (`client.go:135-140`): `Content-Type: application/json` plus any caller-supplied headers. **There is no `Authorization` header, no token, no signature, nowhere on this path.**
- `commandTimeout = 2 * time.Minute` (`client.go:20`).

`config.LoopbackHost = "127.0.0.1"` (`config/config.go:25`), and the comment above it (`config/config.go:20-24`) is the whole security model stated out loud:

> *"LoopbackHost is the only host the daemon ever binds. There is deliberately no AO_HOST env var: the daemon has no auth/CORS/TLS and a stray AO_HOST=0.0.0.0 would turn it into a public no-auth service."*

The router confirms it: the middleware stack is `RequestID`, `RealIP`, `requestLogger`, `recoverTelemetry`, `corsMiddleware`, `previewOriginMiddleware` (`httpd/router.go:51-56`). No authentication middleware exists.

### 3.3 The endpoint

Registered at `httpd/controllers/sessions.go:148`:

```go
r.Post("/sessions/{sessionId}/activity", c.activity)
```

Handler `c.activity` (`sessions.go:982-1029`):
- decodes `SetActivityRequest` (`controllers/dto.go:607-614`);
- validates `state` against the five domain constants, else `400 INVALID_ACTIVITY_STATE`;
- requires at least `state` **or** `agentSessionId`, else `400 ACTIVITY_OR_SESSION_ID_REQUIRED`;
- sanitises control characters and caps every metadata field at 256 chars, **dropping** rather than truncating (`capActivityMeta`, `sessions.go:1033-1039`);
- builds `ports.ActivitySignal{Valid: state != "", State, Event, ToolName, ToolUseID, AgentSessionID, LaunchID}` (`ports/runtime_observations.go:41-53`);
- calls `c.Activity.ApplyActivitySignal(ctx, sessionID(r), sig)`;
- maps `ErrSessionNotFound` to `404 SESSION_NOT_FOUND`.

`Valid: state != ""` is how a metadata-only `SessionStart` persists the native agent session id without inventing an activity transition (`ports/runtime_observations.go:29-33`).

### 3.4 The one thing a hook writes back to the agent

Two adapters (agy, devin) get a `SessionStart` hook that returns content on **stdout** for the agent to consume: `shouldEmitSessionStartContext` (`cli/hooks.go:191-224`) emits a `hookSpecificOutput.additionalContext` object whose text is read from `$AO_DATA_DIR/prompts/<sessionID>/system.md`. This is the only place AO's hooks influence the agent rather than merely observing it.

---

## 4. Q4 — How session identity reaches the hook process

**This is the single most important mechanism and it is remarkably plain: it is one inherited environment variable.**

### 4.1 The variable

```go
// backend/internal/session_manager/manager.go:78-91
EnvSessionID          = "AO_SESSION_ID"          // :79
EnvProjectID          = "AO_PROJECT_ID"          // :80
EnvIssueID            = "AO_ISSUE_ID"            // :81
EnvRuntimeLaunchID    = "AO_RUNTIME_LAUNCH_ID"   // :83
EnvDataDir            = "AO_DATA_DIR"            // :85
EnvBrowserCapability  = ...                      // :87
EnvBrowserRuntimeToken= ...                      // :90
```

### 4.2 How it is set, and why the ordering matters

`spawnEnv` (`manager.go:2681-2691`) merges project-supplied environment **first** and AO's internal variables **last**, so that a project's own env config *cannot override* `AO_SESSION_ID` and friends. That ordering is a deliberate integrity property, not incidental.

`runtimeEnv` (`manager.go:2700-2714`) is `spawnEnv` plus the browser capability vars plus a **pinned PATH**.

### 4.3 The PATH pin — the second half of the identity story

The hook command is the bare word `ao` (`manager.go:93-97`: `hookBinaryName = "ao"`, with the comment *"every agent adapter installs a bare `ao hooks <agent> <event>`"*). Which `ao` that resolves to determines which daemon receives the callback. `HookPATH` (`manager.go:2723-2744`) prepends `filepath.Dir(exe)` to PATH and errors if the running executable is not named `ao`.

If the pin fails, AO logs (`manager.go:2708`):

> *"session PATH not pinned to the daemon binary; `ao hooks` callbacks may resolve to a different ao and activity tracking will stall"*

— and spawns anyway. The degradation is a silent activity stall, caught later by the no-signal grace (§8).

### 4.4 Inheritance chain

```
daemon (ao)
  └─ tmux/conpty pane, env = runtimeEnv  (AO_SESSION_ID, AO_RUNTIME_LAUNCH_ID, AO_DATA_DIR, PATH pinned)
      └─ agent process (claude / codex / opencode …)
          └─ hook child process: `sh -c "ao hooks claude-code pre-tool-use"`
              └─ inherits AO_SESSION_ID ──► becomes the URL path segment
```

### 4.5 What this means for tm8 — say it plainly

- Identity is **ambient**, not in the config file and not in argv. The same hook file works for every session because the env differs.
- The consequence: **any process that can read or guess `AO_SESSION_ID` can assert any activity state for that session**, because the endpoint is unauthenticated. A subshell the agent spawns, a background daemon started inside the worktree, a stale process from a previous launch — all can POST. AO's only defences are (a) loopback binding and (b) the launch-generation fence (§5.1), which is an ordering defence, not an authorisation one.
- `AO_RUNTIME_LAUNCH_ID` is set only when the adapter declares `AgentExitDetectionSupervisor`; otherwise `superviseAgentProcess` **deletes** the variable (`manager.go:3324-3341`). When present, AO wraps argv as `<exe> agent-process supervise --session <id> --launch <id> -- <argv...>`. So the fence is a per-adapter capability, not universal.

---

## 5. Q5 — How state is computed and correlated

The reducer is `backend/internal/lifecycle/manager.go` (775 lines). Its package comment (`:1-5`) states the storage doctrine:

> *"activity_state plus an is_terminated bit are the only persisted status-like facts on the session row."*

The vocabulary (`domain/activity.go:20-26`): `active | idle | waiting_input | blocked | exited`, with `IsSticky()` (`:30-32`) = {waiting_input, blocked} and `NeedsInput()` (`:38-40`) = {waiting_input, blocked}.

The `waiting_input` vs `blocked` distinction is doctrinal (`domain/activity.go:9-19`): `waiting_input` = awaiting the next *instruction*, safe to nudge; `blocked` = a pending *decision* where *"a stray keystroke could answer the dialog on the user's behalf. Automated senders must never inject input into a blocked session."*

### 5.1 `ApplyActivitySignal` — the ordered gate list (`lifecycle/manager.go:301-439`)

1. **Launch rendezvous** (`:309-322`): if the signal's `LaunchID` matches a *pending* launch, wait on `pendingLaunches[id].ready`. This closes the race where a hook fires before the spawn transaction has committed the session row. (`PrepareLaunch`/`CancelLaunch`/`finishLaunchLocked` at `:168-203`.)
2. **Terminated short-circuit** (`:333-337`): drop in-flight tool tracking, return nil.
3. **Generation fence** (`:338-341`):
   ```go
   if s.LaunchID != "" && s.LaunchID != rec.Metadata.RuntimeLaunchID { return nil }
   ```
   A signal from a previous process generation of the same session is discarded.
4. **CAS** (`:342-346`): `ExpectedUpdatedAt`, used only by the reconciliation observer (§6), never by hooks.
5. **Resurrection rule** (`:350-354`): a session already in `exited` is only revived by `active` + `user-prompt-submit`. Nothing else brings a dead agent back.
6. **Tool precedence** (`:361-363`): `s = m.applyToolPrecedenceLocked(id, rec.Activity.State, s)` — see §5.2.
7. **Receipt write** (`:389-403`): a same-state repeat is *still* a durable write when `FirstSignalAt` is zero, because *"the receipt itself is a durable fact — it clears the no_signal display status"*. `next.FirstSignalAt = timeOr(s.Timestamp, now)`.
8. **Exit handling** (`:404-410`): `exited` drops tool flights but explicitly does **not** set `IsTerminated`. Activity and lifecycle stay orthogonal.
9. **Notification edges** (`:419-430`): entering the needs-input family emits `NotificationNeedsInput`; escalating *within* the family (waiting_input → blocked) does not re-notify; `needsInputResolutions` (`:233-245`) closes the notification on exit from the family.

`sameActivity` (`:756-758`) ignores `LastActivityAt`, so same-state repeats do not fan out CDC events.

### 5.2 Tool correlation — how `blocked` is set and cleared

The state:

```go
// backend/internal/lifecycle/manager.go:451-463
type toolFlight struct {
    inflight         map[string]string // tool_use_id -> tool_name
    blockedCandidate string            // the tool_use_id whose completion clears blocked
}
```

It is **in-memory only**. The doc comment is explicit: a daemon restart loses it and the session degrades to clearing at the next turn boundary — *"fail-safe staleness, never a spurious clear."*

Constants: `maxInflightTools = 128` (`:468`); `isToolUseEvent` (`:472-474`); `isTurnBoundaryEvent` = `user-prompt-submit | stop | session-end | process-exited` (`:479-481`).

`applyToolPrecedenceLocked` (`:490-590`):

- **`:491-493`** — an untagged signal (`Event == ""`) passes through untouched. Old CLIs and payload-less adapters keep plain last-writer-wins semantics.
- **`:507-520`** — tracking: `pre-tool-use` records `inflight[ToolUseID] = ToolName`; at the 128 cap the map is reset rather than grown. `post-tool-use` / `post-tool-use-failure` delete the entry.
- **`:522-555`** — **entering `blocked`**: recompute `blockedCandidate` from scratch. Set it **only when exactly one in-flight tool bears the dialog's `tool_name`**. Two matching tools, or zero, leaves the candidate empty — fail closed, meaning the block will only clear at a turn boundary.
- **`:557-577`** — **while `cur == blocked`**: a turn-boundary event clears it (and drops flights); a `post-tool-use`/`post-tool-use-failure` whose `ToolUseID == fl.blockedCandidate` clears it; **every other signal is suppressed**. This is what stops subagent traffic, sibling tool calls, and notification sub-types from silently un-blocking a session that is genuinely sitting on a permission dialog.
- **`:579-582`** — while sticky `waiting_input`: tool-use events are suppressed for the same reason.

**This is the sharpest idea in AO's pipeline.** A permission dialog is a *sticky* state that ordinary busy-signals must not clear, and the only two things allowed to clear it are (a) the end of the turn, or (b) the completion of the exact tool call the dialog was about. Correlating on the harness's own `tool_use_id` is what makes (b) possible.

It also only works on claude-code and grok, because only they install the pre/post-tool-use trio. Everywhere else `permission-request` degrades to `waiting_input`, which is cleared by any subsequent state change.

### 5.3 Telemetry

`waitingInputEvents` (`lifecycle/manager.go:592-633`) emits `ao.session.waiting_input_entered` / `ao.session.waiting_input_exited` with a `dwell_ms` attribute — a directly useful measure of how long a session sat waiting on a human.

### 5.4 The write barrier that consumes the state

`backend/internal/sessionguard/guard.go` is the consumer that makes the vocabulary earn its keep. Its doctrine (`:1-9`): re-read the session **immediately before writing** to the pane and refuse when the paste could land somewhere only the user may act — *"the runtime appends Enter after every paste."*

Three policies:
- `Deliver` (`:119-123`) — a user-initiated message. Refuses only `blocked`. `waiting_input` does **not** suppress: an idle prompt is exactly where a user's message belongs.
- `Nudge` (`:129-133`) — an AO-initiated message. Refuses the whole `NeedsInput()` family.
- `NudgeCoordination` (`:142-152`) — refuses `NeedsInput()`, and additionally refuses `active` unless the harness's `steersActiveTurn` predicate says it can be steered. **A nil predicate means "cannot steer"** — an unknown harness never takes an unsolicited write mid-turn.

`Outcome`'s zero value is `SuppressedUnknown` (`:32-56`), deliberately: *"a forgotten assignment must never read as a successful send."* And `send` (`:160-185`) fails closed on a store read error.

There is a documented trap here worth carrying over: `Guard.Send` (`:109-112`) satisfies `ports.AgentMessenger` but **folds a suppressed outcome into `nil`**. The comment (`:100-108`) warns that any path whose success contract depends on the write actually landing (spawn/restore prompt injection) must call `Deliver` directly and map non-`Sent` to an error — otherwise a session that blocked before injection is reported as a successful spawn with a prompt that was never delivered.

---

## 6. Q6 — Reconciliation, fallbacks, and every number

### 6.1 The three independent producers, in confidence order

1. **Hooks** — authoritative, push, per-event. (§3)
2. **Terminal markers** — one adapter only. `codex/terminal_activity.go`: strip ANSI (`:10`), take the last 12 non-empty lines (`:18`), return `("", false)` if any line contains `esc to interrupt` (`:22-26`), otherwise require a line starting with `›` whose next line contains `" · "` and return `(ActivityIdle, true)` (`:27-33`). It can only ever produce **idle**, never busy.
3. **Process liveness** — the reaper. `observe/reaper/reaper.go:20`: `DefaultTickInterval = 5 * time.Second`. Its doctrine (`:1-6`): *"The reaper only reports facts — it never writes session rows directly… A probe error is reported as a probe-failure fact, never collapsed to 'alive' or 'dead'."*

### 6.2 The activity observer — the terminal-marker reconciler

`backend/internal/observe/activity/observer.go`:

```go
DefaultTickInterval = 30 * time.Second   // :14-18
DefaultStaleAfter   = 2 * time.Minute
DefaultOutputLines  = 40
```

Preconditions before it will even look (`:103-108`): not terminated **and** `Activity.State == ActivityActive` **and** `LastActivityAt` non-zero **and** `now.Sub(LastActivityAt) >= staleAfter` **and** `RuntimeHandleID` non-empty. Then it requires the adapter to implement `ports.TerminalActivityDetector` (`:113-116`) — only codex does (`codex/codex.go:67`). It acts only if the detector returns `ActivityIdle` (`:122-125`).

Its emitted signal (`:126-133`) is what makes the fallback safe against races:

```go
ports.ActivitySignal{
    Valid: true, State: state, Timestamp: now,
    ExpectedUpdatedAt: session.UpdatedAt,      // CAS
    Event: "terminal-idle",
    LaunchID: session.Metadata.RuntimeLaunchID, // fence
}
```

The CAS means a hook that landed between the read and the write wins. The fence means an observation about an older process generation is discarded. **The fallback can never overwrite a fresher authoritative signal.**

### 6.3 Supervised process exit

`cli/agent_process.go:81-91` — when the supervisor wrapper sees the agent process exit, it POSTs the same activity endpoint with:

```json
{ "state": "exited", "event": "process-exited", "launchId": "<launch>" }
```

with `supervisedExitReportTimeout = 5 * time.Second` (`:15`). On failure it logs to the hooks log with the comment *"Reconciliation will recover this event from process absence."*

Note `process-exited` is in `isTurnBoundaryEvent` (`lifecycle/manager.go:479-481`), so a process exit also clears a stuck `blocked`.

### 6.4 Every timing and bound constant, in one place

| Constant | Value | Source |
|---|---|---|
| reaper tick | 5 s | `observe/reaper/reaper.go:20` |
| activity observer tick | 30 s | `observe/activity/observer.go:14-18` |
| activity observer stale-after | 2 min | same |
| activity observer output lines scanned | 40 | same |
| codex terminal-marker window | last 12 non-empty lines | `codex/terminal_activity.go:18` |
| no-signal grace | **90 s** | `service/session/status.go:16` |
| claude-code hook timeout | 30 (s) | `claudecode/hooks.go:15` |
| goose hook timeout | 30 (s) | `goose/hooks.go:24` |
| qwen hook timeout | 30000 (ms) | `qwen/hooks.go:21` |
| codex hook timeout | 5 (s) | `codex/hooks.go:40` |
| opencode plugin hook timeout | 30_000 ms | `opencode/assets/ao-activity.ts:24` |
| supervised exit report timeout | 5 s | `cli/agent_process.go:15` |
| CLI HTTP command timeout | 2 min | `cli/client.go:20` |
| doctor hooks.log lookback | 24 h | `cli/doctor.go:352` |
| max in-flight tools tracked | 128 | `lifecycle/manager.go:468` |
| max activity metadata field length | 256 (dropped, not truncated) | `cli/hooks.go:56`; `controllers/sessions.go:1033-1039` |
| hooks.log cap | 1 MiB, truncate on overflow | `cli/hooks.go:34` |
| hook file mode | `0o600` | `hooksjson/hooksjson.go:234-257` |

---

## 7. Q7 — Per-adapter capability declaration

### 7.1 The interfaces

`backend/internal/ports/agent.go:120-152`:

```go
type ActivitySignaler interface {
    EmitsSubmitActivity() bool
    EmitsBlockedActivity() bool
}
```

The doc comment there says it outright: *"Only claude-code satisfies both halves… codex maps permission-request to waiting_input and opts out (no tool trio → blocked could not be cleared). Every other harness simply does not implement this interface."*

`ports/agent.go:154-162`:

```go
type ActiveTurnSteerer interface { SteersActiveTurn() bool }
```

Non-implementers are treated as unsafe to steer (`daemon/lifecycle_wiring.go:88-93`: `return ok && steerer.SteersActiveTurn()`).

`ports.TerminalActivityDetector` — implemented only by codex (`codex/codex.go:67`).

`activitydispatch.SupportsHarness(h)` (`activitydispatch/dispatch.go:69-72`) is the fourth, structural capability: does this harness have an activity pipeline *at all*.

### 7.2 The declarations

| Harness | `EmitsSubmitActivity` | `EmitsBlockedActivity` | `SteersActiveTurn` | `TerminalActivityDetector` | `SupportsHarness` |
|---|---|---|---|---|---|
| claude-code | ✅ `claudecode/claudecode.go:68` | ✅ `:75` | not declared → no | no | ✅ |
| codex | ✅ `codex/codex.go:42` | ❌ `:49` (documented) | ✅ `:61` | ✅ `:67` | ✅ |
| grok | not declared | not declared | not declared | no | ✅ |
| droid, agy, opencode, vibe, goose, devin, cursor, qwen, copilot, kimi, cline, kiro, kilocode, autohand | not declared | not declared | not declared | no | ✅ |
| any harness absent from `Derivers` | — | — | — | — | ❌ |

### 7.3 What the declarations gate

- **`EmitsSubmitActivity && EmitsBlockedActivity`** gates the "confirm the session actually went active" path in the session manager (`session_manager/manager.go:2088-2089`): `return ok && s.EmitsSubmitActivity() && s.EmitsBlockedActivity()`. Only a harness that reports both a turn start *and* a block can be trusted to confirm.
- **`SteersActiveTurn`** gates `Guard.NudgeCoordination` mid-turn writes (`sessionguard/guard.go:142-152`), resolved per-harness at `daemon/lifecycle_wiring.go:88-93`.
- **`TerminalActivityDetector`** gates the entire terminal-marker reconciler (`observe/activity/observer.go:113-116`).
- **`SupportsHarness`** gates whether prolonged silence is read as `no_signal` or as ordinary `idle` (`service/session/status.go:21-25, 51-53`).

**The pattern to steal: capability is declared by the adapter, never inferred, and each declaration gates exactly one behaviour. A harness that declares nothing gets the most conservative treatment on every axis.**

---

## 8. Q8 — Failure modes: what AO does when the pipeline breaks

### 8.1 Hooks fail silently by design

`runHook` returns `nil` on every error path (`cli/hooks.go:175-181`). `doctor.go:325-328` explains why and what the consequence is:

> *"`ao hooks` callbacks deliberately swallow errors (a hook must never break the user's agent), so `$AO_DATA_DIR/hooks.log` is the only place a dead activity feed becomes visible."*

`reportHookFailure` (`cli/hooks.go:229-258`) writes to stderr and best-effort appends an RFC3339-prefixed line to `$AO_DATA_DIR/hooks.log`, capped at `maxHooksLogBytes = 1 << 20` (`:34`) with truncate-on-overflow.

The opencode plugin degrades even earlier: `if ! command -v ao >/dev/null 2>&1; then exit 0; fi` (`ao-activity.ts:37-39`). If the binary is not on PATH, the hook is a silent no-op.

### 8.2 The one place it becomes visible

`checkHooksLog` (`cli/doctor.go:329-365`) parses the RFC3339 prefixes, counts failures in the last 24 h, and warns:

> `"%d hook delivery failure(s) in the last 24h — activity tracking may be degraded; latest: %s (full log: %s)"`

That is the entire operator-facing surface for a dead hook feed. There is no metric, no notification, no UI badge for hook delivery failure itself.

### 8.3 How AO distinguishes "broken pipeline" from "resting agent"

This is the part most directly relevant to tm8, and it is elegant.

`FirstSignalAt` (`domain/session.go:61-66`) is a **receipt**, deliberately separate from state:

> *"FirstSignalAt is when the FIRST agent hook callback arrived for the current spawn/restore: raw signal receipt, independent of the derived activity state. Zero means no hook has ever reported, which deriveStatus surfaces as StatusNoSignal after a grace period. Internal fact, not part of the API read model."*

`MarkSpawned` (`lifecycle/manager.go:669-690`) sets `rec.Activity = {Idle, now}` and **clears `rec.FirstSignalAt = time.Time{}`** — *"Each spawn/restore must re-prove its hook pipeline."*

Then:

```go
// backend/internal/service/session/status.go:51-53
if signalCapable && rec.FirstSignalAt.IsZero() && now.Sub(rec.Activity.LastActivityAt) > noSignalGrace {
    return domain.StatusNoSignal
}
return domain.StatusIdle
```

with `noSignalGrace = 90 * time.Second` (`status.go:16`) and its rationale (`:9-15`):

> *"It covers the agent's TUI boot plus the gap to the first activity-bearing hook callback (for Codex that is UserPromptSubmit, seconds after the auto-submitted spawn prompt — its SessionStart hook fires earlier but carries no activity state); past it, a silent session is indistinguishable from one with a broken hook pipeline, and the dashboard must not claim a confident 'idle'."*

Three ingredients, all necessary:
1. `signalCapable` — a hook-less harness is *permanently* silent, and that is normal; it stays `idle` forever.
2. `FirstSignalAt.IsZero()` — the pipeline has never once proven itself *this launch*.
3. `> 90s` since the seeded `LastActivityAt` — enough time for the TUI to boot.

Only all three together produce `no_signal`. And the receipt is written even for a same-state repeat (`lifecycle/manager.go:389-398`), so the very first hook of any kind clears it.

**The honest-uncertainty principle:** AO has a distinct display status for "I don't know", and it refuses to render a confident `idle` when it cannot distinguish rest from breakage. `StatusNoSignal` is in the API enum (`domain/session.go:88`).

### 8.4 Where it still degrades silently

Be blunt: several failure paths produce no visible signal at all.

- **PATH pin failure** — logs a warning at spawn (`manager.go:2708`) and proceeds. The session then reads `no_signal` after 90s, but nothing connects the two for the user.
- **`toolFlight` lost on daemon restart** — the in-memory correlation map is gone (`lifecycle/manager.go:451-463`). A session sitting on a permission dialog will stay `blocked` until the next turn boundary rather than clearing on the tool's completion. Documented and accepted.
- **An adapter that installs `ao hooks <tok>` with no registered deriver** — *"its activity is silently never reported"* (`activitydispatch/dispatch.go:1-8`), and worse, it *is* `signalCapable`… no: `SupportsHarness` reads the same map, so it correctly reports not-capable. The failure is the inverse — a registered deriver whose adapter installs nothing would be marked capable and go permanently `no_signal`. Nothing checks the two directions agree.
- **A non-sentinel `.gitignore` already present** — hooks install fine, but teardown will need `--force` (`hookutil/hookutil.go:30-54`).
- **A non-AO file at the opencode plugin path** — this one is *not* silent; it fails loudly (`opencode/hooks.go:99-109`).

---

## 9. Q9 — What AO's hooks do NOT do

Stated from what the source contains, and I am flagging that absence of a code path is only weak evidence about intent.

**Hooks carry exactly six fields.** `setActivityAPIRequest` (`cli/hooks.go:43-50`) / `SetActivityRequest` (`controllers/dto.go:607-614`): `state`, `event`, `toolName`, `toolUseId`, `agentSessionId`, `launchId`. Nothing else crosses the boundary.

**Hooks write exactly two durable columns plus one receipt.** `lifecycle/manager.go:1-5`: *"activity_state plus an is_terminated bit are the only persisted status-like facts on the session row."* Plus `FirstSignalAt` (internal, `json:"-"`). Hooks set `activity_state` and `FirstSignalAt`; they never set `is_terminated` — even the `exited` state explicitly leaves `IsTerminated` alone (`lifecycle/manager.go:404-410`).

**The one non-activity fact hooks do persist:** `agentSessionId` — the native transcript-resume handle, stored on `SessionMetadata.AgentSessionID` (`domain/session.go:35`), delivered by metadata-only `SessionStart` hooks that carry no state (`ports/runtime_observations.go:29-33`).

**Things hooks demonstrably do not touch:**
- Git / PR / SCM facts. Those arrive on a completely separate path and feed `deriveSCMStatus` (`service/session/status.go:59-68`) independently.
- The display status. `Session.Status` and `Session.SCMStatus` are derived on read and *"Neither Status nor SCMStatus is persisted"* (`domain/session.go:84-85`).
- Terminal output capture, diffs, worktree state, branch, `DiffBaseSHA` — all in `SessionMetadata` (`domain/session.go:27-45`) and written by other subsystems.
- Session termination.
- Any content the agent produces. The hook reads the payload only for `notification_type`, `reason`, `tool_name`, `tool_use_id`, and the session-id aliases.

**What is derived from activity beyond the display status:**
- The `sessionguard` write policies (§5.4) — the highest-consequence consumer.
- `NotificationNeedsInput` on the edge into the needs-input family (`lifecycle/manager.go:419-430`).
- `ao.session.waiting_input_entered/_exited` telemetry with `dwell_ms` (`lifecycle/manager.go:592-633`).
- `ErrAwaitingDecision` → HTTP 409 on the send path (`session_manager/manager.go:2015-2016`, `:64-69`).

**The one thing hooks push *to* the agent:** the agy/devin `SessionStart` additional-context injection (§3.4).

---

## 10. For the tm8 designer — what transfers, and what breaks

tm8 is multi-tenant with RLS, has remote nodes, and hosts the PTY on the server. AO is single-user, single-machine, loopback, unauthenticated. Sorting AO's ideas along that seam:

### 10.1 Transfers cleanly — mechanism-independent

| AO idea | Source | Why it transfers |
|---|---|---|
| **Two orthogonal columns**: activity vs terminated | `lifecycle/manager.go:1-5`; `domain/session.go:60-67` | Pure data modelling. Directly maps to tm8's D1 (separate `activity` column). |
| **Derived-never-stored presentation** | `domain/session.go:84-85`; `service/session/status.go:27-55` | Matches tm8's D7. |
| **`waiting_input` vs `blocked`** as *safe-to-nudge* vs *never-inject* | `domain/activity.go:9-19` | The distinction exists because of a real consequence (answering a dialog), not taxonomy. |
| **Capability declared, never inferred**; unknown → most conservative | `ports/agent.go:120-162`; `lifecycle_wiring.go:88-93` | Matches tm8's D5. The nil-predicate-means-no rule is the important half. |
| **The `no_signal` honest-uncertainty status** + per-launch `FirstSignalAt` receipt + grace | `domain/session.go:61-66`; `lifecycle/manager.go:669-690`; `status.go:16,51-53` | This is the single best idea to copy verbatim. It is exactly the antidote to the `idle` trap tm8 already documented (`packages/tm8-ui/src/data/real/liveness.ts:172`). |
| **Write a receipt even for a same-state repeat** | `lifecycle/manager.go:389-398` | Otherwise the pipeline can never prove itself for a session that legitimately stays in one state. |
| **Tool-use correlation to clear a sticky state** | `lifecycle/manager.go:490-590` | Requires the harness to expose tool ids, but the *algorithm* — exactly-one-match or fail closed, clear only on that id or on a turn boundary — is transport-independent. |
| **Just-in-time re-read before any pane write**, fail closed on read error, zero-value = suppressed | `sessionguard/guard.go:32-56,160-185` | More important in tm8, not less: see §10.3. |
| **Fallback signals carry CAS + generation fence** | `observe/activity/observer.go:126-133` | The pattern that lets a weak producer participate without ever overwriting a strong one. This is how tm8's D3 producer hierarchy should actually be enforced. |
| **Drop, don't truncate, overlong correlation metadata** | `cli/hooks.go:56-76`; `sessions.go:1033-1039` | A truncated id correlates to the wrong thing. |
| **Atomic file writes**; refuse to overwrite a non-AO file | `hookutil.go:67-90`; `opencode/hooks.go:99-109` | Basic hygiene, cheap. |
| **A hook must never break the agent** — always exit 0, log elsewhere | `cli/hooks.go:175-181`; `doctor.go:325-328` | Non-negotiable. But see §10.4 on the cost. |
| **Read-preserving install**: keep unknown keys, remove-then-re-add owned entries | `hooksjson.go:73-108,287-302` | Users have their own hooks. |
| **Self-ignoring `.gitignore`** so hook files can't block teardown | `hookutil.go:17-25` | Applies wherever tm8 uses git worktrees. |
| **Three install strategies** because harnesses differ | §1.2, `codex/hooks.go:16-28` | Design the seam as "adapter prepares the workspace *and may amend argv*", not "adapter returns a config file". |

### 10.2 Breaks outright — depends on AO being loopback and unauthenticated

**The transport.** `http://127.0.0.1:<port>/api/v1/sessions/<id>/activity`, headers `Content-Type` only (`cli/client.go:130,135-140`), middleware stack with no auth (`httpd/router.go:51-56`), and the explicit "no AO_HOST, we have no auth/CORS/TLS" comment (`config/config.go:20-24`). **None of this survives contact with tm8.** In tm8, a hook POST is a cross-tenant write into an RLS-protected table from a process running on a possibly-remote node. AO's endpoint would let any tenant assert any session's activity.

**Ambient identity via a bare env var.** `AO_SESSION_ID` is a plain, guessable, inheritable string with no secret component (`manager.go:79`; `cli/hooks.go:134-140`). It is *identity*, not *authorisation*, and AO conflates them because loopback + single-user makes the distinction free. tm8 cannot. The minimal correction: **the hook process must carry a per-session, per-launch bearer credential, not just an id** — something like `TM8_SESSION_ID` + `TM8_HOOK_TOKEN`, where the token is minted at spawn, scoped to exactly `POST activity for this session id`, invalidated on the next launch, and never logged. AO's env-ordering rule (AO's vars merged *last* so a project cannot override them, `manager.go:2681-2691`) becomes load-bearing rather than merely tidy.

**The bare `ao` binary + PATH pin.** `hookBinaryName = "ao"` with `HookPATH` prepending the daemon's own directory (`manager.go:93-97, 2723-2744`). This assumes the daemon binary and the agent process share a filesystem and a PATH. With remote nodes that assumption dies. tm8 needs the hook command to reference something node-resolvable — an absolute path materialised on the node, or an endpoint URL baked into the config at install time — plus an explicit answer for "which server does this hook talk to". AO's failure mode here (warn and proceed, `manager.go:2708`) is acceptable when the answer is always "the one daemon on this machine"; it is not acceptable when it could be the wrong tenant's server.

**The run-file port discovery.** `cli/client.go:107-120` reads a local run-file for the port and refuses if the daemon PID is not alive. There is no equivalent on a remote node. tm8 must inject the target URL explicitly.

**In-process, in-memory correlation state.** `toolFlight` (`lifecycle/manager.go:451-463`) lives in the daemon's memory with a documented restart degradation. In tm8 with multiple server processes, "the daemon that holds the flight map" is not a well-defined thing. Either pin a session's signals to one process, or persist the correlation state, or accept turn-boundary-only clearing everywhere. **Do not silently inherit the in-memory assumption.**

**Local filesystem for the failure log.** `$AO_DATA_DIR/hooks.log` + `ao doctor` (`cli/hooks.go:229-258`; `doctor.go:329-365`). On a remote node, a local file nobody reads is not an observability strategy. tm8 needs hook-delivery failure to become a server-side fact.

**`localhost` reachability at all.** AO's hook process assumes it can open a TCP connection to the orchestrator. A tm8 hook on a remote node must traverse whatever channel tm8 already uses for that node, with its retry and offline semantics. This is the largest structural difference and it deserves its own decision.

### 10.3 One consequence that gets *worse* in tm8, not better

`sessionguard`'s just-in-time re-read (`guard.go:154-159`) is honest about being *"not atomic against the agent itself — a dialog can still appear mid-paste."* AO closes that window to a single in-process store read. In tm8, the read is a database round-trip and the write is a PTY write on a possibly-remote node — the window is wider by orders of magnitude. The mitigation cannot just be "read closer to the write"; tm8 probably needs the *node* to hold the last-known activity state and refuse the write locally, i.e. push the guard to the same side of the network as the pane.

### 10.4 One thing I would push back on before copying

AO's "hooks always exit 0 and log to a local file" (`cli/hooks.go:175-181`) is right for the agent's sake and wrong for the operator's. The result is that the *only* signal of a dead pipeline is a status that says `no_signal` 90 seconds later, plus a log line nobody reads unless they run `ao doctor`. tm8 can keep the never-break-the-agent property while still making delivery failure a first-class server-side event — e.g. the hook exits 0 but writes a local spool that a node agent drains and reports. AO did not need this because AO has one user watching one dashboard.

---

## 11. Summary table — the mechanism in nine lines

| Question | Answer | Anchor |
|---|---|---|
| Where is config written | worktree file, or argv `-c` flags (codex), or embedded TS plugin (opencode) — before runtime start | `manager.go:2860-2867` |
| What format | matcher-group JSON, `0o600`, atomic, read-preserving, self-gitignored | `hooksjson.go:73-108`; `hookutil.go:17-90` |
| Full vocabulary | 9 events (claude-code, grok); 4 (codex, qwen); 5 (droid, agy); 4 (devin); 3 (goose, opencode) | §2 |
| What the hook runs | `ao hooks <agent> <event>`, hidden cobra, stdin JSON, always exit 0 | `cli/hooks.go:121-181` |
| Where it POSTs | `POST http://127.0.0.1:<port>/api/v1/sessions/{id}/activity`, no auth | `client.go:130-140`; `sessions.go:148` |
| Identity | `AO_SESSION_ID` env var, inherited, `^[A-Za-z0-9_-]+$`, path-escaped | `manager.go:79`; `hooks.go:24,134-140` |
| Blocked set/clear | set only on exactly-one tool-name match; cleared only by turn boundary or that exact `tool_use_id` | `lifecycle/manager.go:490-590` |
| Reconciliation | reaper 5 s; terminal observer 30 s / 2 min stale / 40 lines, CAS + launch fence | `reaper.go:20`; `observer.go:14-18,126-133` |
| Broken-vs-resting | `signalCapable && FirstSignalAt.IsZero() && >90 s` → `no_signal` | `status.go:16,51-53` |

---

## 12. What I could not verify

Stated plainly, because absence of evidence is not evidence.

1. **Rendered file bytes.** The claude-code JSON in §1.3 is reconstructed from the Go struct tags plus `json.MarshalIndent`. I did not execute AO or capture a real `settings.local.json` from a live worktree. Field names, values, indentation and trailing newline follow from the source; the exact key ordering Go produces for a map is not something I confirmed by observation.
2. **Adapters I did not open in full.** cursor, copilot, kimi, cline, kiro, kilocode, autohand, vibe, amp, devin — I read their path/prefix constants and their registry entry, and (for those using `hooksjson`) their `HookSpec` lists. I did **not** read their `GetAgentHooks` bodies or their payload parsing. Any claim about their event set beyond the `ManagedHooks` grep results should be re-checked.
3. **The vibe TOML format.** I confirmed `vibeHooksFileName = "hooks.toml"` (`vibe/hooks.go:17`) and that `vibe.DeriveActivityState` is registered. I did not read the TOML writer or the deriver.
4. **`--dangerously-bypass-hook-trust`.** I read `codex/hooks.go:97-111` for the trust flag construction; the bypass flag is asserted from that file's surrounding logic and package comment. Re-verify the exact argv if it matters.
5. **The SQLite schema.** I read the Go domain structs, not the migrations. The mapping from `SessionRecord.Activity` / `FirstSignalAt` to actual columns, and the `change_log` trigger/SSE fan-out that publishes activity changes, are un-inspected. I read the reducer, not the store.
6. **AO's own docs.** I did not read `docs/architecture.md`, `CONTEXT.md`, or `docs/STATUS.md` this pass. Everything here is from source. That is a deliberate trade, but it means I cannot report where AO's stated design and its code disagree.
7. **Windows/conpty.** All environment-inheritance reasoning is from the Unix path. I did not check the conpty runtime's env handling.
8. **Whether any hook event fires more than once per logical occurrence**, or the actual ordering guarantees each harness gives. AO's opencode plugin comment (`ao-activity.ts:54-66`) implies ordering is *not* free and had to be bought with a synchronous spawn. I have no data on the other harnesses.
9. **Grok's capability declarations.** I confirmed grok installs the full nine and shares claude-code's deriver, but I did not open `grok/grok.go` looking for `EmitsSubmitActivity` / `EmitsBlockedActivity`. The §7.2 row for grok says "not declared" on the basis of `ports/agent.go:120-152`'s claim that *only* claude-code satisfies both — that is AO's own doc comment, not an independent check.

---

*Compiled from `github.com/Untrivial-ai/agent-orchestrator` @ `bfb69fb`. Every `path:line` is relative to `backend/` unless the path says otherwise. No AO source was modified.*
