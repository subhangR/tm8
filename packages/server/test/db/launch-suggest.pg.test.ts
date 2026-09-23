/**
 * `launch.suggest` end to end against a REAL PostgreSQL, with a FAKE
 * `JevAdvisorPort` (design 01a0cb80 §4, §5.1, §6, §8).
 *
 * The handler is registered exactly as the facade registers it and runs as
 * `tm8_app` under the caller's claims, so RLS and 201's policies are live:
 *   · candidates are the union of their sources, one per id, `sources[]` kept;
 *     superseded and unreadable memories and `missing` skills never appear;
 *     skill bodies never reach Jev; text is cut at 600 characters;
 *   · above 240, direct sources come first, then the space by recency;
 *   · skips (no_teammate, no_subject_text), one group failing alone, no_key;
 *   · a non-member is refused;
 *   · every Jev call is a `jev_calls` row (failures too), `chunk` is its index
 *     in `calls[]`, a retried `requestId` adds nothing, and `run` sums the run;
 *   · `jev_runs.suggestions` holds ids and numbers, never text;
 *   · the four groups are in flight at once.
 */
import { randomUUID } from 'node:crypto';

import type { LaunchSuggestResult } from '@tm8/contract';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createDb } from '../../src/db/index.js';
import type { Db } from '../../src/db/types.js';
import type { FacadeDeps } from '../../src/facade/deps.js';
import { HandlerRegistry } from '../../src/facade/registry.js';
import type { RequestContext } from '../../src/http/types.js';
import { registerJevHandlers } from '../../src/jev/handlers.js';
import type { JevAdvisorPort, JevCallRecord, JevCandidate } from '../../src/jev/port.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 300_000 });

const OWNER = 'suggest-owner';
const STRANGER = 'suggest-stranger';
const SECRET_BODY = 'SECRET SKILL BODY — must never leave the server';
const LONG_STATEMENT = `working set: ${'x'.repeat(1000)}`;

let database: W1ScratchDatabase;
let db: Db;
const ids: Record<string, string> = {};

async function asOwner<T>(fn: (client: import('pg').PoolClient) => Promise<T>): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    return fn(client);
  });
}

async function entity(
  client: import('pg').PoolClient, space: string, kind: string,
  opts: { parent?: string; visibility?: string; updatedAt?: string } = {},
): Promise<string> {
  const id = (await client.query<{ id: string }>('select internal.new_id()::text id')).rows[0]!.id;
  await client.query(
    `insert into public.entities(id, space_id, kind, parent_id, position, created_by, visibility, updated_at)
     values ($1, $2, $3, $4, 0, $5, $6, coalesce($7::timestamptz, now()))`,
    [id, space, kind, opts.parent ?? null, ids[`member:${space}`] ?? id, opts.visibility ?? 'space', opts.updatedAt ?? null],
  );
  return id;
}

async function edge(client: import('pg').PoolClient, space: string, src: string, dst: string, type: string): Promise<void> {
  const props = type === 'supersedes' ? { reason: 'measured again' } : {};
  await client.query(
    `insert into public.edges(space_id, src_id, dst_id, type, props, created_by) values ($1, $2, $3, $4, $5::jsonb, $6)`,
    [space, src, dst, type, JSON.stringify(props), ids[`member:${space}`]],
  );
}

async function memory(client: import('pg').PoolClient, space: string, statement: string, opts: { visibility?: string; updatedAt?: string } = {}): Promise<string> {
  const id = await entity(client, space, 'memory', opts);
  await client.query(
    `insert into public.memories(entity_id, statement, mechanism, subject_scope, does_not_establish)
     values ($1, $2, 'seed', 'scratch', 'runtime')`,
    [id, statement],
  );
  return id;
}

