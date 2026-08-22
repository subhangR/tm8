// @tm8/execution — launch-config precedence, cwd resolution, command building
// and manifest composition. Pure functions: no I/O, no graph, no PTY, so every
// precedence rule below is directly unit-testable.
//
// BEHAVIORAL ORACLE: old maestro's ~850-line inline spawn route
// (agent-maestro maestro-server/src/api/sessionRoutes.ts:1477-2324). The
// BEHAVIOR is copied — precedence order, provider-inference-from-model, the
// permission-mode bijection, the auth-env passthrough, the CLAUDE_CODE_*
// deletions. The STRUCTURE is not: that route resolved config across request
// body / task / member override / model profile / multi-member power ranking,
// then shelled out to a CLI to build the manifest. G1A has one persona and one
// request, so the chain collapses to three links and runs in-process.
//
// Deliberately NOT ported (parked with Orion, R20/R27/R29): worktree creation,
// sub-team re-rooting, spell injection, multi-member model-power
// ranking. Power ranking in particular belongs in model-profile DATA, not in a
// branch table that drifts every time a model ships.

import { fileURLToPath } from 'node:url';
import { existsSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AccessMode,
  AgentMode,
  CommandNetworkPolicy,
  CredentialSource,
  GitHubCredential,
  PermissionMode,
  ReasoningEffort,
  ResolvedCredentialSources,
  SessionLaunchPosture,
  SpawnContext,
  SpawnRequest,
  Tm8Manifest,
  WorkdirMode,
} from './types.js';
import { SpawnError } from './types.js';
import {
  AGENT_CREDENTIAL_SUPPRESSED_ENV_KEYS,
  agentCredentialEnv,
  type AgentCredentialHome,
} from './agent-credentials.js';
import { redactSecretsDeep } from './secret-redaction.js';
import { codexHarness } from '../harness/codex.js';

/** Fallback when neither the request nor the persona names a model. */
export const DEFAULT_MODEL = 'sonnet';
/** Fallback agent tool. Matches old maestro's read-time default. */
export const DEFAULT_AGENT_TOOL = 'claude-code';
/**
 * Fallback permission posture.
 *
 * `auto`, not maestro's `acceptEdits` (manifest-generator.ts:474). Every tm8
 * session is UNATTENDED — there is no human at the PTY to answer a prompt — and
 * `acceptEdits` frees only file edits: a spawned agent still stopped dead at its
 * first `Bash` approval, which is the same unattended-hang class the Codex
 * branch below documents. `auto` is Claude Code's own answer to that (the agent
 * runs what it judges safe and escalates the rest), so it is what a session
 * that named no posture gets. It is a DEFAULT and nothing more: an explicit
 * `accessMode` on the request, `TM8_PERMISSION_MODE` on the node, the SPAWNING
 * PARENT SESSION's own posture, or a persona's recorded `permission_mode` all
 * still win, in that order.
 */
export const DEFAULT_PERMISSION_MODE: PermissionMode = 'auto';
/** The magic `TM8_AGENT_CMD` value that selects the built-in smoke agent. */
/** Re-exported: the definition moved to `../harness/echo-agent.ts`, which owns
 *  the smoke harness. Kept exported here so existing importers do not move. */
export { ECHO_AGENT_CMD, echoAgentPath } from '../harness/echo-agent.js';

/**
 * A coordinated launch is only coherent when it names the work session that
 * will receive the result. The parent id has already passed the server's
 * same-space/session validation by the time the manifest is composed; carrying
 * it here turns that persisted hierarchy into the prompt's concrete return
 * address. Non-coordinated child sessions deliberately get no coordinator.
 */
export function resolveCoordinatorSessionId(
  mode: AgentMode,
  parentSessionId: string | null | undefined,
): string | null {
  if (mode !== 'coordinated-worker' && mode !== 'coordinated-coordinator') return null;
  const coordinatorSessionId = parentSessionId?.trim() || null;
  if (!coordinatorSessionId) {
    throw new SpawnError(
      `mode '${mode}' requires parentSessionId so the worker can report to its coordinator`,
      'invalid_input',
      { mode, reason: 'coordinator_session_required' },
    );
  }
  return coordinatorSessionId;
}

/** Exact hosts tm8 grants to sandboxed Codex commands. */
export const CODEX_LOOPBACK_HOSTS = ['127.0.0.1', 'localhost'] as const;

/**
 * tm8-owned Codex config overrides for command networking.
 *
 * Values are kept as raw argv entries and shell-quoted only at the final
 * command-rendering seam. That makes TOML parsing and argument order directly
 * unit-testable, and keeps spawn/resume on one policy source.
 */
export const CODEX_LOOPBACK_CONFIG_OVERRIDES = [
  'sandbox_workspace_write.network_access=true',
  'features.network_proxy.enabled=true',
  'features.network_proxy.domains={"127.0.0.1"="allow", "localhost"="allow"}',
  // Pin the safe default explicitly so a developer-global config cannot turn
  // the exact-host policy into broad loopback/LAN/private-network access.
  'features.network_proxy.allow_local_binding=false',
] as const;

/** Expand the tm8-owned Codex config overrides into their exact CLI argv. */
export function codexLoopbackConfigArgs(): string[] {
  return CODEX_LOOPBACK_CONFIG_OVERRIDES.flatMap((value) => ['-c', value]);
}

const PERMISSION_MODES: readonly PermissionMode[] = [
  'auto',
  'acceptEdits',
  'interactive',
  'readOnly',
  'bypassPermissions',
];

