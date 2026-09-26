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
import {
  credentialConfigDir,
  credentialHomeDir,
  ensureCredentialHome,
} from '../../../credentials/agent-credential-home.js';
import {
  assertSpaceLoginProvider,
  SpaceLoginHomes,
  type SpaceLoginHomeKey,
} from '../../../credentials/space-credential-home.js';
import {
  DbSpaceCredentialStore,
  type SpaceCredential,
  type SpaceCredentialLoginFinish,
} from '../../../credentials/space-credential-store.js';
import {
  captureGitHubToken,
  credentialCliInstallMessage,
  measureCredentialBinary,
  runCredentialProbe,
  type CredentialBinaryResolver,
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
  /**
   * A login into a SPACE credential (206, SC-4) instead of the member's own:
   * `label` opens a new pending credential (any member, D1), `credentialId`
   * logs in again onto an existing one (its creator or a space admin, M4).
   * Exactly one of the two.
   */
  spaceCredential?: { label?: string; credentialId?: string };
}

export interface StartedCredentialSession {
  workSessionId: string;
  spaceId: string;
  provider: CredentialProvider;
  expiresAt: string;
  /** The exact table entry that was launched. Recorded, never accepted. */
  command: string;
  /** A space login's credential: the new pending row, or the one logged into. */
  spaceCredential?: SpaceCredential;
}

export interface FinishedCredentialSession {
  workSessionId: string;
  provider: CredentialProvider;
  probe: ProbeResult;
  /** True when the metadata row was written. False for any non-positive probe. */
  stored: boolean;
  terminated: boolean;
  /**
   * A space login's credential AS THE PROBED FINISH LEFT IT (I6): the row
   * `finish_space_credential_login` returned, never a reading of the files.
   */
  spaceCredential?: SpaceCredential;
}

/** What one pass of `closeSession` established. */
interface CloseOutcome {
  /**
   * The COMMITTED answer: a probe result that was also successfully recorded,
   * or null when the close cannot truthfully claim one. `failure` then says why.
   *
   * Null therefore covers a probe that threw AND a probe that succeeded but
   * could not be persisted, because the two are the same claim from the
   * member's side: nothing durable was written, and the next spawn will inject
   * nothing. Reporting the measurement alone would say "connected" about a
   * credential that reached no table — see `closeSession` for the ordering
   * that enforces this.
   */
  probe: ProbeResult | null;
  stored: boolean;
  terminated: boolean;
  /** The first error that occurred, or null. Returned, never thrown — see `closeSession`. */
  failure: unknown;
  /** A space login: the credential row the finish RPC returned. */
  spaceCredential?: SpaceCredential;
  /**
   * A space login whose PTY the host could not kill. Its row is NOT stamped
   * and its registry entry is kept, so the next sweep tries again: a row
   * stamped finished over a live terminal is what unblocks a re-login that
   * then races that terminal for the space home (A6, kill-before-stamp).
   */
  killFailed?: boolean;
}

/**
 * How a close treats the terminal. `probe` asks the vendor CLI what the
 * terminal achieved (the member's own finish, and a PTY that exited before
 * its expiry). `abandon` never probes: an expired space login is closed
 * through `finish_space_credential_login(ws, false)` and nothing else, so
 * 206's N1/B1/B2 guards and lock order stay the only write path.
 */
type CloseMode = 'probe' | 'abandon';

/** The row `reportClosedSession` reads for a session this node no longer holds. */
interface ClosedSessionRow {
  provider: string;
}

/** The persisted index row, read back when the terminal is already gone. */
interface StoredCredentialRow {
  login: string | null;
  auth_method: string | null;
  status: string;
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
  /**
   * Set for a login into a space credential. Every close of this entry then
   * goes through `finish_space_credential_login` — never 083's member finish —
   * and a probed success is promoted from the staging home into the space home.
   */
  space?: SpaceLoginHomeKey & { isNew: boolean };
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
  /** The server environment used for both the cap and login-terminal PATH. */
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
  sweepIntervalMs?: number;
  probeRunner?: CommandRunner;
  /** Test seam for binary presence; production resolves executables on PATH. */
  binaryResolver?: CredentialBinaryResolver;
  /** Injected clock, so TTL behaviour is testable without waiting. */
  now?: () => number;
  /**
   * Persist a GitHub credential into 093's string-shaped table.
   *
   * The seam stays injected because session lifecycle and encrypted storage
   * are separate responsibilities. A rolling/older composition that lacks the
   * store can still report `connected` and `stored` independently without
   * pretending persistence happened.
   */
  storeGitCredential?: (input: {
    claims: DbClaims;
    login: string;
    provider: 'github';
    token: string;
  }) => Promise<void>;
  /** 206's space-login RPCs. Defaults to the real store over `db`. */
  spaceStore?: SpaceLoginStorePort;
  /** The space login homes. Defaults to one over `dataDir`; share it with delete. */
  spaceHomes?: SpaceLoginHomes;
}

export type SpaceLoginStorePort = Pick<
  DbSpaceCredentialStore,
  'startLogin' | 'finishLogin' | 'liveSessions' | 'expirePending' | 'recordProbe' | 'read'
>;

/** What `closeSpaceLogin` did for a caller outside this service (delete). */
export type SpaceLoginCloseResult = 'closed' | 'kill_failed';

interface OwnSpaceLoginRow {
  work_session_id: string;
  space_credential_id: string;
  provider: string;
  expires_at: Date | string;
  finished_at: Date | string | null;
}

export class W2CredentialSessionsService {
  private readonly db: Db;
  private readonly launcher: CredentialSessionLauncher;
  private readonly dataDir: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly logger: Logger | undefined;
  private readonly sweepIntervalMs: number;
  private readonly probeRunner: CommandRunner | undefined;
  private readonly binaryResolver: CredentialBinaryResolver | undefined;
  private readonly now: () => number;
  private readonly storeGitCredential:
    | W2CredentialSessionsServiceOptions['storeGitCredential']
    | undefined;
  private readonly spaceStore: SpaceLoginStorePort;
  private readonly spaceHomes: SpaceLoginHomes;

