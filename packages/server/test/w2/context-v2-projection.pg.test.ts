/**
 * Entity context v2 projection (M2/S3a) — what the shared acceptance suite
 * (`context-v2-acceptance.pg.test.ts`) does not pin on its own:
 *
 *   - every v2 DTO, default and per explicit section, parses against the
 *     contract's STRICT `EntityContextV2ViewSchema` (c761 §3.3 row shapes);
 *   - `you:true` on the caller's assignee row and `toMe:true` on a message that
 *     mentions the caller (c761 Q4, Q6);
 *   - budget trims: rows outside the core go in the c904 §2.6 order and say
 *     so in `omitted[]`; a chat's messages are core and are never trimmed;
 *   - `v2LoadPlan`: the default never plans connections, actions or activity;
 *   - the per-fixture measurement, v1 vs v2, printed for the PR (never summed).
 *
 * Same harness as the shared suite: the production registry over a scratch
 * PostgreSQL, as `tm8_app` under claim-bound RLS, statements counted.
 */
import { EntityContextV2ViewSchema, getOperation, type EntityContextV2View, type OperationName } from '@tm8/contract';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createDb } from '../../src/db/index.js';
import type { Db } from '../../src/db/types.js';
import { HandlerRegistry, registerFacadeHandlers } from '../../src/facade/index.js';
import { v2LoadPlan } from '../../src/facade/services/w2/feed-context-v2.js';
import type { ServerConfig } from '../../src/http/config.js';
import type { RequestContext } from '../../src/http/types.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from '../db/w1-pg.js';
import { countStatements, type StatementCounter } from './context-statement-counter.js';
import { BODIES, F, IDENTITY, seedContextV2Fixtures } from './context-v2/fixtures.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 300_000 });

const OWNER = {
  identityId: IDENTITY,
  accountId: '01a0c000-0000-7000-8000-0000000000fe',
  username: 'ctx-v2-owner',
  isNodeAdmin: false,
  isOwner: true,
};
/** A message on T that mentions the caller's member row (for `toMe`). */
const MENTION = '01a0c000-0000-7000-8000-000000000a01';
/** A restricted PR G also tracks: the caller cannot read it (S3b gate fix). */
const HIDDEN_PR = '01a0c000-0000-7000-8000-000000000a02';

/** A `pr_merged` task tracking eleven PRs: one past the gate's row limit. */
const WIDE_GATE = '01a0c000-0000-7000-8000-000000000a03';
const WIDE_GATE_PRS = Array.from({ length: 11 }, (_, i) => `01a0c000-0000-7000-8000-000000000b${String(i).padStart(2, '0')}`);

let database: W1ScratchDatabase;
let pgDb: Db;
let registry: HandlerRegistry;
let counter: StatementCounter;