const AGENT_MODES: readonly AgentMode[] = [
  'worker',
  'coordinator',
  'coordinated-worker',
  'coordinated-coordinator',
  'dispatcher',
];

/**
 * Infer the agent tool from the MODEL NAME, not from the persona's declared
 * tool.
 *
 * This ordering is load-bearing and old maestro learned it the hard way
 * (sessionRoutes.ts:330-346): a persona whose `agent_tool` still says `codex`
 * but whose model was switched to `opus` must launch on Claude, or the spawn
 * fails deep inside the wrong CLI with an unrecognised-model error. The model
 * is what the user actually chose; the tool is a stale sidecar of it.
 */
export function agentToolForModel(model: string | null | undefined): string | null {
  if (!model) return null;
  const m = model.toLowerCase();
  if (/^(claude|opus|sonnet|haiku|fable)/.test(m)) return 'claude-code';
  if (/^(gpt|o\d)/.test(m)) return 'codex';
  if (/^gemini/.test(m)) return 'gemini';
  if (/^hermes/.test(m)) return 'hermes';
  return null;
}

function asPermissionMode(value: string | null | undefined): PermissionMode | null {
  if (!value) return null;
  return (PERMISSION_MODES as readonly string[]).includes(value) ? (value as PermissionMode) : null;
}

const ACCESS_MODES: readonly AccessMode[] = ['safe', 'acceptEdits', 'auto', 'plan', 'fullAccess'];

/**
 * A posture string read back out of a STORED manifest, which is a JSON document
 * an older build may have written — so it is validated, never cast.
 */
function asAccessMode(value: string | null | undefined): AccessMode | null {
  if (!value) return null;
  return (ACCESS_MODES as readonly string[]).includes(value) ? (value as AccessMode) : null;
}

function asAgentMode(value: string | null | undefined): AgentMode | null {
  if (!value) return null;
  return (AGENT_MODES as readonly string[]).includes(value) ? (value as AgentMode) : null;
}

/** The resolved launch posture — one persona, one request, three links. */
export interface ResolvedLaunchConfig {
  mode: AgentMode;
  model: string | null;
  agentTool: string;
  permissionMode: PermissionMode;
  accessMode: AccessMode;
  reasoningEffort: ReasoningEffort | null;
  /** Deprecated common value; null when provider choices differ or are auto. */
  credentialSource: CredentialSource | null;
  /** Independent launch-time choice for every credential provider. */
  credentialSources: ResolvedCredentialSources;
}

/**
 * Resolve command networking independently from approval/filesystem posture.
 *
 * An operator wrapper remains operator-defined because tm8 cannot safely guess
 * flags into its private CLI vocabulary. Explicit Codex full access remains
 * unsandboxed and unchanged. Every tm8-owned, sandboxed Codex invocation gets
 * the exact loopback proxy policy, including plan/readOnly sessions.
 */
export function resolveCommandNetworkPolicy(
  launch: ResolvedLaunchConfig,
  env: NodeJS.ProcessEnv = process.env,
): CommandNetworkPolicy {
  const override = env.TM8_AGENT_CMD?.trim();
  if (override && override !== 'codex') {
    return {
      mode: 'operator-defined',
      commandNetworkAccess: null,
      proxyEnabled: false,
      allowedHosts: [],
      portScoped: false,
    };
  }
  if (launch.agentTool !== 'codex') {
    return {
      mode: 'provider-default',
      commandNetworkAccess: null,
      proxyEnabled: false,
      allowedHosts: [],
      portScoped: false,
    };
  }
  if (launch.permissionMode === 'bypassPermissions') {
    return {
      mode: 'full-access',
      commandNetworkAccess: true,
      proxyEnabled: false,
      allowedHosts: [],
      portScoped: false,
    };
  }
  return {
    mode: 'loopback-proxy',
    commandNetworkAccess: true,
    proxyEnabled: true,
    allowedHosts: [...CODEX_LOOPBACK_HOSTS],
    // The proxy currently matches hosts only. An exact 127.0.0.1 rule can
    // therefore reach every loopback port, not just tm8's configured port.
    portScoped: false,
  };
}

function asReasoningEffort(value: string | null | undefined): ReasoningEffort | null {
  if (!value) return null;
  return ['low', 'medium', 'high', 'xhigh', 'max'].includes(value)
    ? (value as ReasoningEffort)
    : null;
}

function permissionModeForAccessMode(mode: AccessMode): PermissionMode {
  switch (mode) {
    case 'fullAccess': return 'bypassPermissions';
    case 'auto': return 'auto';
    case 'acceptEdits': return 'acceptEdits';
    case 'plan': return 'readOnly';
    case 'safe': return 'interactive';
  }
}

function accessModeForPermissionMode(mode: PermissionMode): AccessMode {
  switch (mode) {
    case 'bypassPermissions': return 'fullAccess';
    case 'auto': return 'auto';
    case 'acceptEdits': return 'acceptEdits';
    case 'readOnly': return 'plan';
    case 'interactive': return 'safe';
  }
}

