import {
  CheckpointReadError, VaultError, systemClock, type AuditGate, type AuditVerification, type CheckpointRecord,
  type CheckpointSink, type CheckpointVerifier, type Clock, type RetainedCheckpoint, type VaultStore,
} from '../core-types.js';
import { AUDIT_GENESIS_HASH, checkpointSigningInput, verifyAuditRun, type ChainCursor } from './chain.js';

const AUDIT_SCOPE = { kind: 'system', purpose: 'audit' } as const;

/**
 * Why an anchored verification failed. A fixed vocabulary: a log carries one of
 * these and nothing read from a sink, a key or the database.
 */
export type AuditAnchorFailure =
  /** The sink or a verification key cannot be read right now. Transient; the budget bounds it. */
  | 'anchor_unavailable'
  /** The sink retains a signed head beyond the database's head: the database was rolled back or truncated. */
  | 'anchor_rollback'
  /** The chain disagrees with a retained signed head, or two retained heads claim one seq. */
  | 'anchor_conflict'
  /** A checkpoint the database or this process saw anchored is no longer retained. */
  | 'anchor_missing'
  /** A retained object is malformed, or its signature does not verify under a key the verifier vouches for. */
  | 'anchor_invalid'
  /** An event has stayed unanchored, or no anchored verification has succeeded, for longer than the budget. */
  | 'anchor_stale';

/**
 * Review F01: the database is not its own witness. vault.checkpoints is
 * writable by the broker role, so with an anchor every verification reads the
 * newest signed checkpoint back from the sink itself, checks its signature, and
 * requires the chain to contain that exact head.
 */
export interface AuditAnchorOptions {
  sink: Pick<CheckpointSink, 'kind' | 'latest'>;
  verifier: CheckpointVerifier;
  /**
   * The longest an appended event may stay unanchored, and the longest since the
   * last anchored verification, before the gate fails closed.
   */
  budgetMs: number;
  /** Called once per failed anchored verification, with the reason only. */
  onFailure?: (reason: AuditAnchorFailure) => void;
}

type Outcome =
  | { kind: 'verified'; cursor: ChainCursor; oldestUnanchoredAt: number | null }
  | { kind: 'broken'; verification: AuditVerification; reason: AuditAnchorFailure | null };

/**
 * A chain break or an anchor failure that is evidence is sticky for the lifetime
 * of this instance. Outages cool down; an anchor outage is bounded by the budget.
 *
 * A verification says whether the chain is intact and agrees with the retained
 * anchor; `status()` also says whether the anchor is fresh. So a stale anchor
 * still verifies, and startup can anchor a suffix a crashed process left
 * unanchored, but nothing audited is served until a checkpoint covers it.
 */
export class VaultAuditGate implements AuditGate {
  readonly #store: VaultStore;
  readonly #clock: Clock;
  readonly #cooldownMs: number;
  readonly #enabled: boolean;
  readonly #pageSize: number;
  readonly #anchor: AuditAnchorOptions | null;
  #unavailableUntil = -Infinity;
  #broken: AuditVerification | null = null;
  #verified: ChainCursor = { seq: 0, hash: AUDIT_GENESIS_HASH };
  #tail: Promise<unknown> = Promise.resolve();
  /** The newest retained seq this instance has verified; -1 before any. It never goes back. */
  #anchoredSeq = -1;
  /** Clock time of the last verification whose anchor read, signature and containment all passed. */
  #anchorCheckedAt = -Infinity;
  /** `at` (ms) of the oldest event above the anchored seq, as of the last chain walk; null when none. */
  #oldestUnanchoredAt: number | null = null;

