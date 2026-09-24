/**
 * Acceptance 2 and 13 (spec doc 01a0cf35 §6) — the DIFFERENTIAL ORACLE.
 *
 * For random windows and scopes over a seeded fixture, the set of changed ids
 * that `events.changes` reports — following its `more` chain to the end — must
 * EQUAL the oracle's. The oracle shares no code with the feed: it replays the
 * whole window through `events.poll` (full contract events, no subject index)
 * and applies the scope rules client-side, from the spec's own table.
 *
 * The fixture is sized so every chain shape occurs: windows over 2,000 events
 * (examine-cap chains), windows with more than 50 changed entities (entity-cap
 * chains), and 8,192-byte budgets over long messages (budget chains). Every page
 * of every chain is also checked for the progress and budget guarantees:
 * `through > since`, at most 50 entities, at most `totalBytes` minified.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DurableWorkspaceEvent, EntitySummary, EventChangesView } from '@tm8/contract';

import { byteLength, parseChangesQuery, PgChangeFeed } from '../../src/events/changes.js';
import { PgDurableEventLog } from '../../src/events/poll.js';
import { ChangesFixture } from './changes-fixture.js';

vi.setConfig({ testTimeout: 600_000, hookTimeout: 900_000 });

/** mulberry32 — a seeded PRNG, so a failing case is reproducible by its seed. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEED = Number(process.env['TM8_CHANGES_ORACLE_SEED'] ?? 20260924);
const f = new ChangesFixture();
let feed: PgChangeFeed;
let log: PgDurableEventLog;
let base: number;
let head: number;
const roots: string[] = [];
const tasks: string[] = [];

interface Scope {
  entity: string[];
  anchor: string[];
  subtree: string[];
  kind: string[];
  change: string[];
  totalBytes: number;
}

/** Follow the `more` chain from `after`; returns the union of ids and checks every page. */
async function chain(scope: Scope, after: number): Promise<{ ids: Set<string>; pages: number }> {
  const ids = new Set<string>();
  let since = after;
  for (let pages = 1; pages <= 400; pages++) {
    const query: Record<string, string> = { after: String(since), totalBytes: String(scope.totalBytes) };
    for (const key of ['entity', 'anchor', 'subtree', 'kind', 'change'] as const) {
      if (scope[key].length > 0) query[key] = scope[key].join(',');
    }
    const view: EventChangesView = await feed.read(f.spaceId, parseChangesQuery(new URLSearchParams(query)), f.claims());
    expect(byteLength(view), 'page over budget').toBeLessThanOrEqual(scope.totalBytes);
    expect(view.changed!.length).toBeLessThanOrEqual(50);
    for (const e of view.changed!) ids.add(e.id);
    if (!view.more) {
      expect(view.through).toBe(head);
      return { ids, pages };
    }
    // Progress: every `more` page moves the cursor forward.
    expect(view.through, 'a more page must advance').toBeGreaterThan(since);
    since = view.through;
  }
  throw new Error('chain did not converge in 400 pages');
}

// ── the oracle: full poll replay + the spec's scope rules, client-side ──────

async function replay(after: number): Promise<DurableWorkspaceEvent[]> {
  const out: DurableWorkspaceEvent[] = [];
  let cursor = after;
  for (;;) {
    const page = await log.since(f.spaceId, cursor, 500, f.claims());
    out.push(...page.items);
    if (!page.hasMore) return out;
    cursor = page.examinedThrough!;
  }
}

interface World {
  kindOf: Map<string, string>;
  /** Readable now (the digest reports only entities it can hydrate at read time). */
  readable: Set<string>;
  parentOf: Map<string, string | null>;
  workingOn: Array<{ src: string; dst: string }>;
  trackedBy: Map<string, string[]>;
}

async function world(): Promise<World> {
  const rows = await f.db.query<{ id: string; kind: string; parent_id: string | null }>(
    f.claims(), 'select id::text id, kind, parent_id::text parent_id from public.entities where space_id = $1', [f.spaceId]);
  const edges = await f.db.query<{ src: string; dst: string; type: string }>(
    f.claims(),
    `select src_id::text src, dst_id::text dst, type from public.edges
      where space_id = $1 and type in ('working_on', 'tracks')`,
    [f.spaceId],
  );
  const trackedBy = new Map<string, string[]>();
  for (const e of edges.filter((x) => x.type === 'tracks')) trackedBy.set(e.dst, [...(trackedBy.get(e.dst) ?? []), e.src]);
  return {
    kindOf: new Map(rows.map((r) => [r.id, r.kind])),
    readable: new Set(rows.map((r) => r.id)),
    parentOf: new Map(rows.map((r) => [r.id, r.parent_id])),
    workingOn: edges.filter((x) => x.type === 'working_on'),
    trackedBy,
  };
}

