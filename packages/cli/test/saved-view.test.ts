/**
 * `tm8 saved-view list|create|update|delete` — group 7, G09 saved views.
 *
 * `saved-view update` WAS BLOCKED HERE AND IS NOW UNBLOCKED. It was specified
 * with `--expect-version <n>` REQUIRED and summarised as "Redefine a saved view
 * under a version guard", but `SavedViewInputSchema` is `.strict()` with no
 * `expectedVersion`, `SavedView` publishes no version for a caller to read, and
 * `update_saved_view(...)` (migration 024) takes no such parameter. The guard
 * was fictional at every layer. The projection has since been corrected — the
 * flag and the `ver:` marker are gone and the summary now says "Replace the
 * name, sharing, and query of a saved view" — so the row binds normally.
 *
 * The one thing kept from the blocked period: `--expect-version` is refused BY
 * NAME rather than ignored. An agent that learned the earlier grammar would
 * otherwise pass a guard, have it silently dropped, and believe it held. A flag
 * that quietly does nothing is worse than one that fails.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { run } from '../src/run.js';
import { isRegisteredPath } from '../src/commands/registry.js';

/**
 * Drive the REAL kernel router — `run()` — including the registry lookup this
 * slot does not own. Group 7's modules are wired into `commands/registry.ts`
 * now, so nothing about dispatch is substituted here: this is the same path the
 * shipped binary takes, minus the process-exiting entry wrapper.
 */
async function tm8(argv: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const o = vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => {
    out.push(String(c));
    return true;
  });
  const e = vi.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => {
    err.push(String(c));
    return true;
  });
  try {
    const code = await run(argv);
    return { code, stdout: out.join(''), stderr: err.join('') };
  } finally {
    o.mockRestore();
    e.mockRestore();
  }
}

interface Recorded {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
}

let server: Server;
let baseUrl: string;
let recorded: Recorded[] = [];
let reply: { status: number; body: unknown } = { status: 200, body: { data: [], requestId: 'req_t' } };

const SPACE = '11111111-1111-7111-8111-111111111111';
const OTHER_SPACE = '99999999-9999-7999-8999-999999999999';
const VIEW = '55555555-5555-7555-8555-555555555555';
const ACTOR = '44444444-4444-7444-8444-444444444444';

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      recorded.push({
        method: req.method ?? '',
        path: url.pathname,
        query: url.searchParams,
        body: raw ? (JSON.parse(raw) as unknown) : undefined,
      });
      res.setHeader('content-type', 'application/json');
      res.statusCode = reply.status;
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (typeof addr === 'string' || addr === null) throw new Error('no address');
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});

beforeEach(() => {
  recorded = [];
  reply = { status: 200, body: { data: [], requestId: 'req_t' } };
  process.env.TM8_BASE_URL = baseUrl;
  delete process.env.TM8_SPACE_ID;
  delete process.env.TM8_ACTOR_ID;
  delete process.env.TM8_CONFIG_PATH;
});

const QUERY = JSON.stringify({ kinds: ['task'] });

describe('tm8 saved-view list — savedViews.list', () => {
  it('binds GET /v2/spaces/:spaceId/saved-views', async () => {
    const r = await tm8(['saved-view', 'list', '--space', SPACE]);
    expect(r.code).toBe(0);
    expect(recorded[0]?.method).toBe('GET');
    expect(recorded[0]?.path).toBe(`/v2/spaces/${SPACE}/saved-views`);
  });

  it('refuses locally with no Space in context', async () => {
    const r = await tm8(['saved-view', 'list']);
    expect(r.code).toBe(2);
    expect(recorded).toHaveLength(0);
    expect(r.stderr).toContain('--space');
  });

  /**
   * The contract gives `savedViews.list` no limit and no cursor — it answers a
   * bare array, not a Page. Measured against a real Server, 3 stored views with
   * `--limit 1` returned all 3: silently ignored, not rejected. A flag with no
   * wire destination is the same disease as the fictional version guard, so it
   * is refused by name rather than sent into the void.
   */
  it('refuses --limit and --cursor by name: this operation is unpaginated', async () => {
    const limited = await tm8(['saved-view', 'list', '--space', SPACE, '--limit', '5']);
    expect(limited.code).toBe(2);
    expect(limited.stderr).toContain('--limit');

    const cursored = await tm8(['saved-view', 'list', '--space', SPACE, '--cursor', 'c1']);
    expect(cursored.code).toBe(2);
    expect(cursored.stderr).toContain('--cursor');

    expect(recorded).toHaveLength(0);
  });

  it('sends no query parameters at all on the plain list', async () => {
    await tm8(['saved-view', 'list', '--space', SPACE]);
    expect([...(recorded[0]?.query.keys() ?? [])]).toEqual([]);
  });

  it('refuses --mutation-id on a read', async () => {
    const r = await tm8(['saved-view', 'list', '--space', SPACE, '--mutation-id', 'x']);
    expect(r.code).toBe(2);
    expect(recorded).toHaveLength(0);
  });

  it('keeps the view id in human output — update and delete both need it', async () => {
    reply = {
      status: 200,
      body: {
        data: [{
          id: VIEW, spaceId: SPACE, name: 'My tasks', shareMode: 'private',
          query: { spaceId: SPACE }, createdBy: { id: ACTOR, name: 'Ada' },
          createdAt: '2026-07-27T00:00:00.000Z',
        }],
        requestId: 'req_t',
      },
    };
    const r = await tm8(['saved-view', 'list', '--space', SPACE]);
    expect(r.stdout).toContain(VIEW);
    expect(r.stdout).toContain('My tasks');
  });
});