/**
 * Precedence: explicit request > operator env > INHERITED PARENT POSTURE >
 * persona defaults > built-in default.
 *
 * Old maestro had five links here (request → member override → task →
 * member/profile → reconstructed-from-bare-model). Links 2-4 all exist to carry
 * config that G1A's contract does not accept: `ExecutionSpawnInput` has no
 * permissionMode, no launchConfig and no memberOverrides, and it names exactly
 * one teamMemberId. Adding the missing links now would be building branches with
 * no callers, so they are omitted and noted rather than stubbed.
 *
 * WHY `inherited` OUTRANKS THE PERSONA. A child spawned by a running session is
 * launched by that session's decision, not by a human sitting at the terminal:
 * nobody is watching its PTY to answer a permission prompt, so a child that
 * drops from its parent's `fullAccess` back to the persona's default stalls on
 * the first approval and looks like a hang. The parent's posture is the live,
 * specific grant; the persona's is a static default, and a default is exactly
 * what an inherited fact is entitled to replace.
 *
 * WHY THAT IS NOT AN ESCALATION. Inheritance can only ever hand a child what
 * the PARENT already holds, and the parent could have performed the same work
 * itself. It is a default-selection mechanism, not an authorization boundary —
 * `parentSessionId` is client-asserted, so it must never be read as one. What a
 * caller may spawn at all remains the space/persona question the server answers
 * upstream of here.
 */
export function resolveLaunchConfig(
  request: SpawnRequest,
  context: SpawnContext,
  env: NodeJS.ProcessEnv = process.env,
  inherited?: SessionLaunchPosture | null,
): ResolvedLaunchConfig {
  const member = context.teamMember;

  const mode: AgentMode = asAgentMode(request.mode) ?? asAgentMode(member.mode) ?? 'worker';

  const model = request.model?.trim() || member.model?.trim() || DEFAULT_MODEL;

  // Model wins over the persona's declared tool — see agentToolForModel.
  const agentTool =
    request.agentTool?.trim() || agentToolForModel(model) || member.agentTool?.trim() || DEFAULT_AGENT_TOOL;

  // The env override is last and highest, mirroring old maestro's
  // MAESTRO_PERMISSION_MODE (manifest-generator.ts:814-817). It is how an
  // operator forces a whole node's posture without touching any persona.
  const requestedAccessMode = request.accessMode ?? null;
  // The inherited posture is carried as an accessMode when the parent recorded
  // one, and reconstructed from its permissionMode when it did not — a manifest
  // written before accessMode existed still names a posture, just in the other
  // vocabulary, and the two are 1:1.
  const inheritedPermissionMode = asPermissionMode(inherited?.permissionMode);
  const inheritedAccessMode =
    asAccessMode(inherited?.accessMode) ??
    (inheritedPermissionMode ? accessModeForPermissionMode(inheritedPermissionMode) : null);
  const requestedPermissionMode = requestedAccessMode
    ? permissionModeForAccessMode(requestedAccessMode)
    : asPermissionMode(env.TM8_PERMISSION_MODE?.trim()) ??
      (inheritedAccessMode ? permissionModeForAccessMode(inheritedAccessMode) : null) ??
      asPermissionMode(member.permissionMode) ??
      DEFAULT_PERMISSION_MODE;

  // THE DISPATCHER ALWAYS RUNS UNPROMPTED, and that outranks every link above
  // rather than joining the chain as one more default. The dispatcher is
  // resident and unattended: nobody is sitting at its PTY to answer an
  // approval, and its entire job — read the request, decide the teammate,
  // spawn the session — is shell commands that a prompting posture stops dead
  // at the first one. A dispatcher parked on an approval still reports
  // `running` and still answers liveness, so the failure looks like a
  // dispatcher that simply never did anything. There is no posture in which a
  // prompting dispatcher is the intended thing, so nothing below gets to
  // select one — not the persona, not the node's env override, not the caller.
  const dispatcher = mode === 'dispatcher';
  const permissionMode = dispatcher ? 'bypassPermissions' : requestedPermissionMode;
  const accessMode = dispatcher
    ? 'fullAccess'
    : requestedAccessMode ?? accessModeForPermissionMode(permissionMode);
  const reasoningEffort = asReasoningEffort(request.reasoningEffort);

  // Each provider resolves independently. New provider keys outrank the
  // deprecated global carrier; inherited provider keys then outrank an older
  // manifest's global value. Every read is narrowed because inherited posture
  // comes from stored JSON written by arbitrary older builds.
  const credentialSources: ResolvedCredentialSources = {
    anthropic: resolveCredentialSource('anthropic', request, inherited),
    openai: resolveCredentialSource('openai', request, inherited),
    github: resolveCredentialSource('github', request, inherited),
  };
  const commonSources = new Set(Object.values(credentialSources));
  const credentialSource = commonSources.size === 1
    ? ([...commonSources][0] ?? null)
    : null;

  return {
    mode,
    model,
    agentTool,
    permissionMode,
    accessMode,
    reasoningEffort,
    credentialSource,
    credentialSources,
  };
}

function resolveCredentialSource(
  provider: keyof ResolvedCredentialSources,
  request: SpawnRequest,
  inherited: SessionLaunchPosture | null | undefined,
): CredentialSource | null {
  return asCredentialSource(request.credentialSources?.[provider]) ??
    asCredentialSource(request.credentialSource) ??
    asCredentialSource(inherited?.credentialSources?.[provider]) ??
    asCredentialSource(inherited?.credentialSource) ??
    null;
}

function asCredentialSource(value: unknown): CredentialSource | null {
  return value === 'member' || value === 'node' ? value : null;
}

/**
 * Resolve the working directory FROM THE GRAPH.
 *
 * The one security rule that survives AM-4's deferral, because it costs nothing
 * and cannot be retrofitted: the cwd is whatever `public.projects.working_dir`
 * says, and a client-supplied path is never consulted. `ExecutionSpawnInput`
 * carries no path field at all, which is the contract making the same point.
 */
