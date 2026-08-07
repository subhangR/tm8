// @tm8/execution — the spawn block's public surface.
export { SpawnService, type SpawnServiceOptions } from './SpawnService.js';
export {
  DEFAULT_AGENT_TOOL,
  DEFAULT_MODEL,
  DEFAULT_PERMISSION_MODE,
  ECHO_AGENT_CMD,
  CODEX_LOOPBACK_CONFIG_OVERRIDES,
  CODEX_LOOPBACK_HOSTS,
  agentToolForModel,
  buildAgentCommand,
  buildCodexArgs,
  codexLoopbackConfigArgs,
  composeEnv,
  composeManifest,
  echoAgentPath,
  resolveLaunchConfig,
  resolveCommandNetworkPolicy,
  resolveWorkdir,
  shellQuote,
  withAgentResume,
  type ComposeManifestInput,
  type ResolvedLaunchConfig,
} from './manifest.js';
export {
  assertCodexNetworkFeatureList,
  assertCodexNetworkRuntimeVersion,
  MINIMUM_CODEX_LOOPBACK_PROXY_VERSION,
  preflightCodexNetworkPolicy,
  type CodexNetworkPreflight,
} from './codex-network-preflight.js';
export {
  extractCodexRolloutIdentity,
  resolveCodexNativeSessionId,
  type CodexRolloutIdentity,
} from './native-session.js';
export { SpawnError } from './types.js';
export {
  branchNameFor,
  provisionWorktree,
  type ProvisionedWorktree,
  type ProvisionWorktreeParams,
} from './worktree-provisioning.js';
export {
  reconcileNodeWorktrees,
  type ReconcileParams,
  type WorktreeQuarantine,
  type WorktreeReconcileReport,
  type WorktreeRepair,
} from './worktree-reconcile.js';
export type {
  AgentMode,
  CommandNetworkPolicy,
  CreateWorkSessionInput,
  CreateWorkSessionResult,
  GraphAuth,
  GraphPort,
  LoadSpawnContextInput,
  PermissionMode,
  ProjectContext,
  ResolvedInteractionProfileContext,
  InteractionProfilePinContext,
  RecordCommandInput,
  ResumeRequest,
  ResumeWorkSessionResult,
  SessionLaunchPosture,
  SpawnContext,
  SpawnRequest,
  SpawnResult,
  TaskContext,
  TeamMemberContext,
  Tm8Manifest,
  TransitionInput,
  WorkdirMode,
  WorkSessionResumeInfo,
  WorkSessionStatus,
  WorktreeAllocationRow,
  WorktreeAllocationState,
} from './types.js';
