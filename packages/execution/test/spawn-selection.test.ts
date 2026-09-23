// Exact selection at spawn, as execution sees it (design 01a0cb80 §5.2, §7.4).
//
// Execution never interprets Jev. It forwards `selection` to the graph loader,
// which resolves the exact sets, and it copies `jevRunId` onto the manifest.
// The audit it writes records what the selection left out (`not-selected`)
// and, afterwards, what the #646 byte budget dropped (`byte-budget`). Without
// either field, nothing it produces changes by a single byte.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PtyHostService } from '../src/pty/PtyHostService.js';
import { composeManifest, ECHO_AGENT_CMD, resolveLaunchConfig } from '../src/spawn/manifest.js';
import { SpawnService } from '../src/spawn/SpawnService.js';
import type { ResolvedSkillRow } from '../src/spawn/skills.js';
import type { SpawnContext, SpawnRequest } from '../src/spawn/types.js';
import { FakeGraph } from './fake-graph.js';

const RUN_ID = '99999999-9999-4999-8999-999999999999';
const SELECTION = {
  memoryIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
  skillIds: ['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'],
};

const context: SpawnContext = {
  spaceId: 'space', project: { id: 'project', name: 'repo', workingDir: '/repo', trust: 'trusted' }, tasks: [],
  teamMember: { id: 'persona', name: 'Persona', role: '', identity: '', memories: ['selected memory'], model: null, agentTool: null, mode: 'worker', permissionMode: null, avatar: null, capabilities: {}, commandPermissions: {} },
};

function compose(request: SpawnRequest, ctx: SpawnContext = context) {
  return composeManifest({
    sessionId: 'session', request, context: ctx, launch: resolveLaunchConfig(request, ctx, {}),
    workdir: { mode: 'project', path: '/repo' }, command: 'test', baseUrl: 'http://localhost', now: new Date('2026-09-23T00:00:00Z'),
  });
}

describe('manifest', () => {
  const base: SpawnRequest = { spaceId: 'space', teamMemberId: 'persona' };

  it('writes launch.jevRunId untouched — and nothing else changes', () => {
    const withRun = compose({ ...base, jevRunId: RUN_ID });
    expect(withRun.launch.jevRunId).toBe(RUN_ID);
    const { jevRunId: _dropped, ...launch } = withRun.launch;
    expect(JSON.stringify({ ...withRun, launch })).toBe(JSON.stringify(compose(base)));
  });

  it('absent jevRunId is ABSENT, not null — the baseline launch block is byte-identical', () => {
    const manifest = compose(base);
    expect('jevRunId' in manifest.launch).toBe(false);
    expect(JSON.stringify(compose({ ...base, selection: SELECTION }))).toBe(JSON.stringify(manifest));
  });

  it('audits the equipped skills a selection left out as not-selected; the byte budget still applies after', () => {
    const selected: ResolvedSkillRow[] = Array.from({ length: 400 }, (_, i) => ({
      entityId: `s${i}`, name: `selected-${i}`, depth: 0, description: `does thing ${i} `.repeat(8),
    }));
    const manifest = compose(base, {
      ...context,
      skillEquips: selected,
      skippedSkills: [{ entityId: 'left-out', name: 'equipped-but-unticked', reason: 'not-selected' }],
    });
    const reasons = manifest.effectiveSkills!.skipped.map((s) => [s.entityId, s.reason]);
    expect(reasons).toContainEqual(['left-out', 'not-selected']);
    expect(manifest.skills.map((s) => s.entityId)).not.toContain('left-out');
    // 400 selected entries overflow the 32 KiB index; the tail is budgeted out, and says so.
    const budgeted = manifest.effectiveSkills!.skipped.filter((s) => s.reason === 'byte-budget');
    expect(budgeted.length).toBeGreaterThan(0);
    expect(manifest.skills.length + budgeted.length).toBe(400);
    // Selection order is preserved: the budget drops from the END.
    expect(manifest.skills[0]?.entityId).toBe('s0');
  });
});

describe('SpawnService', () => {
  let dataDir: string;
  let projectDir: string;
  let graph: FakeGraph;
  let pty: PtyHostService;
  const REQUEST = {
    clientMutationId: 'mutation-1',
    spaceId: '11111111-1111-4111-8111-111111111111',
    teamMemberId: '22222222-2222-4222-8222-222222222222',
    projectId: '33333333-3333-4333-8333-333333333333',
    taskIds: ['44444444-4444-4444-8444-444444444444'],
  };

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'tm8-sel-data-'));
    projectDir = await mkdtemp(join(tmpdir(), 'tm8-sel-project-'));
    graph = new FakeGraph({ workingDir: projectDir, memories: ['m'] });
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

  const service = () => new SpawnService({
    graph, pty, baseUrl: 'http://127.0.0.1:4611', dataDir,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, TM8_AGENT_CMD: ECHO_AGENT_CMD },
    bootSettlementMs: 25,
  });

  it('hands selection to the graph loader, which resolves the exact sets', async () => {
    await service().spawn({ identityId: 'i' }, { ...REQUEST, selection: SELECTION, jevRunId: RUN_ID });
    expect(graph.spawnContextInputs[0]?.selection).toEqual(SELECTION);
    expect(graph.manifests[0]?.manifest.launch.jevRunId).toBe(RUN_ID);
  });

  it('without selection the loader input carries no selection key at all', async () => {
    await service().spawn({ identityId: 'i' }, REQUEST);
    expect(Object.keys(graph.spawnContextInputs[0] ?? {}).sort()).toEqual(
      ['parentSessionId', 'projectId', 'spaceId', 'taskIds', 'teamMemberId'],
    );
    expect('jevRunId' in (graph.manifests[0]?.manifest.launch ?? {})).toBe(false);
  });
});
