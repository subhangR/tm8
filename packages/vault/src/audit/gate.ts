import { VaultError, systemClock, type AuditGate, type AuditVerification, type Clock, type VaultStore } from '../core-types.js';
import { AUDIT_GENESIS_HASH, verifyAuditRun, type ChainCursor } from './chain.js';

/** A chain break is sticky for the lifetime of this instance. Outages cool down. */
export class VaultAuditGate implements AuditGate {
  readonly #store: VaultStore;
  readonly #clock: Clock;
  readonly #cooldownMs: number;
  readonly #enabled: boolean;
  readonly #pageSize: number;
  #unavailableUntil = -Infinity;
  #broken: AuditVerification | null = null;
  #verified: ChainCursor = { seq: 0, hash: AUDIT_GENESIS_HASH };
  #tail: Promise<unknown> = Promise.resolve();

  constructor(options: { store: VaultStore; clock?: Clock; cooldownMs?: number; pageSize?: number; enabled?: boolean }) {
    this.#store = options.store;
    this.#clock = options.clock ?? systemClock;
    this.#cooldownMs = options.cooldownMs ?? 30_000;
    this.#pageSize = options.pageSize ?? 200;
    this.#enabled = options.enabled ?? true;
    if (!Number.isSafeInteger(this.#cooldownMs) || this.#cooldownMs < 0 || !Number.isSafeInteger(this.#pageSize) || this.#pageSize < 1) {
      throw new TypeError('vault audit: invalid configuration');
    }
  }

  status(): 'ok' | 'unavailable' | 'disabled' {
    if (!this.#enabled) return 'disabled';
    return this.#broken || this.#clock.now().getTime() < this.#unavailableUntil ? 'unavailable' : 'ok';
  }

  assertHealthy(): void {
    if (this.status() !== 'ok') throw VaultError.reason('audit_unavailable');
  }

  reportAppendFailure(): void {
    this.#unavailableUntil = Math.max(this.#unavailableUntil, this.#clock.now().getTime() + this.#cooldownMs);
  }

  verifyIncremental(): Promise<AuditVerification> { return this.#queue(false); }
  verifyAll(): Promise<AuditVerification> { return this.#queue(true); }

  #queue(all: boolean): Promise<AuditVerification> {
    const run = this.#tail.then(() => this.#verify(all));
    this.#tail = run.then(() => undefined, () => undefined);
    return run;
  }

  async #verify(all: boolean): Promise<AuditVerification> {
    if (this.#broken) return { ...this.#broken };
    const unverified = (): AuditVerification => ({ status: 'unverified', checkedThroughSeq: this.#verified.seq, headHash: this.#verified.hash, firstBrokenSeq: null });
    if (!this.#enabled) return unverified();
    let cursor: ChainCursor = all ? { seq: 0, hash: AUDIT_GENESIS_HASH } : { ...this.#verified };
    try {
      const result = await this.#store.transaction({ kind: 'system', purpose: 'audit' }, async (tx): Promise<AuditVerification> => {
        const target = await tx.audit.head();
        const broken = (seq: number): AuditVerification => ({ status: 'broken', checkedThroughSeq: cursor.seq, headHash: cursor.hash, firstBrokenSeq: seq });
        if (target.seq < cursor.seq) return broken(target.seq + 1);
        if (cursor.seq > 0) {
          const boundary = await tx.audit.range(cursor.seq, cursor.seq);
          if (boundary.length !== 1 || boundary[0]!.entryHash !== cursor.hash || !verifyAuditRun({ seq: cursor.seq - 1, hash: boundary[0]!.prevHash }, boundary).ok) return broken(cursor.seq);
        }
        const checkpoint = await tx.audit.latestCheckpoint();
        if (checkpoint && checkpoint.seq > target.seq) return broken(target.seq + 1);
        if (checkpoint) {
          const rows = checkpoint.seq === 0 ? [] : await tx.audit.range(checkpoint.seq, checkpoint.seq);
          const hash = checkpoint.seq === 0 ? AUDIT_GENESIS_HASH : rows[0]?.entryHash;
          if (hash !== checkpoint.headHash) return broken(Math.max(1, checkpoint.seq));
        }
        while (cursor.seq < target.seq) {
          const end = Math.min(target.seq, cursor.seq + this.#pageSize);
          const rows = await tx.audit.range(cursor.seq + 1, end);
          const run = verifyAuditRun(cursor, rows);
          cursor = run.head;
          if (!run.ok) return broken(run.firstBrokenSeq);
          if (cursor.seq !== end) return broken(cursor.seq + 1);
        }
        if (cursor.hash !== target.hash) return broken(Math.max(1, target.seq));
        return { status: 'verified', checkedThroughSeq: cursor.seq, headHash: cursor.hash, firstBrokenSeq: null };
      });
      if (result.status === 'broken') this.#broken = { ...result };
      else this.#verified = { ...cursor };
      return result;
    } catch {
      this.reportAppendFailure();
      return unverified();
    }
  }
}

export { VaultAuditGate as StoreAuditGate };
