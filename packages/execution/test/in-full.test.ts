// Launch card v3, lane B: the in-full channel through spawn's composition
// (dedup, launch record, budget), and resume's replay of effort + in-full ids.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PtyHostService } from '../src/pty/PtyHostService.js';
import { PREVIEW_SESSION_ID, replayedSelection, SpawnService } from '../src/spawn/SpawnService.js';
import { FakeGraph } from './fake-graph.js';
import { BudgetExceededError, BYTE_BUDGETS, composePrompt } from '@tm8/prompt';
import { dedupInFull } from '../src/spawn/in-full.js';
import { composeManifest, ECHO_AGENT_CMD, resolveLaunchConfig } from '../src/spawn/manifest.js';
import type { InFullEntity, SpawnContext, SpawnRequest, TaskContext } from '../src/spawn/types.js';

const HOME = '/home/test';
const MEM = '11111111-1111-4111-8111-111111111111';
const DOC = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const request: SpawnRequest = { spaceId: 'space', teamMemberId: 'persona' };
const member: SpawnContext['teamMember'] = {
  id: 'persona', name: 'Persona', role: '', identity: '', memories: [], model: null, agentTool: 'claude-code',
  mode: 'worker', permissionMode: null, avatar: null, capabilities: {}, commandPermissions: {},
};
const task = (extra: Partial<TaskContext> = {}): TaskContext => ({
  id: 'task-1', version: 1, title: 'Build it', description: 'Do the thing.', priority: 'medium', status: 'open',
  acceptanceCriteria: [], ...extra,
});
const inFullDoc = (body = 'the whole design'): InFullEntity => ({ entityId: DOC, kind: 'doc', title: 'Design', version: 4, body });
const ctx = (extra: Partial<SpawnContext> = {}): SpawnContext => ({
  spaceId: 'space', project: { id: 'project', name: 'repo', workingDir: '/repo', trust: 'trusted' },
  tasks: [task()], teamMember: member, ...extra,
});

function compose(context: SpawnContext, req: SpawnRequest = request, budget: 'throw' | 'record' = 'throw') {
  const manifest = composeManifest({
    sessionId: 'session', request: req, context, launch: resolveLaunchConfig(req, context, {}),
    workdir: { mode: 'project', path: '/repo' }, baseUrl: 'http://localhost', homeDir: HOME,
    agentConfigDir: `${HOME}/.claude`, now: new Date('2026-09-27T00:00:00Z'),
    command: 'claude', contextIndex: { source: 'default' }, budget,
  });
  return { manifest, prompt: composePrompt(manifest, { sessionId: 'session', baseUrl: 'http://localhost', budget }) };
}

describe('dedupInFull: in full wins', () => {
  it('takes an in-full id out of the memories, the selected references and <linked>, and names it', () => {
    const context = ctx({
      teamMember: { ...member, memories: ['keep me', 'in full already', 'legacy'], memoryIds: [OTHER, MEM] },
      contextAudit: { selectedGroups: [], memoryVia: ['teammate', 'task'], dropped: [] },
      references: [{ entityId: DOC, kind: 'doc', title: 'Design', via: 'selection' }],
      tasks: [task({ linked: [{ entityId: DOC, kind: 'doc', link: 'relates_to', title: 'Design' }], linkedTotal: 3 })],
      inFull: [inFullDoc(), { entityId: MEM, kind: 'memory', title: 'in full already', version: 1, body: 'in full already' }],
    });
    const { context: out, duplicates } = dedupInFull(context);
    expect(out.teamMember.memoryIds).toEqual([OTHER]);
    expect(out.teamMember.memories).toEqual(['keep me', 'legacy']);
    expect(out.contextAudit?.memoryVia).toEqual(['teammate']);
    expect(out.references).toEqual([]);
    expect(out.tasks[0]?.linked).toEqual([]);
    expect(out.tasks[0]?.linkedTotal).toBe(2);
    expect(duplicates.map((d) => d.entityId).sort()).toEqual([DOC, MEM].sort());
  });

  it('is the identity when nothing is sent in full', () => {
    const context = ctx();
    expect(dedupInFull(context).context).toBe(context);
  });
});

