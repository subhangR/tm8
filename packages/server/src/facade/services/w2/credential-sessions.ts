/**
 * The credential-session lifecycle: start, finish, and the node's own sweep.
 *
 * WHY THIS SERVICE TAKES TYPED INPUTS AND NOT A `RequestContext`. The contract
 * and catalog operations are PR3's; inventing their request shapes here would
 * mean two lanes authoring the same types. The thin registration adapter that
 * turns a `RequestContext` into these inputs is one function and belongs with
 * the operations it registers.
 *
 * ---------------------------------------------------------------------------
 * THE SWEEP, AND WHY IT IS NOT THE ONE R5 ORDERED (architect ruling R10)
 * ---------------------------------------------------------------------------
 *
 * R5 said: on boot and on interval, sweep ANY `credential_sessions` row that is
 * unfinished and expired-or-PTY-less. That cannot be run by any role this
 * server has. Measured, and each leg is independently checkable:
 *
 *   * `credential_sessions`'s only policy is `account_id =
 *     internal.current_account_id()` — self-select, with the absence of a
 *     node-admin bypass called out in 083's header as DELIBERATE;
 *   * the node's background identity is the loopback owner
 *     (`execution-handlers.ts`, `reconcileGhosts`), which resolves to exactly
 *     ONE account and is therefore blind to every other member's rows;
 *   * `node_id` is NULL by construction (D5), so there is no node-scoped
 *     predicate to sweep on either.
 *
 * A cross-account sweep would need a `security definer` function (a migration),
 * a node-admin policy (083 forbids it on purpose), or `tm8_graph_owner` at
 * runtime (no such path exists). R10 replaced the mechanism with three parts,
 * all implemented here:
 *
 *   1. THE INTERVAL SWEEP runs off this node's own in-memory registry — the
 *      sessions THIS process started, whose claims it still holds. No
 *      cross-account read is needed because a live PTY implies a live process
 *      that remembers who owns it.
 *   2. THE SELF-SCOPED RECLAIM runs at `start`, under the CALLING member's own
 *      claims, and finishes their own stale rows. RLS-legal, and it heals the
 *      only person the one-live-per-pair index can block: you, against your own
 *      row from a previous boot.
 *   3. THE CAP PREDICATE was amended in 083 to count from
 *      `credential_sessions.finished_at`/`expires_at` rather than
 *      `work_sessions.status`, so a crash-orphan ages out of the cap on its own.
 *      Without that, two crashes would have blocked every login on the node
 *      permanently — nothing writes a credential session's status after its
 *      process dies.
 *
 * The residual, stated rather than discovered: an absent member's row stays
 * unfinished and its `work_sessions.status` reads `running` forever. It blocks
 * only that member, heals when they return, and is why READ MODELS MUST DERIVE
 * CONNECTION STATE FROM `credential_sessions.finished_at`/`expires_at` AND
 * NEVER FROM THE CREDENTIAL WORK SESSION'S `status`.
 */
import { CollabError } from '@tm8/contract';
import type { CredentialProvider, CredentialSessionLauncher, Logger } from '@tm8/execution';
import { CREDENTIAL_LOGIN_COMMANDS, CREDENTIAL_PROVIDERS } from '@tm8/execution';

import type { Db, DbClaims } from '../../../db/types.js';
import { ensureCredentialHome } from '../../../credentials/agent-credential-home.js';
import {
  runCredentialProbe,
  type CommandRunner,
  type ProbeResult,
} from './credential-probe.js';

/**
 * The credential cap is ITS OWN, and disjoint from the agent cap by
 * construction (083 §3). Two separate counts mean a node full of agents can
 * still admit a login — otherwise a member could never connect an account on a
 * busy node — and a stuck login can never starve a spawn.
 */
export const CREDENTIAL_SESSION_CAP_ENV = 'TM8_CREDENTIAL_SESSION_CAP';
export const DEFAULT_CREDENTIAL_SESSION_CAP = 2;
/** Clamped again in SQL to [60, 1800]; this is only the default. */
export const DEFAULT_CREDENTIAL_TTL_SECONDS = 900;
/** How often the registry sweep runs. */
export const DEFAULT_SWEEP_INTERVAL_MS = 30_000;

export function resolveCredentialSessionCap(env: NodeJS.ProcessEnv): number {
  const raw = env[CREDENTIAL_SESSION_CAP_ENV]?.trim();
  if (!raw) return DEFAULT_CREDENTIAL_SESSION_CAP;
  const parsed = Number.parseInt(raw, 10);
  // A malformed value falls back to the default rather than to zero or NaN.
  // Zero would refuse every login with a cap error, which reads as a bug in the
  // feature rather than as a typo in a unit file.
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_CREDENTIAL_SESSION_CAP;
  return parsed;
}