beforeAll(async () => {
  database = await createW1ScratchDatabase('ctx_v2_proj');
  database.apply(migrationFiles());
  await seedContextV2Fixtures(database);
  await database.transaction(async (c) => {
    await c.query('set local role tm8_graph_owner');
    // T is also assigned to the CALLER (the fixture owner's member row).
    await c.query(
      `insert into public.edges(space_id,src_id,dst_id,type,created_by,assigned_by,assigned_at,created_at)
       values ($1,$2,$3,'assigned_to',$3,$4,'2026-09-23T12:05:00Z','2026-09-23T12:05:00Z')`,
      [F.space, F.T, F.member, F.coordinatorTeammate],
    );
    await c.query(
      `insert into public.entities(id,space_id,kind,created_by,visibility,created_at,updated_at)
       values ($1,$2,'message',$3,'space','2026-09-23T13:00:00Z','2026-09-23T13:00:00Z')`,
      [MENTION, F.space, F.teammate],
    );
    await c.query(
      `insert into public.messages(entity_id,anchor_id,author_id,body,mentions,created_at)
       values ($1,$2,$3,'@owner please review',$4::jsonb,'2026-09-23T13:00:00Z')`,
      [MENTION, F.T, F.teammate, JSON.stringify([{ entityId: F.member, kind: 'member', display: 'Fixture Owner' }])],
    );
    await c.query(
      `insert into public.entities(id,space_id,kind,created_by,visibility,created_at,updated_at)
       values ($1,$2,'pull_request',$3,'restricted','2026-09-23T13:00:00Z','2026-09-23T13:00:00Z')`,
      [HIDDEN_PR, F.space, F.teammate],
    );
    await c.query(
      `insert into public.pull_requests(entity_id,space_id,provider,url,repo,number,title,state,ci_status)
       values ($1,$2,'github','https://github.com/example/tm8/pull/9002','example/tm8',9002,'Hidden PR','open','pending')`,
      [HIDDEN_PR, F.space],
    );
    await c.query(
      `insert into public.edges(space_id,src_id,dst_id,type,created_by,created_at)
       values ($1,$2,$3,'tracks',$4,'2026-09-23T13:00:00Z')`,
      [F.space, F.G, HIDDEN_PR, F.teammate],
    );
    await c.query(
      `insert into public.entities(id,space_id,kind,parent_id,created_by,visibility,created_at,updated_at)
       values ($1,$2,'task',$3,$4,'space','2026-09-23T13:00:00Z','2026-09-23T13:00:00Z')`,
      [WIDE_GATE, F.space, F.root, F.member],
    );
    await c.query(
      `insert into public.tasks(entity_id,title,description,acceptance_criteria,work_status,completion_gate)
       values ($1,'Gated on eleven PRs','','[]'::jsonb,'working','pr_merged')`,
      [WIDE_GATE],
    );
    for (const [i, pr] of WIDE_GATE_PRS.entries()) {
      const at = `2026-09-23T13:${String(10 + i).padStart(2, '0')}:00Z`;
      await c.query(
        `insert into public.entities(id,space_id,kind,created_by,visibility,created_at,updated_at)
         values ($1,$2,'pull_request',$3,'space',$4,$4)`,
        [pr, F.space, F.teammate, at],
      );
      await c.query(
        `insert into public.pull_requests(entity_id,space_id,provider,url,repo,number,title,state,ci_status)
         values ($1,$2,'github',$3,'example/tm8',$4,'Wide PR','open','pending')`,
        [pr, F.space, `https://github.com/example/tm8/pull/${9100 + i}`, 9100 + i],
      );
      await c.query(
        `insert into public.edges(space_id,src_id,dst_id,type,created_by,created_at)
         values ($1,$2,$3,'tracks',$4,$5)`,
        [F.space, WIDE_GATE, pr, F.teammate, at],
      );
    }
  });
  pgDb = createDb(database.url);
  counter = countStatements(pgDb);
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

async function read<T>(id: string, query: string): Promise<{ view: T; bytes: number; statements: number }> {
  const opName: OperationName = 'entities.context';
  const op = getOperation(opName);
  const handler = registry.get(opName)!;
  counter.reset();
  const view = (await handler({
    op, opName, params: { id }, query: new URLSearchParams(query), body: undefined,
    requestId: 'ctx-v2-proj', identity: { kind: 'auto-owner', identityId: IDENTITY },
    headers: {}, method: op.method, path: op.path,
  } satisfies RequestContext)) as T;
  return { view, bytes: Buffer.byteLength(JSON.stringify(view), 'utf8'), statements: counter.total() };
}

const v2 = (id: string, query = '') => read<EntityContextV2View>(id, query ? `schema=v2&${query}` : 'schema=v2');

const FIXTURES = [
  { name: 'T (task, 3.5 KB body, 4 criteria)', id: F.T, body: BODIES.T },
  { name: 'P (task, 8 KB body, 10 children, 1 msg)', id: F.P, body: BODIES.P },
  { name: 'G (task, pr_merged gate, 1 blocker)', id: F.G, body: 'G body' },
  { name: 'X (task, 60 KB body)', id: F.X, body: BODIES.X },
  { name: 'D (doc, 40 KB body)', id: F.D, body: BODIES.D },
  { name: 'WS (running session, working_on)', id: F.WS, body: null },
  { name: 'CS (coordinator session)', id: F.CS, body: null },
  { name: 'C (chat, 12 messages)', id: F.C, body: null },
  { name: 'PJ (project)', id: F.PJ, body: null },
  { name: 'M (message, chat turn 0)', id: F.chatMessages[0]!, body: BODIES.message('chat turn', 0) },
] as const;

describe('v2 projection (S3a)', () => {
  it('every default and explicit-section DTO parses against the strict contract schema', async () => {
    for (const fixture of FIXTURES) {
      for (const query of ['', 'sections=assignment', 'sections=hierarchy', 'sections=blockers',
        'sections=connections', 'sections=messages', 'sections=actions', 'sections=summary,hierarchy']) {
        const { view } = await v2(fixture.id, query);
        const parsed = EntityContextV2ViewSchema.safeParse(view);
        expect(parsed.success, `${fixture.name} ?${query}: ${JSON.stringify(parsed.error?.issues ?? [])}`).toBe(true);
        expect(view.budget.used).toBe(Buffer.byteLength(JSON.stringify(view), 'utf8'));
      }
    }
  });

  it('marks the caller: you:true on its own assignee row only, toMe:true on a message that mentions it', async () => {
    const { view } = await v2(F.T);
    expect(view.assignees).toEqual([
      { id: F.teammate, name: 'Opus 5.5 1M Teammate', by: 'Opus 5 1M Teammate', at: '2026-09-23T12:01:00.000Z' },
      { id: F.member, name: 'Fixture Owner', you: true, by: 'Opus 5 1M Teammate', at: '2026-09-23T12:05:00.000Z' },
    ]);
    const mention = view.messages?.find((m) => m.id === MENTION);
    expect(mention).toMatchObject({ from: 'Opus 5.5 1M Teammate', text: '@owner please review', toMe: true });
    // The other messages on the same anchor do not mention the caller.
    const p = await v2(F.P);
    expect(p.view.messages?.every((m) => !('toMe' in m))).toBe(true);
  });

  it('explicit sections return the §2.10 header and only what was asked; the rest is notLoaded with runnable expands', async () => {
    const { view } = await v2(F.T, 'sections=blockers');
    expect(Object.keys(view)).toEqual([
      'schemaVersion', 'id', 'kind', 'title', 'version', 'status', 'asOfSeq',
      'blockers', 'omitted', 'notLoaded', 'errors', 'budget',
    ]);
    expect(view.notLoaded.map((n) => n.section)).toEqual(['assignment', 'hierarchy', 'connections', 'in_project', 'messages', 'actions']);
    for (const entry of view.notLoaded) {
      if (entry.section === 'in_project') continue; // its own test, below
      if (entry.section === 'actions') {
        // Bounded since #669: the CLI pages by default, the expandOp names v2.
        expect(entry).toEqual({
          section: 'actions',
          expand: `tm8 action list --for ${F.T}`,
          expandOp: { operation: 'actions.list', params: { contextEntityId: F.T, schema: 'v2' } },
        });
        continue;
      }
      expect(entry.expand).toBe(`tm8 entity context ${F.T} --sections ${entry.section}`);
      expect(entry.expandOp).toEqual({ operation: 'entities.context', params: { id: F.T, sections: [entry.section] } });
    }
    // `summary` is the v2 alias of `assignment`.
    const alias = await v2(F.T, 'sections=summary');
    const named = await v2(F.T, 'sections=assignment');
    expect(alias.view).toEqual(named.view);
    expect(named.view.assignment).toEqual({ text: BODIES.T, bytes: Buffer.byteLength(BODIES.T), complete: true });
    expect(named.view.acceptance).toHaveLength(4);
  });

  it('rejects v1-only and unknown section names on v2, and v2-only names on v1', async () => {
    await expect(v2(F.T, 'sections=activity')).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(read(F.T, 'sections=blockers')).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(read(F.T, 'schema=v1&sections=assignment')).rejects.toMatchObject({ code: 'invalid_input' });
    const explicitV1 = await read<{ schemaVersion: string }>(F.T, 'schema=v1&sections=summary');
    expect(explicitV1.view.schemaVersion).toBe('tm8.entity-context.v1');
  });

  it('a budget trims children before messages, farthest first, and says so in omitted[]', async () => {
    const full = await v2(F.P);
    expect(full.view.children).toHaveLength(10);
    const requested = full.bytes - 600;
    const { view, bytes } = await v2(F.P, `totalBytes=${requested}`);
    expect(bytes).toBeLessThanOrEqual(requested);
    expect(view.assignment).toEqual(full.view.assignment);
    const kept = view.children ?? [];
    expect(kept.length).toBeLessThan(10);
    // The nearest (first) children survive; the farthest went first.
    expect(kept.map((c) => c.id)).toEqual((full.view.children ?? []).slice(0, kept.length).map((c) => c.id));
    // The expand pages on from the last child the trim kept (S3b section cursor).
    const entry = view.omitted.find((o) => o.section === 'children');
    expect(entry).toMatchObject({ section: 'children', kept: kept.length, more: true, reason: 'budget' });
    expect(entry?.expand).toMatch(new RegExp(`^tm8 entity context ${F.P} --sections hierarchy --cursor \\S+$`));
    const next = await v2(F.P, `sections=hierarchy&cursor=${entry!.expandOp!.params['cursor'] as string}`);
    expect(next.view.children?.[0]?.id).toBe(full.view.children?.[kept.length]?.id);
    // Messages go only after every child has.
    expect(view.messages).toEqual(full.view.messages);
  });

  it('a chat keeps its messages as core: a tight budget does not trim them', async () => {
    const full = await v2(F.C);
    // Since S4 (#713) a core that cannot fit is a 422, never a trim.
    await expect(v2(F.C, 'totalBytes=4096')).rejects.toMatchObject({ code: 'context_budget_too_small' });
    const { view } = await v2(F.C, `totalBytes=${full.bytes}`);
    expect(view.messages).toEqual(full.view.messages);
    expect(view.omitted.filter((o) => o.reason === 'budget')).toEqual([]);
  });

  it('v2LoadPlan: the default never plans connections, and plans only what the kind shows', () => {
    for (const kind of ['task', 'doc', 'work_session', 'chat', 'project', 'message', 'channel']) {
      const plan = v2LoadPlan(kind, null);
      expect(plan.connections, kind).toBe(false);
      expect(plan.notLoaded, kind).toEqual(expect.arrayContaining(['connections', 'actions']));
      expect(plan.children, kind).toBe(kind === 'task');
      expect(plan.sessionCard, kind).toBe(kind === 'work_session');
    }
    expect(v2LoadPlan('project', null).notLoaded).toEqual(['hierarchy', 'connections', 'actions']);
    expect(v2LoadPlan('chat', null).messages).toEqual({ limit: 10, cap: 500, core: true });
    expect(v2LoadPlan('task', null).messages).toEqual({ limit: 3, cap: 280, core: false });
    const explicit = v2LoadPlan('task', new Set(['hierarchy']));
    expect(explicit).toMatchObject({ explicit: true, parent: true, children: true, blockers: false, messages: null });
  });

  it('measures every fixture, v1 vs v2 default (bytes, ~tok, statements, body complete, fixed core)', async () => {
    const rows = [
      '| fixture | v1 bytes | v1 ~tok | v1 stmts | v2 bytes | v2 ~tok | v2 stmts | v2 `--sections assignment` stmts | v2 body complete | v2 fixed core |',
      '|---|---|---|---|---|---|---|---|---|---|',
    ];
    for (const fixture of FIXTURES) {
      const old = await read<Record<string, unknown>>(fixture.id, '');
      const now = await v2(fixture.id);
      const assignmentOnly = await v2(fixture.id, 'sections=assignment');
      expect(now.statements, fixture.name).toBeLessThan(old.statements);
      const core = structuredClone(now.view) as Record<string, unknown>;
      if (core['assignment']) (core['assignment'] as { text: string }).text = '';
      for (const key of ['acceptance', 'assignees', 'children', 'blockers', 'tasks', 'connections', 'messages',
        'outline', 'attachments', 'omitted', 'notLoaded', 'errors']) {
        if (Array.isArray(core[key])) core[key] = [];
      }
      const fixedCore = Buffer.byteLength(JSON.stringify(core), 'utf8');
      expect(fixedCore, fixture.name).toBeLessThanOrEqual(1_500);
      const complete = fixture.body === null ? 'n/a' : now.view.assignment?.complete ? 'yes' : `no (${Buffer.byteLength(now.view.assignment?.text ?? '')} of ${now.view.assignment?.bytes} B)`;
      const fmt = (n: number) => n.toLocaleString('en-US');
      rows.push(`| ${fixture.name} | ${fmt(old.bytes)} | ${fmt(Math.round(old.bytes / 4))} | ${old.statements} | ${fmt(now.bytes)} | ${fmt(Math.round(now.bytes / 4))} | ${now.statements} | ${assignmentOnly.statements} | ${complete} | ${fmt(fixedCore)} |`);
    }
    console.log(`\n[context-v2 S3a] v1 default vs v2 default, minified server DTO (per fixture, never summed)\n${rows.join('\n')}\n`);
  });
});

// ===========================================================================
// S3b — section cursors, --edge-type, and the gate's unreadable PR
// ===========================================================================

describe('v2 section pages (S3b)', () => {
  it('a gated task names a tracked PR it cannot read as {id, unreadable:true}, not by dropping it', async () => {
    const { view } = await v2(F.G);
    expect(EntityContextV2ViewSchema.safeParse(view).success).toBe(true);
    const gate = (view as { gate?: { prs: unknown[] } }).gate;
    expect(gate?.prs).toEqual([
      { url: 'https://github.com/example/tm8/pull/9001', state: 'open', ci: 'pending' },
      { id: HIDDEN_PR, unreadable: true },
    ]);
  });

  it('--edge-type filters connections to one type; the unfiltered read hides anchored_to only', async () => {
    const all = await v2(F.G, 'sections=connections');
    const types = new Set((all.view.connections ?? []).map((c) => c.type));
    expect(types.has('tracks') && types.has('depends_on')).toBe(true);
    expect(types.has('anchored_to')).toBe(false);
    const tracks = await v2(F.G, 'sections=connections&edgeType=depends_on');
    expect(tracks.view.connections?.map((c) => [c.type, c.other.id])).toEqual([['depends_on', F.B]]);
    expect(EntityContextV2ViewSchema.safeParse(tracks.view).success).toBe(true);
  });

  it('an unknown --edge-type is invalid_input naming the valid types, not an empty page', async () => {
    const err = await v2(F.G, 'sections=connections&edgeType=working_onn').then(() => null, (e: unknown) => e);
    expect(err).toMatchObject({ code: 'invalid_input', details: { reason: 'unknown_edge_type', field: 'edgeType' } });
    const valid = (err as { details: { validTypes: string[] } }).details.validTypes;
    expect(valid).toEqual(expect.arrayContaining(['depends_on', 'tracks', 'working_on']));
  });

  it('a cursor is bound to its entity, section and filter, and is refused before any SQL', async () => {
    const full = await v2(F.P);
    const trimmed = await v2(F.P, `totalBytes=${full.bytes - 600}`);
    const cursor = trimmed.view.omitted.find((o) => o.section === 'children')?.expandOp?.params['cursor'] as string;
    expect(cursor).toEqual(expect.any(String));
    // The same cursor pages P's hierarchy...
    await expect(v2(F.P, `sections=hierarchy&cursor=${cursor}`)).resolves.toBeTruthy();
    // ...but not another entity's, another section's, or a filtered read's.
    for (const query of [
      [F.T, `sections=hierarchy&cursor=${cursor}`],
      [F.P, `sections=messages&cursor=${cursor}`],
      [F.P, `sections=connections&edgeType=tracks&cursor=${cursor}`],
    ] as const) {
      counter.reset();
      await expect(v2(query[0], query[1]), query.join(' ')).rejects.toMatchObject({ code: 'invalid_cursor' });
      expect(counter.total(), query.join(' ')).toBe(0);
    }
    // Anything but exactly one paged section is a usage error, not a cursor error.
    for (const query of [`sections=hierarchy,messages&cursor=${cursor}`, `sections=assignment&cursor=${cursor}`, `cursor=${cursor}`]) {
      await expect(v2(F.P, query), query).rejects.toMatchObject({ code: 'invalid_input' });
    }
  });
});

// ===========================================================================
// Phase 2 step C — the gate's `more` and the hidden edge types get expands
// ===========================================================================

describe('v2 follow-up expands (phase 2 step C)', () => {
  it('a gate past 10 PRs keeps 10, says more, and its omitted[] entry expands to the tracks-filtered connections', async () => {
    const { view } = await v2(WIDE_GATE);
    expect(EntityContextV2ViewSchema.safeParse(view).success).toBe(true);
    const gate = view.gate as { prs: Array<{ url: string }>; more?: true };
    expect(gate.prs.map((pr) => pr.url)).toEqual(
      Array.from({ length: 10 }, (_, i) => `https://github.com/example/tm8/pull/${9100 + i}`),
    );
    expect(gate.more).toBe(true);
    const entry = view.omitted.find((o) => o.section === 'gate');
    expect(entry).toEqual({
      section: 'gate', kept: 10, more: true, reason: 'rowLimit',
      expand: `tm8 entity context ${WIDE_GATE} --sections connections --edge-type tracks`,
      expandOp: { operation: 'entities.context', params: { id: WIDE_GATE, sections: ['connections'], edgeType: 'tracks' } },
    });
    // The expand runs and reaches the eleventh PR.
    const page = await v2(WIDE_GATE, 'sections=connections&edgeType=tracks');
    expect(page.view.connections?.map((c) => c.other.id)).toContain(WIDE_GATE_PRS[10]);
    // At or under the limit: no `more`, no omitted entry.
    const g = await v2(F.G);
    expect((g.view.gate as { more?: true }).more).toBeUndefined();
    expect(g.view.omitted.find((o) => o.section === 'gate')).toBeUndefined();
  });

  it('in_project and authored_from are advertised in notLoaded[] with their filtered expand, only for kinds that carry them', async () => {
    const expected = (id: string, type: string) => ({
      section: type,
      expand: `tm8 entity context ${id} --sections connections --edge-type ${type}`,
      expandOp: { operation: 'entities.context', params: { id, sections: ['connections'], edgeType: type } },
    });
    const advertised = (view: EntityContextV2View) =>
      view.notLoaded.filter((n) => n.section === 'in_project' || n.section === 'authored_from');
    // A session carries both (in_project out, authored_from in), right after `connections`.
    const ws = await v2(F.WS);
    expect(advertised(ws.view)).toEqual([expected(F.WS, 'in_project'), expected(F.WS, 'authored_from')]);
    const sections = ws.view.notLoaded.map((n) => n.section);
    expect(sections.indexOf('in_project')).toBe(sections.indexOf('connections') + 1);
    // Each expand runs, and the session's in_project edge is on its page.
    const page = await v2(F.WS, 'sections=connections&edgeType=in_project');
    expect(page.view.connections?.map((c) => [c.type, c.dir, c.other.id])).toEqual([['in_project', 'out', F.PJ]]);
    // Per kind, from the edge catalog: task → in_project; chat, message → authored_from;
    // project → in_project (incoming); a doc carries neither.
    expect(advertised((await v2(F.T)).view)).toEqual([expected(F.T, 'in_project')]);
    expect(advertised((await v2(F.C)).view)).toEqual([expected(F.C, 'authored_from')]);
    expect(advertised((await v2(F.chatMessages[0]!)).view)).toEqual([expected(F.chatMessages[0]!, 'authored_from')]);
    expect(advertised((await v2(F.PJ)).view)).toEqual([expected(F.PJ, 'in_project')]);
    expect(advertised((await v2(F.D)).view)).toEqual([]);
    // Loading connections loads them too: nothing is advertised twice.
    const loaded = await v2(F.WS, 'sections=connections');
    expect(advertised(loaded.view)).toEqual([]);
  });
});