describe('composeManifest with inFullIds', () => {
  it('renders the entity once, records launch.inFullIds / jevRemovedIds and context.inFull', () => {
    const req: SpawnRequest = { ...request, inFullIds: [DOC], jevRemovedIds: [OTHER] };
    const { manifest, prompt } = compose(ctx({
      tasks: [task({ linked: [{ entityId: DOC, kind: 'doc', link: 'relates_to', title: 'Design' }], linkedTotal: 1 })],
      inFull: [inFullDoc()],
    }), req);
    expect(manifest.launch.inFullIds).toEqual([DOC]);
    expect(manifest.launch.jevRemovedIds).toEqual([OTHER]);
    expect(manifest.context?.inFull).toEqual({ ids: [DOC] });
    expect(prompt.system).toContain(`type="in-full" entity_id="${DOC}"`);
    // Not also an index entry, nor a <linked> line.
    const all = `${prompt.system}\n${prompt.task}`;
    expect(all.split(DOC).length - 1).toBe(1);
  });

  it('records a resume\'s unavailable ids with a warning', () => {
    const { manifest } = compose(ctx({ inFull: [inFullDoc()], inFullUnavailable: [OTHER] }), { ...request, inFullIds: [DOC, OTHER] });
    expect(manifest.context?.inFull).toEqual({
      ids: [DOC], unavailable: [OTHER], warning: expect.stringContaining(OTHER),
    });
  });

  it('refuses subject + in-full past the budget; record mode composes and reports it', () => {
    const big = 'z'.repeat(BYTE_BUDGETS.inFullInjection);
    const context = ctx({ inFull: [inFullDoc(big)] });
    let caught: unknown;
    try { compose(context, { ...request, inFullIds: [DOC] }); } catch (error) { caught = error; }
    expect((caught as BudgetExceededError).material).toBe('inFullInjection');
    const { prompt } = compose(context, { ...request, inFullIds: [DOC] }, 'record');
    expect(prompt.layout?.overBudget?.material).toBe('inFullInjection');
  });
});

describe('resume replay (decisions 1 and 2)', () => {
  it('replays reasoningEffort, inFullIds and jevRemovedIds; never promptExtra', () => {
    const out = replayedSelection({
      accessMode: null, permissionMode: null,
      reasoningEffort: 'high', inFullIds: [DOC], jevRemovedIds: [OTHER],
    } as never);
    expect(out).toEqual({ reasoningEffort: 'high', inFullIds: [DOC], jevRemovedIds: [OTHER] });
    expect(out).not.toHaveProperty('promptExtra');
  });

  it('drops a malformed record alone, and keeps it through an invalid selection', () => {
    expect(replayedSelection({ reasoningEffort: 'turbo', inFullIds: ['not-an-id'] } as never)).toEqual({});
    expect(replayedSelection({ selection: { memoryIds: 'x' }, reasoningEffort: 'low' } as never))
      .toEqual({ invalid: true, reasoningEffort: 'low' });
  });
});

describe('SpawnService.preview (launch.preview): spawn\'s composition, nothing written', () => {
  it('composes on spawn\'s path in record mode and writes no session, pin, token or manifest', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'tm8-preview-data-'));
    const projectDir = await mkdtemp(join(tmpdir(), 'tm8-preview-project-'));
    try {
      const graph = new FakeGraph({ workingDir: projectDir, memories: [] });
      const service = new SpawnService({
        graph, pty: new PtyHostService(), baseUrl: 'http://127.0.0.1:4611', dataDir,
        env: { PATH: process.env.PATH, HOME: process.env.HOME, TM8_AGENT_CMD: ECHO_AGENT_CMD },
      });
      const preview = await service.preview({ identityId: 'i' }, {
        spaceId: '11111111-1111-4111-8111-111111111111',
        teamMemberId: '22222222-2222-4222-8222-222222222222',
        projectId: '33333333-3333-4333-8333-333333333333',
        taskIds: ['44444444-4444-4444-8444-444444444444'],
        promptExtra: 'n'.repeat(BYTE_BUDGETS.combinedInitialInjection),
        inFullIds: [DOC],
      });
      expect(graph.spawnContextInputs[0]).toMatchObject({ inFullIds: [DOC], skipSkillScan: true });
      expect(preview.manifest.sessionId).toBe(PREVIEW_SESSION_ID);
      // Spawn would refuse this launch (notes past the cap); the preview still renders it.
      expect(preview.envelope.layout?.overBudget?.material).toBe('combinedInitialInjection');
      expect(preview.envelope.layout?.notesBytes).toBeGreaterThan(BYTE_BUDGETS.combinedInitialInjection);
      expect(graph.created).toEqual([]);
      expect(graph.manifests).toEqual([]);
      expect(graph.profilePins).toEqual([]);
      expect(graph.issuedAgentTokens).toEqual([]);
      expect(graph.transitions).toEqual([]);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
      await rm(projectDir, { recursive: true, force: true });
    }
  });
});
