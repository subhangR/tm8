/**
 * `meta.get` — GET /v2/meta (s-lld §4, version signals; TM8 Mobile S2).
 *
 * Two things are proved here without a database. First, every field is
 * DERIVED: the features come from the catalog's statuses and the handler
 * registry at read time, never from a list kept by hand. Second, the chosen
 * access: the frame answers it for every caller, including a caller with no
 * credential at all and a gate session under TM8_SPACE_SESSIONS=enforce. The
 * same access over the real resolver and composition root is
 * test/db/meta-access.pg.test.ts.
 */
import { createHash } from 'node:crypto';

import {
  CONTRACT_VERSION,
  MetaGetResultSchema,
  OPERATIONS,
  RESERVED_OPERATIONS,
  WORKSPACE_EVENT_SCHEMA_VERSION,
  type MetaGetResult,
  type OperationName,
} from '@tm8/contract';
import { afterEach, describe, expect, it } from 'vitest';

import {
  CATALOG_SHA256,
  MIN_CLIENT_VERSIONS,
  metaFeatures,
  registerW2MetaHandlers,
} from '../src/facade/handlers/w2/meta.js';
import { HandlerRegistry } from '../src/facade/registry.js';
import type { ServerConfig } from '../src/http/config.js';
import { createFacadeServer, type FacadeServer } from '../src/http/server.js';
import type { RequestContext, RequestIdentity } from '../src/http/types.js';

const stub = async () => ({ ok: true });

async function readMeta(registry: HandlerRegistry): Promise<MetaGetResult> {
  const handler = registry.get('meta.get');
  if (!handler) throw new Error('meta.get is not registered');
  const op = OPERATIONS.find((row) => row.name === 'meta.get')!;
  return await handler({
    op,
    opName: 'meta.get',
    params: {},
    query: new URLSearchParams(),
    body: undefined,
    requestId: 'req_meta',
    identity: { kind: 'anonymous' },
    headers: {},
    method: 'GET',
    path: '/v2/meta',
  } as RequestContext) as MetaGetResult;
}

/** The rule, written out independently of the handler. */
function served(registry: HandlerRegistry): string[] {
  return OPERATIONS
    .filter((op) => op.status === 'v1' && (op.method === 'WS' || registry.has(op.name)))
    .map((op) => op.name);
}