export function resolveWorkdir(
  request: SpawnRequest,
  context: SpawnContext,
  opts: { scratchRoot: string; sessionIdHint?: string },
): { mode: WorkdirMode; path: string; baseRef: string | null } {
  const mode: WorkdirMode = request.workdir?.mode ?? (context.project ? 'project' : 'scratch');
  const baseRef = request.workdir?.baseRef ?? null;

  if (mode === 'scratch' && context.project) {
    throw new SpawnError('workdir.mode "scratch" cannot be combined with a project', 'invalid_input', {
      projectId: context.project.id,
    });
  }

  // Worktree mode requires a project for the mirror of scratch mode's reason: a
  // worktree is a checkout OF something (design §4.1). The path returned for it
  // here is the REPOSITORY root, which the provisioning saga replaces with the
  // checkout it creates — that is what keeps this function pure and Git-free.
  if (mode === 'worktree' && !context.project) {
    throw new SpawnError('workdir.mode "worktree" requires a project', 'invalid_input', {
      reason: 'worktree_requires_project',
    });
  }

  // Project mode requires a project, for the same reason worktree mode does and
  // scratch mode refuses one: the mode names where the agent works, and without
  // a project there is no such place.
  //
  // THIS IS THE ONE COMBINATION THAT USED TO FALL THROUGH. The two guards above
  // reject their impossible pairing; `mode: 'project'` with no project reached
  // the projectless return at the bottom and got back
  // `.../scratch/pending` — with `mode` still reported as `'project'`. Nothing
  // failed, so the session spawned, the row recorded `project`, and the agent
  // ran in a scratch directory instead of the repository it was asked for.
  //
  // Measured on a live node 2026-08-22: of the sessions active that day, every
  // one whose row said `project` and whose path was scratch had a null
  // `project_id`, and every one with a project was in the repository. The
  // operator's report was "my sessions are not starting from /root/strykr".
  //
  // Safe to add because the DEFAULT already resolves correctly: an unspecified
  // mode is `context.project ? 'project' : 'scratch'`, so a caller that simply
  // does not know is unaffected. Only a caller that explicitly asked for project
  // mode without one reaches here — and that caller is asking for something that
  // does not exist.
  if (mode === 'project' && !context.project) {
    throw new SpawnError('workdir.mode "project" requires a project', 'invalid_input', {
      reason: 'project_requires_project',
    });
  }

  if (context.project) {
    const dir = context.project.workingDir;
    if (!dir.startsWith('/') || dir.includes('..')) {
      // The DB CHECK already enforces this shape; re-asserting here means a
      // future direct-write path cannot quietly bypass it.
      throw new SpawnError('project working directory is not a safe absolute path', 'internal', {
        projectId: context.project.id,
      });
    }
    return { mode, path: dir, baseRef };
  }

  // Projectless scratch session: a server-managed directory, never the server's
  // own cwd (which would let an agent write into the tm8 checkout).
  return { mode, path: `${scratchRootFor(opts.scratchRoot)}/${opts.sessionIdHint ?? 'pending'}`, baseRef };
}

function scratchRootFor(root: string): string {
  return root.replace(/\/+$/, '');
}

/** Single-quote a shell word so paths with spaces survive `sh -c`. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The agent-command builders now live in the HARNESS REGISTRY (`../harness/`),
 * which is the sole dispatch point for agent-tool differences. They are
 * re-exported here unchanged in signature, error shape and rendered output, so
 * every existing importer of `@tm8/execution` is unaffected.
 *
 * WHAT MOVED, AND WHY. This block used to hold a three-entry lookup table
 * followed by a chain of string-equality tests on the resolved binary
 * (`raw === ECHO_AGENT_CMD`, `raw === 'codex'`, `raw !== 'claude'`), with
 * Claude's entire flag vocabulary inlined into the tail of `buildAgentCommand`
 * and Codex's into `buildCodexArgs`. Adding a third real agent meant adding a
 * fourth branch here and then finding every other place that had made the same
 * assumption. tm8 law T-L4 forbids exactly that shape — behaviour keyed on a
 * string literal makes the set of legal values a property of the CODE rather
 * than of a REGISTRY.
 *
 * The measured failure this prevents is already in this file's history: on
 * 2026-07-28 a spawn with `agentTool: 'codex'` produced a work_session row and
 * a manifest that both said `codex`, while the live PTY's argv was the bare
 * `claude` command, because the tool selection reached every surface EXCEPT the
 * one that picks the binary. `AGENT_TOOL_BINARIES` was the fix; it is now
 * DERIVED from the registry, so it can no longer drift from the harnesses it
 * names.
 *
 * The per-tool flag knowledge — including the hard-won facts that
 * `instructions` is reserved by Codex and silently ignored, that `codex resume`
 * is a subcommand while the rollout id is positional, and that `auto` is a
 * first-class Claude `--permission-mode` — moved WITH the code, into
 * `../harness/claude-code.ts` and `../harness/codex.ts`.
 */
export { AGENT_TOOL_BINARIES } from '../harness/registry.js';
export { buildAgentCommand, withAgentPrompt, withAgentResume } from '../harness/command.js';

