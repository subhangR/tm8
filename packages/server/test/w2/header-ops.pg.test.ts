/**
 * `entities.header.set` / `entities.header.clear` and `header` on entity reads
 * (headers design 01a0d31e T3; integrated design 01a0d348 §8 M2 I4).
 *
 * Through the production registry over a real PostgreSQL scratch database:
 *   - `entities.get` and the v2 `entities.context` carry the header once it
 *     is authored, with its own `version`, and nothing before that;
 *   - set writes an authored header, never moving `entities.version`; an
 *     EXPLICIT stale header version is refused; clear falls back to the
 *     derived header, with or without a version;
 *   - LENIENT (migration 223): nothing is refused for content or kind. A long
 *     header is stored whole, and `resolveHeaders` clips it ONCE for
 *     every reader (the set result, get, context, Jev's text), declared in
 *     `clipped`; an empty set, a clear with nothing to clear and a kind that
 *     stores no header are no-ops that say so in `warnings`;
 *   - `entities.create` writes a header in the create's transaction, and on a
 *     kind that cannot carry one the create still succeeds, with a warning;
 *   - a kind with no header (work_session) reads none.
 *
 * The RPC-level rules (RLS, kind allowlist, normalisation, the teammate edit
 * right) are pinned in test/db/entity-headers.pg.test.ts; this is the
 * operation seam.
 */
import type { EntityHeaderView, OperationName } from '@tm8/contract';
import { getOperation } from '@tm8/contract';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createDb } from '../../src/db/index.js';
import type { Db, Querier } from '../../src/db/types.js';
import { HandlerRegistry, registerFacadeHandlers } from '../../src/facade/index.js';
import { resolveHeaders } from '../../src/headers/resolve.js';
import { jevText } from '../../src/headers/render.js';
import type { ServerConfig } from '../../src/http/config.js';
import type { RequestContext } from '../../src/http/types.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from '../db/w1-pg.js';
import { F, IDENTITY, seedContextV2Fixtures } from './context-v2/fixtures.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 300_000 });

const OWNER = {
  identityId: IDENTITY,
  accountId: '01a0c000-0000-7000-8000-0000000000fe',
  username: 'header-owner',
  isNodeAdmin: false,
  isOwner: true,
};

interface Detail { id: string; kind: string; version: number; header?: EntityHeaderView }
interface Warning { code: string; message: string }
interface HeaderResult { entity: Detail; header?: EntityHeaderView; activity?: { id: string }; warnings?: Warning[] }

let database: W1ScratchDatabase;
let pgDb: Db;
let registry: HandlerRegistry;
let mutation = 0;

beforeAll(async () => {
  database = await createW1ScratchDatabase('headerops');
  database.apply(migrationFiles());
  await seedContextV2Fixtures(database);
  pgDb = createDb(database.url);
  registry = new HandlerRegistry();
  registerFacadeHandlers(registry, {
    db: pgDb,
    config: { host: '127.0.0.1', port: 0, databaseUrl: database.url } as unknown as ServerConfig,
    owner: async () => OWNER,
  });
}, 300_000);

afterAll(async () => {
  await pgDb?.end();
  await database?.destroy();
});

async function call<T>(
  opName: OperationName,
  params: Record<string, string>,
  opts: { query?: URLSearchParams; body?: Record<string, unknown> } = {},
): Promise<T> {
  const handler = registry.get(opName);
  if (!handler) throw new Error(`missing handler: ${opName}`);
  const op = getOperation(opName);
  const ctx: RequestContext = {
    op,
    opName,
    params,
    query: opts.query ?? new URLSearchParams(),
    body: opts.body === undefined ? undefined : { clientMutationId: `header-${++mutation}`, ...opts.body },
    requestId: `header-${opName}`,
    identity: { kind: 'auto-owner', identityId: IDENTITY },
    headers: {},
    method: op.method,
    path: op.path,
  };
  return (await handler(ctx)) as T;
}

const get = (id: string): Promise<Detail> => call<Detail>('entities.get', { id });
const context = (id: string): Promise<Detail & Record<string, unknown>> =>
  call('entities.context', { id }, { query: new URLSearchParams({ schema: 'v2' }) });

async function refusal(run: () => Promise<unknown>): Promise<{ code: string; message: string; details?: Record<string, unknown> }> {
  try {
    await run();
  } catch (error) {
    return error as { code: string; message: string; details?: Record<string, unknown> };
  }
  throw new Error('expected a refusal');
}

describe('header on entity reads (I4)', () => {
  it('get and context carry no header until one is authored: reads stay byte-identical', async () => {
    expect((await get(F.D)).header).toBeUndefined();
    expect((await context(F.D)).header).toBeUndefined();
  });

  it('a kind with no header reads none', async () => {
    expect((await get(F.WS)).header).toBeUndefined();
    expect((await context(F.WS)).header).toBeUndefined();
  });
});

