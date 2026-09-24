// @tm8/execution — SpawnService: the G1A loop's engine.
//
// Owns the four verbs the loop is made of — spawn, prompt, terminate, and the
// PTY-exit transition — and nothing else. It has no database driver, no HTTP
// knowledge and no contract types: the graph arrives as `GraphPort`, the
// terminal as `PtyHostService`, and both are swappable in tests. The whole
// point is that the PTY assertions can run with no Postgres at all.

import { randomUUID } from 'node:crypto';
import { access, chmod, lstat, mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { PtyHostService } from '../pty/PtyHostService.js';
import type {
  PromptSettlementResult,
  PromptSettlementWaiter,
} from '../pty/PromptSettlementWaiter.js';
import type { Logger, PtyActivity, PtyExitInfo, PtyKillOutcome, PtySessionStatus } from '../pty/types.js';
import {
  BYTE_BUDGETS,
  composePrompt,
  primaryContextBudgetV2,
  PROMPT_VERSION_V2,
  utf8Bytes,
  type PromptRuntime,
} from '@tm8/prompt';

import { oomKillObserved, readOomKillCount } from './oom-witness.js';
import { trustClaudeWorkspace, trustCodexWorkspace } from './workspace-trust.js';
import {
  preflightCodexNetworkPolicy,
  type CodexNetworkPreflight,
} from './codex-network-preflight.js';
import {
  buildAgentCommand,
  childLaunchPosture,
  composeEnv,
  composeManifest,
  resolveAgentBinary,
  resolveCommandNetworkPolicy,
  resolveCoordinatorSessionId,
  resolveLaunchConfig,
  resolveSessionTitle,
  resolveWorkdir,
  supportsPositionalPrompt,
  withAgentPrompt,
  withAgentResume,
  type ResolvedLaunchConfig,
} from './manifest.js';
import { detectCheckoutBranch } from './checkout-branch.js';
import { claudePluginConfigDir, harnessSurfaceEnv, readInstalledClaudePlugins } from './harness-surface.js';
import { contextHeaderIds, contextIndexForResume, contextIndexSwitch } from './context-index.js';
import { resolveCodexNativeSessionId } from './native-session.js';
import { knownAgentConfigDirs } from '../transcript/agent-config-dirs.js';
import { readSessionUsage } from '../transcript/session-usage.js';
import { probeCodexSandbox } from './sandbox-probe.js';
import {
  agentCredentialProviderFor,
  type AgentCredentialHome,
  type AgentCredentialHomePort,
} from './agent-credentials.js';
import {
  API_KEY_PROVIDER_DISPLAY_NAME,
  apiKeyBackendForModel,
  isApiKeyCredentialProvider,
} from '../credentials/api-key-credentials.js';
import {
  resolveSessionCredentials,
  type ResolvedSessionCredentials,
} from './credential-resolution.js';
import {
  materializeSpaceApiKeyHome,
  scrubSpaceSessionSecrets,
  sweepSpaceSessionSecrets,
} from './space-credential-session-home.js';
import type { WorktreeManager } from '../worktree/WorktreeManager.js';
import { provisionWorktree, type ProvisionedWorktree } from './worktree-provisioning.js';
import { reconcileNodeWorktrees, type WorktreeReconcileReport } from './worktree-reconcile.js';
import {
  ShellSessionLauncher,
  loginShellCommand,
  resolveLoginShell,
} from '../shell/ShellSessionLauncher.js';
import type {
  CredentialSource,
  GraphAuth,
  GraphPort,
  GitHubCredential,
  GitHubCredentialPort,
  InteractionProfilePinContext,
  ResumeRequest,
  SessionLaunchPosture,
  ShellSessionRequest,
  ShellSessionResult,
  SpawnContext,
  SpawnRequest,
  SpawnResult,
  SpaceCredentialPort,
  Tm8Manifest,
  TransitionInput,
  WorkSessionEndedKind,
  WorkSessionStatus,
  WorktreeAllocationRow,
  GhostReconcileReport,
} from './types.js';
import { SpawnError } from './types.js';
import { SpawnSelectionReasonsSchema, SpawnSelectionSchema, type SpawnSelection } from '@tm8/contract';

/**
 * Why a credential containment killed a session (`containCredentialSession`).
 *   - `space_credential_deleted`: SC-3 — a space credential was deleted.
 *   - `member_credential_disconnected`: the member Disconnect of their own credential.
 *   - `member_removed`: SC-6 — the launching member was removed or disabled.
 */
export type CredentialContainmentCause =
  | 'space_credential_deleted'
  | 'member_credential_disconnected'
  | 'member_removed';

/**
 * What a containment kill did. `outcome` is the PTY host's own answer;
 * `recorded` is whether the row's ending was written. `killed` with
 * `recorded: false` is a dead process whose row still reads live — `reason`
 * says why, for the caller's `failures`.
 */
export interface CredentialContainmentResult {
  outcome: PtyKillOutcome;
  recorded: boolean;
  reason?: string;
}

/**
 * The ending each containment records. `endedReason` is read by a person (one
 * plain sentence, per 171); `error` stays technical. Fixed strings: nothing
 * about the credential — its label, id or secret — is interpolated (I5).
 */
const CREDENTIAL_CONTAINMENT_ENDINGS: Record<
  CredentialContainmentCause,
  { endedReason: string; error: string }
> = {
  space_credential_deleted: {
    endedReason: 'Stopped because the space credential it was running on was deleted.',
    error:
      'credential containment: the space credential this session launched on was deleted — ' +
      'PTY killed, exit code not observed',
  },
  member_credential_disconnected: {
    endedReason: 'Stopped because the credential it was running on was disconnected.',
    error:
      'credential containment: the member credential this session ran on was disconnected — ' +
      'PTY killed, exit code not observed',
  },
  member_removed: {
    endedReason:
      'Stopped because the member who launched it no longer has access to the space credential it was running on.',
    error:
      'credential containment: the launching member was removed or disabled — ' +
      'PTY killed, exit code not observed',
  },
};

/** Why a session became live: see `SpawnService.onSessionLive`. */
export type SessionLiveCause = 'spawn' | 'resume' | 'running' | 'idle';
export type SessionLiveListener = (sessionId: string, cause: SessionLiveCause) => void | Promise<void>;

export interface SpawnServiceOptions {
  graph: GraphPort;
  pty: PtyHostService;
  /** Where the agent reports back — becomes TM8_BASE_URL. */
  baseUrl: string;
  /** Node data root. Manifests land in `<dataDir>/manifests/`. Default `~/.tm8-dev`. */
  dataDir?: string;
  /** Identifies this node in `work_sessions.node_id`. */
  nodeId?: string | null;
  logger?: Logger;
  /** Injected for tests. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Window in which a child exit makes spawn itself fail. Default 150ms. */
  bootSettlementMs?: number;
  /**
   * Production's closed-loop PTY settlement bridge. When present, a fresh
   * spawn queues its first task through the same verified submit path as every
   * later message and does not acknowledge until that outcome settles.
   * Optional for legacy embedders which constructed their PTY before the
   * callback bridge existed; those retain the argv positional fallback.
   */
  promptSettlement?: Pick<PromptSettlementWaiter, 'awaitOutcome' | 'cancel'>;
  /**
   * Hard ceiling for first-turn settlement. Default 150s.
   *
   * This is a BACKSTOP against a wedged delivery, so it must stay strictly
   * larger than the closed loop's own worst case — a ceiling tighter than the
   * work it bounds fails sessions that were about to succeed. Cold-path budget,
   * summing PtyHostService's constants: 45s readiness gate + 22s arrival
   * confirmation (three body writes with a 5s re-settle between) + ~1.3s
   * pre-submit floor + ~36s submit-verify backoff ≈ 104s.
   */
  firstPromptSettlementMs?: number;
  /** Base delay for retrying a failed terminal-state write. Default 1s. */
  failedTransitionRetryMs?: number;
  /** Injected only for deterministic compatibility-preflight tests. */
  codexNetworkPreflight?: CodexNetworkPreflight;
  /**
   * Resolves the spawning identity's own vendor credential home, so an agent
   * authenticates as the MEMBER rather than as the node's machine account.
   *
   * OPTIONAL. A node that does not wire it injects nothing and behaves exactly
   * as it did before — which is what lets this land ahead of the settings
   * screen that populates the credentials, without a feature flag.
   */
  credentialHome?: AgentCredentialHomePort;
  /** Caller-owned GitHub token store, resolved independently of agent vendor. */
  gitHubCredentials?: GitHubCredentialPort;
  /**
   * SPACE credentials (206), the D4 rung between the member's own and the
   * node's. OPTIONAL: without it an explicit `space` source is refused by name
   * and auto runs member → node exactly as before.
   */
  spaceCredentials?: SpaceCredentialPort;
  /**
   * The node's Git worktree manager. Its PRESENCE is what makes
   * `workdir.mode:'worktree'` serviceable — omit it and the mode is refused by
   * name, never silently downgraded to the project directory (§7.4).
   */
  worktrees?: WorktreeManager;
  /**
   * §5.2's worktree cap — separate from the session cap because it bounds a
   * different scarce resource (disk and `.git/worktrees` metadata) and one
   * worktree outlives many sessions. 0 means unbounded.
   */
  worktreeCap?: number;
}

/**
 * The outcome of the sandbox preflight for one launch.
 *
 * Returned rather than stashed on the service, because spawns run CONCURRENTLY
 * — five at once across both providers is a supported case and was measured
 * working — and a mutable "last degradation" field would let one launch's
 * verdict land on another's manifest. The decision belongs to the launch that
 * asked for it.
 */
interface SandboxDecision {
  /** `buildAgentCommand` must not emit a sandbox flag it cannot honour. */
  unavailable: boolean;
  /** Why, in one sentence, for the manifest. Null when nothing was degraded. */
  degradedReason: string | null;
}

/** The ordinary case: whatever the posture asked for, the node can give it. */
const CONFINED: SandboxDecision = { unavailable: false, degradedReason: null };

/** How long a v2 launch waits for its task's context render before degrading. */
const TASK_CONTEXT_RENDER_TIMEOUT_MS = 5_000;

/** PTY exit status → work_session status. The PTY speaks in outcomes, the
 *  graph in lifecycle states, and 'completed' is not one of the five the
 *  001 CHECK constraint allows. */
const EXIT_STATUS_MAP: Record<PtySessionStatus, WorkSessionStatus> = {
  completed: 'exited',
  failed: 'failed',
};

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

/**
 * Tighten an application-owned directory even when it predates the permission
 * boundary. `mkdir({ mode })` only applies to directories it creates, so it is
 * not enough for an upgraded node whose roots already exist as 0755.
 */
async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const info = await lstat(path);
  if (!info.isDirectory()) {
    throw new Error(`private tm8 data root is not a directory: ${path}`);
  }
  await chmod(path, PRIVATE_DIRECTORY_MODE);
}

/**
 * Repair regular files already present in a private data root. Symlinks and
 * special files are deliberately ignored: following one during remediation
 * could chmod a target outside the tm8 data directory.
 */
async function repairPrivateFiles(path: string): Promise<void> {
  const entries = await readdir(path, { withFileTypes: true });
  await Promise.all(
    entries.map(async (entry) => {
      const entryPath = join(path, entry.name);
      const info = await lstat(entryPath);
      if (info.isFile()) await chmod(entryPath, PRIVATE_FILE_MODE);
    }),
  );
}

/** A 0700 scratch root is sufficient to protect everything below it, but its
 * existing per-session directories are tightened as defence in depth. */
async function repairPrivateChildDirectories(path: string): Promise<void> {
  const entries = await readdir(path, { withFileTypes: true });
  await Promise.all(
    entries.map(async (entry) => {
      const entryPath = join(path, entry.name);
      const info = await lstat(entryPath);
      if (info.isDirectory()) await chmod(entryPath, PRIVATE_DIRECTORY_MODE);
    }),
  );
}

/**
 * "Is there still a directory at this path?" — the observation resume needs
 * before it will honour a recorded worktree path.
 *
 * `stat`, not `lstat`: a worktree reachable through a symlinked path is still
 * reachable, and refusing it would fail a resume that would have worked. Any
 * error at all (gone, unreadable, a file) answers `false` — the caller's only
 * two options are "use this directory" or "refuse", and every error means the
 * first one is not available.
 */
async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** Per-session bound on the usage read inside `recordShutdown`. See there. */
const SHUTDOWN_USAGE_READ_MS = 2_000;

/**
 * Turn a {@link PtyExitInfo} into the honest, human-readable statement that
 * lands in `work_sessions.error` for a NATURAL exit.
 *
 * The record law this exists to satisfy: a died session must persist the exit
 * code, the terminating signal, or a NAMED unknown — never silence. Before
 * this existed, `handlePtyExit` passed no `exitCode` and no `error` at all for
 * ANY exit, so `work_sessions.error` and `.exit_code` were both NULL for every
 * agent death this process ever recorded, for either tool — indistinguishable
 * from a row nobody thought to fill in. A clean `completed` exit (code 0)
 * needs no narrative — `exit_code = 0` already says it plainly — so this is
 * only called for the `failed` branch.
 */
function describePtyExit(exitInfo: PtyExitInfo): string {
  const { exitCode, signal } = exitInfo;
  if (signal !== null && exitCode !== null) {
    return `agent process exited with code ${String(exitCode)} after signal ${String(signal)}`;
  }
  if (signal !== null) {
    return `agent process was terminated by signal ${String(signal)}`;
  }
  if (exitCode !== null) {
    return `agent process exited with code ${String(exitCode)}`;
  }
  // The true "we could not determine how" case — node-pty reported neither.
  // An explicit statement, not a blank field: NULL here would read exactly
  // like the pre-fix silence this function exists to end.
  return 'agent process exited; neither an exit code nor a signal was reported';
}

/**
 * The same PTY exit, said to a PERSON (171).
 *
 * `describePtyExit` above is the technical diagnostic and keeps its job. This
 * is the other half: one sentence, no signal numbers, no exit codes, no jargon.
 * The reader is someone looking at a list of sessions wondering why one of
 * theirs stopped, and "terminated by signal 9" tells them nothing they can act
 * on. It is a separate function rather than a rewrite because BOTH are wanted —
 * `error` for whoever is debugging, `ended_reason` for whoever is working.
 *
 * `killedForMemory` is the caller's kernel evidence, never inferred here: a
 * deploy's SIGKILL and the OOM killer's SIGKILL are identical at this layer,
 * and guessing between them would launder a deploy bug as an infrastructure
 * fact. See `oom-witness.ts`.
 */
function endingFromPtyExit(
  status: PtySessionStatus,
  exitInfo: PtyExitInfo,
  killedForMemory: boolean,
): { endedKind: WorkSessionEndedKind; endedReason: string } {
  if (killedForMemory) {
    return {
      endedKind: 'out_of_memory',
      endedReason:
        'Stopped because the machine ran out of memory. This session was using too much, ' +
        'and the system shut it down to stay alive.',
    };
  }
  if (status === 'completed') {
    return { endedKind: 'completed', endedReason: 'Finished on its own.' };
  }
  // A signal death that was NOT a memory kill. This is the deploy/restart
  // shape — but from here it is genuinely indistinguishable from an operator
  // running `kill` by hand, so the sentence says what is known and stops.
  // `reconcileNodeGhosts` is where a restart CAN be named, because a whole
  // node's worth of sessions dying at once is itself the evidence.
  if (exitInfo.signal !== null) {
    return {
      endedKind: 'crashed',
      endedReason: 'Stopped by the system before it finished. It can be resumed to try again.',
    };
  }
  return {
    endedKind: 'crashed',
    endedReason:
      exitInfo.exitCode === null
        ? 'Stopped unexpectedly, and no reason was reported. It can be resumed to try again.'
        : 'Stopped because it hit an error and could not continue. It can be resumed to try again.',
  };
}

/**
 * The first user turn: the composed task, plus the caller's appendix. The
 * appendix is offered only the bytes the combined budget has left, so a large
 * task turn shrinks the appendix and never the reverse; one that ignores its
 * allowance refuses the launch rather than being clipped (§8.1).
 */
function firstTurn(
  envelope: { system: string; task: string },
  sessionId: string,
  request: SpawnRequest,
): string {
  if (!request.firstTurnAppendix) return envelope.task;
  const used = utf8Bytes(`${envelope.system}\n\n${envelope.task}\n\n`);
  const room = BYTE_BUDGETS.combinedInitialInjection - used;
  const appendix = room > 0 ? request.firstTurnAppendix(sessionId, room) : '';
  if (!appendix) {
    throw new SpawnError(
      `the first turn has no room for its appendix (${String(room)} bytes left)`,
      'invalid_input',
      { sessionId, room },
    );
  }
  if (utf8Bytes(appendix) > room) {
    throw new SpawnError(
      `the first-turn appendix is ${String(utf8Bytes(appendix))} bytes, over the ${String(room)} left`,
      'invalid_input',
      { sessionId, room },
    );
  }
  return `${envelope.task}\n\n${appendix}`;
}

