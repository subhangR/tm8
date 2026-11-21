import type { AlertSink, VaultAlert } from '../core-types.js';
import type { CanarySet } from '../types.js';
import {
  VAULT_ALERTS_HEADER_MAX_CHARS, VAULT_ALERTS_MAX_PER_HEADER, VaultAlertSchema, encodeVaultAlerts,
} from '../relay/alerts.js';

export const MAX_QUEUED_ALERTS = 1024;

/** The broker server drains this onto attested responses (server.ts). */
export interface AlertOutbox {
  /** Removes the alerts that fit one header and returns it encoded; null when nothing is pending. */
  take(): string | null;
}

/**
 * Bounded and in memory. Every raise site runs inside a request, before that
 * request's response is written, so the same response normally carries its own
 * alerts and the relay notifies in real time. An alert that does not fit waits
 * for the next response. A broker restart loses pending alerts: the hash-chained
 * audit log stays the durable record of every alerted event.
 *
 * Params are metadata, but they are copied field by field, and an alert whose
 * params fail the schema, contain a planted decoy or are too large for one
 * header keeps its kind, ids and time with empty params.
 */
export class RelayAlertQueue implements AlertSink, AlertOutbox {
  readonly #queue: VaultAlert[] = [];
  readonly #canaries: CanarySet;
  readonly #capacity: number;
  #dropped = 0;

  constructor(options: { canaries: CanarySet; capacity?: number }) {
    this.#canaries = options.canaries;
    this.#capacity = options.capacity ?? MAX_QUEUED_ALERTS;
    if (!Number.isSafeInteger(this.#capacity) || this.#capacity < 1) throw new TypeError('vault alerts: invalid capacity');
  }

  get pending(): number { return this.#queue.length; }
  get dropped(): number { return this.#dropped; }

  raise(alert: VaultAlert): void {
    const bare: VaultAlert = { kind: alert.kind, memberId: alert.memberId, spaceId: alert.spaceId,
      itemId: alert.itemId, params: {}, at: alert.at };
    let copy: VaultAlert = bare;
    try {
      const full: VaultAlert = { ...bare, params: { ...alert.params } };
      if (VaultAlertSchema.safeParse(full).success && !this.#canaries.matches(JSON.stringify(full))
        && encodeVaultAlerts({ dropped: 0, alerts: [full] }).length <= VAULT_ALERTS_HEADER_MAX_CHARS / 2) copy = full;
    } catch { copy = bare; }
    if (!VaultAlertSchema.safeParse(copy).success || this.#queue.length >= this.#capacity) {
      this.#dropped += 1;
      return;
    }
    this.#queue.push(Object.freeze(copy));
  }

  take(): string | null {
    if (this.#queue.length === 0 && this.#dropped === 0) return null;
    let count = Math.min(this.#queue.length, VAULT_ALERTS_MAX_PER_HEADER);
    let header = encodeVaultAlerts({ dropped: this.#dropped, alerts: this.#queue.slice(0, count) });
    // Each queued alert fits half the budget alone (raise), so this ends with count >= 1.
    while (header.length > VAULT_ALERTS_HEADER_MAX_CHARS && count > 1) {
      count -= 1;
      header = encodeVaultAlerts({ dropped: this.#dropped, alerts: this.#queue.slice(0, count) });
    }
    this.#queue.splice(0, count);
    this.#dropped = 0;
    return header;
  }
}
