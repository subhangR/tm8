/**
 * Test-mode command input normalization.
 *
 * Idempotency is off by default, deliberately making each HTTP command a new
 * mutation. Supplying a fresh id here keeps the strict DTOs that require or
 * accept `clientMutationId` usable while the database's command ledger is
 * disabled for the same server pool. It is intentionally applied before zod
 * validation: some command DTOs require `clientMutationId` while others only
 * accept it — and the auth DTOs forbid it, so they are asked about rather
 * than assumed.
 */
import { randomUUID } from 'node:crypto';

import { ZodEffects, ZodObject, type ZodTypeAny } from 'zod';

import { commandAcceptsClientMutationId, type OperationBinding } from '@tm8/contract';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whether the operation's own input schema would refuse an injected id: a
 * `.strict()` object (under any refinements) whose shape has no
 * `clientMutationId`. Anything else — a stripping object, a union, no schema
 * at all — is treated as accepting, which is the old behaviour.
 */
function schemaForbidsClientMutationId(schema: ZodTypeAny | undefined): boolean {
  let inner = schema;
  while (inner instanceof ZodEffects) inner = inner.innerType();
  if (!(inner instanceof ZodObject)) return false;
  return inner._def.unknownKeys === 'strict' && !('clientMutationId' in inner.shape);
}

export function normalizeCommandInputForIdempotencyMode(
  op: OperationBinding,
  body: unknown,
  idempotencyEnabled: boolean,
  schema?: ZodTypeAny,
): unknown {
  if (idempotencyEnabled || op.kind !== 'command') return body;

  // Not every command DTO tolerates an id. The auth surface sits outside the
  // ledger on purpose and its schemas are `.strict()`, so injecting here made
  // signup and login fail contract validation on any server with the ledger
  // disabled — which is the default. The contract owns the rule; ask it.
  if (!commandAcceptsClientMutationId(op.name)) return body;

  // The name rule above missed every other strict DTO without the field —
  // `mcp.proxy.request` among them, so no session or chat could list a
  // connector's tools on a ledger-off node. The schema is the authority on
  // what it accepts; when the caller has it, ask it too.
  if (schemaForbidsClientMutationId(schema)) return body;

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
