/**
 * WHOSE KEY Ask Jev spends (Lane K). Resolved per request, never once at
 * startup:
 *
 *   1. the CALLER's own stored `typesafe` key (Settings → agent credentials);
 *   2. otherwise the node's `TYPESAFE_API_KEY`, which keeps the single-machine
 *      path working exactly as before;
 *   3. otherwise none — every group answers `failed: no_key`.
 *
 * A member's key is only ever read with THAT member's claims: the store's RPC
 * derives the account from the transaction identity and takes no account id,
 * so one member's request cannot reach another member's key, and the advisor
 * cache below is keyed by the key itself, so a cached client can only ever
 * carry the key that built it.
 *
 * Only a HUMAN session (browser | cli) reads a member key. An agent token
 * carries its owner's identity, and 203's read RPC refuses it anyway; asking
 * would only log a refusal, so an agent's request goes straight to rung 2.
 *
 * This file does not import `@tm8/jev`: building a client from a key is
 * `advisorForKey`, which main.ts takes from `jev-adapter.ts`.
 */
import type { DbClaims } from '../db/types.js';
import type { JevAdvisorPort, JevAdvisorResolver } from './port.js';

const HUMAN_AUTH_KINDS: ReadonlySet<string> = new Set(['browser', 'cli']);

export interface JevAdvisorResolverDeps {
  /** The caller's own stored key, or null. May throw (store absent, unreadable). */
  readMemberKey(claims: DbClaims): Promise<string | null>;
  /** The node's key, or null/empty when the environment has none. */
  nodeKey: string | null | undefined;
  /** A Jev advisor bound to exactly this key. */
  advisorForKey(apiKey: string): JevAdvisorPort;
  logger?: { warn?: (message: string, fields?: Record<string, unknown>) => void };
}

export function createJevAdvisorResolver(deps: JevAdvisorResolverDeps): JevAdvisorResolver {
  const nodeKey = deps.nodeKey?.trim() || null;
  return async (claims) => {
    if (claims.authKind && HUMAN_AUTH_KINDS.has(claims.authKind)) {
      let memberKey: string | null = null;
      try {
        memberKey = (await deps.readMemberKey(claims))?.trim() || null;
      } catch (error) {
        // An unreadable or absent store is not a reason to fail Ask Jev when
        // the node can still answer. Never logs the key; the error carries none.
        deps.logger?.warn?.('member TypeSafe key could not be read; using the node key if any', {
          reason: error instanceof Error ? error.message : 'unknown',
        });
      }
      if (memberKey) return deps.advisorForKey(memberKey);
    }
    return nodeKey ? deps.advisorForKey(nodeKey) : null;
  };
}