/** §3.3: subtree = parentId descendants + work sessions working_on any of them (one hop). */
function subtreeOf(w: World, roots: readonly string[]): Set<string> {
  const out = new Set(roots.filter((r) => w.readable.has(r)));
  let grew = true;
  while (grew) {
    grew = false;
    for (const [id, parent] of w.parentOf) {
      if (parent !== null && out.has(parent) && !out.has(id)) { out.add(id); grew = true; }
    }
  }
  for (const e of w.workingOn) if (out.has(e.dst) && w.kindOf.get(e.src) === 'work_session') out.add(e.src);
  return out;
}

type Via = 'self' | 'edge' | 'message' | 'git';

/** Which (entity, via, isMessage) touches one contract event carries — the spec's §3.2 table. */
function touches(ev: DurableWorkspaceEvent, w: World): Array<{ id: string; via: Via; message: boolean }> {
  const e = ev as unknown as Record<string, unknown>;
  switch (ev.type) {
    case 'entity.upsert':
    case 'entity.deleted': {
      const entity = e['entity'] as EntitySummary;
      return entity.kind === 'message' ? [] : [{ id: entity.id, via: 'self', message: false }];
    }
    case 'edge.upsert':
    case 'edge.deleted': {
      const edge = e['edge'] as { source: EntitySummary; target: EntitySummary };
      if (edge.source.kind === 'message' || edge.target.kind === 'message') return [];
      return [edge.source.id, edge.target.id].map((id) => ({ id, via: 'edge' as const, message: false }));
    }
    case 'message.created':
      return [{ id: String(e['anchorId']), via: 'message', message: true }];
    case 'activity.created': {
      const a = e['activity'] as { entityId: string | null; verb: string };
      return a.entityId !== null && a.verb === 'created' ? [{ id: a.entityId, via: 'self', message: false }] : [];
    }
    case 'git.pr_state_changed':
    case 'git.commit_recorded': {
      const fact = String(e['prEntityId'] ?? e['commitEntityId']);
      return [fact, ...(w.trackedBy.get(fact) ?? [])].map((id) => ({ id, via: 'git' as const, message: false }));
    }
    default:
      return [];
  }
}

function oracle(events: readonly DurableWorkspaceEvent[], w: World, scope: Scope): Set<string> {
  const scoped = scope.entity.length + scope.anchor.length + scope.subtree.length > 0;
  const entitySet = new Set(scope.entity.filter((id) => w.readable.has(id)));
  const anchorLike = new Set([
    ...scope.anchor.filter((id) => w.readable.has(id)),
    ...subtreeOf(w, scope.subtree),
  ]);
  const changed = new Map<string, { message: boolean }>();
  for (const ev of events) {
    for (const t of touches(ev, w)) {
      const inScope = !scoped || anchorLike.has(t.id) || (entitySet.has(t.id) && t.via !== 'message');
      if (!inScope) continue;
      const prior = changed.get(t.id) ?? { message: false };
      changed.set(t.id, { message: prior.message || t.message });
    }
  }
  const out = new Set<string>();
  for (const [id, c] of changed) {
    const kind = w.kindOf.get(id);
    if (kind === undefined || kind === 'message' || !w.readable.has(id)) continue;
    if (scope.kind.length > 0 && !scope.kind.includes(kind)) continue;
    if (scope.change.includes('message') && !c.message) continue;
    out.add(id);
  }
  return out;
}

