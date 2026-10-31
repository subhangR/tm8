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
import type { ZodTypeAny } from 'zod';

import { commandAcceptsClientMutationId, type OperationBinding } from '@tm8/contract';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whether the op's own input schema admits a `clientMutationId`. A `.strict()`
 * object that does not declare one refuses the injected id as an unrecognized
 * key — which is how `mcp.proxy.request` answered 400 to every connector call
 * from every chat and session, and how `chat.interrupt`, `mcp.oauth.callback`,
 * `spaceLinks.invoke`, `bridges.listen` and four more failed the same way on a
 * server with the ledger off. Unknown schema shapes keep the old behaviour.
 */
function schemaAcceptsClientMutationId(schema: ZodTypeAny | undefined): boolean {
  // By `typeName`, not `instanceof`: the contract's schemas may come from a
  // different zod copy than this package's, and instanceof would then say
  // "not an object" and quietly keep injecting.
  type Def = { typeName?: string; schema?: ZodTypeAny; unknownKeys?: string; shape?: () => Record<string, unknown> };
  let def = schema?._def as Def | undefined;
  while (def?.typeName === 'ZodEffects' && def.schema) def = def.schema._def as Def;
  if (def?.typeName !== 'ZodObject' || typeof def.shape !== 'function') return true;
  if ('clientMutationId' in def.shape()) return true;
  return def.unknownKeys !== 'strict';
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
  // The schema has the last word: never inject a key a strict DTO refuses.
  if (!schemaAcceptsClientMutationId(schema)) return body;

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
