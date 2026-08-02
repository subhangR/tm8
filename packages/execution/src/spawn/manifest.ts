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
// coordinator/sub-team re-rooting, spell injection, multi-member model-power
// ranking. Power ranking in particular belongs in model-profile DATA, not in a
// branch table that drifts every time a model ships.

import { fileURLToPath } from 'node:url';
import { existsSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AccessMode,
  AgentMode,
  PermissionMode,
  ReasoningEffort,
  SessionLaunchPosture,
  SpawnContext,
  SpawnRequest,
  Tm8Manifest,
  WorkdirMode,
} from './types.js';
import { SpawnError } from './types.js';

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
export const ECHO_AGENT_CMD = 'echo-agent';

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
  const permissionMode = requestedAccessMode
    ? permissionModeForAccessMode(requestedAccessMode)
    : asPermissionMode(env.TM8_PERMISSION_MODE?.trim()) ??
      (inheritedAccessMode ? permissionModeForAccessMode(inheritedAccessMode) : null) ??
      asPermissionMode(member.permissionMode) ??
      DEFAULT_PERMISSION_MODE;
  const accessMode = requestedAccessMode ?? accessModeForPermissionMode(permissionMode);
  const reasoningEffort = asReasoningEffort(request.reasoningEffort);

  return { mode, model, agentTool, permissionMode, accessMode, reasoningEffort };
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

/** Absolute path to the built-in echo agent, resolved relative to this module.
 *
 *  `../../harness/echo-agent.mjs` lands on the same file from `src/spawn/`
 *  (vitest, running TypeScript directly) and from `dist/spawn/` (the built
 *  server) — both are two levels below the package root. */
export function echoAgentPath(): string {
  return fileURLToPath(new URL('../../harness/echo-agent.mjs', import.meta.url));
}

/**
 * Per-`agentTool` binary name, selected when the operator has not forced one
 * via `TM8_AGENT_CMD`.
 *
 * Before this table existed, a per-session `agentTool: 'codex'` landed on the
 * work_session row, the manifest, and `TM8_AGENT_TOOL` — everywhere EXCEPT the
 * one place that decides which binary the PTY actually runs. `buildAgentCommand`
 * ignored `launch.agentTool` entirely and fell straight through to `'claude'`,
 * so a caller who asked for codex silently got Claude launched with a model
 * name (e.g. `gpt-5-codex`) it does not recognise. Measured 2026-07-28: a spawn
 * with `agentTool: 'codex'` produced a work_session row and manifest that both
 * said `codex`, while the live PTY's argv (`ps -p <pid> -o args=`) was the bare
 * `claude` command. This table is what makes the resolved tool selection reach
 * the actual child process.
 *
 * Tool-specific argument and prompt handling lives in the two builders below;
 * unsupported tools are rejected instead of being routed through another CLI.
 */
const AGENT_TOOL_BINARIES: Readonly<Record<string, string>> = {
  'claude-code': 'claude',
  codex: 'codex',
  'echo-agent': ECHO_AGENT_CMD,
};

/**
 * Build the shell command line the PTY runs.
 *
 * `TM8_AGENT_CMD` is an OPERATOR OVERRIDE and wins over everything — it forces
 * one binary for the whole node, whatever any session's resolved `agentTool`
 * says. Absent it, the resolved tool picks its own default binary via
 * {@link AGENT_TOOL_BINARIES}. Unrecognised tool names are rejected:
 *   - `echo-agent`  → the built-in smoke agent. Proves the whole loop (manifest
 *                     read → PTY spawn → prompt delivery → output) without
 *                     burning a real model session. HOW-TO-TEST uses this.
 *   - `claude-code` → real Claude Code, with flags derived from the manifest the
 *                     same way old maestro's ClaudeSpawner.buildBaseArgs did.
 *   - `codex`       → Codex with its model and developer-instruction config.
 * An explicit `TM8_AGENT_CMD` remains a complete operator-owned wrapper and is
 * used verbatim.
 */