/**
 * Codex's exact logical argv before any shell joining or quoting.
 *
 * Retained as a named export because it is part of `@tm8/execution`'s surface
 * and the spawn suite asserts on it directly. It now renders the registry's
 * tagged argv down to plain strings, so the argv and the real command line
 * cannot diverge — previously they were two independent constructions of the
 * same list, kept in agreement only by review.
 */
export function buildCodexArgs(
  launch: ResolvedLaunchConfig,
  opts: { sandboxUnavailable?: boolean } = {},
): string[] {
  return codexHarness
    .buildArgv(launch, { sandboxUnavailable: opts.sandboxUnavailable === true })
    .map((token) => (typeof token === 'string' ? token : token.value));
}

/** Auth credentials forwarded from the server's own environment, when present. */
const AUTH_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_GENAI_USE_VERTEXAI',
  'GOOGLE_GENAI_USE_GCA',
] as const;

/**
 * Non-secret process basics an interactive CLI needs to behave normally.
 *
 * `XDG_CONFIG_HOME` USED TO BE ON THIS LIST AND IS DELIBERATELY NOT — sub-doc
 * 14's channel C5. It is not a process basic at all; it is a credential
 * LOOKUP PATH. `gh` resolves its config directory as `GH_CONFIG_DIR` >
 * `$XDG_CONFIG_HOME/gh` > `$HOME/.config/gh`, so copying it out of the server
 * process hands every spawned agent whatever the server's own value points at
 * — and it OUTRANKS `HOME`, so a per-identity home does not cover it.
 *
 * It is latent today only because the variable happens to be unset on the
 * deployed unit. One operator `Environment=XDG_CONFIG_HOME=...` line in the
 * unit file would silently revert `gh` isolation for every session, with no
 * error, no log line and no failing test. Inheritance is exactly the wrong
 * default for a value like that, so `composeEnv` now DECIDES it: set to the
 * spawning identity's own config directory when they have a credential home,
 * and otherwise absent. Never copied.
 *
 * `XDG_CACHE_HOME` stays: a cache directory is not an authentication input.
 */
const SAFE_BASE_ENV_KEYS = [
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'PATH',
  'LANG',
  'LC_ALL',
  'TERM',
  'COLORTERM',
  'TMPDIR',
  'XDG_CACHE_HOME',
] as const;

/**
 * A process-local HTTPS helper. The string contains no secret: git expands
 * `$GH_TOKEN` only inside the child environment when it asks for a credential.
 */
const GIT_CREDENTIAL_HELPER =
  '!f() { test "$1" = get && printf '
  + '"username=%s\\npassword=%s\\n" "${TM8_GIT_LOGIN:-x-access-token}" "$GH_TOKEN"; }; f';

function isolateGitHubCredential(
  env: Record<string, string>,
  credential: GitHubCredential | undefined,
  strictMemberIsolation: boolean,
): void {
  if (!credential && !strictMemberIsolation) return;

  // Always reset machine/global helpers in member posture. With no member row
  // this yields a prompt-free authentication failure, never a node fallback.
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_CONFIG_KEY_0 = 'credential.https://github.com.helper';
  env.GIT_CONFIG_VALUE_0 = '';
  env.GIT_CONFIG_COUNT = credential ? '2' : '1';

  // Explicit empty values also defeat wrappers that branch on presence. They
  // are replaced below only when the DB row gate returned a real credential.
  env.GH_TOKEN = '';
  env.GITHUB_TOKEN = '';
  delete env.TM8_GIT_LOGIN;

  if (!credential) return;

  env.GH_TOKEN = credential.token;
  env.GITHUB_TOKEN = credential.token;
  env.GIT_CONFIG_KEY_1 = 'credential.https://github.com.helper';
  env.GIT_CONFIG_VALUE_1 = GIT_CREDENTIAL_HELPER;
  env.TM8_GIT_LOGIN = credential.login;
  env.GIT_AUTHOR_NAME = credential.login;
  env.GIT_COMMITTER_NAME = credential.login;
  env.GIT_AUTHOR_EMAIL = `${credential.login}@users.noreply.github.com`;
  env.GIT_COMMITTER_EMAIL = env.GIT_AUTHOR_EMAIL;
}

/**
 * Compose the agent's environment.
 *
 * The session id, manifest path, base URL, and session-bound agent credential
 * are the boot contract. The credential is supplied explicitly by SpawnService
 * and is never inherited from the server process.
 *
 * The `CLAUDE_CODE_ENTRYPOINT` / `CLAUDECODE` deletions are a scar, not
 * housekeeping: when tm8-server is itself started from inside a Claude Code
 * session those variables are inherited, and the spawned agent then refuses to
 * start because it believes it is already running inside itself.
 */
