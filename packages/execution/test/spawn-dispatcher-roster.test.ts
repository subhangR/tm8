// I8 (design 01a0d348 §8 I8, headers T6): a dispatcher's `<context_index>`
// teammates group is the space roster, read under RLS through the graph port.
// The read happens only for a dispatcher, and only with the index switch on:
// switched off, no roster is read and the launch is what it always was.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SelectionHeader } from '@tm8/contract';
import { PtyHostService } from '../src/pty/PtyHostService.js';
import { SpawnService } from '../src/spawn/SpawnService.js';
import { DISPATCHER_ROSTER_READ_MAX } from '../src/spawn/context-index.js';
import type { DispatcherRoster, GraphAuth, WorkSessionResumeInfo } from '../src/spawn/types.js';
import { FakeGraph } from './fake-graph.js';

const SPACE_ID = '11111111-1111-4111-8111-111111111111';
const MEMBER_ID = '22222222-2222-4222-8222-222222222222';
const MATE_ID = '33333333-3333-4333-8333-333333333333';
const SESSION_ID = '44444444-4444-4444-8444-444444444444';
const AUTH = { identityId: 'identity-1', actorId: 'actor-1' };

class RosterGraph extends FakeGraph {
  readonly rosterReads: Array<{ spaceId: string; excludeTeamMemberId: string; limit: number }> = [];
  readonly headerReads: string[][] = [];

  async loadDispatcherRoster(
    _auth: GraphAuth,
    input: { spaceId: string; excludeTeamMemberId: string; limit: number },
  ): Promise<DispatcherRoster> {
    this.rosterReads.push(input);
    return { members: [{ entityId: MATE_ID, name: 'Reviewer', mode: 'worker', model: 'claude-opus-5' }], total: 1 };
  }

  async loadContextHeaders(_auth: GraphAuth, input: { spaceId: string; ids: string[] }): Promise<SelectionHeader[]> {
    this.headerReads.push(input.ids);
    return input.ids.filter((id) => id === MATE_ID).map((id) => ({
      entityId: id, kind: 'team_member', name: 'Reviewer', whenToUse: 'pick me for code review', summary: 'Reviews PRs.',
      keywords: [], source: 'authored', stale: false, bytes: 512, loadPointer: `tm8 entity context ${id}`,
    }));
  }
}

describe('SpawnService reads a dispatcher roster only when the index is on', () => {
  let dataDir: string;
  let projectDir: string;
  let pty: PtyHostService;
  let graph: RosterGraph;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'tm8-roster-data-'));
    projectDir = await mkdtemp(join(tmpdir(), 'tm8-roster-proj-'));
    graph = new RosterGraph({ workingDir: projectDir });
    pty = new PtyHostService();
  });

  afterEach(async () => {
    pty.shutdownAll();
    await rm(dataDir, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
  });

  const service = (index?: 'on' | 'off'): SpawnService => new SpawnService({
    graph, pty, baseUrl: 'http://127.0.0.1:4614', dataDir, nodeId: 'test-node',
    env: { ...process.env, TM8_AGENT_CMD: 'echo-agent', TM8_CONTEXT_INDEX: index ?? '' },
  });

  it('on, dispatcher: reads the roster without the dispatcher itself, and its headers ride the one header read', async () => {
    const result = await service('on').spawn(AUTH, { spaceId: SPACE_ID, teamMemberId: MEMBER_ID, mode: 'dispatcher' });
    expect(graph.rosterReads).toEqual([{ spaceId: SPACE_ID, excludeTeamMemberId: MEMBER_ID, limit: DISPATCHER_ROSTER_READ_MAX }]);
    expect(graph.headerReads).toEqual([[MATE_ID]]);
    const group = result.manifest.contextIndex!.groups.find((g) => g.name === 'teammates')!;
    expect(group.entries).toMatchObject([{ id: MATE_ID, via: 'roster', teammate: { mode: 'worker', model: 'claude-opus-5' }, source: 'authored' }]);
  });

  it('on, worker: no roster read', async () => {
    await service('on').spawn(AUTH, { spaceId: SPACE_ID, teamMemberId: MEMBER_ID, mode: 'worker' });
    expect(graph.rosterReads).toEqual([]);
  });

  it('off, dispatcher: no roster read, no header read, no index', async () => {
    const result = await service('off').spawn(AUTH, { spaceId: SPACE_ID, teamMemberId: MEMBER_ID, mode: 'dispatcher' });
    expect(graph.rosterReads).toEqual([]);
    expect(graph.headerReads).toEqual([]);
    expect(result.manifest.contextIndex).toBeUndefined();
  });

  it('a resumed dispatcher that launched with the index reads its roster again', async () => {
    const info: WorkSessionResumeInfo = {
      sessionId: SESSION_ID, spaceId: SPACE_ID, teamMemberId: MEMBER_ID, parentSessionId: null, projectId: null,
      taskIds: [], workdirMode: 'scratch', workdirPath: null, mode: 'dispatcher', model: 'claude-opus-5',
      agentTool: 'claude-code', title: 'dispatcher', status: 'exited', nativeSessionId: 'native', agentConfigDir: null,
    };
    graph.resumeInfo = info;
    graph.resumeReplayed = true;
    graph.postures.set(SESSION_ID, { accessMode: 'fullAccess', permissionMode: 'bypassPermissions', contextIndex: 'env' });
    // The ledger-replay short-circuit is the only hermetic resume (resume
    // refuses under TM8_AGENT_CMD); it composes before any child exists, so
    // this pins the READ, by the mode the resumed launch runs in.
    await new SpawnService({
      graph, pty, baseUrl: 'http://127.0.0.1:4614', dataDir, nodeId: 'test-node', env: { PATH: process.env.PATH ?? '' },
    }).resume(AUTH, { sessionId: SESSION_ID });
    expect(graph.rosterReads).toEqual([{ spaceId: SPACE_ID, excludeTeamMemberId: MEMBER_ID, limit: DISPATCHER_ROSTER_READ_MAX }]);
    expect(graph.headerReads).toEqual([[MATE_ID]]);
  });
});
