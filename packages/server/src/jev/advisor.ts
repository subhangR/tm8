/**
 * WHOSE KEY Ask Jev spends (Lane K; credentials spec 01a0e248 decision 10).
 * Resolved per request, never once at startup:
 *
 *   1. the SPACE's `typesafe` credential (server_only_space_credentials):
 *      the caller's my_default in this space, else the space default —
 *      `read_space_service_key` picks, and reads my_default for HUMAN auth
 *      kinds only, so an agent-driven Ask Jev falls to the space default;
 *   2. otherwise none — every group answers `failed: no_key`.
 *
 * There is no member or node fallback. Release 2 (S6-removal) deleted the
 * caller's 203 key and the node's `TYPESAFE_API_KEY`: a space that wants Ask
 * Jev connects a `typesafe` credential in Space → Credentials.
 *
 * The advisor cache (`jev-adapter.ts`) is keyed by the key itself, so a
 * cached client can only ever carry the key that built it.
 *
 * This file does not import `@tm8/jev`: building a client from a key is
 * `advisorForKey`, which main.ts takes from `jev-adapter.ts`.
 */
import type { DbClaims } from '../db/types.js';
import type { JevAdvisorPort, JevAdvisorResolver } from './port.js';

export interface JevAdvisorResolverDeps {
  /**
   * The space's `typesafe` credential for this caller (my_default, else the
   * space default), or null when the space holds none. May throw (not a
   * member, store absent, unreadable); a throw is `no_key`.
   */
  readSpaceKey(claims: DbClaims, spaceId: string): Promise<string | null>;
  /** A Jev advisor bound to exactly this key. */
  advisorForKey(apiKey: string): JevAdvisorPort;
  logger?: { warn?: (message: string, fields?: Record<string, unknown>) => void };
}

export function createJevAdvisorResolver(deps: JevAdvisorResolverDeps): JevAdvisorResolver {
  return async (claims, request) => {
    // Without a space there is no credential to read: `no_key`, not a guess.
    if (!request?.spaceId) return null;
    let spaceKey: string | null = null;
    try {
      spaceKey = (await deps.readSpaceKey(claims, request.spaceId))?.trim() || null;
    } catch (error) {
      // Never logs the key; the error carries none.
      deps.logger?.warn?.('space TypeSafe credential could not be read; Ask Jev answers no_key', {
        reason: error instanceof Error ? error.message : 'unknown',
      });
    }
    return spaceKey ? deps.advisorForKey(spaceKey) : null;
  };
}