export function buildAgentCommand(
  launch: ResolvedLaunchConfig,
  env: NodeJS.ProcessEnv = process.env,
  opts: {
    /**
     * The PRE-MINTED native session id (maestro's claude-spawner pattern):
     * `--session-id <uuid>` forces Claude to adopt tm8's uuid as its own
     * conversation id, which is what makes `--resume <uuid>` possible later
     * without ever parsing a transcript. Claude-only — Codex cannot be
     * pre-seeded (its CLI mints its own rollout id), and an operator wrapper's
     * flag vocabulary is unknown, so both ignore this.
     */
    claudeSessionId?: string | null;
    /**
     * This node cannot actually confine a codex command, as established by
     * RUNNING the provider's own sandbox rather than inferring from paths or
     * capability bits — see `sandbox-probe.ts`.
     *
     * When set, the codex branch stops emitting `--sandbox`, because emitting
     * it is what produced the defect this flag exists to end: the flag went
     * out, codex accepted it, the session came up healthy in every tm8 surface,
     * and then failed EVERY shell command with `bwrap: loopback: Failed
     * RTM_NEWADDR: Operation not permitted`. tm8 was calling that a sandbox.
     * It was a session that could not run anything.
     *
     * The caller decides WHETHER a launch may proceed unconfined — that is a
     * security question and it is answered in SpawnService, which refuses by
     * default. By the time this flag is true the decision is already made, and
     * this function's only job is to emit a command line that tells the truth
     * about it.
     */
    sandboxUnavailable?: boolean;
  } = {},
): string {
  const override = env.TM8_AGENT_CMD?.trim();
  const raw = override || AGENT_TOOL_BINARIES[launch.agentTool];

  if (!raw) {
    throw new SpawnError(`unsupported agent tool: ${launch.agentTool}`, 'invalid_input', {
      agentTool: launch.agentTool,
    });
  }

  if (raw === ECHO_AGENT_CMD) {
    return `node ${shellQuote(echoAgentPath())}`;
  }

  if (raw === 'codex') {
    const args: string[] = [];
    if (launch.model) args.push('--model', shellQuote(launch.model));

    // Codex's approval prompts are the SAME unattended-hang hazard the Claude
    // branch below documents at length, and this branch used to ignore them
    // entirely: it emitted `--model` and nothing else, so a launched Codex
    // stopped at its first approval request with no human at the terminal.
    // Same authorization argument, same conclusion — tm8's spawn-time project
    // TRUST gate (`execution_spawn` refuses an untrusted project) is the human
    // authorization, so by the time we launch, an operator has vouched for this
    // working directory. Mirrors maestro's codex-spawner buildCodexArgs.
    //
    // `opts.sandboxUnavailable` collapses the second branch into the first.
    // WHY NOT KEEP `--ask-for-approval` AND DROP ONLY `--sandbox`: that is the
    // tempting half-measure, and it is worse than either whole. Approvals with
    // no sandbox is a policy that stops to ask with nobody at the terminal to
    // answer — the exact unattended hang this branch was written to design out,
    // one paragraph up — and it would buy no confinement in exchange for it. If
    // the node cannot confine, the honest command line says so in one flag
    // rather than implying a gate that will never open.
    if (launch.permissionMode === 'bypassPermissions' || opts.sandboxUnavailable === true) {
      args.push('--dangerously-bypass-approvals-and-sandbox');
    } else {
      args.push('--ask-for-approval', mapCodexApprovalPolicy(launch.permissionMode));
      args.push('--sandbox', mapCodexSandboxMode(launch.permissionMode));
    }

    // This PTY is always server-hosted and rendered into a browser xterm, so
    // Codex must stay INLINE. Its default alternate-screen mode continuously
    // redraws, which a reconnecting xterm client replays as a garbled buffer
    // instead of ordinary scrollback. maestro gates this on
    // `MAESTRO_PTY_HOST === 'server'`; in tm8 there is no other host.
    args.push('--no-alt-screen');

    if (launch.reasoningEffort) {
      args.push('-c', shellQuote(`model_reasoning_effort=${JSON.stringify(launch.reasoningEffort)}`));
    }

    // NOT passed: `--cd`. The PTY spawns the child with `cwd` already set to the
    // resolved working directory (SpawnService step 5), and naming it twice is
    // two places for a future edit to disagree about.
    return ['codex', ...args].join(' ');
  }

  if (raw !== 'claude') return raw;

  const args: string[] = [];
  if (launch.permissionMode === 'bypassPermissions') {
    args.push('--dangerously-skip-permissions');
  } else {
    args.push('--permission-mode', mapClaudePermissionMode(launch.permissionMode));
  }
  if (launch.model) args.push('--model', shellQuote(launch.model));
  if (launch.reasoningEffort) args.push('--effort', launch.reasoningEffort);
  if (opts.claudeSessionId) args.push('--session-id', shellQuote(opts.claudeSessionId));
  return ['claude', ...args].join(' ');
}

