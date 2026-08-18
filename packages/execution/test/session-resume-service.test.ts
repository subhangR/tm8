// SpawnService.resume — the ORCHESTRATION, not the pure helpers.
//
// session-resume.test.ts covers the command builder and the rollout parser.
// Neither of those could have caught the defects this file exists for: the
// resume path shipped with no service-level test at all, and three separate
// bugs lived in the gap between "the helpers are right" and "resume calls them
// correctly".
//
// Every test here stops BEFORE a PTY is spawned. That is deliberate, not a
// limitation: resume refuses under TM8_AGENT_CMD (it cannot know an operator
// wrapper's resume flags), so a hermetic echo-agent harness is impossible by
// construction. The two paths that reach the RPC use the ledger-replay
// short-circuit, which returns with `reused: true` before any child exists —
// which is exactly where the node-id assertion belongs anyway.

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PtyHostService } from '../src/pty/PtyHostService.js';
import { SpawnService } from '../src/spawn/SpawnService.js';
import { resolveAgentBinary } from '../src/spawn/manifest.js';
import { SpawnError, type WorkSessionResumeInfo } from '../src/spawn/types.js';
import { FakeGraph } from './fake-graph.js';

// The one test below drives resume PAST its binary preflight (assertAgentRuntime)
// to reach the PTY-reuse race. That preflight legitimately fails closed when the
// real `claude` CLI is absent — as it is on CI — so the scenario is only
// reachable where the binary exists. Gate it on binary presence, the same way
// credential-injection-live.test.ts gates its real-CLI probes, so CI skips it
// cleanly instead of surfacing 'agent CLI claude was not found' as a failure.
const CLAUDE_BINARY = resolveAgentBinary('claude', process.env.PATH ?? '');

const SESSION_ID = '44444444-4444-4444-8444-444444444444';
const SPACE_ID = '11111111-1111-4111-8111-111111111111';
const MEMBER_ID = '22222222-2222-4222-8222-222222222222';
const AUTH = { identityId: 'identity-1', actorId: 'actor-1' };
const NODE_ID = 'node-resuming';

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

// --- codex rollout fixture helpers (same shapes as session-resume.test.ts) ---
const marker = (id: string): string => `<tm8_session_id>${id}</tm8_session_id>`;
const meta = (id: string, cwd: string, timestamp: string): string =>
  JSON.stringify({ type: 'session_meta', payload: { id, cwd, timestamp } });
const userTurn = (text: string): string =>
  JSON.stringify({
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
  });

