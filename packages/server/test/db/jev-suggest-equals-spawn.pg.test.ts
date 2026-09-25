/**
 * THE I7 CONTRACT (integrated design 01a0d348 §10 Q5.8): for an unchanged
 * graph, the set Ask Jev ticks at suggest time is the set spawn keeps at
 * launch — byte for byte.
 *
 * Against a REAL PostgreSQL, as `tm8_app` under the caller's claims:
 *   1. `launch.suggest` (the registered handler, a fake Jev that scores) ranks
 *      memories, skills and references and fills each group's budget from the
 *      profile the launch pins;
 *   2. the ticked sets are sent the way the launch sheet sends them — each
 *      group an exact `selection` set, with the run's `jevRunId`;
 *   3. spawn's own path runs: `DbGraphPort.loadSpawnContext`, the index
 *      headers and memory scores `SpawnService.loadIndexHeaders` reads, and
 *      `composeManifest` with the same profile.
 *
 * Then, per group: what spawn kept whole is exactly what was ticked (nothing
 * collapsed, header-dropped or entry-dropped), every entry renders at exactly
 * its `promptBytes`, and the group renders at exactly the bytes the fill
 * counted. The fill is made to BIND in every group (something, a default
 * included, is left over budget), so the equality is not a vacuous one over a
 * group that fit anyway — and the over-budget default is recorded at spawn,
 * never silent.
 */
import { randomUUID } from 'node:crypto';

import type { LaunchSuggestResult, RankedEntity } from '@tm8/contract';
import { composeManifest, contextHeaderIds, resolveLaunchConfig, type SpawnContext } from '@tm8/execution';
import { contextEntryBytes, serializeContextGroup, serializeMemoryEntry, serializeSkillIndexEntry, utf8Bytes } from '@tm8/prompt';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createDb } from '../../src/db/index.js';
import type { Db, DbClaims } from '../../src/db/types.js';
import { DbGraphPort } from '../../src/facade/execution-handlers.js';
import type { FacadeDeps } from '../../src/facade/deps.js';
import { HandlerRegistry } from '../../src/facade/registry.js';
import type { RequestContext } from '../../src/http/types.js';
import { filledBytes } from '../../src/jev/groups.js';
import { groupRules, registerJevHandlers } from '../../src/jev/handlers.js';
import type { JevAdvisorPort } from '../../src/jev/port.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

// The pre-spawn scan refreshes filesystem references from real home
// directories; it is not what is under test and must not touch this machine.
vi.mock('../../src/skills/service.js', () => ({ scanSpaceSkills: vi.fn(async () => ({ scannedAt: null })) }));
vi.setConfig({ testTimeout: 60_000, hookTimeout: 300_000 });

const IDENTITY = 'equals-owner';
let database: W1ScratchDatabase;
let db: Db;
let port: DbGraphPort;
const ids: Record<string, string> = {};
/** Jev's score per entity id: the fixture decides the rank. */
const scores = new Map<string, number>();
const claims = (): DbClaims => ({ identityId: IDENTITY, nodeAdmin: false, requestId: randomUUID() });

type Client = import('pg').PoolClient;
const newId = async (c: Client): Promise<string> => (await c.query<{ id: string }>('select internal.new_id()::text id')).rows[0]!.id;

