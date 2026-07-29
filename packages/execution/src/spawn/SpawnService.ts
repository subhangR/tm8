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
import type { Logger, PtyExitInfo, PtySessionStatus } from '../pty/types.js';
import { composePrompt } from '@tm8/prompt';

import {
  buildAgentCommand,
  composeEnv,
  composeManifest,
  resolveLaunchConfig,
  resolveWorkdir,
  withAgentPrompt,
} from './manifest.js';
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
  /** Window in which a child exit makes spawn itself fail. Default 150ms. */
  bootSettlementMs?: number;
}

/** PTY exit status → work_session status. The PTY speaks in outcomes, the
 *  graph in lifecycle states, and 'completed' is not one of the five the
 *  001 CHECK constraint allows. */
const EXIT_STATUS_MAP: Record<PtySessionStatus, WorkSessionStatus> = {
  completed: 'exited',
  failed: 'failed',
};

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
    let bootExit: PtyExitInfo | undefined;

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

    const resolvedProfile = await this.graph.resolveInteractionProfile(auth, {
      spaceId: request.spaceId,
      teamMemberId: request.teamMemberId,
      interactionProfileId: request.interactionProfileId ?? null,
    });

    const { sessionId, commandResult, replayed } = await this.graph.createWorkSession(auth, {
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
      const interactionProfile = await this.graph.recordInteractionProfilePin(
        auth,
        sessionId,
        resolvedProfile,
      );
      // The base command is built FIRST and recorded in the manifest; the system
      // prompt is then derived FROM that manifest and appended to produce the
      // line the PTY actually runs. See `withAgentPrompt` for why this is two
      // steps and not one — it unties an apparent circular dependency.
      const baseCommand = buildAgentCommand(launch, this.env);
      const manifestPath = this.manifestPathFor(sessionId);
      const manifest = composeManifest({
        sessionId,
        request,
        context,
        launch,
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
      const command = withAgentPrompt(
        baseCommand,
        `${envelope.system}\n\n${envelope.task}`,
        launch,
        this.env,
      );

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
