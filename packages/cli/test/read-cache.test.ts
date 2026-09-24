/**
 * The session read-cache (F2). The property hierarchy, in order of importance:
 *
 *   1. NEVER a stale byte: every uncertain path answers "refetch".
 *   2. NEVER active for a harness (this suite included) or when disabled.
 *   3. Only then: hits actually serve, writes actually invalidate.
 *
 * Unit tests drive the module directly with explicit env + cwd, and the client
 * seam with an injected cache + mocked fetch — the singleton is never touched
 * (it is INERT here anyway, by property 2, which one test proves).
 */
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Tm8Client } from '../src/client.js';
import { createReadCache, readCache } from '../src/read-cache.js';

const SESSION = '019fbbcd-cef8-7701-ae98-3d5f1d459ed8';
const SPACE = '019fb748-0068-76dc-9869-1bb36133c554';
const ENTITY = '019fc06c-80ae-75cc-9dd8-ed7796bb702b';
const AGENT_CWD = '/work/some-project';

function tempEnv(): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), 'tm8-cache-'));
  return { TM8_JOURNAL_PATH: join(dir, `${SESSION}.jsonl`), TM8_SESSION_ID: SESSION };
}

/** An entity-context-shaped envelope: carries its own eventSeq provenance. */
function contextBody(seq: number, marker = 'v1'): string {
  return JSON.stringify({
    data: {
      root: { id: ENTITY, spaceId: SPACE },
      provenance: { operation: 'entities.context', fetchedAt: 'x', eventSeq: seq },
      marker,
    },
    requestId: 'r1',
  });
}

function pollBody(events: unknown[]): string {
  return JSON.stringify({ data: { events }, requestId: 'r2' });
}

/**
 * The LIVE `events.poll` page shape — `{items, nextCursor}` (server poll.ts
 * `DurableEventPage`, pinned by the conformance suite). The staging defect:
 * the revalidator only read `data.events`/bare-array, so every real poll was
 * "unreadable", evicted, and refetched — the cache never served once.
 */
function livePollBody(items: unknown[], nextCursor: string | null = null): string {
  return JSON.stringify({ data: { items, nextCursor }, requestId: 'r2' });
}

describe('the gate (property 2)', () => {
  it('is inert without the journal env, under TM8_NO_CACHE, and for harness class', () => {
    expect(createReadCache({}, AGENT_CWD).enabled).toBe(false);
    expect(createReadCache({ ...tempEnv(), TM8_NO_CACHE: '1' }, AGENT_CWD).enabled).toBe(false);
    expect(createReadCache({ ...tempEnv(), TM8_JOURNAL_CLASS: 'harness' }, AGENT_CWD).enabled).toBe(false);
    // The cwd heuristic: a process running from packages/cli is a harness.
    expect(createReadCache(tempEnv(), '/repo/packages/cli').enabled).toBe(false);
    expect(createReadCache(tempEnv(), AGENT_CWD).enabled).toBe(true);
  });

  it('THIS suite sees the singleton INERT — the self-pollution guard, measured', () => {
    expect(readCache.enabled).toBe(false);
  });
});