/**
 * Turn a base agent command into the RESUME invocation for `nativeSessionId`.
 *
 * Ported from maestro's proven resume builders (claude-spawner/codex-spawner
 * buildResumeArgs), including the two facts that make resume correct:
 *   - The SYSTEM prompt is re-appended. `--resume` / `codex resume` restore
 *     conversation HISTORY, not the invocation's own configuration — an agent
 *     resumed without it comes back with its memory and no identity.
 *   - The TASK prompt is NOT re-sent. It is already the first user turn of the
 *     restored conversation; sending it again duplicates the assignment. No
 *     positional argument also happens to be what keeps both CLIs in the
 *     interactive session the PTY needs.
 * Exact-id only: no `--continue`, no `--last` — both mean "most recent", which
 * resumes the WRONG conversation the moment two sessions share a cwd.
 *
 * Refusals are loud and typed. An operator wrapper (`TM8_AGENT_CMD`) has a
 * private flag vocabulary tm8 must not guess a resume flag into, and a tool
 * with no resume-by-id contract (echo-agent, gemini, hermes) must never be
 * silently restarted fresh and presented as resumed.
 */
export function withAgentResume(
  command: string,
  systemPrompt: string,
  launch: ResolvedLaunchConfig,
  nativeSessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env.TM8_AGENT_CMD?.trim();
  if (override) {
    throw new SpawnError(
      'resume is not supported under a TM8_AGENT_CMD operator wrapper — tm8 cannot know its resume flags',
      'not_implemented',
      { override },
    );
  }
  const raw = AGENT_TOOL_BINARIES[launch.agentTool];
  const system = systemPrompt.trim();

  if (raw === 'claude') {
    const parts = [command];
    if (system !== '') parts.push(`--append-system-prompt ${shellQuote(system)}`);
    parts.push(`--resume ${shellQuote(nativeSessionId)}`);
    return parts.join(' ');
  }
  if (raw === 'codex') {
    // `resume` is a SUBCOMMAND and must come before the flags; the rollout id
    // is positional and must come after them.
    const parts = [command.replace(/^codex\b/, 'codex resume')];
    if (system !== '') {
      parts.push(`-c ${shellQuote(`developer_instructions=${JSON.stringify(system)}`)}`);
    }
    parts.push(shellQuote(nativeSessionId));
    return parts.join(' ');
  }
  throw new SpawnError(
    `agent tool '${launch.agentTool}' has no resume-by-id contract`,
    'invalid_input',
    { agentTool: launch.agentTool },
  );
}