describe('entities.header.set / clear (I4)', () => {
  it('set writes an authored header without moving the entity version', async () => {
    const before = await get(F.D);
    const result = await call<HeaderResult>('entities.header.set', { id: F.D }, {
      body: { expectedVersion: 0, whenToUse: 'Load when tuning context budgets', summary: 'Notes on the context read', keywords: ['context', 'budget'] },
    });
    expect(result.header).toMatchObject({
      source: 'authored', whenToUse: 'Load when tuning context budgets', summary: 'Notes on the context read',
      keywords: ['context', 'budget'], version: 1, pinnedVersion: before.version, stale: false,
    });
    expect(result.entity.header).toEqual(result.header);
    expect(result.entity.version).toBe(before.version);
    expect(result.activity).toBeDefined();
    expect((await context(F.D)).header).toEqual(result.header);
  });

  it('refuses a stale header version as version_conflict about the header', async () => {
    const err = await refusal(() => call('entities.header.set', { id: F.D }, {
      body: { expectedVersion: 0, summary: 'lost update' },
    }));
    expect(err.code).toBe('version_conflict');
    expect((await get(F.D)).header?.summary).toBe('Notes on the context read');
  });

  it('the whole header is written: a field left out is removed', async () => {
    const result = await call<HeaderResult>('entities.header.set', { id: F.D }, {
      body: { expectedVersion: 1, whenToUse: 'Load when tuning context budgets' },
    });
    expect(result.header?.version).toBe(2);
    expect(result.header?.keywords).toEqual([]);
    // The summary falls back to the derived one, field by field.
    expect(result.header?.summary).not.toBe('Notes on the context read');
  });

  it('an explicit stale version on clear still conflicts; the right one clears to the derived header', async () => {
    const err = await refusal(() => call('entities.header.clear', { id: F.D }, { body: { expectedVersion: 1 } }));
    expect(err.code).toBe('version_conflict');
    const cleared = await call<HeaderResult>('entities.header.clear', { id: F.D }, { body: { expectedVersion: 2 } });
    // The result names the header now in effect: the derived one, version 0.
    expect(cleared.header).toMatchObject({
      entityId: F.D, kind: 'doc', source: 'derived', stale: false, version: 0, pinnedVersion: null,
      loadPointer: `tm8 entity context ${F.D}`,
    });
    expect(cleared.entity.header).toBeUndefined();
    expect((await get(F.D)).header).toBeUndefined();
    expect((await context(F.D)).header).toBeUndefined();
  });

  it('clear without a version is unguarded; clear with no header is a no-op that says so', async () => {
    await call<HeaderResult>('entities.header.set', { id: F.D }, { body: { summary: 'Short-lived' } });
    const cleared = await call<HeaderResult>('entities.header.clear', { id: F.D }, { body: {} });
    expect(cleared.header).toMatchObject({ source: 'derived', version: 0 });
    expect(cleared.activity).toBeDefined();
    expect(cleared.warnings).toBeUndefined();
    const again = await call<HeaderResult>('entities.header.clear', { id: F.D }, { body: {} });
    expect(again.activity).toBeUndefined();
    expect(again.warnings).toEqual([expect.objectContaining({ code: 'header_absent' })]);
  });

  it('a set with nothing left after trimming is a no-op that keeps the header and warns', async () => {
    await call<HeaderResult>('entities.header.set', { id: F.D }, { body: { whenToUse: 'Keep me' } });
    const empty = await call<HeaderResult>('entities.header.set', { id: F.D }, {
      body: { whenToUse: '   ', summary: '', keywords: [' '] },
    });
    expect(empty.warnings).toEqual([expect.objectContaining({ code: 'header_empty' })]);
    expect(empty.activity).toBeUndefined();
    expect(empty.header).toMatchObject({ whenToUse: 'Keep me', version: 1 });
    await call('entities.header.clear', { id: F.D }, { body: {} });
  });

  it('stores a 5,000-char summary whole; every reader sees ONE clipped value, declared', async () => {
    const summary = 'x'.repeat(5000);
    const keywords = ['', 'clip', 'clip', ...Array.from({ length: 14 }, (_, i) => `k${i}`), 'y'.repeat(90)];
    const set = await call<HeaderResult>('entities.header.set', { id: F.T }, {
      body: { whenToUse: '  Open when checking the clip  ', summary, keywords },
    });
    const clippedSummary = `${'x'.repeat(599)}…`;
    // The write's own result is the same resolved value every reader gets.
    expect(set.header).toMatchObject({ whenToUse: 'Open when checking the clip', summary: clippedSummary });
    expect(set.header?.keywords).toEqual(['clip', ...Array.from({ length: 11 }, (_, i) => `k${i}`)]);
    expect(set.header?.clipped).toEqual(['summary', 'keywords']);
    const stored = await database.query<{ n: number; k: number }>(
      'select char_length(summary)::int n, cardinality(keywords)::int k from public.entity_headers where entity_id = $1',
      [F.T],
    );
    expect(stored[0]).toEqual({ n: 5000, k: 16 });
    for (const read of [await get(F.T), await context(F.T)]) {
      expect(read.header?.summary).toBe(clippedSummary);
      expect(read.header?.whenToUse).toBe('Open when checking the clip');
      expect(read.header?.clipped).toEqual(['summary', 'keywords']);
    }
    // The resolver itself, which Jev and the prompt's context index read.
    const q = { query: database.query.bind(database) } as unknown as Querier;
    const spaceId = (await database.query<{ space_id: string }>(
      'select space_id from public.entities where id = $1', [F.T],
    ))[0]!.space_id;
    const resolved = (await resolveHeaders(q, spaceId, [F.T])).get(F.T)!;
    expect(resolved).toMatchObject({ source: 'authored', summary: clippedSummary, clipped: ['summary', 'keywords'] });
    // Jev cuts per field (600 each); the summary reaches it already cut, never whole.
    const jev = jevText(resolved);
    expect(jev).toContain(clippedSummary);
    expect(jev).not.toContain('x'.repeat(600));
    // A long keyword alone is cut and declared.
    await call('entities.header.set', { id: F.T }, { body: { summary: 'short', keywords: ['z'.repeat(90)] } });
    const kw = (await get(F.T)).header!;
    expect(kw.keywords).toEqual([`${'z'.repeat(39)}…`]);
    expect(kw.clipped).toEqual(['keywords']);
  });

  it('a kind that stores no header is a no-op success with a warning, not a refusal', async () => {
    const ws = await call<HeaderResult>('entities.header.set', { id: F.WS }, { body: { summary: 'nope' } });
    expect(ws.entity.id).toBe(F.WS);
    expect(ws.header).toBeUndefined();
    expect(ws.warnings).toEqual([{ code: 'header_not_stored', message: expect.stringContaining('referenced by id alone') }]);
    expect((await call<HeaderResult>('entities.header.clear', { id: F.WS }, { body: {} })).warnings)
      .toEqual([expect.objectContaining({ code: 'header_not_stored' })]);

    const skill = await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      const id = (await client.query<{ id: string }>('select internal.new_id()::text id')).rows[0]!.id;
      await client.query(
        `insert into public.entities(id, space_id, kind, position, created_by) values ($1, $2, 'skill', 0, $3)`,
        [id, F.space, F.member],
      );
      await client.query(
        `insert into public.skills(entity_id, space_id, name, description, content) values ($1, $2, 'hdr-skill', 'Deploys things', 'BODY')`,
        [id, F.space],
      );
      return id;
    });
    const onSkill = await call<HeaderResult>('entities.header.set', { id: skill }, { body: { summary: 'ignored' } });
    // The skill's own header is the one in effect; nothing was stored.
    expect(onSkill.header).toMatchObject({ source: 'native', summary: 'Deploys things', version: 0 });
    expect(onSkill.warnings).toEqual([{ code: 'header_not_stored', message: expect.stringContaining('description and when_to_use') }]);
    const rows = await database.query<{ n: number }>('select count(*)::int n from public.entity_headers where entity_id = $1', [skill]);
    expect(rows[0]?.n).toBe(0);
  });
});

