/**
 * What every handler is given, and nothing more.
 *
 * Handlers receive `db` and a memoized `owner()` — no pool, no config beyond
 * what they need, no registry. A handler that cannot reach the composition
 * root cannot quietly grow a second database connection or a second identity
 * path, which is the failure this narrow shape exists to prevent.
 */
import type { Db } from '../db/types.js';
import type { ServerConfig } from '../http/config.js';
import type { LoopbackOwner } from '../identity/loopback.js';

export interface FacadeDeps {
  readonly db: Db;
  readonly config: ServerConfig;
  /** The v1 loopback auto-owner, resolved once per process. */
  readonly owner: () => Promise<LoopbackOwner>;
}