describe('store refuses what it cannot keep coherent (property 1)', () => {
  it('a payload with no spaceId or no seq basis is not stored', () => {
    const cache = createReadCache(tempEnv(), AGENT_CWD);
    const search = new URLSearchParams();
    cache.store('entities.get', `/v2/entities/${ENTITY}`, search, 200,
      JSON.stringify({ data: { id: ENTITY } })); // no spaceId anywhere
    expect(cache.read(cache.keyFor('entities.get', `/v2/entities/${ENTITY}`, search) as string)).toBeNull();

    cache.store('entities.get', `/v2/entities/${ENTITY}`, search, 200,
      JSON.stringify({ data: { id: ENTITY, spaceId: SPACE } })); // space, but no watermark yet
    expect(cache.read(cache.keyFor('entities.get', `/v2/entities/${ENTITY}`, search) as string)).toBeNull();
  });

  it('own provenance stores; a prior watermark lets a seq-less read store too', () => {
    const cache = createReadCache(tempEnv(), AGENT_CWD);
    const search = new URLSearchParams();
    cache.store('entities.context', `/v2/entities/${ENTITY}/context`, search, 200, contextBody(41));
    const ctx = cache.read(cache.keyFor('entities.context', `/v2/entities/${ENTITY}/context`, search) as string);
    expect(ctx?.seq).toBe(41);
    expect(ctx?.entityIds).toContain(ENTITY);

    // The context call left a watermark; a plain get in the same space now
    // has a conservative basis and stores against it.
    cache.store('entities.get', `/v2/entities/${ENTITY}`, search, 200,
      JSON.stringify({ data: { id: ENTITY, spaceId: SPACE } }));
    expect(cache.read(cache.keyFor('entities.get', `/v2/entities/${ENTITY}`, search) as string)?.seq).toBe(41);
  });

  it('watermarks only ever advance', () => {
    const cache = createReadCache(tempEnv(), AGENT_CWD);
    cache.advanceWatermark(SPACE, 10);
    cache.advanceWatermark(SPACE, 7);
    expect(cache.watermark(SPACE)).toBe(10);
  });

  it('query order does not defeat byte-identity', () => {
    const cache = createReadCache(tempEnv(), AGENT_CWD);
    const a = cache.keyFor('x', '/p', new URLSearchParams([['b', '2'], ['a', '1']]));
    const b = cache.keyFor('x', '/p', new URLSearchParams([['a', '1'], ['b', '2']]));
    expect(a).toBe(b);
  });

  it('invalidate drops entries about the named entity and leaves the rest', () => {
    const cache = createReadCache(tempEnv(), AGENT_CWD);
    const search = new URLSearchParams();
    const other = '019fc06c-d498-7c5c-b5f9-2930d94af645';
    cache.store('entities.context', `/v2/entities/${ENTITY}/context`, search, 200, contextBody(1));
    cache.store('entities.context', `/v2/entities/${other}/context`, search, 200,
      JSON.stringify({ data: { root: { id: other, spaceId: SPACE }, provenance: { eventSeq: 2 } } }));
    cache.invalidate([ENTITY.toUpperCase()]); // case must not matter
    expect(cache.read(cache.keyFor('entities.context', `/v2/entities/${ENTITY}/context`, search) as string)).toBeNull();
    expect(cache.read(cache.keyFor('entities.context', `/v2/entities/${other}/context`, search) as string)).not.toBeNull();
  });
});

// ── the client seam, with an injected cache and a counting fetch ────────────

interface Route {
  match: (url: string) => boolean;
  body: (url: string) => string;
}

function fetchStub(routes: Route[]): { impl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const impl = (async (input: URL | RequestInfo) => {
    const url = String(input);
    calls.push(url);
    const route = routes.find((r) => r.match(url));
    if (!route) return new Response(JSON.stringify({ error: { code: 'not_found', message: 'x', requestId: 'r', retryable: false } }), { status: 404 });
    return new Response(route.body(url), { status: 200, headers: { 'x-tm8-request-id': 'r' } });
  }) as typeof fetch;
  return { impl, calls };
}

function clientWith(cache: ReturnType<typeof createReadCache>, routes: Route[], fresh = false) {
  const { impl, calls } = fetchStub(routes);
  const client = new Tm8Client({ baseUrl: 'http://127.0.0.1:4610', fetchImpl: impl, cache, fresh });
  return { client, calls };
}

const contextRoute = (seq: () => number, marker: () => string): Route => ({
  match: (u) => u.includes('/context'),
  body: () => contextBody(seq(), marker()),
});

