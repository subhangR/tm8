// What a persona carries into a spawn: its memories and resolved skills,
// verbatim and in the graph's order.
//
// Spawn-time context engineering (@tm8/jev) is gone (design 01a0cb80 §7.4).
// Nothing between the graph read and the manifest may trim, reorder or rank
// this material, and the manifest records no `contextEngineering` block.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

describe('SpawnService persona context', () => {
  let dataDir: string;
  let projectDir: string;
  let graph: FakeGraph;
  let pty: PtyHostService;

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

  it('injects every memory and skill the graph resolved, in order, with no Jev block', async () => {
    const service = new SpawnService({
      graph,
      pty,
      baseUrl: 'http://127.0.0.1:4611',
      dataDir,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TM8_AGENT_CMD: ECHO_AGENT_CMD },
      bootSettlementMs: 25,
    });
    await service.spawn(AUTH, REQUEST);
    const manifest = graph.manifests[0]?.manifest;
    expect(manifest?.agent.memory).toEqual(MEMORIES);
    expect(manifest?.skills?.map((s) => s.name)).toEqual(['deploy-runbook', 'figma-connector']);
    expect(manifest?.launch).not.toHaveProperty('contextEngineering');
    expect(manifest?.launch).not.toHaveProperty('routing');
  });
});