export function composeEnv(
  manifest: Tm8Manifest,
  manifestPath: string,
  baseUrl: string,
  parentEnv: NodeJS.ProcessEnv = process.env,
  /**
   * Where this session's `tm8` invocations append their command journal.
   *
   * The env var IS the feature gate: a CLI that does not see it journals
   * nothing at all, which is exactly what should happen for a human running
   * `tm8` at their own terminal. Optional so a caller that does not want
   * journaling simply omits it rather than having to disable anything.
   *
   * It needs no manifest field to be discoverable — `envVarNames` is derived
   * from these keys and already reaches the graph via `recordManifest`.
   */
  journalPath?: string,
  agentToken?: string,
  /**
   * The spawning identity's own credential home, when they have connected the
   * provider this session's agent tool authenticates with.
   *
   * A VALUE, not a flag. `composeEnv` and `composeCredentialEnv` remain two
   * separate functions with no boolean selecting between them — see
   * `credential-env.ts`'s header for why that matters. This parameter cannot
   * turn an agent environment into a login-terminal environment or the reverse;
   * it only names which directory the agent's vendor CLI reads.
   *
   * Absent is the ordinary case: a member who has not connected keeps today's
   * behaviour, where the agent uses whatever credential the node itself has.
   */
  credentialHome?: AgentCredentialHome,
  /** DB-gated, caller-owned GitHub credential. Never inherited from parentEnv. */
  gitHubCredential?: GitHubCredential,
  /** GitHub `member` fails closed against machine-wide gh/git fallback even with no row. */
  githubCredentialSource?: CredentialSource | null,
): Record<string, string> {
  const env: Record<string, string> = {
    TM8_SESSION_ID: manifest.sessionId,
    TM8_MANIFEST_PATH: manifestPath,
    TM8_BASE_URL: baseUrl,
    TM8_SPACE_ID: manifest.spaceId,
    TM8_MODE: manifest.mode,
    TM8_AGENT_TOOL: manifest.launch.tool,
    TM8_TEAM_MEMBER_ID: manifest.agent.teamMemberId,
    TM8_ACTOR_ID: manifest.agent.teamMemberId,
    TM8_TASK_IDS: manifest.tasks.map((t) => t.id).join(','),
  };
  if (journalPath) env.TM8_JOURNAL_PATH = journalPath;
  if (agentToken) env.TM8_AGENT_TOKEN = agentToken;

  for (const key of SAFE_BASE_ENV_KEYS) {
    const value = parentEnv[key];
    if (value) env[key] = value;
  }
  if (manifest.project) env.TM8_PROJECT_ID = manifest.project.id;
  if (manifest.launch.model) env.TM8_MODEL = manifest.launch.model;

  for (const key of AUTH_ENV_KEYS) {
    const value = parentEnv[key];
    if (value) env[key] = value;
  }

  // The spawning identity's OWN vendor credential, when they have connected one.
  //
  // This is the read half of Tier B: the login terminal wrote
  // `<dataDir>/credentials/<identityId>/<provider>/` and this is what makes an
  // ordinary agent session read it, so the member's work is attributed to the
  // member rather than to the node's machine account.
  //
  // It also carries the ONLY `XDG_CONFIG_HOME` this function ever emits.
  // Placed AFTER the two copy loops on purpose: both are allowlists over
  // `parentEnv`, and a deliberate per-identity value must not be overwritable
  // by an inherited one if either list ever grows a name that collides.
  if (credentialHome) {
    Object.assign(env, agentCredentialEnv(credentialHome));
    // C8 / ruling 13 — and this DELETE is the load-bearing half.
    //
    // Setting the config directory is not enough on a node whose own
    // `ANTHROPIC_API_KEY` is forwarded by `AUTH_ENV_KEYS` a few lines above:
    // measured against the real CLI, that key competes with — and with an
    // unpopulated identity home outright beats — the member's own login, so the
    // session would run on the node's key under the member's name with nothing
    // red anywhere. Scoped to the connected provider only, so a member who has
    // NOT connected keeps today's behaviour exactly.
    for (const key of AGENT_CREDENTIAL_SUPPRESSED_ENV_KEYS[credentialHome.provider]) {
      delete env[key];
    }
  }

  // GitHub is universal rather than agent-tool-specific. Apply after the env
  // copy loops and after XDG_CONFIG_HOME is redirected into the identity home,
  // so neither a parent token nor a machine helper/config can win precedence.
  isolateGitHubCredential(env, gitHubCredential, githubCredentialSource === 'member');

  // Explicit empty strings also defend wrappers that interpret presence.
  env.CLAUDE_CODE_ENTRYPOINT = '';
  env.CLAUDECODE = '';

  if (manifest.launch.commandNetwork.mode === 'loopback-proxy') {
    // Codex's network proxy supplies HTTP(S)_PROXY to sandboxed commands.
    // Node's built-in fetch does not use those variables unless this startup
    // switch is present. Scope it to the proxy posture so explicit full access
    // and non-Codex providers keep their previous process environment.
    env.NODE_USE_ENV_PROXY = '1';
  }

  // PROPHYLAXIS, not a fix for any observed cause. Confirmed on this machine
  // (2026-07-28) that Claude Code self-updates a `npm-global` install in the
  // background without being asked (`~/.claude/.last-update-result.json`
  // recorded a real 2.1.219→2.1.220 event), and `DISABLE_AUTOUPDATER` is a
  // real, honored env var (confirmed via `strings` on the installed binary,
  // not assumed from documentation). A binary that can replace itself out
  // from under a running PTY, with nothing supervising for that, is a
  // documented hazard regardless of whether it has been shown to explain any
  // particular session death — it has NOT been shown to be the cause of one.
  // Disable it for every spawned agent as a precaution, and because it removes
  // a confound from Phase 2's death diagnosis: a self-update mid-session would
  // otherwise be indistinguishable, in the evidence describePtyExit records,
  // from any other unexplained termination.
  env.DISABLE_AUTOUPDATER = '1';

  // Put the `tm8` binary on the agent's PATH.
  //
  // The system prompt instructs the agent to report durably with
  // `tm8 message send --to <anchor-entity-id>` — that IS the reporting loop
  // (the retired `task report` verbs are rejected vocabulary now), and it is
  // the only way its work becomes visible in the graph. `@tm8/cli` is a
  // workspace package with a `bin` entry that nothing ever installs globally,
  // so without this every one of those commands dies with "command not found"
  // and the agent looks broken while believing it reported. PREPENDED so a
  // stale globally-installed `tm8` cannot shadow the build this server
  // actually shipped with.
  const binDir = cliBinDir();
  if (binDir) {
    const inherited = parentEnv.PATH ?? '';
    env.PATH = inherited === '' ? binDir : `${binDir}:${inherited}`;
  }

  // …and then make sure the AGENT binary itself is reachable.
  //
  // tm8-server does not always inherit a developer's PATH. Under the macOS
  // launchd agent that runs it as a service, `PATH` is the bare
  // `/usr/bin:/bin:/usr/sbin:/sbin` — while `claude` lives in
  // `/opt/homebrew/bin` and `codex` in `~/.local/bin`. Measured 2026-07-30:
  // every launch from the UI died with `exitCode 127` (command not found) while
  // the identical request against a hand-started server in a login shell
  // succeeded, because that one inherited an interactive PATH. The launch flow
  // must not depend on who started the server.
  //
  // APPENDED, never prepended: these are FALLBACKS. An operator who has put a
  // specific `claude` earlier on PATH keeps it, and tm8 does not silently
  // reorder a resolution the machine's owner already arranged. Non-existent
  // directories are filtered out rather than added blindly, so PATH stays
  // meaningful in `describePtyExit` evidence and in the manifest's env record.
  env.PATH = withAgentBinDirs(env.PATH ?? '', parentEnv);

  return env;
}

