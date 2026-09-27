/**
 * WHOSE KEY Ask Jev spends (Lane K; credentials release 1, S6 storage half).
 * Resolved per request, never once at startup:
 *
 *   1. the SPACE's `typesafe` credential (server_only_space_credentials, spec 01a0e248 decision 10):
 *      the caller's my_default in this space, else the space default —
 *      `read_space_service_key` picks, and reads my_default for HUMAN auth
 *      kinds only, so an agent-driven Ask Jev falls to the space default;
 *   2. [release 1 only] the CALLER's own stored 203 `typesafe` key
 *      (Settings → agent credentials);
 *   3. [release 1 only] the node's `TYPESAFE_API_KEY`;
 *   4. otherwise none — every group answers `failed: no_key`.
 *
 * Rungs 2 and 3 are the unchanged pre-server_only_space_credentials chain. Release 2 (S6-removal, S8)
 * deletes them; nothing here decides that.
 *
 * A member's key is only ever read with THAT member's claims: both store RPCs
 * derive the account from the transaction identity and take no account id,
 * so one member's request cannot reach another member's key, and the advisor
 * cache below is keyed by the key itself, so a cached client can only ever
 * carry the key that built it.
 *
 * Only a HUMAN session (browser | cli) reads a 203 member key. An agent token
 * carries its owner's identity, and 203's read RPC refuses it anyway; asking
 * would only log a refusal, so an agent's request skips rung 2.
 *
 * This file does not import `@tm8/jev`: building a client from a key is
 * `advisorForKey`, which main.ts takes from `jev-adapter.ts`.
 */
import type { DbClaims } from '../db/types.js';
import type { JevAdvisorPort, JevAdvisorResolver } from './port.js';

const HUMAN_AUTH_KINDS: ReadonlySet<string> = new Set(['browser', 'cli']);

export interface JevAdvisorResolverDeps {
  /**
   * Rung 1: the space's `typesafe` credential for this caller (my_default,
   * else the space default), or null when the space holds none. May throw
   * (not a member, store absent, unreadable); a throw falls to rung 2.
   */
  readSpaceKey?(claims: DbClaims, spaceId: string): Promise<string | null>;
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
  return async (claims, request) => {
    if (deps.readSpaceKey && request?.spaceId) {
      let spaceKey: string | null = null;
      try {
        spaceKey = (await deps.readSpaceKey(claims, request.spaceId))?.trim() || null;
      } catch (error) {
        // Release 1 is additive: an unreadable space key falls to the old
        // rungs. Never logs the key; the error carries none.
        deps.logger?.warn?.('space TypeSafe credential could not be read; trying the member and node keys', {
          reason: error instanceof Error ? error.message : 'unknown',
        });
      }
      if (spaceKey) return deps.advisorForKey(spaceKey);
    }
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
