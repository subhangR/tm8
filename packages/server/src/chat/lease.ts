import { CollabError } from '@tm8/contract';

/**
 * How long one claim or renewal holds a chat's runtime lease. It must equal the
 * `interval '10 minutes'` that `claim_next_chat_turn` and
 * `heartbeat_chat_runtime` (332) write; the owner uses it to know, from its own
 * clock, when the lease it last renewed runs out.
 */
export const CHAT_LEASE_MS = 10 * 60_000;

/**
 * The turn's owner can no longer prove it holds the chat. Either the database
 * refused the fence (the lease ran out, or recovery moved the chat on), or no
 * renewal landed before the lease the owner last renewed would expire.
 *
 * Its message is what the thread shows if the turn can still be settled, so it
 * names the cause rather than a generic failure.
 */
export class ChatLeaseLostError extends Error {
  readonly code = 'lease_lost';
  constructor(readonly reason: string) {
    super(`This turn lost its hold on the chat: ${reason}. The next message will run.`);
  }
}

/** A pre-launch step that ran past its budget. Shown in the thread as is. */
export class ChatPhaseTimeoutError extends Error {
  readonly code = 'phase_timeout';
  constructor(readonly phase: string, readonly milliseconds: number) {
    super(`Preparing this turn stopped: ${phase} took longer than ${Math.round(milliseconds / 1000)}s. The next message will run.`);
  }
}

/** `operation` names the step for the thrown message, or builds the error itself. */
export async function deadline<T>(promise: Promise<T>, milliseconds: number,
  operation: string | (() => Error)): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(typeof operation === 'function'
        ? operation() : new Error(`${operation} timed out`)), milliseconds);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

function sqlstateOf(error: unknown): string | undefined {
  const candidate = error as { code?: unknown; details?: { sqlstate?: unknown } } | null;
  if (typeof candidate?.details?.sqlstate === 'string') return candidate.details.sqlstate;
  return typeof candidate?.code === 'string' && /^[0-9A-Z]{5}$/.test(candidate.code) ? candidate.code : undefined;
}

/**
 * The database refused the turn's lease fence (`internal.chat_lock_owned`):
 * this owner does not hold the chat any more, and retrying cannot change that.
 */
export function isLeaseFenceError(error: unknown): boolean {
  return sqlstateOf(error) === '42501' && error instanceof Error
    && /stale (chat execution fence|native generation)/.test(error.message);
}

/**
 * SQLSTATEs where the statement provably did not commit and a second attempt
 * can succeed: lock/statement timeouts, serialization and deadlock aborts, and
 * a server that is restarting or out of connections.
 */
const TRANSIENT_SQLSTATES = new Set(['57014', '55P03', '40001', '40P01', '53300', '57P01', '57P02', '57P03', '25P03']);
const TRANSIENT_ERRNOS = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN']);

/**
 * True for a database failure that says nothing about the turn itself: the pool
 * had no free client in time (`DbPoolExhaustedError`), the server was briefly
 * unreachable, or a statement was aborted and rolled back. A lease write that
 * fails this way is retried; anything else is a real answer and is not.
 */
export function isTransientDbError(error: unknown): boolean {
  if (error instanceof CollabError) {
    const sqlstate = sqlstateOf(error);
    if (sqlstate) return TRANSIENT_SQLSTATES.has(sqlstate);
    return error.code === 'upstream_unavailable' && error.retryable;
  }
  const sqlstate = sqlstateOf(error);
  if (sqlstate) return TRANSIENT_SQLSTATES.has(sqlstate);
  const errno = (error as { code?: unknown } | null)?.code;
  if (typeof errno === 'string' && TRANSIENT_ERRNOS.has(errno)) return true;
  return error instanceof Error
    && /timeout exceeded when trying to connect|Connection terminated|connection timeout/i.test(error.message);
}

export interface RetryOptions {
  /** Epoch milliseconds after which no further attempt starts. */
  readonly until: () => number;
  readonly baseMs?: number;
  readonly capMs?: number;
  readonly retryable?: (error: unknown) => boolean;
  /** Called before each wait, so every failed attempt is logged by the caller. */
  readonly onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}

const sleep = (milliseconds: number) => new Promise<void>((resolve) => {
  const timer = setTimeout(resolve, milliseconds);
  timer.unref?.();
});

/**
 * Run `operation` until it succeeds, it fails with a non-transient error, or
 * the next attempt would start after `until()`. Backoff doubles from `baseMs`
 * to `capMs`. The last error is rethrown, never swallowed.
 */