  /** This node's live login terminals. See the sweep discussion in the header. */
  private readonly registry = new Map<string, RegistryEntry>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * The close that is IN FLIGHT for a work session, by id.
   *
   * Closing stopped being instantaneous once every path began probing: it
   * terminates, spawns a vendor CLI and writes two rows, so a second path can
   * now reach the same entry while the first is still awaiting. Deleting from
   * `registry` up front would lose the entry if the close then failed, so the
   * claim is held separately.
   *
   * IT HOLDS THE PROMISE AND NOT JUST THE ID, and that is the whole point.
   * A claim that only said "someone else has it" left the second caller with
   * two bad options and it took both:
   *
   *   * `finish()` fell through to the persisted row — which the in-flight
   *     close HAD NOT WRITTEN YET — and reported a login that had just
   *     succeeded as `connected: false`. The same false negative this service
   *     exists to remove, re-created one layer up by the claim that was added
   *     to make closing safe.
   *   * the start-time reclaim counted the refusal as a reclaim and walked on
   *     to `start_credential_session` with `finished_at` still null, so
   *     `credential_sessions_one_live_per_account_provider` refused the
   *     member's next Connect. Counting a close is not performing one.
   *
   * Both disappear if the second caller simply WAITS for the answer the first
   * one is already computing, which is what this map lets it do. One close
   * still happens — one terminate, one probe, one persist — and every caller
   * gets its real outcome.
   */
  private readonly closing = new Map<string, Promise<CloseOutcome>>();

  /**
   * Re-entrancy guard for the interval sweep.
   *
   * `setInterval` does not wait for an async tick, and a sweep that now runs
   * probes can comfortably outlive its own 30s period. Without this, two
   * sweeps interleave over one registry and race each other's closes.
   */
  private sweeping = false;

