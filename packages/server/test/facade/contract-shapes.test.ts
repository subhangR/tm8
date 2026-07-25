/**
 * Validate every response this facade produces against the FROZEN CONTRACT'S
 * OWN ZOD SCHEMAS.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM loop.test.ts: that suite asserts
 * VALUES, and I wrote both the assertions and the shapes they check — so it
 * cannot catch a shape that is wrong in a way I did not think of. This file
 * asserts nothing about values. It hands each response to the schema the
 * contract declares for it and lets `@tm8/contract` be the judge. Those are
 * different claims, and only the second one survives me being wrong.
 *
 * It is deliberately the same check `tools/conformance` performs — that suite
 * currently cannot run its 58 assertions because its world builder collides
 * with `create_space`'s seeded `general` channel and grants points to a task
 * (both reported; both in a lane I do not own). This file covers the shape
 * question for the operations I built, from inside my own lane, in the
 * meantime. It is NOT a replacement for conformance: it validates only what I
 * built, and conformance validates the catalog.
 *
 * Both bugs found by hand today — a `+05:30` timestamp violating
 * `IsoTimestamp`, and tombstones leaking through `entities.get` — are exactly
 * the class this catches automatically.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ActivityItemSchema,
  CommandResultSchema,
  EdgeViewSchema,
  EntityDetailSchema,
  EntitySummarySchema,
  HomeSnapshotSchema,
  MessageViewSchema,
  ProjectResourceSchema,
  SpaceNavigationSchema,
  SpaceSummarySchema,
  pageOf,
} from '@tm8/contract';
import type { ZodTypeAny } from 'zod';
import { HandlerRegistry, registerFacadeHandlers } from '../../src/facade/index.js';
import { createFacadeServer, type FacadeServer } from '../../src/http/server.js';
import { createDb } from '../../src/db/index.js';
import type { Db } from '../../src/db/types.js';
import type { ServerConfig } from '../../src/http/config.js';

const DATABASE_URL = process.env.TM8_DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

describeDb('responses satisfy the frozen contract schemas', () => {
  let server: FacadeServer;
  let db: Db;
  let base: string;

  beforeAll(async () => {
    db = createDb(DATABASE_URL as string);
    const registry = new HandlerRegistry();
    const config: ServerConfig = {
      host: '127.0.0.1',
      port: 0,
      uiDir: undefined,
      maxBodyBytes: 8 * 1024 * 1024,
      databaseUrl: DATABASE_URL,
    };
    registerFacadeHandlers(registry, { db, config });
    server = createFacadeServer({ config, registry });
    const { url } = await server.listen();
    base = url;
    await buildNarrative();
  });

  afterAll(async () => {
    await server.close();
    await db.end();
  });

  async function call<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
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
    return json.data as T;
  }

  /**
   * Assert against the contract, with the zod issues printed on failure.
   *
   * A bare `.success` assertion would report "expected false to be true", which
   * tells you nothing about WHICH field of a 40-key DTO is wrong.
   */
  function expectShape(schema: ZodTypeAny, value: unknown, label: string): void {
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      throw new Error(
        `${label} does not satisfy its contract schema:\n${JSON.stringify(parsed.error.issues, null, 2)}\n` +
          `received: ${JSON.stringify(value, null, 2).slice(0, 1500)}`,
      );
    }
    expect(parsed.success).toBe(true);
  }

  // The narrative every assertion reads from — the same shape the conformance
  // world builder constructs, minus the two steps that collide with the
  // database's own rules.
  const w = {
    spaceId: '',
    memberId: '',
    channelBuild: '',
    epic: '',
    t101: '',
    t102: '',
    t103: '',
    forge: '',
    doc: '',
    projectId: '',
  };

  async function createEntity(input: Record<string, unknown>): Promise<string> {
    const res = await call<{ entity: { id: string } }>('POST', '/v2/entities', input);
    return res.entity.id;
  }

  async function buildNarrative(): Promise<void> {
    const space = await call<{ space: { id: string }; memberId: string }>('POST', '/v2/spaces', {
      name: `shapes-${Date.now()}`,
    });
    w.spaceId = space.space.id;
    w.memberId = space.memberId;

    // NOT 'general' — `create_space` already seeded that channel (007:463) and
    // `channels` is unique on (space_id, name).
    w.channelBuild = await createEntity({
      spaceId: w.spaceId,
      kind: 'channel',
      title: 'build',
      content: { topic: 'The build' },
    });

    w.epic = await createEntity({
      spaceId: w.spaceId,
      kind: 'task',
      title: 'T-100 epic',
      content: { priority: 'high', axes: { type: 'code' } },
    });

    w.t101 = await createEntity({
      spaceId: w.spaceId,
      kind: 'task',
      title: 'T-101',
      parentId: w.epic,
      position: 1,
      content: {
        description: 'Lay the schema.',
        axes: { type: 'code' },
        acceptanceCriteria: [{ text: 'tables exist' }, { text: 'triggers fire' }],
      },
      attachTo: { entityId: w.channelBuild, edgeType: 'attached_to' },
    });

    w.t102 = await createEntity({
      spaceId: w.spaceId,
      kind: 'task',
      title: 'T-102',
      parentId: w.epic,
      position: 2,
      content: { priority: 'urgent' },
    });

    w.t103 = await createEntity({
      spaceId: w.spaceId,
      kind: 'task',
      title: 'T-103',
      parentId: w.epic,
      position: 3,
      content: { axes: { type: 'design' } },
    });

    w.forge = await createEntity({
      spaceId: w.spaceId,
      kind: 'team_member',
      title: 'Forge',
      content: { identity: 'Implementer persona.', model: 'claude-opus-4-8', agentTool: 'claude-code' },
    });

    w.doc = await createEntity({
      spaceId: w.spaceId,
      kind: 'doc',
      title: 'Spec',
      content: { body: '# Spec\nOne contract.', format: 'markdown' },
      attachTo: { entityId: w.channelBuild, edgeType: 'attached_to' },
    });

    // A hard dependency so the blocked badge is populated, and an assignment so
    // `state.assignees` is — both are derived fields that would otherwise be
    // empty and therefore untested.
    await call('POST', '/v2/edges', {
      srcId: w.t103,
      dstId: w.t102,
      type: 'depends_on',
      props: { hard: true },
    });
    await call('POST', '/v2/edges', { srcId: w.t101, dstId: w.forge, type: 'assigned_to' });
    await call('POST', '/v2/messages', { anchorId: w.t101, body: 'Progress: schema drafted.' });
    // Points go to the PERSONA — `grant_points` refuses a task (007:1577).
    await call('POST', `/v2/entities/${w.forge}/points`, { amount: 5, reason: 'grant' });

    const project = await call<{ id: string }>('POST', '/v2/projects', {
      name: `shapes-proj-${Date.now()}`,
      workingDir: `/tmp/tm8-shapes-${Date.now()}`,
    });
    w.projectId = project.id;
    await call('POST', `/v2/spaces/${w.spaceId}/projects`, { projectId: w.projectId });
  }

  it('spaces.list → SpaceSummary[]', async () => {
    expectShape(SpaceSummarySchema.array(), await call('GET', '/v2/spaces'), 'spaces.list');
  });

  it('spaces.navigation → SpaceNavigation', async () => {
    expectShape(
      SpaceNavigationSchema,
      await call('GET', `/v2/spaces/${w.spaceId}/navigation`),
      'spaces.navigation',
    );
  });

  it('spaces.home → HomeSnapshot', async () => {
    expectShape(HomeSnapshotSchema, await call('GET', `/v2/spaces/${w.spaceId}/home`), 'spaces.home');
  });

  it('projects.{create,list,get,update} → a BARE ProjectResource everywhere', async () => {
    // create/get/update must agree: a project is a resource, not an entity, so
    // none of them wraps it. This is the shape the contract's own suite
    // validates `data` against directly.
    const created = await call('POST', '/v2/projects', {
      name: `shapes-p2-${Date.now()}`,
      workingDir: `/tmp/tm8-shapes-p2-${Date.now()}`,
    });
    expectShape(ProjectResourceSchema, created, 'projects.create');

    expectShape(ProjectResourceSchema.array(), await call('GET', '/v2/projects'), 'projects.list');
    expectShape(
      ProjectResourceSchema,
      await call('GET', `/v2/projects/${w.projectId}`),
      'projects.get',
    );

    const updated = await call<{ trust: string }>('PATCH', `/v2/projects/${w.projectId}`, {
      trust: 'trusted',
    });
    expectShape(ProjectResourceSchema, updated, 'projects.update');
    expect(updated.trust).toBe('trusted');
  });

  it('a version_conflict carries details.current so the client can reconcile', async () => {
    const err = await fetch(`${base}/v2/entities/${w.t101}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedVersion: 99, title: 'stale write' }),
    });
    expect(err.status).toBe(409);
    const body = (await err.json()) as {
      error: { code: string; details?: { current?: { id: string; version: number } } };
    };
    expect(body.error.code).toBe('version_conflict');
    // Without this the client's only move is another round trip — and it has
    // to know to make it.
    expect(body.error.details?.current?.id).toBe(w.t101);
    expectShape(EntityDetailSchema, body.error.details?.current, 'version_conflict details.current');
  });

  it('a foreign cursor fails closed rather than resuming from the wrong place', async () => {
    const foreign = Buffer.from(
      JSON.stringify({ v: 2, k: ['zzz-not-a-real-sort-value', 'ent_foreign'] }),
    ).toString('base64url');
    const res = await fetch(`${base}/v2/collections/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ spaceId: w.spaceId, kinds: ['task'], cursor: foreign }),
    });
    const body = (await res.json()) as { error?: { code: string } };
    // A wrong-page-of-results bug looks like data loss, so this must never be
    // silently reinterpreted against the wrong sort key.
    expect(body.error?.code).toBe('invalid_cursor');
    expect(res.status).toBe(400);
  });

  it("entities.create with attachTo reports the edge it created", async () => {
    const res = await call<{ edge?: { type: string; source: { id: string }; target: { id: string } } }>(
      'POST',
      '/v2/entities',
      {
        spaceId: w.spaceId,
        kind: 'task',
        title: 'attached task',
        attachTo: { entityId: w.channelBuild, edgeType: 'attached_to' },
      },
    );
    // The RPC creates the edge but discards its id, so this is assembled by the
    // facade — a client that asked for an atomic create-and-attach has to be
    // able to see what it got.
    expect(res.edge?.type).toBe('attached_to');
    expect(res.edge?.target.id).toBe(w.channelBuild);
    expectShape(EdgeViewSchema, res.edge, 'entities.create attach edge');
  });

  it('entities.get → EntityDetail, for every kind this node builds', async () => {
    // Each kind assembles a different `state` and `content` variant, so one
    // sample per kind is the minimum that exercises the discriminated unions.
    for (const [label, id] of [
      ['task', w.t101],
      ['task (blocked)', w.t103],
      ['doc', w.doc],
      ['channel', w.channelBuild],
      ['team_member', w.forge],
      ['member', w.memberId],
    ] as const) {
      expectShape(EntityDetailSchema, await call('GET', `/v2/entities/${id}`), `entities.get ${label}`);
    }
  });

  it('the blocked badge and its waitingOn summaries are contract-shaped', async () => {
    const detail = await call<{ badges: { blocked?: { waitingOn: unknown[] } } }>(
      'GET',
      `/v2/entities/${w.t103}`,
    );
    // Guard against the assertion passing vacuously: if the badge were absent,
    // validating "the summaries inside it" would check nothing at all.
    expect(detail.badges.blocked?.waitingOn).toHaveLength(1);
    expectShape(
      EntitySummarySchema.array(),
      detail.badges.blocked?.waitingOn,
      'badges.blocked.waitingOn',
    );
  });

  it('entities.children → Page<EntitySummary>', async () => {
    const page = await call<{ items: unknown[] }>('GET', `/v2/entities/${w.epic}/children`);
    expect(page.items.length).toBeGreaterThan(0);
    expectShape(pageOf(EntitySummarySchema), page, 'entities.children');
  });

  it('entities.activity → Page<ActivityItem>', async () => {
    const page = await call<{ items: unknown[] }>('GET', `/v2/entities/${w.t101}/activity`);
    expect(page.items.length).toBeGreaterThan(0);
    expectShape(pageOf(ActivityItemSchema), page, 'entities.activity');
  });

  it('collections.query → EntitySummary[] for every kind, grouped and ungrouped', async () => {
    for (const kind of ['task', 'doc', 'channel', 'team_member', 'member'] as const) {
      const res = await call<{ page: { items: unknown[] } }>('POST', '/v2/collections/query', {
        spaceId: w.spaceId,
        kinds: [kind],
      });
      expect(res.page.items.length, `kind ${kind} produced no rows to validate`).toBeGreaterThan(0);
      expectShape(pageOf(EntitySummarySchema), res.page, `collections.query ${kind}`);
    }

    const grouped = await call<{ groups?: Array<{ items: unknown[] }> }>('POST', '/v2/collections/query', {
      spaceId: w.spaceId,
      kinds: ['task'],
      groupBy: 'axis:type',
    });
    expect(grouped.groups?.length).toBeGreaterThan(0);
    for (const group of grouped.groups ?? []) {
      expectShape(EntitySummarySchema.array(), group.items, 'collection group items');
    }
  });

  it('messages.list → Page<MessageView>', async () => {
    const page = await call<{ items: unknown[] }>('GET', `/v2/entities/${w.t101}/messages`);
    expect(page.items.length).toBeGreaterThan(0);
    expectShape(pageOf(MessageViewSchema), page, 'messages.list');
  });

  it('commands return CommandResult, including the edge and undo variants', async () => {
    // entities.create
    expectShape(
      CommandResultSchema,
      await call('POST', '/v2/entities', { spaceId: w.spaceId, kind: 'task', title: 'shape check' }),
      'entities.create',
    );

    // edges.create — the only command that returns `edge` AND `undo`, so it is
    // the only one that exercises those two branches of CommandResult.
    const edgeResult = await call<{ edge?: unknown; undo?: unknown }>('POST', '/v2/edges', {
      srcId: w.t102,
      dstId: w.channelBuild,
      type: 'attached_to',
    });
    expectShape(CommandResultSchema, edgeResult, 'edges.create');
    expect(edgeResult.edge).toBeDefined();
    expectShape(EdgeViewSchema, edgeResult.edge, 'edges.create edge');
    // DEV-11: write_edge issues an undo token, so the field must be populated
    // and well-formed rather than merely optional-and-absent.
    expect(edgeResult.undo).toBeDefined();

    // The work/complete pair.
    const worked = await call<{ entity: { version: number } }>(
      'POST',
      `/v2/entities/${w.t102}/commands/work`,
      { status: 'working' },
    );
    expectShape(CommandResultSchema, worked, 'commands.work');

    const completed = await call('POST', `/v2/entities/${w.t102}/commands/complete`, {
      expectedVersion: worked.entity.version,
      completerIds: [w.forge],
    });
    expectShape(CommandResultSchema, completed, 'commands.complete');

    // messages.post
    expectShape(
      CommandResultSchema,
      await call('POST', '/v2/messages', { anchorId: w.t101, body: 'another' }),
      'messages.post',
    );

    // points.add — the counter is a trigger-maintained cache of the ledger.
    expectShape(
      CommandResultSchema,
      await call('POST', `/v2/entities/${w.forge}/points`, { amount: 2, reason: 'grant' }),
      'entities.points.add',
    );
  });

  it('every timestamp on the wire is ISO-8601 UTC, including jsonb-sourced ones', async () => {
    // The regression guard for the bug class that has now appeared three times
    // (working_on.startedAt, pulled.pulledAt, undo.expiresAt): Postgres
    // serialises a timestamptz INSIDE jsonb using the server's UTC offset
    // ("+05:30"), which violates the contract's `IsoTimestamp` (/…Z$/). Column
    // timestamps are safe because the driver returns Date; jsonb ones are not.
    // A shape test alone would miss it wherever the field is a plain string.
    const worked = await call<{
      entity: { badges: { workingActors?: Array<{ startedAt: string }> } };
    }>('POST', `/v2/entities/${w.t103}/commands/work`, { status: 'working' });

    const started = worked.entity.badges.workingActors?.[0]?.startedAt;
    expect(started, 'no workingActors badge to check').toBeDefined();
    expect(started).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/);

    const edge = await call<{ undo?: { expiresAt?: string } }>('POST', '/v2/edges', {
      srcId: w.doc,
      dstId: w.epic,
      type: 'relates_to',
    });
    expect(edge.undo?.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/);
  });
});
