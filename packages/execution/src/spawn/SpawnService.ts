// @tm8/execution — SpawnService: the G1A loop's engine.
//
// Owns the four verbs the loop is made of — spawn, prompt, terminate, and the
// PTY-exit transition — and nothing else. It has no database driver, no HTTP
// knowledge and no contract types: the graph arrives as `GraphPort`, the
// terminal as `PtyHostService`, and both are swappable in tests. The whole
// point is that the PTY assertions can run with no Postgres at all.

import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { PtyHostService } from '../pty/PtyHostService.js';
import type { Logger, PtyExitInfo, PtySessionStatus } from '../pty/types.js';
import { composePrompt } from '@tm8/prompt';

import { trustClaudeWorkspace, trustCodexWorkspace } from './workspace-trust.js';
import {
  preflightCodexNetworkPolicy,
  type CodexNetworkPreflight,
} from './codex-network-preflight.js';
import {
  buildAgentCommand,
  composeEnv,
  composeManifest,
  resolveAgentBinary,
  resolveCommandNetworkPolicy,
  resolveLaunchConfig,
  resolveSessionTitle,
  resolveWorkdir,
  withAgentPrompt,
  withAgentResume,
  type ResolvedLaunchConfig,
} from './manifest.js';
import { resolveCodexNativeSessionId } from './native-session.js';
import type { AgentCredentialHome, AgentCredentialHomePort } from './agent-credentials.js';
import type {
  GraphAuth,
  GraphPort,
  InteractionProfilePinContext,
  ResumeRequest,
  SessionLaunchPosture,
  SpawnRequest,
  SpawnResult,
  Tm8Manifest,
  WorkSessionStatus,
} from './types.js';
import { SpawnError } from './types.js';

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
}

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

export class SpawnService {
  private readonly graph: GraphPort;
  private readonly pty: PtyHostService;
  private readonly baseUrl: string;
  private readonly dataDir: string;
  private readonly nodeId: string | null;
  private readonly logger: Logger | undefined;
  private readonly env: NodeJS.ProcessEnv;
  private readonly bootSettlementMs: number;
  private readonly codexNetworkPreflight: CodexNetworkPreflight;
  private readonly credentialHome: AgentCredentialHomePort | undefined;
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

  constructor(options: SpawnServiceOptions) {
    this.graph = options.graph;
    this.pty = options.pty;
    this.baseUrl = options.baseUrl;
    this.dataDir = options.dataDir ?? join(homedir(), '.tm8-dev');
    this.nodeId = options.nodeId ?? null;
    this.logger = options.logger;
    this.env = options.env ?? process.env;
    this.bootSettlementMs = options.bootSettlementMs ?? 150;
    this.codexNetworkPreflight = options.codexNetworkPreflight ?? preflightCodexNetworkPolicy;
    this.credentialHome = options.credentialHome;
  }