export class SpawnService {
  private readonly graph: GraphPort;
  private readonly pty: PtyHostService;
  private readonly baseUrl: string;
  private readonly dataDir: string;
  private readonly nodeId: string | null;
  private readonly logger: Logger | undefined;
  private readonly env: NodeJS.ProcessEnv;
  private readonly bootSettlementMs: number;
  private readonly promptSettlement: Pick<PromptSettlementWaiter, 'awaitOutcome' | 'cancel'> | undefined;
  private readonly firstPromptSettlementMs: number;
  private readonly failedTransitionRetryMs: number;
  private readonly codexNetworkPreflight: CodexNetworkPreflight;
  private readonly credentialHome: AgentCredentialHomePort | undefined;
  private readonly gitHubCredentials: GitHubCredentialPort | undefined;
  private readonly spaceCredentials: SpaceCredentialPort | undefined;
  private readonly worktrees: WorktreeManager | null;
  private readonly worktreeCap: number;
  /** One fail-closed remediation pass per service lifetime. */
  private privateDataLayoutReady: Promise<void> | undefined;

  /**
   * Claims captured at spawn time, replayed for that session's exit transition.
   *
   * This map is not a cache — it is the only way the exit path can write to the
   * graph at all. `work_session_transition` calls `internal.require_space_member`
   * (002_identity.sql:297), which calls `require_identity()`, and there is NO
   * node-admin bypass on that path. A PTY exiting three hours after the request
   * that spawned it has no ambient identity, so without the spawner's claims the
   * transition raises 42501 and the session stays 'running' forever — a ghost
   * row that the UI shows as a live agent and the concurrency cap counts against
   * every future spawn.
   *
   * Attributing the exit to the spawner is also correct on the merits: they are
   * the actor who started it.
   */
  private readonly sessionAuth = new Map<string, GraphAuth>();
  /**
   * The cgroup OOM-kill counter as it stood when each session's PTY was
   * spawned (171). The exit path compares against it: an ADVANCE across a
   * session's lifetime is kernel evidence that a memory kill happened, which
   * is the only thing that can separate the OOM killer's SIGKILL from a
   * deploy's — they are identical at the process level.
   *
   * Keyed by session id and deleted on exit, exactly as `sessionAuth` is, so a
   * long-lived node does not accumulate one integer per session it ever ran.
   */
  private readonly oomKillAtSpawn = new Map<string, number | null>();
  /** Failed spawn terminal writes retried for this process lifetime. Startup
   * ghost reconciliation is the second line of defence after a node restart. */
  private readonly failedTransitionRetries = new Map<string, ReturnType<typeof setTimeout>>();

  /** Drain-on-live listeners (Forms W2, 214). See `onSessionLive`. */
  private readonly sessionLiveListeners = new Set<SessionLiveListener>();

  constructor(options: SpawnServiceOptions) {
    this.graph = options.graph;
    this.pty = options.pty;
    this.baseUrl = options.baseUrl;
    this.dataDir = options.dataDir ?? join(homedir(), '.tm8-dev');
    this.nodeId = options.nodeId ?? null;
    this.logger = options.logger;
    this.env = options.env ?? process.env;
    this.bootSettlementMs = options.bootSettlementMs ?? 150;
    this.promptSettlement = options.promptSettlement;
    this.firstPromptSettlementMs = options.firstPromptSettlementMs ?? 150_000;
    this.failedTransitionRetryMs = options.failedTransitionRetryMs ?? 1_000;
    this.codexNetworkPreflight = options.codexNetworkPreflight ?? preflightCodexNetworkPolicy;
    this.credentialHome = options.credentialHome;
    this.gitHubCredentials = options.gitHubCredentials;
    this.spaceCredentials = options.spaceCredentials;
    this.worktrees = options.worktrees ?? null;
    this.worktreeCap = options.worktreeCap ?? 0;
  }

  /**
   * The spawning identity's credential home for this session's agent tool, or
   * null when there is nothing to inject.
   *
   * ERRORS ARE NOT SWALLOWED: silently falling back to the node's machine
   * account would make a session run under the wrong identity.
   *
   * `source` is the launch-time choice. `'node'` skips the lookup entirely.
   * `'member'` REFUSES the launch when no active credential exists — the
   * member asked to run as themselves, and quietly running them as the node
   * instead is the exact lie the credential store exists to stop. Auto (null)
   * keeps the pre-field behaviour byte for byte.
   *
   * MEMBER REFUSES ON TWO DIFFERENT FACTS, and they are worth keeping apart.
   * `null` means the member connected nothing. A KEYLESS API-key home means
   * they connected a pasted-key provider and its stored key could not be read
   * (`agent-credential-injection.ts` answers that with a keyless home rather
   * than `null`, because `null` would leave the node's own key live in the
   * composed environment). AUTO IS DELIBERATELY NOT REFUSED on a keyless home:
   * there it is what suppresses the node key, and it must reach `composeEnv`
   * intact.
   *
   * A MODEL SERVED BY AN API-KEY BACKEND (a Kimi model on `claude-code`, a Groq
   * model on `codex`) has exactly one route: the member's own key for that
   * backend. There is no node credential for it and no native provider that
   * serves it, so `source` does not apply, and a missing or unreadable key
   * refuses the launch in every posture — naming the key — rather than
   * starting a session whose first request goes to a vendor that does not
   * serve its model.
   */
  private async resolveCredentialHome(
    auth: GraphAuth,
    agentTool: string,
    model: string | null,
    source: CredentialSource | null = null,
  ): Promise<AgentCredentialHome | null> {
    const backend = apiKeyBackendForModel(agentTool, model);
    if (backend) {
      const home = this.credentialHome
        ? await this.credentialHome.resolve(auth, { agentTool, model })
        : null;
      const name = API_KEY_PROVIDER_DISPLAY_NAME[backend];
      if (!home || home.provider !== backend) {
        throw new SpawnError(
          `${model} runs only on your own ${name} key, and no ${name} key is connected ` +
            'for your account — connect it under Settings → Connections, or pick a model ' +
            `that ${agentTool} runs natively`,
          'conflict',
          { agentTool, model, provider: backend },
        );
      }
      if (home.apiKey === undefined) {
        throw new SpawnError(
          `${model} runs only on your own ${name} key, and your connected ${name} key ` +
            'could not be read — reconnect it under Settings → Connections',
          'conflict',
          { agentTool, model, provider: backend },
        );
      }
      return home;
    }

    if (source === 'node') return null;
    const home = this.credentialHome
      ? await this.credentialHome.resolve(auth, { agentTool, model })
      : null;
    if (source === 'member' && !home && agentCredentialProviderFor(agentTool)) {
      throw new SpawnError(
        `credentialSources.${agentCredentialProviderFor(agentTool)} 'member' was requested but no active ${agentCredentialProviderFor(agentTool)} ` +
          'credential is connected for your account — connect it under Settings → Connections, ' +
          "or launch with the node credential ('node')",
        'conflict',
        { agentTool, provider: agentCredentialProviderFor(agentTool) },
      );
    }
    if (source === 'member' && home && isApiKeyCredentialProvider(home.provider)
      && home.apiKey === undefined) {
      throw new SpawnError(
        `credentialSources.${home.provider} 'member' was requested and a ${home.provider} ` +
          'credential is connected, but its stored key could not be read — reconnect it ' +
          "under Settings → Connections, or launch with the node credential ('node')",
        'conflict',
        // The ACTUAL provider, not the tool's native one, so the member is
        // pointed at the credential that is the problem.
        { agentTool, provider: home.provider },
      );
    }
    return home;
  }

  /**
   * Resolve the caller's GitHub row. `node` deliberately skips it. Errors are
   * never swallowed: in member posture, degrading to the node's machine login
   * is an attribution bug, not an availability feature.
   */
  private async resolveGitHubCredential(
    auth: GraphAuth,
    source: CredentialSource | null = null,
  ): Promise<GitHubCredential | null> {
    if (source === 'node' || !this.gitHubCredentials) return null;
    return this.gitHubCredentials.resolve(auth);
  }

  /**
   * Every credential a session runs on, member → space → node under D5
   * (`credential-resolution.ts`, the ONLY place the policy is enforced). A
   * space API key is materialized into the session's own 0700 home from the
   * key read NOW, so a resume picks up a rekey (D7).
   */
  private resolveSessionCredentials(
    auth: GraphAuth,
    spaceId: string,
    sessionId: string,
    launch: ResolvedLaunchConfig,
    resume = false,
  ): Promise<ResolvedSessionCredentials> {
    return resolveSessionCredentials(
      { auth, spaceId, launch, resume },
      {
        ...(this.spaceCredentials ? { spaceCredentials: this.spaceCredentials } : {}),
        resolveMemberHome: (source) =>
          this.resolveCredentialHome(auth, launch.agentTool, launch.model, source),
        resolveMemberGitHub: () => this.resolveGitHubCredential(auth, null),
        materializeApiKeyHome: (input) =>
          materializeSpaceApiKeyHome({ dataDir: this.dataDir, sessionId, ...input }),
      },
    );
  }

  /**
   * M7: the space credentials a session launched on are re-read AFTER its PTY
   * exists. A delete that revoked one between our read and now found no PTY to
   * kill (SC-3 kills by recorded session), so this is the check that closes
   * that window; a delete from here on finds the PTY. Refuses on a read error
   * too — an unanswerable question is not an active credential.
   */
  private async assertSpaceCredentialsStillActive(
    auth: GraphAuth,
    sessionId: string,
    credentialIds: readonly string[],
  ): Promise<void> {
    if (credentialIds.length === 0 || !this.spaceCredentials) return;
    let active: ReadonlySet<string>;
    try {
      active = await this.spaceCredentials.activeIds(auth, credentialIds);
    } catch (error) {
      throw new SpawnError(
        'could not re-check the space credentials this session launched on, so it was stopped ' +
          'rather than left running on one that may have been deleted — retry',
        'internal',
        { sessionId, cause: error instanceof Error ? error.message : String(error) },
      );
    }
    const gone = credentialIds.filter((id) => !active.has(id));
    if (gone.length > 0) {
      throw new SpawnError(
        `space credential ${gone.join(', ')} was deleted or disabled while this session was ` +
          'starting, so it was stopped — launch again to use another credential',
        'conflict',
        { sessionId, spaceCredentialIds: gone },
      );
    }
  }

  /**
   * Scrub a session's space API key from its per-session home, keeping its
   * conversation state. Best effort and silent about contents (I5): a failure
   * is logged by session id only, and the boot sweep retries it.
   */
  private async scrubSpaceSecrets(sessionId: string): Promise<void> {
    try {
      await scrubSpaceSessionSecrets(this.dataDir, sessionId);
    } catch (error) {
      this.logger?.warn?.('SpawnService: could not scrub a session space credential home', {
        sessionId,
        code: (error as NodeJS.ErrnoException).code ?? 'unknown',
      });
    }
  }

  /**
   * The boot sweep for space API keys: scrub every per-session home whose
   * session has no live PTY and no in-flight claims here. A crash skips the
   * exit path; this is what catches it.
   *
   * Safe at boot ONLY because no agent survives the server: PTYs die with it
   * (the unit's KillMode=control-group, PtyHostService.ts ~585). An
   * agent that outlived a restart would find its key scrubbed mid-session.
   */
  async sweepSpaceSessionSecrets(): Promise<{ scrubbed: string[]; errors: string[] }> {
    const result = await sweepSpaceSessionSecrets(
      this.dataDir,
      (sessionId) => this.pty.hasSession(sessionId) || this.sessionAuth.has(sessionId),
    );
    if (result.scrubbed.length > 0 || result.errors.length > 0) {
      this.logger?.info('SpawnService: swept space credential session homes', {
        scrubbed: result.scrubbed.length,
        errors: result.errors,
      });
    }
    return result;
  }

  /**
   * One spawn/resume gate for binary presence and Codex proxy compatibility.
   */
  private async assertAgentRuntime(
    baseCommand: string,
    launch: ResolvedLaunchConfig,
    env: NodeJS.ProcessEnv,
  ): Promise<void> {
    const binary = baseCommand.split(' ')[0] ?? '';
    const unquoted = binary.replace(/^'|'$/g, '');
    const resolved = resolveAgentBinary(unquoted, env.PATH ?? '');
    if (resolved === null) {
      throw new SpawnError(
        `agent CLI '${unquoted}' was not found — install it, or point TM8_AGENT_CMD at it. ` +
          `Looked on PATH: ${env.PATH ?? '(empty)'}`,
        'not_found',
        { agentTool: launch.agentTool, binary: unquoted },
      );
    }

    const override = this.env.TM8_AGENT_CMD?.trim();
    if (
      launch.agentTool === 'codex' &&
      launch.permissionMode !== 'bypassPermissions' &&
      (!override || override === 'codex')
    ) {
      await this.codexNetworkPreflight(resolved, env);
    }
  }

  /**
   * §4.1 admission plus §4.2-4.7, for a spawn that asked for isolation.
   *
   * Every refusal here NAMES its reason, and none of them falls back to the
   * project directory. That is §7.4's first prohibition and the reason the
   * whole feature exists: a session told it is isolated, running in the shared
   * checkout, is worse than a session that refused to start.
   */
  private async provisionWorktreeFor(
    auth: GraphAuth,
    request: SpawnRequest,
    context: SpawnContext,
    requestedBaseRef: string | null,
  ): Promise<ProvisionedWorktree> {
    if (!this.worktrees) {
      throw new SpawnError(
        'this node cannot provision worktrees — no worktree area is configured',
        'invalid_input',
        { reason: 'worktree_unavailable' },
      );
    }
    if (!context.project) {
      // Matches the shipped guard the design points at (048:77): a worktree is
      // a checkout OF something, and without a project there is nothing to
      // check out.
      throw new SpawnError(
        'workdir.mode "worktree" requires a project',
        'invalid_input',
        { reason: 'worktree_requires_project' },
      );
    }
    if (!this.nodeId) {
      // `worktree_allocations.node_id` is NOT NULL for a reason: an allocation
      // nobody owns is one nobody reconciles, which is a leaked checkout.
      throw new SpawnError(
        'this node has no stable identity — refusing to allocate a worktree it could not later reconcile',
        'internal',
        { reason: 'worktree_no_node_identity' },
      );
    }

    return provisionWorktree({
      auth,
      graph: this.graph,
      manager: this.worktrees,
      spaceId: request.spaceId,
      projectId: context.project.id,
      projectWorkingDir: context.project.workingDir,
      requestedBaseRef,
      nodeId: this.nodeId,
      cap: this.worktreeCap,
      clientMutationId: request.clientMutationId ?? null,
      logger: this.logger,
    });
  }

  /**
   * §6 — startup reconciliation for this node's worktree allocations.
   *
   * Exposed like `reconcileNodeGhosts` and with the same posture: the
   * composition root owns the ordering, it never rejects, and it is cleanup
   * rather than a precondition for serving traffic.
   */
  async reconcileNodeWorktrees(auth: GraphAuth): Promise<WorktreeReconcileReport> {
    if (!this.worktrees || !this.nodeId) {
      return { examined: 0, repaired: [], quarantined: [], errors: [] };
    }
    return reconcileNodeWorktrees({
      auth,
      graph: this.graph,
      manager: this.worktrees,
      nodeId: this.nodeId,
      hasLivePty: (sessionId) => this.pty.hasSession(sessionId),
      repoRootFor: (projectId) =>
        this.graph.loadProjectWorkingDir(auth, projectId).catch(() => null),
      logger: this.logger,
    });
  }

  private manifestPathFor(sessionId: string): string {
    return join(this.dataDir, 'manifests', `${sessionId}.json`);
  }