describe('the client seam: hit, revalidate, serve, invalidate, --fresh', () => {
  it('a byte-identical re-read makes ONE events.poll and serves the cached payload', async () => {
    const cache = createReadCache(tempEnv(), AGENT_CWD);
    let served = 0;
    const routes: Route[] = [
      contextRoute(() => 41, () => { served += 1; return `serve-${served}`; }),
      { match: (u) => u.includes('/events'), body: () => pollBody([]) },
    ];
    const { client, calls } = clientWith(cache, routes);

    const first = await client.invoke<{ marker: string }>('entities.context', { params: { id: ENTITY } });
    const second = await client.invoke<{ marker: string }>('entities.context', { params: { id: ENTITY } });

    expect(first.marker).toBe('serve-1');
    expect(second.marker).toBe('serve-1'); // cached bytes, not a second render
    const contextCalls = calls.filter((u) => u.includes('/context'));
    const pollCalls = calls.filter((u) => u.includes('/events'));
    expect(contextCalls).toHaveLength(1);
    expect(pollCalls).toHaveLength(1);
    expect(pollCalls[0]).toContain('since=41');
  });

  it('the LIVE {items, nextCursor} poll page serves the cached payload (staging regression)', async () => {
    const cache = createReadCache(tempEnv(), AGENT_CWD);
    let served = 0;
    const routes: Route[] = [
      contextRoute(() => 41, () => { served += 1; return `serve-${served}`; }),
      { match: (u) => u.includes('/events'), body: () => livePollBody([]) },
    ];
    const { client, calls } = clientWith(cache, routes);

    await client.invoke('entities.context', { params: { id: ENTITY } });
    const second = await client.invoke<{ marker: string }>('entities.context', { params: { id: ENTITY } });

    expect(second.marker).toBe('serve-1'); // cached, NOT the pre-fix silent refetch
    expect(calls.filter((u) => u.includes('/context'))).toHaveLength(1);
    expect(calls.filter((u) => u.includes('/events'))).toHaveLength(1);
  });

  it('a live-page ITEM naming the entity still forces a refetch, and its seq advances the watermark', async () => {
    const cache = createReadCache(tempEnv(), AGENT_CWD);
    let version = 0;
    const routes: Route[] = [
      contextRoute(() => 41, () => { version += 1; return `v${version}`; }),
      { match: (u) => u.includes('/events'), body: () => livePollBody([{ seq: 42, entity: { id: ENTITY } }], '42') },
    ];
    const { client, calls } = clientWith(cache, routes);

    await client.invoke('entities.context', { params: { id: ENTITY } });
    const second = await client.invoke<{ marker: string }>('entities.context', { params: { id: ENTITY } });
    expect(second.marker).toBe('v2');
    expect(calls.filter((u) => u.includes('/context'))).toHaveLength(2);
  });

  it('an unknown poll page shape still fails CLOSED to the network', async () => {
    const cache = createReadCache(tempEnv(), AGENT_CWD);
    let version = 0;
    const routes: Route[] = [
      contextRoute(() => 41, () => { version += 1; return `v${version}`; }),
      { match: (u) => u.includes('/events'), body: () => JSON.stringify({ data: { rows: [] }, requestId: 'r2' }) },
    ];
    const { client, calls } = clientWith(cache, routes);
    await client.invoke('entities.context', { params: { id: ENTITY } });
    const second = await client.invoke<{ marker: string }>('entities.context', { params: { id: ENTITY } });
    expect(second.marker).toBe('v2');
    expect(calls.filter((u) => u.includes('/context'))).toHaveLength(2);
  });

  it('an event naming the entity forces a REFETCH — never a stale byte', async () => {
    const cache = createReadCache(tempEnv(), AGENT_CWD);
    let seq = 41;
    let version = 0;
    const routes: Route[] = [
      contextRoute(() => seq, () => { version += 1; return `v${version}`; }),
      { match: (u) => u.includes('/events'), body: () => pollBody([{ seq: 42, entity: { id: ENTITY } }]) },
    ];
    const { client, calls } = clientWith(cache, routes);

    await client.invoke('entities.context', { params: { id: ENTITY } });
    seq = 43;
    const second = await client.invoke<{ marker: string }>('entities.context', { params: { id: ENTITY } });
    expect(second.marker).toBe('v2');
    expect(calls.filter((u) => u.includes('/context'))).toHaveLength(2);
  });

  it('a failing poll fails OPEN to the network', async () => {
    const cache = createReadCache(tempEnv(), AGENT_CWD);
    let version = 0;
    const routes: Route[] = [
      contextRoute(() => 41, () => { version += 1; return `v${version}`; }),
      // no /events route: the poll 404s
    ];
    const { client, calls } = clientWith(cache, routes);
    await client.invoke('entities.context', { params: { id: ENTITY } });
    const second = await client.invoke<{ marker: string }>('entities.context', { params: { id: ENTITY } });
    expect(second.marker).toBe('v2');
    expect(calls.filter((u) => u.includes('/context'))).toHaveLength(2);
  });

  it('--fresh skips the lookup entirely and repairs the entry', async () => {
    const env = tempEnv();
    const warm = createReadCache(env, AGENT_CWD);
    let version = 0;
    const routes: Route[] = [contextRoute(() => 41, () => { version += 1; return `v${version}`; })];
    await clientWith(warm, routes).client.invoke('entities.context', { params: { id: ENTITY } });

    const { client, calls } = clientWith(createReadCache(env, AGENT_CWD), routes, true);
    const forced = await client.invoke<{ marker: string }>('entities.context', { params: { id: ENTITY } });
    expect(forced.marker).toBe('v2');
    expect(calls.some((u) => u.includes('/events'))).toBe(false); // no lookup, no revalidation
  });

  it('a mutation naming the entity invalidates its cached reads', async () => {
    const cache = createReadCache(tempEnv(), AGENT_CWD);
    let version = 0;
    const routes: Route[] = [
      contextRoute(() => 41, () => { version += 1; return `v${version}`; }),
      { match: (u) => u.includes('/events'), body: () => pollBody([]) },
      { match: (u) => /\/v2\/entities\/[0-9a-f-]+$/.test(u), body: () => JSON.stringify({ data: { id: ENTITY, spaceId: SPACE }, requestId: 'r' }) },
    ];
    const { client } = clientWith(cache, routes);

    await client.invoke('entities.context', { params: { id: ENTITY } });
    await client.invoke('entities.patch', { params: { id: ENTITY }, body: { title: 'moved' } });
    const after = await client.invoke<{ marker: string }>('entities.context', { params: { id: ENTITY } });
    expect(after.marker).toBe('v2'); // the write evicted the entry; this refetched
  });


  it('the cache dir stays inside the session directory, next to the journal', async () => {
    const env = tempEnv();
    const cache = createReadCache(env, AGENT_CWD);
    const routes: Route[] = [contextRoute(() => 41, () => 'x')];
    await clientWith(cache, routes).client.invoke('entities.context', { params: { id: ENTITY } });
    const dir = `${env.TM8_JOURNAL_PATH}.cache`;
    expect(readdirSync(dir).some((f) => f.endsWith('.entry.json'))).toBe(true);
  });
});

