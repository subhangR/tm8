/**
 * PostgreSQL store entry point. Acquire every advisory lock before the first
 * audit append: the append holds the global head row until commit. The store
 * refuses new advisory keys afterwards and treats 40P01/40001 as unavailable.
 */
export { PgVaultStore, type PgVaultStoreOptions } from './postgres.js';
