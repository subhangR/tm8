// D1/D6a — resume preserves the workdir it was GIVEN, and a finished session
// gives its checkout back.
//
// WHY THIS FILE ASSERTS ON A REAL PTY'S `pwd` AND NOT ON THE MANIFEST.
// The defect being closed here is precisely that the manifest was RIGHT while
// the cwd was WRONG: resume computed `context.project.workingDir`
// unconditionally, then emitted `workdir: { mode: 'worktree', path: cwd }` —
// so a resumed worktree session was told it was in its own lane, ran in the
// shared checkout, and its recorded `checkoutBranch` still looked correct
// because the branch probe read `info.workdirPath` rather than the cwd. There
// was no surface on which it was visible, and a manifest assertion would have
// passed against the broken code. So the first test here launches a REAL
// child through the PTY host and reads the directory that process actually
// landed in.
//
// The sibling file session-resume-service.test.ts says a hermetic agent is
// impossible on this path because resume refuses under TM8_AGENT_CMD. That is
// true of TM8_AGENT_CMD and only of it — `assertAgentRuntime` resolves the
// agent binary off `env.PATH`, so a shim named `claude` on a temp PATH gets a
// real spawn with none of the wrapper machinery. That is the harness below.

import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PtyHostService } from '../src/pty/PtyHostService.js';
import { SpawnService } from '../src/spawn/SpawnService.js';
import {
  SpawnError,
  type WorkSessionResumeInfo,
  type WorktreeAllocationRow,
} from '../src/spawn/types.js';
import { FakeGraph } from './fake-graph.js';

const SESSION_ID = '44444444-4444-4444-8444-444444444444';
const OTHER_SESSION_ID = '66666666-6666-4666-8666-666666666666';
const SPACE_ID = '11111111-1111-4111-8111-111111111111';
const MEMBER_ID = '22222222-2222-4222-8222-222222222222';
const WORKTREE_ID = '77777777-7777-4777-8777-777777777777';
const AUTH = { identityId: 'identity-1', actorId: 'actor-1' };
const NODE_ID = 'node-resuming';

function allocation(overrides: Partial<WorktreeAllocationRow> = {}): WorktreeAllocationRow {
  return {
    worktreeId: WORKTREE_ID,
    projectId: null,
    state: 'ready',
    path: null,
    branch: 'tm8/lane-1',
    leaseSessionId: null,
    attempts: 0,
    failureCode: null,
    entityExists: true,
    worktreeStatus: 'active',
    leaseSessionStatus: 'exited',
    updatedAt: null,
    ...overrides,
  };
}

