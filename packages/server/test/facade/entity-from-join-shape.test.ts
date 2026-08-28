/**
 * THE `ENTITY_FROM` JOIN-SHAPE GUARD — the #518 bug class, made unrepeatable.
 *
 * `ENTITY_FROM` left-joins ~25 detail tables onto `public.entities`. How you
 * FILTER that chain decides whether a read costs milliseconds or minutes, and
 * the difference is invisible at the call site:
 *
 *   - Filter on `e.*` (or join something to `e.id`) and the planner drives the
 *     chain from an index on `entities`, visiting each detail table once.
 *   - Filter ONLY on a table INSIDE the chain — `msg.anchor_id`, say — and it
 *     has no id to drive from, so it rebuilds the whole chain per candidate row.
 *
 * That is not a micro-optimisation. Measured on live prod data under real RLS
 * claims, full `ENTITY_COLUMNS`, opening one 71-reply chat thread:
 *
 *   - filtered on `msg`:  `Seq Scan on entities` at `loops=71`, 6,130,184
 *     shared buffer hits, 609,180 rows discarded by a join filter,
 *     **86,916 ms** — well past `statement_timeout`, so it never returns at
 *     all. The caller sees SQLSTATE 57014 and a 503.
 *   - filtered on `e.id`: **78 ms**, for the identical rows.
 *
 * Two things make the bad plan worse than it looks, and both defeat review by
 * eye. The RLS predicates (`internal.entity_readable`,
 * `internal.entity_row_visible`) are SECURITY DEFINER and cannot be inlined, so
 * the planner cannot estimate their selectivity and concludes the rescan is
 * free. And the `Sort` lands ABOVE the join, so `limit` discards nothing —
 * `limit 1` and `limit 100` cost the same. A reviewer reasoning "it is only a
 * hundred rows" is reasoning about a plan Postgres did not choose.
 *
 * So this test reads the SOURCE rather than running SQL: the defect is a shape,
 * it is introduced by writing a new query, and it should be caught at review
 * time on any machine, with no database and no heavy fixture. The pg-level
 * companion that proves the timings is
 * `test/db/chat-thread-heavy-tool-results.pg.test.ts`.
 *
 * WHAT THIS DOES NOT CATCH, stated so nobody trusts it further than it goes: a
 * query assembled from fragments this scanner cannot see as one string, and any
 * `ENTITY_FROM` use outside `packages/server/src`. It is a guard against the
 * known shape, not a proof of overall query health.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_SRC = fileURLToPath(new URL('../../src', import.meta.url));
const REPO_REL = (abs: string): string => relative(SERVER_SRC, abs).replaceAll('\\', '/');

/**
 * Sites whose WHERE is assembled at runtime, so the scanner cannot read the
 * predicates out of the template.
 *
 * An allowlist rather than a silent skip: adding one is a deliberate act that
 * shows up in review, and each entry has to say why the site is safe. All three
 * are `queryCollection`'s reads, which share `buildWhere` — and `buildWhere`
 * SEEDS `e.space_id` as its first predicate before any caller-supplied filter,
 * so the chain is always anchored on `entities` no matter what the query asks
 * for. That seeding is asserted separately below, so this list cannot quietly
 * become a way to opt out of the property.
 */
const DYNAMIC_WHERE_ALLOWLIST = new Map<string, string>([
  ['facade/handlers/collections.ts', 'buildWhere() seeds e.space_id; asserted below'],
]);

/** The aliases `ENTITY_FROM` binds — everything a predicate could sit on. */
const DETAIL_ALIASES = [
  'ec', 't', 'd', 'ch', 'vc', 'mem', 'tm', 'col', 'ws', 'wsp', 'msg', 'f',
  'ppd', 'ip', 'profile_version', 'memo', 'wt', 'lp', 'gr', 'pr', 'art', 'arev',
];

interface Site {
  readonly file: string;
  readonly line: number;
  readonly sql: string;
  readonly where: string;
}

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) return tsFiles(abs);
    return name.endsWith('.ts') ? [abs] : [];
  });
}

/**
 * Every `${ENTITY_FROM}` interpolation, with the template literal it sits in.
 *
 * The enclosing literal is found by walking out to the nearest backtick on
 * either side. That is crude, and it is sufficient here precisely because these
 * are SQL templates: they are opened and closed on the query, and none of them
 * nests a second literal inside itself. If that ever stops being true this
 * finds a wrong span and the assertion below fails loudly rather than passing
 * silently, which is the correct direction for a guard to be wrong in.
 */