/**
 * Append the composed prompts to an agent command line.
 *
 * SEPARATE from {@link buildAgentCommand} because of an ordering constraint that
 * looks circular and is not: the prompt is composed FROM the manifest, and the
 * manifest records the command. Splitting the two unties it — the base command
 * is built and recorded, the manifest is composed, the prompt is derived from
 * it, and only then is the prompt appended to produce the line the PTY runs.
 * Nothing in the prompt renders `launch.command`, so there is no real cycle.
 *
 * THIS IS THE STEP THAT WAS MISSING. Before it, tm8 composed a complete manifest
 * AND a complete system prompt, wrote the manifest to disk, exported
 * `TM8_MANIFEST_PATH` — then launched a bare `claude` that read none of it. Every
 * real agent booted with no identity and no task. It went unnoticed because the
 * smoke stub (`echo-agent`) DOES read the manifest, so the loop passed on a path
 * the product never takes.
 *
 * THE TWO PROMPTS TRAVEL ON DIFFERENT CHANNELS, and conflating them was the
 * second half of the same bug. The system prompt configures the agent; the task
 * prompt is the agent's FIRST USER TURN — the thing that makes it start working.
 * This function used to take one string, and its only caller passed
 * `${envelope.system}\n\n${envelope.task}`, so the task block landed inside
 * `--append-system-prompt` and no positional argument was emitted at all.
 * Measured 2026-07-30 on a live spawn (`ps -p <pid> -o command=`): the argv
 * ended `...</tm8_system_prompt>\n\n<tm8_task_prompt count="0">...`, with
 * nothing after it. Both CLIs treat an invocation with no positional prompt as
 * an INTERACTIVE session, so every tm8-launched agent booted to an idle REPL
 * with its assignment buried in its own configuration, reported `running`, and
 * never emitted a token. A session row that exists is not an agent that started.
 *
 * Delivery is PER-TOOL, and matches maestro's proven spawners
 * (`maestro-cli/src/services/{claude,codex}-spawner.ts`) flag for flag:
 *   - Claude: `--append-system-prompt <system>` then `<task>` positional
 *   - Codex:  `-c developer_instructions=<json>` then `<task>` positional
 *     (`instructions` is reserved by Codex and silently ignored)
 * The manifest-reading smoke agent needs neither: it reads the typed manifest.
 * Operator wrappers (`TM8_AGENT_CMD`) are returned unchanged because tm8 cannot
 * know their private flag vocabulary — including whether a bare positional would
 * be read as a prompt or as a path.
 *
 * The positional goes LAST, after every flag, because both CLIs stop parsing
 * options at the first non-option argument.
 */
export function withAgentPrompt(
  command: string,
  prompts: { system: string; task: string },
  launch: ResolvedLaunchConfig,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const system = prompts.system.trim();
  const task = prompts.task.trim();
  if (system === '' && task === '') return command;
  const raw = env.TM8_AGENT_CMD?.trim() || AGENT_TOOL_BINARIES[launch.agentTool];

  // echo-agent reads the typed manifest directly. An operator-provided wrapper
  // is a complete command whose private flag vocabulary tm8 must not guess.
  if (raw !== 'claude' && raw !== 'codex') return command;

  const parts = [command];
  if (system !== '') {
    parts.push(
      raw === 'claude'
        ? `--append-system-prompt ${shellQuote(system)}`
        : `-c ${shellQuote(`developer_instructions=${JSON.stringify(system)}`)}`,
    );
  }
  if (task !== '') parts.push(shellQuote(task));
  return parts.join(' ');
}

/**
 * tm8's four postures → Codex's `--ask-for-approval` policy.
 *
 * `interactive` maps to `untrusted` and NOT to `on-request`, which is the honest
 * answer for an unattended launch: a policy that stops to ask is a policy that
 * hangs, and `untrusted` at least confines what runs without asking. The pairing
 * with the sandbox below is what makes it usable. Mirrors maestro's
 * `mapApprovalPolicy` (codex-spawner.ts:101).
 */
function mapCodexApprovalPolicy(mode: PermissionMode): string {
  switch (mode) {
    // Codex has no `auto` of its own, and inventing one out of `on-request`
    // would be a REGRESSION dressed as a translation: `on-request` stops to ask,
    // and there is nobody at this PTY to answer. `auto` is tm8's default, so
    // codex sessions that name no posture must keep landing exactly where they
    // land today — `never` + `workspace-write`, i.e. `acceptEdits`.
    case 'auto':
    case 'acceptEdits':
      return 'never';
    case 'readOnly':
    case 'interactive':
      return 'untrusted';
    case 'bypassPermissions':
      // Unreachable — the caller emits
      // --dangerously-bypass-approvals-and-sandbox instead.
      return 'never';
  }
}

