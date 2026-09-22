// Context engineering at the spawn seam (@tm8/jev).
//
// Routing decides WHICH MODEL runs the task. This decides WHAT IT READS when
// it does, and it is the half with the sharper failure mode: a mis-routed
// model does the same work at the wrong price, while a wrongly-dropped memory
// produces an agent that does not know something its operator believed it
// knew. So every claim below is about restraint.
//
//   1. UNWIRED IS BYTE-IDENTICAL. Asserted by comparing two real spawns, not
//      by inspection.
//   2. It only ever REMOVES, and the survivors keep the caller's order —
//      `resolveSkills` documents a byte-identical manifest across two spawns
//      of an unchanged graph, and a ranker does not get to spend that.
//   3. FAIL-OPEN. An advisor that throws leaves the agent carrying everything,
//      exactly as today. A context service being down must never make a
//      persona forget things.
//   4. The decision is visible: what was offered, what survived, what it saved.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContextActivation, ContextAdvisorPort, ContextPlan } from '@tm8/jev';
import { PtyHostService } from '../src/pty/PtyHostService.js';
import { ECHO_AGENT_CMD } from '../src/spawn/manifest.js';
import { SpawnService } from '../src/spawn/SpawnService.js';
import { FakeGraph } from './fake-graph.js';

const AUTH = { identityId: 'identity-1', actorId: 'actor-1' };
const TASK_ID = '44444444-4444-4444-8444-444444444444';
const REQUEST = {
  clientMutationId: 'mutation-1',
  spaceId: '11111111-1111-4111-8111-111111111111',
  teamMemberId: '22222222-2222-4222-8222-222222222222',
  projectId: '33333333-3333-4333-8333-333333333333',
  taskIds: [TASK_ID],
};

const MEMORIES = [
  'Deploying tm8 from the Utho box: you are already on prod.',
  'A CSS comment can eat the next rule.',
  'Worktree is shared — the branch moves under you.',
];
const SKILLS = [
  { entityId: 'deploy', provider: 'tm8', level: 'space', native: false, loadPointer: 'tm8 entity get deploy', name: 'deploy-runbook', description: 'Swap the dist, never restart the unit.' },
  { entityId: 'figma', provider: 'tm8', level: 'space', native: false, loadPointer: 'tm8 entity get figma', name: 'figma-connector', description: 'OAuth-only server, catalog-gated clients.' },
];

function group(keptIds: string[], decisions: number): ContextActivation['memories'] {
  return {
    keptIds,
    decisions: Array.from({ length: decisions }, (_v, i) => ({
      id: `x${i}`,
      name: null,
      kept: false,
      score: 1,
      confidence: 0.8,
      rank: i + 1,
      bytes: 10,
      reason: 'kept' as const,
    })),
    bytesBefore: 300,
    bytesAfter: 120,
    droppedCritical: [],
  };
}

function planWith(over: Partial<ContextPlan> = {}): ContextPlan {
  return {
    activation: {
      at: '2026-09-21T12:00:00.000Z',
      jevModel: 'jev-1.13.0',
      latencyMs: 1123,
      jevInputTokens: 6880,
      jevCostUsd: 0.000289,
      memories: group(['m0'], 3),
      skills: group(['s0'], 2),
      bytesSaved: 360,
      pctSaved: 60,
      summary: 'Jev kept 1/3 memories and 1/2 skills — 360 prompt bytes saved (60%).',
    },
    keepMemoryIds: ['m0'],
    keepSkillIds: ['s0'],
    ...over,
  };
}

function fixedAdvisor(plan: ContextPlan | null): ContextAdvisorPort {
  return { plan: vi.fn(async () => plan) };
}

