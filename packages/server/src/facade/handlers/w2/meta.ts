/**
 * `meta.get` — GET /v2/meta: what this node speaks (TM8 Mobile s-lld §4,
 * version signals). One read replaces probing operation by operation, and it
 * lets a node refuse a too-old client in words before that client signs in.
 *
 * ANONYMOUS-READABLE, like `auth.claim.status` and `/health`, and for the same
 * reason: a client asks it while it adds a server, before it has sent a
 * password, to decide whether it may sign in at all. The handler reads no
 * identity and touches no database. Nothing in the answer is about a member, a
 * space, a session or a setting; `/health` already publishes the contract
 * version, and the catalog ships inside every tm8 client.
 * `space-gate.ts` admits it for a gate session too, so a signed-in caller is
 * never refused what a stranger may read.
 *
 * EVERY FIELD IS DERIVED, NEVER KEPT BY HAND:
 *  - `contractVersion` — `CONTRACT_VERSION`.
 *  - `catalogSha256` — sha256 of `JSON.stringify(OPERATIONS)`, the digest the
 *    CLI pins as `CATALOG_DIGEST` and every help shard prints. Computed once:
 *    the catalog is static for the life of the process.
 *  - `eventSchemaVersion` — `WORKSPACE_EVENT_SCHEMA_VERSION`.
 *  - `features` — the catalog rows whose status is `v1` and that this node
 *    mounts, re-read from the registry on every call. An HTTP row is mounted when
 *    a handler is registered: without one it answers 501, so listing it would
 *    be a promise the node breaks. A socket row (`events.subscribe` and its alias
 *    `containers.stream`) is served by the server frame's upgrade path, which
 *    the composition root always mounts; the registry holds no socket handlers.
 *    MOUNTED IS NOT AVAILABLE, and the contract says so: a few families mount
 *    every row and answer 501 with a reason while a switch is off (containers
 *    under TM8_CONTAINERS=off, tools with no runtime, voice with no LiveKit).
 *    The registry cannot tell those apart without calling them, and a read may
 *    not call a handler, so they stay listed and their 501 names the switch.
 *  - `minClients` — `MIN_CLIENT_VERSIONS`, below.
 */
import { createHash } from 'node:crypto';

import {
  CONTRACT_VERSION,
  OPERATIONS,
  WORKSPACE_EVENT_SCHEMA_VERSION,
  type MetaGetResult,
} from '@tm8/contract';

import type { HandlerRegistry } from '../../registry.js';

export const CATALOG_SHA256 = createHash('sha256').update(JSON.stringify(OPERATIONS)).digest('hex');

/**
 * The oldest version of each client this node serves, keyed by the name its
 * `x-tm8-client` header starts with (`tm8-mobile`).
 *
 * EMPTY, because it is true: every client version that exists speaks this
 * contract, so no client is refused by version. The change that first breaks an
 * older app adds that app's entry here, in the same commit, naming the first
 * version that speaks the new contract.
 */
export const MIN_CLIENT_VERSIONS: Readonly<Record<string, string>> = {};

/** The operations this node answers, in catalog order. */
export function metaFeatures(registry: Pick<HandlerRegistry, 'has'>): string[] {
  return OPERATIONS
    .filter((op) => op.status === 'v1' && (op.method === 'WS' || registry.has(op.name)))
    .map((op) => op.name);
}

export function registerW2MetaHandlers(registry: HandlerRegistry): void {
  registry.register('meta.get', async () => {
    const result: MetaGetResult = {
      contractVersion: CONTRACT_VERSION,
      catalogSha256: CATALOG_SHA256,
      eventSchemaVersion: WORKSPACE_EVENT_SCHEMA_VERSION,
      features: metaFeatures(registry),
      minClients: { ...MIN_CLIENT_VERSIONS },
    };
    return result;
  });
}
