/**
 * Id + clock seams.
 *
 * Both are injectable so tests are deterministic: token lifecycle and expiry
 * assertions need to move time without sleeping, and idempotency assertions
 * need to know which id was minted.
 */

import { randomUUID, randomBytes } from 'node:crypto';

export interface Clock {
  /** ISO-8601 UTC, the wire shape every contract DTO uses. */
  now(): string;
  nowMs(): number;
}

export const systemClock: Clock = {
  now: () => new Date().toISOString(),
  nowMs: () => Date.now(),
};

/** A clock tests drive by hand. */
export class ManualClock implements Clock {
  private ms: number;
  constructor(start: string | number = '2026-01-01T00:00:00.000Z') {
    this.ms = typeof start === 'number' ? start : Date.parse(start);
  }
  now(): string {
    return new Date(this.ms).toISOString();
  }
  nowMs(): number {
    return this.ms;
  }
  advance(ms: number): void {
    this.ms += ms;
  }
}

export interface IdGenerator {
  /** Row ids — uuid, matching 002's `uuidv7()` defaults in shape if not in ordering. */
  uuid(): string;
  /**
   * The opaque, immutable identity id (R6). Deliberately NOT a uuid and
   * deliberately not derived from any name: it must survive a rename and, later,
   * carry a `user@server` address without rekeying `user_profiles`. Consumers
   * treat it as an opaque string and never parse it.
   */
  identityId(): string;
}

export const IDENTITY_ID_PREFIX = 'id_';

export const systemIds: IdGenerator = {
  uuid: () => randomUUID(),
  identityId: () => `${IDENTITY_ID_PREFIX}${randomBytes(16).toString('base64url')}`,
};

/** Sequential ids for tests. */
export class SequentialIds implements IdGenerator {
  private n = 0;
  constructor(private readonly prefix = 'test') {}
  uuid(): string {
    this.n += 1;
    return `${this.prefix}-${String(this.n).padStart(8, '0')}-0000-0000-0000-000000000000`;
  }
  identityId(): string {
    this.n += 1;
    return `${IDENTITY_ID_PREFIX}${this.prefix}${this.n}`;
  }
}
