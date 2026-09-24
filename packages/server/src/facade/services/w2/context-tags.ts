/**
 * Split out of `feed-context.ts` (M2/S3a) so the v2 projection in
 * `feed-context-v2.ts` tags its statements with the same helpers without an
 * import cycle. `feed-context.ts` re-exports everything here.
 */
import type { Db, DbClaims, Querier } from '../../../db/types.js';

/**
 * The tag every `entities.context` statement carries, by the loader it serves.
 *
 * c904 §2.6 / §5 test 8: "select before load" is asserted by COUNTING tagged
 * statements, not by reading the output — a section that is loaded and then
 * dropped looks identical to one never loaded. So the tag has to reach every
 * statement, including those issued inside shared helpers (`assembleSummaries`,
 * `loadActors`, `loadMessageViewsByIds`) and the actions palette's own
 * transaction; `taggedQuerier` / `taggedDb` put it there. It is a leading SQL
 * comment so the same attribution shows up in `pg_stat_statements` and logs.
 */
export const CONTEXT_LOAD_TAGS = [
  'root', 'summary', 'parents', 'children', 'edges', 'messages', 'activity', 'seq', 'actions',
  // v2 only (M2/S3a): each v2 section loader has its own tag, so the
  // statement counter can prove what the v2 default does NOT load.
  'assignees', 'blockers', 'gate', 'tasks', 'connections',
  // The selection header (headers design T3): one statement, header kinds only.
  'header',
] as const;
export type ContextLoadTag = (typeof CONTEXT_LOAD_TAGS)[number];

function contextTag(tag: ContextLoadTag): string {
  return `/* entities.context:${tag} */`;
}

function tagSql(tag: ContextLoadTag, sql: string): string {
  const prefix = contextTag(tag);
  return sql.startsWith(prefix) ? sql : `${prefix}\n${sql}`;
}

/** `q`, with every statement it issues led by `tag`. */
export function taggedQuerier(q: Querier, tag: ContextLoadTag): Querier {
  return {
    query: <R = Record<string, unknown>>(sql: string, params?: readonly unknown[]) =>
      q.query<R>(tagSql(tag, sql), params),
    rpc: <T = unknown>(fn: string, args?: readonly unknown[]) => q.rpc<T>(fn, args),
  };
}

/** `db`, with every statement it issues — in any transaction — led by `tag`. */
export function taggedDb(db: Db, tag: ContextLoadTag): Db {
  return {
    tx: <T>(claims: DbClaims, fn: (q: Querier) => Promise<T>) =>
      db.tx(claims, (q) => fn(taggedQuerier(q, tag))),
    rpc: <T = unknown>(claims: DbClaims, fn: string, args?: readonly unknown[]) =>
      db.rpc<T>(claims, fn, args),
    query: <R = Record<string, unknown>>(claims: DbClaims, sql: string, params?: readonly unknown[]) =>
      db.query<R>(claims, tagSql(tag, sql), params),
    end: () => db.end(),
  };
}
