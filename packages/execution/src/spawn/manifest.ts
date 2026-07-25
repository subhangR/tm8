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
  const mode: WorkdirMode = request.workdir?.mode ?? 'project';
  const baseRef = request.workdir?.baseRef ?? null;

  if (mode === 'worktree') {
    // Honest refusal over a silent downgrade to the project dir: a caller who
    // asked for an isolated tree and got the shared one would find out by
    // having their branch stomped. Worktree creation is R20, post-G1A.
    throw new SpawnError(
      'workdir.mode "worktree" is not implemented yet — G1A spawns into the project directory only',
      'not_implemented',
      { mode },
    );
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
 * Build the shell command line the PTY runs.
 *
 * `TM8_AGENT_CMD` selects the agent, defaulting to `claude`:
 *   - `echo-agent`  → the built-in smoke agent. Proves the whole loop (manifest
 *                     read → PTY spawn → prompt delivery → output) without
 *                     burning a real model session. HOW-TO-TEST uses this.
 *   - `claude`      → real Claude Code, with flags derived from the manifest the
 *                     same way old maestro's ClaudeSpawner.buildBaseArgs did.
 *   - anything else → used verbatim. The operator owns their own wrapper; we do
 *                     not guess flags for a CLI whose interface we do not know.
 */
export function buildAgentCommand(
  launch: ResolvedLaunchConfig,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const raw = env.TM8_AGENT_CMD?.trim() || 'claude';

  if (raw === ECHO_AGENT_CMD) {
    return `node ${shellQuote(echoAgentPath())}`;
  }

  if (raw !== 'claude') return raw;

  const args: string[] = [];
  if (launch.permissionMode === 'bypassPermissions') {
    args.push('--dangerously-skip-permissions');
  } else {
    args.push('--permission-mode', mapClaudePermissionMode(launch.permissionMode));
  }
  if (launch.model) args.push('--model', launch.model);
  return ['claude', ...args].join(' ');
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
  if (manifest.project) env.TM8_PROJECT_ID = manifest.project.id;
  if (manifest.launch.model) env.TM8_MODEL = manifest.agent.model;

  for (const key of AUTH_ENV_KEYS) {
    const value = parentEnv[key];
    if (value) env[key] = value;
  }

  // Explicit empty string, not deletion: node-pty merges over process.env, so
  // `delete env[k]` here would leave the inherited value intact in the child.
  env.CLAUDE_CODE_ENTRYPOINT = '';
  env.CLAUDECODE = '';

  return env;
}

export interface ComposeManifestInput {
  sessionId: string;
  request: SpawnRequest;
  context: SpawnContext;
  launch: ResolvedLaunchConfig;
  workdir: { mode: WorkdirMode; path: string };
  command: string;
  baseUrl: string;
  now?: Date;
}

/** Assemble the manifest. Pure — every input is already resolved. */
export function composeManifest(input: ComposeManifestInput): Tm8Manifest {
  const { sessionId, request, context, launch, workdir, command, baseUrl } = input;
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