describe('entities.create with a header (I4)', () => {
  it('writes the header in the create transaction', async () => {
    const created = await call<{ data: { entity: Detail } }>('entities.create', {}, {
      body: {
        spaceId: F.space, kind: 'doc', title: 'Header on create',
        content: { body: '# Body\n\nText.' },
        header: { whenToUse: 'Load when creating docs', summary: 'A created doc' },
      },
    });
    // entities.create answers through the facade's `{kind:'json', data}` wrapper.
    const detail = await get(created.data.entity.id);
    expect(detail.header).toMatchObject({
      source: 'authored', whenToUse: 'Load when creating docs', summary: 'A created doc',
      version: 1, pinnedVersion: detail.version,
    });
  });

  it('a kind that cannot carry a header is still created, and the result says the header was skipped', async () => {
    const title = `Memory with a header ${Date.now()}`;
    const created = await call<{ data: { entity: Detail; warnings?: Warning[] } }>('entities.create', {}, {
      body: {
        spaceId: F.space, kind: 'memory', title,
        content: { statement: title, mechanism: 'm', subjectScope: 's', doesNotEstablish: 'd' },
        header: { summary: 'not stored' },
      },
    });
    expect(created.data.entity.kind).toBe('memory');
    expect(created.data.warnings).toEqual([
      { code: 'header_not_stored', message: expect.stringContaining('subject_scope') },
    ]);
    const rows = await database.query<{ h: number }>(
      'select count(*)::int h from public.entity_headers where entity_id = $1',
      [created.data.entity.id],
    );
    expect(rows[0]?.h).toBe(0);
  });

  it('a receipt create carries the header warning in the receipt (a blank header on a task)', async () => {
    const created = await call<{ data: { ok: true; kind: string; warnings: Warning[] } }>('entities.create', {}, {
      query: new URLSearchParams({ return: 'receipt' }),
      body: { spaceId: F.space, kind: 'task', title: `Blank header ${Date.now()}`, header: { summary: '   ' } },
    });
    expect(created.data).toMatchObject({ ok: true, kind: 'task' });
    expect(created.data.warnings).toContainEqual(expect.objectContaining({ code: 'header_empty' }));
  });
});