async function entity(c: Client, space: string, kind: string, parent: string | null = null): Promise<string> {
  const id = await newId(c);
  await c.query(
    `insert into public.entities(id, space_id, kind, parent_id, position, created_by) values ($1, $2, $3, $4, 0, $5)`,
    [id, space, kind, parent, ids[`member:${space}`] ?? id],
  );
  return id;
}
async function edge(c: Client, space: string, src: string, dst: string, type: string): Promise<void> {
  await c.query(
    `insert into public.edges(space_id, src_id, dst_id, type, props, created_by) values ($1, $2, $3, $4, '{}'::jsonb, $5)`,
    [space, src, dst, type, ids[`member:${space}`]],
  );
}
async function memory(c: Client, space: string, statement: string, score: number): Promise<string> {
  const id = await entity(c, space, 'memory');
  await c.query(
    `insert into public.memories(entity_id, statement, mechanism, subject_scope, does_not_establish) values ($1, $2, 'seed', 'deploys', 'runtime')`,
    [id, statement],
  );
  scores.set(id, score);
  return id;
}
async function skill(c: Client, space: string, name: string, description: string, score: number): Promise<string> {
  const id = await entity(c, space, 'skill');
  await c.query(`insert into public.skills(entity_id, space_id, name, description) values ($1, $2, $3, $4)`, [id, space, name, description]);
  scores.set(id, score);
  return id;
}
async function doc(c: Client, space: string, title: string, body: string, score: number): Promise<string> {
  const id = await entity(c, space, 'doc');
  await c.query(`insert into public.documents(entity_id, title, body) values ($1, $2, $3)`, [id, title, body]);
  scores.set(id, score);
  return id;
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('jev_suggest_equals_spawn');
  database.apply(migrationFiles());
  db = createDb(database.url);
  port = new DbGraphPort(db);
  await database.transaction(async (c) => {
    await c.query('set local role tm8_graph_owner');
    await c.query(`insert into public.user_profiles(identity_id, display_name) values ($1, 'Owner')`, [IDENTITY]);
    const s = ids.space = await newId(c);
    await c.query(`insert into public.spaces(id, name, created_by_identity) values ($1, 'Equals', $2)`, [s, IDENTITY]);
    const member = await newId(c);
    await c.query(`insert into public.entities(id, space_id, kind, position, created_by) values ($1, $2, 'member', 0, $1)`, [member, s]);
    await c.query(`insert into public.members(entity_id, space_id, identity_id, role, display_name) values ($1, $2, $3, 'owner', 'Owner')`, [member, s, IDENTITY]);
    ids[`member:${s}`] = member;

    ids.teammate = await entity(c, s, 'team_member');
    await c.query(`insert into public.team_members(entity_id, owner_member_id, name, role, identity) values ($1, $2, 'Draco', 'PTY', 'persona')`, [ids.teammate, member]);
    ids.task = await entity(c, s, 'task');
    await c.query(`insert into public.tasks(entity_id, title, description) values ($1, 'Fix the deploy', 'The deploy target is wrong.')`, [ids.task]);

    // Memories: two defaults (the working set, the task's set) and space picks,
    // with lengths that make the 3000-byte budget bind part-way down the rank.
    ids.mWorking = await memory(c, s, `working: ${'w'.repeat(1400)}`, 1.8);
    await edge(c, s, ids.teammate, ids.mWorking, 'remembers');
    ids.mTask = await memory(c, s, `task: ${'t'.repeat(500)}`, 2.2);
    await edge(c, s, ids.task, ids.mTask, 'remembers');
    ids.mTop = await memory(c, s, `top: ${'a'.repeat(1200)} 🚀`, 2.4);
    ids.mSmall = await memory(c, s, 'small but useful', 1.6);
    ids.mLow = await memory(c, s, 'below the floor', 1.2);
    // Verified at its version: the mark is part of what spawn renders.
    const pinned = (await c.query<{ version: number }>('select version from public.entities where id = $1', [ids.mSmall])).rows[0]!.version;
    await c.query(
      `insert into public.edges(space_id, src_id, dst_id, type, props, created_by) values ($1, $2, $3, 'verifies', $4::jsonb, $2)`,
      [s, member, ids.mSmall, JSON.stringify({ pinnedVersion: pinned })],
    );

    // Skills: equipped defaults and space skills.
    ids.sEquipped = await skill(c, s, 'deploy-runbook', `Deploy the node. ${'d'.repeat(300)}`, 2.0);
    await edge(c, s, ids.teammate, ids.sEquipped, 'equips');
    ids.sEquippedLow = await skill(c, s, 'old-runbook', `Superseded runbook. ${'o'.repeat(500)}`, 1.7);
    await edge(c, s, ids.teammate, ids.sEquippedLow, 'equips');
    ids.sPick = await skill(c, s, 'utho-ssh', 'How to reach utho.', 2.6);
    ids.sPick2 = await skill(c, s, 'nginx', `Nginx config. ${'n'.repeat(200)}`, 1.9);
    ids.sOff = await skill(c, s, 'figma', 'Design files.', 0.4);

    // References: the task's links (defaults) and space docs.
    ids.dLinked = await doc(c, s, 'Deploy notes', `First paragraph about deploys. ${'p'.repeat(600)}\n\n## Steps\n\n## Rollback`, 2.1);
    await edge(c, s, ids.dLinked, ids.task, 'attached_to');
    ids.dLinkedLow = await doc(c, s, 'Old deploy notes', `Old notes. ${'q'.repeat(800)}`, 1.6);
    await edge(c, s, ids.task, ids.dLinkedLow, 'relates_to');
    ids.dPick = await doc(c, s, 'Utho runbook', `How utho is laid out. ${'u'.repeat(900)}`, 2.5);
    ids.dPick2 = await doc(c, s, 'Nginx map', 'Which vhost is which.', 1.8);
    ids.dOff = await doc(c, s, 'Lunch menu', 'Tacos.', 0.1);
  });
}, 300_000);

