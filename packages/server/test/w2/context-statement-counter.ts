import type { Db, DbClaims, Querier } from '../../src/db/types.js';

/**
 * Statements per `entities.context:<section>` tag (M2/S2; c904 §5 test 8,
 * c761 §10 tests 5 and 8).
 *
 * Select-before-load is a claim about DATABASE work, so it is asserted by
 * counting the statements that ran, not by reading the output: a section that
 * is loaded and then dropped renders exactly like one never loaded.
 *
 * It patches `db` IN PLACE rather than returning a wrapper, so one counter
 * serves both the unit suite's fake and the production pool behind the public
 * harness, where the facade already holds the `db` reference.
 */
export interface StatementCounter {
  /** Every statement since the last `reset`, as issued. */
  readonly statements: readonly string[];
  /** Counts by section tag; statements without one count as `(untagged)`. */
  byTag(): Record<string, number>;
  total(): number;
  reset(): void;
  restore(): void;
}

export const UNTAGGED = '(untagged)';

export function contextTagOf(sql: string): string {
  return /^\s*\/\* entities\.context:([a-zA-Z]+) \*\//.exec(sql)?.[1] ?? UNTAGGED;
}

export function countStatements(db: Db): StatementCounter {
  const statements: string[] = [];
  const counted = (q: Querier): Querier => ({
    query: <R = Record<string, unknown>>(sql: string, params?: readonly unknown[]) => {
      statements.push(sql);
      return q.query<R>(sql, params);
    },
    rpc: <T = unknown>(fn: string, args?: readonly unknown[]) => {
      statements.push(`rpc ${fn}`);
      return q.rpc<T>(fn, args);
    },
  });

  const target = db as { -readonly [K in keyof Db]: Db[K] };
  const original = { tx: target.tx, query: target.query, rpc: target.rpc };
  target.tx = <T>(claims: DbClaims, fn: (q: Querier) => Promise<T>) =>
    original.tx.call(db, claims, (q: Querier) => fn(counted(q))) as Promise<T>;
  // One-statement reads go through the counted `tx`, which is exactly what
  // `PgDb.query`/`rpc` do themselves; patching them separately would count a
  // production statement twice.
  target.query = <R = Record<string, unknown>>(
    claims: DbClaims, sql: string, params?: readonly unknown[],
  ) => target.tx(claims, (q) => q.query<R>(sql, params));
  target.rpc = <T = unknown>(claims: DbClaims, fn: string, args?: readonly unknown[]) =>
    target.tx(claims, (q) => q.rpc<T>(fn, args));

  return {
    statements,
    byTag() {
      const counts: Record<string, number> = {};
      for (const sql of statements) {
        const tag = contextTagOf(sql);
        counts[tag] = (counts[tag] ?? 0) + 1;
      }
      return counts;
    },
    total: () => statements.length,
    reset() {
      statements.length = 0;
    },
    restore() {
      Object.assign(target, original);
    },
  };
}
