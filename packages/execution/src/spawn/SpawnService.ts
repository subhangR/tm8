// @tm8/execution — SpawnService: the G1A loop's engine.
//
// Owns the four verbs the loop is made of — spawn, prompt, terminate, and the
// PTY-exit transition — and nothing else. It has no database driver, no HTTP
// knowledge and no contract types: the graph arrives as `GraphPort`, the
// terminal as `PtyHostService`, and both are swappable in tests. The whole
// point is that the PTY assertions can run with no Postgres at all.

import { mkdir, writeFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { PtyHostService } from '../pty/PtyHostService.js';
import type { Logger, PtySessionStatus } from '../pty/types.js';
import { buildAgentCommand, composeEnv, composeManifest, resolveLaunchConfig, resolveWorkdir } from './manifest.js';
import type {
  GraphAuth,
  GraphPort,
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
}

/** PTY exit status → work_session status. The PTY speaks in outcomes, the
 *  graph in lifecycle states, and 'completed' is not one of the five the
 *  001 CHECK constraint allows. */
const EXIT_STATUS_MAP: Record<PtySessionStatus, WorkSessionStatus> = {
  completed: 'exited',
  failed: 'failed',
};

export class SpawnService {
  private readonly graph: GraphPort;
  private readonly pty: PtyHostService;
  private readonly baseUrl: string;
  private readonly dataDir: string;
  private readonly nodeId: string | null;
  private readonly logger: Logger | undefined;
  private readonly env: NodeJS.ProcessEnv;

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
  }

  private manifestPathFor(sessionId: string): string {
    return join(this.dataDir, 'manifests', `${sessionId}.json`);
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

    const context = await this.graph.loadSpawnContext(auth, {
      spaceId: request.spaceId,
      teamMemberId: request.teamMemberId,
      projectId: request.projectId ?? null,
      taskIds,
    });

    const launch = resolveLaunchConfig(request, context, this.env);
    const workdir = resolveWorkdir(request, context, {
      scratchRoot: join(this.dataDir, 'scratch'),
    });

    const { sessionId, commandResult } = await this.graph.createWorkSession(auth, {
      spaceId: request.spaceId,
      teamMemberId: request.teamMemberId,
      taskIds,
      projectId: request.projectId ?? null,
      workdirMode: workdir.mode,
      workdirPath: workdir.path,
      baseRef: workdir.baseRef,
      mode: launch.mode,
      model: launch.model,
      agentTool: launch.agentTool,
      title: request.title?.trim() || null,
      nodeId: this.nodeId,
      confirmUntrusted: request.confirmUntrusted ?? false,
      clientMutationId: request.clientMutationId ?? null,
    });

    // A projectless scratch session's directory is named for the session, which
    // only exists now. Re-resolve so the manifest and the PTY agree.
    const cwd = context.project ? workdir.path : join(this.dataDir, 'scratch', sessionId);

    this.sessionAuth.set(sessionId, auth);

    try {
      const command = buildAgentCommand(launch, this.env);
      const manifestPath = this.manifestPathFor(sessionId);
      const manifest = composeManifest({
        sessionId,
        request,
        context,
        launch,
        workdir: { mode: workdir.mode, path: cwd },
        command,
        baseUrl: this.baseUrl,
      });

      const env = composeEnv(manifest, manifestPath, this.baseUrl, this.env);
      const envVarNames = Object.keys(env).sort();

      await this.writeManifestFile(manifestPath, manifest);
      // Names only. The manifest row is read by the UI and included in backups;
      // an ANTHROPIC_API_KEY value in there would outlive every rotation.
      await this.graph.recordManifest(auth, sessionId, manifest, envVarNames);

      if (!context.project) await mkdir(cwd, { recursive: true });

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

      await this.graph.transition(auth, { sessionId, status: 'running' });

      this.logger?.info('SpawnService: session spawned', { sessionId, cwd, reused });

      return { sessionId, manifestPath, manifest, command, cwd, envVarNames, reused, commandResult };
    } catch (error) {
      // The row exists and the graph believes a session is spawning. Leaving it
      // there would burn a slot against the concurrency cap forever, so mark it
      // failed before rethrowing — and do not let a cleanup failure mask the
      // original error, which is the one that explains what happened.
      await this.failSession(auth, sessionId, error);
      this.sessionAuth.delete(sessionId);
      throw error;
    }
  }

  private async writeManifestFile(path: string, manifest: Tm8Manifest): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    // Write-then-rename: the agent boots concurrently and must never observe a
    // half-written manifest. A truncated JSON parse at boot is indistinguishable
    // from a malformed manifest, and the agent has no way to retry.
    const tmp = `${path}.tmp`;
    await writeFile(tmp, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    const { rename } = await import('node:fs/promises');
    await rename(tmp, path);
  }

  private async failSession(auth: GraphAuth, sessionId: string, error: unknown): Promise<void> {
    try {
      await this.graph.transition(auth, {
        sessionId,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
    } catch (cleanupError) {
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
    opts: { force?: boolean; clientMutationId?: string | null } = {},
  ): Promise<{ outcome: string; commandResult: unknown }> {
    const commandResult = await this.graph.recordCommand(auth, {
      sessionId,
      operation: 'execution.terminate',
      payload: { force: opts.force ?? false },
      clientMutationId: opts.clientMutationId ?? null,
    });

    const outcome = this.pty.kill(sessionId, true);
    this.sessionAuth.delete(sessionId);

    // 'not_found' is not an error: terminating an already-dead session is the
    // user cancelling something that just finished. The graph still needs to
    // reflect the terminal state, and the RPC tolerates same→same.
    await this.graph.transition(auth, {
      sessionId,
      status: 'exited',
      ...(opts.force ? { error: 'terminated by request (force)' } : {}),
    });

    this.logger?.info('SpawnService: session terminated', { sessionId, outcome });
    return { outcome, commandResult };
  }

  /**
   * The PTY-exit sink (R29's single writer). Wire this into
   * `PtyHostService`'s `onSessionStatus` at construction —
   * `createExecutionPtyHost` in the server's execution-handlers does exactly
   * that, and it is the only reason the graph ever learns an agent finished.
   */
  handlePtyExit = async (sessionId: string, status: PtySessionStatus): Promise<void> => {
    const auth = this.sessionAuth.get(sessionId);
    this.sessionAuth.delete(sessionId);
    if (auth === undefined) {
      // A PTY this process did not spawn (server restarted under a live agent,
      // or a terminate already consumed the entry). Nothing to write as.
      this.logger?.warn('SpawnService: PTY exited with no captured auth; skipping transition', {
        sessionId,
        status,
      });
      return;
    }
    try {
      await this.graph.transition(auth, { sessionId, status: EXIT_STATUS_MAP[status] });
    } catch (error) {
      this.logger?.error(
        'SpawnService: failed to record PTY exit transition',
        error instanceof Error ? error : new Error(String(error)),
        { sessionId, status },
      );
    }
  };

  /** Best-effort removal of a session's manifest file. Used by tests + cleanup. */
  async discardManifest(sessionId: string): Promise<void> {
    await rm(this.manifestPathFor(sessionId), { force: true });
  }
}