afterAll(async () => {
  await db?.end();
  await database?.destroy();
});

const jev: JevAdvisorPort = {
  rank: async ({ candidates }) => ({
    ok: true,
    ranked: candidates.map((c) => ({ id: c.id, score: scores.get(c.id) ?? 0 })),
    calls: [{ jevModel: 'jev-test', inputTokens: 1, outputTokens: 1, costUsd: 0, latencyMs: 1, outcome: 'ok' }],
  }),
  model: async () => { throw new Error('not asked'); },
};

async function suggest(profileSnapshot: unknown, runId: string): Promise<LaunchSuggestResult> {
  const registry = new HandlerRegistry();
  const deps = { db, config: {}, owner: async () => ({ identityId: IDENTITY, isNodeAdmin: false }) } as unknown as FacadeDeps;
  registerJevHandlers(registry, deps, { advisor: jev, env: {}, resolveProfile: async () => profileSnapshot });
  return registry.get('launch.suggest')!({
    params: { spaceId: ids.space }, query: new URLSearchParams(), requestId: randomUUID(),
    body: { runId, requestId: randomUUID(), subjectId: ids.task, teamMemberId: ids.teammate, groups: ['memories', 'skills', 'references'] },
    identity: { kind: 'loopback' }, headers: {}, method: 'POST', path: '/',
  } as unknown as RequestContext) as Promise<LaunchSuggestResult>;
}

function group(result: LaunchSuggestResult, name: 'memories' | 'skills' | 'references') {
  const g = result.groups[name];
  if (g?.status !== 'ok') throw new Error(`${name} is ${g?.status}`);
  return g.value;
}

/** The ticked ids in rank order — how the launch sheet seeds its ticks from `suggested`. */
const ticked = (items: readonly RankedEntity[]): string[] => items.filter((item) => item.suggested).map((item) => item.entityId);

/** Spawn's own path for a launch that sends `selection` and the run: load, index headers + scores, compose. */
async function spawn(profileSnapshot: unknown, selection: { memoryIds: string[]; skillIds: string[]; referenceIds: string[] }, jevRunId: string, indexOn: boolean) {
  const context: SpawnContext = await port.loadSpawnContext(claims(), {
    spaceId: ids.space!, teamMemberId: ids.teammate!, taskIds: [ids.task!], selection,
  });
  if (indexOn) {
    // Exactly `SpawnService.loadIndexHeaders`.
    context.headers = await port.loadContextHeaders(claims(), { spaceId: ids.space!, ids: contextHeaderIds(context) });
    const memoryScores = await port.loadMemoryScores(claims(), { spaceId: ids.space!, jevRunId, memoryIds: context.teamMember.memoryIds ?? [] });
    if (memoryScores.length > 0) context.memoryScores = memoryScores;
  }
  const request = { spaceId: ids.space!, teamMemberId: ids.teammate!, taskIds: [ids.task!], selection, jevRunId };
  return composeManifest({
    sessionId: 'session', request, context, launch: resolveLaunchConfig(request, context, {}),
    workdir: { mode: 'project', path: '/repo' }, command: 'test', baseUrl: 'http://localhost',
    interactionProfile: {
      profileId: null, profileVersion: null, templateKey: 'tm8.chat.core', templateVersion: 1,
      source: 'core_default', resolvedHash: 'test', pinRevision: 0, snapshot: profileSnapshot as Record<string, unknown>,
    } as never,
    ...(indexOn ? { contextIndex: { source: 'profile' as const } } : {}),
  });
}