function entityFromSites(): Site[] {
  const sites: Site[] = [];
  for (const abs of tsFiles(SERVER_SRC)) {
    const source = readFileSync(abs, 'utf8');
    for (const match of source.matchAll(/\$\{ENTITY_FROM\}/g)) {
      const at = match.index;
      const open = source.lastIndexOf('`', at);
      const close = source.indexOf('`', at + match[0].length);
      if (open < 0 || close < 0) continue;
      const sql = source.slice(open + 1, close);
      const where = /\bwhere\b([\s\S]*?)(?:\border\s+by\b|\bgroup\s+by\b|\blimit\b|$)/i.exec(sql);
      sites.push({
        file: REPO_REL(abs),
        line: source.slice(0, at).split('\n').length,
        sql,
        where: where ? where[1] : '',
      });
    }
  }
  return sites;
}

/** Does anything pin the read to a row of `entities` the planner can start from? */
function isAnchored(site: Site): boolean {
  // A predicate on the envelope itself.
  if (/\be\.(id|parent_id|space_id)\b/.test(site.where)) return true;
  // …or an explicit join that supplies `e.id` from elsewhere, which anchors it
  // just as well (`entities-commands-tracking.ts` joins `public.edges` this
  // way, and its own WHERE mentions only `e.deleted_at`).
  return /\bjoin\b[\s\S]*?\bon\b[^\n]*?=\s*e\.id\b/i.test(site.sql);
}

describe('ENTITY_FROM is always anchored on entities', () => {
  it('finds the call sites at all', () => {
    // If the scanner silently matched nothing, every assertion below would pass
    // vacuously — which is the one way a guard like this fails without saying
    // so. The floor is deliberately well under the real count so ordinary
    // refactors do not trip it.
    expect(entityFromSites().length).toBeGreaterThan(15);
  });

  it('never drives a read from a detail table alone', () => {
    const offenders = entityFromSites()
      .filter((site) => !isAnchored(site))
      .filter((site) => !DYNAMIC_WHERE_ALLOWLIST.has(site.file))
      .map((site) => {
        const onDetail = DETAIL_ALIASES.filter((a) =>
          new RegExp(String.raw`\b${a}\.\w+`).test(site.where),
        );
        return `${site.file}:${site.line} — WHERE touches [${onDetail.join(', ')}] but nothing anchors e.*\n` +
          `    where: ${site.where.replace(/\s+/g, ' ').trim().slice(0, 160)}`;
      });

    expect(
      offenders,
      'A query filtered only on a table inside the ENTITY_FROM chain rebuilds ' +
        'the whole 25-table join per candidate row — ~87s vs ~78ms on prod, ' +
        'past statement_timeout, so it 503s instead of returning.\n' +
        'Fix it the way #518 did: read the ids from the detail table first, ' +
        'then hydrate envelopes with `where e.id = any(...)` — see ' +
        '`hydrateEntityRows` in facade/handlers/messages.ts.\n\n' +
        offenders.join('\n'),
    ).toEqual([]);
  });

  /*
   * The allowlist above is only honest while this holds. `buildWhere` opens
   * with the space predicate and every caller-supplied filter is pushed AFTER
   * it, so a collections query is anchored on `entities` however it is
   * configured.
   */
  it('keeps collections anchored by seeding e.space_id in buildWhere', () => {
    const source = readFileSync(join(SERVER_SRC, 'facade/handlers/collections.ts'), 'utf8');
    const seed = /const\s+where:\s*string\[\]\s*=\s*\[\s*`e\.space_id\s*=/.exec(source);
    expect(
      seed,
      'collections.ts no longer seeds `e.space_id` as the first predicate in ' +
        'buildWhere, so its ENTITY_FROM reads may no longer be anchored on ' +
        'entities. Either restore the seed or remove the DYNAMIC_WHERE_ALLOWLIST ' +
        'entry so those sites are scanned like everything else.',
    ).not.toBeNull();
  });
});

describe('the thread-open read specifically', () => {
  /*
   * The exact regression that produced the bug report. `messages.list` with
   * `?rootMessageId=` is what opening a chat thread calls, and it used to
   * filter `ENTITY_FROM` on `msg.anchor_id` / `msg.root_message_id`. Pinned by
   * name because this is the one path a user hits by scrolling.
   */
  it('reads ids from public.messages before touching ENTITY_FROM', () => {
    const source = readFileSync(join(SERVER_SRC, 'facade/handlers/messages.ts'), 'utf8');
    expect(source).toMatch(/select\s+msg\.entity_id\s+as\s+id[\s\S]*?from\s+public\.messages\s+msg/i);
    expect(source).toContain('hydrateEntityRows');
  });

  it('hydrates envelopes by e.id and nothing else', () => {
    const source = readFileSync(join(SERVER_SRC, 'facade/handlers/messages.ts'), 'utf8');
    const hydrate = /export async function hydrateEntityRows[\s\S]*?\n}/.exec(source);
    expect(hydrate).not.toBeNull();
    expect(hydrate?.[0]).toContain('where e.id = any($1::uuid[])');
    for (const alias of DETAIL_ALIASES) {
      expect(hydrate?.[0]).not.toMatch(new RegExp(String.raw`where[\s\S]*\b${alias}\.\w+`, 'i'));
    }
  });
});