// ── revalidation past the first poll page ────────────────────────────────────

/**
 * A durable feed of `seq`s after 41 that honours `?since=` and `?limit=` the
 * way poll.ts does: ascending, capped (default 200, max 500), and a
 * `nextCursor` that is never null — it echoes `since` when caught up.
 */
function feedRoute(lastSeq: number, relevantSeq: number | null = null): Route {
  return {
    match: (u) => u.includes('/events'),
    body: (u) => {
      const q = new URL(u).searchParams;
      const since = Number(q.get('since'));
      const limit = Math.min(Number(q.get('limit') ?? 200), 500);
      const items: unknown[] = [];
      for (let seq = since + 1; seq <= lastSeq && items.length < limit; seq += 1) {
        const id = seq === relevantSeq ? ENTITY : `019fc06c-0000-7000-8000-${String(seq).padStart(12, '0')}`;
        items.push({ seq, entity: { id } });
      }
      const last = (items.at(-1) as { seq: number } | undefined)?.seq ?? since;
      return livePollBody(items, String(last));
    },
  };
}

describe('revalidation past the first poll page (fails closed on a busy space)', () => {
  it('a change AFTER a full page of unrelated events still forces a refetch', async () => {
    const cache = createReadCache(tempEnv(), AGENT_CWD);
    let version = 0;
    // 41 → 641 unrelated, the cached entity changes at 642: past any first page.
    const routes: Route[] = [contextRoute(() => 41, () => { version += 1; return `v${version}`; }), feedRoute(700, 642)];
    const { client, calls } = clientWith(cache, routes);

    await client.invoke('entities.context', { params: { id: ENTITY } });
    const second = await client.invoke<{ marker: string }>('entities.context', { params: { id: ENTITY } });
    expect(second.marker).toBe('v2'); // pre-fix: 'v1', a stale byte from one page
    expect(calls.filter((u) => u.includes('/context'))).toHaveLength(2);
    const polls = calls.filter((u) => u.includes('/events'));
    expect(polls).toHaveLength(2);
    expect(polls[1]).toContain('since=541'); // paged from the first page's nextCursor
    // Only the INSPECTED quiet page advanced the watermark, not the one that matched.
    expect(cache.watermark(SPACE)).toBe(541);
  });

  it('several pages of unrelated events page to the head, serve the cache, and advance the watermark', async () => {
    const cache = createReadCache(tempEnv(), AGENT_CWD);
    let served = 0;
    const routes: Route[] = [contextRoute(() => 41, () => { served += 1; return `serve-${served}`; }), feedRoute(741)];
    const { client, calls } = clientWith(cache, routes);

    await client.invoke('entities.context', { params: { id: ENTITY } });
    const second = await client.invoke<{ marker: string }>('entities.context', { params: { id: ENTITY } });
    expect(second.marker).toBe('serve-1');
    expect(calls.filter((u) => u.includes('/context'))).toHaveLength(1);
    expect(calls.filter((u) => u.includes('/events'))).toHaveLength(2);
    expect(cache.watermark(SPACE)).toBe(741);
  });

  it('a feed still full at the page cap refetches instead of crawling', async () => {
    const cache = createReadCache(tempEnv(), AGENT_CWD);
    let version = 0;
    const routes: Route[] = [contextRoute(() => 41, () => { version += 1; return `v${version}`; }), feedRoute(100_000)];
    const { client, calls } = clientWith(cache, routes);

    await client.invoke('entities.context', { params: { id: ENTITY } });
    const second = await client.invoke<{ marker: string }>('entities.context', { params: { id: ENTITY } });
    expect(second.marker).toBe('v2');
    expect(calls.filter((u) => u.includes('/events'))).toHaveLength(3);
    expect(cache.watermark(SPACE)).toBe(1541); // three inspected pages, no further
  });

  it('a full page whose cursor does not advance fails closed', async () => {
    const cache = createReadCache(tempEnv(), AGENT_CWD);
    let version = 0;
    const stuck = Array.from({ length: 500 }, () => ({ note: 'no seq' }));
    const routes: Route[] = [
      contextRoute(() => 41, () => { version += 1; return `v${version}`; }),
      { match: (u) => u.includes('/events'), body: () => livePollBody(stuck, '41') },
    ];
    const { client, calls } = clientWith(cache, routes);

    await client.invoke('entities.context', { params: { id: ENTITY } });
    const second = await client.invoke<{ marker: string }>('entities.context', { params: { id: ENTITY } });
    expect(second.marker).toBe('v2');
    expect(calls.filter((u) => u.includes('/events'))).toHaveLength(1);
  });
});