describe('SpawnService.resume — guards and orchestration', () => {
  let dataDir: string;
  let projectDir: string;
  let pty: PtyHostService;
  let graph: FakeGraph;

  /** A service with no TM8_AGENT_CMD, so resume reaches its real logic. */
  function serviceWith(env: NodeJS.ProcessEnv = {}): SpawnService {
    return new SpawnService({
      graph,
      pty,
      baseUrl: 'http://127.0.0.1:4614',
      dataDir,
      nodeId: NODE_ID,
      env: { PATH: process.env.PATH ?? '', ...env },
    });
  }

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'tm8-resume-data-'));
    projectDir = await mkdtemp(join(tmpdir(), 'tm8-resume-proj-'));
    graph = new FakeGraph({ workingDir: projectDir, withProject: false });
    pty = new PtyHostService();
    graph.resumeInfo = { ...RESUME_INFO };
  });

  afterEach(async () => {
    pty.shutdownAll();
    await rm(dataDir, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
  });

  async function expectRefusal(
    promise: Promise<unknown>,
    code: SpawnError['code'],
  ): Promise<SpawnError> {
    const error = await promise.then(
      () => null,
      (e: unknown) => e,
    );
    expect(error, 'expected resume to refuse, but it resolved').toBeInstanceOf(SpawnError);
    expect((error as SpawnError).code).toBe(code);
    return error as SpawnError;
  }

  it('refuses a session that is not in a terminal status', async () => {
    graph.resumeInfo = { ...RESUME_INFO, status: 'running' };
    const error = await expectRefusal(
      serviceWith().resume(AUTH, { sessionId: SESSION_ID }),
      'conflict',
    );
    expect(error.message).toContain("is 'running'");
    // Nothing was written: a refused resume must not touch the row.
    expect(graph.resumes).toHaveLength(0);
  });

  it('refuses a session whose Teammate edge is gone', async () => {
    graph.resumeInfo = { ...RESUME_INFO, teamMemberId: null };
    await expectRefusal(
      serviceWith().resume(AUTH, { sessionId: SESSION_ID }),
      'invalid_input',
    );
    expect(graph.resumes).toHaveLength(0);
  });

  it('refuses under a TM8_AGENT_CMD operator wrapper', async () => {
    await expectRefusal(
      serviceWith({ TM8_AGENT_CMD: 'echo-agent' }).resume(AUTH, { sessionId: SESSION_ID }),
      'not_implemented',
    );
    expect(graph.resumes).toHaveLength(0);
  });

  it('refuses a Claude session with no pre-minted native id, rather than starting a fresh conversation', async () => {
    graph.resumeInfo = { ...RESUME_INFO, nativeSessionId: null };
    const error = await expectRefusal(
      serviceWith().resume(AUTH, { sessionId: SESSION_ID }),
      'conflict',
    );
    expect(error.message).toContain('no recorded native session id');
    // The critical half: it refused BEFORE mutating status. A resume that
    // flipped the row to `spawning` and then failed would strand the session.
    expect(graph.resumes).toHaveLength(0);
  });

  // --- defect C: node ownership moves with the resume -----------------------

  it('hands the RESUMING node id to the RPC, so the row follows the PTY', async () => {
    // The ledger-replay short-circuit returns before any child is spawned,
    // which is all this assertion needs.
    graph.resumeReplayed = true;
    const result = await serviceWith().resume(AUTH, {
      sessionId: SESSION_ID,
      clientMutationId: 'cmid-1',
    });

    expect(result.reused).toBe(true);
    expect(graph.resumes).toEqual([
      { sessionId: SESSION_ID, clientMutationId: 'cmid-1', nodeId: NODE_ID },
    ]);
  });

  it('restores the parent coordinator as the durable return route', async () => {
    const coordinatorSessionId = '55555555-5555-4555-8555-555555555555';
    graph.resumeInfo = {
      ...RESUME_INFO,
      mode: 'coordinated-worker',
      parentSessionId: coordinatorSessionId,
    };
    graph.resumeReplayed = true;

    const result = await serviceWith().resume(AUTH, { sessionId: SESSION_ID });

    expect(result.manifest.coordinator).toEqual({ sessionId: coordinatorSessionId });
  });

  it('does not boot a second child on a ledger replay', async () => {
    graph.resumeReplayed = true;
    await serviceWith().resume(AUTH, { sessionId: SESSION_ID, clientMutationId: 'cmid-1' });
    expect(pty.hasSession(SESSION_ID)).toBe(false);
    // A replay is a transport retry — the status must not be re-driven.
    expect(graph.statusesFor(SESSION_ID)).toHaveLength(0);
  });

  it.runIf(CLAUDE_BINARY !== null)('does not kill a live PTY reused after the optimistic resume guard', async () => {
    // Reproduce the race instead of returning a decorative `reused` flag from
    // a fake: the host owns a REAL, live PTY. The initial guard observes the
    // pre-race state, then the real spawnIfAbsent discovers and reuses it.
    pty.spawn({
      sessionId: SESSION_ID,
      command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify('setInterval(() => {}, 1_000)')}`,
      cwd: projectDir,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: dataDir,
        SHELL: '/bin/sh',
      },
    });
    expect(pty.hasSession(SESSION_ID)).toBe(true);

    vi.spyOn(pty, 'hasSession').mockReturnValueOnce(false);
    const kill = vi.spyOn(pty, 'kill');
    vi.spyOn(graph, 'transition').mockRejectedValueOnce(
      new Error('injected graph failure after PTY reuse'),
    );

    await expect(
      serviceWith({ HOME: dataDir }).resume(AUTH, { sessionId: SESSION_ID }),
    ).rejects.toThrow('injected graph failure after PTY reuse');

    expect(kill).not.toHaveBeenCalled();
    expect(pty.hasSession(SESSION_ID)).toBe(true);
    expect(graph.statusesFor(SESSION_ID)).toEqual(['failed']);
  });

  // --- defect D: a write-once collision is fatal, not silent ----------------

  describe('codex native-id capture', () => {
    let home: string;

    beforeEach(async () => {
      home = await mkdtemp(join(tmpdir(), 'tm8-resume-home-'));
      graph.resumeInfo = { ...RESUME_INFO, agentTool: 'codex', nativeSessionId: null };
    });

    afterEach(async () => {
      await rm(home, { recursive: true, force: true });
    });

    async function writeOwningRollout(configDir = join(home, '.codex')): Promise<void> {
      const day = join(configDir, 'sessions', '2026', '07', '31');
      await mkdir(day, { recursive: true });
      await writeFile(
        join(day, 'own.jsonl'),
        [
          meta('rollout-scanned', projectDir, '2026-07-31T09:00:00Z'),
          userTurn(`task…\n${marker(SESSION_ID)}`),
        ].join('\n'),
      );
    }

    it('refuses when the scanned id contradicts one already recorded', async () => {
      await writeOwningRollout();
      // Write-once refuses: the row already names a DIFFERENT conversation.
      graph.nativeIdWriteAccepted = false;
      graph.resumeReplayed = true; // would otherwise proceed toward a PTY

      const error = await expectRefusal(
        serviceWith({ HOME: home }).resume(AUTH, { sessionId: SESSION_ID }),
        'conflict',
      );
      expect(error.message).toContain('already has a different native session id');
      // The whole point: it stopped, rather than resuming an ambiguous
      // conversation on an id the graph does not agree is ours.
      expect(graph.resumes).toHaveLength(0);
    });

    it('records a newly scanned id and proceeds when write-once accepts it', async () => {
      await writeOwningRollout();
      graph.resumeReplayed = true;

      const result = await serviceWith({ HOME: home }).resume(AUTH, {
        sessionId: SESSION_ID,
        clientMutationId: 'cmid-codex',
      });

      expect(graph.nativeIds).toEqual([
        { sessionId: SESSION_ID, nativeSessionId: 'rollout-scanned' },
      ]);
      expect(result.reused).toBe(true);
      expect(graph.resumes[0]?.nodeId).toBe(NODE_ID);
    });

    it('resolves the rollout from the CODEX_HOME recorded for the original run', async () => {
      const originalConfigDir = join(home, 'credentials', 'id_member', 'openai');
      graph.resumeInfo = {
        ...graph.resumeInfo!,
        agentConfigDir: originalConfigDir,
      };
      await writeOwningRollout(originalConfigDir);
      graph.resumeReplayed = true;

      await serviceWith({ HOME: home }).resume(AUTH, { sessionId: SESSION_ID });
      expect(graph.nativeIds).toEqual([
        { sessionId: SESSION_ID, nativeSessionId: 'rollout-scanned' },
      ]);
    });

    it('refuses when no rollout can be proven to belong to this session', async () => {
      // An empty ~/.codex/sessions: fail closed, never `--last`.
      await mkdir(join(home, '.codex', 'sessions'), { recursive: true });
      const error = await expectRefusal(
        serviceWith({ HOME: home }).resume(AUTH, { sessionId: SESSION_ID }),
        'conflict',
      );
      expect(error.message).toContain('refusing to resume a different or fresh conversation');
      expect(graph.nativeIds).toHaveLength(0);
      expect(graph.resumes).toHaveLength(0);
    });
  });
});