describe('tm8 saved-view create — savedViews.create', () => {
  beforeEach(() => {
    reply = {
      status: 201,
      body: {
        data: {
          id: VIEW, spaceId: SPACE, name: 'My tasks', shareMode: 'private',
          query: { spaceId: SPACE }, createdBy: { id: ACTOR, name: 'Ada' },
          createdAt: '2026-07-27T00:00:00.000Z',
        },
        requestId: 'req_t',
      },
    };
  });

  it('binds POST /v2/saved-views and accepts 201 as a success', async () => {
    const r = await tm8(['saved-view', 'create', 'My tasks', '--space', SPACE, '--share', 'private', '--query', QUERY]);
    expect(r.code).toBe(0);
    expect(recorded[0]?.method).toBe('POST');
    expect(recorded[0]?.path).toBe('/v2/saved-views');
  });

  it('sends exactly the frozen SavedViewInput fields', async () => {
    await tm8(['saved-view', 'create', 'My tasks', '--space', SPACE, '--share', 'private', '--query', QUERY]);
    const body = recorded[0]?.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['clientMutationId', 'name', 'query', 'shareMode']);
    expect(body.name).toBe('My tasks');
    expect(body.shareMode).toBe('private');
  });

  /**
   * `CollectionQuery.spaceId` is REQUIRED by the contract, but the CLI's Space
   * arrives through the four-step context chain. Filling it from the resolved
   * Space is binding a required contract field from the established source; it
   * is not inventing one.
   */
  it('fills query.spaceId from the resolved Space when the query omits it', async () => {
    await tm8(['saved-view', 'create', 'My tasks', '--space', SPACE, '--share', 'private', '--query', QUERY]);
    const body = recorded[0]?.body as { query: { spaceId: string; kinds: string[] } };
    expect(body.query.spaceId).toBe(SPACE);
    expect(body.query.kinds).toEqual(['task']);
  });

  it('refuses a query whose spaceId contradicts --space rather than silently picking one', async () => {
    const conflicting = JSON.stringify({ spaceId: OTHER_SPACE, kinds: ['task'] });
    const r = await tm8(['saved-view', 'create', 'My tasks', '--space', SPACE, '--share', 'private', '--query', conflicting]);
    expect(r.code).toBe(2);
    expect(recorded).toHaveLength(0);
  });

  it('honours a query that carries its own spaceId when --space is absent', async () => {
    const owned = JSON.stringify({ spaceId: OTHER_SPACE });
    await tm8(['saved-view', 'create', 'My tasks', '--share', 'space', '--query', owned]);
    expect((recorded[0]?.body as { query: { spaceId: string } }).query.spaceId).toBe(OTHER_SPACE);
  });

  it('requires --share and rejects a value outside private|space', async () => {
    const missing = await tm8(['saved-view', 'create', 'My tasks', '--space', SPACE, '--query', QUERY]);
    expect(missing.code).toBe(2);

    const bogus = await tm8(['saved-view', 'create', 'My tasks', '--space', SPACE, '--share', 'public', '--query', QUERY]);
    expect(bogus.code).toBe(2);
    expect(bogus.stderr).toContain('private');
    expect(recorded).toHaveLength(0);
  });

  it('requires --query', async () => {
    const r = await tm8(['saved-view', 'create', 'My tasks', '--space', SPACE, '--share', 'private']);
    expect(r.code).toBe(2);
    expect(recorded).toHaveLength(0);
  });

  it('requires the view name', async () => {
    const r = await tm8(['saved-view', 'create', '--space', SPACE, '--share', 'private', '--query', QUERY]);
    expect(r.code).toBe(2);
    expect(recorded).toHaveLength(0);
  });

  it('rejects invalid JSON in --query locally, never putting it on the wire', async () => {
    const r = await tm8(['saved-view', 'create', 'My tasks', '--space', SPACE, '--share', 'private', '--query', '{nope']);
    expect(r.code).toBe(2);
    expect(recorded).toHaveLength(0);
  });

  it('sends --graph-layout when given', async () => {
    const layout = JSON.stringify({ [VIEW]: { x: 1, y: 2 } });
    await tm8([
      'saved-view', 'create', 'My tasks', '--space', SPACE, '--share', 'private',
      '--query', QUERY, '--graph-layout', layout,
    ]);
    expect((recorded[0]?.body as { graphLayout?: unknown }).graphLayout).toEqual({ [VIEW]: { x: 1, y: 2 } });
  });

  it('carries actorId from --as', async () => {
    await tm8([
      'saved-view', 'create', 'My tasks', '--space', SPACE, '--share', 'private',
      '--query', QUERY, '--as', ACTOR,
    ]);
    expect((recorded[0]?.body as { actorId?: string }).actorId).toBe(ACTOR);
  });
});