// ── hasMore, not page length, ends revalidation (change feed step 1) ────────

/**
 * The poll.ts page WITH `hasMore` / `examinedThrough`: every seq after 41 up
 * to `lastSeq` is examined, but only every `readableEvery`th one is readable,
 * so a page that hit its examine cap is SHORT. `hasMore` is the cap, exactly
 * as poll.ts computes it.
 */
function paddedFeedRoute(lastSeq: number, relevantSeq: number | null = null, readableEvery = 4): Route {
  return {
    match: (u) => u.includes('/events'),
    body: (u) => {
      const q = new URL(u).searchParams;
      const since = Number(q.get('since'));
      const limit = Math.min(Number(q.get('limit') ?? 200), 500);
      const through = Math.min(since + limit, lastSeq);
      const examined = Math.max(0, through - since);
      const items: unknown[] = [];
      for (let seq = since + 1; seq <= through; seq += 1) {
        if (seq !== relevantSeq && seq % readableEvery !== 0) continue; // unreadable: skipped
        const id = seq === relevantSeq ? ENTITY : `019fc06c-0000-7000-8000-${String(seq).padStart(12, '0')}`;
        items.push({ seq, entity: { id } });
      }
      return JSON.stringify({
        data: { items, nextCursor: String(through), hasMore: examined === limit, examinedThrough: through },
        requestId: 'r2',
      });
    },
  };
}

