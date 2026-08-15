// A child session inherits its spawner's permission posture.
//
// WHAT WENT WRONG WITHOUT IT. A coordinator launched with `fullAccess` spawns a
// worker. The worker names no posture — the CLI had no flag for one — so the
// chain fell through to the persona default and the child booted on `auto`. It
// then stopped at its first escalation and waited for an approval that nobody
// would ever give: its parent is an agent, not a human at a terminal. From the
// outside that is indistinguishable from a slow agent, which is why it went
// unnoticed for as long as it did.
//
// The assertions here are on the COMPOSED MANIFEST rather than on the string
// `--dangerously-skip-permissions`, because these spawns run under the hermetic
// echo-agent wrapper and an operator wrapper deliberately gets no posture flags
// (tm8 must not guess flags into a command it does not own). The manifest is
// what the agent reads and what the graph records; the manifest → argv half of
// the story is `buildAgentCommand`'s, and spawn-manifest.test.ts holds it.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PtyHostService } from '../src/pty/PtyHostService.js';
import { SpawnService } from '../src/spawn/SpawnService.js';
import type { WorkSessionResumeInfo } from '../src/spawn/types.js';
import { FakeGraph } from './fake-graph.js';

const SPACE_ID = '11111111-1111-4111-8111-111111111111';
const MEMBER_ID = '22222222-2222-4222-8222-222222222222';
const PARENT_ID = '55555555-5555-4555-8555-555555555555';
const AUTH = { identityId: 'identity-1', actorId: 'actor-1' };

const BYPASS = { accessMode: 'fullAccess' as const, permissionMode: 'bypassPermissions' as const };

describe('a spawned session inherits its spawner posture', () => {
  let dataDir: string;
  let projectDir: string;
  let pty: PtyHostService;
  let graph: FakeGraph;
  let service: SpawnService;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'tm8-posture-data-'));
    projectDir = await mkdtemp(join(tmpdir(), 'tm8-posture-proj-'));
    // The persona says `interactive` throughout: every inherited result below
    // is therefore a fact the parent supplied, not one the persona could have.
    graph = new FakeGraph({ workingDir: projectDir, permissionMode: 'interactive' });
    pty = new PtyHostService();
    service = new SpawnService({
      graph,
      pty,
      baseUrl: 'http://127.0.0.1:4614',
      dataDir,
      nodeId: 'test-node',
      env: { ...process.env, TM8_AGENT_CMD: 'echo-agent' },
    });
  });

  afterEach(async () => {
    pty.shutdownAll();
    await rm(dataDir, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
  });

  it('boots the child on the parent posture, not the persona default', async () => {
    graph.postures.set(PARENT_ID, BYPASS);

    const result = await service.spawn(AUTH, {
      spaceId: SPACE_ID,
      teamMemberId: MEMBER_ID,
      parentSessionId: PARENT_ID,
    });

    expect(graph.postureQueries).toEqual([PARENT_ID]);
    expect(result.manifest.launch).toMatchObject({
      permissionMode: 'bypassPermissions',
      accessMode: 'fullAccess',
    });
  });

  it('asks nothing at all for a root spawn', async () => {
    const result = await service.spawn(AUTH, { spaceId: SPACE_ID, teamMemberId: MEMBER_ID });

    // A human-launched root has no parent to inherit from, so the read is not
    // made — an absent parent must not cost a query.
    expect(graph.postureQueries).toEqual([]);
    expect(result.manifest.launch.permissionMode).toBe('interactive');
  });

  it('asks nothing when the child named its own posture', async () => {
    graph.postures.set(PARENT_ID, BYPASS);

    const result = await service.spawn(AUTH, {
      spaceId: SPACE_ID,
      teamMemberId: MEMBER_ID,
      parentSessionId: PARENT_ID,
      accessMode: 'plan',
    });

    expect(graph.postureQueries).toEqual([]);
    expect(result.manifest.launch).toMatchObject({
      permissionMode: 'readOnly',
      accessMode: 'plan',
    });
  });

  it('still launches when the parent posture cannot be read', async () => {
    // Inheritance selects a DEFAULT. Failing a launch over it would trade a
    // child that stalls for no child at all, which is strictly worse.
    graph.postureError = new Error('parent manifest unreadable');

    const result = await service.spawn(AUTH, {
      spaceId: SPACE_ID,
      teamMemberId: MEMBER_ID,
      parentSessionId: PARENT_ID,
    });

    expect(result.manifest.launch.permissionMode).toBe('interactive');
  });
});

describe('a resumed session keeps the posture it was launched with', () => {
  let dataDir: string;
  let projectDir: string;
  let pty: PtyHostService;
  let graph: FakeGraph;

  const SESSION_ID = '44444444-4444-4444-8444-444444444444';
  const RESUME_INFO: WorkSessionResumeInfo = {
    sessionId: SESSION_ID,
    spaceId: SPACE_ID,
    teamMemberId: MEMBER_ID,
    parentSessionId: null,
    projectId: null,
    taskIds: [],
    workdirMode: 'scratch',
    workdirPath: null,
    mode: 'worker',
    model: 'claude-opus-5',
    agentTool: 'claude-code',
    title: 'a session that stopped',
    status: 'exited',
    nativeSessionId: 'pre-minted-claude-uuid',
    agentConfigDir: null,
  };

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'tm8-posture-resume-'));
    projectDir = await mkdtemp(join(tmpdir(), 'tm8-posture-resume-proj-'));
    graph = new FakeGraph({ workingDir: projectDir, withProject: false, permissionMode: 'interactive' });
    pty = new PtyHostService();
    graph.resumeInfo = { ...RESUME_INFO };
    // The ledger-replay short-circuit returns a fully composed manifest before
    // any child exists, which is where this assertion belongs: resume refuses
    // under TM8_AGENT_CMD, so a hermetic PTY harness is impossible here.
    graph.resumeReplayed = true;
  });

  afterEach(async () => {
    pty.shutdownAll();
    await rm(dataDir, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
  });

  function service(): SpawnService {
    return new SpawnService({
      graph,
      pty,
      baseUrl: 'http://127.0.0.1:4614',
      dataDir,
      nodeId: 'node-resuming',
      env: { PATH: process.env.PATH ?? '' },
    });
  }

  it('reads its recorded posture back instead of re-deriving a weaker one', async () => {
    // `work_sessions` carries model/mode/agent_tool and no permission column,
    // so before this the row alone re-resolved to the persona default: a
    // session launched fullAccess came back interactive and stalled.
    graph.postures.set(SESSION_ID, BYPASS);

    const result = await service().resume(AUTH, { sessionId: SESSION_ID });

    expect(graph.postureQueries).toEqual([SESSION_ID]);
    expect(result.manifest.launch).toMatchObject({
      permissionMode: 'bypassPermissions',
      accessMode: 'fullAccess',
    });
  });

  it('falls back to the ordinary chain when nothing was recorded', async () => {
    const result = await service().resume(AUTH, { sessionId: SESSION_ID });
    expect(result.manifest.launch.permissionMode).toBe('interactive');
  });
});