  constructor(options: W2CredentialSessionsServiceOptions) {
    this.db = options.db;
    this.launcher = options.launcher;
    this.dataDir = options.dataDir;
    this.env = options.env ?? process.env;
    this.logger = options.logger;
    this.sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    this.probeRunner = options.probeRunner;
    this.binaryResolver = options.binaryResolver;
    this.now = options.now ?? (() => Date.now());
    this.storeGitCredential = options.storeGitCredential;
    this.spaceStore =
      options.spaceStore ?? new DbSpaceCredentialStore({ db: options.db, dataDir: options.dataDir });
    this.spaceHomes = options.spaceHomes ?? new SpaceLoginHomes({ dataDir: options.dataDir });
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
   *  2. MEASURE BINARY PRESENCE in the PATH the login terminal will actually
   *     receive. A measured absence refuses here, before any row or PTY exists.
   *  3. RECLAIM this member's own stale rows, before the RPC, because the
   *     one-live-per-pair index would otherwise refuse a member who is blocked
   *     only by their own crash-orphan.
   *  4. ENSURE THE HOME, before the RPC, so that a permissions failure refuses
   *     the request instead of leaving a `credential_sessions` row pointing at
   *     a terminal that never started.
   *  5. THE RPC, which derives the account itself, meters the cap, clamps the
   *     TTL and mints the work session with `session_kind='credential'`,
   *     `share_mode='none'` and NO `node_id`.
   *  6. THE PTY last, because it is the only irreversible step.
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
    if (input.spaceCredential) return this.startSpace(input, input.spaceCredential, principal);
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

    await this.reclaimOwnStaleSessions(principal, provider);

    const { homeDir, configDir } = await ensureCredentialHome(
      this.dataDir,
      principal.identityId,
      provider,
    );

    let started: StartRpcResult;
    try {
      started = await this.db.rpc<StartRpcResult>(
        principal.claims,
        'start_credential_session',
        [
          input.spaceId,
          provider,
          DEFAULT_CREDENTIAL_TTL_SECONDS,
          resolveCredentialSessionCap(this.env),
        ],
      );
    } catch (error) {
      // After the same-provider supersede above, the one-live-per-pair index
      // can only fire on a race — two Connect clicks landing together. The
      // raw `duplicate key value violates unique constraint …` message is a
      // debugging artifact, not an answer; say what actually happened.
      if (error instanceof CollabError && error.code === 'invariant_violation') {
        throw new CollabError(
          'conflict',
          `a ${provider} login terminal for your account just opened elsewhere — finish or close it, then try again`,
        );
      }
      throw error;
    }

    try {
      // THE BINARY CHECK IS HERE, AFTER THE RPC, AND THAT ORDERING IS THE
      // POINT — it was written before the RPC first, and CI caught why that was
      // wrong. `start_credential_session` is where `require_human_auth_kind`
      // and `require_space_member` live, so measuring the node BEFORE it
      // answered a caller who had not yet been authorised: on a machine with no
      // agent CLIs installed, an unauthenticated probe got a 400 naming which
      // binary is missing instead of the 403 it had earned. That is a node
      // capability disclosed to someone with no standing to ask, and it also
      // made `w5/surface/sweep` environment-dependent — green on a developer
      // box with the CLIs installed, red on a runner without them. An
      // authorization answer must never depend on a fact about the node.
      //
      // The cost of moving it is one work_session row minted for a login that
      // cannot proceed, and the catch below already releases it — the same
      // best-effort path a failed launch uses, and the reason that path exists.
      // A doomed row that is immediately released is strictly cheaper than an
      // authorization answer that leaks.
      const binary = measureCredentialBinary({
        provider,
        homeDir,
        configDir,
        parentEnv: this.env,
        ...(this.binaryResolver ? { resolveBinary: this.binaryResolver } : {}),
      });
      if (binary.status === 'unavailable') {
        // `invalid_input` is this contract's caller-fixable precondition code;
        // there is no `failed_precondition` member in CommandErrorCode.
        throw new CollabError('invalid_input', credentialCliInstallMessage(provider));
      }
      if (binary.status === 'unknown') {
        throw new CollabError(
          'upstream_unavailable',
          binary.detail ?? `could not determine whether credential CLI '${binary.binary}' is installed`,
        );
      }

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
   * (a vendor override for three providers, isolated HOME for Gemini/Hermes)
   * and a probe run anywhere else would read the NODE's credential and
   * cheerfully confirm it.
   */
  async finish(
    input: { workSessionId: string },
    principal: CredentialPrincipal,
  ): Promise<FinishedCredentialSession> {
    const entry = this.registry.get(input.workSessionId);
    // The session was already closed — the sweep reached it first, or this is a
    // second click. That used to answer `not_found`, which is what made a login
    // that HAD succeeded read to the member as a login that failed. (A close
    // that is still IN FLIGHT no longer lands here: `closeSession` waits for it
    // and returns its real outcome, rather than sending this call to read a row
    // that has not been written yet.)
    if (!entry) return this.reportClosedSession(input.workSessionId, principal);
    if (entry.space) assertHumanSpaceLogin(principal.claims);

    // WHOSE TERMINAL IS THIS. The registry is keyed by work-session id alone,
    // so without this any authenticated member holding an id could terminate
    // another member's login terminal AND have its probe persisted against
    // their OWN account — `persistProbe` writes with the caller's claims, so
    // the victim's login name would land in the attacker's credential row and
    // put a Connected card in front of an account with no credential on disk.
    // `finishRow` is RLS-scoped and would refuse the last step, but the kill
    // and the probe have already happened by then.
    //
    // `not_found` rather than `forbidden`, deliberately: it is the same answer
    // an RLS-scoped lookup gives for someone else's row, so this guard does not
    // become an oracle for which work-session ids are live login terminals.
    if (entry.principal.identityId !== principal.identityId) {
      throw new CollabError(
        'not_found',
        'no live credential session on this node for that work session',
      );
    }

    const outcome = await this.closeSession(entry, principal);

    // The member is here and waiting, so unlike the background paths they get
    // the failure rather than a log line. The row is already finished and the
    // slot already released by this point, so the error costs them nothing but
    // the truth: retrying Connect works.
    if (!outcome.probe) {
      throw outcome.failure instanceof Error
        ? outcome.failure
        : new CollabError('upstream_unavailable', String(outcome.failure));
    }

    return {
      workSessionId: entry.workSessionId,
      provider: entry.provider,
      probe: outcome.probe,
      stored: outcome.stored,
      terminated: outcome.terminated,
      ...(outcome.spaceCredential ? { spaceCredential: outcome.spaceCredential } : {}),
    };
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
    entry: RegistryEntry,
  ): Promise<boolean> {
    if (!probe.connected) return false;

    if (probe.provider === 'github') {
      // The storage split by SHAPE — see `storeGitCredential`'s doc. A GitHub
      // token is string-shaped and belongs in 093's encrypted table, not
      // in `account_agent_credentials`, whose CHECK admits the four
      // file-shaped providers (R6, widened by 123).
      if (!this.storeGitCredential || !probe.login) return false;
      const token = await captureGitHubToken({
        env: entry.env,
        cwd: entry.homeDir,
        ...(this.probeRunner ? { run: this.probeRunner } : {}),
      });
      await this.storeGitCredential({
        claims: principal.claims,
        login: probe.login,
        provider: 'github',
        token,
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
  // the one close path
  // -------------------------------------------------------------------------

  /**
   * TERMINATE, PROBE, PERSIST, STAMP — the single way a credential session ends.
   *
   * Before this existed there were three ways to close one and only `finish()`
   * — the path the member's own click reaches — probed and persisted. The
   * sweep and the reclaim called `finishRow` alone. So a login that SUCCEEDED
   * and then exited, which is what every one of these CLIs does on success,
   * was recorded as closed with no credential row written: the credential sat
   * valid on disk while nothing referenced it, no config dir was injected at
   * the member's next spawn, and the settings card still offered to Connect.
   *
   * The sweep could never have told those apart by watching the process. A
   * successful `claude auth login` exits 0 and so does an abandoned one. That
   * is exactly why `finish()` probes instead of reading an exit code, and
   * exactly why every other path has to probe too.
   *
   * THIS NEVER THROWS. The close must complete even when the probe or the
   * persist fails, because leaving `finished_at` null holds the
   * one-live-per-pair slot and locks the member out of retrying — the lockout
   * R10 added the sweep to prevent. The failure is RETURNED instead, so
   * `finish()` can surface it to the member while the background paths log it.
   *
   * IT ALWAYS RETURNS AN OUTCOME, including to a caller that arrived second.
   * It used to return null for "someone else has it", which left every caller
   * guessing at an answer that was already being computed a few milliseconds
   * away — and both of them guessed wrong in a way the member could see. See
   * `closing`. A second caller now awaits the first close and receives its
   * real result; exactly one terminate, probe and persist ever happen.
   */
  private closeSession(
    entry: RegistryEntry,
    principal: CredentialPrincipal,
    mode: CloseMode = 'probe',
  ): Promise<CloseOutcome> {
    const inFlight = this.closing.get(entry.workSessionId);
    if (inFlight) return inFlight;
    // The claim is registered from the promise, not from inside `runClose`,
    // so the entry cannot be cleared before it is set.
    const run = entry.space
      ? this.runSpaceClose(entry, principal, mode)
      : this.runClose(entry, principal);
    const claim = run.finally(() => {
      this.closing.delete(entry.workSessionId);
    });
    this.closing.set(entry.workSessionId, claim);
    return claim;
  }

  /** The body of one close. Never called twice for a session — see `closeSession`. */
  private async runClose(
    entry: RegistryEntry,
    principal: CredentialPrincipal,
  ): Promise<CloseOutcome> {
    // Terminate BEFORE probing. The vendor CLIs write their credential file
    // on completion and the process may still hold a partially written one;
    // and a live `claude`/`gh` holding the config directory can race the
    // probe's read. `kill` answers 'not_found' rather than throwing for a
    // PTY that already died, so this is safe on the sweep's gone path too.
    const terminated = this.launcher.terminate(entry.workSessionId) === 'killed';

    let probe: ProbeResult | null = null;
    let stored = false;
    let failure: unknown = null;

    try {
      const measured = await runCredentialProbe({
        provider: entry.provider,
        env: entry.env,
        cwd: entry.homeDir,
        ...(this.probeRunner ? { run: this.probeRunner } : {}),
        ...(this.binaryResolver ? { resolveBinary: this.binaryResolver } : {}),
      });
      stored = await this.persistProbe(principal, measured, entry);
      // THE MEASUREMENT IS COMMITTED ONLY ONCE IT HAS BEEN RECORDED, and the
      // order of these two lines is the whole guarantee. Assigning `probe`
      // before `persistProbe` ran left `outcome.probe` non-null on a persist
      // that had just thrown, so `finish()`'s `if (!outcome.probe)` guard could
      // never fire: the member was handed a 200 saying `connected: true,
      // stored: false` for a credential that reached no table, and their next
      // agent spawned unauthenticated anyway. A probe nobody could record is
      // not a connection to report — it is the failure, and `failure` below is
      // what the caller then sees.
      probe = measured;
    } catch (error) {
      failure = error;
    }

    try {
      await this.finishRow(principal, entry.workSessionId);
    } catch (error) {
      // Keep the probe's failure if there was one: it explains the outcome
      // the member cares about, where this one only explains bookkeeping.
      failure ??= error;
    } finally {
      this.registry.delete(entry.workSessionId);
    }

    return { probe, stored, terminated, failure };
  }

  /**
   * Report a session this node no longer holds, from what was PERSISTED.
   *
   * A member's `finish()` can legitimately arrive after the session is already
   * closed — the sweep got there first, or they clicked twice. Answering
   * `not_found` is what made a successful login look like a failed one, so the
   * persisted row is consulted rather than guessed at.
   *
   * WHAT THIS REPORTS IS NARROWER THAN A PROBE, deliberately. It says a
   * credential row EXISTS, not that the vendor would accept it this second,
   * and `status` is read off the row rather than assumed `active` so a row
   * written as stale is never upgraded on the way out. `detail` says which
   * kind of answer this is, because "connected, from the stored record" and
   * "connected, just measured" are not the same claim.
   *
   * AND IT DOES NOT SAY WHICH LOGIN TERMINAL WROTE THE ROW, because it cannot
   * know. Neither credential table records the session that produced it, so
   * the lookup is by `(account, provider)` and a member who connected last
   * week and then abandoned a terminal today gets last week's row back. The
   * detail used to read "recorded by an earlier close of this login terminal",
   * which attributed it to the terminal being closed — a provenance claim with
   * no column behind it. It now reports what the row says and says the close
   * did not measure it, which is the whole of what is actually known.
   */
  private async reportClosedSession(
    workSessionId: string,
    principal: CredentialPrincipal,
  ): Promise<FinishedCredentialSession> {
    const sessions = await this.db.query<ClosedSessionRow>(
      principal.claims,
      // A space login's row is not a member credential session (A3b): read
      // without this filter, its provider sent a space login to the member's
      // own `account_agent_credentials` row and reported THAT as its outcome.
      `select provider
         from public.credential_sessions
        where work_session_id = $1
          and space_credential_id is null`,
      [workSessionId],
    );
    const session = sessions[0];
    // No member row: a space login's, or (RLS scopes both to the caller's own
    // rows) "never existed, or not yours" — `not_found`, answered there.
    if (!session) return this.reportClosedSpaceSession(workSessionId, principal);

    const provider = session.provider as CredentialProvider;
    const probe = await this.readStoredCredential(provider, principal);
    return { workSessionId, provider, probe, stored: probe.connected, terminated: false };
  }

  /**
   * The persisted answer for one provider, shaped as a `ProbeResult`.
   *
   * The two credential tables are split by SHAPE, not by accident (R6/093), so
   * this reads whichever one holds the provider: GitHub's string-shaped token
   * lives in `account_git_credentials`, the four file-shaped providers in
   * `account_agent_credentials`. Reading only the second would report every
   * successful GitHub connect as not connected.
   */
  private async readStoredCredential(
    provider: CredentialProvider,
    principal: CredentialPrincipal,
  ): Promise<ProbeResult> {
    const disconnected: ProbeResult = {
      provider,
      connected: false,
      status: 'active',
      login: null,
      authMethod: null,
      detail: 'the login terminal was already closed and no credential was recorded',
    };

    if (provider === 'github') {
      const rows = await this.db.query<{ login: string }>(
        principal.claims,
        `select login from public.account_git_credentials where provider = 'github' limit 1`,
      );
      const row = rows[0];
      if (!row) return disconnected;
      return {
        provider,
        connected: true,
        // The measurement is confident — a row is there or it is not. This is
        // not a claim about the token's freshness; 093's table has no status
        // column to make one from.
        status: 'active',
        login: row.login,
        // NULL, not 'oauth'. `account_git_credentials` stores an account, a
        // provider, a login and a sealed token — and nothing that records how
        // the member authenticated (093). 'oauth' was invented at this line
        // and would have been displayed to the member as though measured.
        authMethod: null,
        detail: `a stored github credential for ${row.login} exists; this close did not measure it`,
      };
    }

    const rows = await this.db.query<StoredCredentialRow>(
      principal.claims,
      `select login, auth_method, status
         from public.account_agent_credentials
        where provider = $1
        limit 1`,
      [provider],
    );
    const row = rows[0];
    if (!row) return disconnected;
    // Only an `active` row is a connection. A `stale` or `revoked` row is
    // exactly what `DbAgentCredentialHome.resolve` refuses to inject, and
    // calling it connected here would put a Connected card in front of a
    // member whose next agent will start unauthenticated.
    const connected = row.status === 'active';
    return {
      provider,
      connected,
      // `ProbeResult.status` has three members and the column has three
      // different ones, so a 'revoked' row has to land somewhere. It lands on
      // `stale` — the honest "cannot confirm" — and the row's OWN value goes
      // into `detail` verbatim rather than being quietly rewritten, so
      // 'revoked' is still readable by whoever needs to tell the two apart.
      status: connected ? 'active' : 'stale',
      login: row.login,
      authMethod: row.auth_method,
      detail: `the stored ${provider} credential is recorded as '${row.status}'; this close did not measure it`,
    };
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
   * Close every registry entry that is expired or has lost its PTY.
   *
   * Both predicates, not just expiry: a terminal whose process died on its own
   * is closed immediately rather than held until its TTL, so the
   * one-live-per-pair slot comes back at once and Connect works on the second
   * click.
   *
   * THE `gone` BRANCH IS THE SUCCESS PATH, which is the whole reason this now
   * goes through `closeSession`. The original comment here read "the member
   * typed `exit`, or the CLI crashed" — but the commonest way a login terminal
   * loses its PTY is the member COMPLETING the login, because every one of
   * these CLIs exits when it is done. Finishing the row without probing threw
   * that success away.
   */
  async sweepNow(): Promise<number> {
    // A tick that is still running owns the registry; a second one would race
    // it entry-for-entry now that closing is asynchronous.
    if (this.sweeping) return 0;
    this.sweeping = true;
    try {
      const now = this.now();
      let swept = 0;
      // `expire_pending_space_credentials` must be called by a human (206);
      // the node has no such identity, so it borrows the claims of a space
      // login it just closed — the one moment a pending row may have aged out.
      let spaceClaims: DbClaims | null = null;
      for (const entry of [...this.registry.values()]) {
        const expired = entry.expiresAtMs <= now;
        const gone = !this.launcher.hasLiveTerminal(entry.workSessionId);
        if (!expired && !gone) continue;

        // `closeSession` terminates first either way, so `finished_at` is
        // never stamped on a row whose PTY is still streaming. R7's single
        // lifecycle writer — the PTY-exit path — still writes
        // `work_sessions.status` on its own.
        // If another path claimed it between the snapshot and here, this awaits
        // THAT close rather than skipping the entry, so the tick does not
        // return while a session it is responsible for is still half-closed.
        // A SPACE login past its expiry is ABANDONED, never probed: the sweep
        // closes its row only through `finish_space_credential_login(ws,
        // false)`, after the kill (acceptance 1 and 2; A10). One that exited
        // before its expiry is the success path and is probed, as above.
        const outcome = await this.closeSession(
          entry,
          entry.principal,
          entry.space && expired ? 'abandon' : 'probe',
        );
        if (entry.space) spaceClaims ??= entry.principal.claims;

        if (outcome.failure) {
          // Best-effort by design, and `closeSession` has already stamped the
          // row and freed the slot. A credential that failed to persist is
          // re-probed the next time the member connects.
          this.logger?.warn?.('credential sweep could not close a session cleanly', {
            workSessionId: entry.workSessionId,
            provider: entry.provider,
            error:
              outcome.failure instanceof Error
                ? outcome.failure.message
                : String(outcome.failure),
          });
        }
        swept += 1;
      }
      if (spaceClaims) await this.expirePendingQuietly(spaceClaims);
      return swept;
    } finally {
      this.sweeping = false;
    }
  }

  /**
   * Finish the CALLING member's own unfinished rows that are expired, have no
   * live PTY on this node, or belong to the provider the member is about to
   * start again.
   *
   * Self-scoped, so it reads only rows RLS already lets this member see — no
   * privilege widening, no `security definer` helper, no migration. This is the
   * boot sweep's replacement: the case a boot sweep actually had to fix is a
   * member blocked by their OWN orphan, and that member is by definition
   * present when it matters.
   *
   * THIS NOW RUNS A VENDOR CLI ON THE START PATH, WHICH IT DID NOT BEFORE, and
   * that was questioned in review. It stays, and here is the accounting.
   *
   * It cannot be dropped. The registry-entry branch below exists precisely
   * because the member may have COMPLETED the login in the tab they are
   * superseding — every one of these CLIs exits on success, so the tab they
   * are giving up on is more often than not the one that worked. Reverting
   * this branch to `finishRow` re-creates the root-cause bug of this whole
   * change on the one path where the member is watching.
   *
   * What it can cost is bounded, on each axis, by something already in the
   * code rather than by hope:
   *
   *   * IT CANNOT FAIL THE START. `closeSession` returns its failures instead
   *     of throwing, and the branch below logs them. A broken or missing
   *     vendor CLI slows a Connect; it never refuses one.
   *   * IT CANNOT HANG THE START. `runCredentialProbe` spawns with
   *     `PROBE_TIMEOUT_MS` (20s), so the delay is bounded by the probe module,
   *     not by the vendor's willingness to exit.
   *   * IT CANNOT FAN OUT. Only rows this node has a registry entry for are
   *     probed, and the credential cap (default 2) bounds how many of those a
   *     member can have. The no-entry branch below still stamps and moves on.
   *
   * The alternative — probing off the request, after answering — was
   * considered and rejected: the reclaim's whole purpose is to free the index
   * slot BEFORE the RPC three lines later, so a close that has not finished is
   * a close that has not helped.
   *
   * THE SAME-PROVIDER SUPERSEDE (measured on utho-prod 2026-08-09): a member
   * opened the Anthropic login terminal, abandoned the tab, and every retry
   * for the next fifteen minutes died on
   * `credential_sessions_one_live_per_account_provider` — a raw 23505 in the
   * settings UI. A live, unexpired terminal for a DIFFERENT provider is left
   * alone (it does not contend for this start's index slot anyway). But the
   * member clicking Connect again for the SAME provider is the authority to
   * retire their own previous login terminal: only one login flow per
   * (account, provider) can be real, and the newer request is it.
   */
  private async reclaimOwnStaleSessions(
    principal: CredentialPrincipal,
    startingProvider: CredentialProvider,
  ): Promise<number> {
    const rows = await this.db.query<OpenSessionRow>(
      principal.claims,
      // Only the member's OWN logins: a login into a space credential (206)
      // has its own one-live index and is not superseded by this Connect.
      `select work_session_id, provider, expires_at
         from public.credential_sessions
        where finished_at is null and space_credential_id is null`,
    );

    const now = this.now();
    let reclaimed = 0;
    for (const row of rows) {
      const expiresAtMs = new Date(row.expires_at).getTime();
      const live = this.launcher.hasLiveTerminal(row.work_session_id);
      const supersede = row.provider === startingProvider;
      // A live, unexpired terminal for ANOTHER provider is someone's session
      // in progress — most likely this member's other tab, and it holds a
      // different index slot. It is left alone.
      if (live && expiresAtMs > now && !supersede) continue;

      // When this node still remembers the terminal, close it PROPERLY — the
      // member may have completed the login in the tab they are superseding,
      // and the entry carries the env the probe needs to find out. Without
      // this, clicking Connect a second time destroys the credential the first
      // click had already obtained.
      const entry = this.registry.get(row.work_session_id);
      if (entry) {
        // Awaited, and it is `start()` that depends on the wait. A close that
        // is in flight has not stamped `finished_at` yet, so returning here
        // without it sends the RPC below into
        // `credential_sessions_one_live_per_account_provider` and refuses the
        // member's Connect — a lockout manufactured by the close path that
        // exists to end lockouts. Counting a close is not performing one.
        const outcome = await this.closeSession(entry, principal);
        if (outcome.failure) {
          this.logger?.warn?.('credential reclaim could not close a session cleanly', {
            workSessionId: row.work_session_id,
            error:
              outcome.failure instanceof Error
                ? outcome.failure.message
                : String(outcome.failure),
          });
        }
        reclaimed += 1;
        continue;
      }

      // No registry entry: a row left by a previous process, or by another
      // node. There is no env to probe with here — rebuilding one is possible
      // and is deliberately left out of this change — so the row is stamped as
      // before. This is the one remaining close that cannot persist, and it
      // only covers sessions this node never launched.
      if (live) this.launcher.terminate(row.work_session_id);
      await this.finishRow(principal, row.work_session_id);
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

  // -------------------------------------------------------------------------
  // space logins (206, SC-4)
  // -------------------------------------------------------------------------

  /**
   * Open a login terminal onto a SPACE credential.
   *
   * The order differs from the member start in one place, deliberately: the
   * RPC runs BEFORE the home exists, because a new login's credential id —
   * the home's directory — is minted by `start_space_credential_login`. A
   * home that cannot be made then releases the row through
   * `finish_space_credential_login(ws, false)`, as a failed launch does.
   *
   * The terminal logs in under a STAGING home of its own, never the live one
   * agents read (A6); see `space-credential-home.ts`.
   */
  private async startSpace(
    input: StartCredentialSessionInput,
    target: { label?: string; credentialId?: string },
    principal: CredentialPrincipal,
  ): Promise<StartedCredentialSession> {
    const { provider } = input;
    assertSpaceLoginProvider(provider);
    assertHumanSpaceLogin(principal.claims);
    if (principal.claims.actorId) {
      throw new CollabError(
        'forbidden',
        'a credential session is never opened on another actor’s behalf (finding D2)',
      );
    }
    const hasLabel = target.label !== undefined;
    const hasId = target.credentialId !== undefined;
    if (hasLabel === hasId) {
      throw new CollabError(
        'invalid_input',
        'a space login names exactly one of a label (a new credential) or a credentialId (log in again)',
      );
    }

    await this.reclaimExpiredSpaceLogins(principal, input.spaceId, provider, target);

    let started: Awaited<ReturnType<SpaceLoginStorePort['startLogin']>>;
    try {
      started = await this.spaceStore.startLogin(principal.claims, {
        spaceId: input.spaceId,
        provider,
        label: target.label ?? null,
        credentialId: target.credentialId ?? null,
        ttlSeconds: DEFAULT_CREDENTIAL_TTL_SECONDS,
        sessionCap: resolveCredentialSessionCap(this.env),
      });
    } catch (error) {
      throw spaceStartRefusal(error, target);
    }

    const key: SpaceLoginHomeKey = {
      spaceId: started.credential.spaceId,
      credentialId: started.credential.id,
      provider,
    };
    try {
      const { homeDir, configDir } = await this.spaceHomes.ensureStaging(key, started.workSessionId);
      // After the RPC, for the reason the member start gives: an
      // authorization answer must never depend on a fact about the node.
      const binary = measureCredentialBinary({
        provider,
        homeDir,
        configDir,
        parentEnv: this.env,
        ...(this.binaryResolver ? { resolveBinary: this.binaryResolver } : {}),
      });
      if (binary.status === 'unavailable') {
        throw new CollabError('invalid_input', credentialCliInstallMessage(provider));
      }
      if (binary.status === 'unknown') {
        throw new CollabError(
          'upstream_unavailable',
          binary.detail ?? `could not determine whether credential CLI '${binary.binary}' is installed`,
        );
      }

      const launched = this.launcher.launch({
        sessionId: started.workSessionId,
        provider,
        homeDir,
        configDir,
        ...(input.cols ? { cols: input.cols } : {}),
        ...(input.rows ? { rows: input.rows } : {}),
      });

      // Registered at once, in the same registry the member sweep walks, so
      // this terminal is killed before its row is ever stamped — by the
      // sweep at expiry, by a delete, or by a re-login's reclaim.
      this.registry.set(started.workSessionId, {
        workSessionId: started.workSessionId,
        provider,
        expiresAtMs: new Date(started.expiresAt).getTime(),
        homeDir,
        configDir,
        env: launched.env,
        principal,
        space: { ...key, isNew: !hasId },
      });

      return {
        workSessionId: started.workSessionId,
        spaceId: started.spaceId,
        provider,
        expiresAt: started.expiresAt,
        command: launched.command,
        spaceCredential: started.credential,
      };
    } catch (error) {
      // Nothing was launched, or the launch threw: no PTY to kill first.
      this.launcher.terminate(started.workSessionId);
      await this.spaceStore
        .finishLogin(principal.claims, started.workSessionId, false)
        .catch(() => undefined);
      await this.spaceHomes.removeStaging(key, started.workSessionId).catch(() => undefined);
      throw error;
    }
  }

  /**
   * KILL, PROBE, FINISH, PROMOTE — the one way a space login terminal ends.
   *
   * The kill comes first and GATES everything after it. A terminal the PTY
   * host could not kill is left open: its row is not stamped and its entry is
   * kept for the next sweep. Stamping it would free the credential for a
   * re-login that then races a live terminal for the home.
   *
   * The finish RPC is the only writer of the row (206: N1, B1, B2 and the
   * lock order live there). `ok` is the probe's verdict AND the presence of
   * the credential file in the staging home — a probe that saw a login
   * somewhere else must not activate this credential. Files move into the
   * live home only after the RPC committed `connected`, and a promote that
   * then fails marks the credential `stale` through the probe RPC, so the
   * row never claims a login the disk does not hold (I6).
   */
  private async runSpaceClose(
    entry: RegistryEntry,
    principal: CredentialPrincipal,
    mode: CloseMode,
  ): Promise<CloseOutcome> {
    const key = entry.space!;
    const killed = this.launcher.terminate(entry.workSessionId);
    if (killed === 'error') {
      return {
        probe: null,
        stored: false,
        terminated: false,
        killFailed: true,
        failure: new CollabError(
          'upstream_unavailable',
          'the PTY host could not kill this login terminal; it was left open and will be retried',
        ),
      };
    }

    let failure: unknown = null;
    let measured: ProbeResult | null = null;
    let ok = false;
    if (mode === 'probe') {
      try {
        measured = await runCredentialProbe({
          provider: entry.provider,
          env: entry.env,
          cwd: entry.homeDir,
          ...(this.probeRunner ? { run: this.probeRunner } : {}),
          ...(this.binaryResolver ? { resolveBinary: this.binaryResolver } : {}),
        });
        ok = measured.connected && (await this.spaceHomes.stagingHasLogin(key, entry.workSessionId));
      } catch (error) {
        failure = error;
      }
    }

    let finished: SpaceCredentialLoginFinish | null = null;
    try {
      finished = await this.spaceStore.finishLogin(
        principal.claims,
        entry.workSessionId,
        ok,
        ok ? measured?.login ?? null : null,
      );
    } catch (error) {
      failure ??= error;
      if (ok) {
        // A success the RPC refused — the credential was deleted meanwhile
        // (M6), or a manager already closed the terminal (B2). The terminal
        // is dead either way, so it is still stamped, as a failure.
        try {
          finished = await this.spaceStore.finishLogin(principal.claims, entry.workSessionId, false);
        } catch (second) {
          failure ??= second;
        }
      }
    }

    let stored = false;
    let credential = finished?.credential;
    if (finished?.connected) {
      try {
        stored = await this.spaceHomes.promote(key, entry.workSessionId, () =>
          this.spaceLoginStillWanted(principal.claims, key.credentialId),
        );
        if (!stored) failure ??= new CollabError('invariant_violation', 'the login could not be moved into the space home');
      } catch (error) {
        failure ??= error;
      }
      if (!stored) {
        credential = await this.spaceStore
          .recordProbe(principal.claims, key.credentialId, false)
          .catch(() => credential);
      }
    }

    if (finished) {
      this.registry.delete(entry.workSessionId);
      await this.spaceHomes.removeStaging(key, entry.workSessionId).catch(() => undefined);
    }
    // Otherwise the row is still open (the RPC could not be reached): the
    // entry and the staging home are kept, and the next sweep retries.

    const connected = finished?.connected === true && stored;
    return {
      probe: finished
        ? {
            provider: entry.provider,
            connected,
            status: credential?.status === 'active' ? 'active' : 'stale',
            login: credential?.displayLogin ?? null,
            authMethod: connected ? measured?.authMethod ?? null : null,
            detail: `the space credential is recorded as '${credential?.status ?? 'unknown'}'`,
          }
        : null,
      stored,
      terminated: killed === 'killed',
      failure: connected ? null : failure,
      ...(credential ? { spaceCredential: credential } : {}),
    };
  }

  /** Whether a promote may still write: the row, read under the member RLS policy (I6). */
  private async spaceLoginStillWanted(claims: DbClaims, credentialId: string): Promise<boolean> {
    const rows = await this.db.query<{ status: string }>(
      claims,
      'select status from public.space_credentials where id = $1',
      [credentialId],
    );
    return rows[0]?.status === 'active' || rows[0]?.status === 'stale';
  }

  /**
   * `finish` for a space login this node no longer holds: after a restart,
   * or a second click. An open row of the caller's own is closed as the
   * sweep would close it — killed, then `finish(ws, false)`; the answer is
   * the credential row, never the files (I6).
   */
  private async reportClosedSpaceSession(
    workSessionId: string,
    principal: CredentialPrincipal,
  ): Promise<FinishedCredentialSession> {
    const rows = await this.db.query<OwnSpaceLoginRow>(
      principal.claims,
      `select work_session_id, space_credential_id, provider, expires_at, finished_at
         from public.credential_sessions
        where work_session_id = $1
          and space_credential_id is not null`,
      [workSessionId],
    );
    const row = rows[0];
    if (!row) {
      throw new CollabError('not_found', 'no live credential session on this node for that work session');
    }
    assertHumanSpaceLogin(principal.claims);
    const provider = row.provider as CredentialProvider;

    let credential: SpaceCredential | undefined;
    let terminated = false;
    if (row.finished_at === null) {
      const killed = this.launcher.terminate(workSessionId);
      if (killed === 'error') {
        throw new CollabError('upstream_unavailable', 'the PTY host could not kill this login terminal');
      }
      terminated = killed === 'killed';
      credential = (await this.spaceStore.finishLogin(principal.claims, workSessionId, false)).credential;
    } else {
      credential = (await this.spaceStore.read(principal.claims, row.space_credential_id)) ?? undefined;
    }
    const connected = credential?.status === 'active';
    return {
      workSessionId,
      provider,
      probe: {
        provider,
        connected,
        status: connected ? 'active' : 'stale',
        login: credential?.displayLogin ?? null,
        authMethod: null,
        detail: `the space credential is recorded as '${credential?.status ?? 'gone'}'; this close did not measure it`,
      },
      stored: false,
      terminated,
      ...(credential ? { spaceCredential: credential } : {}),
    };
  }

  /**
   * N1: before a start raises `login_open` (a re-login) or a taken label (a
   * new login), close what is ALREADY PAST ITS EXPIRY and that the caller may
   * close — its own terminals, or, for the credential's creator or a space
   * admin, anyone's (206's manager close). A terminal still inside its
   * expiry is NEVER closed here, even the caller's own: it answers
   * `login_open`, so a second manager cannot kill the first one's terminal
   * mid-login.
   *
   * Every close kills first, through the registry when this node holds the
   * terminal, and stamps only through `finish_space_credential_login(ws,
   * false)`. After a restart the registry is empty; the terminal is killed
   * by id (a no-op when no PTY survived) and then stamped.
   */
  private async reclaimExpiredSpaceLogins(
    principal: CredentialPrincipal,
    spaceId: string,
    provider: string,
    target: { label?: string; credentialId?: string },
  ): Promise<void> {
    const now = this.now();
    const expired = new Map<string, string>(); // workSessionId -> credentialId

    // The caller's own expired space terminals, visible through RLS: they
    // hold the credential cap and, for a re-login, the credential. Not
    // filtered to `spaceId` on purpose: every row closed here is the caller's
    // own and already past its expiry, in whichever space it was opened.
    const own = await this.db.query<OwnSpaceLoginRow>(
      principal.claims,
      `select work_session_id, space_credential_id, provider, expires_at, finished_at
         from public.credential_sessions
        where finished_at is null
          and space_credential_id is not null`,
    );
    for (const row of own) {
      if (new Date(row.expires_at).getTime() <= now) expired.set(row.work_session_id, row.space_credential_id);
    }

    // Anyone's expired terminal on the targeted credential — or on the
    // pending credential holding the requested label. `liveSessions` is
    // manager-only in SQL; a caller who is not a manager gets nothing here,
    // and the start RPC answers them.
    let credentialId = target.credentialId ?? null;
    if (target.label !== undefined) {
      const pending = await this.db.query<{ id: string }>(
        principal.claims,
        `select id from public.space_credentials
          where space_id = $1 and provider = $2 and status = 'pending' and label = btrim($3)`,
        [spaceId, provider, target.label],
      );
      credentialId = pending[0]?.id ?? null;
    }
    if (credentialId) {
      try {
        const live = await this.spaceStore.liveSessions(principal.claims, credentialId);
        for (const terminal of live.loginTerminals) {
          if (new Date(terminal.expiresAt).getTime() <= now) expired.set(terminal.workSessionId, credentialId);
        }
      } catch {
        // Not a manager, or not found: nothing of anyone else's to close.
      }
    }

    for (const workSessionId of expired.keys()) {
      const result = await this.closeSpaceLogin(principal.claims, workSessionId).catch((error: unknown) => {
        this.logger?.warn?.('space login reclaim could not close a terminal', {
          workSessionId,
          error: error instanceof Error ? error.message : String(error),
        });
        return 'kill_failed' as const;
      });
      if (result === 'kill_failed') {
        this.logger?.warn?.('space login reclaim left a terminal open', { workSessionId });
      }
    }
    // A pending credential whose login is now closed and whose deadline has
    // passed gives its label back here, before the start asks for it.
    if (expired.size > 0 || target.label !== undefined) await this.expirePendingQuietly(principal.claims);
  }

  /**
   * Close one space login terminal as ABANDONED: kill it — through the
   * registry when this node holds it, so an in-flight close is awaited rather
   * than raced — and only then `finish_space_credential_login(ws, false)`
   * under `claims`, which 206 admits for the opener, or for a manager once the
   * credential is revoked or the terminal is past its expiry. Delete (step 3
   * and 4) and the start-time reclaim both come through here.
   */
  async closeSpaceLogin(claims: DbClaims, workSessionId: string): Promise<SpaceLoginCloseResult> {
    const entry = this.registry.get(workSessionId);
    if (entry?.space) {
      const outcome = await this.closeSession(
        entry,
        { claims, identityId: entry.principal.identityId },
        'abandon',
      );
      if (outcome.killFailed) return 'kill_failed';
      if (outcome.failure && !outcome.probe) throw outcome.failure;
      return 'closed';
    }
    if (this.launcher.terminate(workSessionId) === 'error') return 'kill_failed';
    await this.spaceStore.finishLogin(claims, workSessionId, false);
    return 'closed';
  }

  /** The pending-login expiry (M3). Best effort: a failure leaves the row for the next call. */
  private async expirePendingQuietly(claims: DbClaims): Promise<void> {
    try {
      await this.spaceStore.expirePending(claims);
    } catch (error) {
      this.logger?.warn?.('pending space credential expiry failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
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

/**
 * I2 inside the service, not only at the handler: a space login is opened
 * and closed by a human. SQL refuses an agent too, but only at the RPC, and
 * a close KILLS the terminal before its RPC runs — an agent-claims finish
 * would end the human's login first and be refused after.
 */
function assertHumanSpaceLogin(claims: DbClaims): void {
  if (claims.authKind !== 'browser' && claims.authKind !== 'cli') {
    throw new CollabError('forbidden', 'a space login is opened and closed by a human session only', {
      details: { reason: 'credentials_human_only' },
    });
  }
}

/**
 * A start refusal, named so a caller can tell its causes apart without
 * reading a message: `details.reason` is `login_open` (a login onto that
 * credential is still inside its expiry) or `label_taken`.
 */
function spaceStartRefusal(error: unknown, target: { label?: string; credentialId?: string }): unknown {
  if (!(error instanceof CollabError) || error.code !== 'invariant_violation') return error;
  const details = error.details ?? {};
  if (details.reason === 'login_open') {
    return new CollabError('conflict', 'a login onto this space credential is already open', {
      details: {
        reason: 'login_open',
        ...(typeof details.expiresAt === 'string' ? { expiresAt: details.expiresAt } : {}),
        ...(target.credentialId ? { credentialId: target.credentialId } : {}),
      },
    });
  }
  if (details.sqlstate === '23505') {
    // A new login's only unique key is the label; a re-login's is the
    // one-live-per-credential index, reached only by a race with another start.
    return target.credentialId
      ? new CollabError('conflict', 'a login onto this space credential is already open', {
          details: { reason: 'login_open', credentialId: target.credentialId },
        })
      : new CollabError('conflict', 'a credential with this label already exists for this provider', {
          details: { reason: 'label_taken', label: target.label?.trim() ?? null },
        });
  }
  return error;
}