function assertKnownProvider(provider: string): asserts provider is CredentialProvider {
  if (!(CREDENTIAL_PROVIDERS as readonly string[]).includes(provider)) {
    throw new CollabError('invalid_input', `unsupported credential provider: ${provider}`);
  }
}

/** Who is asking. Both fields are SERVER-RESOLVED; neither is client-asserted. */
export interface CredentialPrincipal {
  /** Includes `authKind`, which 083's RPCs require and which fails closed. */
  claims: DbClaims;
  /** The auth principal's identity row id — the credential home's directory. */
  identityId: string;
}

export interface StartCredentialSessionInput {
  spaceId: string;
  provider: string;
  cols?: number;
  rows?: number;
}

export interface StartedCredentialSession {
  workSessionId: string;
  spaceId: string;
  provider: CredentialProvider;
  expiresAt: string;
  /** The exact table entry that was launched. Recorded, never accepted. */
  command: string;
}

export interface FinishedCredentialSession {
  workSessionId: string;
  provider: CredentialProvider;
  probe: ProbeResult;
  /** True when the metadata row was written. False for a stale probe. */
  stored: boolean;
  terminated: boolean;
}

/** What this node remembers about a login terminal it started. */
interface RegistryEntry {
  workSessionId: string;
  provider: CredentialProvider;
  expiresAtMs: number;
  homeDir: string;
  configDir: string;
  env: Record<string, string>;
  /** Held so the sweep can finish the row AS ITS OWNER, not as the node. */
  principal: CredentialPrincipal;
}

interface StartRpcResult {
  workSessionId: string;
  spaceId: string;
  provider: string;
  expiresAt: string;
}

interface OpenSessionRow {
  work_session_id: string;
  provider: string;
  expires_at: Date | string;
}

export interface W2CredentialSessionsServiceOptions {
  db: Db;
  launcher: CredentialSessionLauncher;
  /** Node data root; the credential home hangs off it. */
  dataDir: string;
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
  sweepIntervalMs?: number;
  probeRunner?: CommandRunner;
  /** Injected clock, so TTL behaviour is testable without waiting. */
  now?: () => number;
  /**
   * Persist a GitHub credential into 079's string-shaped table.
   *
   * OPTIONAL, AND ABSENT ON THIS BRANCH ON PURPOSE. The storage split is by
   * credential SHAPE: file-shaped credentials (anthropic, openai) are indexed
   * by `account_agent_credentials`, while a GitHub token is a STRING and
   * belongs in the already-shipped `account_git_credentials` — which lives in
   * migration 079 on the deployed staging line and is reachable from no local
   * git object. Rather than duplicate that table or pretend to write to one
   * that does not exist here, the seam is injected. When 079 reaches this line,
   * wire it; until then a GitHub login is verified and reported, and the
   * `stored` flag says plainly that nothing was persisted.
   */
  storeGitCredential?: (input: {
    claims: DbClaims;
    login: string;
    provider: 'github';
  }) => Promise<void>;
}

export class W2CredentialSessionsService {
  private readonly db: Db;
  private readonly launcher: CredentialSessionLauncher;
  private readonly dataDir: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly logger: Logger | undefined;
  private readonly sweepIntervalMs: number;
  private readonly probeRunner: CommandRunner | undefined;
  private readonly now: () => number;
  private readonly storeGitCredential:
    | W2CredentialSessionsServiceOptions['storeGitCredential']
    | undefined;