async function skill(client: import('pg').PoolClient, space: string, name: string, opts: { missing?: boolean } = {}): Promise<string> {
  const id = await entity(client, space, 'skill');
  await client.query(
    `insert into public.skills(entity_id, space_id, name, description, content, source_path, missing)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [id, space, name, `${name} does a thing`, opts.missing ? '' : SECRET_BODY, opts.missing ? `/gone/${name}/SKILL.md` : null, opts.missing === true],
  );
  return id;
}

async function teammate(client: import('pg').PoolClient, space: string, name: string, role: string, persona: string, parent?: string): Promise<string> {
  const id = await entity(client, space, 'team_member', parent ? { parent } : {});
  await client.query(
    `insert into public.team_members(entity_id, owner_member_id, name, role, identity) values ($1, $2, $3, $4, $5)`,
    [id, ids[`member:${space}`], name, role, persona],
  );
  return id;
}

async function space(client: import('pg').PoolClient, key: string, identity: string): Promise<string> {
  const id = (await client.query<{ id: string }>('select internal.new_id()::text id')).rows[0]!.id;
  await client.query(`insert into public.spaces(id, name, created_by_identity) values ($1, $2, $3)`, [id, key, identity]);
  const member = (await client.query<{ id: string }>('select internal.new_id()::text id')).rows[0]!.id;
  await client.query(
    `insert into public.entities(id, space_id, kind, position, created_by) values ($1, $2, 'member', 0, $1)`,
    [member, id],
  );
  await client.query(
    `insert into public.members(entity_id, space_id, identity_id, role, display_name) values ($1, $2, $3, 'owner', $3)`,
    [member, id, identity],
  );
  ids[`member:${id}`] = member;
  return id;
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('launch_suggest');
  database.apply(migrationFiles());
  db = createDb(database.url);
  await asOwner(async (c) => {
    await c.query(
      `insert into public.user_profiles(identity_id, display_name) values ($1, 'Owner'), ($2, 'Stranger')`,
      [OWNER, STRANGER],
    );
    await c.query(
      `insert into public.accounts(identity_id, username, display_name, is_node_admin, is_owner)
       values ($1, 'suggest-owner', 'Owner', false, true), ($2, 'suggest-stranger', 'Stranger', false, false)`,
      [OWNER, STRANGER],
    );
    const s = ids.space = await space(c, 'Suggest', OWNER);
    ids.strangerSpace = await space(c, 'Elsewhere', STRANGER);

    ids.parent = await teammate(c, s, 'Lead', 'Architect', 'Parent persona.');
    ids.teammate = await teammate(c, s, 'Draco', 'PTY engineer', `You own the terminal seam. ${'p'.repeat(1000)}`, ids.parent);
    ids.task = await entity(c, s, 'task');
    await c.query(`insert into public.tasks(entity_id, title, description) values ($1, 'Fix login', 'SSO lands on 404')`, [ids.task]);

    ids.mWorking = await memory(c, s, LONG_STATEMENT);
    await edge(c, s, ids.teammate, ids.mWorking, 'remembers');
    ids.mTask = await memory(c, s, 'task memory');
    await edge(c, s, ids.task, ids.mTask, 'remembers');
    ids.mSpace = await memory(c, s, 'space memory');
    ids.mOld = await memory(c, s, 'stale claim');
    await edge(c, s, ids.teammate, ids.mOld, 'remembers');
    ids.mNew = await memory(c, s, 'current claim');
    await edge(c, s, ids.mNew, ids.mOld, 'supersedes');
    ids.mHidden = await memory(c, s, 'HIDDEN restricted memory', { visibility: 'restricted' });

    ids.sEquipped = await skill(c, s, 'deploy-runbook');
    await edge(c, s, ids.teammate, ids.sEquipped, 'equips');
    ids.sInherited = await skill(c, s, 'design-review');
    await edge(c, s, ids.parent, ids.sInherited, 'equips');
    ids.sSpace = await skill(c, s, 'figma-connector');
    ids.sMissing = await skill(c, s, 'vanished', { missing: true });
  });
}, 300_000);

afterAll(async () => {
  await db?.end();
  await database?.destroy();
});

// ---------------------------------------------------------------------------
// The fake port
// ---------------------------------------------------------------------------

const okCall = (over: Partial<JevCallRecord> = {}): JevCallRecord => ({
  jevModel: 'jev-1.13.0', inputTokens: 1000, outputTokens: 12, costUsd: 0.000042, latencyMs: 250, outcome: 'ok', ...over,
});

interface FakePort extends JevAdvisorPort {
  seen: Array<{ noun: string; candidates: JevCandidate[] }>;
  maxInFlight: number;
}

function fakePort(opts: {
  score?: (noun: string, candidate: JevCandidate) => number;
  failNoun?: string;
  calls?: (noun: string) => JevCallRecord[];
  barrier?: number;
} = {}): FakePort {
  let inFlight = 0;
  let started = 0;
  const waiters: Array<() => void> = [];
  const enter = async (): Promise<void> => {
    inFlight += 1;
    started += 1;
    port.maxInFlight = Math.max(port.maxInFlight, inFlight);
    if (opts.barrier) {
      if (started >= opts.barrier) waiters.splice(0).forEach((wake) => wake());
      else await Promise.race([new Promise<void>((wake) => waiters.push(wake)), new Promise((r) => setTimeout(r, 2000))]);
    }
  };
  const port: FakePort = {
    seen: [],
    maxInFlight: 0,
    async rank({ candidates, noun }) {
      port.seen.push({ noun, candidates });
      await enter();
      inFlight -= 1;
      const calls = opts.calls?.(noun) ?? [okCall()];
      if (noun === opts.failNoun) return { ok: false, reason: 'timeout', calls: calls.map((c) => ({ ...c, outcome: 'timeout' as const })) };
      return { ok: true, ranked: candidates.map((c) => ({ id: c.id, score: opts.score?.(noun, c) ?? 2 })), calls };
    },
    async model() {
      await enter();
      inFlight -= 1;
      return {
        ok: true,
        call: okCall({ inputTokens: 800, costUsd: 0.0000336 }),
        verdict: { tier: 'standard', model: 'claude-sonnet-5', agentTool: 'claude-code', effort: 'medium', need: 1.2, workKind: 'bugfix', reasons: ['work_kind=bugfix'] },
      };
    },
  };
  return port;
}

function handlerFor(advisor: JevAdvisorPort | null, identity = OWNER) {
  const registry = new HandlerRegistry();
  const deps = { db, config: {}, owner: async () => ({ identityId: identity, isNodeAdmin: false }) } as unknown as FacadeDeps;
  registerJevHandlers(registry, deps, { advisor });
  const handler = registry.get('launch.suggest')!;
  return (body: Record<string, unknown>, spaceId = ids.space!) => handler({
    params: { spaceId }, query: new URLSearchParams(), body, requestId: randomUUID(),
    identity: { kind: 'loopback' }, headers: {}, method: 'POST', path: '/',
  } as unknown as RequestContext) as Promise<LaunchSuggestResult>;
}

const ALL = ['model', 'teammates', 'memories', 'skills'];
const input = (over: Record<string, unknown> = {}) => ({
  runId: randomUUID(), requestId: randomUUID(), subjectId: ids.task, teamMemberId: ids.teammate, groups: ALL, ...over,
});

function items(result: LaunchSuggestResult, group: 'memories' | 'skills' | 'teammates') {
  const g = result.groups[group];
  if (g?.status !== 'ok') throw new Error(`${group} is ${g?.status}: ${JSON.stringify(g)}`);
  return g.value.items;
}

async function callRows(runId: string) {
  return database.query<{ request_id: string; grp: string; chunk: number; outcome: string; latency_ms: number }>(
    `select request_id::text, grp, chunk, outcome, latency_ms from public.jev_calls where run_id = $1 order by grp, chunk`,
    [runId],
  );
}

// ---------------------------------------------------------------------------

describe('candidates', () => {
  it('memories: one entry per id, every source kept, superseded and unreadable excluded, text cut at 600', async () => {
    const port = fakePort();
    const result = await handlerFor(port)(input());
    const byId = new Map(items(result, 'memories').map((item) => [item.entityId, item]));
    expect(byId.get(ids.mWorking!)?.sources).toEqual(['teammate', 'space']);
    expect(byId.get(ids.mTask!)?.sources).toEqual(['task', 'space']);
    expect(byId.get(ids.mSpace!)?.sources).toEqual(['space']);
    expect(byId.get(ids.mNew!)?.sources).toEqual(['space']);
    expect(byId.has(ids.mOld!)).toBe(false);
    expect(byId.has(ids.mHidden!)).toBe(false);
    expect(items(result, 'memories').filter((i) => i.entityId === ids.mWorking)).toHaveLength(1);

    const sent = port.seen.find((s) => s.noun === 'memory')!.candidates;
    expect(sent.map((c) => c.id).sort()).toEqual([ids.mWorking, ids.mTask, ids.mSpace, ids.mNew].sort());
    expect([...sent.find((c) => c.id === ids.mWorking)!.text]).toHaveLength(600);
    expect(JSON.stringify(sent)).not.toContain('HIDDEN');
    // Direct sources first.
    expect(sent.slice(0, 2).map((c) => c.id).sort()).toEqual([ids.mWorking, ids.mTask].sort());
  });

  it('skills: equipped, inherited and space sources merged per id; missing excluded; bodies never sent', async () => {
    const port = fakePort();
    const result = await handlerFor(port)(input());
    const byId = new Map(items(result, 'skills').map((item) => [item.entityId, item]));
    expect(byId.get(ids.sEquipped!)?.sources).toEqual(['teammate', 'space']);
    expect(byId.get(ids.sInherited!)?.sources).toEqual(['inherited', 'space']);
    expect(byId.get(ids.sSpace!)?.sources).toEqual(['space']);
    expect(byId.has(ids.sMissing!)).toBe(false);
    expect(byId.size).toBe(3);
    const sent = port.seen.find((s) => s.noun === 'skill')!.candidates;
    expect(sent.find((c) => c.id === ids.sEquipped)?.text).toBe('deploy-runbook: deploy-runbook does a thing');
    expect(JSON.stringify(port.seen)).not.toContain('SECRET SKILL BODY');
  });

  it('teammates: every live teammate, with role, equipped skill names (inherited too) and a 600-char persona', async () => {
    const port = fakePort();
    const result = await handlerFor(port)(input());
    expect(items(result, 'teammates').map((i) => i.entityId).sort()).toEqual([ids.parent, ids.teammate].sort());
    const text = port.seen.find((s) => s.noun === 'teammate')!.candidates.find((c) => c.id === ids.teammate)!.text;
    expect(text.startsWith('Draco — PTY engineer. Equipped with: deploy-runbook, design-review. You own the terminal seam.')).toBe(true);
    expect(text).toContain('p'.repeat(100));
    expect(text.length).toBeLessThan(700);
  });

  it('above 240: direct sources first, then the space by most recently updated; considered/total reported', async () => {
    const limitSpace = await asOwner(async (c) => {
      const s = await space(c, 'Limit', OWNER);
      const tm = await teammate(c, s, 'Solo', 'Worker', 'persona');
      ids.limitTeammate = tm;
      const task = await entity(c, s, 'task');
      ids.limitTask = task;
      await c.query(`insert into public.tasks(entity_id, title) values ($1, 'Limit task')`, [task]);
      // Two direct memories, OLDEST of all — they must still come first.
      ids.limitDirect1 = await memory(c, s, 'direct one', { updatedAt: '2020-01-01T00:00:00Z' });
      await edge(c, s, tm, ids.limitDirect1, 'remembers');
      ids.limitDirect2 = await memory(c, s, 'direct two', { updatedAt: '2020-01-02T00:00:00Z' });
      await edge(c, s, task, ids.limitDirect2, 'remembers');
      for (let i = 0; i < 250; i += 1) {
        const at = new Date(Date.UTC(2025, 0, 1) + i * 60_000).toISOString();
        ids[`limit:${i}`] = await memory(c, s, `space memory ${i}`, { updatedAt: at });
      }
      return s;
    });
    const port = fakePort();
    const result = await handlerFor(port)(
      input({ subjectId: ids.limitTask, teamMemberId: ids.limitTeammate, groups: ['memories'] }), limitSpace,
    );
    const group = result.groups.memories;
    if (group?.status !== 'ok') throw new Error(JSON.stringify(group));
    expect(group.value).toMatchObject({ considered: 240, total: 252 });
    const sent = port.seen[0]!.candidates.map((c) => c.id);
    expect(sent).toHaveLength(240);
    expect(sent.slice(0, 2).sort()).toEqual([ids.limitDirect1, ids.limitDirect2].sort());
    // Then newest first: 249, 248, … down to 12; the 12 oldest space rows fall off.
    expect(sent[2]).toBe(ids['limit:249']);
    expect(sent[239]).toBe(ids['limit:12']);
    expect(sent).not.toContain(ids['limit:11']);
  });
});

describe('skips, failures and no_key', () => {
  it('without a teammate, memories and skills are skipped: no_teammate; the rest still answer', async () => {
    const result = await handlerFor(fakePort())(input({ teamMemberId: undefined }));
    expect(result.groups.memories).toMatchObject({ status: 'skipped', reason: 'no_teammate', cost: { calls: 0 } });
    expect(result.groups.skills).toMatchObject({ status: 'skipped', reason: 'no_teammate' });
    expect(result.groups.teammates?.status).toBe('ok');
    expect(result.groups.model?.status).toBe('ok');
  });

  it('an empty subject skips every group with no_subject_text — the draft decides the text', async () => {
    // A task title cannot be blank (tasks_title_check); the Run popup's live
    // draft can, and it replaces the subject's text.
    const port = fakePort();
    const empty = await handlerFor(port)(input({ draft: { title: '  ', description: '' } }));
    for (const group of ALL) {
      expect(empty.groups[group as 'model']).toMatchObject({ status: 'skipped', reason: 'no_subject_text' });
    }
    expect(port.seen).toHaveLength(0);
    const drafted = await handlerFor(port)(input({ draft: { title: 'Real title', description: '' } }));
    expect(drafted.groups.model?.status).toBe('ok');
  });

  it('one group failing leaves the others ok, and its failed call is still recorded and costed', async () => {
    const body = input();
    const result = await handlerFor(fakePort({ failNoun: 'skill' }))(body);
    expect(result.groups.skills).toMatchObject({ status: 'failed', reason: 'timeout', cost: { calls: 1 } });
    expect(result.groups.model?.status).toBe('ok');
    expect(result.groups.teammates?.status).toBe('ok');
    expect(result.groups.memories?.status).toBe('ok');
    const rows = await callRows(body.runId);
    expect(rows.find((r) => r.grp === 'skills')?.outcome).toBe('timeout');
    expect(result.run.calls).toBe(4);
  });

  it('with no client configured every group is failed: no_key — still an answer, not an error', async () => {
    const body = input();
    const result = await handlerFor(null)(body);
    for (const group of ALL) {
      expect(result.groups[group as 'model']).toEqual({ status: 'failed', reason: 'no_key', cost: { calls: 0, inputTokens: 0, outputTokens: 0, usd: 0, latencyMs: 0 } });
    }
    expect(result.run.calls).toBe(0);
  });
});

describe('RLS', () => {
  it('refuses a caller who is not a member of the space', async () => {
    await expect(handlerFor(fakePort(), STRANGER)(input())).rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('cost records', () => {
  it('one jev_calls row per call; chunk is the index in calls[]', async () => {
    const body = input({ groups: ['memories'] });
    const chunks = [okCall({ latencyMs: 100 }), okCall({ latencyMs: 200 }), okCall({ latencyMs: 300, outcome: 'ok' })];
    await handlerFor(fakePort({ calls: () => chunks }))(body);
    const rows = await callRows(body.runId);
    expect(rows.map((r) => [r.grp, r.chunk, r.latency_ms])).toEqual([
      ['memories', 0, 100], ['memories', 1, 200], ['memories', 2, 300],
    ]);
  });

  it('re-sending the same requestId adds no jev_calls rows', async () => {
    const body = input();
    const handler = handlerFor(fakePort());
    await handler(body);
    const before = await callRows(body.runId);
    expect(before).toHaveLength(4);
    const again = await handler(body);
    expect(await callRows(body.runId)).toHaveLength(4);
    expect(again.run.calls).toBe(4);
  });

  it('run sums every request in the run: calls, tokens, dollars; latency is the sum of each request’s slowest call', async () => {
    const runId = randomUUID();
    const handler = handlerFor(fakePort({ calls: () => [okCall({ latencyMs: 400 })] }));
    const first = await handler(input({ runId, groups: ['memories', 'skills'] }));
    expect(first.run).toMatchObject({ calls: 2, inputTokens: 2000, latencyMs: 400 });
    const second = await handler(input({ runId, groups: ['skills'] }));
    expect(second.run.calls).toBe(3);
    expect(second.run.inputTokens).toBe(3000);
    expect(second.run.outputTokens).toBe(36);
    expect(second.run.usd).toBeCloseTo(0.000126, 10);
    expect(second.run.latencyMs).toBe(800);
  });

  it('jev_runs.suggestions holds ids, scores, levels and the verdict — no statement, title or description text', async () => {
    const body = input();
    await handlerFor(fakePort())(body);
    const row = (await database.query<{ suggestions: Record<string, any>; requested_by: string }>(
      'select suggestions, requested_by from public.jev_runs where id = $1', [body.runId],
    ))[0]!;
    expect(row.requested_by).toBe(OWNER);
    const text = JSON.stringify(row.suggestions);
    for (const forbidden of ['working set', 'task memory', 'space memory', 'deploy-runbook', 'Draco', 'Fix login', 'SSO']) {
      expect(text).not.toContain(forbidden);
    }
    expect(row.suggestions.memories.items[0]).toEqual({ id: expect.any(String), score: 2, level: 'useful', suggested: true });
    expect(row.suggestions.model.verdict.model).toBe('claude-sonnet-5');
    expect(Object.keys(row.suggestions).sort()).toEqual([...ALL].sort());
  });

  it('a later request merges into the run: its groups replace, the others stay', async () => {
    const runId = randomUUID();
    const handler = handlerFor(fakePort());
    await handler(input({ runId }));
    const second = randomUUID();
    await handler(input({ runId, requestId: second, groups: ['skills'] }));
    const row = (await database.query<{ suggestions: Record<string, { requestId: string }> }>(
      'select suggestions from public.jev_runs where id = $1', [runId],
    ))[0]!;
    expect(row.suggestions.skills!.requestId).toBe(second);
    expect(row.suggestions.memories!.requestId).not.toBe(second);
  });
});

describe('parallelism', () => {
  it('all four groups are in flight at once', async () => {
    const port = fakePort({ barrier: 4 });
    const started = Date.now();
    await handlerFor(port)(input());
    expect(port.maxInFlight).toBe(4);
    // The barrier released on the fourth arrival, not on its 2 s fallback.
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
