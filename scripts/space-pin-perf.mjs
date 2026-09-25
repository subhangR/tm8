#!/usr/bin/env node
/**
 * W0a (226/227) read-path cost: `collections.query` — the entity-list read that
 * runs ENTITY_FROM under entities_select — timed with and without the session
 * pin, on one database. Run it on the baseline (main) and again after 226/227.
 *
 *   TM8_DATABASE_URL=postgres://tm8@127.0.0.1:5443/<prod-copy> \
 *   SPACE_ID=<a busy space> IDENTITY_ID=<a member of it and of other spaces> \
 *   [ACTOR_ID=<that identity's member entity in SPACE_ID>] [ITER=300] [LIMIT=50] \
 *   node scripts/space-pin-perf.mjs
 *
 * Needs `npx tsc -b` in packages/server first (it imports dist/, so the SQL is
 * the server's own, not a copy). Read-only: every statement is a SELECT or an
 * EXPLAIN ANALYZE of one, inside a transaction.
 *
 * Six claims per transaction, the production binder (BIND_CLAIMS_SQL):
 *   identity_id, actor_id, node_admin=false, request_id, auth_kind='agent',
 *   session_space_id = ''        (unpinned: 227's helpers are their old bodies)
 *                    = SPACE_ID  (pinned: the W0a agent path)
 * On a pre-226 database the sixth claim is bound but read by nothing, so the
 * same command gives the baseline.
 *
 * Output: p50/p95/p99 ms of the whole transaction (claims bind + page query +
 * total query), and from one EXPLAIN (ANALYZE, BUFFERS, VERBOSE) of the page
 * query: planning/execution ms, shared hit/read buffers, each InitPlan that
 * calls member_space_ids() with its loops (each <= 1; 0 = that branch never
 * ran), and which of is_space_member / entity_readable / entity_row_visible
 * appear in the plan. entities_select calls entity_row_visible per row by
 * design (159, SECURITY DEFINER so never inlined): the check is that the set is
 * the SAME before and after 226/227, not that it is empty.
 *
 * The once-per-statement guarantees are counted separately by
 *   packages/server/test/db/rls-membership-once-per-statement.pg.test.ts
 *   packages/server/test/db/secdef-membership-once-per-statement.pg.test.ts
 */
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DIST = join(dirname(fileURLToPath(import.meta.url)), '..', 'packages', 'server', 'dist');
const { createDb } = await import(pathToFileURL(join(DIST, 'db', 'client.js')).href);
const { queryCollection } = await import(pathToFileURL(join(DIST, 'facade', 'handlers', 'collections.js')).href);

const need = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const url = need('TM8_DATABASE_URL');
const spaceId = need('SPACE_ID');
const identityId = need('IDENTITY_ID');
const actorId = process.env.ACTOR_ID || undefined;
const iterations = Number(process.env.ITER ?? 300);
const limit = Number(process.env.LIMIT ?? 50);

const db = createDb(url, { max: 1 });
const claimsFor = (pin) => ({
  identityId,
  ...(actorId ? { actorId } : {}),
  nodeAdmin: false,
  requestId: `space-pin-perf-${randomUUID()}`,
  authKind: 'agent',
  ...(pin ? { sessionSpaceId: pin } : {}),
});
const query = { spaceId, limit };

/** Every statement queryCollection issues, recorded on the first call. */
async function captureSql(pin) {
  const seen = [];
  await db.tx(claimsFor(pin), (q) => queryCollection(new Proxy(q, {
    get(target, key) {
      const value = target[key];
      if (key !== 'query') return typeof value === 'function' ? value.bind(target) : value;
      return (sql, params) => { seen.push({ sql, params }); return target.query(sql, params); };
    },
  }), query, identityId));
  return seen;
}

function walk(node, visit) {
  visit(node);
  for (const child of node.Plans ?? []) walk(child, visit);
}

async function explain(pin, { sql, params }) {
  const [row] = await db.tx(claimsFor(pin), (q) =>
    q.query(`explain (analyze, buffers, verbose, format json) ${sql}`, params));
  const doc = row['QUERY PLAN'][0];
  const initPlans = [];
  const perRow = new Set();
  walk(doc.Plan, (n) => {
    const text = JSON.stringify({ ...n, Plans: undefined });
    if (n['Parent Relationship'] === 'InitPlan' && text.includes('member_space_ids')) {
      initPlans.push({ name: n['Subplan Name'], loops: n['Actual Loops'] });
    }
    for (const fn of ['is_space_member', 'entity_readable', 'entity_row_visible']) {
      if (text.includes(`${fn}(`)) perRow.add(fn);
    }
  });
  return {
    planningMs: doc['Planning Time'],
    executionMs: doc['Execution Time'],
    sharedHit: doc.Plan['Shared Hit Blocks'],
    sharedRead: doc.Plan['Shared Read Blocks'],
    memberSpaceIdsInitPlans: initPlans,
    perRowMembershipCalls: [...perRow],
  };
}

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];

async function measure(label, pin) {
  for (let i = 0; i < 20; i += 1) await db.tx(claimsFor(pin), (q) => queryCollection(q, query, identityId));
  const ms = [];
  for (let i = 0; i < iterations; i += 1) {
    const start = process.hrtime.bigint();
    await db.tx(claimsFor(pin), (q) => queryCollection(q, query, identityId));
    ms.push(Number(process.hrtime.bigint() - start) / 1e6);
  }
  ms.sort((a, b) => a - b);
  const [page] = await captureSql(pin);
  return {
    label,
    iterations,
    p50: +pct(ms, 50).toFixed(2),
    p95: +pct(ms, 95).toFixed(2),
    p99: +pct(ms, 99).toFixed(2),
    plan: await explain(pin, page),
  };
}

try {
  const results = [await measure('unpinned', ''), await measure('pinned', spaceId)];
  console.log(JSON.stringify({ spaceId, limit, results }, null, 2));
} finally {
  await db.end();
}