describe('tm8 saved-view update — savedViews.update', () => {
  beforeEach(() => {
    reply = {
      status: 200,
      body: {
        data: {
          id: VIEW, spaceId: SPACE, name: 'Renamed', shareMode: 'space',
          query: { spaceId: SPACE }, createdBy: { id: ACTOR, name: 'Ada' },
          createdAt: '2026-07-27T00:00:00.000Z',
        },
        requestId: 'req_t',
      },
    };
  });

  it('binds PATCH /v2/saved-views/:viewId', async () => {
    const r = await tm8([
      'saved-view', 'update', VIEW, '--name', 'Renamed', '--share', 'space',
      '--query', QUERY, '--space', SPACE,
    ]);
    expect(r.code, r.stderr).toBe(0);
    expect(recorded[0]?.method).toBe('PATCH');
    expect(recorded[0]?.path).toBe(`/v2/saved-views/${VIEW}`);
  });

  it('sends exactly the frozen SavedViewInput fields — and no expectedVersion', async () => {
    await tm8([
      'saved-view', 'update', VIEW, '--name', 'Renamed', '--share', 'space',
      '--query', QUERY, '--space', SPACE,
    ]);
    const body = recorded[0]?.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['clientMutationId', 'name', 'query', 'shareMode']);
    expect(body).not.toHaveProperty('expectedVersion');
  });

  /**
   * The guard was fictional at every layer, and the projection has been
   * corrected. It is refused BY NAME rather than ignored: an agent that learned
   * the earlier grammar would otherwise pass a guard, have it silently dropped,
   * and believe it held — which is precisely what made the fictional flag
   * dangerous.
   */
  it('refuses --expect-version by name instead of silently dropping it', async () => {
    const r = await tm8([
      'saved-view', 'update', VIEW, '--expect-version', '3', '--name', 'Renamed',
      '--share', 'space', '--query', QUERY, '--space', SPACE,
    ]);
    expect(r.code).toBe(2);
    expect(recorded).toHaveLength(0);
    expect(r.stderr).toContain('--expect-version');
  });

  it('requires --name, because the update REPLACES rather than patches', async () => {
    const r = await tm8([
      'saved-view', 'update', VIEW, '--share', 'space', '--query', QUERY, '--space', SPACE,
    ]);
    expect(r.code).toBe(2);
    expect(recorded).toHaveLength(0);
    expect(r.stderr).toContain('--name');
  });

  it('requires --share and --query for the same reason', async () => {
    const noShare = await tm8([
      'saved-view', 'update', VIEW, '--name', 'Renamed', '--query', QUERY, '--space', SPACE,
    ]);
    expect(noShare.code).toBe(2);
    const noQuery = await tm8([
      'saved-view', 'update', VIEW, '--name', 'Renamed', '--share', 'space', '--space', SPACE,
    ]);
    expect(noQuery.code).toBe(2);
    expect(recorded).toHaveLength(0);
  });

  it('requires the view id', async () => {
    const r = await tm8([
      'saved-view', 'update', '--name', 'Renamed', '--share', 'space',
      '--query', QUERY, '--space', SPACE,
    ]);
    expect(r.code).toBe(2);
    expect(recorded).toHaveLength(0);
  });

  it('reconciles query.spaceId against --space, as create does', async () => {
    const conflicting = JSON.stringify({ spaceId: OTHER_SPACE });
    const r = await tm8([
      'saved-view', 'update', VIEW, '--name', 'Renamed', '--share', 'space',
      '--query', conflicting, '--space', SPACE,
    ]);
    expect(r.code).toBe(2);
    expect(recorded).toHaveLength(0);
  });

  it('carries actorId from --as', async () => {
    await tm8([
      'saved-view', 'update', VIEW, '--name', 'Renamed', '--share', 'space',
      '--query', QUERY, '--space', SPACE, '--as', ACTOR,
    ]);
    expect((recorded[0]?.body as { actorId?: string }).actorId).toBe(ACTOR);
  });

  /**
   * `--graph-layout` closes an EXPRESSIVENESS gap only. The Server replaces the
   * column wholesale, so any caller omitting the field still nulls a stored
   * layout — that is a server merge fix, not this flag. Asserted here is
   * exactly what the flag DOES do: when given, the layout reaches the wire;
   * when omitted, the CLI sends no `graphLayout` key at all rather than an
   * explicit null, so the CLI is not itself the one requesting the erasure.
   */
  it('sends --graph-layout on update when given', async () => {
    const layout = JSON.stringify({ [VIEW]: { x: 9, y: 9 } });
    await tm8([
      'saved-view', 'update', VIEW, '--name', 'Renamed', '--share', 'space',
      '--query', QUERY, '--space', SPACE, '--graph-layout', layout,
    ]);
    expect((recorded[0]?.body as { graphLayout?: unknown }).graphLayout)
      .toEqual({ [VIEW]: { x: 9, y: 9 } });
  });

  it('omits the graphLayout key entirely when the flag is absent', async () => {
    await tm8([
      'saved-view', 'update', VIEW, '--name', 'Renamed', '--share', 'space',
      '--query', QUERY, '--space', SPACE,
    ]);
    // NOT `graphLayout: null`. The CLI declines to express an erasure it was
    // never asked for; what the Server then does with an absent key is the
    // server-side defect, and it must stay visible as such.
    expect(Object.keys(recorded[0]?.body as object)).not.toContain('graphLayout');
  });

  it('is registered in the real command registry', () => {
    expect(isRegisteredPath(['saved-view', 'update'])).toBe(true);
  });
});

