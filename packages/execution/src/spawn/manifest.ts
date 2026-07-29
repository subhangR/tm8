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
  AgentMode,
  PermissionMode,
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
/** Fallback permission posture (old maestro: manifest-generator.ts:474). */
export const DEFAULT_PERMISSION_MODE: PermissionMode = 'acceptEdits';
/** The magic `TM8_AGENT_CMD` value that selects the built-in smoke agent. */
export const ECHO_AGENT_CMD = 'echo-agent';

const PERMISSION_MODES: readonly PermissionMode[] = [
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
}

/**
 * Precedence: explicit request > persona defaults > built-in default.
 *
 * Old maestro had five links here (request → member override → task →
 * member/profile → reconstructed-from-bare-model). Links 2-4 all exist to carry
 * config that G1A's contract does not accept: `ExecutionSpawnInput` has no
 * permissionMode, no launchConfig and no memberOverrides, and it names exactly
 * one teamMemberId. Adding the missing links now would be building branches with
 * no callers, so they are omitted and noted rather than stubbed.
 */
export function resolveLaunchConfig(
  request: SpawnRequest,
  context: SpawnContext,
  env: NodeJS.ProcessEnv = process.env,
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
  const permissionMode =
    asPermissionMode(env.TM8_PERMISSION_MODE?.trim()) ??
    asPermissionMode(member.permissionMode) ??
    DEFAULT_PERMISSION_MODE;

  return { mode, model, agentTool, permissionMode };
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
    return ['codex', ...args].join(' ');
  }

  if (raw !== 'claude') return raw;

  const args: string[] = [];
  // ALWAYS skip permissions for a tm8-spawned Claude, whatever the persona's
  // configured permissionMode says.
  //
  // An unattended agent must not be able to hang on an interactive prompt, and
  // TWO separate dialogs can block it forever: Claude's "do you trust this
  // folder?" gate on first access, and per-tool-use confirmations. A blocked
  // agent produces no output, never reports, and burns a slot against the
  // concurrency cap until a human notices — indistinguishable from a hung agent.
  // Pre-trusting the folder alone does NOT cover the tool prompts.
  //
  // The human-authorization layer is tm8's own spawn-time PROJECT TRUST gate:
  // `execution_spawn` refuses an untrusted project, so by the time we launch an
  // operator has explicitly vouched for this working directory. Mirrors old
  // maestro's proven worker spawn.
  //
  // DELIBERATE TRADE-OFF: this overrides a MORE RESTRICTIVE configured mode — a
  // `readOnly` persona still launches with full access, so `permissionMode` is
  // currently advisory for Claude. Honouring it needs a launch path that cannot
  // deadlock; that is post-Slice-1 work, and `mapClaudePermissionMode` is kept
  // for it rather than deleted.
  args.push('--dangerously-skip-permissions');
  if (launch.model) args.push('--model', shellQuote(launch.model));
  return ['claude', ...args].join(' ');
}

/**
 * Append the composed system prompt to an agent command line.
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
 * Delivery is PER-TOOL: Claude takes `--append-system-prompt`; Codex takes
 * `-c developer_instructions=<json>` (`instructions` is reserved and ignored),
 * and the manifest-reading smoke agent needs no prompt flag. Operator wrappers
 * are returned unchanged because tm8 cannot know their private flag vocabulary.
 */
export function withAgentPrompt(
  command: string,
  systemPrompt: string,
  launch: ResolvedLaunchConfig,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (systemPrompt.trim() === '') return command;
  const raw = env.TM8_AGENT_CMD?.trim() || AGENT_TOOL_BINARIES[launch.agentTool];
  if (raw === 'claude') {
    return `${command} --append-system-prompt ${shellQuote(systemPrompt)}`;
  }
  if (raw === 'codex') {
    const config = `developer_instructions=${JSON.stringify(systemPrompt)}`;
    return `${command} -c ${shellQuote(config)}`;
  }
  // echo-agent reads the typed manifest directly. An operator-provided wrapper
  // is a complete command whose private flag vocabulary tm8 must not guess.
  return command;
}

/** tm8's four postures → the three `--permission-mode` values Claude accepts. */
function mapClaudePermissionMode(mode: PermissionMode): string {
  switch (mode) {
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

  return env;
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
      command,
    },
    session: {
      title: request.title?.trim() || defaultTitle(context),
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

function defaultTitle(context: SpawnContext): string {
  const first = context.tasks[0];
  if (first) return first.title;
  return `${context.teamMember.name} session`;
}