export async function retryTransient<T>(operation: () => Promise<T>, options: RetryOptions): Promise<T> {
  const retryable = options.retryable ?? isTransientDbError;
  const base = options.baseMs ?? 500;
  const cap = options.capMs ?? 15_000;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const delay = Math.min(cap, base * 2 ** (attempt - 1));
      if (!retryable(error) || Date.now() + delay >= options.until()) throw error;
      options.onRetry?.(error, attempt, delay);
      await sleep(delay);
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface TurnLeaseOptions {
  /** One renewal round trip (`heartbeat_chat_runtime`). */
  readonly renew: () => Promise<void>;
  /** Local time the lease was last written: the claim, before any renewal. */
  readonly claimedAt: number;
  readonly leaseMs?: number;
  readonly intervalMs?: number;
  /** Ceiling on one renewal attempt, so a hung call cannot eat the lease. */
  readonly attemptTimeoutMs?: number;
  readonly retryBaseMs?: number;
  readonly retryCapMs?: number;
  /**
   * The owner gives the lease up this long before its own estimate of expiry,
   * so it stops acting before the database could hand the chat to recovery.
   */
  readonly safetyMs?: number;
  readonly label: string;
  readonly onLost: (error: ChatLeaseLostError) => void;
  readonly onError?: ((error: unknown) => void) | undefined;
}

/**
 * Keeps one turn's runtime lease alive, and says so the moment it cannot.
 *
 * The heartbeat this replaces was a fire-and-forget `setInterval`: a renewal
 * that queued behind a saturated pool for 5s and failed was passed to onError
 * and forgotten, the next try was 30s later, and nothing ever compared "time
 * since the last renewal landed" with the lease. A turn could therefore hold a
 * lease it had silently stopped renewing until the database expired it, and
 * only a sweep minutes later would notice (prod 2026-10-20, chat dd0bbd03: not
 * one renewal landed).
 *
 * Now every failed renewal is logged with the turn and retried with backoff
 * until it lands, and the owner tracks the expiry of the last lease it actually
 * wrote. When the database refuses the fence, or that expiry is about to pass
 * with no renewal landed, the lease is declared lost: `onLost` runs once and
 * `whenLost` rejects, so every await racing it ends at once.
 */
export class TurnLease {
  private readonly leaseMs: number;
  private readonly safetyMs: number;
  /** Earliest the lease can run out: from the START of the last write that landed. */
  private expiresAt: number;
  /** Latest it can still be live: from the END of that write. */
  private latest: number;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private lostError: ChatLeaseLostError | null = null;
  private consecutiveFailures = 0;
  private rejectLost!: (error: ChatLeaseLostError) => void;
  /** Rejects once, when the lease is lost. Never resolves. */
  readonly whenLost: Promise<never>;

  constructor(private readonly options: TurnLeaseOptions) {
    this.leaseMs = options.leaseMs ?? CHAT_LEASE_MS;
    this.safetyMs = options.safetyMs ?? 15_000;
    this.expiresAt = options.claimedAt + this.leaseMs;
    // Constructed after the claim returned, so the claim's lease ends by now+lease.
    this.latest = Date.now() + this.leaseMs;
    this.whenLost = new Promise<never>((_, reject) => { this.rejectLost = reject; });
    // Racing promises observe it; an unraced loss must not crash the process.
    this.whenLost.catch(() => undefined);
  }

  start(): void {
    this.schedule(this.options.intervalMs ?? 30_000);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  get lost(): ChatLeaseLostError | null { return this.lostError; }

  /**
   * The latest moment the lease this owner last wrote can still be live, by
   * the owner's clock. Recovery of an abandoned turn is scheduled after it.
   */
  get latestExpiry(): number { return this.latest; }

  /** The owner's last safe moment to act on the lease. */
  get safeUntil(): number { return this.expiresAt - this.safetyMs; }

  /** A fence error seen by ANY write of the turn means the lease is gone. */
  observe(error: unknown): void {
    if (isLeaseFenceError(error)) this.lose(`the database refused its lease (${describe(error)})`);
  }

  private schedule(milliseconds: number): void {
    if (this.stopped || this.lostError) return;
    this.timer = setTimeout(() => { void this.tick(); }, milliseconds);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.lostError) return;
    const startedAt = Date.now();
    try {
      await this.renewOnce();
      // The database wrote now()+lease at some point between these two.
      this.expiresAt = startedAt + this.leaseMs;
      this.latest = Date.now() + this.leaseMs;
      if (this.consecutiveFailures > 0) {
        console.warn(`[chat] lease renewal recovered for ${this.options.label} after ${this.consecutiveFailures} failed attempt(s)`);
      }
      this.consecutiveFailures = 0;
      this.schedule(this.options.intervalMs ?? 30_000);
    } catch (error) {
      if (this.stopped || this.lostError) return;
      this.consecutiveFailures += 1;
      if (isLeaseFenceError(error)) {
        this.lose(`the database refused its lease (${describe(error)})`);
        return;
      }
      const delay = Math.min(this.options.retryCapMs ?? 10_000,
        (this.options.retryBaseMs ?? 1_000) * 2 ** (this.consecutiveFailures - 1));
      const remaining = this.safeUntil - Date.now();
      console.error(`[chat] lease renewal failed for ${this.options.label} (attempt ${this.consecutiveFailures}, `
        + `${Math.max(0, Math.round(remaining / 1000))}s of lease left): ${describe(error)}`);
      this.options.onError?.(error);
      if (remaining <= delay) {
        this.lose(`no lease renewal landed for ${Math.round((Date.now() - (this.expiresAt - this.leaseMs)) / 1000)}s `
          + `(last error: ${describe(error)})`);
        return;
      }
      this.schedule(delay);
    }
  }

  private async renewOnce(): Promise<void> {
    const timeout = this.options.attemptTimeoutMs ?? 10_000;
    await deadline(this.options.renew(), timeout, () => new Error(`lease renewal timed out after ${timeout}ms`));
  }

  private lose(reason: string): void {
    if (this.lostError || this.stopped) return;
    const error = new ChatLeaseLostError(reason);
    this.lostError = error;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    console.error(`[chat] lease LOST for ${this.options.label}: ${reason}`);
    this.rejectLost(error);
    try { this.options.onLost(error); } catch (failure) { this.options.onError?.(failure); }
  }
}