  /**
   * Record the session's lane fact (107) — NEVER load-bearing for a launch.
   * A session that cannot report its branch is degraded, not broken, so this
   * logs and returns instead of throwing; the row simply keeps NULL and the
   * lane line renders no claim.
   */
  private async captureCheckoutBranch(
    auth: GraphAuth,
    sessionId: string,
    branch: string | null,
  ): Promise<void> {
    try {
      await this.graph.recordCheckoutBranch(auth, sessionId, branch);
    } catch (error) {
      this.logger?.warn?.('SpawnService: could not record the checkout branch fact', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * The plugins a `minimal` Claude lane must turn off, read from the config
   * home the child will run under: the member's credential home when there is
   * one, else the node's `CLAUDE_CONFIG_DIR`, else `~/.claude` — the same
   * resolution `recordManifest` records. Empty (no read at all) for any other
   * tool, for `inherit`, and under an operator `TM8_AGENT_CMD` wrapper.
   */
  /**
   * Whether tm8 shapes this lane's harness surface at all, and so records it
   * as `launch.harness`: a claude-code lane not run through an operator
   * `TM8_AGENT_CMD` wrapper, which replaces the whole command line.
   */
  private managesClaudeHarness(launch: ResolvedLaunchConfig): boolean {
    return launch.agentTool === 'claude-code' && !this.env.TM8_AGENT_CMD?.trim();
  }

  private installedClaudePluginsFor(
    launch: ResolvedLaunchConfig,
    credentialConfigDir: string | undefined,
  ): string[] {
    if (launch.agentTool !== 'claude-code' || launch.harnessSurface === 'inherit') return [];
    if (this.env.TM8_AGENT_CMD?.trim()) return [];
    return readInstalledClaudePlugins(claudePluginConfigDir(credentialConfigDir, this.env));
  }

  /**
   * Decide what a launch is allowed to do when the node cannot actually give it
   * the sandbox its posture asks for. Returns whether `buildAgentCommand` must
   * drop `--sandbox`; throws when the launch may not proceed at all.
   *
   * THE DEFECT THIS CLOSES is not "codex could not sandbox" — it is that tm8
   * asked for a sandbox it could not have, got a session that could not run a
   * single command, and then reported that session as healthy for as long as
   * anyone cared to look. Measured on the prod node 2026-08-02: spawn returned
   * in 0.77s, `status` stayed `running`, `session liveness` kept listing it,
   * and every command inside it died with `bwrap: loopback: Failed RTM_NEWADDR`.
   *
   * WHY IT DEGRADES RATHER THAN REFUSES, which is a reversal worth explaining.
   * The first cut of this refused the spawn outright, on the argument that
   * running unconfined should require someone to say so. That argument is right
   * about the direction and wrong about the baseline, and old maestro is the
   * evidence: its codex spawner has flag-for-flag the same branch as ours, and
   * it ran fifteen real codex sessions to completion on THIS node — building
   * PDFs, generating image sets, hundreds of shell commands. It managed that
   * because nothing in maestro ever resolved a posture that demanded a sandbox:
   * maestro has no default permission mode at all, so a session fell through to
   * whatever its team member was configured with, and those were configured
   * `bypassPermissions`.
   *
   * tm8 then invented `auto`, made it `DEFAULT_PERMISSION_MODE`, and mapped it
   * to `--ask-for-approval never --sandbox workspace-write`. Maestro has no
   * `auto` in either vocabulary — its accessMode union is
   * `['safe','acceptEdits','plan','fullAccess']`. So tm8 created a default that
   * silently REQUIRES a working sandbox where its own behavioural oracle
   * required nothing, and every codex teammate created without an explicit
   * posture inherited it. That is the regression, and refusing the spawn would
   * have made tm8 stricter than the thing it was ported from while still not
   * running any codex — a worse outcome on both axes.
   *
   * So the default matches the oracle: the launch proceeds. What it does NOT do
   * is proceed silently. The degradation is logged in full and recorded on the
   * manifest as `sandboxDegraded`, so "this agent is running unconfined" is a
   * fact someone can read rather than one they have to reproduce. That is the
   * part the status quo was missing — codex was ALREADY running unconfined
   * wherever a teammate was set to `bypassPermissions`, with nothing anywhere
   * saying so.
   *
   * An operator who genuinely requires confinement sets
   * `TM8_REQUIRE_CODEX_SANDBOX=1` and gets the refusal instead — the strict
   * posture is still one env var away, it just is not imposed on a node whose
   * predecessor never imposed it.
   *
   * The probe result is cached for the process, so this costs one subprocess
   * per node boot, not one per spawn.
   */
  private async resolveSandboxPosture(launch: ResolvedLaunchConfig): Promise<SandboxDecision> {
    // Only codex has an OS-level sandbox tm8 drives through flags. Claude Code's
    // permission modes are enforced inside the agent, so there is nothing here
    // to probe and nothing that can silently fail this way.
    if (launch.agentTool !== 'codex') return CONFINED;
    if (launch.permissionMode === 'bypassPermissions') return CONFINED;

    const availability = await probeCodexSandbox({
      binary: this.env.TM8_AGENT_CMD?.trim() || 'codex',
      env: this.env,
      logger: this.logger,
    });
    if (availability.usable) return CONFINED;

    const strict = this.env.TM8_REQUIRE_CODEX_SANDBOX?.trim() === '1';
    if (strict) {
      throw new SpawnError(
        `this node cannot sandbox codex and TM8_REQUIRE_CODEX_SANDBOX=1 forbids running it ` +
          `unconfined, so a '${launch.permissionMode}' launch cannot be honoured: ` +
          `${availability.detail}. ` +
          `Fix the node (on Ubuntu 24.04 this is usually AppArmor's unprivileged-userns restriction — ` +
          `installing the 'bubblewrap' package supplies /etc/apparmor.d/bwrap-userns-restrict and puts a ` +
          `profiled bwrap on PATH), or unset TM8_REQUIRE_CODEX_SANDBOX to let the launch proceed ` +
          `unconfined and recorded.`,
        'conflict',
        {
          agentTool: launch.agentTool,
          permissionMode: launch.permissionMode,
          sandboxProbe: availability.reason,
        },
      );
    }

    // Proceeding unconfined. Said ONCE, in full, at the moment it actually
    // happens, and recorded on the manifest besides — the failure this whole
    // path exists to end was not "codex ran unconfined", it was that nothing
    // anywhere said which of the two things had happened.
    this.logger?.warn?.(
      'SpawnService: launching codex UNCONFINED — this node cannot sandbox it. ' +
        'Install the `bubblewrap` package to restore confinement, or set ' +
        'TM8_REQUIRE_CODEX_SANDBOX=1 to refuse these launches instead.',
      {
        requestedPermissionMode: launch.permissionMode,
        sandboxProbe: availability.reason,
        detail: availability.detail,
      },
    );
    return { unavailable: true, degradedReason: availability.detail };
  }

  /**
   * Where this session's `tm8` invocations append their command journal.
   *
   * Session-keyed and a sibling of `manifests/`, deliberately NOT the session's
   * cwd: a project-backed session's cwd is the SHARED project directory, so a
   * journal written there would have every session of that project appending
   * to one file, inside the user's repo.
   *
   * The file itself is created by the first `tm8` invocation, not here — a
   * session that never runs a command correctly has no journal, and the read
   * side reports that as `available: false` rather than as an empty one.
   */
  private journalPathFor(sessionId: string): string {
    return join(this.dataDir, 'journals', `${sessionId}.jsonl`);
  }

  /**
   * Manifests contain the full persona and task briefing, journals contain
   * command output, and scratch directories contain the agent's files. They
   * are one confidentiality boundary and must be repaired together.
   *
   * This runs lazily on the first non-replayed spawn/resume so a permission
   * failure participates in the existing failed-session cleanup path. Caching
   * the promise also prevents concurrent spawns from racing the same sweep.
   */
  private ensurePrivateDataLayout(): Promise<void> {
    if (this.privateDataLayoutReady) return this.privateDataLayoutReady;

    this.privateDataLayoutReady = (async () => {
      const manifests = join(this.dataDir, 'manifests');
      const journals = join(this.dataDir, 'journals');
      const scratch = join(this.dataDir, 'scratch');

      await Promise.all([
        ensurePrivateDirectory(manifests),
        ensurePrivateDirectory(journals),
        ensurePrivateDirectory(scratch),
      ]);
      await Promise.all([
        repairPrivateFiles(manifests),
        repairPrivateFiles(journals),
        repairPrivateChildDirectories(scratch),
      ]);
    })();

    return this.privateDataLayoutReady;
  }

  private async ensurePrivateScratchDirectory(path: string): Promise<void> {
    await mkdir(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    // As above, `mode` does not repair an existing directory (notably resume).
    await chmod(path, PRIVATE_DIRECTORY_MODE);
  }

  /**
   * A session's OWN recorded posture, for resume. Same read as
   * `inheritedPosture` and the same failure posture (a warning, then the
   * ordinary precedence chain), pointed at the session itself.
   */
  private async recordedPosture(
    auth: GraphAuth,
    sessionId: string,
  ): Promise<{ posture: SessionLaunchPosture | null; unreadable: boolean }> {
    try {
      return { posture: await this.graph.loadSessionLaunchPosture(auth, sessionId), unreadable: false };
    } catch (error) {
      this.logger?.warn?.('SpawnService: could not read the recorded posture of a resuming session', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return { posture: null, unreadable: true };
    }
  }

  /**
   * Resume's space-credential gate, run BEFORE the PTY (C3). The DB's
   * session_space_credentials rows are the authority on what this session ran
   * on; the recorded posture only names it. So:
   *   - a session resolved onto space credentials re-points them to the
   *     resumer (206 refuses unless every one is still active), and what 206
   *     recorded must be exactly what resolution chose;
   *   - a session whose posture could not be read is asked the DB directly:
   *     had it run on a space credential, re-resolving it from nothing would
   *     silently move it onto member or node, so that refuses.
   */
  private async repointSpaceCredentials(
    auth: GraphAuth,
    sessionId: string,
    resolved: ResolvedSessionCredentials,
    postureUnreadable: boolean,
  ): Promise<void> {
    if (!this.spaceCredentials) return;
    if (resolved.spaceCredentialIds.length === 0 && !postureUnreadable) return;
    let repoint;
    try {
      repoint = await this.spaceCredentials.repointSession(auth, sessionId);
    } catch (error) {
      throw new SpawnError(
        'could not re-point the space credentials this session runs on to you, so the resume ' +
          'is refused rather than run with the wrong launcher on record — retry',
        'internal',
        { sessionId, cause: error instanceof Error ? error.message : String(error) },
      );
    }
    if (!repoint.ok) {
      throw new SpawnError(
        'a space credential this session launched on has been deleted or is no longer usable, ' +
          'so it cannot resume on it — start a new session with another credential',
        'conflict',
        { sessionId, reason: repoint.reason },
      );
    }
    const chosen = resolved.launch.spaceCredentialIds ?? {};
    const recorded = new Map(repoint.credentials.map((c) => [c.provider, c.spaceCredentialId]));
    const agrees =
      recorded.size === Object.keys(chosen).length &&
      [...recorded].every(([provider, id]) => chosen[provider] === id);
    if (!agrees) {
      throw new SpawnError(
        postureUnreadable
          ? "this session's recorded launch could not be read and it ran on a space credential, " +
              'so it is not resumed on a different one — retry, or start a new session'
          : 'the space credentials recorded for this session do not match its manifest, so the ' +
              'resume is refused — start a new session',
        'conflict',
        { sessionId },
      );
    }
  }

  /**
   * The parent session's recorded posture, when this spawn is a child and named
   * no posture of its own.
   *
   * A session spawned BY a session is unattended twice over: nobody is at its
   * PTY, and nobody is at its parent's either. Dropping such a child back to the
   * persona default is what makes a delegated agent sit forever on an approval
   * prompt that no human will ever see, so the parent's posture carries down.
   *
   * An explicit `accessMode` on the request still wins over the parent's —
   * `resolveLaunchConfig` ranks the request first — but the parent is READ
   * regardless: its credential sources and exact space credential ids carry
   * down whatever posture the child names (A4, D6a).
   *
   * Two deliberate silences, both "no inheritance" rather than a failure:
   *   - a root spawn (no parent) has nothing to inherit from
   *   - an unreadable or missing parent manifest is a WARNING, never a refused
   *     spawn: posture inheritance is a default-selection convenience, and
   *     failing a launch over a convenience would trade a stalled child for no
   *     child at all
   */
  private async inheritedPosture(
    auth: GraphAuth,
    request: SpawnRequest,
  ): Promise<SessionLaunchPosture | null> {
    const parentSessionId = request.parentSessionId ?? null;
    if (!parentSessionId) return null;
    try {
      return await this.graph.loadSessionLaunchPosture(auth, parentSessionId);
    } catch (error) {
      this.logger?.warn?.('SpawnService: could not read the parent session posture to inherit', {
        parentSessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * The spawn flow, in the only order that is safe:
   *   1. read the graph (persona, project, tasks) — nothing has been created yet
   *   2. resolve launch config + cwd IN-PROCESS
   *   3. `execution_spawn` — the work_session row and `working_on` edges, one tx
   *   4. compose the manifest, write the FILE and record the ROW
   *   5. queue the first task, spawn the PTY, and await verified submission
   *   6. transition to `running`
   *
   * Steps 1-2 precede 3 because the RPC persists the resolved model/agentTool/
   * mode onto the row, and resolving them needs the persona's defaults. Step 4
   * precedes 5 because the agent reads the manifest at boot — a PTY started
   * before the file exists races its own configuration.
   */
  /**
   * The per-launch facts only the v2 frame reads (spec ca8d §2): the primary
   * task's context DTO, rendered now — after the session row exists, so as its
   * actor and with the task already `working` — and whether the cwd holds a
   * code graph. A v1 launch reads neither and pays for neither.
   *
   * A failed or slow render never fails the launch (§2.3): the header then
   * says `snapshot="unavailable"` with the reason and names the one read to run.
   */
  private async promptV2Runtime(
    auth: GraphAuth,
    manifest: Tm8Manifest,
    sessionId: string,
    cwd: string,
  ): Promise<Pick<PromptRuntime, 'taskContext' | 'codeGraph'>> {
    if (manifest.promptVersion !== PROMPT_VERSION_V2) return {};
    const codeGraph = await access(join(cwd, 'graphify-out', 'merged-graph.json')).then(
      () => true,
      () => false,
    );
    const primary = manifest.tasks[0];
    if (!primary) return { codeGraph };
    const load = this.graph.loadTaskContextSnapshot?.bind(this.graph);
    if (!load) return { codeGraph, taskContext: { taskId: primary.id, unavailable: 'not_supported' } };
    let timer: NodeJS.Timeout | undefined;
    try {
      const dto = await Promise.race([
        load(auth, { sessionId, taskId: primary.id, totalBytes: primaryContextBudgetV2(manifest.tasks) }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(Object.assign(new Error('context render timed out'), { code: 'timeout' })), TASK_CONTEXT_RENDER_TIMEOUT_MS);
        }),
      ]);
      return { codeGraph, taskContext: { taskId: primary.id, dto } };
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      this.logger?.warn?.('spawn: v2 task context render failed', { sessionId, taskId: primary.id, error: String(error) });
      return {
        codeGraph,
        taskContext: { taskId: primary.id, unavailable: typeof code === 'string' && code !== '' ? code : 'render_failed' },
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * The selection headers `<context_index>` renders, read under the caller's
   * RLS after the context load (so a spawn's refusals keep their order). A
   * graph without the read renders the index from the loader's own rows.
   */
  private async loadIndexHeaders(auth: GraphAuth, context: SpawnContext, jevRunId?: string): Promise<void> {
    if (this.graph.loadContextHeaders) {
      context.headers = await this.graph.loadContextHeaders(auth, {
        spaceId: context.spaceId,
        ids: contextHeaderIds(context),
      });
    }
    // The launch's Jev run ranks its memories for the collapse (§10 Q1).
    const memoryIds = context.teamMember.memoryIds ?? [];
    if (jevRunId && memoryIds.length > 0 && this.graph.loadMemoryScores) {
      const scores = await this.graph.loadMemoryScores(auth, { spaceId: context.spaceId, jevRunId, memoryIds });
      if (scores.length > 0) context.memoryScores = scores;
    }
  }

  async spawn(auth: GraphAuth, request: SpawnRequest): Promise<SpawnResult> {
    const taskIds = request.taskIds ?? [];
    let bootExit: PtyExitInfo | undefined;
    let firstPromptDeliveryId: string | undefined;

    const context = await this.graph.loadSpawnContext(auth, {
      spaceId: request.spaceId,
      teamMemberId: request.teamMemberId,
      projectId: request.projectId ?? null,
      taskIds,
      // 176: the loader resolves the parent's KIND for the manifest's
      // coordinator block. Passed even for non-coordinated modes because the
      // launch config that decides coordination has not been resolved yet, and
      // re-reading the graph after it would be a second round trip describing
      // a later instant than the persona it is composed beside.
      parentSessionId: request.parentSessionId ?? null,
      ...(request.memoryIds?.length ? { memoryIds: request.memoryIds } : {}),
      ...(request.selection ? { selection: request.selection } : {}),
    });

    // A child inherits its parent's posture but not its harness pick; only a
    // resume replays the pick, because only a resume is the same launch. An
    // explicit inheritPosture (Forms W2) is the requester's OWN recorded launch
    // replayed, so it keeps its pick: dropping a plugin allow set could widen it.
    const inherited = request.inheritPosture !== undefined
      ? request.inheritPosture
      : childLaunchPosture(await this.inheritedPosture(auth, request));
    const launch = resolveLaunchConfig(request, context, this.env, inherited);
    // Fail before creating a work_session row when a coordinated mode has no
    // concrete parent to receive its result. composeManifest repeats this
    // guard so direct callers cannot manufacture an unroutable prompt.
    resolveCoordinatorSessionId(launch.mode, request.parentSessionId);
    const commandNetwork = resolveCommandNetworkPolicy(launch, this.env);
    if (inherited) {
      this.logger?.info('SpawnService: child inherits its parent session posture', {
        parentSessionId: request.parentSessionId,
        accessMode: launch.accessMode,
        permissionMode: launch.permissionMode,
      });
    }
    // Pre-mint Claude's NATIVE conversation id (maestro's claude-spawner
    // pattern): `--session-id <uuid>` makes Claude adopt tm8's uuid, so resume
    // needs no transcript parsing — the id is known before the agent exists.
    // Codex cannot be pre-seeded; its rollout id is captured at resume time
    // (see native-session.ts). An operator wrapper gets neither: tm8 must not
    // guess flags into a command it does not own.
    const nativeSessionId =
      !this.env.TM8_AGENT_CMD?.trim() && launch.agentTool === 'claude-code' ? randomUUID() : null;
    const title = resolveSessionTitle(request, context);
    const workdir = resolveWorkdir(request, context, {
      scratchRoot: join(this.dataDir, 'scratch'),
    });

    // Worktree mode provisions BEFORE the work_session row exists, because the
    // row must persist the path the PTY will actually use — that is §1.2's
    // shipped scratch defect (a row recording `.../pending`) not being
    // reintroduced. Everything after this point treats the worktree as just
    // another workdir.
    const worktree =
      workdir.mode === 'worktree'
        ? await this.provisionWorktreeFor(auth, request, context, workdir.baseRef)
        : null;

    // The lane fact (107). Worktree mode knows its branch without a probe —
    // provisioning just created it. Project mode asks the SHARED checkout what
    // it has right now; a non-repo or detached HEAD answers null, which is
    // recorded as "no claim". Scratch has no repo by construction.
    const checkoutBranch = worktree
      ? worktree.branch
      : workdir.mode === 'project'
        ? await detectCheckoutBranch(workdir.path)
        : null;

    const resolvedProfile = await this.graph.resolveInteractionProfile(auth, {
      spaceId: request.spaceId,
      teamMemberId: request.teamMemberId,
      interactionProfileId: request.interactionProfileId ?? null,
    });
    // `<context_index>` (design 01a0d348 §2), shipped dark: the node env or
    // the pinned profile turns it on, and only then are its headers read.
    const indexSwitch = contextIndexSwitch(this.env, resolvedProfile.snapshot);
    const contextIndex = indexSwitch.on ? { source: indexSwitch.source } : null;
    if (contextIndex) await this.loadIndexHeaders(auth, context, request.jevRunId);

    const { sessionId, commandResult, replayed } = await this.graph.createWorkSession(auth, {
      spaceId: request.spaceId,
      teamMemberId: request.teamMemberId,
      parentSessionId: request.parentSessionId ?? null,
      taskIds,
      projectId: request.projectId ?? null,
      workdirMode: workdir.mode,
      workdirPath: worktree ? worktree.path : workdir.path,
      // The SYMBOLIC ref the server actually resolved, not the one asked for:
      // an absent `baseRef` becomes the repository's own HEAD branch, and
      // recording the request rather than the resolution would make the row a
      // plausible record instead of a reproducible one (§4.3).
      baseRef: worktree ? worktree.baseRef : workdir.baseRef,
      mode: launch.mode,
      model: launch.model,
      agentTool: launch.agentTool,
      title,
      nodeId: this.nodeId,
      confirmUntrusted: request.confirmUntrusted ?? false,
      clientMutationId: request.clientMutationId ?? null,
    });

    // A projectless scratch session's directory is named for the session, which
    // only exists now. Re-resolve so the manifest and the PTY agree.
    //
    // A worktree's path needed no session id — it was computed from an id
    // generated before any write — so it is simply the path, and the row above
    // persisted this exact string (G3.6).
    const cwd = worktree
      ? worktree.path
      : context.project
        ? workdir.path
        : join(this.dataDir, 'scratch', sessionId);

    // A ledger replay is a transport retry of the original command result, not
    // permission to boot another child under the old work-session id.
    if (replayed) {
      // No sandbox preflight on a replay branch: this re-renders the ORIGINAL
      // command result and boots no child, so it cannot produce a session that
      // looks alive and is not. Preflighting here would let a node whose
      // sandbox broke since the first call turn a successful, already-completed
      // spawn into an error on retry, which is precisely what idempotent replay
      // exists to prevent.
      const command = buildAgentCommand(launch, this.env);
      const manifestPath = this.manifestPathFor(sessionId);
      const manifest = composeManifest({
        sessionId,
        request,
        context,
        launch,
        commandNetwork,
        interactionProfile: { ...resolvedProfile, pinRevision: 0 },
        workdir: { mode: workdir.mode, path: cwd },
        command,
        contextIndex,
        baseUrl: this.baseUrl,
      });
      return {
        sessionId,
        manifestPath,
        manifest,
        command,
        cwd,
        envVarNames: [],
        reused: true,
        commandResult,
      };
    }

    this.sessionAuth.set(sessionId, auth);
    // The OOM baseline, captured with the claims because it is the same kind
    // of launch-time bookkeeping and must exist before the PTY can die (171).
    this.oomKillAtSpawn.set(sessionId, await readOomKillCount());
    let spaceCredentialIds: string[] = [];

    try {
      // Step 7 (§4.8) — publish. The lease and the association need the session
      // id, so they are the one part of the saga that cannot run before the row
      // exists. `ready` is last: it is the claim that this checkout is usable,
      // and claiming it before the lease is held would let a second spawn take
      // a worktree this one is about to boot into.
      if (worktree) {
        await this.graph.acquireWorktreeLease(auth, worktree.worktreeId, sessionId);
        await this.graph.linkSessionToWorktree(auth, {
          spaceId: request.spaceId,
          sessionId,
          worktreeId: worktree.worktreeId,
        });
        await this.graph.setWorktreeAllocationState(auth, {
          worktreeId: worktree.worktreeId,
          state: 'ready',
        });
      }

      // The lane fact needs the row, so this is the earliest it can land —
      // recorded before the PTY exists so even a session that dies in its
      // boot window already answers "what branch was I on".
      if (checkoutBranch !== null) {
        await this.captureCheckoutBranch(auth, sessionId, checkoutBranch);
      }

      // The pre-minted Claude id is graph truth from the moment the session
      // exists — recorded BEFORE the PTY spawns, so even a session that dies
      // in its boot window is already resume-capable.
      if (nativeSessionId) {
        await this.graph.recordNativeSessionId(auth, sessionId, nativeSessionId);
      }
      const interactionProfile = await this.graph.recordInteractionProfilePin(
        auth,
        sessionId,
        resolvedProfile,
      );
      const agentToken = await this.graph.issueWorkSessionAgentToken(
        auth,
        sessionId,
        request.teamMemberId,
      );
      // The base command is built FIRST and recorded in the manifest; the system
      // prompt is then derived FROM that manifest and appended to produce the
      // line the PTY actually runs. See `withAgentPrompt` for why this is two
      // steps and not one — it unties an apparent circular dependency.
      // Preflight the sandbox BEFORE the command is built, so that a node which
      // cannot honour this posture refuses here — with a sentence naming the
      // precondition — instead of booting an agent that will look healthy and
      // be unable to run anything. Throws unless the operator has opted in.
      const sandbox = await this.resolveSandboxPosture(launch);
      const manifestPath = this.manifestPathFor(sessionId);
      const credentials = await this.resolveSessionCredentials(
        auth,
        request.spaceId,
        sessionId,
        launch,
      );
      spaceCredentialIds = credentials.spaceCredentialIds;
      const { credentialHome, gitHubCredential } = credentials;
      // Built after the credentials because a `minimal` launch reads the
      // plugin registry of the config home the child will actually use.
      // Read once: the same lists build the argv and the manifest's record of
      // it, so the two cannot disagree about a plugin.
      // The command is built INSIDE composeManifest, after the skill index is
      // trimmed, from the plugins of the skills that survived (F2).
      const installedPlugins = this.installedClaudePluginsFor(launch, credentialHome?.configDir);
      let baseCommand = '';
      const manifest = composeManifest({
        agentConfigDir: credentialHome?.configDir ?? (launch.agentTool === 'codex' ? this.env.CODEX_HOME : this.env.CLAUDE_CONFIG_DIR),
        homeDir: this.env.HOME ?? homedir(),
        sessionId,
        request,
        context,
        // The RESOLVED sources: auto that landed on the space is recorded as
        // `space` with its id, which is what 206's manifest writer turns into
        // the session_space_credentials row containment reads (D8).
        launch: credentials.launch,
        commandNetwork,
        interactionProfile,
        workdir: { mode: workdir.mode, path: cwd },
        command: (effectiveClaudePlugins) => (baseCommand = buildAgentCommand(launch, this.env, {
          claudeSessionId: nativeSessionId,
          sandboxUnavailable: sandbox.unavailable,
          installedClaudePlugins: installedPlugins,
          equippedClaudePlugins: effectiveClaudePlugins,
        })),
        sandboxDegraded: sandbox.degradedReason,
        harness: this.managesClaudeHarness(launch) ? { installedPlugins } : null,
        contextIndex,
        baseUrl: this.baseUrl,
      });

      // Compose the agent's briefing IN-PROCESS and embed it in the command.
      //
      // In-process, NOT by having the PTY shell out to `tm8 worker init`: the
      // prompt must exist at the agent's FIRST TOKEN, before it could run any
      // CLI, so a boot that depends on the CLI being resolvable on PATH is a
      // failure mode designed out rather than handled. `tm8 worker init` remains
      // for an agent that wants to re-read its own briefing, and shares this
      // exact composer (`@tm8/prompt`) so the two can never drift.
      const envelope = composePrompt(manifest, {
        sessionId,
        baseUrl: this.baseUrl,
        ...(await this.promptV2Runtime(auth, manifest, sessionId, cwd)),
      });
      // The two halves stay SEPARATE all the way to the argv. `envelope.system`
      // configures the agent; `envelope.task` is its first user turn, and is
      // what actually makes it start. Concatenating them here is what left every
      // real agent idle at a REPL — see `withAgentPrompt`.
      //
      // The Codex marker: a Codex rollout records nothing of the child's env
      // and carries the system prompt as config, not a message — so the ONLY
      // durable link between this tm8 session and its rollout file is a marker
      // in the first user turn. That marker is what resume's capture scan
      // matches (native-session.ts). Claude needs none: its id is pre-minted.
      const task =
        launch.agentTool === 'codex'
          ? `${firstTurn(envelope, sessionId, request)}\n<tm8_session_id>${sessionId}</tm8_session_id>`
          : firstTurn(envelope, sessionId, request);
      // THE FIRST TURN RIDES IN ARGV wherever the binary accepts one, because a
      // prompt that is already in the process cannot be lost to a boot race. The
      // alternative — launch an idle REPL and type the task into the TUI once it
      // looks quiet — is what produced sessions that reported `running` with an
      // empty composer and an agent that never received its assignment. See
      // `withAgentPrompt`'s production note for the evidence.
      //
      // Only a launch this function cannot configure (echo-agent, an operator
      // `TM8_AGENT_CMD` wrapper) still needs the PTY to carry its first turn, and
      // `positionalTask` is the single source of truth for which case we are in —
      // so the task is delivered exactly once, never zero times and never twice.
      const positionalTask = supportsPositionalPrompt(launch, this.env);
      const command = withAgentPrompt(
        baseCommand,
        { system: envelope.system, task: positionalTask ? task : '' },
        launch,
        this.env,
      );

      const env = composeEnv(
        manifest,
        manifestPath,
        this.baseUrl,
        this.env,
        this.journalPathFor(sessionId),
        agentToken,
        credentialHome ?? undefined,
        gitHubCredential ?? undefined,
        credentials.launch.credentialSources.github,
      );
      Object.assign(env, harnessSurfaceEnv(launch));
      const envVarNames = Object.keys(env).sort();

      // Refuse BEFORE spawning if the agent CLI cannot be found, so the caller
      // is told what is actually wrong.
      //
      // Without this the launch "succeeds", the child exits 127 immediately, and
      // the boot-settlement watcher reports `agent process exited during the
      // 150ms boot settlement window` — true about the symptom, silent about the
      // cause, and indistinguishable from a crashing or unlicensed CLI. Measured
      // 2026-07-30 under the launchd service, whose PATH omits both agent
      // binaries. `composeEnv` has already added the standard install dirs, so
      // reaching this branch means the CLI genuinely is not installed anywhere
      // tm8 knows to look — which is a `not_found`, not a retryable 503.
      await this.assertAgentRuntime(baseCommand, launch, env);

      await this.writeManifestFile(manifestPath, manifest);
      // Names only. The manifest row is read by the UI and included in backups;
      // an ANTHROPIC_API_KEY value in there would outlive every rotation.
      //
      // The two prompts go down WITH the manifest, in the same write, because
      // this is the only moment they exist as data: a second later they are
      // argv on a child process and nothing can read them back. `task` is the
      // one actually handed to the PTY — including the Codex session marker —
      // so that a reader sees the real first user turn rather than the
      // pre-marker composer output.
      await this.graph.recordManifest(auth, sessionId, manifest, envVarNames, {
        system: envelope.system,
        task,
      }, launch.agentTool === 'claude-code'
        ? env.CLAUDE_CONFIG_DIR ?? join(env.HOME ?? homedir(), '.claude')
        : launch.agentTool === 'codex'
          ? env.CODEX_HOME ?? join(env.HOME ?? homedir(), '.codex')
          : null);

      if (!context.project) await this.ensurePrivateScratchDirectory(cwd);

      // Record the CLI's per-workspace trust BEFORE the child exists, because
      // afterwards is too late: the dialog blocks on first directory access, and
      // this launch is unattended — nobody is watching the PTY to answer it.
      // Must also come after the `mkdir` above, since these resolve `cwd`
      // through `realpath` and a scratch directory does not exist until then.
      // Trust belongs to the same credential/config home the child is about to
      // use. Passing the server environment here writes into the node account
      // even when `env` points Claude/Codex at a member-specific home, leaving
      // the child untrusted and reintroducing shared mutable provider state.
      if (launch.agentTool === 'claude-code') await trustClaudeWorkspace(cwd, env);
      if (launch.agentTool === 'codex') await trustCodexWorkspace(cwd, env);

      // Prompts accepted between here and the PTY being live must not be
      // dropped on the floor; the handoff parks them in the bounded FIFO and
      // spawnIfAbsent drains it.
      this.pty.beginPromptHandoff(sessionId);
      let firstPromptOutcome: Promise<PromptSettlementResult> | undefined;
      // `positionalTask` already put the assignment in the command line; queuing
      // it here as well would deliver the same first turn twice.
      if (this.promptSettlement && !positionalTask) {
        firstPromptDeliveryId = `spawn:${sessionId}:${randomUUID()}`;
        // Registration MUST precede queue admission: a same-tick settlement
        // must already have somewhere to land (PromptSettlementWaiter's law).
        firstPromptOutcome = this.promptSettlement.awaitOutcome(firstPromptDeliveryId);
        const admitted = await this.pty.deliverPrompt(
          sessionId,
          task,
          'send',
          firstPromptDeliveryId,
          true,
        );
        if (!admitted) {
          this.promptSettlement.cancel(firstPromptDeliveryId);
          throw new SpawnError(
            `initial task prompt was refused by the delivery queue for session ${sessionId}`,
            'conflict',
            { sessionId },
          );
        }
      }
      const { reused } = this.pty.spawnIfAbsent({
        sessionId,
        command,
        cwd,
        env,
        ...(request.cols ? { cols: request.cols } : {}),
        ...(request.rows ? { rows: request.rows } : {}),
      });

      // Arm the watcher before the first post-spawn await. A very short-lived
      // child can exit while the running transition is in flight; registering
      // after that await creates a gap where the PTY entry and its exit evidence
      // have already been removed before we begin watching.
      const bootSettlement = this.pty.waitForBootSettlement(sessionId, this.bootSettlementMs);
      await this.assertSpaceCredentialsStillActive(auth, sessionId, spaceCredentialIds);
      const [earlyExit, promptOutcome] = await Promise.all([
        bootSettlement,
        firstPromptDeliveryId && firstPromptOutcome
          ? this.waitForFirstPromptSettlement(firstPromptDeliveryId, firstPromptOutcome)
          : Promise.resolve<PromptSettlementResult>({ outcome: 'delivered' }),
      ]);
      if (earlyExit) {
        bootExit = earlyExit;
        throw new SpawnError(
          `agent process exited during the ${String(this.bootSettlementMs)}ms boot settlement window`,
          'internal',
          { sessionId, exitCode: earlyExit.exitCode, signal: earlyExit.signal },
        );
      }
      if (promptOutcome.outcome !== 'delivered') {
        throw new SpawnError(
          `initial task prompt did not settle as delivered for session ${sessionId}: ` +
            `${promptOutcome.reason ?? 'unknown outcome'}`,
          'internal',
          { sessionId, reason: promptOutcome.reason ?? 'unknown' },
        );
      }

      // `running` now means both process survival and first-turn submission.
      await this.graph.transition(auth, { sessionId, status: 'running' });

      this.logger?.info('SpawnService: session spawned', { sessionId, cwd, reused });
      this.notifySessionLive(sessionId, 'spawn');

      return { sessionId, manifestPath, manifest, command, cwd, envVarNames, reused, commandResult };
    } catch (error) {
      // The row exists and the graph believes a session is spawning. Leaving it
      // there would burn a slot against the concurrency cap forever, so mark it
      // failed before rethrowing — and do not let a cleanup failure mask the
      // original error, which is the one that explains what happened.
      await this.failSession(auth, sessionId, error, bootExit);
      if (firstPromptDeliveryId) this.promptSettlement?.cancel(firstPromptDeliveryId);
      // A failure after the child exists must not leave an unowned process. The
      // notifying kill also abandons a queued first prompt if spawn itself
      // threw before the PTY was installed, closing the handoff residue.
      this.pty.kill(sessionId);
      // §4.8: the lease is released, and the WORKTREE IS PRESERVED. A failed
      // spawn is evidence about a process, not about a checkout — and a
      // checkout may already hold work. Removing it here would be the delete
      // §6.3 forbids, arrived at through the back door.
      if (worktree) {
        await this.graph
          .releaseWorktreeLease(auth, worktree.worktreeId)
          .catch(() => undefined);
      }
      // The session is dead; its space key must not outlive it on disk.
      await this.scrubSpaceSecrets(sessionId);
      this.sessionAuth.delete(sessionId);
      throw error;
    }
  }

  /**
   * execution.terminal.start — a VANILLA TERMINAL (101).
   *
   * ===========================================================================
   * WHY THIS LIVES ON `SpawnService` WHEN IT SPAWNS NO AGENT
   * ===========================================================================
   *
   * Because of ONE field: `sessionAuth`. Read its docstring above — it is not a
   * cache, it is the only way anything can write a session's exit transition to
   * the graph. `work_session_transition` goes through `require_space_member`,
   * which needs an identity, and a PTY exiting three hours later has none. A
   * shell session registered anywhere else would exit into
   * `handlePtyExit`'s "no captured claims — expect a ghost session" branch: the
   * row stays `running` forever and the UI paints a dead shell as live.
   *
   * That is exactly the residual `credentials/` accepted (083's header states
   * it: an absent member's login row reads `running` forever, and read models
   * must therefore derive connection state from `credential_sessions` instead).
   * A login terminal can live with it because it has a TTL and its own ledger
   * to be honest from. A vanilla terminal has neither — its `status` IS the
   * answer to "is this shell alive" — so it goes through the single writer,
   * which means it goes through this map, which means it goes through this
   * class. Everything else this method needs it gets for free from the same
   * decision: `terminate`, `handlePtyActivity`, `handlePtyExit` and
   * `reconcileNodeGhosts` are all keyed by session id and ask no questions
   * about kind.
   *
   * ===========================================================================
   * WHAT IT DOES NOT DO, ENUMERATED AGAINST `spawn()` ABOVE
   * ===========================================================================
   *
   * No `loadSpawnContext` (no persona, no skills, no memory working set), no
   * `resolveLaunchConfig`, no `resolveInteractionProfile` and no pin, no
   * `issueWorkSessionAgentToken`, no `composeManifest`, no `writeManifestFile`,
   * no `recordManifest`, no `composePrompt`, no `assertAgentRuntime`, no
   * sandbox preflight, no worktree provisioning, and — the one with a visible
   * failure mode — NO `trustClaudeWorkspace`/`trustCodexWorkspace`. Those two
   * write into an agent CLI's config home to pre-answer a trust dialog that
   * only that CLI raises. Running them for a session with no agent would at
   * best write a trust record nothing reads, and at worst mark a directory
   * trusted on the member's behalf because they opened a shell in it.
   *
   * There is also no boot-settlement window. It exists so a spawn does not
   * report success for an agent CLI that exits 127 a moment later; a login
   * shell that dies instantly is a broken node, not a mistyped launch config,
   * and the honest report for it is the same exit transition every other death
   * takes rather than a synthesized launch error.
   */
  async startShell(auth: GraphAuth, request: ShellSessionRequest): Promise<ShellSessionResult> {
    const context = await this.graph.loadShellContext(auth, {
      spaceId: request.spaceId,
      projectId: request.projectId,
    });

    // Re-asserted here for the same reason `resolveWorkdir` re-asserts it: the
    // DB CHECK already enforces this shape, and a future direct-write path must
    // not be able to quietly hand a PTY a relative or traversing cwd.
    if (context.project) {
      const dir = context.project.workingDir;
      if (!dir.startsWith('/') || dir.includes('..')) {
        throw new SpawnError('project working directory is not a safe absolute path', 'internal', {
          projectId: context.project.id,
        });
      }
    }

    const { sessionId, commandResult, replayed } = await this.graph.createShellSession(auth, {
      ...request,
      nodeId: this.nodeId,
      // Recorded so the row says where the shell actually is. Null for a
      // projectless terminal rather than the `.../pending` placeholder
      // `execution_spawn` writes — see the migration for why.
      workdirPath: context.project ? context.project.workingDir : null,
    });

    // A projectless terminal's directory is named for the session, which only
    // exists now — the same re-resolution `spawn()` does, and for the same
    // reason: the row must record the path the PTY will actually use.
    const cwd = context.project
      ? context.project.workingDir
      : join(this.dataDir, 'scratch', sessionId);

    const launcher = new ShellSessionLauncher({
      pty: this.pty,
      baseUrl: this.baseUrl,
      env: this.env,
      ...(this.logger ? { logger: this.logger } : {}),
    });

    // A ledger replay is a transport retry of the original result, not
    // permission to start a second shell under the same id. Unlike `spawn()`'s
    // replay branch — which has to recompose a manifest to answer with — there
    // is nothing to rebuild here, so the answer is the recorded result and the
    // reattach state of whatever PTY is (or is not) already live.
    if (replayed) {
      const shell = resolveLoginShell(this.env);
      return {
        sessionId,
        shell,
        command: loginShellCommand(shell),
        cwd,
        envVarNames: [],
        reused: launcher.hasLiveTerminal(sessionId),
        commandResult,
      };
    }

    this.sessionAuth.set(sessionId, auth);
    // The OOM baseline, captured with the claims because it is the same kind
    // of launch-time bookkeeping and must exist before the PTY can die (171).
    this.oomKillAtSpawn.set(sessionId, await readOomKillCount());
    let launchedPty = false;
    try {
      if (!context.project) await this.ensurePrivateScratchDirectory(cwd);

      const launched = launcher.launch({
        sessionId,
        cwd,
        ...(request.cols ? { cols: request.cols } : {}),
        ...(request.rows ? { rows: request.rows } : {}),
      });

      launchedPty = true;

      await this.graph.transition(auth, { sessionId, status: 'running' });

      // The lane fact (107) for a project terminal: the SHARED checkout's
      // current branch. A scratch terminal has no repo — nothing to probe,
      // and NULL already says so. Best-effort like every lane-fact write.
      if (context.project) {
        await this.captureCheckoutBranch(auth, sessionId, await detectCheckoutBranch(cwd));
      }

      return {
        sessionId,
        shell: launched.shell,
        command: launched.command,
        cwd,
        envVarNames: Object.keys(launched.env).sort(),
        reused: launched.reused,
        commandResult,
      };
    } catch (error) {
      // KILL THE PTY IF IT IS ALREADY UP, and this is not the same call `spawn`
      // makes. If the launch succeeded and the `running` transition then threw,
      // the row is about to be marked `failed` and the claims dropped — but the
      // shell would stay alive with nothing claiming it. It cannot be reaped:
      // `reconcileNodeGhosts` skips any session that still has a live PTY, so a
      // boot-time sweep passes over it too. `spawn()` has the identical hole
      // and it matters less there, because an agent process eventually exits on
      // its own; A LOGIN SHELL RUNS FOREVER BY DESIGN. An orphaned interactive
      // shell as the tm8 OS user, unreachable and unreapable short of
      // restarting the node, is the one outcome this path must not produce.
      if (launchedPty) this.pty.kill(sessionId);
      // The row exists and the graph believes a session is spawning. Leaving it
      // there would burn a slot against the terminal cap forever.
      await this.failSession(auth, sessionId, error);
      this.sessionAuth.delete(sessionId);
      throw error;
    }
  }

  /**
   * execution.resume — bring THIS session back, conversation and all.
   *
   * Maestro-style same-session resume: the work_session row is resurrected
   * (`exited`/`failed` → `spawning` via `public.execution_resume`, the one
   * legal exception to the terminal-sink law) and the agent is relaunched with
   * the provider's OWN resume flag against the stored native session id —
   * `claude --resume <uuid>` / `codex resume <id>`. The provider restores the
   * conversation history; tm8 re-applies only the static layer (system prompt,
   * model, permission posture, cwd), and deliberately does NOT re-send the
   * task turn — it is already the first message of the restored conversation.
   *
   * Ordering mirrors `spawn()` and is just as deliberate:
   *   1. read the stored session facts + refuse everything non-resumable
   *   2. resolve the native id — Codex's rollout scan runs HERE, before any
   *      state changes, so a missing rollout refuses cleanly (fail-closed;
   *      never `--last`, never a silent fresh start)
   *   3. `execution_resume` — the status resurrection, cap check, ledger row
   *   4. recompose manifest/env, write the file
   *   5. spawn the PTY (no live PTY exists — step 1 refused if one did)
   *   6. transition to `running`
   */
  async resume(auth: GraphAuth, request: ResumeRequest): Promise<SpawnResult> {
    const info = await this.graph.loadWorkSessionForResume(auth, request.sessionId);
    const sessionId = info.sessionId;
    let bootExit: PtyExitInfo | undefined;
    // Cleanup owns only a child THIS invocation created. `spawnIfAbsent` can
    // legitimately discover a live PTY after the optimistic guard above (a
    // concurrent reattach/race) and answer `reused: true`; a later graph error
    // must not turn that unrelated failure into destruction of the healthy
    // process we merely found.
    let launchedPty = false;
    let spaceCredentialIds: string[] = [];

    if (this.pty.hasSession(sessionId)) {
      throw new SpawnError(
        `work session ${sessionId} already has a live terminal — nothing to resume`,
        'conflict',
        { sessionId },
      );
    }
    if (info.status !== 'exited' && info.status !== 'failed') {
      throw new SpawnError(
        `work session ${sessionId} is '${info.status}' — only exited or failed sessions can be resumed`,
        'conflict',
        { sessionId, status: info.status },
      );
    }
    if (!info.teamMemberId) {
      throw new SpawnError(
        `work session ${sessionId} has no linked Teammate — cannot reconstruct its launch`,
        'invalid_input',
        { sessionId },
      );
    }

    // The posture is the one launch fact `work_sessions` does NOT carry (the
    // row has model/mode/agent_tool and no permission column), so re-resolving
    // from the row alone silently demoted every resumed session to the persona
    // default — a session launched `fullAccess` came back on `auto` and stalled
    // on its first approval. The recorded manifest is where that fact is
    // durable, and resume does not rewrite it, so it still describes the launch.
    // Read BEFORE the context: the launch's selection lives there too, and
    // whether it rendered `<context_index>` (so the loader reads its headers).
    const recorded = await this.recordedPosture(auth, sessionId);
    const recordedPosture = recorded.posture;
    // The launch's exact sets, replayed (design 01a0d348 §5.1). Without this a
    // resumed session came back on the edge defaults while its rewritten
    // manifest claimed it had never selected anything.
    const launchSelection = replayedSelection(recordedPosture);
    const resumeIndex = contextIndexForResume(this.env, recordedPosture?.contextIndex ?? null);

    const context = await this.graph.loadSpawnContext(auth, {
      spaceId: info.spaceId,
      teamMemberId: info.teamMemberId,
      projectId: info.projectId,
      taskIds: info.taskIds,
      // The stored parent, resolved the same way spawn resolves it. A resumed
      // worker must be told the same thing about its return address as it was
      // told at launch — and the kind is re-READ rather than taken from the
      // recorded manifest, because a chat that has since been deleted should
      // stop being described as one.
      parentSessionId: info.parentSessionId,
      ...(launchSelection.selection ? { selection: launchSelection.selection, selectionReplay: true } : {}),
    });

    if (resumeIndex) await this.loadIndexHeaders(auth, context);

    // The stored row IS the request: same precedence chain as spawn, fed the
    // facts the session was actually launched with, so the two paths resolve
    // identically and cannot drift.
    const syntheticRequest: SpawnRequest = {
      spaceId: info.spaceId,
      teamMemberId: info.teamMemberId,
      parentSessionId: info.parentSessionId,
      projectId: info.projectId,
      taskIds: info.taskIds,
      mode: info.mode,
      model: info.model,
      agentTool: info.agentTool,
      title: info.title || null,
      clientMutationId: request.clientMutationId ?? null,
      ...(launchSelection.selection ? { selection: launchSelection.selection } : {}),
      ...(launchSelection.selectionReasons ? { selectionReasons: launchSelection.selectionReasons } : {}),
      ...(launchSelection.invalid ? { selectionReplayInvalid: true } : {}),
    };
    // NOT routed. A resume continues a conversation the agent already has, and
    // switching models underneath it would hand a transcript written by one
    // model to another — the native session id in `--resume` belongs to the
    // model that created it. Resume replays the recorded posture, full stop.
    const launch = resolveLaunchConfig(syntheticRequest, context, this.env, recordedPosture);
    const commandNetwork = resolveCommandNetworkPolicy(launch, this.env);

    if (launch.agentTool !== 'claude-code' && launch.agentTool !== 'codex') {
      throw new SpawnError(
        `agent tool '${launch.agentTool}' has no resume-by-id contract`,
        'invalid_input',
        { sessionId, agentTool: launch.agentTool },
      );
    }
    if (this.env.TM8_AGENT_CMD?.trim()) {
      throw new SpawnError(
        'resume is not supported under a TM8_AGENT_CMD operator wrapper — tm8 cannot know its resume flags',
        'not_implemented',
        { sessionId },
      );
    }

    // WORKTREE FIRST, and it is the whole point of this block.
    //
    // Resume used to compute this as `context.project.workingDir` outright,
    // which sent every resumed WORKTREE session back into the SHARED checkout
    // while the manifest below still emitted `mode: 'worktree'`. Nothing showed
    // it: the branch probe reads `info.workdirPath`, so `checkoutBranch` stayed
    // right while the cwd was wrong, and the session committed to whatever
    // branch the shared checkout happened to be parked on. §7.4's first
    // prohibition — a session told it is isolated and running in the shared
    // checkout — arrived through resume rather than through spawn.
    //
    // The row is the authority here, NOT `resolveWorkdir`: re-resolving would
    // re-run the request-time DECISION (persona defaults, a policy that has
    // since changed) and could legitimately answer a different mode than the
    // one this conversation's files actually live in. A resume restores a
    // place; it does not choose one.
    //
    // Project cwd is still re-read from the graph (it may legitimately have
    // moved); a scratch cwd is named for the SESSION id, which resume shares —
    // so the conversation's own files are still there.
    const worktreeCwd = info.workdirMode === 'worktree' ? info.workdirPath : null;
    if (info.workdirMode === 'worktree' && worktreeCwd === null) {
      throw new SpawnError(
        `work session ${sessionId} is recorded as an isolated worktree but its row carries no ` +
          `workdir path — refusing to resume it into the shared checkout`,
        'conflict',
        { sessionId, workdirMode: info.workdirMode },
      );
    }
    // A reclaimed checkout REFUSES, and refuses BEFORE `resumeWorkSession`
    // touches the row. Falling through to the project directory is precisely
    // the defect above; making that fallback unreachable is what keeps it from
    // coming back.
    if (worktreeCwd !== null && !(await isDirectory(worktreeCwd))) {
      throw new SpawnError(
        `the worktree for session ${sessionId} is gone — '${worktreeCwd}' is no longer a ` +
          `directory. Refusing to resume: an isolated session must not silently reland in the ` +
          `shared checkout.`,
        'not_found',
        { sessionId, workdirPath: worktreeCwd },
      );
    }
    const cwd =
      worktreeCwd ??
      (context.project ? context.project.workingDir : join(this.dataDir, 'scratch', sessionId));

    // Resolve the native id BEFORE any state change (fail-closed, maestro's
    // codex_resume_id_unavailable pattern). Claude ids are pre-minted at spawn,
    // so a missing one means the session predates resume support — refuse
    // honestly rather than silently launching a fresh conversation. Codex ids
    // are captured lazily from the rollout here, then recorded write-once so
    // the scan never runs twice.
    let nativeSessionId = info.nativeSessionId;
    if (!nativeSessionId && launch.agentTool === 'codex') {
      const configDirs = [...new Set([
        ...(info.agentConfigDir ? [info.agentConfigDir] : []),
        ...await knownAgentConfigDirs({
          agentTool: launch.agentTool,
          dataDir: this.dataDir,
          home: this.env.HOME ?? homedir(),
        }),
      ])];
      for (const configDir of configDirs) {
        nativeSessionId = await resolveCodexNativeSessionId({
          home: this.env.HOME ?? homedir(),
          configDir,
          tm8SessionId: sessionId,
          cwd,
        });
        if (nativeSessionId) break;
      }
      if (nativeSessionId) {
        // Write-once refusing this id means the row already names a DIFFERENT
        // conversation — two rollouts claiming one session. Resuming on the id
        // we just scanned would attach to a conversation the graph does not
        // agree is ours, so refuse instead of guessing which one is right.
        const stored = await this.graph.recordNativeSessionId(auth, sessionId, nativeSessionId);
        if (!stored) {
          throw new SpawnError(
            `work session ${sessionId} already has a different native session id recorded — ` +
              `the Codex rollout scan found '${nativeSessionId}', which contradicts it. ` +
              `Refusing to resume against an ambiguous conversation.`,
            'conflict',
            { sessionId, agentTool: launch.agentTool },
          );
        }
      }
    }
    if (!nativeSessionId) {
      throw new SpawnError(
        launch.agentTool === 'codex'
          ? `no Codex rollout under ~/.codex/sessions could be proven to belong to session ${sessionId} — refusing to resume a different or fresh conversation`
          : `work session ${sessionId} has no recorded native session id (spawned before resume support) — it cannot be resumed`,
        'conflict',
        { sessionId, agentTool: launch.agentTool },
      );
    }

    const { commandResult, replayed } = await this.graph.resumeWorkSession(auth, {
      sessionId,
      clientMutationId: request.clientMutationId ?? null,
      // THIS node is about to own the PTY, so it must own the row — a session
      // first spawned elsewhere migrates here on resume.
      nodeId: this.nodeId,
    });
    // A successful resurrection supersedes any process-local cleanup retry left
    // from the prior run. Without this, a late retry could fail the new run.
    this.cancelFailedTransitionRetry(sessionId);

    const manifestPath = this.manifestPathFor(sessionId);
    // A ledger replay is a transport retry of the original resume result — not
    // permission to boot a second child. Mirrors spawn()'s replay branch.
    if (replayed) {
      const command = buildAgentCommand(launch, this.env);
      const manifest = composeManifest({
        sessionId,
        request: syntheticRequest,
        context,
        launch,
        commandNetwork,
        workdir: { mode: info.workdirMode, path: cwd },
        command,
        baseUrl: this.baseUrl,
      });
      return {
        sessionId,
        manifestPath,
        manifest,
        command,
        cwd,
        envVarNames: [],
        reused: true,
        commandResult,
      };
    }

    this.sessionAuth.set(sessionId, auth);
    // The OOM baseline, captured with the claims because it is the same kind
    // of launch-time bookkeeping and must exist before the PTY can die (171).
    this.oomKillAtSpawn.set(sessionId, await readOomKillCount());

    try {
      // §3.4 — one write-capable live session per worktree, re-asserted for the
      // NEW run. Resume never did this: the previous run's lease was either
      // still hanging off a dead session (see `handlePtyExit`) or had been
      // swept by reconciliation, and in the swept case a resumed session went
      // back into a checkout it held no claim on, where a fresh spawn was free
      // to take it out from under it.
      //
      // Re-acquiring a lease this session ALREADY holds is a success, not a
      // conflict: `acquire_worktree_lease` refuses only when the holder is
      // some OTHER session (081:282-284). A resume that refused because the
      // session still owned its own worktree would be a new bug.
      if (worktreeCwd !== null) {
        const allocation = await this.findWorktreeAllocation(
          auth,
          (row) => row.path === worktreeCwd,
        );
        if (allocation) {
          await this.graph.acquireWorktreeLease(auth, allocation.worktreeId, sessionId);
        } else {
          // Not fatal. The cwd fix above already put this session in the right
          // place, and the directory is provably there; an allocation this node
          // cannot see is a bookkeeping gap, not a reason to strand a
          // conversation. It IS worth saying out loud, because until it is
          // fixed nothing enforces exclusivity on that checkout.
          this.logger?.warn?.(
            'SpawnService: resumed worktree session has no allocation on this node — ' +
              'its checkout is unleased and nothing prevents a second session taking it',
            { sessionId, workdirPath: worktreeCwd, nodeId: this.nodeId },
          );
        }
      }

      // Re-pin the interaction profile for the new run; non-fatal on failure —
      // a resume that degrades to the core-default profile frame is strictly
      // better than one that refuses, because the restored conversation already
      // carries the agent's working context.
      let interactionProfile: InteractionProfilePinContext | undefined;
      try {
        const resolvedProfile = await this.graph.resolveInteractionProfile(auth, {
          spaceId: info.spaceId,
          teamMemberId: info.teamMemberId,
          interactionProfileId: null,
        });
        interactionProfile = await this.graph.recordInteractionProfilePin(
          auth,
          sessionId,
          resolvedProfile,
        );
      } catch (error) {
        this.logger?.warn?.('SpawnService: resume could not re-pin the interaction profile', {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      if (!info.teamMemberId) {
        throw new SpawnError(
          `work session ${sessionId} has no related team member and cannot receive a session-bound credential`,
          'conflict',
          { sessionId },
        );
      }

      // Refresh the lane fact (107): a shared checkout may have changed
      // branches since the last run, and a lane branch may have been renamed.
      // Scratch has no repo by construction and keeps NULL.
      //
      // This probes `cwd` for BOTH repo modes now, and that is deliberate. It
      // used to read `info.workdirPath` for worktree mode and `cwd` for
      // project mode — a divergence that was invisibly load-bearing: it kept
      // the displayed branch correct while the cwd above was wrong, which is
      // exactly why the defect had no surface. One expression, one answer: the
      // branch reported is now the branch of the directory the PTY gets.
      const branchProbePath = info.workdirMode === 'scratch' ? null : cwd;
      if (branchProbePath !== null) {
        await this.captureCheckoutBranch(
          auth,
          sessionId,
          await detectCheckoutBranch(branchProbePath),
        );
      }
      const agentToken = await this.graph.issueWorkSessionAgentToken(
        auth,
        sessionId,
        info.teamMemberId,
      );

      // NO --session-id on a resume invocation: the id is already Claude's, and
      // naming it twice (`--session-id` + `--resume`) is two flags to disagree.
      //
      // Resume gets the SAME sandbox preflight as a fresh spawn, because it
      // boots a real child on this node: a session that was sandboxed where it
      // first ran is not sandboxed by having been sandboxed before, and resume
      // is exactly the path that moves a session onto a different node.
      const sandbox = await this.resolveSandboxPosture(launch);
      // Re-resolved under the RESUMER's claims: membership, policy (A5) and
      // credential status are today's, the space key is re-read and re-seeded
      // from the current sealed value (D7), and a pinned or recorded id that
      // is no longer usable refuses rather than falling back (M8d).
      const credentials = await this.resolveSessionCredentials(
        auth,
        info.spaceId,
        sessionId,
        launch,
        true,
      );
      spaceCredentialIds = credentials.spaceCredentialIds;
      const { credentialHome, gitHubCredential } = credentials;
      await this.repointSpaceCredentials(auth, sessionId, credentials, recorded.unreadable);
      // Same harness surface as the fresh spawn: `withAgentResume` builds on
      // this base command, so the minimal-surface flags survive `--resume`.
      // Read once: the same lists build the argv and the manifest's record of
      // it, so the two cannot disagree about a plugin.
      const installedPlugins = this.installedClaudePluginsFor(launch, credentialHome?.configDir);
      let baseCommand = '';
      const manifest = composeManifest({
        agentConfigDir: credentialHome?.configDir ?? (launch.agentTool === 'codex' ? this.env.CODEX_HOME : this.env.CLAUDE_CONFIG_DIR),
        homeDir: this.env.HOME ?? homedir(),
        sessionId,
        request: syntheticRequest,
        context,
        launch: credentials.launch,
        commandNetwork,
        ...(interactionProfile ? { interactionProfile } : {}),
        workdir: { mode: info.workdirMode, path: cwd },
        command: (effectiveClaudePlugins) => (baseCommand = buildAgentCommand(launch, this.env, {
          sandboxUnavailable: sandbox.unavailable,
          installedClaudePlugins: installedPlugins,
          equippedClaudePlugins: effectiveClaudePlugins,
        })),
        sandboxDegraded: sandbox.degradedReason,
        harness: this.managesClaudeHarness(launch) ? { installedPlugins } : null,
        contextIndex: resumeIndex,
        replayEffectivePlugins: recorded.posture?.effectivePlugins ?? null,
        baseUrl: this.baseUrl,
      });
      const envelope = composePrompt(manifest, { sessionId, baseUrl: this.baseUrl });
      const command = withAgentResume(
        baseCommand,
        envelope.system,
        launch,
        nativeSessionId,
        this.env,
      );

      // Resolved on resume too, not just spawn: a member who connects their
      // identity between a session's spawn and its resume should get their own
      // credential on the way back up, and one that has been disconnected must
      // stop being injected. A resume that kept the launch-time answer would be
      // the one path where Ruling 3's "disconnect terminates" could be undone.
      const env = composeEnv(
        manifest,
        manifestPath,
        this.baseUrl,
        this.env,
        this.journalPathFor(sessionId),
        agentToken,
        credentialHome ?? undefined,
        gitHubCredential ?? undefined,
        credentials.launch.credentialSources.github,
      );
      Object.assign(env, harnessSurfaceEnv(launch));
      const envVarNames = Object.keys(env).sort();

      await this.assertAgentRuntime(baseCommand, launch, env);

      // The manifest FILE is rewritten (the agent re-reads it at boot); the
      // manifest ROW is not re-recorded — record_session_manifest documented
      // the original launch, and this resume's exact command is in the ledger.
      await this.writeManifestFile(manifestPath, manifest);

      if (!context.project) await this.ensurePrivateScratchDirectory(cwd);
      // Resume must seed the exact same member-scoped home as a fresh spawn.
      if (launch.agentTool === 'claude-code') await trustClaudeWorkspace(cwd, env);
      if (launch.agentTool === 'codex') await trustCodexWorkspace(cwd, env);

      this.pty.beginPromptHandoff(sessionId);
      const { reused } = this.pty.spawnIfAbsent({
        sessionId,
        command,
        cwd,
        env,
        ...(request.cols ? { cols: request.cols } : {}),
        ...(request.rows ? { rows: request.rows } : {}),
      });
      launchedPty = !reused;

      const bootSettlement = this.pty.waitForBootSettlement(sessionId, this.bootSettlementMs);
      await this.assertSpaceCredentialsStillActive(auth, sessionId, spaceCredentialIds);
      await this.graph.transition(auth, { sessionId, status: 'running' });

      const earlyExit = await bootSettlement;
      if (earlyExit) {
        bootExit = earlyExit;
        throw new SpawnError(
          `agent process exited during the ${String(this.bootSettlementMs)}ms boot settlement window`,
          'internal',
          { sessionId, exitCode: earlyExit.exitCode, signal: earlyExit.signal },
        );
      }

      this.logger?.info('SpawnService: session resumed', { sessionId, cwd, reused });
      this.notifySessionLive(sessionId, 'resume');
      return { sessionId, manifestPath, manifest, command, cwd, envVarNames, reused, commandResult };
    } catch (error) {
      await this.failSession(auth, sessionId, error, bootExit);
      if (launchedPty) this.pty.kill(sessionId);
      // A PTY this resume merely FOUND is healthy and still reads its key.
      if (!this.pty.hasSession(sessionId)) await this.scrubSpaceSecrets(sessionId);
      this.sessionAuth.delete(sessionId);
      throw error;
    }
  }

  private async waitForFirstPromptSettlement(
    deliveryId: string,
    outcome: Promise<PromptSettlementResult>,
  ): Promise<PromptSettlementResult> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        outcome,
        new Promise<PromptSettlementResult>((resolve) => {
          timer = setTimeout(() => {
            this.promptSettlement?.cancel(deliveryId);
            resolve({ outcome: 'unknown', reason: 'first_prompt_settlement_timeout' });
          }, this.firstPromptSettlementMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async writeManifestFile(path: string, manifest: Tm8Manifest): Promise<void> {
    await this.ensurePrivateDataLayout();
    await ensurePrivateDirectory(dirname(path));
    // Write-then-rename: the agent boots concurrently and must never observe a
    // half-written manifest. A truncated JSON parse at boot is indistinguishable
    // from a malformed manifest, and the agent has no way to retry.
    //
    // The fixed temp name is removed first. `writeFile({ mode })` does not
    // change an existing file's mode and follows symlinks; either behaviour
    // would let a stale pre-fix `.tmp` preserve 0644 or redirect the write.
    const tmp = `${path}.tmp`;
    await rm(tmp, { force: true });
    await writeFile(tmp, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: 'utf8',
      mode: PRIVATE_FILE_MODE,
      flag: 'wx',
    });
    // Assert the postcondition explicitly rather than trusting the process
    // umask or creation semantics. The rename then publishes a 0600 inode.
    await chmod(tmp, PRIVATE_FILE_MODE);
    await rename(tmp, path);
    await chmod(path, PRIVATE_FILE_MODE);
  }

  private async failSession(
    auth: GraphAuth,
    sessionId: string,
    error: unknown,
    exitInfo?: PtyExitInfo,
  ): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    const transition: TransitionInput = {
      sessionId,
      status: 'failed',
      ...(exitInfo ? { exitCode: exitInfo.exitCode } : {}),
      // A NAMED unknown, never blank: an Error with an empty message would
      // otherwise write error = '' — a value that PASSES a `NOT NULL`-style
      // honesty check while saying nothing, which is the exact failure this
      // whole fix exists to close.
      error: exitInfo
        ? describePtyExit(exitInfo)
        : message.trim() !== ''
          ? message
          : 'spawn failed for an unspecified reason',
    };
    if (await this.persistFailedTransition(auth, transition, message)) return;
    this.scheduleFailedTransitionRetry(auth, transition, message, 1);
  }

  private async persistFailedTransition(
    auth: GraphAuth,
    transition: TransitionInput,
    originalError: string,
  ): Promise<boolean> {
    try {
      await this.graph.transition(auth, transition);
      this.cancelFailedTransitionRetry(transition.sessionId);
      return true;
    } catch (cleanupError) {
      // CONFLICT, not a fresh failure: sqlstate 23514 here means the row is
      // ALREADY terminal — almost always because the PTY died fast enough
      // that `handlePtyExit` (this class's OTHER writer) already recorded the
      // real exit evidence (see describePtyExit) before this optimistic
      // 'running'->'failed' write got its turn. MEASURED 2026-07-28: without
      // this guard, that race lands the confusing `illegal work_session
      // transition failed -> running` text in `error` — the SQL exception's
      // own message, not the agent's actual death reason — silently
      // OVERWRITING the good evidence the exit path had just written moments
      // earlier (`coalesce(p_error, error)` only protects a NULL write; this
      // one is non-null). Detected by sqlstate rather than by re-reading the
      // row, so no extra query sits on this hot error path.
      const sqlState = (cleanupError as { code?: string } | null)?.code;
      if (sqlState === '23514') {
        this.cancelFailedTransitionRetry(transition.sessionId);
        this.logger?.info(
          'SpawnService: skipped a redundant failed-transition write — the row is already terminal, ' +
            'almost certainly from the real PTY-exit path recording it first',
          { sessionId: transition.sessionId, originalError },
        );
        return true;
      }
      this.logger?.error(
        'SpawnService: failed to mark session failed after spawn error',
        cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError)),
        { sessionId: transition.sessionId },
      );
      return false;
    }
  }

  private scheduleFailedTransitionRetry(
    auth: GraphAuth,
    transition: TransitionInput,
    originalError: string,
    attempt: number,
  ): void {
    if (this.failedTransitionRetries.has(transition.sessionId)) return;
    const delayMs = Math.min(
      this.failedTransitionRetryMs * 2 ** Math.min(attempt - 1, 5),
      30_000,
    );
    const timer = setTimeout(() => {
      this.failedTransitionRetries.delete(transition.sessionId);
      void this.persistFailedTransition(auth, transition, originalError).then((settled) => {
        if (!settled) {
          this.scheduleFailedTransitionRetry(auth, transition, originalError, attempt + 1);
        }
      });
    }, delayMs);
    // A cleanup retry must never keep a server process alive by itself. If the
    // process exits first, startup ghost reconciliation owns the same row.
    timer.unref?.();
    this.failedTransitionRetries.set(transition.sessionId, timer);
    this.logger?.warn?.('SpawnService: scheduled failed-session transition retry', {
      sessionId: transition.sessionId,
      attempt,
      delayMs,
    });
  }

  private cancelFailedTransitionRetry(sessionId: string): void {
    const timer = this.failedTransitionRetries.get(sessionId);
    if (!timer) return;
    clearTimeout(timer);
    this.failedTransitionRetries.delete(sessionId);
  }

  /**
   * execution.prompt (R17) — THE seam that fails silently.
   *
   * The failure this ordering exists to prevent: record the ledger row first,
   * then discover there is no live PTY. The command_ledger then says the prompt
   * was delivered, `record_execution_command` returns a perfectly ordinary
   * CommandResult, the UI shows the message as sent — and the bytes went
   * nowhere. Nothing anywhere is red. So liveness is checked BEFORE the ledger
   * is touched, and a delivery the queue rejects throws rather than returning.
   *
   * `deliverPrompt` returning false is a bound rejection (oversized prompt, full
   * FIFO), not a transport error — but from the caller's side it means the same
   * thing: this prompt will never reach the agent. It must not be reported as
   * accepted.
   */
  async prompt(
    auth: GraphAuth,
    sessionId: string,
    message: string,
    opts: { clientMutationId?: string | null; mode?: 'send' | 'paste' } = {},
  ): Promise<{ delivered: true; commandResult: unknown }> {
    if (!message || message.length === 0) {
      throw new SpawnError('prompt message must not be empty', 'invalid_input');
    }
    if (!this.pty.hasSession(sessionId)) {
      throw new SpawnError(
        `work session ${sessionId} has no live terminal to prompt`,
        'conflict',
        { sessionId },
      );
    }

    const commandResult = await this.graph.recordCommand(auth, {
      sessionId,
      operation: 'execution.prompt',
      payload: { bytes: Buffer.byteLength(message, 'utf8') },
      clientMutationId: opts.clientMutationId ?? null,
    });

    const delivered = await this.pty.deliverPrompt(sessionId, message, opts.mode ?? 'send');
    if (!delivered) {
      throw new SpawnError(
        `prompt was refused by the delivery queue for session ${sessionId}`,
        'conflict',
        { sessionId },
      );
    }

    return { delivered: true, commandResult };
  }

  /**
   * execution.terminate — the cancellation path (AM-2 §4); there is no separate
   * cancel operation.
   *
   * `kill(notify=true)` finalizes the PTY entry synchronously, which means
   * onExit will NOT fire for it and the exit sink will not run. So the
   * transition is written here explicitly rather than left to the exit path.
   */
  async terminate(
    auth: GraphAuth,
    sessionId: string,
    opts: {
      force?: boolean;
      clientMutationId?: string | null;
      /**
       * Overrides the default `error` text. For a caller that knows WHY it is
       * terminating this session for a reason other than "an operator asked"
       * (ghost reconciliation, for one) — so the row says that, not a generic
       * "terminated by request" that would misattribute an automatic cleanup
       * to a human action that never happened.
       */
      reason?: string;
      /**
       * The terminal status to record. Defaults to 'exited' — an operator
       * cancelling a session is an ordinary end, not a failure.
       *
       * `'failed'` exists for the one caller that knows the session did NOT
       * end on its own terms: ghost reconciliation. A row retired at startup
       * belonged to an agent killed alongside its host, and recording that as
       * 'exited' makes it byte-identical, in every read model, to an agent
       * that finished its work — `exit_code` is NULL either way, and the
       * contract's `work_session` state projects neither `exit_code` nor
       * `error`, so `status` is the ONLY field a client can discriminate on.
       * Measured 2026-08-22: a deploy SIGKILLed the server with four live
       * agents; all four were retired here as 'exited', and the incident was
       * invisible in the graph until someone read `exited_at` by hand and
       * noticed four unrelated sessions sharing a timestamp to the millisecond.
       */
      terminalStatus?: 'exited' | 'failed';
      /**
       * The ending facts (171), for a caller that knows more than "an operator
       * asked". Default to a cancellation, which is what a bare terminate is.
       *
       * `endedReason` is read by a PERSON, and by a person who is not a
       * developer. One sentence, plain English, no signal names and no exit
       * codes — those belong in `reason`/`error`, which stay technical.
       */
      endedKind?: WorkSessionEndedKind;
      endedReason?: string;
    } = {},
  ): Promise<{ outcome: string; commandResult: unknown }> {
    const commandResult = await this.graph.recordCommand(auth, {
      sessionId,
      operation: 'execution.terminate',
      payload: { force: opts.force ?? false },
      clientMutationId: opts.clientMutationId ?? null,
    });

    // Phase 1b — a genuine kill FAILURE must not be reported as a successful
    // exit. Ported from old maestro's own discrimination
    // (sessionRoutes.ts:576-580: `if (killOutcome === 'error') return
    // res.status(500)` BEFORE any state write) — tm8 carried the PtyKillOutcome
    // type itself but had DROPPED the short-circuit this specific value exists
    // to drive, in tm8's own glue code with no maestro counterpart. Before this
    // guard: `entry.proc.kill()` throwing something other than ESRCH (EPERM, a
    // genuine signal-delivery refusal) still fell through to the unconditional
    // `status: 'exited'` write below — the database said the session was gone
    // while the OS process might still be running, with nothing louder than a
    // `logger.info` nobody greps. `kill()` still finalizes its OWN bookkeeping
    // unconditionally (the tracked entry is gone either way — see its own
    // doc comment), so this session cannot be reconciled through the normal
    // PTY-exit path anymore regardless; the one thing still within our control
    // is not ALSO lying about it in the graph. Leaving the row at its prior,
    // non-terminal status here is more honest than a false 'exited': Phase 1's
    // `reconcileNodeGhosts` will retire it with an accurate reason at the next
    // restart if it is never resolved another way.
    //
    // 'not_found' is not an error: terminating an already-dead session is the
    // user cancelling something that just finished. The graph still needs to
    // reflect the terminal state, and the RPC tolerates same→same.
    const status = opts.terminalStatus ?? 'exited';
    const { outcome } = await this.killThenRecordEnding(auth, sessionId, {
      onNotFound: 'record',
      status,
      error: (killed) =>
        opts.reason ??
        (killed === 'not_found'
          ? 'terminate requested, but no live PTY was found (already exited)'
          : opts.force
            ? 'terminated by request (force) — exit code not observed, kill does not wait for the real exit event'
            : 'terminated by request — exit code not observed, kill does not wait for the real exit event'),
      // The default reads as a cancellation because that is what an
      // unqualified terminate IS; a caller who knows better (ghost
      // reconciliation, the shutdown sweep) passes its own.
      endedKind: opts.endedKind ?? 'stopped_by_operator',
      endedReason: opts.endedReason ?? 'Stopped by request.',
    });
    if (outcome === 'error') {
      throw new SpawnError(
        `failed to terminate work session ${sessionId}: the kill signal itself failed`,
        'internal',
        { sessionId, outcome },
      );
    }

    this.logger?.info('SpawnService: session terminated', { sessionId, outcome, status });
    return { outcome, commandResult };
  }

  /**
   * CREDENTIAL CONTAINMENT — kill a session because the credential it runs on
   * was taken away, and record that it ended.
   *
   * The three containment callers (a space-credential delete, the member
   * Disconnect, SC-6's member removal) used to call `PtyHostService.kill`
   * directly. `kill()` finalizes the PTY entry synchronously, so the late
   * node-pty `onExit` for that process returns at its identity check and
   * `handlePtyExit` never runs: nothing wrote the row, and it read `running`
   * forever — counted against the concurrency cap, and refusing a resume as
   * "is 'running'" rather than for the revoked credential.
   *
   * This goes through `killThenRecordEnding`, the same kill-then-transition
   * `terminate` uses, so there is one ending writer for a stop, not two:
   *
   *   - KILL BEFORE STAMP. The row is written only after `kill()` reports
   *     `killed`. A kill `error` leaves the row at its prior status and is
   *     returned for the caller to surface; `not_found` (no PTY here) writes
   *     nothing, because nothing was confirmed dead — on a single node the boot
   *     reconciliation retires such a row, and on another node its own host
   *     still owns it.
   *   - EXACTLY ONE TRANSITION. `kill()` removes the entry before this writes,
   *     so the late `onExit` returns at `sessions.get(id) !== entry`
   *     (PtyHostService `onExit`) and `handlePtyExit` never runs for it. The
   *     reverse order — the process exits on its own first — makes `kill()`
   *     answer `not_found`, so this writes nothing and the exit's own ending
   *     stands.
   *   - THE LAUNCHER'S CLAIMS. The transition is written under the claims the
   *     session was spawned with (`sessionAuth`), exactly as its exit would
   *     have been. The containing caller may not be a member of the session's
   *     space at all (a node admin disabling an account), and
   *     `work_session_transition` has no bypass for that.
   *
   * The ending is `stopped_by_operator` — a person took the credential away —
   * with an `ended_reason` naming the containment, so the row says why it
   * stopped and a plain "Stopped by request." still means a terminate. The
   * texts are fixed strings: no credential label, id or secret reaches them (I5).
   *
   * The space key's per-session copy is scrubbed by `killThenRecordEnding`
   * after the kill, before the ending is written, so it is gone even when the
   * transition then fails.
   *
   * Never throws. A transition that fails after a successful kill is returned
   * as `recorded: false` with a reason, for the caller's `failures`.
   */
  async containCredentialSession(
    sessionId: string,
    cause: CredentialContainmentCause,
  ): Promise<CredentialContainmentResult> {
    const auth = this.sessionAuth.get(sessionId);
    const ending = CREDENTIAL_CONTAINMENT_ENDINGS[cause];
    let result: { outcome: PtyKillOutcome; recorded: boolean };
    try {
      result = await this.killThenRecordEnding(auth, sessionId, {
        onNotFound: 'skip',
        status: 'exited',
        error: () => ending.error,
        endedKind: 'stopped_by_operator',
        endedReason: ending.endedReason,
      });
    } catch (error) {
      // Killed, but the ending could not be written: the row is a ghost until
      // the boot reconciliation retires it, so say so loudly.
      const sqlState = (error as { code?: string } | null)?.code ?? '(no sqlstate)';
      this.loud(
        `credential containment killed session ${sessionId} but FAILED to record its ending — ` +
          `sqlstate=${sqlState}. Expect a ghost session until the next boot reconciliation.`,
      );
      return { outcome: 'killed', recorded: false, reason: `transition_failed: ${sqlState}` };
    }
    if (result.outcome === 'killed' && !result.recorded) {
      // A live PTY with no captured claims: not a session this service
      // spawned. Nothing can authorise its row's write from here.
      this.loud(
        `credential containment killed session ${sessionId}, which had no captured claims — ` +
          `its ending was not recorded. Expect a ghost session.`,
      );
      return { outcome: 'killed', recorded: false, reason: 'no_captured_claims' };
    }
    this.logger?.info('SpawnService: session contained', { sessionId, cause, outcome: result.outcome });
    return { outcome: result.outcome, recorded: result.recorded };
  }

  /**
   * THE STOP PATH's kill and ending, shared by `terminate` and
   * `containCredentialSession` so a stop has one writer.
   *
   * `kill(notify=true)` finalizes the PTY entry synchronously, which means
   * onExit will NOT fire for it and the exit sink will not run. So the
   * transition is written here explicitly rather than left to the exit path.
   *
   * The same skipped exit path is the one that scrubs a space API key's
   * per-session copy (`handlePtyExit`), so a `killed` scrubs it here, before
   * anything that can fail: a stopped session must not keep a copy of a space
   * secret on disk until the next boot sweep. The conversation state stays,
   * and a resume re-seeds the key from the credential as it reads NOW.
   * `not_found` scrubs nothing: a process that exited on its own was scrubbed
   * by its own exit.
   *
   * Returns without writing when the kill failed (`error`), when there was
   * nothing to kill and the caller asked to `skip` that, or when there are no
   * claims to write under. A transition that throws propagates.
   */
  private async killThenRecordEnding(
    auth: GraphAuth | undefined,
    sessionId: string,
    ending: {
      onNotFound: 'record' | 'skip';
      status: 'exited' | 'failed';
      error: (outcome: 'killed' | 'not_found') => string;
      endedKind: WorkSessionEndedKind;
      endedReason: string;
    },
  ): Promise<{ outcome: PtyKillOutcome; recorded: boolean }> {
    const outcome = this.pty.kill(sessionId, true);
    this.sessionAuth.delete(sessionId);
    // Even a failed kill must lose graph authority: a process whose lifecycle
    // is no longer under control is the least safe process to leave credentialed.
    if (outcome === 'error') return { outcome, recorded: false };
    if (outcome === 'killed') await this.scrubSpaceSecrets(sessionId);
    if (outcome === 'not_found' && ending.onNotFound === 'skip') return { outcome, recorded: false };
    if (auth === undefined) return { outcome, recorded: false };

    // `kill()` sends a signal and finalizes the tracked entry synchronously —
    // it does not, and structurally cannot, wait for node-pty's own async exit
    // event, so there is no real exit code available here to report. That is
    // a fact about this path, not a gap: `error` says so explicitly instead of
    // leaving `exit_code`/`error` both NULL, which used to be indistinguishable
    // from every OTHER unrecorded death this whole fix exists to end.
    //
    // The ending facts (171). `endedReason` is the sentence a person reads, so
    // it never mentions PTYs, kill outcomes or exit events — all of which are
    // already in `error`, which stays technical.
    await this.graph.transition(auth, {
      sessionId,
      status: ending.status,
      error: ending.error(outcome),
      endedKind: ending.endedKind,
      endedReason: ending.endedReason,
    });

    // The instrument, AFTER the ending is on record. A kill does not wait for
    // the exit event (see `error` above), so the harness may still be writing
    // its last records when this reads — a `cost-state` written after this
    // point is missed, and the transcript half is what the process had
    // flushed. Best-effort by contract; a later exit read overwrites with
    // more. Ghost reconciliation reuses this path, so a session killed with a
    // previous instance of the node is measured here too.
    await this.recordUsageAfterExit(auth, sessionId);
    return { outcome, recorded: true };
  }

  /**
   * THE USAGE INSTRUMENT (185) — read the whole transcript once the process
   * is gone, and persist what it says.
   *
   * WHY HERE AND WHY NOW. The agent's own transcript is the only place its
   * provider usage exists — PTY-hosted agents emit no `result` event, unlike
   * the headless chat runtime — and the file is transient: measured 2026-09-15,
   * 46.8% of ended claude-code sessions' transcripts were already gone. The
   * exit is the one moment the whole conversation is certainly on disk, so
   * every exit path calls this AFTER it has written the ending.
   *
   * NEVER ON THE TRANSITION PATH, NEVER THROWS. `handlePtyExit`'s loud-failure
   * contract is about the status write; a usage read that fails must not join
   * it. A session with no transcript (predates native-id capture, ran on
   * another node, file deleted) simply keeps `usage = NULL`, which renders as
   * "never measured" — the honest answer, and the one 171's rule requires.
   *
   * The cwd is re-derived exactly as `execution.transcript` derives it — the
   * scratch path from the data dir and the session id, the project or
   * worktree path from the row — so the exit read and the live page can never
   * name different files for one session.
   */
  private async recordUsageAfterExit(auth: GraphAuth, sessionId: string): Promise<void> {
    try {
      const info = await this.graph.loadWorkSessionForResume(auth, sessionId);
      const cwd =
        info.workdirMode === 'scratch' ? join(this.dataDir, 'scratch', sessionId) : info.workdirPath;
      const home = this.env.HOME ?? homedir();
      const fallbackAgentConfigDirs = await knownAgentConfigDirs({
        agentTool: info.agentTool,
        dataDir: this.dataDir,
        home,
      });
      const read = await readSessionUsage({
        sessionId,
        agentTool: info.agentTool,
        nativeSessionId: info.nativeSessionId,
        cwd,
        home,
        agentConfigDir: info.agentConfigDir,
        fallbackAgentConfigDirs,
      });
      if (!read.available) {
        this.logger?.debug('SpawnService: no transcript to record usage from', {
          sessionId,
          reason: read.reason,
          searchedPaths: read.searchedPaths,
        });
        return;
      }
      await this.graph.recordWorkSessionUsage(auth, sessionId, read.usage, read.source);
      this.logger?.info('SpawnService: recorded session usage', {
        sessionId,
        source: read.source,
        messages: read.usage.transcript.messages,
        transcriptBytes: read.usage.transcriptBytes,
      });
    } catch (error) {
      // Logged, never thrown: the ending is already recorded and nothing that
      // follows this may fail because a measurement did.
      this.logger?.warn?.('SpawnService: could not record session usage', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * STARTUP GHOST RECONCILIATION — retire sessions this node can no longer own.
   *
   * A PTY lives in THIS process. When the server dies — a dev restart, a crash,
   * a `kill` — every PTY dies with it, but the `work_sessions` rows stay at
   * `running`, because the exit transition is written by `handlePtyExit` and
   * that never runs for a process that was killed along with its host. The rows
   * become GHOSTS: the UI paints them as live agents, and each one burns a slot
   * against the 8-session concurrency cap forever. In practice a handful of dev
   * restarts is enough to make spawning fail outright with
   * `session concurrency cap reached`, which is how this was found.
   *
   * The inference is only sound at STARTUP, and only for THIS node: a fresh
   * process has an empty session map, so a row this node owns that claims to be
   * running provably has no PTY. Rows belonging to other nodes are left alone —
   * they may be perfectly alive over there.
   *
   * `terminate()` is reused rather than calling `transition` directly so the
   * ledger records the retirement like any other terminate; its `kill()` is a
   * no-op returning 'not_found', which is exactly right here.
   *
   * NEVER THROWS. Reconciliation is a cleanup, not a precondition: a node that
   * refuses to boot because it could not tidy stale rows is strictly worse than
   * one that boots with the cap slightly over-subscribed. Per-session failures
   * are logged and skipped so one unreadable row cannot block the rest.
   *
   * @returns how many sessions were retired.
   */
  async reconcileNodeGhosts(auth: GraphAuth): Promise<GhostReconcileReport> {
    if (!this.nodeId) return { retired: 0, errors: [] };

    let candidates: Array<{ sessionId: string; status: WorkSessionStatus }>;
    try {
      candidates = await this.graph.listNodeActiveSessions(auth, this.nodeId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger?.warn?.('SpawnService: ghost reconciliation could not list sessions', {
        nodeId: this.nodeId,
        error: message,
      });
      return { retired: 0, errors: [{ message: `could not list this node's sessions: ${message}` }] };
    }

    // WAS THE KERNEL INVOLVED? Asked ONCE, before the sweep, because it is a
    // property of the window we are reconciling, not of any one row.
    //
    // Every ghost here died with a previous instance of this node, and this
    // process cannot see how. The one thing it can still check is whether the
    // kernel OOM-killed anything in this cgroup — and under the standing policy
    // that is the difference between the single death that is allowed to happen
    // and every death that is not.
    //
    // The honesty bound from `readOomKillCount` applies with full force: the
    // counter is per-cgroup, so a positive says "a memory kill happened here",
    // NOT "this session was the one killed". With several ghosts that is not
    // enough to accuse any particular one, so a positive only ever WEAKENS the
    // claim to 'unknown' with a hedged sentence — it never asserts
    // `out_of_memory` for a row it cannot pin. A single ghost with a positive
    // counter is the one case where the attribution is unambiguous.
    //
    // The NEGATIVE is what carries most of the value, and it is unambiguous in
    // every case: the counter did not move, so the kernel killed nothing for
    // memory, so this was a restart and can be said so plainly.
    const oomSinceBoot = await readOomKillCount();
    const memoryKillHappened = (oomSinceBoot ?? 0) > 0;

    let retired = 0;
    const errors: Array<{ message: string }> = [];
    for (const { sessionId, status } of candidates) {
      // Defensive, and what makes this safe to call at any time rather than
      // only at boot: a session with a LIVE PTY on this node is not a ghost.
      if (this.pty.hasSession(sessionId)) continue;
      try {
        await this.terminate(auth, sessionId, {
          // 'failed', not 'exited': this agent did not finish, it was killed
          // with its host. See the `terminalStatus` docstring on terminate() —
          // 'exited' here is indistinguishable from a clean finish to every
          // client, because the contract projects neither exit_code nor error.
          terminalStatus: 'failed',
          reason:
            `retired at node startup: this node still recorded status '${status}' with no live ` +
            'PTY for it — the process almost certainly died with a prior instance of this node ' +
            '(crash or restart) before it could record its own exit',
          // Attribution rule, per the honesty bound above: assert
          // `out_of_memory` ONLY when a memory kill happened AND this is the
          // single ghost, because only then does the per-cgroup counter point
          // at exactly one session. With several ghosts we know a memory kill
          // occurred but not to whom, so the kind drops to 'unknown' and the
          // sentence says both halves out loud rather than picking a victim.
          ...(memoryKillHappened
            ? candidates.length === 1
              ? {
                  endedKind: 'out_of_memory' as const,
                  endedReason:
                    'Stopped because the machine ran out of memory. This session was using ' +
                    'too much, and the system shut it down to stay alive.',
                }
              : {
                  endedKind: 'unknown' as const,
                  endedReason:
                    'Stopped when the server restarted. The machine also ran out of memory ' +
                    'around that time, so this session may have been shut down for memory ' +
                    'rather than by the restart — there is no way to tell which.',
                }
            : {
                endedKind: 'server_restart' as const,
                endedReason:
                  'Stopped when the server restarted. Nothing was wrong with this session — ' +
                  'it can be resumed to pick up where it left off.',
              }),
        });
        retired += 1;
        this.logger?.info('SpawnService: retired ghost session', { sessionId, status });
      } catch (error) {
        // COLLECTED, not merely logged. This catch fires once per ghost, and on
        // a node whose owner is not a member of the ghost's space it fires for
        // EVERY one — `work_session_transition` goes through
        // `require_space_member` with no node-admin bypass. Reported only to an
        // optional logger, a total failure is indistinguishable from a clean
        // boot with nothing to do, and the caller's `retired: 0` says the same
        // thing either way.
        //
        // Measured on a live node 2026-08-22: reconciliation had been refused on
        // every boot since the space was created, silently, while its worktree
        // sibling printed the identical refusal at startup — because that one
        // returns its errors and this one dropped them.
        const message = error instanceof Error ? error.message : String(error);
        errors.push({ message: `session ${sessionId} (${status}): ${message}` });
        this.logger?.warn?.('SpawnService: failed to retire ghost session', {
          sessionId,
          error: message,
        });
      }
    }

    if (retired > 0) {
      this.logger?.info('SpawnService: ghost reconciliation complete', {
        nodeId: this.nodeId,
        retired,
      });
    }
    return { retired, errors };
  }

  /**
   * SHUTDOWN SWEEP — say why, while there is still someone to say it.
   *
   * Called from the server's SIGTERM/SIGINT handler, BEFORE the process exits.
   * Every PTY this process holds is about to die with it, and this is the only
   * moment at which the truthful reason is known FIRST-HAND: the server is
   * stopping, deliberately, and nothing is wrong with the agents.
   *
   * WHY THIS IS NOT JUST reconcileNodeGhosts RUNNING EARLIER. The reconciler
   * runs in the NEXT process and can only ever infer — it finds rows with no
   * live PTY and reasons backwards to "the previous instance must have died".
   * That inference is sound but weak, and it cannot tell a deploy from a crash.
   * Here we are the process that is being asked to stop, so the reason is
   * observed rather than deduced, and it is recorded before the evidence is
   * destroyed. Reconciliation stays as the backstop for the case this cannot
   * cover — a SIGKILL, where no handler runs at all.
   *
   * ORDERING. Must complete before the process exits, so the caller has to
   * await it. It is bounded: one transition per live session, and the caller
   * should still cap the total shutdown window rather than trust this.
   *
   * NEVER THROWS, per-session or overall. A shutdown that hangs or crashes
   * because it could not annotate a row is strictly worse than one that exits
   * having annotated fewer — the process is going away either way, and the
   * reconciler will still catch whatever this missed.
   *
   * @returns how many sessions were annotated.
   */
  async recordShutdown(auth: GraphAuth, signal: string): Promise<number> {
    const live = this.pty.liveSessionIds();
    if (live.length === 0) return 0;

    // Deliberately NOT the OOM path. Reaching this handler means the process
    // was asked to stop politely; the OOM killer sends SIGKILL and no handler
    // runs. So a session ending here ended because of a restart, full stop —
    // and saying so plainly is the entire point of doing it here.
    let annotated = 0;
    for (const sessionId of live) {
      const sessionAuth = this.sessionAuth.get(sessionId) ?? auth;
      try {
        await this.graph.transition(sessionAuth, {
          sessionId,
          status: 'failed',
          error: `node received ${signal} and is shutting down; this session's PTY dies with it`,
          endedKind: 'server_restart',
          endedReason:
            'Stopped because the server was restarted. Nothing was wrong with this session — ' +
            'it can be resumed to pick up where it left off.',
        });
        annotated += 1;
        // The usage read, BOUNDED. This handler's contract is "bounded and
        // never throws", and a whole-file parse of a 30 MB transcript (456 ms
        // measured) times eight live sessions is inside a shutdown window; a
        // stalled read is not. Two seconds per session, then move on — the
        // rows this misses are countable (`ended_kind = 'server_restart' and
        // usage is null`), which is what would justify a boot-time sweep.
        await Promise.race([
          this.recordUsageAfterExit(sessionAuth, sessionId),
          new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_USAGE_READ_MS).unref()),
        ]);
      } catch (error) {
        this.logger?.warn?.('SpawnService: could not record shutdown for session', {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    this.logger?.info('SpawnService: recorded shutdown', { signal, annotated, live: live.length });
    return annotated;
  }

  /**
   * The PTY-activity sink. Wire this into `PtyHostService`'s
   * `onActivityChange` at construction, exactly as `handlePtyExit` is wired
   * into `onSessionStatus`.
   *
   * WHAT THIS UNBLOCKS. `'idle'` has been a legal `work_session` status since
   * migration 043 (which accepts it, and permits running -> idle -> running:
   * only transitions OUT of a terminal status and INTO 'spawning' are refused),
   * and `needs-you` has been a fully drawn UI state since R8 — the presentation
   * verdict, the pill, the interrupt banner and the home-screen group all exist.
   * The predicate that lights them is `live && status === 'idle'`, and until
   * this method nothing in the product ever wrote that status, so the whole
   * chain was unreachable on real data. This is the missing writer, and it is
   * why no new UI is needed to make a blocked session visible.
   *
   * WHY THE GRAPH AND NOT A SIDE-CHANNEL. Writing status makes the signal an
   * ordinary entity change, so it rides the durable event spine every other
   * change rides: ordered by `seq`, deduplicated client-side by the
   * drop-if-not-newer rule, replayed on reconnect from the client's cursor, and
   * it nudges a liveness re-read on arrival. A bespoke socket would have had to
   * re-earn all four.
   *
   * HONESTY BOUND. `'idle'` here means "this PTY has been silent for the host's
   * quiescence threshold", nothing more. It is NOT proof an agent is waiting on
   * a human — a silent `npm install` produces the same evidence — so no caller
   * may render it as a specific question. Distinguishing the two needs a
   * structured signal from the agent, which this repo does not have.
   */
  /**
   * Subscribe to "this session is live and can take a turn": after a resume
   * succeeds, after a spawn's first turn settles, and on each running/idle
   * activity transition this service writes. It is what a server-side OUTBOX
   * drains on (Forms W2: `form_deliveries` queued for a session that was not
   * live), so a queued answer arrives as the resumed session's next turn.
   *
   * Fire-and-forget, after the transition is written: a listener never delays,
   * and never fails, the lifecycle write it observes. Returns an unsubscribe.
   */
  onSessionLive(listener: SessionLiveListener): () => void {
    this.sessionLiveListeners.add(listener);
    return () => { this.sessionLiveListeners.delete(listener); };
  }

  private notifySessionLive(sessionId: string, cause: SessionLiveCause): void {
    for (const listener of this.sessionLiveListeners) {
      try {
        void Promise.resolve(listener(sessionId, cause)).catch((error: unknown) => {
          this.logger?.warn?.('SpawnService: session-live listener failed', {
            sessionId, cause, error: error instanceof Error ? error.message : String(error),
          });
        });
      } catch (error) {
        this.logger?.warn?.('SpawnService: session-live listener threw', {
          sessionId, cause, error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  handlePtyActivity = async (sessionId: string, activity: PtyActivity): Promise<void> => {
    const auth = this.sessionAuth.get(sessionId);
    // No claims ⇒ nothing can be written (see the sessionAuth docstring). Unlike
    // the exit path this is not worth shouting about: an activity signal for an
    // unknown session is a missed nicety, not a ghost row, and the exit path
    // legitimately deletes the claims before a late timer can fire.
    if (auth === undefined) return;
    // A PTY that has already gone means any status this would write is stale,
    // and the RPC would refuse it with a 23514 anyway. Checking here keeps a
    // routine race out of the error log.
    if (!this.pty.hasSession(sessionId)) return;
    try {
      await this.graph.transition(auth, {
        sessionId,
        status: activity === 'idle' ? 'idle' : 'running',
      });
      this.notifySessionLive(sessionId, activity === 'idle' ? 'idle' : 'running');
    } catch (error) {
      // Deliberately NOT `loud`. A failed exit transition leaves a ghost that
      // corrupts the concurrency cap forever; a failed activity transition
      // leaves a session showing the previous one of two non-terminal states,
      // and the next transition corrects it. Same reason it does not retry.
      this.logger?.warn?.('SpawnService: failed to record session activity transition', {
        sessionId,
        activity,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  /**
   * The PTY-exit sink (R29's single writer). Wire this into
   * `PtyHostService`'s `onSessionStatus` at construction —
   * `createExecutionPtyHost` in the server's execution-handlers does exactly
   * that, and it is the only reason the graph ever learns an agent finished.
   */
  handlePtyExit = async (
    sessionId: string,
    status: PtySessionStatus,
    exitInfo: PtyExitInfo = { exitCode: null, signal: null },
  ): Promise<void> => {
    const auth = this.sessionAuth.get(sessionId);
    this.sessionAuth.delete(sessionId);
    // FIRST, before any graph write can fail, and on the ghost path too: the
    // process that read the space key is gone, so the key leaves the disk. A
    // kill (containment) arrives here like any other exit.
    await this.scrubSpaceSecrets(sessionId);
    if (auth === undefined) {
      this.loud(
        `PTY for session ${sessionId} exited (${status}) with no captured claims — ` +
          `the graph still believes this session is running. Expect a ghost session.`,
      );
      return;
    }
    // This is the ONE path with real evidence: node-pty observed the actual
    // exit and told us the code and the signal. So the OOM question is asked
    // here too — a signal death whose cgroup counter advanced is a memory kill,
    // and a signal death whose counter did not is something else. Unlike the
    // ghost path, the window here is one specific process's death, so a
    // positive attributes cleanly.
    const oomBefore = this.oomKillAtSpawn.get(sessionId) ?? null;
    this.oomKillAtSpawn.delete(sessionId);
    const killedForMemory =
      exitInfo.signal !== null && oomKillObserved(oomBefore, await readOomKillCount());
    try {
      await this.graph.transition(auth, {
        sessionId,
        status: EXIT_STATUS_MAP[status],
        exitCode: exitInfo.exitCode,
        // A clean 'completed' exit needs no narrative — exit_code alone says
        // it. 'failed' always gets an explicit statement of what the PTY
        // actually reported (see describePtyExit) — never left for `error` to
        // stay NULL by default.
        ...(status === 'failed' ? { error: describePtyExit(exitInfo) } : {}),
        ...endingFromPtyExit(status, exitInfo, killedForMemory),
      });
      // The one path with a real exit event, and so the one moment the file
      // is complete — the process that wrote it has exited. Runs after the
      // transition and inside its own catch; see the method.
      await this.recordUsageAfterExit(auth, sessionId);
    } catch (error) {
      // LOUD, always, even with no logger injected.
      //
      // This is the failure that compounds in silence: the row stays 'running',
      // the UI paints a dead agent as live, and the session keeps counting
      // against the concurrency cap — so spawning degrades over hours for
      // reasons nobody can trace back to here. A ghost session that announces
      // itself is recoverable; a silent one is not. The SQLSTATE is included
      // because 42501 here means a claims problem, not an RLS policy problem,
      // and those look identical from the outside.
      const sqlState =
        (error as { code?: string } | null)?.code ?? '(no sqlstate)';
      this.loud(
        `FAILED to transition work_session ${sessionId} to ` +
          `${EXIT_STATUS_MAP[status]} after its PTY exited — sqlstate=${sqlState}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      this.logger?.error(
        'SpawnService: failed to record PTY exit transition',
        error instanceof Error ? error : new Error(String(error)),
        { sessionId, status, sqlState },
      );
    } finally {
      // In `finally`, not after the `try`: a transition that FAILED still means
      // the agent is gone, and the checkout must come back either way.
      await this.releaseWorktreeLeaseAfterExit(auth, sessionId);
    }
  };

  /**
   * The one lookup that turns a session (or a path) back into the worktree it
   * is bound to.
   *
   * `work_sessions` records the workdir PATH, not the worktree entity id, and
   * `WorkSessionResumeInfo` carries no worktree id either — so both the resume
   * lease and the exit release have to ask the allocation table. Scoping to
   * THIS node is not a limitation of the query, it is the correct bound: an
   * allocation is a checkout on a specific node's disk, and both callers have
   * already established that the checkout is on this one (resume stat()ed the
   * directory; exit just ran a PTY in it).
   *
   * Returns null rather than throwing. Both callers have a defined, non-fatal
   * behaviour for "no allocation", and neither should turn a bookkeeping gap
   * into a dead session.
   */
  private async findWorktreeAllocation(
    auth: GraphAuth,
    match: (row: WorktreeAllocationRow) => boolean,
  ): Promise<WorktreeAllocationRow | null> {
    // A node with no id owns no allocations to look up — `worktree_allocations`
    // is keyed by node_id, so there is nothing to ask for.
    if (this.nodeId === null) return null;
    try {
      const rows = await this.graph.listNodeWorktreeAllocations(auth, this.nodeId);
      return rows.find(match) ?? null;
    } catch (error) {
      this.logger?.warn?.('SpawnService: could not read this node worktree allocations', {
        nodeId: this.nodeId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * D6a — hand the checkout back when the agent that held it is gone.
   *
   * This used to be a literally empty `finally { }`. The consequence was not
   * theoretical: the lease is a `unique(lease_session_id) where not null` row
   * that nothing else clears on a CLEAN exit, so a session that finished
   * normally PINNED its worktree. Reconciliation does release a lease held by a
   * terminal session — but reconciliation is a node-boot sweep, so in practice
   * the checkout stayed unavailable until the next reboot.
   *
   * The worktree itself is NEVER touched here. §6.3: a checkout may hold
   * unpushed work, and an exiting process is evidence about a process, not
   * about a directory.
   *
   * Loud but non-fatal, and it must stay that way — this runs in the `finally`
   * of the exit transition, and a throw here would replace the transition's
   * own (already reported) outcome with this one.
   */
  private async releaseWorktreeLeaseAfterExit(
    auth: GraphAuth,
    sessionId: string,
  ): Promise<void> {
    try {
      const allocation = await this.findWorktreeAllocation(
        auth,
        (row) => row.leaseSessionId === sessionId,
      );
      if (!allocation) return;
      await this.graph.releaseWorktreeLease(auth, allocation.worktreeId);
    } catch (error) {
      // LOUD for the same reason the transition above is: the damage is a
      // worktree that silently stops being allocatable, and the node degrades
      // over hours with nothing pointing back here.
      this.loud(
        `FAILED to release the worktree lease held by session ${sessionId} after its PTY ` +
          `exited — that checkout stays leased to a dead session until the next ` +
          `reconciliation sweep: ${error instanceof Error ? error.message : String(error)}`,
      );
      this.logger?.error?.(
        'SpawnService: failed to release worktree lease on PTY exit',
        error instanceof Error ? error : new Error(String(error)),
        { sessionId },
      );
    }
  }

  /** Exit-path failures must never depend on a logger having been injected. */
  private loud(message: string): void {
    // eslint-disable-next-line no-console
    console.error(`[tm8:SpawnService] ${message}`);
  }

  /** Best-effort removal of a session's manifest file. Used by tests + cleanup. */
  async discardManifest(sessionId: string): Promise<void> {
    await rm(this.manifestPathFor(sessionId), { force: true });
  }
}

/**
 * The selection a session was launched with, from its recorded manifest, for
 * resume to replay. Stored JSON, so it is parsed with the contract's own
 * schemas. A malformed (or over-ceiling) record is never half-applied: the
 * resume loads the defaults and `invalid` makes its audit say
 * `replay-invalid`, so it is never misread as a launch that selected nothing.
 */
export function replayedSelection(posture: SessionLaunchPosture | null | undefined): {
  selection?: SpawnSelection;
  selectionReasons?: NonNullable<SpawnRequest['selectionReasons']>;
  invalid?: true;
} {
  const hasSelection = posture?.selection !== undefined;
  const hasReasons = posture?.selectionReasons !== undefined;
  const selection = SpawnSelectionSchema.safeParse(posture?.selection);
  const reasons = SpawnSelectionReasonsSchema.safeParse(posture?.selectionReasons);
  if ((hasSelection && !selection.success) || (hasReasons && !reasons.success)) return { invalid: true };
  return {
    ...(hasSelection && selection.success ? { selection: selection.data } : {}),
    ...(hasReasons && reasons.success ? { selectionReasons: reasons.data } : {}),
  };
}