/**
 * Directories where the agent CLIs are actually installed on a developer Mac,
 * in the order a login shell would normally have them.
 *
 * Deliberately a SHORT, EXPLICIT list of package-manager bin dirs rather than a
 * filesystem search: a search would be slower, order-unstable, and could pick up
 * an arbitrary binary named `claude` from somewhere nobody intended. Anything
 * more exotic than these is what `TM8_AGENT_CMD` exists for.
 */
function agentBinDirCandidates(parentEnv: NodeJS.ProcessEnv): string[] {
  const home = parentEnv['HOME'];
  const dirs = ['/opt/homebrew/bin', '/usr/local/bin'];
  if (home) {
    dirs.push(join(home, '.local', 'bin'), join(home, '.bun', 'bin'), join(home, '.volta', 'bin'));
  }
  return dirs;
}

/**
 * Append any candidate bin dir that exists and is not already on `path`.
 *
 * EXPORTED for `composeCredentialEnv`, which builds a login terminal's
 * environment from scratch and shares nothing else with `composeEnv`. The PATH
 * problem is genuinely identical for both — a login terminal that cannot find
 * `claude`, `codex` or `gh` dies with 127 in exactly the same way an agent does,
 * for exactly the same reason (the launchd unit's PATH is the bare
 * `/usr/bin:/bin:/usr/sbin:/sbin`). Sharing the discovery list is not the same
 * as sharing the environment: this function decides where a binary is FOUND and
 * never what a process is TRUSTED with.
 */
export function withAgentBinDirs(path: string, parentEnv: NodeJS.ProcessEnv): string {
  const present = new Set(path.split(':').filter((p) => p !== ''));
  const additions = agentBinDirCandidates(parentEnv).filter(
    (dir) => !present.has(dir) && existsSync(dir),
  );
  if (additions.length === 0) return path;
  return path === '' ? additions.join(':') : `${path}:${additions.join(':')}`;
}

/**
 * Absolute path to `binary` as resolved against `path`, or null.
 *
 * Exists so the spawn flow can REFUSE with the true reason instead of launching
 * a child that exits 127 a moment later. A 127 surfaces as
 * `agent process exited during the boot settlement window`, which is honest
 * about the symptom and silent about the cause — the operator still has to guess
 * whether the CLI is missing, unlicensed, crashing, or misconfigured.
 */
