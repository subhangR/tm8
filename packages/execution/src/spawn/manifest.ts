import { buildManifestContext } from './context-audit.js';
import { collapseMemories, collapsedMemoryEntry, contextBudgetsFrom, contextIndexCandidates, contextIndexCaps, type MemoryCollapseResult } from './context-index.js';
import { computeEffectiveSkills } from './effective-skills.js';
import {
  asHarnessSurface,
  asMcpServers,
  asReadHints,
  equippedClaudePlugins,
  isPluginAllowed,
  laneHarnessRecord,
  laneSkillOverrides,
  laneSkillPlan,
  pluginDecisions,
  minimalMcpConfig,
  pluginSettings,
  readHintHookSettings,
  type ConfigHomeSkill,
  type LaneSkillPlan,
  type HarnessSurface,
  type HarnessSurfaceSource,
} from './harness-surface.js';
import { composePrompt, BudgetExceededError, BYTE_BUDGETS, contextBudgetOverrun, fitContextIndex, type PromptContextEntry, promptVersionFor, utf8Bytes, serializeSkillIndex, serializeSkillIndexEntry, type FitContextIndexResult } from '@tm8/prompt';
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
  CoordinatorKind,
  CredentialSource,
  GitHubCredential,
  PermissionMode,
  ReasoningEffort,
  ResolvedCredentialSources,
  SessionLaunchPosture,
  ManifestSkillContext,
  SpawnContext,
  SpaceCredentialProvider,
  SpawnRequest,
  Tm8Manifest,
  WorkdirMode,
} from './types.js';
import { SpawnError, isSpaceCredentialProvider } from './types.js';
import {
  AGENT_CREDENTIAL_CONFIG_DIR_VAR,
  AGENT_CREDENTIAL_SUPPRESSED_ENV_KEYS,
  SPACE_CREDENTIAL_API_KEY_ENV,
  SPACE_CREDENTIAL_SUPPRESSED_ENV_KEYS,
  agentCredentialEnv,
  agentCredentialProviderFor,
  type AgentCredentialHome,
  type AgentCredentialProvider,
} from './agent-credentials.js';
// Type-only in the other direction: `api-key-credentials.ts` imports nothing
// from this module at runtime, so this does not close the cycle the header of
// `agent-credentials.ts` warns about between `manifest.ts` and `credential-env.ts`.
import {
  apiKeyBackendEnv,
  isApiKeyCredentialProvider,
} from '../credentials/api-key-credentials.js';
import { redactSecretsDeep } from './secret-redaction.js';

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

/**
 * What the coordinator id NAMES, resolved from the parent the graph read back.
 *
 * Deliberately separate from {@link resolveCoordinatorSessionId}, which the
 * spec pins as returning a string: the id and its kind are two facts, and
 * folding them into one return would change a signature three call sites and a
 * guard already depend on. `null`/unknown folds to `work_session` — the pre-176
 * meaning, and the only safe reading of a parent this node could not resolve.
 */
