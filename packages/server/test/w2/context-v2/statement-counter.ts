/**
 * A statement counter for the `entities.context` acceptance suite (Module 2,
 * c904 §5 test 8 and c761 §10 tests 5 and 8).
 *
 * "`--sections X` skips loading X" is a claim about DATABASE WORK, so it has to
 * be asserted where the work happens — on the querier — and never inferred from
 * what the response printed. This wraps a `Db` so every statement a handler
 * issues is recorded with the section its SQL is tagged for:
 *
 *   /* entities.context:<section> *\/  select …
 *
 * Statements with no tag are counted as well, under `null`. Today most of the
 * summary/actor/ancestor reads a context call makes are untagged; S2 tags every
 * section loader, and the suite asserts the untagged count reaches zero then.
 *
 * `attributeSql(pattern, section)` exists for work that reaches the database
 * through a seam the context service does not own — the `actions` section is
 * served by G09's discoverer (`actions.list`), whose SQL carries no
 * `entities.context` tag. An untagged statement matching `pattern` is recorded
 * as `section`, so "was actions loaded?" has one answer whichever path loaded
 * it.
 *
 * `failOn(section)` makes the NEXT statements tagged `section` reject before
 * they reach PostgreSQL — the fault a partial-failure test needs ("a list
 * section whose loader failed lands in `errors[]`"). Thrown client-side so the
 * transaction is not aborted, which is what a real per-section failure behind a
 * savepoint would look like to the assembler.
 *
 * Test-only. Nothing in `src/` imports it.
 */
import type { Db, DbClaims, Querier } from '../../../src/db/types.js';

export const CONTEXT_TAG = /\/\*\s*entities\.context:([a-z_]+)\s*\*\//;

export interface CountedStatement {
  /** The `entities.context:<section>` tag, the attributed section, or null. */
  readonly tag: string | null;
  /** True when the tag came from `attributeSql()` rather than the SQL itself. */
  readonly attributed: boolean;
  readonly sql: string;
}

export class StatementCounter {
  readonly statements: CountedStatement[] = [];
  private readonly attributions: Array<{ pattern: RegExp; section: string }> = [];
  private readonly faults = new Set<string>();

  reset(): void {
    this.statements.length = 0;
  }

  failOn(section: string): this {
    this.faults.add(section);
    return this;
  }

  clearFaults(): void {
    this.faults.clear();
  }

  /** Records the statement; answers the injected fault for it, if any. */
  record(sql: string): Error | null {
    const tag = CONTEXT_TAG.exec(sql)?.[1] ?? null;
    const attributed = tag === null
      ? this.attributions.find((a) => a.pattern.test(sql))?.section ?? null
      : null;
    const section = tag ?? attributed;
    this.statements.push({ tag: section, attributed: attributed !== null, sql });
    return section !== null && this.faults.has(section)
      ? new Error(`injected fault: entities.context:${section}`)
      : null;
  }

  /** Every statement, tagged or not. */
  total(): number {
    return this.statements.length;
  }

  /** Statements whose SQL carried (or was attributed) this section. */
  count(section: string): number {
    return this.statements.filter((s) => s.tag === section).length;
  }

  /** Statements with no `entities.context:*` tag and no attribution. */
  untagged(): CountedStatement[] {
    return this.statements.filter((s) => s.tag === null);
  }

  /** `{ root: 1, children: 1, …, '(untagged)': 7 }` — for measurement output. */
  byTag(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const s of this.statements) {
      const key = s.tag ?? '(untagged)';
      out[key] = (out[key] ?? 0) + 1;
    }
    return out;
  }

  attributeSql(pattern: RegExp, section: string): this {
    this.attributions.push({ pattern, section });
    return this;
  }

  wrapQuerier(q: Querier): Querier {
    return {
      query: <R>(sql: string, params?: readonly unknown[]) => {
        const fault = this.record(sql);
        return fault ? Promise.reject(fault) : q.query<R>(sql, params);
      },
      rpc: <T>(fn: string, args?: readonly unknown[]) => {
        this.record(`/* rpc */ select ${fn}(…)`);
        return q.rpc<T>(fn, args);
      },
    };
  }

  wrapDb(db: Db): Db {
    return {
      tx: <T>(claims: DbClaims, fn: (q: Querier) => Promise<T>) =>
        db.tx(claims, (q) => fn(this.wrapQuerier(q))),
      rpc: <T>(claims: DbClaims, fn: string, args?: readonly unknown[]) => {
        this.record(`/* rpc */ select ${fn}(…)`);
        return db.rpc<T>(claims, fn, args);
      },
      query: <R>(claims: DbClaims, sql: string, params?: readonly unknown[]) => {
        const fault = this.record(sql);
        return fault ? Promise.reject(fault) : db.query<R>(claims, sql, params);
      },
      end: () => db.end(),
    };
  }
}