export function resolveAgentBinary(binary: string, path: string): string | null {
  // A caller-supplied path (`TM8_AGENT_CMD=/opt/mine/agent`) is not a PATH
  // lookup at all, and must not be rewritten into one.
  if (binary.includes('/')) return existsSync(binary) ? binary : null;
  for (const dir of path.split(':')) {
    if (dir === '') continue;
    const candidate = join(dir, binary);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Directory containing an executable literally named `tm8`, or null.
 *
 * Resolved RELATIVE TO THIS MODULE rather than from cwd or an env var, so the
 * agent gets the CLI from the same checkout as the server that spawned it.
 * `../../../cli/dist` lands on `packages/cli/dist` from both `src/spawn/`
 * (vitest, running TypeScript directly) and `dist/spawn/` (the built server) —
 * both are three levels below `packages/`.
 *
 * WHY IT CHECKS FOR `tm8` AND NOT `index.js`: the built entrypoint is
 * `dist/index.js`, and `tm8` only exists because the CLI's build step links it
 * (`package.json` `bin` is a manifest declaration — it materializes a `tm8`
 * executable only when a package manager INSTALLS the package, which nothing
 * does for a workspace member). Putting `dist` on PATH while it contains only
 * `index.js` looks correct, passes every type check, and still leaves the agent
 * with `tm8: command not found` on every reporting call — a silent failure where
 * the agent believes it reported and nothing reached the graph. So the probe is
 * for the exact name the prompt tells the agent to type.
 *
 * The symlink is created idempotently rather than merely asserted: relying on
 * build ordering would reintroduce the same silent gap for anyone who builds
 * with a bare `tsc -b`.
 *
 * Returns null rather than throwing when it cannot be made: a server on a
 * read-only or unbuilt checkout should still spawn agents that do useful work,
 * just without the reporting verbs. Failing the spawn outright is a worse trade.
 *
 * EXPORTED because a vanilla terminal needs the same directory for the same
 * reason (`shell-env.ts`). Two copies of this resolution would be two places to
 * get the `tm8`-vs-`index.js` distinction above wrong, and the second copy is
 * the one nobody would remember to fix.
 */
export function cliBinDir(): string | null {
  const dir = fileURLToPath(new URL('../../../cli/dist', import.meta.url));
  const entry = join(dir, 'index.js');
  if (!existsSync(entry)) return null;
  const link = join(dir, 'tm8');
  if (!existsSync(link)) {
    try {
      symlinkSync('index.js', link);
    } catch {
      // Raced with another spawn, or the checkout is read-only. If it exists
      // now the race was benign; otherwise report honestly that there is no
      // usable bin dir instead of poisoning PATH with one that cannot work.
      if (!existsSync(link)) return null;
    }
  }
  return dir;
}

export interface ComposeManifestInput {
  sessionId: string;
  request: SpawnRequest;
  context: SpawnContext;
  launch: ResolvedLaunchConfig;
  /** Effective command-network policy resolved from launch + operator env. */
  commandNetwork?: CommandNetworkPolicy;
  interactionProfile?: import('./types.js').InteractionProfilePinContext;
  workdir: { mode: WorkdirMode; path: string };
  command: string;
  baseUrl: string;
  /** Why the launch runs unconfined, when it does. See `Tm8Manifest.launch.sandboxDegraded`. */
  sandboxDegraded?: string | null;
  now?: Date;
}

/** Assemble the manifest. Pure — every input is already resolved.
 *
 * The composed object is passed through {@link redactSecretsDeep} before it is
 * returned, so every downstream artifact — the manifest file, the
 * `record_session_manifest` row, the prompts composed FROM the manifest, and
 * the argv they end up on — carries `[credential-redacted]` where a
 * credential-shaped token sat in member-controlled text (a task description,
 * a persona, promptExtra). Without this, one pasted API key makes the S15
 * guard trigger kill every launch of that task with `manifest appears to
 * contain a credential value` — and the alternative to refusing would have
 * been persisting the key. See secret-redaction.ts for the measured incident.
 */
export function composeManifest(input: ComposeManifestInput): Tm8Manifest {
  const { sessionId, request, context, launch, workdir, command, baseUrl } = input;
  const coordinatorSessionId = resolveCoordinatorSessionId(launch.mode, request.parentSessionId);
  const interactionProfile = input.interactionProfile ?? {
    profileId: null,
    profileVersion: null,
    templateKey: 'tm8.chat.core',
    templateVersion: 1,
    source: 'core_default' as const,
    resolvedHash: 'core-default',
    pinRevision: 0,
    snapshot: { profile: { source: 'core_default' } },
  };
  const member = context.teamMember;

  return redactSecretsDeep({
    manifestVersion: '1',
    sessionId,
    spaceId: context.spaceId,
    generatedAt: (input.now ?? new Date()).toISOString(),
    mode: launch.mode,
    baseUrl,
    // The persona. Field names match Phoenix's CLI reader exactly; `memory`
    // (not `memories`) is his spelling and the graph column's plural is not
    // worth a translation layer on his side.
    agent: {
      teamMemberId: member.id,
      name: member.name,
      avatar: member.avatar,
      role: member.role,
      identity: member.identity,
      memory: member.memories,
      capabilities: member.capabilities,
      commandPermissions: member.commandPermissions,
    },
    launch: {
      tool: launch.agentTool,
      model: launch.model,
      permissionMode: launch.permissionMode,
      accessMode: launch.accessMode,
      reasoningEffort: launch.reasoningEffort,
      credentialSource: launch.credentialSource,
      credentialSources: launch.credentialSources,
      commandNetwork: input.commandNetwork ?? resolveCommandNetworkPolicy(launch, {}),
      sandboxDegraded: input.sandboxDegraded ?? null,
      command,
    },
    session: {
      title: resolveSessionTitle(request, context),
      workingDirectory: workdir.path,
      workdirMode: workdir.mode,
    },
    project: context.project
      ? {
          id: context.project.id,
          name: context.project.name,
          workingDir: context.project.workingDir,
          trust: context.project.trust,
        }
      : null,
    interactionProfile,
    tasks: context.tasks,
    // Row #11: resolved across the persona's ancestor chain by loadSpawnContext
    // and already de-duplicated nearest-first. Still defaults to [] — a spawn
    // context predating this (the test fake, an older caller) is "no skills",
    // not an error. This is the value change the shape was held stable for.
    skills: context.skills ?? [],
    coordinator: coordinatorSessionId ? { sessionId: coordinatorSessionId } : null,
    directive: null,
    promptExtra: request.promptExtra?.trim() || null,
  });
}

/**
 * One title for both the durable work_session row and its launch manifest.
 * Keeping this resolution in one place prevents the list/event projection
 * from showing an empty title while the terminal manifest names the session.
 */
export function resolveSessionTitle(
  request: Pick<SpawnRequest, 'title'>,
  context: SpawnContext,
): string {
  const explicit = request.title?.trim();
  if (explicit) return explicit;
  const first = context.tasks[0];
  if (first) return first.title;
  return `${context.teamMember.name} session`;
}
