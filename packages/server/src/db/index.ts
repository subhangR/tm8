/**
 * The db block's public seam.
 *
 * `db/types.ts` is the FROZEN interface every lane codes against; this file
 * adds the one concrete implementation and the error translation, and nothing
 * else. The composition root (`main.ts`) is the only caller of `createDb` —
 * no module constructs a pool at import time, because a pool created on import
 * is a pool that outlives the server it belongs to.
 */
export type { Db, DbClaims, Querier } from './types.js';
export { createDb, PgDb, type PgDbOptions } from './client.js';
export { translateDbError, sqlStateToCode } from './errors.js';