describe('tm8 saved-view delete — savedViews.delete', () => {
  beforeEach(() => {
    reply = {
      status: 200,
      body: {
        data: {
          id: VIEW, spaceId: SPACE, name: 'My tasks', shareMode: 'private',
          query: { spaceId: SPACE }, createdBy: { id: ACTOR, name: 'Ada' },
          createdAt: '2026-07-27T00:00:00.000Z',
        },
        requestId: 'req_t',
      },
    };
  });

  it('refuses without --yes and sends nothing (§7.5)', async () => {
    const r = await tm8(['saved-view', 'delete', VIEW]);
    expect(r.code).toBe(2);
    expect(recorded).toHaveLength(0);
    expect(r.stderr).toContain('--yes');
  });

  it('binds DELETE /v2/saved-views/:viewId with --yes', async () => {
    const r = await tm8(['saved-view', 'delete', VIEW, '--yes']);
    expect(r.code).toBe(0);
    expect(recorded[0]?.method).toBe('DELETE');
    expect(recorded[0]?.path).toBe(`/v2/saved-views/${VIEW}`);
  });

  it('carries a clientMutationId — the operation requires one', async () => {
    await tm8(['saved-view', 'delete', VIEW, '--yes']);
    const body = recorded[0]?.body as { clientMutationId?: string };
    expect(typeof body?.clientMutationId).toBe('string');
    expect(body!.clientMutationId!.length).toBeGreaterThan(0);
  });

  it('requires the view id', async () => {
    const r = await tm8(['saved-view', 'delete', '--yes']);
    expect(r.code).toBe(2);
    expect(recorded).toHaveLength(0);
  });
});