describe('SpawnService context engineering', () => {
  let dataDir: string;
  let projectDir: string;
  let graph: FakeGraph;
  let pty: PtyHostService;

  function serviceWith(contextAdvisor?: ContextAdvisorPort): SpawnService {
    return new SpawnService({
      graph,
      pty,
      baseUrl: 'http://127.0.0.1:4611',
      dataDir,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TM8_AGENT_CMD: ECHO_AGENT_CMD },
      bootSettlementMs: 25,
      ...(contextAdvisor ? { contextAdvisor } : {}),
    });
  }

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'tm8-ctx-data-'));
    projectDir = await mkdtemp(join(tmpdir(), 'tm8-ctx-project-'));
    graph = new FakeGraph({ workingDir: projectDir, memories: MEMORIES, skills: SKILLS });
    pty = new PtyHostService();
    vi.spyOn(pty, 'beginPromptHandoff').mockImplementation(() => {});
    vi.spyOn(pty, 'spawnIfAbsent').mockReturnValue({ reused: false } as never);
    vi.spyOn(pty, 'waitForBootSettlement').mockResolvedValue(null);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dataDir, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
  });

  it('is a no-op when no advisor is wired', async () => {
    await serviceWith().spawn(AUTH, REQUEST);
    const manifest = graph.manifests[0]?.manifest;
    expect(manifest?.agent.memory).toEqual(MEMORIES);
    expect(manifest?.skills?.map((s) => s.name)).toEqual(['deploy-runbook', 'figma-connector']);
    expect(manifest?.launch.contextEngineering).toBeNull();
  });

  it('injects only what the plan kept', async () => {
    await serviceWith(fixedAdvisor(planWith())).spawn(AUTH, REQUEST);
    const manifest = graph.manifests[0]?.manifest;
    expect(manifest?.agent.memory).toEqual([MEMORIES[0]]);
    expect(manifest?.skills?.map((s) => s.name)).toEqual(['deploy-runbook']);
  });

  it('keeps the resolver’s order among the survivors', async () => {
    // Jev kept the SECOND and THIRD memory. They must come back in the graph's
    // order, not in whatever order the plan happened to list them.
    await serviceWith(fixedAdvisor(planWith({ keepMemoryIds: ['m2', 'm1'] }))).spawn(AUTH, REQUEST);
    expect(graph.manifests[0]?.manifest.agent.memory).toEqual([MEMORIES[1], MEMORIES[2]]);
  });

  it('records a dropped skill beside the ones the hierarchy cap already lost', async () => {
    await serviceWith(fixedAdvisor(planWith())).spawn(AUTH, REQUEST);
    expect(graph.manifests[0]?.manifest.droppedSkills).toContain('figma-connector');
  });

  it('hands the advisor every candidate the spawn was about to inject', async () => {
    const advisor = fixedAdvisor(null);
    await serviceWith(advisor).spawn(AUTH, REQUEST);
    expect(advisor.plan).toHaveBeenCalledWith(
      expect.objectContaining({ id: TASK_ID, title: 'fixture task 1' }),
      {
        memories: MEMORIES.map((text, i) => ({ id: `m${i}`, text })),
        skills: SKILLS.map((s, i) => ({ id: `s${i}`, text: s.description, name: s.name })),
      },
    );
  });

  it('injects everything when the advisor throws', async () => {
    const advisor: ContextAdvisorPort = {
      plan: vi.fn(async () => {
        throw new Error('typesafe down');
      }),
    };
    const result = await serviceWith(advisor).spawn(AUTH, REQUEST);

    expect(result.sessionId).toBeTruthy();
    const manifest = graph.manifests[0]?.manifest;
    // A context service being down must never make a persona forget things.
    expect(manifest?.agent.memory).toEqual(MEMORIES);
    expect(manifest?.skills).toHaveLength(2);
    expect(manifest?.launch.contextEngineering).toBeNull();
  });

  it('records what was offered, what survived and what it saved', async () => {
    await serviceWith(fixedAdvisor(planWith())).spawn(AUTH, REQUEST);
    const ce = graph.manifests[0]?.manifest.launch.contextEngineering;
    expect(ce).toMatchObject({ jevModel: 'jev-1.13.0', bytesSaved: 360, pctSaved: 60 });
    // Offered three, carried one — a thinner prompt must never be
    // indistinguishable from a teammate who never had the memory.
    expect(ce?.memories.decisions).toHaveLength(3);
    expect(ce?.memories.keptIds).toEqual(['m0']);
    expect(ce?.jevCostUsd).toBeGreaterThan(0);
  });

  it('says the counts out loud, and warns when the budget beat a critical', async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const plan = planWith();
    const loud: ContextPlan = {
      ...plan,
      activation: {
        ...plan.activation,
        memories: { ...plan.activation.memories, droppedCritical: ['m2'] },
      },
    };
    const service = new SpawnService({
      graph,
      pty,
      baseUrl: 'http://127.0.0.1:4611',
      dataDir,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TM8_AGENT_CMD: ECHO_AGENT_CMD },
      bootSettlementMs: 25,
      logger,
      contextAdvisor: fixedAdvisor(loud),
    });
    await service.spawn(AUTH, REQUEST);

    const line = logger.info.mock.calls.find((c) => String(c[0]).includes('Jev kept'));
    expect(line?.[1]).toMatchObject({ memories: '1/3', skills: '1/2', bytesSaved: 360 });
    // The one outcome this feature exists to prevent gets a warn, not an info.
    const warn = logger.warn.mock.calls.find((c) => String(c[0]).includes('rated critical'));
    expect(warn?.[1]).toMatchObject({ dropped: ['m2'] });
  });
});