describe('resume preserves the worktree it was given (D1) and releases it on exit (D6a)', () => {
  let dataDir: string;
  /** The SHARED checkout — the wrong answer, and the one the bug produced. */
  let projectDir: string;
  /** The session's own lane — the right answer. */
  let worktreeDir: string;
  let binDir: string;
  let pty: PtyHostService;
  let graph: FakeGraph;
  let logs: string[];

  const resumeInfo = (): WorkSessionResumeInfo => ({
    sessionId: SESSION_ID,
    spaceId: SPACE_ID,
    teamMemberId: MEMBER_ID,
    parentSessionId: null,
    projectId: null,
    taskIds: [],
    workdirMode: 'worktree',
    workdirPath: worktreeDir,
    mode: 'worker',
    model: 'claude-opus-5',
    agentTool: 'claude-code',
    title: 'a lane that stopped',
    status: 'exited',
    nativeSessionId: 'pre-minted-claude-uuid',
    agentConfigDir: null,
  });

  function serviceWith(env: NodeJS.ProcessEnv = {}): SpawnService {
    const capture = (message: string): void => {
      logs.push(message);
    };
    return new SpawnService({
      graph,
      pty,
      baseUrl: 'http://127.0.0.1:4614',
      dataDir,
      nodeId: NODE_ID,
      env: {
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        HOME: join(dataDir, 'node-home'),
        SHELL: '/bin/sh',
        ...env,
      },
      bootSettlementMs: 5,
      logger: { info: capture, warn: capture, error: capture },
    });
  }

  beforeEach(async () => {
    // realpath: macOS hands out /var/folders/... symlinks for tmpdir, and the
    // child reports its cwd already resolved — comparing the two raw strings
    // fails for a reason that has nothing to do with this feature.
    dataDir = await realpath(await mkdtemp(join(tmpdir(), 'tm8-wt-resume-data-')));
    projectDir = await realpath(await mkdtemp(join(tmpdir(), 'tm8-wt-resume-shared-')));
    worktreeDir = await realpath(await mkdtemp(join(tmpdir(), 'tm8-wt-resume-lane-')));
    binDir = await realpath(await mkdtemp(join(tmpdir(), 'tm8-wt-resume-bin-')));
    graph = new FakeGraph({ workingDir: projectDir });
    graph.resumeInfo = resumeInfo();
    graph.nodeWorktreeAllocations = [allocation({ path: worktreeDir })];
    pty = new PtyHostService();
    logs = [];
    await mkdir(join(dataDir, 'node-home'), { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    pty.shutdownAll();
    await Promise.all(
      [dataDir, projectDir, worktreeDir, binDir].map((d) =>
        rm(d, { recursive: true, force: true }),
      ),
    );
  });

  /**
   * A `claude` shim that records the directory it was actually started in and
   * then stays alive past the boot-settlement window (an immediate exit inside
   * that window is a spawn failure, by design).
   */
  async function installPwdRecordingAgent(): Promise<string> {
    const witness = join(binDir, 'observed-cwd');
    await writeFile(
      join(binDir, 'claude'),
      `#!/bin/sh\npwd > ${JSON.stringify(witness)}\nexec sleep 30\n`,
      'utf8',
    );
    await chmod(join(binDir, 'claude'), 0o755);
    return witness;
  }

  /**
   * The child is a real process: `resume` returns when the boot-settlement
   * window closes, which is not the same instant the shell inside the PTY has
   * finished its first redirect. Poll for the observation rather than sleeping
   * a guessed amount.
   */
  async function observedCwd(witness: string): Promise<string> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      try {
        const seen = (await readFile(witness, 'utf8')).trim();
        if (seen !== '') return seen;
      } catch {
        // not written yet
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`the resumed child never reported a cwd into ${witness}`);
  }

  // --- D1: the actual process cwd -------------------------------------------

  it('lands the RESUMED child in its own worktree, not the shared checkout', async () => {
    const witness = await installPwdRecordingAgent();

    const result = await serviceWith().resume(AUTH, { sessionId: SESSION_ID });

    // THE assertion: what the operating system says about the child process,
    // read out of the child itself. Not the manifest — the manifest is the
    // thing that lied.
    const seen = await observedCwd(witness);
    expect(seen).toBe(worktreeDir);
    expect(seen).not.toBe(projectDir);
    // …and the manifest, which was already telling this story, now tells the
    // truth rather than merely telling it. `workingDirectory` was the field
    // pointing at the shared checkout while `workdirMode` said 'worktree'.
    expect(result.manifest.session.workdirMode).toBe('worktree');
    expect(result.manifest.session.workingDirectory).toBe(worktreeDir);
    expect(result.manifest.project?.workingDir).toBe(projectDir);
    expect(result.cwd).toBe(worktreeDir);
  });

  it('still sends a PROJECT session to the shared checkout', async () => {
    // The fix must not have inverted the ordinary case.
    const witness = await installPwdRecordingAgent();
    graph.resumeInfo = { ...resumeInfo(), workdirMode: 'project', workdirPath: projectDir };
    graph.nodeWorktreeAllocations = [];

    await serviceWith().resume(AUTH, { sessionId: SESSION_ID });

    expect(await observedCwd(witness)).toBe(projectDir);
  });

  // --- D1 guard 1: a reclaimed checkout refuses, it does not fall back -------

  it('refuses — by name — when the worktree directory is gone', async () => {
    await installPwdRecordingAgent();
    await rm(worktreeDir, { recursive: true, force: true });

    const error = (await serviceWith()
      .resume(AUTH, { sessionId: SESSION_ID })
      .then(
        () => null,
        (e: unknown) => e,
      )) as SpawnError | null;

    expect(error, 'a resume into a reclaimed worktree must refuse').toBeInstanceOf(SpawnError);
    expect(error!.code).toBe('not_found');
    expect(error!.message).toContain(worktreeDir);
    expect(error!.message).toContain('no longer a directory');
    // The half that matters most: it did NOT quietly become a shared-checkout
    // session. Nothing was spawned and the row was never touched.
    expect(pty.hasSession(SESSION_ID)).toBe(false);
    expect(graph.resumes).toHaveLength(0);
  });

  it('refuses a worktree row that carries no path rather than inventing one', async () => {
    graph.resumeInfo = { ...resumeInfo(), workdirPath: null };

    const error = (await serviceWith()
      .resume(AUTH, { sessionId: SESSION_ID })
      .then(
        () => null,
        (e: unknown) => e,
      )) as SpawnError | null;

    expect(error).toBeInstanceOf(SpawnError);
    expect(error!.code).toBe('conflict');
    expect(graph.resumes).toHaveLength(0);
  });

  // --- D1 guard 2: the lease ------------------------------------------------

  it('re-acquires the lease for the resuming session', async () => {
    await installPwdRecordingAgent();

    await serviceWith().resume(AUTH, { sessionId: SESSION_ID });

    expect(graph.worktreeCalls.filter((c) => c.call === 'lease')).toEqual([
      { call: 'lease', worktreeId: WORKTREE_ID, detail: SESSION_ID },
    ]);
  });

  it('succeeds when the session already holds the lease on its own worktree', async () => {
    // `acquire_worktree_lease` (081:282-284) refuses only when the holder is
    // some OTHER session. A resume that treated "I already own this" as
    // contention would be a new bug, so it is pinned here.
    await installPwdRecordingAgent();
    graph.nodeWorktreeAllocations = [
      allocation({ path: worktreeDir, leaseSessionId: SESSION_ID }),
    ];

    const result = await serviceWith().resume(AUTH, { sessionId: SESSION_ID });

    expect(result.cwd).toBe(worktreeDir);
    expect(graph.worktreeCalls.filter((c) => c.call === 'lease')).toHaveLength(1);
  });

  it('resumes anyway, loudly, when no allocation on this node matches the path', async () => {
    await installPwdRecordingAgent();
    graph.nodeWorktreeAllocations = [allocation({ path: '/somewhere/else' })];

    const result = await serviceWith().resume(AUTH, { sessionId: SESSION_ID });

    expect(result.cwd).toBe(worktreeDir);
    expect(graph.worktreeCalls.filter((c) => c.call === 'lease')).toHaveLength(0);
    expect(logs.join('\n')).toContain('no allocation on this node');
  });

  // --- D6a: the empty finally ----------------------------------------------

  describe('handlePtyExit releases the lease', () => {
    it('hands a normally-exited session\'s worktree back without a node restart', async () => {
      await installPwdRecordingAgent();
      const service = serviceWith();
      await service.resume(AUTH, { sessionId: SESSION_ID });
      // The lease the resume just took is the one that must come back.
      graph.nodeWorktreeAllocations = [
        allocation({ path: worktreeDir, leaseSessionId: SESSION_ID }),
      ];

      await service.handlePtyExit(SESSION_ID, 'completed', { exitCode: 0, signal: null });

      expect(graph.worktreeCalls.filter((c) => c.call === 'unlease')).toEqual([
        { call: 'unlease', worktreeId: WORKTREE_ID },
      ]);
      expect(graph.statusesFor(SESSION_ID)).toContain('exited');
    });

    it('releases even when the exit transition itself failed', async () => {
      await installPwdRecordingAgent();
      const service = serviceWith();
      await service.resume(AUTH, { sessionId: SESSION_ID });
      graph.nodeWorktreeAllocations = [
        allocation({ path: worktreeDir, leaseSessionId: SESSION_ID }),
      ];
      vi.spyOn(graph, 'transition').mockRejectedValueOnce(new Error('injected transition failure'));

      await service.handlePtyExit(SESSION_ID, 'completed', { exitCode: 0, signal: null });

      // A dead agent is a dead agent whether or not the row could be written.
      expect(graph.worktreeCalls.filter((c) => c.call === 'unlease')).toHaveLength(1);
    });

    it('does not release a lease held by a DIFFERENT session', async () => {
      await installPwdRecordingAgent();
      const service = serviceWith();
      await service.resume(AUTH, { sessionId: SESSION_ID });
      graph.nodeWorktreeAllocations = [
        allocation({ path: worktreeDir, leaseSessionId: OTHER_SESSION_ID }),
      ];

      await service.handlePtyExit(SESSION_ID, 'completed', { exitCode: 0, signal: null });

      expect(graph.worktreeCalls.filter((c) => c.call === 'unlease')).toHaveLength(0);
    });

    it('is loud but non-fatal when the release fails, and does not undo the transition', async () => {
      await installPwdRecordingAgent();
      const service = serviceWith();
      await service.resume(AUTH, { sessionId: SESSION_ID });
      graph.nodeWorktreeAllocations = [
        allocation({ path: worktreeDir, leaseSessionId: SESSION_ID }),
      ];
      vi.spyOn(graph, 'releaseWorktreeLease').mockRejectedValue(new Error('injected release failure'));
      const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      await expect(
        service.handlePtyExit(SESSION_ID, 'completed', { exitCode: 0, signal: null }),
      ).resolves.toBeUndefined();

      expect(graph.statusesFor(SESSION_ID)).toContain('exited');
      expect(stderr.mock.calls.flat().join('\n')).toContain('FAILED to release the worktree lease');
    });
  });
});
