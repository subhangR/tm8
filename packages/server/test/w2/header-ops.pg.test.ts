/**
 * `entities.header.set` / `entities.header.clear` and `header` on entity reads
 * (headers design 01a0d31e T3; integrated design 01a0d348 §8 M2 I4).
 *
 * Through the production registry over a real PostgreSQL scratch database:
 *   - `entities.get` and the v2 `entities.context` carry the header once it
 *     is authored, with its own `version`, and nothing before that;
 *   - set writes an authored header, never moving `entities.version`; a stale
 *     header version is refused; clear falls back to the derived header;
 *   - `entities.create` writes a header in the create's transaction, and a
 *     kind that cannot carry one refuses the whole create;
 *   - a kind with no header (work_session) reads none.
 *
 * The RPC-level rules (RLS, kind allowlist, bounds, the teammate edit right)
 * are pinned in test/db/entity-headers.pg.test.ts; this is the operation seam.
 */
import type { EntityHeaderView, OperationName } from '@tm8/contract';
import { getOperation } from '@tm8/contract';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createDb } from '../../src/db/index.js';
import type { Db } from '../../src/db/types.js';
import { HandlerRegistry, registerFacadeHandlers } from '../../src/facade/index.js';
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
interface HeaderResult { entity: Detail; header: EntityHeaderView; activity?: { id: string } }

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
    expect(result.header.version).toBe(2);
    expect(result.header.keywords).toEqual([]);
    // The summary falls back to the derived one, field by field.
    expect(result.header.summary).not.toBe('Notes on the context read');
  });

  it('clear needs the header version and falls back to the derived header', async () => {
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

  it('refuses a kind that cannot carry a header', async () => {
    const err = await refusal(() => call('entities.header.set', { id: F.WS }, { body: { summary: 'nope' } }));
    expect(err.code).toBe('invalid_input');
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

  it('a kind that cannot carry a header refuses the whole create', async () => {
    const title = `Memory with a header ${Date.now()}`;
    const err = await refusal(() => call('entities.create', {}, {
      body: {
        spaceId: F.space, kind: 'memory', title,
        content: { statement: title, mechanism: 'm', subjectScope: 's', doesNotEstablish: 'd' },
        header: { summary: 'not allowed' },
      },
    }));
    expect(err.code).toBe('invalid_input');
    expect(err.message).toContain('cannot carry a selection header');
    const rows = await database.query<{ n: number }>(
      'select count(*)::int n from public.memories where statement = $1',
      [title],
    );
    expect(rows[0]?.n).toBe(0);
  });
});