  /** This node's live login terminals. See the sweep discussion in the header. */
  private readonly registry = new Map<string, RegistryEntry>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: W2CredentialSessionsServiceOptions) {
    this.db = options.db;
    this.launcher = options.launcher;
    this.dataDir = options.dataDir;
    this.env = options.env ?? process.env;
    this.logger = options.logger;
    this.sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    this.probeRunner = options.probeRunner;
    this.now = options.now ?? (() => Date.now());
    this.storeGitCredential = options.storeGitCredential;
  }

  // -------------------------------------------------------------------------
  // start
  // -------------------------------------------------------------------------

  /**
   * Open a login terminal for `provider`.
   *
   * ORDER IS LOAD-BEARING and the reasons differ at each step:
   *
   *  1. VALIDATE the provider against the fixed list, before anything touches
   *     the filesystem — the provider names a directory.
   *  2. RECLAIM this member's own stale rows, before the RPC, because the
   *     one-live-per-pair index would otherwise refuse a member who is blocked
   *     only by their own crash-orphan.
   *  3. ENSURE THE HOME, before the RPC, so that a permissions failure refuses
   *     the request instead of leaving a `credential_sessions` row pointing at
   *     a terminal that never started.
   *  4. THE RPC, which derives the account itself, meters the cap, clamps the
   *     TTL and mints the work session with `session_kind='credential'`,
   *     `share_mode='none'` and NO `node_id`.
   *  5. THE PTY last, because it is the only irreversible step.
   *
   * D2 IS ENFORCED IN SQL AND NOT RE-DERIVED HERE. `start_credential_session`
   * builds its envelope with `internal.current_member_id(p_space_id)` — the
   * CALLER'S own membership — and never `internal.resolve_actor`, which exists
   * so a caller can act AS a teammate and would make a login terminal belong to
   * whoever a persona resolves to. This service must therefore NOT pass an
   * `actorId`: doing so is the one way TypeScript could reintroduce the
   * inversion the SQL closed.
   */
  async start(
    input: StartCredentialSessionInput,
    principal: CredentialPrincipal,
  ): Promise<StartedCredentialSession> {
    const { provider } = input;
    assertKnownProvider(provider);

    // D2. Stated as an assertion rather than a comment, because "we simply do
    // not set it" is invisible to a reviewer and to a future edit.
    if (principal.claims.actorId) {
      throw new CollabError(
        'forbidden',
        'a credential session is never opened on another actor’s behalf (finding D2)',
      );
    }

    await this.reclaimOwnStaleSessions(principal);

    const { homeDir, configDir } = await ensureCredentialHome(
      this.dataDir,
      principal.identityId,
      provider,
    );

    const started = await this.db.rpc<StartRpcResult>(
      principal.claims,
      'start_credential_session',
      [
        input.spaceId,
        provider,
        DEFAULT_CREDENTIAL_TTL_SECONDS,
        resolveCredentialSessionCap(this.env),
      ],
    );

    try {
      const launched = this.launcher.launch({
        sessionId: started.workSessionId,
        provider,
        homeDir,
        configDir,
        ...(input.cols ? { cols: input.cols } : {}),
        ...(input.rows ? { rows: input.rows } : {}),
      });

      this.registry.set(started.workSessionId, {
        workSessionId: started.workSessionId,
        provider,
        expiresAtMs: new Date(started.expiresAt).getTime(),
        homeDir,
        configDir,
        env: launched.env,
        principal,
      });

      return {
        workSessionId: started.workSessionId,
        spaceId: started.spaceId,
        provider,
        expiresAt: started.expiresAt,
        command: launched.command,
      };
    } catch (error) {
      // The row exists and holds the one-live-per-pair slot. Releasing it is
      // what stops a failed launch from locking the member out of retrying.
      // Best-effort: the launch error is the one that explains what happened
      // and must not be masked by a cleanup failure.
      await this.finishRow(principal, started.workSessionId).catch(() => undefined);
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // finish
  // -------------------------------------------------------------------------

  /**
   * Close a login terminal and record what the PROBE established.
   *
   * NOTHING HERE READS AN EXIT CODE, and that is the point. A member who opens
   * the terminal, reads the device code and closes the tab exits 0 with nothing
   * captured — identical, at the process level, to one who completed the flow.
   * The probe runs in the SAME environment the terminal ran in, because the
   * credential's location is a property of that environment
   * (`CLAUDE_CONFIG_DIR` / `CODEX_HOME` / `GH_CONFIG_DIR`) and a probe run
   * anywhere else would read the NODE's credential and cheerfully confirm it.
   */
  async finish(
    input: { workSessionId: string },
    principal: CredentialPrincipal,
  ): Promise<FinishedCredentialSession> {
    const entry = this.registry.get(input.workSessionId);
    if (!entry) {
      throw new CollabError(
        'not_found',
        'no live credential session on this node for that work session',
      );
    }

    // Terminate BEFORE probing. The vendor CLIs write their credential file on
    // completion and the process may still hold a partially written one; and a
    // live `claude`/`gh` holding the config directory can race the probe's read.
    const outcome = this.launcher.terminate(entry.workSessionId);
    const terminated = outcome === 'killed';

    const probe = await runCredentialProbe({
      provider: entry.provider,
      env: entry.env,
      cwd: entry.homeDir,
      ...(this.probeRunner ? { run: this.probeRunner } : {}),
    });

    const stored = await this.persistProbe(principal, probe);

    await this.finishRow(principal, entry.workSessionId);
    this.registry.delete(entry.workSessionId);

    return { workSessionId: entry.workSessionId, provider: entry.provider, probe, stored, terminated };
  }

  /**
   * Write the metadata row, but ONLY on a positive probe.
   *
   * A `stale` probe writes nothing at all rather than writing `status='stale'`.
   * The difference matters: an unwritten row means "not connected", while a
   * `stale` row means "connected once, cannot confirm now" — and claiming the
   * second on the strength of a login nobody completed would put a Connected
   * card in front of a member who has no credential.
   */
  private async persistProbe(
    principal: CredentialPrincipal,
    probe: ProbeResult,
  ): Promise<boolean> {
    if (!probe.connected) return false;

    if (probe.provider === 'github') {
      // The storage split by SHAPE — see `storeGitCredential`'s doc. A GitHub
      // token is string-shaped and belongs in 079's already-shipped table, not
      // in `account_agent_credentials`, whose CHECK admits only the two
      // file-shaped providers (R6).
      if (!this.storeGitCredential || !probe.login) return false;
      await this.storeGitCredential({
        claims: principal.claims,
        login: probe.login,
        provider: 'github',
      });
      return true;
    }

    await this.db.rpc(principal.claims, 'set_account_agent_credential', [
      probe.provider,
      probe.login,
      probe.authMethod,
      probe.status,
    ]);
    return true;
  }

  // -------------------------------------------------------------------------
  // the sweep (R10 element 1) and the reclaim (R10 element 2)
  // -------------------------------------------------------------------------

  /** Arm the interval sweep. Idempotent. */
  startSweep(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => {
      void this.sweepNow().catch((error: unknown) => {
        this.logger?.warn?.('credential sweep failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, this.sweepIntervalMs);
    // Never hold the process open for a sweep. A node that is shutting down
    // has nothing to sweep — its PTYs die with it.
    this.sweepTimer.unref?.();
  }

  stopSweep(): void {
    if (!this.sweepTimer) return;
    clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }

  /**
   * Finish every registry entry that is expired or has lost its PTY.
   *
   * Both predicates, not just expiry: a terminal whose process died on its own
   * (the member typed `exit`, or the CLI crashed) is finished immediately
   * rather than held until its TTL, so the one-live-per-pair slot comes back at
   * once and Connect works on the second click.
   */
  async sweepNow(): Promise<number> {
    const now = this.now();
    let swept = 0;
    for (const entry of [...this.registry.values()]) {
      const expired = entry.expiresAtMs <= now;
      const gone = !this.launcher.hasLiveTerminal(entry.workSessionId);
      if (!expired && !gone) continue;

      // Terminate first, so `finished_at` is never stamped on a row whose PTY
      // is still streaming. R7's single lifecycle writer — the PTY-exit path —
      // then writes `work_sessions.status` on its own.
      if (expired) this.launcher.terminate(entry.workSessionId);

      try {
        await this.finishRow(entry.principal, entry.workSessionId);
      } catch (error) {
        // Best-effort by design. A row this node cannot finish is picked up by
        // the member's own reclaim next time they connect, and the amended cap
        // predicate ages it out regardless.
        this.logger?.warn?.('credential sweep could not finish a row', {
          workSessionId: entry.workSessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      this.registry.delete(entry.workSessionId);
      swept += 1;
    }
    return swept;
  }

  /**
   * Finish the CALLING member's own unfinished rows that are expired or have no
   * live PTY on this node.
   *
   * Self-scoped, so it reads only rows RLS already lets this member see — no
   * privilege widening, no `security definer` helper, no migration. This is the
   * boot sweep's replacement: the case a boot sweep actually had to fix is a
   * member blocked by their OWN orphan, and that member is by definition
   * present when it matters.
   */
  private async reclaimOwnStaleSessions(principal: CredentialPrincipal): Promise<number> {
    const rows = await this.db.query<OpenSessionRow>(
      principal.claims,
      `select work_session_id, provider, expires_at
         from public.credential_sessions
        where finished_at is null`,
    );

    const now = this.now();
    let reclaimed = 0;
    for (const row of rows) {
      const expiresAtMs = new Date(row.expires_at).getTime();
      const live = this.launcher.hasLiveTerminal(row.work_session_id);
      // A live, unexpired terminal is someone's session in progress — most
      // likely this member's other tab. It is left alone and the RPC's unique
      // index refuses the second start, which is the correct answer.
      if (live && expiresAtMs > now) continue;
      if (live) this.launcher.terminate(row.work_session_id);

      await this.finishRow(principal, row.work_session_id);
      this.registry.delete(row.work_session_id);
      reclaimed += 1;
    }
    return reclaimed;
  }

  /**
   * `finish_credential_session` — it stamps `finished_at` AND NOTHING ELSE (R7).
   *
   * It deliberately does not write `work_sessions.status`: session lifecycle has
   * exactly one writer, the PTY-exit path. An RPC-written `'exited'` would be
   * the same false-exited lie `SpawnService.terminate` refuses to tell when a
   * kill fails with EPERM.
   */
  private async finishRow(principal: CredentialPrincipal, workSessionId: string): Promise<void> {
    await this.db.rpc(principal.claims, 'finish_credential_session', [workSessionId]);
  }

  /** The command that WOULD run for `provider`. Exposed for the settings UI. */
  static commandFor(provider: CredentialProvider): string {
    return CREDENTIAL_LOGIN_COMMANDS[provider];
  }

  /** Test/diagnostic view of what this node believes it is running. */
  liveSessionIds(): string[] {
    return [...this.registry.keys()];
  }
}