export function resolveCoordinatorKind(
  parentKind: CoordinatorKind | null | undefined,
): CoordinatorKind {
  return parentKind === 'chat' ? 'chat' : 'work_session';
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

export function asPermissionMode(value: string | null | undefined): PermissionMode | null {
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
  /**
   * Space credential ids known BEFORE the spawn reads the space: the request's
   * own pins, and the exact id an inherited or resumed `space` source carries.
   * A `space` source with no entry here takes the space default at spawn.
   * Optional so a hand-built launch (tests, embedders) means "none".
   */
  spaceCredentialIds?: Partial<Record<SpaceCredentialProvider, string>>;
  /** D9: set by the spawn path once it has resolved auto; absent before that. */
  effectiveCredentialSources?: Partial<Record<SpaceCredentialProvider, CredentialSource>>;
  /**
   * Which harness surface a Claude lane boots with — see `harness-surface.ts`.
   * `minimal` strips the operator's MCP connectors, non-allowlisted plugins
   * and the harness Artifact tool; `inherit` is the bare `claude` command.
   * Absent means `minimal`, the lane default. Ignored for every other tool.
   */
  harnessSurface?: HarnessSurface;
  /**
   * Which link of the precedence chain chose `harnessSurface`, recorded as
   * `launch.harness.surfaceSource`. Absent means the lane default.
   */
  harnessSurfaceSource?: HarnessSurfaceSource;
  /**
   * Plugins a `minimal` lane keeps: `<name>@<marketplace>` or a bare name.
   * Absent means none.
   */
  plugins?: string[];
  /**
   * MCP servers a `minimal` lane keeps, `{ name: serverConfig }` as in a
   * `.mcp.json` `mcpServers` block. Emitted as the lane's `--mcp-config`
   * under `--strict-mcp-config`. Absent means none.
   */
  mcpServers?: Record<string, Record<string, unknown>>;
  /**
   * The explicit harness pick from the launch UI (or inherited from the
   * session this one resumes or was spawned by). Recorded on the manifest as
   * `launch.harnessChoice` so it survives resume. Absent means no pick: the
   * surface and plugins above came from the node env or the persona.
   */
  harnessChoice?: HarnessChoice;
  /**
   * The persona's `capabilities.launch.plugins`, kept ONLY when a launch pick
   * replaced it — so the manifest can name what the pick removed.
   */
  personaPlugins?: string[];
  /**
   * Install the lane read-hint hook (`harness/read-hint.mjs`): a short hint
   * after a large repository read. OFF by default — the hook ships dark until
   * the A/B in doc 01a0d2e9 has run, and `TM8_READ_HINTS=on` (node) or
   * `capabilities.launch.readHints: true` (persona) is how an arm is turned
   * on. Absent here means off. Independent of `harnessSurface`.
   */
  readHints?: boolean;
}

/** An explicit per-launch harness pick; either half may be absent. */
export interface HarnessChoice {
  surface?: HarnessSurface;
  plugins?: string[];
}

function asPluginList(value: unknown): string[] | null {
  return Array.isArray(value)
    ? value.filter((p): p is string => typeof p === 'string' && p.trim() !== '').map((p) => p.trim())
    : null;
}

/** The request's pick, else the recorded one; null when neither names anything. */
function harnessChoiceOf(
  request: SpawnRequest,
  inherited: SessionLaunchPosture | null | undefined,
): HarnessChoice | null {
  const requested: HarnessChoice = {
    ...(asHarnessSurface(request.harnessSurface) ? { surface: asHarnessSurface(request.harnessSurface)! } : {}),
    ...(asPluginList(request.plugins) ? { plugins: asPluginList(request.plugins)! } : {}),
  };
  if (Object.keys(requested).length > 0) return requested;
  const stored = inherited?.harnessChoice;
  if (!stored || typeof stored !== 'object') return null;
  const recorded: HarnessChoice = {
    ...(asHarnessSurface(stored.surface) ? { surface: asHarnessSurface(stored.surface)! } : {}),
    ...(asPluginList(stored.plugins) ? { plugins: asPluginList(stored.plugins)! } : {}),
  };
  return Object.keys(recorded).length > 0 ? recorded : null;
}

/**
 * The posture a CHILD inherits from its parent: everything but the parent's
 * harness pick. A pick in the launch UI is a human's choice for one launch of
 * one teammate, and a child may run a different teammate — a parent launched
 * with `plugins: []` must not empty the child's plugins. Resume, which
 * continues the SAME launch, reads the recorded posture whole.
 */
export function childLaunchPosture(
  parent: SessionLaunchPosture | null | undefined,
): SessionLaunchPosture | null | undefined {
  return parent?.harnessChoice ? { ...parent, harnessChoice: null } : parent;
}

/**
 * A teammate's launch preferences, read from `capabilities.launch` on the
 * persona — a stored JSON bag, so every field is narrowed, never cast:
 *   { "launch": { "harnessSurface": "inherit", "plugins": ["sales"],
 *                 "mcpServers": { "linear": { "type": "http", "url": "…" } } } }
 */
export function memberLaunchPreferences(capabilities: Record<string, unknown> | null | undefined): {
  harnessSurface: HarnessSurface | null;
  plugins: string[] | null;
  mcpServers: Record<string, Record<string, unknown>> | null;
  readHints: boolean | null;
} {
  const raw = capabilities?.launch;
  const launch = typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
  const plugins = asPluginList(launch.plugins);
  return {
    harnessSurface: asHarnessSurface(launch.harnessSurface),
    plugins,
    mcpServers: asMcpServers(launch.mcpServers),
    readHints: asReadHints(launch.readHints),
  };
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
  return ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(value)
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
  const { credentialSources, spaceCredentialIds } = resolveCredentialSources(
    request,
    inherited,
    agentTool,
  );
  const credentialSource = commonCredentialSource(credentialSources);

  // Operator env over persona over the lane default, like TM8_PERMISSION_MODE:
  // a node can flip every lane back to `inherit` without editing any persona.
  // A pick in the launch UI outranks even the node env — it is a human's
  // explicit choice for THIS launch. An inherited pick (resume, or a child of
  // a session launched with one) ranks below the env, like accessMode.
  const preferences = memberLaunchPreferences(member.capabilities);
  const choice = harnessChoiceOf(request, inherited);
  const requestedSurface = asHarnessSurface(request.harnessSurface);
  const envSurface = asHarnessSurface(env.TM8_HARNESS_SURFACE);
  const [harnessSurface, harnessSurfaceSource]: [HarnessSurface, HarnessSurfaceSource] =
    requestedSurface ? [requestedSurface, 'launch']
      : envSurface ? [envSurface, 'env']
        : choice?.surface ? [choice.surface, 'inherited']
          : preferences.harnessSurface ? [preferences.harnessSurface, 'persona']
            : ['minimal', 'default'];
  // A harness pick only means something to a claude-code lane, so no other
  // tool records one (and none can hand one to a Claude child). Under a
  // resolved `inherit` surface a plugin pick has no effect, so it is neither
  // applied nor recorded: a later lean resume must not revive a stale pick.
  const effectiveChoice: HarnessChoice | null =
    agentTool !== 'claude-code' || !choice ? null
      : harnessSurface === 'inherit' && choice.plugins
        ? (choice.surface ? { surface: choice.surface } : null)
        : choice;
  // Same precedence, but the default is OFF: this hook is an experiment that
  // has not been through its A/B yet, so merging it changes no lane. Turning
  // an arm on is `TM8_READ_HINTS=on` node-wide, or the persona's
  // `capabilities.launch.readHints`.
  const readHints =
    agentTool === 'claude-code' &&
    (asReadHints(env.TM8_READ_HINTS) ?? preferences.readHints ?? false);

  return {
    mode,
    model,
    agentTool,
    permissionMode,
    accessMode,
    reasoningEffort,
    credentialSource,
    credentialSources,
    spaceCredentialIds,
    harnessSurface,
    harnessSurfaceSource,
    plugins: effectiveChoice?.plugins ?? preferences.plugins ?? [],
    ...(effectiveChoice ? { harnessChoice: effectiveChoice } : {}),
    ...(effectiveChoice?.plugins && preferences.plugins?.length ? { personaPlugins: preferences.plugins } : {}),
    ...(preferences.mcpServers && Object.keys(preferences.mcpServers).length > 0
      ? { mcpServers: preferences.mcpServers }
      : {}),
    readHints,
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The deprecated common value: one source shared by every provider, else null. */
export function commonCredentialSource(
  credentialSources: ResolvedCredentialSources,
): CredentialSource | null {
  const commonSources = new Set(Object.values(credentialSources));
  return commonSources.size === 1 ? ([...commonSources][0] ?? null) : null;
}

/** Whether THIS request (not an inherited posture) states `space` for `provider`. */
function requestStatesSpace(request: SpawnRequest, provider: SpaceCredentialProvider): boolean {
  const own = request.credentialSources?.[provider];
  return own === 'space' || (own == null && request.credentialSource === 'space');
}

function resolveCredentialSources(
  request: SpawnRequest,
  inherited: SessionLaunchPosture | null | undefined,
  agentTool: string,
): {
  credentialSources: ResolvedCredentialSources;
  spaceCredentialIds: Partial<Record<SpaceCredentialProvider, string>>;
} {
  // A4: a pin is the request's own statement about a provider it sets to
  // `space`. An id riding beside `member`, `node`, auto or an inherited
  // source is refused, never ignored: ignoring it would launch on something
  // other than what the caller named while reporting success.
  for (const [provider, id] of Object.entries(request.spaceCredentialIds ?? {})) {
    if (id == null) continue;
    if (!isSpaceCredentialProvider(provider)) {
      throw new SpawnError(
        `spaceCredentialIds.${provider} names a provider a space cannot hold a credential for — ` +
          'only anthropic, openai and github have space credentials',
        'invalid_input',
        { provider },
      );
    }
    if (!requestStatesSpace(request, provider)) {
      throw new SpawnError(
        `spaceCredentialIds.${provider} pins a space credential, but this request does not set ` +
          `credentialSources.${provider} to 'space' — set it to 'space' to use that credential, ` +
          'or drop the id',
        'invalid_input',
        { provider },
      );
    }
    if (typeof id !== 'string' || !UUID_RE.test(id)) {
      throw new SpawnError(
        `spaceCredentialIds.${provider} is not a space credential id`,
        'invalid_input',
        { provider },
      );
    }
  }
  // Scalar `space` covers the tool's own provider (and github). A tool whose
  // provider a space cannot hold is refused by name rather than quietly run on
  // some other source — the caller asked for the space and would not get it.
  const toolProvider = agentCredentialProviderFor(agentTool);
  if (
    request.credentialSource === 'space' &&
    toolProvider !== null &&
    !isSpaceCredentialProvider(toolProvider) &&
    request.credentialSources?.[toolProvider] == null
  ) {
    throw new SpawnError(
      `credentialSource 'space' was requested for ${agentTool}, but a space cannot hold a ` +
        `${toolProvider} credential — launch with 'member' or 'node' for ${toolProvider}`,
      'invalid_input',
      { agentTool, provider: toolProvider },
    );
  }


  // What a scalar `space` covers (A4): the tool's own provider, GitHub, and any
  // provider the request pinned. NOT every space-capable provider — a codex
  // launch saying `space` must not demand an anthropic space credential it
  // will never inject.
  const scalarSpaceCovers = new Set<string>(['github']);
  if (toolProvider !== null) scalarSpaceCovers.add(toolProvider);
  for (const [provider, id] of Object.entries(request.spaceCredentialIds ?? {})) {
    if (id != null) scalarSpaceCovers.add(provider);
  }

  // The exhaustive FILE-provider table is the runtime provider source here;
  // GitHub is the one string-shaped exception. This avoids another hand-kept
  // list at the manifest seam: a seventh file provider added to the table is
  // automatically recorded, inherited and included in common-source collapse.
  const agentProviders = Object.keys(
    AGENT_CREDENTIAL_CONFIG_DIR_VAR,
  ) as AgentCredentialProvider[];
  const spaceCredentialIds: Partial<Record<SpaceCredentialProvider, string>> = {};
  const credentialSources = Object.fromEntries(
    [...agentProviders, 'github' as const].map((provider) => {
      const { source, spaceCredentialId } = resolveCredentialSource(
        provider,
        request,
        inherited,
        scalarSpaceCovers,
      );
      if (spaceCredentialId !== undefined && isSpaceCredentialProvider(provider)) {
        spaceCredentialIds[provider] = spaceCredentialId;
      }
      return [provider, source] as const;
    }),
  ) as ResolvedCredentialSources;
  return { credentialSources, spaceCredentialIds };
}

/**
 * One provider's source: request key > request scalar > inherited key >
 * inherited scalar > auto. `space` carries an id — the request's pin, or the
 * EXACT id an inherited or resumed posture recorded (A4, D6a).
 *
 * THE INHERITED HALF FAILS CLOSED (M8a). It is stored JSON, possibly written
 * by another build, and it names the credential a child or a resume will run
 * on. A value this build does not understand, or a `space` with no usable id,
 * is refused rather than narrowed to auto: auto could land on the node key or
 * on the launcher's own account, which is not what the parent ran on.
 */
function resolveCredentialSource(
  provider: keyof ResolvedCredentialSources,
  request: SpawnRequest,
  inherited: SessionLaunchPosture | null | undefined,
  scalarSpaceCovers: ReadonlySet<string>,
): { source: CredentialSource | null; spaceCredentialId?: string } {
  const spaceCapable = isSpaceCredentialProvider(provider);
  const own = asRequestedSource(request.credentialSources?.[provider]);
  if (own === 'space' && !spaceCapable) {
    throw new SpawnError(
      `credentialSources.${provider} 'space' was requested, but a space cannot hold a ` +
        `${provider} credential — launch with 'member' or 'node'`,
      'invalid_input',
      { provider },
    );
  }
  // A scalar `space` names only what it covers (see `scalarSpaceCovers`); every
  // other provider stays on auto, uninherited (the tool's own non-space
  // provider was refused above).
  const scalar = asRequestedSource(request.credentialSource);
  const requested =
    own ?? (scalar === 'space' && (!spaceCapable || !scalarSpaceCovers.has(provider)) ? undefined : scalar);
  if (requested !== undefined) {
    if (requested !== 'space') return { source: requested };
    const pin = spaceCapable ? request.spaceCredentialIds?.[provider] : undefined;
    return pin ? { source: 'space', spaceCredentialId: pin } : { source: 'space' };
  }
  if (own === undefined && scalar === 'space') return { source: null };

  const storedOwn = inherited?.credentialSources?.[provider];
  const stored = storedOwn != null ? storedOwn : inherited?.credentialSource;
  if (stored == null) return { source: null };
  if (stored === 'member' || stored === 'node') return { source: stored };
  if (stored === 'space') {
    if (!spaceCapable) {
      // Only a scalar can reach here for these providers; it never named them.
      if (storedOwn == null) return { source: null };
      throw inheritedRefusal(provider, `records 'space' for ${provider}, which a space cannot hold`);
    }
    const id = inherited?.spaceCredentialIds?.[provider];
    if (typeof id !== 'string' || !UUID_RE.test(id)) {
      throw inheritedRefusal(provider, `records 'space' for ${provider} with no space credential id`);
    }
    return { source: 'space', spaceCredentialId: id };
  }
  throw inheritedRefusal(
    provider,
    `records a ${provider} credential source this build does not understand`,
  );
}

function inheritedRefusal(provider: string, what: string): SpawnError {
  return new SpawnError(
    `the parent or resumed session's launch ${what} — refusing rather than launching on a ` +
      `different credential; name the source explicitly with credentialSources.${provider}`,
    'conflict',
    { provider },
  );
}

/** Request values are schema-checked upstream; this only narrows the type. */
function asRequestedSource(value: unknown): CredentialSource | undefined {
  return value === 'member' || value === 'space' || value === 'node' ? value : undefined;
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
    /**
     * Plugin ids (`<name>@<marketplace>`) installed in the lane's Claude
     * config home, read at spawn by `readInstalledClaudePlugins`. A `minimal`
     * launch disables every one not on `launch.plugins`. Passed in rather
     * than read here so this function stays pure.
     */
    installedClaudePlugins?: readonly string[];
    /**
     * Plugin names the lane's equipped skills live in (`equippedClaudePlugins`).
     * Allowlisted alongside `launch.plugins`: equipping a plugin skill is
     * choosing its plugin.
     */
    equippedClaudePlugins?: readonly string[];
    /**
     * The lane's `skillOverrides` (`laneSkillPlan`), built from its post-budget
     * effective skills. Absent: only the bundled-skill trim.
     */
    skillOverrides?: Readonly<Record<string, 'off' | 'name-only'>>;
    /** `false` only when a replayed plan launched without `--no-chrome`. Default: emitted. */
    noChrome?: boolean;
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
    return renderCodexCommand(
      buildCodexArgs(launch, { sandboxUnavailable: opts.sandboxUnavailable === true }),
    );
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
  // ONE flag-level settings object for everything tm8 layers onto a lane
  // (Claude Code takes a single `--settings`); each feature adds its own key.
  const settings: Record<string, unknown> = {};
  if (launch.harnessSurface !== 'inherit') {
    // The Artifact half is env, not argv: see `harnessSurfaceEnv`. Resume
    // builds on this same base command, so these flags survive `--resume`.
    args.push('--strict-mcp-config', '--mcp-config', shellQuote(minimalMcpConfig(launch.mcpServers)));
    // Drops the ~4.1k-char Claude in Chrome prompt block for this lane only;
    // the operator's own Chrome setting is untouched.
    if (opts.noChrome !== false) args.push('--no-chrome');
    const plugins = pluginSettings(opts.installedClaudePlugins ?? [], [
      ...(launch.plugins ?? []),
      ...(opts.equippedClaudePlugins ?? []),
    ]);
    if (Object.keys(plugins).length > 0) settings.enabledPlugins = plugins;
    settings.skillOverrides = opts.skillOverrides ?? laneSkillOverrides();
  }
  // Flag-level hooks merge with the user's own hooks rather than replace them.
  if (launch.readHints === true) settings.hooks = readHintHookSettings();
  if (Object.keys(settings).length > 0) {
    args.push('--settings', shellQuote(JSON.stringify(settings)));
  }
  return ['claude', ...args].join(' ');
}

/**
 * Build Codex's exact logical argv before any shell joining or quoting.
 *
 * This is the single source used by new sessions and by exact-id resume (which
 * transforms only the executable/subcommand and retains these arguments).
 */
export function buildCodexArgs(
  launch: ResolvedLaunchConfig,
  opts: { sandboxUnavailable?: boolean } = {},
): string[] {
  const args: string[] = [];
  if (launch.model) args.push('--model', launch.model);

  // Codex's approval prompts are the SAME unattended-hang hazard the Claude
  // branch documents. tm8's project trust gate is the human authorization, so
  // every non-bypass session receives an explicit non-interactive posture.
  //
  // `opts.sandboxUnavailable` collapses the second branch into the first.
  // WHY NOT KEEP `--ask-for-approval` AND DROP ONLY `--sandbox`: approvals with
  // no sandbox is a policy that stops to ask with nobody at the terminal to
  // answer — the exact unattended hang this branch was written to design out —
  // and it would buy no confinement in exchange for it. If the node cannot
  // confine, the honest command line says so in one flag rather than implying a
  // gate that will never open.
  if (launch.permissionMode === 'bypassPermissions' || opts.sandboxUnavailable === true) {
    // Explicit full access is preserved exactly: no proxy or sandbox flags are
    // injected into the opt-in bypass path.
    args.push('--dangerously-bypass-approvals-and-sandbox');
  } else {
    args.push('--ask-for-approval', mapCodexApprovalPolicy(launch.permissionMode));
    args.push('--sandbox', mapCodexSandboxMode(launch.permissionMode));
    args.push(...codexLoopbackConfigArgs());
  }

  // This PTY is always server-hosted and rendered into a browser xterm, so
  // Codex must stay inline for reconnectable scrollback.
  args.push('--no-alt-screen');

  if (launch.reasoningEffort) {
    args.push('-c', `model_reasoning_effort=${JSON.stringify(launch.reasoningEffort)}`);
  }

  // NOT passed: `--cd`. The PTY already spawns with the graph-resolved cwd.
  return args;
}

/** Quote only values whose content is not fixed CLI vocabulary. */
function renderCodexCommand(args: readonly string[]): string {
  const rendered: string[] = ['codex'];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    const previous = args[index - 1];
    rendered.push(previous === '--model' || previous === '-c' ? shellQuote(arg) : arg);
  }
  return rendered.join(' ');
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
 *
 * PRODUCTION NOTE (2026-08-24): positional task delivery is the DEFAULT again,
 * for every provider this function knows how to configure. The 2026-08-16 shape
 * — blank the positional, launch an idle REPL, then type the task into the TUI
 * through the PTY closed loop — bought a verified submit receipt at the cost of
 * making the first turn racy: the readiness gate releases on output silence,
 * and a booting claude-code can fall quiet several seconds before its composer
 * accepts input, so the task was written into a terminal that discarded it. The
 * session then reported `running` with an EMPTY prompt (live sessions 01a035b9
 * and 01a035d3, 2026-08-24: complete task prompts in both launch records, no
 * first turn in either transcript, operator pasted the task in by hand).
 *
 * argv cannot lose a race it does not run: the prompt exists at the agent's
 * first token, before any terminal is drawn. That is also why the SYSTEM half
 * never failed while the task half did — the system half was always in argv.
 * The PTY closed loop keeps its real job, delivering prompts to an agent that
 * is already live, and remains the first-turn path for operator wrappers whose
 * flag vocabulary this function refuses to guess (see `supportsPositionalPrompt`).
 */
/**
 * Whether this launch's actual binary takes its first user turn as a trailing
 * positional argument — i.e. whether {@link withAgentPrompt} will embed `task`.
 *
 * Shares `withAgentPrompt`'s resolution of which binary is really being run so
 * the two cannot drift: a caller that trusts this and skips its own first-turn
 * delivery would otherwise strand the assignment the moment the rule changed
 * in one place only. Returns false for `echo-agent` (it reads the typed
 * manifest) and for any operator `TM8_AGENT_CMD` wrapper.
 */
export function supportsPositionalPrompt(
  launch: ResolvedLaunchConfig,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env.TM8_AGENT_CMD?.trim() || AGENT_TOOL_BINARIES[launch.agentTool];
  return raw === 'claude' || raw === 'codex';
}

export function withAgentPrompt(
  command: string,
  prompts: { system: string; task: string },
  launch: ResolvedLaunchConfig,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const system = prompts.system.trim();
  const task = prompts.task.trim();
  if (system === '' && task === '') return command;

  // echo-agent reads the typed manifest directly. An operator-provided wrapper
  // is a complete command whose private flag vocabulary tm8 must not guess.
  if (!supportsPositionalPrompt(launch, env)) return command;
  const raw = env.TM8_AGENT_CMD?.trim() || AGENT_TOOL_BINARIES[launch.agentTool];

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

/** tm8 postures → Codex's `--sandbox` mode. */
function mapCodexSandboxMode(mode: PermissionMode): string {
  switch (mode) {
    case 'auto':
    case 'acceptEdits':
    case 'interactive':
    case 'readOnly':
      // Codex's legacy read-only sandbox has no supported network-enable key.
      // tm8 plan agents still have to call the loopback graph API, so they run
      // in workspace-write with source edits explicitly prohibited by the
      // trusted launch prompt. See CODEX-COMMAND-NETWORK.md.
      return 'workspace-write';
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

    // API-KEY BACKEND ROUTING — LAST, AND THE ORDER IS THE CORRECTNESS.
    //
    // A member who has connected Kimi runs `claude` against Moonshot, and one
    // who has connected Groq runs `codex` against Groq. Both are expressed the
    // same way: point the tool's vendor SDK at a different base URL and give it
    // the member's key. Nothing about the launch changes — same binary, same
    // manifest, same session row — which is why this is four lines rather than
    // a second spawn path.
    //
    // It must come after the suppression loop above, and for Groq that is not a
    // stylistic preference: `OPENAI_API_KEY` is BOTH the node key we delete and
    // the variable we set. Inject first and the delete silently removes the
    // member's key, leaving a session pointed at Groq's base URL with no
    // credential — a 401 far from here, with nothing in the environment to
    // suggest why. Suppress first, then route, and the node's value is gone and
    // the member's is the only one present.
    //
    // `apiKey` is absent for every file-shaped provider, so this branch is
    // inert for them rather than conditional on a provider list that would need
    // maintaining in a third place.
    if (isApiKeyCredentialProvider(credentialHome.provider) && credentialHome.apiKey) {
      Object.assign(env, apiKeyBackendEnv(credentialHome.provider, credentialHome.apiKey));
    }

    // A SPACE credential (design 01a0cfa8 §4), under the same law: every node
    // value for the provider is deleted FIRST and the space's key set LAST
    // (I4). For both providers the deleted name and the set name coincide, so
    // reversing the two steps would delete the space key and leave the session
    // keyless — or, with the order right but a node ANTHROPIC_AUTH_TOKEN left
    // in place, running on the node's bearer under the space's name.
    if (credentialHome.space) {
      for (const key of SPACE_CREDENTIAL_SUPPRESSED_ENV_KEYS[credentialHome.provider] ?? []) {
        delete env[key];
      }
      const keyVar = SPACE_CREDENTIAL_API_KEY_ENV[credentialHome.provider];
      if (keyVar && credentialHome.space.apiKey) env[keyVar] = credentialHome.space.apiKey;
    }
  }

  // GitHub is universal rather than agent-tool-specific. Apply after the env
  // copy loops and after XDG_CONFIG_HOME is redirected into the identity home,
  // so neither a parent token nor a machine helper/config can win precedence.
  // `space` is as strict as `member`: an explicit space token that is absent
  // must fail authentication, never reach the node's machine gh (M8b).
  isolateGitHubCredential(
    env,
    gitHubCredential,
    githubCredentialSource === 'member' || githubCredentialSource === 'space',
  );

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
  /**
   * The base command line, or a builder for it. The builder is handed the
   * plugins of the lane's POST-BUDGET effective skills (design 01a0d348 §3.1,
   * F2), which only exist once the skill index has been trimmed here — so a
   * plugin skill dropped as `byte-budget` or `native-shadowed` does not turn
   * its plugin on — and the `skillOverrides` built from the same skills
   * (absent when tm8 does not manage the lane's harness). The prompt never
   * renders the command, so building it after the trim changes no measured byte.
   */
  command:
    | string
    | ((
      effectiveClaudePlugins: readonly string[],
      skillOverrides?: Readonly<Record<string, 'off' | 'name-only'>>,
      noChrome?: boolean,
    ) => string);
  baseUrl: string;
  /** Why the launch runs unconfined, when it does. See `Tm8Manifest.launch.sandboxDegraded`. */
  sandboxDegraded?: string | null;
  /**
   * Set for a claude-code lane whose harness tm8 manages (no operator
   * `TM8_AGENT_CMD` wrapper): the plugin ids its config home carries (empty
   * under `inherit`, where none are read). Recorded as `launch.harness`, and
   * under `minimal` with plugins present it makes this launch's allow set the
   * authority on which plugin skills are native. `skills` are the operator
   * skills the same home lists (`readConfigHomeSkills`, empty under
   * `inherit`); the ones this launch did not equip are turned off
   * (`laneSkillPlan`). Absent: no harness record.
   */
  harness?: {
    installedPlugins: readonly string[];
    skills?: readonly ConfigHomeSkill[];
    /** Skill and command names the lane's workdir lists itself (`readProjectSkillKeys`). */
    projectKeys?: readonly string[];
  } | null;
  /**
   * A RESUME's replay of the skill plan its launch recorded
   * (`launch.harness.skillOverrides`, via `asRecordedSkillPlan`). Set, it
   * replaces the computed plan in argv and record alike, like
   * `replayEffectivePlugins` does for plugins. Absent: computed.
   */
  replaySkillPlan?: LaneSkillPlan | null;
  /**
   * The context-index switch (`contextIndexSwitch`), already resolved from
   * the node env and the pinned profile. Set: the launch renders
   * `<context_index>` in place of `<skills>` and trims it per group
   * (design 01a0d348 §2.3). Absent: the manifest and prompt are exactly what
   * they were before the index existed.
   */
  contextIndex?: { source: 'env' | 'profile' } | null;
  /**
   * A RESUME's replay of the plugins its launch turned on for effective
   * skills (`launch.harness.plugins.allowed[source=effective-skill]`). Set,
   * it replaces the post-trim list, because the trim depends on text (a task
   * body, a header) that may have changed since, and a resumed conversation
   * must boot with the harness it was launched with. Absent: computed.
   */
  replayEffectivePlugins?: readonly string[] | null;
  now?: Date;
  agentConfigDir?: string;
  homeDir?: string;
  /** Existence probe for a worktree's project skills (`computeEffectiveSkills`); tests inject it. */
  pathExists?: (path: string) => boolean;
}

/**
 * The pinned profile's prompt ceilings, read tolerantly; anything missing is
 * the node's hard ceiling (what an unconstrained profile allows).
 */
function promptPolicyOf(profileSnapshot: unknown): { kernelMaxBytes: number; manifestMaxBytes: number; initialContextMaxBytes: number } {
  const at = (v: unknown, key: string): unknown =>
    v && typeof v === 'object' ? (v as Record<string, unknown>)[key] : undefined;
  const policy = at(at(profileSnapshot, 'draft'), 'promptPolicy');
  const num = (key: string, fallback: number): number => {
    const value = at(policy, key);
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  };
  return {
    kernelMaxBytes: num('kernelMaxBytes', BYTE_BUDGETS.kernel),
    manifestMaxBytes: num('manifestMaxBytes', BYTE_BUDGETS.manifest),
    initialContextMaxBytes: num('initialContextMaxBytes', BYTE_BUDGETS.combinedInitialInjection),
  };
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
/**
 * The skills whose description the composed prompt actually renders: the
 * `<skills>` index carries every kept skill's description; the
 * `<context_index>` carries an entry's whenToUse always, and its summary
 * unless the budget dropped it (`summaryDropped`; `headerDropped` on a
 * pre-floor-rule manifest). Empty text is no description.
 */
function describedSkillIds(manifest: Tm8Manifest): Set<string> {
  const out = new Set<string>();
  if (manifest.contextIndex) {
    for (const group of manifest.contextIndex.groups) {
      if (group.name !== 'skills') continue;
      for (const entry of group.entries) {
        if (!entry.headerDropped && (entry.header?.whenToUse?.trim() || (!entry.summaryDropped && entry.header?.summary?.trim()))) out.add(entry.id);
      }
    }
  } else {
    for (const skill of manifest.skills) if (skill.entityId && skill.description?.trim()) out.add(skill.entityId);
  }
  return out;
}

/** Whether the composer moved the task bodies out of the task turn (`delivery="reference"` on its opening tag). */
function referencesTaskBodies(task: string): boolean {
  const open = task.split('\n', 1)[0] ?? '';
  return open.startsWith('<tm8_task_prompt ') && open.includes(' delivery="reference"');
}

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

  const equips = context.skillEquips ?? (context.skills ?? []).map(skill => ({ ...skill, depth: 0 }));
  // F2: under `minimal` with plugins in the config home, the flag-level
  // `enabledPlugins` names every installed plugin, so THIS launch decides which
  // are on — not the user's settings the skill scan read. Before the trim the
  // allow set is the launch/persona list plus the plugins of every equipped
  // plugin skill; a plugin whose skills are all trimmed below is turned off,
  // and none of its skills remain to be mis-rendered as native.
  const installedPlugins = input.harness?.installedPlugins ?? [];
  const decidesPlugins = launch.harnessSurface !== 'inherit' && installedPlugins.length > 0;
  const preBudgetAllow = [...(launch.plugins ?? []), ...equippedClaudePlugins(equips)];
  const effectiveSkills = computeEffectiveSkills({
    agentTool: launch.agentTool, workdir: workdir.path, projectRoot: context.project?.workingDir ?? null,
    equips,
    scannedAt: context.skillsScannedAt, agentConfigDir: input.agentConfigDir, homeDir: input.homeDir,
    // A worktree is a checkout OF the launch project (`resolveWorkdir`), so
    // its project skills load from the checkout, not the project root.
    ...(workdir.mode === 'worktree' && context.project ? { worktreeOfProject: true } : {}),
    ...(input.pathExists ? { pathExists: input.pathExists } : {}),
    ...(decidesPlugins
      ? { launchEnabledPlugins: installedPlugins.filter(id => isPluginAllowed(id, preBudgetAllow)) }
      : {}),
  });
  effectiveSkills.skipped.push(...(context.skippedSkills ?? []));
  const manifest: Tm8Manifest = redactSecretsDeep({
    manifestVersion: '1',
    // v1 unless the pinned profile opts a worker into v2 (spec ca8d Q14).
    promptVersion: promptVersionFor({ mode: launch.mode, profileSnapshot: interactionProfile.snapshot }),
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
      // Absent, not `{}`, when nothing ran on a space credential: 206's writer
      // checks every key against a `space` source, and a launch that never
      // touched the space writes the manifest it always wrote.
      ...(launch.spaceCredentialIds && Object.keys(launch.spaceCredentialIds).length > 0
        ? { spaceCredentialIds: { ...launch.spaceCredentialIds } }
        : {}),
      ...(launch.effectiveCredentialSources &&
      Object.keys(launch.effectiveCredentialSources).length > 0
        ? { effectiveCredentialSources: { ...launch.effectiveCredentialSources } }
        : {}),
      commandNetwork: input.commandNetwork ?? resolveCommandNetworkPolicy(launch, {}),
      sandboxDegraded: input.sandboxDegraded ?? null,
      // Set after the skill trim below, when the builder has its plugin list.
      command: typeof command === 'string' ? command : '',
      // Passed through untouched; absent stays absent so a launch without
      // Ask Jev writes the same manifest it always did.
      ...(request.jevRunId ? { jevRunId: request.jevRunId } : {}),
      // Recorded so resume replays the same sets and the same audit; absent
      // when the launch sent none, so an ordinary manifest is unchanged.
      ...(request.selection ? { selection: structuredClone(request.selection) } : {}),
      ...(request.selectionReasons ? { selectionReasons: { ...request.selectionReasons } } : {}),
      // The launch sheet's budget override, recorded so resume replays it;
      // absent when the launch sent none.
      ...(request.contextBudgets ? { contextBudgets: { ...request.contextBudgets } } : {}),
      // Absent unless the launch UI (or the session this one continues) picked
      // a harness, so an ordinary launch writes the manifest it always wrote.
      ...(launch.harnessChoice ? { harnessChoice: { ...launch.harnessChoice } } : {}),
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
    skills: [...effectiveSkills.native, ...effectiveSkills.indexed].sort((a, b) => {
      const rows = context.skillEquips ?? context.skills ?? [];
      return rows.findIndex(row => row.entityId === a.entityId) - rows.findIndex(row => row.entityId === b.entityId);
    }),
    effectiveSkills,
    ...(context.droppedSkills?.length ? { droppedSkills: context.droppedSkills } : {}),
    // Absent when the context predates memory ids, so such a spawn writes the
    // manifest it always wrote.
    ...(member.memoryIds ? { context: { memoryIds: [...member.memoryIds] } } : {}),
    coordinator: coordinatorSessionId
      ? { sessionId: coordinatorSessionId, kind: resolveCoordinatorKind(context.parentKind) }
      : null,
    directive: null,
    promptExtra: request.promptExtra?.trim() || null,
  });
  // Memories past their budget collapse into the index, lowest-ranked first
  // (design 01a0d348 §10 Q1). Only with `<context_index>`: without it there is
  // nowhere to declare a collapsed memory, and the launch behaves as it always
  // did. Measured on the redacted texts, which are the ones that ship.
  // The profile's budgets, each key replaced by this launch's override (§10 Q5.4).
  const budgets = input.contextIndex ? { ...contextBudgetsFrom(interactionProfile.snapshot), ...request.contextBudgets } : {};
  // Lenient (Subhang's rule): an override that promises more than the prompt
  // can hold beside its frame is recorded with a warning, never refused. The
  // trim below still bounds the prompt, and records what it cut.
  const budgetWarning = request.contextBudgets
    ? contextBudgetOverrun({
      promptPolicy: promptPolicyOf(interactionProfile.snapshot),
      contextBudgets: { ...contextBudgetsFrom(interactionProfile.snapshot), ...request.contextBudgets },
    })
    : null;
  let memoryCollapse: MemoryCollapseResult | null = null;
  const collapsedMemories: PromptContextEntry[] = [];
  if (input.contextIndex) {
    const ids = manifest.context?.memoryIds ?? [];
    const texts = (manifest.agent.memory as unknown[]).map(String);
    const via = context.contextAudit?.memoryVia ?? ids.map(() => 'teammate' as const);
    memoryCollapse = collapseMemories({
      texts: texts.slice(0, ids.length),
      ids,
      via,
      legacy: texts.slice(ids.length),
      scores: context.memoryScores ?? [],
      cap: budgets.memories ?? BYTE_BUDGETS.memoryInjection,
    });
    if (memoryCollapse.collapsed.length > 0) {
      const headers = new Map((context.headers ?? []).map(h => [h.entityId, h]));
      // Highest-ranked first in the group, so an index trim drops the lowest.
      for (const i of [...memoryCollapse.collapsed].reverse()) {
        collapsedMemories.push(collapsedMemoryEntry(ids[i]!, texts[i]!, via[i] ?? 'teammate', headers.get(ids[i]!)));
      }
      manifest.agent.memory = [...memoryCollapse.kept.map(i => texts[i]!), ...texts.slice(ids.length)];
      manifest.context = { ...manifest.context, memoryIds: memoryCollapse.kept.map(i => ids[i]!) };
    }
  }
  // Measure the real non-index prompt once, then account for the exact escaped
  // serializer. This stays linear even when a deep equipment chain has no count cap.
  let baseline: ReturnType<typeof composePrompt>;
  try {
    baseline = composePrompt({ ...manifest, skills: [] }, { sessionId, baseUrl });
  } catch (error) {
    // Critical memories never collapse; when what they borrowed pushes the
    // prompt over, the refusal names the budget that was overrun (§10 Q1 rule 2).
    if (error instanceof BudgetExceededError && memoryCollapse && memoryCollapse.borrowed > 0) {
      throw new BudgetExceededError('memoryInjection', error.bytes, error.cap);
    }
    throw error;
  }
  const baseBytes = utf8Bytes(`${baseline.system}\n\n${baseline.task}`);
  const dropped: ManifestSkillContext[] = [];
  let indexFit: FitContextIndexResult | null = null;
  if (input.contextIndex) {
    // `<context_index>` (design 01a0d348 §2.3): references and teammates trim
    // to their sub-caps, skills to what remains, header text before entries.
    // Candidates are redacted BEFORE the trim, so the bytes it counts are the
    // bytes that ship.
    const candidates = redactSecretsDeep(contextIndexCandidates({ context, skills: manifest.skills, memories: collapsedMemories }));
    const caps = contextIndexCaps(launch.mode, budgets);
    const ceiling = BYTE_BUDGETS.combinedInitialInjection;
    const fitAt = (available: number): FitContextIndexResult => fitContextIndex({ groups: [...candidates], available, caps });
    // A task turn too big to inline is switched WHOLE to references by the
    // composer, which keeps the prompt under the ceiling by moving the task
    // bodies out of it. The index must never buy its room that way.
    const inline = !referencesTaskBodies(baseline.task);
    /** The real prompt with this index, measured: every title the index names leaves the task turn. */
    const composedBytes = (fit: FitContextIndexResult): number => {
      const gone = new Set(fit.drops.filter(d => d.group === 'skills' && d.level === 'entry').map(d => d.id));
      try {
        const p = composePrompt({ ...manifest, skills: manifest.skills.filter(skill => !gone.has(skill.entityId)), contextIndex: fit.index }, { sessionId, baseUrl });
        if (inline && referencesTaskBodies(p.task)) return Number.POSITIVE_INFINITY;
        return utf8Bytes(`${p.system}\n\n${p.task}`);
      } catch (error) {
        if (error instanceof BudgetExceededError) return Number.POSITIVE_INFINITY;
        throw error;
      }
    };
    let available = ceiling - baseBytes;
    indexFit = fitAt(available);
    // The baseline lists every linked title in the task turn, and the titles
    // the index names leave it, so the first fit leaves that room unused. Hand
    // it back to the index while something was dropped, re-measuring the real
    // prompt each time; a retry that would overrun the ceiling is discarded,
    // so the first (conservative) fit is the floor. The room handed back is
    // the real prompt's slack LESS what the fit was offered and did not use:
    // that part is already in `available`, and spending it twice overshoots
    // by up to an entry (review #832), which the composer would then settle by
    // moving the task bodies out.
    for (let tries = 0; tries < 3 && indexFit.drops.length > 0; tries += 1) {
      const room = ceiling - composedBytes(indexFit) - (available - indexFit.bytes);
      if (!(room > 0)) break;
      const retry = fitAt(available + room);
      if (composedBytes(retry) > ceiling) break;
      if (retry.drops.length >= indexFit.drops.length && retry.bytes <= indexFit.bytes) break;
      available += room;
      indexFit = retry;
    }
    const gone = new Set(indexFit.drops.filter(d => d.group === 'skills' && d.level === 'entry').map(d => d.id));
    dropped.push(...manifest.skills.filter(skill => gone.has(skill.entityId)));
    manifest.skills = manifest.skills.filter(skill => !gone.has(skill.entityId));
    manifest.contextIndex = indexFit.index;
  } else {
    let indexBytes = manifest.skills.length ? utf8Bytes(serializeSkillIndex(manifest.skills)) + 1 : 0;
    while (baseBytes + indexBytes > BYTE_BUDGETS.combinedInitialInjection && manifest.skills.length) {
      const removed = manifest.skills.pop()!;
      dropped.push(removed);
      indexBytes = manifest.skills.length ? indexBytes - utf8Bytes(serializeSkillIndexEntry(removed)) - 1 : 0;
    }
    dropped.reverse();
  }
  if (dropped.length) {
    manifest.droppedSkills = [...(manifest.droppedSkills ?? []), ...dropped.map(skill => skill.name)];
    const kept = new Set(manifest.skills.map(skill => skill.entityId));
    const audit = manifest.effectiveSkills!;
    audit.native = audit.native.filter(skill => kept.has(skill.entityId));
    audit.indexed = audit.indexed.filter(skill => kept.has(skill.entityId));
    audit.skipped.push(...dropped.map(skill => ({ entityId: skill.entityId, name: skill.name, hash: skill.hash, sourcePath: skill.sourcePath, reason: 'byte-budget' })));
  }

  // F2: the plugin allow set follows the skills that SURVIVED the trim (and
  // the native-shadow pass), so the argv and `launch.harness.plugins` are
  // built from one list and cannot disagree.
  const keptRows = new Map(equips.map(row => [row.entityId, row]));
  const effectiveClaudePlugins = input.replayEffectivePlugins
    ? [...input.replayEffectivePlugins].sort()
    : equippedClaudePlugins(manifest.skills.flatMap(skill => keptRows.get(skill.entityId) ?? []));
  // The same post-trim skills decide `skillOverrides`, argv and record alike.
  // A native skill goes `name-only` only when tm8's prompt carries its
  // description: with the context index on, the budget can drop an entry's
  // header while keeping its line, and name-only would then leave the skill
  // described nowhere.
  const described = describedSkillIds(manifest);
  const skillPlan = !input.harness || launch.harnessSurface === 'inherit' ? null
    : input.replaySkillPlan
      ? structuredClone(input.replaySkillPlan)
      : laneSkillPlan(
        input.harness.skills ?? [],
        (manifest.effectiveSkills?.native ?? []).map(skill => ({ ...skill, described: described.has(skill.entityId) })),
        input.harness.projectKeys ?? [],
      );
  if (typeof command !== 'string') {
    manifest.launch.command = redactSecretsDeep(command(effectiveClaudePlugins, skillPlan?.settings, skillPlan?.noChrome));
  }
  if (input.harness) {
    const launchPick = launch.harnessChoice?.plugins ?? null;
    const plugins = installedPlugins.length > 0
      ? pluginDecisions(installedPlugins, {
        launchPick,
        persona: launchPick ? launch.personaPlugins ?? [] : launch.plugins ?? [],
        effective: effectiveClaudePlugins,
      })
      : null;
    manifest.launch.harness = laneHarnessRecord(launch, plugins, skillPlan?.record ?? null);
  }

  // The launch-context audit (§6): ids and enums only, after every trim.
  manifest.context = {
    ...(manifest.context ?? {}),
    ...buildManifestContext({
      context,
      skills: manifest.skills,
      skippedSkills: manifest.effectiveSkills?.skipped ?? [],
      ...(request.selection ? { requestSelection: request.selection } : {}),
      ...(request.selectionReasons ? { selectionReasons: request.selectionReasons } : {}),
      ...(request.selectionReplayInvalid ? { selectionReplayInvalid: true } : {}),
      ...(indexFit ? { index: indexFit } : {}),
      ...(memoryCollapse ? { memoryCollapse } : {}),
    }),
    ...(input.contextIndex && indexFit
      ? {
          index: {
            source: input.contextIndex.source,
            bytes: indexFit.bytes,
            caps: contextIndexCaps(launch.mode, budgets),
            ...(Object.keys(budgets).length > 0 ? { profileBudgets: Object.keys(budgets).sort() } : {}),
          },
        }
      : {}),
    ...(memoryCollapse || request.contextBudgets
      ? {
          budgets: {
            ...(memoryCollapse ? { memoryInjection: { cap: memoryCollapse.cap, used: memoryCollapse.used, borrowed: memoryCollapse.borrowed } } : {}),
            ...(request.contextBudgets ? { launch: { ...request.contextBudgets } } : {}),
            ...(budgetWarning ? { warning: { code: 'context_budgets_over_ceiling' as const, ...budgetWarning } } : {}),
          },
        }
      : {}),
  };
  composePrompt(manifest, { sessionId, baseUrl });
  return manifest;
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