/** tm8's four postures → Codex's `--sandbox` mode (maestro: mapSandboxMode). */
function mapCodexSandboxMode(mode: PermissionMode): string {
  switch (mode) {
    case 'auto':
    case 'acceptEdits':
    case 'interactive':
      return 'workspace-write';
    case 'readOnly':
      return 'read-only';
    case 'bypassPermissions':
      // Unreachable — see mapCodexApprovalPolicy.
      return 'danger-full-access';
  }
}

/**
 * tm8's five postures → the `--permission-mode` values Claude accepts.
 *
 * `auto` is passed straight through: it is a first-class Claude Code mode
 * (`--permission-mode` choices are acceptEdits / auto / bypassPermissions /
 * manual / dontAsk / plan, verified against the installed CLI 2026-08-01), and
 * it is the posture a tm8 session gets when nothing named one.
 */
function mapClaudePermissionMode(mode: PermissionMode): string {
  switch (mode) {
    case 'auto':
      return 'auto';
    case 'acceptEdits':
      return 'acceptEdits';
    case 'readOnly':
      return 'plan';
    case 'interactive':
      return 'default';
    case 'bypassPermissions':
      // Unreachable — the caller emits --dangerously-skip-permissions instead.
      return 'acceptEdits';
  }
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

/** Non-secret process basics an interactive CLI needs to behave normally. */
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
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
] as const;

/**
 * Compose the agent's environment.
 *
 * The three mandated variables (TM8_SESSION_ID / TM8_MANIFEST_PATH /
 * TM8_BASE_URL) are the whole boot contract — everything else is convenience an
 * agent may ignore.
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
): Record<string, string> {
  const env: Record<string, string> = {
    TM8_SESSION_ID: manifest.sessionId,
    TM8_MANIFEST_PATH: manifestPath,
    TM8_BASE_URL: baseUrl,
    TM8_SPACE_ID: manifest.spaceId,
    TM8_MODE: manifest.mode,
    TM8_AGENT_TOOL: manifest.launch.tool,
    TM8_TEAM_MEMBER_ID: manifest.agent.teamMemberId,
    TM8_TASK_IDS: manifest.tasks.map((t) => t.id).join(','),
  };
  if (journalPath) env.TM8_JOURNAL_PATH = journalPath;

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

  // Explicit empty strings also defend wrappers that interpret presence.
  env.CLAUDE_CODE_ENTRYPOINT = '';
  env.CLAUDECODE = '';

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
  // The system prompt instructs the agent to run `tm8 task report progress|
  // complete|blocked` — that IS the reporting loop, and it is the only way its
  // work becomes visible in the graph. `@tm8/cli` is a workspace package with a
  // `bin` entry that nothing ever installs globally, so without this every one
  // of those commands dies with "command not found" and the agent looks broken
  // while believing it reported. PREPENDED so a stale globally-installed `tm8`
  // cannot shadow the build this server actually shipped with.
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

/** Append any candidate bin dir that exists and is not already on `path`. */
function withAgentBinDirs(path: string, parentEnv: NodeJS.ProcessEnv): string {
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
 */
function cliBinDir(): string | null {
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
  interactionProfile?: import('./types.js').InteractionProfilePinContext;
  workdir: { mode: WorkdirMode; path: string };
  command: string;
  baseUrl: string;
  /** Why the launch runs unconfined, when it does. See `Tm8Manifest.launch.sandboxDegraded`. */
  sandboxDegraded?: string | null;
  now?: Date;
}

/** Assemble the manifest. Pure — every input is already resolved. */
export function composeManifest(input: ComposeManifestInput): Tm8Manifest {
  const { sessionId, request, context, launch, workdir, command, baseUrl } = input;
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

  return {
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
    // Composed as empty/null in G1A rather than omitted: the CLI reader is
    // tolerant, but a stable shape means adding them later is a value change,
    // not a schema change.
    skills: [],
    coordinator: null,
    directive: null,
    promptExtra: request.promptExtra?.trim() || null,
  };
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
