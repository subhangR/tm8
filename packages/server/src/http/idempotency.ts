/**
 * Test-mode command input normalization.
 *
 * `TM8_IDEMPOTENCY_ENABLED=false` deliberately makes each HTTP command a new
 * mutation. Supplying a fresh id here keeps every existing strict DTO and RPC
 * signature usable while the database's command ledger is disabled for the
 * same server pool. It is intentionally applied before zod validation: some
 * command DTOs require `clientMutationId` while others only accept it.
 */
import { randomUUID } from 'node:crypto';

import type { OperationBinding } from '@tm8/contract';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function normalizeCommandInputForIdempotencyMode(
  op: OperationBinding,
  body: unknown,
  idempotencyEnabled: boolean,
): unknown {
  if (idempotencyEnabled || op.kind !== 'command') return body;

  // Commands are object DTOs. Preserve malformed scalar/array bodies so their
  // normal schema error still reaches the caller rather than masking it.
  if (body !== undefined && !isRecord(body)) return body;

  return {
    ...(body ?? {}),
    // Never reuse caller input in this mode: an old ledger row must not affect
    // a local CRUD test, and each request must execute rather than replay.
    clientMutationId: randomUUID(),
  };
}