  constructor(options: {
    store: VaultStore; clock?: Clock; cooldownMs?: number; pageSize?: number; enabled?: boolean; anchor?: AuditAnchorOptions;
  }) {
    this.#store = options.store;
    this.#clock = options.clock ?? systemClock;
    this.#cooldownMs = options.cooldownMs ?? 30_000;
    this.#pageSize = options.pageSize ?? 200;
    this.#enabled = options.enabled ?? true;
    this.#anchor = options.anchor ?? null;
    if (!Number.isSafeInteger(this.#cooldownMs) || this.#cooldownMs < 0 || !Number.isSafeInteger(this.#pageSize) || this.#pageSize < 1 ||
        (this.#anchor !== null && (!Number.isSafeInteger(this.#anchor.budgetMs) || this.#anchor.budgetMs < 1))) {
      throw new TypeError('vault audit: invalid configuration');
    }
  }

  status(): 'ok' | 'unavailable' | 'disabled' {
    if (!this.#enabled) return 'disabled';
    const now = this.#clock.now().getTime();
    return this.#broken || now < this.#unavailableUntil || this.#stale(now) ? 'unavailable' : 'ok';
  }

  assertHealthy(): void {
    if (this.status() !== 'ok') throw VaultError.reason('audit_unavailable');
  }

  reportAppendFailure(): void {
    this.#unavailableUntil = Math.max(this.#unavailableUntil, this.#clock.now().getTime() + this.#cooldownMs);
  }

  verifyIncremental(): Promise<AuditVerification> { return this.#queue(false); }
  verifyAll(): Promise<AuditVerification> { return this.#queue(true); }

  #stale(now: number): boolean {
    if (!this.#anchor) return false;
    const budget = this.#anchor.budgetMs;
    return now - this.#anchorCheckedAt > budget || (this.#oldestUnanchoredAt !== null && now - this.#oldestUnanchoredAt > budget);
  }

  #queue(all: boolean): Promise<AuditVerification> {
    const run = this.#tail.then(() => this.#verify(all));
    this.#tail = run.then(() => undefined, () => undefined);
    return run;
  }

  #report(reason: AuditAnchorFailure): void {
    try { this.#anchor?.onFailure?.(reason); } catch { /* A log failure cannot change an outcome. */ }
  }

  #trip(verification: AuditVerification, reason: AuditAnchorFailure | null): AuditVerification {
    this.#broken = { ...verification };
    if (reason) this.#report(reason);
    return { ...verification };
  }

  async #verify(all: boolean): Promise<AuditVerification> {
    if (this.#broken) return { ...this.#broken };
    const unverified = (): AuditVerification => ({ status: 'unverified', checkedThroughSeq: this.#verified.seq, headHash: this.#verified.hash, firstBrokenSeq: null });
    if (!this.#enabled) return unverified();
    let cursor: ChainCursor = all ? { seq: 0, hash: AUDIT_GENESIS_HASH } : { ...this.#verified };
    const broken = (seq: number): AuditVerification => ({ status: 'broken', checkedThroughSeq: cursor.seq, headHash: cursor.hash, firstBrokenSeq: Math.max(1, seq) });
    const anchor = this.#anchor;

    // The anchor is read before the chain. A receipt is recorded only after its put, so whatever the
    // database had recorded as anchored by then must still be retained; and a checkpoint can only cover a
    // head that existed when it was put, so a concurrent checkpoint can never look like a rollback.
    let retained: RetainedCheckpoint | null = null;
    let anchorUnavailable = false;
    if (anchor) {
      let receipt: CheckpointRecord | null;
      try { receipt = await this.#store.transaction(AUDIT_SCOPE, (tx) => tx.audit.latestCheckpoint()); }
      catch { this.reportAppendFailure(); return unverified(); }
      const recorded = receipt && receipt.anchored && receipt.sink === anchor.sink.kind ? receipt.seq : -1;
      const known = Math.max(recorded, this.#anchoredSeq);
      try {
        retained = await anchor.sink.latest(Math.max(0, known));
        if (known >= 0 && (retained === null || retained.seq < known)) return this.#trip(broken(known), 'anchor_missing');
        if (retained) {
          let input: Buffer;
          try { input = checkpointSigningInput(retained); } catch { return this.#trip(broken(retained.seq), 'anchor_invalid'); }
          if (!(await anchor.verifier.verify(retained.keyId, input, Buffer.from(retained.signature, 'base64url')))) {
            return this.#trip(broken(retained.seq), 'anchor_invalid');
          }
        }
      } catch (error) {
        if (error instanceof CheckpointReadError && error.code !== 'unavailable') {
          return this.#trip(broken(cursor.seq + 1), error.code === 'conflict' ? 'anchor_conflict' : 'anchor_invalid');
        }
        retained = null;
        anchorUnavailable = true;
      }
    }

    let outcome: Outcome;
    try {
      outcome = await this.#store.transaction(AUDIT_SCOPE, async (tx): Promise<Outcome> => {
        const fail = (seq: number, reason: AuditAnchorFailure | null = null): Outcome => ({ kind: 'broken', verification: broken(seq), reason });
        // The receipt is read before the head. Under read committed each statement sees a newer snapshot, and a
        // receipt is recorded only after the head it covers was committed, so a checkpoint that lands between the
        // two reads cannot look like a receipt beyond the head.
        const checkpoint = await tx.audit.latestCheckpoint();
        const target = await tx.audit.head();
        if (target.seq < cursor.seq) return fail(target.seq + 1);
        if (cursor.seq > 0) {
          const boundary = await tx.audit.range(cursor.seq, cursor.seq);
          if (boundary.length !== 1 || boundary[0]!.entryHash !== cursor.hash || !verifyAuditRun({ seq: cursor.seq - 1, hash: boundary[0]!.prevHash }, boundary).ok) return fail(cursor.seq);
        }
        if (retained) {
          // The independent witness outranks the database: a signed head the chain has not reached is a rollback.
          if (retained.seq > target.seq) return fail(target.seq + 1, 'anchor_rollback');
          if (retained.seq === 0) {
            if (retained.headHash !== AUDIT_GENESIS_HASH) return fail(1, 'anchor_conflict');
          } else {
            const rows = await tx.audit.range(retained.seq, retained.seq);
            if (rows.length !== 1 || rows[0]!.entryHash !== retained.headHash ||
                !verifyAuditRun({ seq: retained.seq - 1, hash: rows[0]!.prevHash }, rows).ok) return fail(retained.seq, 'anchor_conflict');
          }
        }
        if (checkpoint && checkpoint.seq > target.seq) return fail(target.seq + 1);
        if (checkpoint) {
          const rows = checkpoint.seq === 0 ? [] : await tx.audit.range(checkpoint.seq, checkpoint.seq);
          const hash = checkpoint.seq === 0 ? AUDIT_GENESIS_HASH : rows[0]?.entryHash;
          if (hash !== checkpoint.headHash) return fail(checkpoint.seq);
        }
        while (cursor.seq < target.seq) {
          const end = Math.min(target.seq, cursor.seq + this.#pageSize);
          const rows = await tx.audit.range(cursor.seq + 1, end);
          const run = verifyAuditRun(cursor, rows);
          cursor = run.head;
          if (!run.ok) return fail(run.firstBrokenSeq);
          if (cursor.seq !== end) return fail(cursor.seq + 1);
        }
        if (cursor.hash !== target.hash) return fail(target.seq);
        let oldestUnanchoredAt: number | null = null;
        if (anchor) {
          // With the sink unreadable, staleness is measured from the last head this instance saw anchored.
          const covered = Math.max(0, retained ? retained.seq : this.#anchoredSeq);
          if (covered < target.seq) {
            const next = await tx.audit.range(covered + 1, covered + 1);
            const at = next.length === 1 ? Date.parse(next[0]!.at) : Number.NaN;
            if (!Number.isFinite(at)) return fail(covered + 1);
            oldestUnanchoredAt = at;
          }
        }
        return { kind: 'verified', cursor: { ...cursor }, oldestUnanchoredAt };
      });
    } catch {
      this.reportAppendFailure();
      return unverified();
    }
    if (outcome.kind === 'broken') return this.#trip(outcome.verification, outcome.reason);
    this.#verified = { ...outcome.cursor };
    if (anchor) {
      this.#oldestUnanchoredAt = outcome.oldestUnanchoredAt;
      if (!anchorUnavailable) {
        if (retained) this.#anchoredSeq = Math.max(this.#anchoredSeq, retained.seq);
        this.#anchorCheckedAt = this.#clock.now().getTime();
      }
      if (anchorUnavailable) this.#report('anchor_unavailable');
      if (this.#stale(this.#clock.now().getTime())) this.#report('anchor_stale');
      if (anchorUnavailable) return unverified();
    }
    return { status: 'verified', checkedThroughSeq: outcome.cursor.seq, headHash: outcome.cursor.hash, firstBrokenSeq: null };
  }
}

export { VaultAuditGate as StoreAuditGate };