describe('suggest-ticked == spawn-kept, byte for byte (design 01a0d348 §10 Q5.8)', () => {
  const PROFILE = {
    profile: { source: 'core_default' },
    draft: { contextIndex: true, contextBudgets: { memories: 3000, skills: 1500, references: 1400 } },
  };

  it('with <context_index> on: every group keeps exactly its ticks, each entry at its promptBytes, each group at the bytes the fill counted', async () => {
    const runId = randomUUID();
    const result = await suggest(PROFILE, runId);
    expect(result.contextIndex).toBe('on');
    const memories = group(result, 'memories');
    const skills = group(result, 'skills');
    const references = group(result, 'references');
    const { rules } = groupRules({}, PROFILE);

    // The fill BINDS in every group: a row above its floor was left over
    // budget, and one of them is a default.
    for (const g of [memories, skills, references]) {
      expect(g.items.some((item) => item.reason === 'over-budget'), JSON.stringify(g.items.map((i) => [i.title, i.score, i.promptBytes, i.suggested]))).toBe(true);
      expect(g.items.some((item) => item.suggested)).toBe(true);
    }
    const overBudgetDefaults = [...memories.items, ...skills.items, ...references.items].filter((item) => item.default && item.reason === 'over-budget');
    expect(overBudgetDefaults.length).toBeGreaterThan(0);

    const selection = { memoryIds: ticked(memories.items), skillIds: ticked(skills.items), referenceIds: ticked(references.items) };
    const manifest = await spawn(PROFILE, selection, runId, true);
    const index = manifest.contextIndex!;
    const promptBytes = new Map([...memories.items, ...skills.items, ...references.items].map((item) => [item.entityId, item.promptBytes]));

    // MEMORIES: all kept whole, none collapsed; each <entry> is its promptBytes.
    expect(manifest.context!.memoryIds).toEqual(selection.memoryIds);
    expect(index.groups.find((g) => g.name === 'memories')?.entries ?? []).toEqual([]);
    const texts = (manifest.agent.memory as unknown[]).map(String);
    expect(texts.map((text) => utf8Bytes(serializeMemoryEntry(text)))).toEqual(selection.memoryIds.map((id) => promptBytes.get(id)));
    expect(manifest.context!.budgets!.memoryInjection!.used).toBe(filledBytes(memories.items, rules.memories));
    expect(manifest.context!.budgets!.memoryInjection!.used).toBeLessThanOrEqual(3000);

    // SKILLS and REFERENCES: every ticked entry rendered whole (no header or
    // entry drop), each at its promptBytes, and the group at the fill's bytes.
    for (const [name, ticks, g] of [['skills', selection.skillIds, skills], ['references', selection.referenceIds, references]] as const) {
      const rendered = index.groups.find((candidate) => candidate.name === name)!;
      expect(rendered.entries.map((entry) => entry.id), name).toEqual(ticks);
      expect(rendered.entries.some((entry) => entry.headerDropped), name).toBe(false);
      expect(rendered.omitted, name).toBe(0);
      expect(rendered.entries.map(contextEntryBytes), name).toEqual(ticks.map((id) => promptBytes.get(id)));
      expect(utf8Bytes(serializeContextGroup(rendered)) + 1, name).toBe(filledBytes(g.items, rules[name]));
    }

    // Nothing the trim cut; every default the fill left out is recorded, not silent.
    const dropped = manifest.context!.dropped ?? [];
    expect(dropped.filter((d) => d.reason === 'byte-budget')).toEqual([]);
    for (const item of overBudgetDefaults) {
      expect(dropped, item.title).toContainEqual(expect.objectContaining({ entityId: item.entityId, reason: 'not-selected' }));
    }
  });

  it('with <context_index> off: memories are kept at their promptBytes, and a skill\'s promptBytes is its <skills> line', async () => {
    const OFF = { profile: { source: 'core_default' }, draft: { contextBudgets: { memories: 3000 } } };
    const runId = randomUUID();
    const result = await suggest(OFF, runId);
    expect(result.contextIndex).toBe('off');
    const memories = group(result, 'memories');
    const skills = group(result, 'skills');
    expect(group(result, 'references').items.every((item) => item.promptBytes === 0)).toBe(true);
    const selection = { memoryIds: ticked(memories.items), skillIds: ticked(skills.items), referenceIds: [] };
    const manifest = await spawn(OFF, selection, runId, false);
    expect(manifest.contextIndex).toBeUndefined();
    const texts = (manifest.agent.memory as unknown[]).map(String);
    expect(texts.map((text) => utf8Bytes(serializeMemoryEntry(text)))).toEqual(
      selection.memoryIds.map((id) => memories.items.find((item) => item.entityId === id)!.promptBytes),
    );
    expect(manifest.skills.map((s) => s.entityId)).toEqual(selection.skillIds);
    expect(manifest.skills.map((s) => utf8Bytes(serializeSkillIndexEntry(s)) + 1)).toEqual(
      selection.skillIds.map((id) => skills.items.find((item) => item.entityId === id)!.promptBytes),
    );
  });
});
