import { AsyncLocalStorage } from 'node:async_hooks';
import pg, { type PoolClient, type PoolConfig, type QueryResultRow } from 'pg';
import { AuditUnavailableError, StoreDuplicateError, StoreNotFoundError, StoreScopeError, StoreStateError, StoreUnavailableError, StoreVersionConflictError, effectiveApprovalState, systemClock, type Clock, type StoreScope, type VaultStore, type VaultTx } from '../core-types.js';
import { checkScope, iso } from './validation.js';
import { PgCtx } from './postgres-repos.js';

export interface PgVaultStoreOptions {
  connectionString?: string;
  pool?: pg.Pool;
  poolOptions?: PoolConfig;
  clock?: Clock;
  /** SET LOCAL ROLE is useful with a migration/test login. Normal broker logins already have this role. */
  role?: 'tm8_vault_broker';
}

/** READ COMMITTED; each repository call has its own savepoint, never an external side effect. */
export class PgVaultStore implements VaultStore {
  readonly #pool: pg.Pool;
  readonly #ownsPool: boolean;
  readonly #clock: Clock;
  readonly #role: 'tm8_vault_broker' | undefined;
  readonly #inTransaction = new AsyncLocalStorage<true>();
  #closed = false;
  /** Deterministic outage injection; production code never enables these. */
  readonly faults = { unavailable: false, auditAppend: false };

  constructor(options: PgVaultStoreOptions = {}) {
    this.#pool = options.pool ?? new pg.Pool({ ...options.poolOptions, connectionString: options.connectionString });
    this.#ownsPool = options.pool === undefined;
    this.#clock = options.clock ?? systemClock;
    this.#role = options.role;
    this.#pool.on('connect', (client) => client.on('error', () => undefined));
    this.#pool.on('error', () => { /* No raw driver errors or connection data reach logs. */ });
  }

  async transaction<T>(scope: StoreScope, fn: (tx: VaultTx) => Promise<T>): Promise<T> {
    if (this.#inTransaction.getStore()) throw new Error('vault store: nested transaction');
    const checked = checkScope(scope);
    const now = iso(this.#clock.now().toISOString(), 'clock');
    if (this.#closed || this.faults.unavailable) throw new StoreUnavailableError();
    let client: PoolClient;
    try { client = await this.#pool.connect(); }
    catch { throw new StoreUnavailableError(); }
    let ctx: PgCtx | undefined;
    let connectionFailed = false;
    const lost = (): void => { connectionFailed = true; ctx?.kill('store'); };
    client.on('error', lost);
    try {
      try {
        await client.query('begin isolation level read committed');
        if (this.#role) await client.query('set local role tm8_vault_broker');
        await client.query("select set_config('vault.member_id', $1, true), set_config('vault.space_id', $2, true), set_config('vault.system_purpose', $3, true), set_config('vault.at', $4, true)", [checked.kind === 'member' ? checked.memberId : '', checked.kind === 'member' ? checked.spaceId : '', checked.kind === 'system' ? checked.purpose : '', now]);
      } catch { throw new StoreUnavailableError(); }
      ctx = new PgCtx(client, checked, now, this.#clock, this.faults);
      const result = await this.#inTransaction.run(true, () => fn(ctx!.tx));
      await ctx.drain();
      if (connectionFailed || this.faults.unavailable) ctx.kill('store');
      ctx.enter();
      try { await client.query('commit'); }
      catch { throw new StoreUnavailableError(); }
      return result;
    } catch (error) {
      try { await client.query('rollback'); } catch { connectionFailed = true; }
      throw error;
    } finally {
      if (ctx) ctx.closed = true;
      client.removeListener('error', lost);
      client.release(connectionFailed || ctx?.dead === 'store');
    }
  }

  async health(): Promise<{ ok: boolean }> {
    if (this.#closed || this.faults.unavailable) return { ok: false };
    try { await this.#pool.query('select 1'); return { ok: true }; }
    catch { return { ok: false }; }
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#ownsPool) await this.#pool.end();
  }
}
