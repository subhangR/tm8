/**
 * The G1A loop, end to end, over real HTTP.
 *
 * This is the acceptance test for the facade slice: a real `node:http` server
 * on an ephemeral port, real `fetch` calls, a real Postgres behind it. Not the
 * handlers called as functions — the whole pipeline, including routing, the
 * zod input schemas, the DEV-6 envelope and the DEV-8 error body. A handler
 * that works when called directly and 400s over the wire is a handler that
 * does not work.
 *
 * The path it drives is the one the user hand-tests:
 *   identity → space → project + link → task → read it back → thread → work →
 *   complete.
 *
 * Needs TM8_DATABASE_URL. Skipped by name without one.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HandlerRegistry, registerFacadeHandlers } from '../../src/facade/index.js';
import { createFacadeServer, type FacadeServer } from '../../src/http/server.js';
import { createDb } from '../../src/db/index.js';
import type { Db } from '../../src/db/types.js';
import type { ServerConfig } from '../../src/http/config.js';

const DATABASE_URL = process.env.TM8_DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

describeDb('G1A loop over HTTP', () => {
  let server: FacadeServer;
  let db: Db;
  let base: string;

  beforeAll(async () => {
    db = createDb(DATABASE_URL as string);
    const registry = new HandlerRegistry();
    const config: ServerConfig = {
      host: '127.0.0.1',
      // Port 0 binds an ephemeral port, so this suite never collides with the
      // dev server on 4610 or with another lane's test run.
      port: 0,
      uiDir: undefined,
      maxBodyBytes: 8 * 1024 * 1024,
      databaseUrl: DATABASE_URL,
    };
    registerFacadeHandlers(registry, { db, config });
    // The frame is assembled directly rather than through `bootstrap()`, so
    // this suite tests THE FACADE and does not go red whenever the composition
    // root (another lane's file) is mid-edit. It is still the real HTTP
    // pipeline — same router, same envelope, same error writer.
    server = createFacadeServer({ config, registry });
    const { url } = await server.listen();
    base = url;
  });

  afterAll(async () => {
    await server.close();
    await db.end();
  });

  /** Unwraps the DEV-6 `{data, requestId}` envelope, failing loudly on an error body. */
  async function call<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; data: T }> {
    const res = await fetch(`${base}${path}`, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
    const json = (await res.json()) as { data?: T; error?: { code: string; message: string } };
    if (json.error) {
      throw new Error(`${method} ${path} -> ${res.status} ${json.error.code}: ${json.error.message}`);
    }
    return { status: res.status, data: json.data as T };
  }

  async function expectError(method: string, path: string, body?: unknown): Promise<{ status: number; code: string }> {
    const res = await fetch(`${base}${path}`, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
    const json = (await res.json()) as { error?: { code: string } };
    if (!json.error) throw new Error(`${method} ${path} unexpectedly succeeded`);
    return { status: res.status, code: json.error.code };
  }

  // Threaded through the suite: each step needs what the last one created,
  // which is the point — this is a loop, not eight independent assertions.
  let spaceId: string;
  let memberId: string;
  let projectId: string;
  let taskId: string;
  let taskVersion: number;

  it('identity.get returns the bootstrapped loopback owner', async () => {
    const { status, data } = await call<{ identityId: string; isOwner: boolean; username: string }>(
      'GET',
      '/v2/identity',
    );
    expect(status).toBe(200);
    expect(data.identityId).toMatch(/^id_/);
    expect(data.isOwner).toBe(true);
    expect(data.username).toBe('owner');
  });

  it('spaces.create mints the space, the owner member and the general channel', async () => {
    const { status, data } = await call<{
      space: { id: string; name: string; memberCount: number };
      memberId: string;
      defaultChannelId: string;
    }>('POST', '/v2/spaces', { name: 'G1A Loop', description: 'the loop' });

    expect(status).toBe(201);
    expect(data.space.name).toBe('G1A Loop');
    // The member row is what every later write authors as — its absence is why
    // a space must exist before anything else can be created.
    expect(data.memberId).toBeTruthy();
    expect(data.defaultChannelId).toBeTruthy();
    expect(data.space.memberCount).toBe(1);
    spaceId = data.space.id;
    memberId = data.memberId;
  });

  it('spaces.list includes the new space', async () => {
    const { data } = await call<Array<{ id: string }>>('GET', '/v2/spaces');
    expect(data.map((s) => s.id)).toContain(spaceId);
  });

  it('projects.create + projects.link give the spawn path a real projectId', async () => {
    const dir = `/tmp/tm8-loop-${Date.now()}`;
    // A BARE ProjectResource — a project is a resource, not an entity, so there
    // is no CommandResult to wrap it in (conformance projects.test.ts:27).
    const created = await call<{ id: string; trust: string; workingDir: string }>(
      'POST',
      '/v2/projects',
      { name: 'loop-project', workingDir: dir },
    );
    expect(created.status).toBe(201);
    // Trust is an explicit grant, never a default (S12).
    expect(created.data.trust).toBe('untrusted');
    expect(created.data.workingDir).toBe(dir);
    projectId = created.data.id;

    const linked = await call<{ projectId: string }>('POST', `/v2/spaces/${spaceId}/projects`, {
      projectId,
    });
    expect(linked.data.projectId).toBe(projectId);

    const scoped = await call<Array<{ id: string }>>('GET', `/v2/projects?spaceId=${spaceId}`);
    expect(scoped.data.map((p) => p.id)).toContain(projectId);
  });

  it('entities.create builds a task with derived title, capabilities and content', async () => {
    const { status, data } = await call<{
      entity: {
        id: string;
        kind: string;
        title: string;
        version: number;
        state: { kind: string; workStatus: string; acceptance: { total: number; completed: number } };
        content: { kind: string; description: string };
        capabilities: { canComplete: boolean; canEdit: boolean };
      };
      patches: Array<{ id: string }>;
    }>('POST', '/v2/entities', {
      spaceId,
      kind: 'task',
      title: 'Wire the loop',
      content: {
        description: 'Prove the vertical slice works.',
        priority: 'high',
        acceptanceCriteria: [{ text: 'server answers' }],
      },
    });

    expect(status).toBe(201);
    expect(data.entity.kind).toBe('task');
    // The title is DERIVED server-side and is never an id (L3).
    expect(data.entity.title).toBe('Wire the loop');
    expect(data.entity.state.workStatus).toBe('open');
    expect(data.entity.state.acceptance).toEqual({ total: 1, completed: 0 });
    expect(data.entity.content.description).toBe('Prove the vertical slice works.');
    // `canComplete` is an AFFORDANCE, not a pre-flight check: it is true on a
    // live task even with criteria outstanding. The gate lives in the RPC and
    // is asserted separately below. (I had this backwards until conformance
    // reads.test.ts:45 settled it.)
    expect(data.entity.capabilities.canComplete).toBe(true);
    expect(data.entity.capabilities.canEdit).toBe(true);
    expect(data.patches.map((p) => p.id)).toContain(data.entity.id);

    taskId = data.entity.id;
    taskVersion = data.entity.version;
  });

  it('entities.get reads the same task back identically', async () => {
    const { data } = await call<{
      id: string;
      title: string;
      hierarchy: { parent: unknown; children: { items: unknown[] } };
      connections: { unresolvedHardDependencyCount: number };
      counters: { messages: number; viewerReaction: string | null };
    }>('GET', `/v2/entities/${taskId}`);

    expect(data.id).toBe(taskId);
    expect(data.title).toBe('Wire the loop');
    expect(data.hierarchy.parent).toBeNull();
    expect(data.connections.unresolvedHardDependencyCount).toBe(0);
    expect(data.counters.viewerReaction).toBeNull();
  });

  it('collections.query finds the task with a keyset cursor, not an offset', async () => {
    const { data } = await call<{
      query: { sort: string; limit: number };
      page: { items: Array<{ id: string; title: string }>; nextCursor: string | null };
    }>('POST', '/v2/collections/query', { spaceId, kinds: ['task'] });

    expect(data.page.items.map((i) => i.id)).toContain(taskId);
    // The query comes back RESOLVED so a client can re-run it verbatim.
    expect(data.query.sort).toBe('activityAt_desc');
    expect(data.query.limit).toBe(50);
  });

  it('collections.query paginates by keyset and rejects a junk cursor', async () => {
    const first = await call<{ page: { items: Array<{ id: string }>; nextCursor: string | null } }>(
      'POST',
      '/v2/collections/query',
      { spaceId, kinds: ['task', 'channel', 'member'], limit: 1 },
    );
    expect(first.data.page.items).toHaveLength(1);
    expect(first.data.page.nextCursor).toBeTruthy();

    const second = await call<{ page: { items: Array<{ id: string }> } }>('POST', '/v2/collections/query', {
      spaceId,
      kinds: ['task', 'channel', 'member'],
      limit: 1,
      cursor: first.data.page.nextCursor,
    });
    expect(second.data.page.items).toHaveLength(1);
    // A keyset page never repeats the row it resumed from.
    expect(second.data.page.items[0]?.id).not.toBe(first.data.page.items[0]?.id);

    // DEV-5: an offset-shaped cursor is refused, not reinterpreted as page 1.
    const bad = await expectError('POST', '/v2/collections/query', {
      spaceId,
      kinds: ['task'],
      cursor: '25',
    });
    expect(bad.code).toBe('invalid_cursor');
    expect(bad.status).toBe(400);
  });

  it('collections.query groups by workStatus server-side', async () => {
    const { data } = await call<{ groups?: Array<{ key: string; label: string }> }>(
      'POST',
      '/v2/collections/query',
      { spaceId, kinds: ['task'], groupBy: 'workStatus', sort: 'position' },
    );
    expect(data.groups?.map((g) => g.key)).toContain('open');
  });

  it('messages.post + messages.list carry the task thread', async () => {
    const posted = await call<{ entity: { id: string } }>('POST', '/v2/messages', {
      anchorId: taskId,
      body: 'starting work now',
    });
    expect(posted.status).toBe(201);

    const listed = await call<{
      items: Array<{ id: string; content: { body: string }; replyCount: number; state: { anchorId: string } }>;
    }>('GET', `/v2/entities/${taskId}/messages`);

    expect(listed.data.items).toHaveLength(1);
    expect(listed.data.items[0]?.content.body).toBe('starting work now');
    expect(listed.data.items[0]?.state.anchorId).toBe(taskId);
    expect(listed.data.items[0]?.replyCount).toBe(0);
  });

  it('/commands/work moves the task and records the working_on edge', async () => {
    const { data } = await call<{ entity: { state: { kind: string; workStatus: string }; version: number } }>(
      'POST',
      `/v2/entities/${taskId}/commands/work`,
      { status: 'working' },
    );
    expect(data.entity.state.workStatus).toBe('working');
    taskVersion = data.entity.version;
  });

  it('/commands/work refuses done — completion has a gate', async () => {
    // 007:1894 raises rather than letting a status write route around
    // complete_task's acceptance-criteria check.
    const err = await expectError('POST', `/v2/entities/${taskId}/commands/work`, { status: 'done' });
    expect(err.code).toBe('invariant_violation');
    expect(err.status).toBe(409);
  });

  it('/commands/complete requires at least one completer', async () => {
    // The frozen contract's `completerIds` is `.min(1)`: a completion has to
    // say WHO completed it, because the award ledger pays them. An empty array
    // is a malformed request, refused by the schema before it reaches the RPC.
    const err = await expectError('POST', `/v2/entities/${taskId}/commands/complete`, {
      expectedVersion: taskVersion,
      completerIds: [],
    });
    expect(err.code).toBe('invalid_input');
    expect(err.status).toBe(400);
  });

  it('/commands/complete is refused while a criterion is outstanding', async () => {
    const err = await expectError('POST', `/v2/entities/${taskId}/commands/complete`, {
      expectedVersion: taskVersion,
      completerIds: [memberId],
    });
    expect(err.code).toBe('invariant_violation');
    expect(err.status).toBe(409);
  });

  it('entities.patch ticks the criterion, then /commands/complete succeeds', async () => {
    const patched = await call<{
      entity: {
        version: number;
        capabilities: { canComplete: boolean };
        content: { acceptanceCriteria: Array<{ done: boolean }> };
      };
    }>('PATCH', `/v2/entities/${taskId}`, {
      expectedVersion: taskVersion,
      content: { acceptanceCriteria: [{ id: 'ac_1', text: 'server answers', done: true }] },
    });
    expect(patched.data.entity.content.acceptanceCriteria[0]?.done).toBe(true);
    // The gate is now satisfied — the RPC will accept the completion. The
    // capability was already true; it tracks the kind and liveness, not the gate.
    expect(patched.data.entity.capabilities.canComplete).toBe(true);

    const completed = await call<{
      entity: { state: { kind: string; workStatus: string } };
      patches: Array<{ id: string }>;
    }>('POST', `/v2/entities/${taskId}/commands/complete`, {
      expectedVersion: patched.data.entity.version,
      completerIds: [memberId],
    });
    expect(completed.data.entity.state.workStatus).toBe('done');
    // The completer is patched too — `complete_task` writes the `completed_by`
    // edge and the point award in the same transaction.
    expect(completed.data.patches.map((p) => p.id)).toContain(memberId);
  });

  it('a stale expectedVersion is a version_conflict, not a lost update', async () => {
    const err = await expectError('PATCH', `/v2/entities/${taskId}`, {
      expectedVersion: 1,
      title: 'should not land',
    });
    expect(err.code).toBe('version_conflict');
    expect(err.status).toBe(409);
  });

  it('entities.activity is a contract-shaped keyset page', async () => {
    const { data } = await call<{ items: Array<{ verb: string }>; nextCursor: string | null }>(
      'GET',
      `/v2/entities/${taskId}/activity`,
    );
    expect(data.items.map((a) => a.verb)).toEqual(expect.arrayContaining(['created', 'completed']));
  });

  it('spaces.home resolves the three presets and compact activity', async () => {
    const { data } = await call<{
      readyToPull: { page: { items: unknown[] } };
      inFlight: { page: { items: unknown[] } };
      needsMe: { page: { items: unknown[] } };
      activity: { items: unknown[] };
    }>('GET', `/v2/spaces/${spaceId}/home`);

    expect(Array.isArray(data.readyToPull.page.items)).toBe(true);
    expect(Array.isArray(data.inFlight.page.items)).toBe(true);
    expect(Array.isArray(data.needsMe.page.items)).toBe(true);
    expect(data.activity.items.length).toBeGreaterThan(0);
  });

  it('a bad id is not_found and an unbuilt kind is an honest 501', async () => {
    // A non-uuid must be not_found rather than a 503 from a cast failure.
    const missing = await expectError('GET', '/v2/entities/ent_nope');
    expect(missing.code).toBe('not_found');
    expect(missing.status).toBe(404);

    // DEV-13: the contract declares `spell`; this build has not implemented
    // it. That is a statement about the server, not about the request.
    const unbuilt = await expectError('POST', '/v2/entities', {
      spaceId,
      kind: 'spell',
      title: 'not yet',
    });
    expect(unbuilt.code).toBe('not_implemented');
    expect(unbuilt.status).toBe(501);
  });

  it('a replayed clientMutationId creates once (DEV-9)', async () => {
    // This is not academic: an agent or the CLI retrying a create after a
    // dropped response is the normal case, and the ledger is what stops a
    // retry from becoming a duplicate task. The handler threads the caller's
    // cmid into the RPC and `internal.ledger_replay` returns the FIRST
    // result — so a replay is indistinguishable from the original.
    const cmid = `cmid-loop-${Date.now()}`;
    const body = {
      spaceId,
      kind: 'task',
      title: 'idempotent task',
      clientMutationId: cmid,
    };

    const first = await call<{ entity: { id: string } }>('POST', '/v2/entities', body);
    const replay = await call<{ entity: { id: string } }>('POST', '/v2/entities', body);
    expect(replay.data.entity.id).toBe(first.data.entity.id);

    // And the graph has exactly one of them, not two.
    const found = await call<{ page: { items: Array<{ id: string; title: string }> } }>(
      'POST',
      '/v2/collections/query',
      { spaceId, kinds: ['task'] },
    );
    const matches = found.data.page.items.filter((i) => i.title === 'idempotent task');
    expect(matches).toHaveLength(1);
  });

  it('a tombstone is not_found on entities.get but visible to deleted:"only"', async () => {
    // Soft-delete a throwaway task by hand. `entities.delete` is not built in
    // this slice, so the tombstone is made directly — the assertion is about
    // how the READ paths treat it, which is what actually differs.
    const created = await call<{ entity: { id: string } }>('POST', '/v2/entities', {
      spaceId,
      kind: 'task',
      title: 'doomed',
    });
    const doomedId = created.data.entity.id;
    await db.tx({}, async (q) => {
      await q.query(`update public.entities set deleted_at = now() where id = $1`, [doomedId]);
    });

    // Not a tombstone-aware path: it must look deleted.
    const gone = await expectError('GET', `/v2/entities/${doomedId}`);
    expect(gone.code).toBe('not_found');

    // Default lists exclude tombstones...
    const live = await call<{ page: { items: Array<{ id: string }> } }>('POST', '/v2/collections/query', {
      spaceId,
      kinds: ['task'],
    });
    expect(live.data.page.items.map((i) => i.id)).not.toContain(doomedId);

    // ...and `deleted: 'only'` is the path that deliberately sees them.
    const graves = await call<{ page: { items: Array<{ id: string; deletedAt: string | null; title: string }> } }>(
      'POST',
      '/v2/collections/query',
      { spaceId, kinds: ['task'], filters: { deleted: 'only' } },
    );
    const tomb = graves.data.page.items.find((i) => i.id === doomedId);
    expect(tomb?.deletedAt).not.toBeNull();
    // A tombstone renders as a tombstone — it does not keep leaking its title.
    expect(tomb?.title).toBe('Deleted');
  });

  it('an unimplemented operation still answers 501, not 404', async () => {
    const reserved = await expectError('GET', '/v2/search?q=x');
    expect(reserved.code).toBe('not_implemented');
    expect(reserved.status).toBe(501);
  });
});