  /**
   * The spawning identity's credential home for this session's agent tool, or
   * null when there is nothing to inject.
   *
   * ERRORS ARE NOT SWALLOWED, and that is the deliberate half of this method.
   * A member who HAS connected their own identity and then silently gets the
   * node's machine account back is exactly the misattribution this whole build
   * exists to end — and it is invisible, because the session runs perfectly and
   * simply commits as somebody else. So a resolution failure fails the spawn
   * with its real reason. A clean `null` is the ordinary answer, not a failure:
   * it means this identity has not connected this provider, and today's
   * behaviour is correct for them.
   */
  private async resolveCredentialHome(
    auth: GraphAuth,
    agentTool: string,
  ): Promise<AgentCredentialHome | null> {
    if (!this.credentialHome) return null;
    return this.credentialHome.resolve(auth, { agentTool });
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

  private manifestPathFor(sessionId: string): string {
    return join(this.dataDir, 'manifests', `${sessionId}.json`);
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
  ): Promise<SessionLaunchPosture | null> {
    try {
      return await this.graph.loadSessionLaunchPosture(auth, sessionId);
    } catch (error) {
      this.logger?.warn?.('SpawnService: could not read the recorded posture of a resuming session', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
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
   * Three deliberate silences, all of them "no inheritance" rather than a
   * failure:
   *   - an explicit `accessMode` on the request means the caller has already
   *     answered the question; nothing is read at all
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
    if (!parentSessionId || request.accessMode) return null;
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
   *   5. spawn the PTY
   *   6. transition to `running`
   *
   * Steps 1-2 precede 3 because the RPC persists the resolved model/agentTool/
   * mode onto the row, and resolving them needs the persona's defaults. Step 4
   * precedes 5 because the agent reads the manifest at boot — a PTY started
   * before the file exists races its own configuration.
   */
  async spawn(auth: GraphAuth, request: SpawnRequest): Promise<SpawnResult> {
    const taskIds = request.taskIds ?? [];
    let bootExit: PtyExitInfo | undefined;

    const context = await this.graph.loadSpawnContext(auth, {
      spaceId: request.spaceId,
      teamMemberId: request.teamMemberId,
      projectId: request.projectId ?? null,
      taskIds,
    });

    const inherited = await this.inheritedPosture(auth, request);
    const launch = resolveLaunchConfig(request, context, this.env, inherited);
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

    const resolvedProfile = await this.graph.resolveInteractionProfile(auth, {
      spaceId: request.spaceId,
      teamMemberId: request.teamMemberId,
      interactionProfileId: request.interactionProfileId ?? null,
    });

    const { sessionId, commandResult, replayed } = await this.graph.createWorkSession(auth, {
      spaceId: request.spaceId,
      teamMemberId: request.teamMemberId,
      parentSessionId: request.parentSessionId ?? null,
      taskIds,
      projectId: request.projectId ?? null,
      workdirMode: workdir.mode,
      workdirPath: workdir.path,
      baseRef: workdir.baseRef,
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
    const cwd = context.project ? workdir.path : join(this.dataDir, 'scratch', sessionId);

    // A ledger replay is a transport retry of the original command result, not
    // permission to boot another child under the old work-session id.
    if (replayed) {
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

    try {
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
      const baseCommand = buildAgentCommand(launch, this.env, { claudeSessionId: nativeSessionId });
      const manifestPath = this.manifestPathFor(sessionId);
      const manifest = composeManifest({
        sessionId,
        request,
        context,
        launch,
        commandNetwork,
        interactionProfile,
        workdir: { mode: workdir.mode, path: cwd },
        command: baseCommand,
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
          ? `${envelope.task}\n<tm8_session_id>${sessionId}</tm8_session_id>`
          : envelope.task;
      const command = withAgentPrompt(
        baseCommand,
        { system: envelope.system, task },
        launch,
        this.env,
      );

      const credentialHome = await this.resolveCredentialHome(auth, launch.agentTool);
      const env = composeEnv(
        manifest,
        manifestPath,
        this.baseUrl,
        this.env,
        this.journalPathFor(sessionId),
        agentToken,
        credentialHome ?? undefined,
      );
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
      });

      if (!context.project) await this.ensurePrivateScratchDirectory(cwd);

      // Record the CLI's per-workspace trust BEFORE the child exists, because
      // afterwards is too late: the dialog blocks on first directory access, and
      // this launch is unattended — nobody is watching the PTY to answer it.
      // Must also come after the `mkdir` above, since these resolve `cwd`
      // through `realpath` and a scratch directory does not exist until then.
      if (launch.agentTool === 'claude-code') await trustClaudeWorkspace(cwd, this.env);
      if (launch.agentTool === 'codex') await trustCodexWorkspace(cwd, this.env);

      // Prompts accepted between here and the PTY being live must not be
      // dropped on the floor; the handoff parks them in the bounded FIFO and
      // spawnIfAbsent drains it.
      this.pty.beginPromptHandoff(sessionId);
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

      this.logger?.info('SpawnService: session spawned', { sessionId, cwd, reused });

      return { sessionId, manifestPath, manifest, command, cwd, envVarNames, reused, commandResult };
    } catch (error) {
      // The row exists and the graph believes a session is spawning. Leaving it
      // there would burn a slot against the concurrency cap forever, so mark it
      // failed before rethrowing — and do not let a cleanup failure mask the
      // original error, which is the one that explains what happened.
      await this.failSession(auth, sessionId, error, bootExit);
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

    const context = await this.graph.loadSpawnContext(auth, {
      spaceId: info.spaceId,
      teamMemberId: info.teamMemberId,
      projectId: info.projectId,
      taskIds: info.taskIds,
    });

    // The posture is the one launch fact `work_sessions` does NOT carry (the
    // row has model/mode/agent_tool and no permission column), so re-resolving
    // from the row alone silently demoted every resumed session to the persona
    // default — a session launched `fullAccess` came back on `auto` and stalled
    // on its first approval. The recorded manifest is where that fact is
    // durable, and resume does not rewrite it, so it still describes the launch.
    const recordedPosture = await this.recordedPosture(auth, sessionId);

    // The stored row IS the request: same precedence chain as spawn, fed the
    // facts the session was actually launched with, so the two paths resolve
    // identically and cannot drift.
    const syntheticRequest: SpawnRequest = {
      spaceId: info.spaceId,
      teamMemberId: info.teamMemberId,
      projectId: info.projectId,
      taskIds: info.taskIds,
      mode: info.mode,
      model: info.model,
      agentTool: info.agentTool,
      title: info.title || null,
      clientMutationId: request.clientMutationId ?? null,
    };
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

    // Project cwd is re-read from the graph (it may legitimately have moved);
    // a scratch cwd is named for the SESSION id, which resume shares — so the
    // conversation's own files are still there.
    const cwd = context.project
      ? context.project.workingDir
      : join(this.dataDir, 'scratch', sessionId);

    // Resolve the native id BEFORE any state change (fail-closed, maestro's
    // codex_resume_id_unavailable pattern). Claude ids are pre-minted at spawn,
    // so a missing one means the session predates resume support — refuse
    // honestly rather than silently launching a fresh conversation. Codex ids
    // are captured lazily from the rollout here, then recorded write-once so
    // the scan never runs twice.
    let nativeSessionId = info.nativeSessionId;
    if (!nativeSessionId && launch.agentTool === 'codex') {
      nativeSessionId = await resolveCodexNativeSessionId({
        home: this.env.HOME ?? homedir(),
        tm8SessionId: sessionId,
        cwd,
      });
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

    try {
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
      const agentToken = await this.graph.issueWorkSessionAgentToken(
        auth,
        sessionId,
        info.teamMemberId,
      );

      // NO --session-id on a resume invocation: the id is already Claude's, and
      // naming it twice (`--session-id` + `--resume`) is two flags to disagree.
      const baseCommand = buildAgentCommand(launch, this.env);
      const manifest = composeManifest({
        sessionId,
        request: syntheticRequest,
        context,
        launch,
        commandNetwork,
        ...(interactionProfile ? { interactionProfile } : {}),
        workdir: { mode: info.workdirMode, path: cwd },
        command: baseCommand,
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
      const credentialHome = await this.resolveCredentialHome(auth, launch.agentTool);
      const env = composeEnv(
        manifest,
        manifestPath,
        this.baseUrl,
        this.env,
        this.journalPathFor(sessionId),
        agentToken,
        credentialHome ?? undefined,
      );
      const envVarNames = Object.keys(env).sort();

      await this.assertAgentRuntime(baseCommand, launch, env);

      // The manifest FILE is rewritten (the agent re-reads it at boot); the
      // manifest ROW is not re-recorded — record_session_manifest documented
      // the original launch, and this resume's exact command is in the ledger.
      await this.writeManifestFile(manifestPath, manifest);

      if (!context.project) await this.ensurePrivateScratchDirectory(cwd);
      if (launch.agentTool === 'claude-code') await trustClaudeWorkspace(cwd, this.env);
      if (launch.agentTool === 'codex') await trustCodexWorkspace(cwd, this.env);

      this.pty.beginPromptHandoff(sessionId);
      const { reused } = this.pty.spawnIfAbsent({
        sessionId,
        command,
        cwd,
        env,
        ...(request.cols ? { cols: request.cols } : {}),
        ...(request.rows ? { rows: request.rows } : {}),
      });

      const bootSettlement = this.pty.waitForBootSettlement(sessionId, this.bootSettlementMs);
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
      return { sessionId, manifestPath, manifest, command, cwd, envVarNames, reused, commandResult };
    } catch (error) {
      await this.failSession(auth, sessionId, error, bootExit);
      this.sessionAuth.delete(sessionId);
      throw error;
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
    try {
      await this.graph.transition(auth, {
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
      });
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
        this.logger?.info(
          'SpawnService: skipped a redundant failed-transition write — the row is already terminal, ' +
            'almost certainly from the real PTY-exit path recording it first',
          { sessionId, originalError: message },
        );
        return;
      }
      this.logger?.error(
        'SpawnService: failed to mark session failed after spawn error',
        cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError)),
        { sessionId },
      );
    }
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
    } = {},
  ): Promise<{ outcome: string; commandResult: unknown }> {
    const commandResult = await this.graph.recordCommand(auth, {
      sessionId,
      operation: 'execution.terminate',
      payload: { force: opts.force ?? false },
      clientMutationId: opts.clientMutationId ?? null,
    });

    const outcome = this.pty.kill(sessionId, true);
    this.sessionAuth.delete(sessionId);
    // Even a failed kill must lose graph authority: a process whose lifecycle
    // is no longer under control is the least safe process to leave credentialed.

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
    if (outcome === 'error') {
      throw new SpawnError(
        `failed to terminate work session ${sessionId}: the kill signal itself failed`,
        'internal',
        { sessionId, outcome },
      );
    }

    // `kill()` sends a signal and finalizes the tracked entry synchronously —
    // it does not, and structurally cannot, wait for node-pty's own async exit
    // event, so there is no real exit code available here to report. That is
    // a fact about this path, not a gap: `error` says so explicitly instead of
    // leaving `exit_code`/`error` both NULL, which used to be indistinguishable
    // from every OTHER unrecorded death this whole fix exists to end.
    // 'not_found' is not an error: terminating an already-dead session is the
    // user cancelling something that just finished. The graph still needs to
    // reflect the terminal state, and the RPC tolerates same→same.
    const error =
      opts.reason ??
      (outcome === 'not_found'
        ? 'terminate requested, but no live PTY was found (already exited)'
        : opts.force
          ? 'terminated by request (force) — exit code not observed, kill does not wait for the real exit event'
          : 'terminated by request — exit code not observed, kill does not wait for the real exit event');
    await this.graph.transition(auth, { sessionId, status: 'exited', error });

    this.logger?.info('SpawnService: session terminated', { sessionId, outcome });
    return { outcome, commandResult };
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
  async reconcileNodeGhosts(auth: GraphAuth): Promise<number> {
    if (!this.nodeId) return 0;

    let candidates: Array<{ sessionId: string; status: WorkSessionStatus }>;
    try {
      candidates = await this.graph.listNodeActiveSessions(auth, this.nodeId);
    } catch (error) {
      this.logger?.warn?.('SpawnService: ghost reconciliation could not list sessions', {
        nodeId: this.nodeId,
        error: error instanceof Error ? error.message : String(error),
      });
      return 0;
    }

    let retired = 0;
    for (const { sessionId, status } of candidates) {
      // Defensive, and what makes this safe to call at any time rather than
      // only at boot: a session with a LIVE PTY on this node is not a ghost.
      if (this.pty.hasSession(sessionId)) continue;
      try {
        await this.terminate(auth, sessionId, {
          reason:
            `retired at node startup: this node still recorded status '${status}' with no live ` +
            'PTY for it — the process almost certainly died with a prior instance of this node ' +
            '(crash or restart) before it could record its own exit',
        });
        retired += 1;
        this.logger?.info('SpawnService: retired ghost session', { sessionId, status });
      } catch (error) {
        this.logger?.warn?.('SpawnService: failed to retire ghost session', {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (retired > 0) {
      this.logger?.info('SpawnService: ghost reconciliation complete', {
        nodeId: this.nodeId,
        retired,
      });
    }
    return retired;
  }

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
    if (auth === undefined) {
      this.loud(
        `PTY for session ${sessionId} exited (${status}) with no captured claims — ` +
          `the graph still believes this session is running. Expect a ghost session.`,
      );
      return;
    }
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
      });
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
    }
  };

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