describe('meta.get — every field is derived', () => {
  it('answers exactly the five fields, and the answer parses', async () => {
    const registry = new HandlerRegistry();
    registerW2MetaHandlers(registry);
    const meta = await readMeta(registry);
    expect(Object.keys(meta).sort()).toEqual(
      ['catalogSha256', 'contractVersion', 'eventSchemaVersion', 'features', 'minClients'],
    );
    expect(MetaGetResultSchema.parse(meta)).toEqual(meta);
  });

  it('reports the contract version /health reports, and the event schemaVersion events carry', async () => {
    const registry = new HandlerRegistry();
    registerW2MetaHandlers(registry);
    const meta = await readMeta(registry);
    expect(meta.contractVersion).toBe(CONTRACT_VERSION);
    expect(meta.eventSchemaVersion).toBe(WORKSPACE_EVENT_SCHEMA_VERSION);
  });

  it('catalogSha256 is sha256(JSON.stringify(OPERATIONS)), the digest `tm8 help` prints', async () => {
    const registry = new HandlerRegistry();
    registerW2MetaHandlers(registry);
    const expected = createHash('sha256').update(JSON.stringify(OPERATIONS)).digest('hex');
    expect(CATALOG_SHA256).toBe(expected);
    expect((await readMeta(registry)).catalogSha256).toBe(expected);
  });

  it('features: the v1 rows this node serves, in catalog order, read from the registry at request time', async () => {
    const registry = new HandlerRegistry();
    registerW2MetaHandlers(registry);
    const before = await readMeta(registry);
    expect(before.features).toEqual(served(registry));
    // Itself, and the socket rows, which the server frame mounts rather than the registry.
    expect(before.features).toEqual(expect.arrayContaining(['meta.get', 'events.subscribe', 'containers.stream']));
    // A v1 row with no handler answers 501 here, so it is not a feature.
    expect(before.features).not.toContain('identity.get');

    // Mount two more after the meta handler: the next read lists them. Nobody
    // edited a list, so nothing could have been forgotten.
    registry.register('identity.get', stub).register('spaces.list', stub);
    const after = await readMeta(registry);
    expect(after.features).toEqual(served(registry));
    expect(after.features).toEqual(expect.arrayContaining(['identity.get', 'spaces.list']));
    expect(after.features).toHaveLength(before.features.length + 2);
  });

  it('features never lists a reserved operation, and lists every mounted v1 one', () => {
    const registry = new HandlerRegistry();
    registerW2MetaHandlers(registry);
    // Mount every registerable v1 HTTP row, as a full composition would.
    for (const op of OPERATIONS) {
      if (op.status === 'v1' && op.method !== 'WS' && !registry.has(op.name)) registry.register(op.name, stub);
    }
    const features = metaFeatures(registry);
    expect(features).toEqual(OPERATIONS.filter((op) => op.status === 'v1').map((op) => op.name));
    expect(RESERVED_OPERATIONS.length).toBeGreaterThan(0);
    for (const op of RESERVED_OPERATIONS) expect(features).not.toContain(op.name);
  });

  it('minClients is the node policy constant: client names and MAJOR.MINOR.PATCH versions', async () => {
    const registry = new HandlerRegistry();
    registerW2MetaHandlers(registry);
    expect((await readMeta(registry)).minClients).toEqual(MIN_CLIENT_VERSIONS);
    for (const [client, version] of Object.entries(MIN_CLIENT_VERSIONS)) {
      expect(client).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });
});

const SPACE = '019f9896-928d-79b6-ba1c-1cdcc1d30a6f';
const ENFORCE: ServerConfig = {
  host: '127.0.0.1', port: 0, uiDir: undefined, maxBodyBytes: 1024 * 1024, databaseUrl: undefined,
  spaceSessions: 'enforce',
};

const CALLERS: ReadonlyArray<{ label: string; identity: RequestIdentity }> = [
  { label: 'no credential at all (anonymous)', identity: { kind: 'anonymous' } },
  {
    label: 'a gate session under enforce (cli bearer, no space)',
    identity: { kind: 'bearer', identityId: 'h', accountId: 'a', sessionId: 's', authKind: 'cli' },
  },
  {
    label: 'a space-pinned session',
    identity: { kind: 'bearer', identityId: 'h', accountId: 'a', sessionId: 's', authKind: 'browser', sessionSpaceId: SPACE },
  },
  {
    label: 'an agent session',
    identity: { kind: 'bearer', identityId: 'g', accountId: 'a', sessionId: 's', authKind: 'agent', sessionSpaceId: SPACE },
  },
  { label: 'the loopback auto-owner', identity: { kind: 'auto-owner', identityId: 'o', authKind: 'browser' } },
];

describe('meta.get — the chosen access: every caller, signed in or not', () => {
  let server: FacadeServer | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  async function serve(identity: RequestIdentity) {
    const registry = new HandlerRegistry().register('spaces.get', stub);
    registerW2MetaHandlers(registry);
    server = createFacadeServer({
      config: ENFORCE, registry, identityResolver: () => identity, authRateLimiter: null,
    });
    return (await server.listen()).url;
  }

  for (const { label, identity } of CALLERS) {
    it(`${label}: 200 with the full answer`, async () => {
      const url = await serve(identity);
      const res = await fetch(`${url}/v2/meta`);
      expect(res.status).toBe(200);
      const body = await res.json() as { data: MetaGetResult; requestId: string };
      expect(MetaGetResultSchema.parse(body.data).features).toContain('meta.get' satisfies OperationName);
      expect(body.data.catalogSha256).toBe(CATALOG_SHA256);
    });
  }

  it('the gate is on in this config: the same gate session is refused a space read', async () => {
    const gate = CALLERS[1]!.identity;
    const url = await serve(gate);
    const res = await fetch(`${url}/v2/spaces/${SPACE}`);
    expect(res.status).toBe(403);
    expect((await res.json() as { error: { code: string } }).error.code).toBe('forbidden');
  });
});