beforeAll(async () => {
  await f.open('changes_oracle');
  feed = new PgChangeFeed(f.db);
  log = new PgDurableEventLog(f.db);
  const r = rng(SEED);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;

  // Three subtrees (roots, children, some grandchildren) and loose tasks.
  for (let i = 0; i < 3; i++) {
    const root = await f.createTask(`oracle root ${String(i)}`);
    roots.push(root);
    tasks.push(root);
    for (let j = 0; j < 5; j++) {
      const child = await f.createTask(`root ${String(i)} child ${String(j)}`, root);
      tasks.push(child);
      if (j < 2) tasks.push(await f.createTask(`root ${String(i)} grandchild ${String(j)}`, child));
    }
  }
  for (let i = 0; i < 8; i++) tasks.push(await f.createTask(`loose ${String(i)}`));
  const channel = await f.channelId();
  base = await f.head();

  // The window: a seeded mix of every mutation the digest classifies, plus
  // bursts that force each chain shape. Targets > 2,000 events.
  let n = 0;
  while ((await f.head()) - base < 2_300) {
    const op = r();
    const t = pick(tasks);
    if (op < 0.35) await f.post(r() < 0.2 ? channel : t, `${String(n)} ${'long body '.repeat(Math.floor(r() * 40))}`);
    else if (op < 0.5) await f.rename(t, `renamed ${String(n)}`);
    else if (op < 0.62) await f.setStatus(t, pick(['working', 'in_review', 'open', 'blocked']));
    else if (op < 0.72) tasks.push(await f.createTask(`born ${String(n)}`, r() < 0.6 ? pick(tasks) : null));
    else if (op < 0.82) await f.edge(t, pick(tasks), 'relates_to').catch(() => undefined);
    else if (op < 0.88) await f.edge(t, f.memberId, 'assigned_to').catch(() => undefined);
    else if (op < 0.93) {
      const s = await f.createSession(`worker ${String(n)}`);
      await f.edge(s, t, 'working_on');
    } else if (op < 0.96) await f.linkPr(t, 1000 + n).catch(() => undefined);
    else {
      // A burst of fresh entities: pushes a window past the 50-entity cap.
      for (let k = 0; k < 12; k++) tasks.push(await f.createTask(`burst ${String(n)}.${String(k)}`));
    }
    n++;
  }
  head = await f.head();
  console.info(`[oracle] seed ${String(SEED)}: ${String(n)} ops, ${String(head - base)} events in the window, ${String(tasks.length)} tasks`);
}, 900_000);

afterAll(async () => {
  await f.close();
});

describe('acceptance 2 / 13 — the changed-id set equals the oracle on every generated case', () => {
  it('the fixture really has every chain shape', async () => {
    expect(head - base).toBeGreaterThan(2_000);
    const all = await chain({ entity: [], anchor: [], subtree: [], kind: [], change: [], totalBytes: 16_384 }, base);
    // >2,000 events forces an examine-cap stop; >50 entities an entity-cap stop.
    expect(all.pages).toBeGreaterThan(2);
    expect(all.ids.size).toBeGreaterThan(50);
  });

  it('space-wide, from the start of the window, at every budget', async () => {
    const events = await replay(base);
    const w = await world();
    for (const totalBytes of [8_192, 16_384, 32_768]) {
      const scope: Scope = { entity: [], anchor: [], subtree: [], kind: [], change: [], totalBytes };
      const got = await chain(scope, base);
      expect([...got.ids].sort(), `budget ${String(totalBytes)}`).toEqual([...oracle(events, w, scope)].sort());
    }
  });

  it('random windows and scopes', async () => {
    const r = rng(SEED + 1);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
    const some = (xs: readonly string[], max: number): string[] =>
      [...new Set(Array.from({ length: 1 + Math.floor(r() * max) }, () => pick(xs)))];
    const w = await world();
    const cases = Number(process.env['TM8_CHANGES_ORACLE_CASES'] ?? 24);
    for (let c = 0; c < cases; c++) {
      const after = base + Math.floor(r() * (head - base));
      const scope: Scope = {
        entity: r() < 0.4 ? some(tasks, 4) : [],
        anchor: r() < 0.4 ? some(tasks, 4) : [],
        subtree: r() < 0.6 ? some(roots, 2) : [],
        kind: r() < 0.2 ? ['task'] : [],
        change: r() < 0.2 ? ['message'] : [],
        totalBytes: pick([8_192, 12_000, 16_384, 32_768]),
      };
      const events = await replay(after);
      const want = [...oracle(events, w, scope)].sort();
      const got = await chain(scope, after);
      expect([...got.ids].sort(), `case ${String(c)} seed ${String(SEED)} after ${String(after)} ${JSON.stringify(scope)}`)
        .toEqual(want);
    }
  });
});