describe('revalidation stops only on hasMore:false, never on a short page', () => {
  it('a SHORT page with hasMore:true pages on, and a change past it forces a refetch', async () => {
    const cache = createReadCache(tempEnv(), AGENT_CWD);
    let version = 0;
    const routes: Route[] = [
      contextRoute(() => 41, () => { version += 1; return `v${version}`; }),
      paddedFeedRoute(700, 642),
    ];
    const { client, calls } = clientWith(cache, routes);

    await client.invoke('entities.context', { params: { id: ENTITY } });
    const second = await client.invoke<{ marker: string }>('entities.context', { params: { id: ENTITY } });
    // Pre-fix the first page (short: ~50 readable of 200+ examined) read as
    // "caught up" and served v1 — a stale byte.
    expect(second.marker).toBe('v2');
    const polls = calls.filter((u) => u.includes('/events'));
    expect(polls.length).toBeGreaterThan(1);
  });

  it('padded pages page to hasMore:false, serve the cache, and the watermark covers the skipped rows', async () => {
    const cache = createReadCache(tempEnv(), AGENT_CWD);
    let served = 0;
    // 741 is not readable (741 % 4 !== 0): the watermark must still reach it.
    const routes: Route[] = [contextRoute(() => 41, () => { served += 1; return `serve-${served}`; }), paddedFeedRoute(741)];
    const { client, calls } = clientWith(cache, routes);

    await client.invoke('entities.context', { params: { id: ENTITY } });
    const second = await client.invoke<{ marker: string }>('entities.context', { params: { id: ENTITY } });
    expect(second.marker).toBe('serve-1');
    expect(calls.filter((u) => u.includes('/context'))).toHaveLength(1);
    expect(calls.filter((u) => u.includes('/events'))).toHaveLength(2);
    expect(cache.watermark(SPACE)).toBe(741);
  });

  it('an EMPTY page with hasMore:true is not the head either', async () => {
    const cache = createReadCache(tempEnv(), AGENT_CWD);
    let version = 0;
    // Nothing readable before 642 at all: the first page is empty but capped.
    const routes: Route[] = [
      contextRoute(() => 41, () => { version += 1; return `v${version}`; }),
      paddedFeedRoute(700, 642, 1_000_000),
    ];
    const { client } = clientWith(cache, routes);

    await client.invoke('entities.context', { params: { id: ENTITY } });
    const second = await client.invoke<{ marker: string }>('entities.context', { params: { id: ENTITY } });
    expect(second.marker).toBe('v2');
  });

  it('still hasMore at the page cap refetches instead of crawling', async () => {
    const cache = createReadCache(tempEnv(), AGENT_CWD);
    let version = 0;
    const routes: Route[] = [contextRoute(() => 41, () => { version += 1; return `v${version}`; }), paddedFeedRoute(100_000)];
    const { client, calls } = clientWith(cache, routes);

    await client.invoke('entities.context', { params: { id: ENTITY } });
    const second = await client.invoke<{ marker: string }>('entities.context', { params: { id: ENTITY } });
    expect(second.marker).toBe('v2');
    expect(calls.filter((u) => u.includes('/events'))).toHaveLength(3);
  });
});
