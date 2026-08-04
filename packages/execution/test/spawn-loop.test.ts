// The G1A loop, end to end, against a REAL PTY.
//
// Every assertion in the prompt tests reads BYTES THE AGENT PROCESS EMITTED.
// That is not stylistic preference — `execution.prompt` is the seam that fails
// silently. A prompt that is accepted, ledgered and marked delivered but never
// reaches the PTY produces a completely green database: the command_ledger has
// its row, record_execution_command returned a normal CommandResult, the UI
// shows the message as sent. Nothing anywhere is red. The `delivered: true` this
// service returns is therefore worth exactly nothing as a test oracle, and an
// assertion on it would pass against a SpawnService that never called
// deliverPrompt at all.
//
// So the oracle is `TM8-ECHO: <text>` in the terminal's output ring. The
// echo-agent only emits that prefix after reading the line from its own stdin,
// which means the bytes traversed: SpawnService → PtyHostService.deliverPrompt →
// the FIFO → pty master → tty line discipline → the agent's stdin → back out
// through the pty → the 16ms coalescer → the output ring. Terminal local echo
// would put the raw prompt text in the output whether or not the agent ever ran,
// which is exactly why the assertion is on the PREFIX and not on the text alone.

import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PtyHostService } from '../src/pty/PtyHostService.js';
import { SpawnService } from '../src/spawn/SpawnService.js';
import { SpawnError } from '../src/spawn/types.js';
import { FakeGraph } from './fake-graph.js';

const SPACE_ID = '11111111-1111-4111-8111-111111111111';
const MEMBER_ID = '22222222-2222-4222-8222-222222222222';
const TASK_ID = '33333333-3333-4333-8333-333333333333';
const AUTH = { identityId: 'identity-1', actorId: 'actor-1' };

/** Poll the output ring from offset 0 until `needle` appears. Reads the ring
 *  rather than subscribing so nothing emitted before the test looked can be
 *  missed — a live-frame subscription started after spawn() returns would race
 *  the agent's own boot banner. */
async function waitForOutput(
  pty: PtyHostService,
  sessionId: string,
  needle: string,
  timeoutMs = 15000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let seen = '';
  while (Date.now() < deadline) {
    const slice = pty.getReplay(sessionId, 0);
    seen = slice ? slice.data.toString('utf8') : seen;
    if (seen.includes(needle)) return seen;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(
    `timed out after ${timeoutMs}ms waiting for ${JSON.stringify(needle)}.\n` +
      `--- terminal output (${seen.length} bytes) ---\n${seen}\n--- end ---`,
  );
}

describe('SpawnService — the G1A loop over a real PTY', () => {
  let dataDir: string;
  let projectDir: string;
  let pty: PtyHostService;
  let graph: FakeGraph;
  let service: SpawnService;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'tm8-draco-data-'));
    projectDir = await mkdtemp(join(tmpdir(), 'tm8-draco-proj-'));
    graph = new FakeGraph({ workingDir: projectDir });
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

  it('spawns a live PTY whose agent read the manifest we composed', async () => {
    const result = await service.spawn(AUTH, {
      spaceId: SPACE_ID,
      teamMemberId: MEMBER_ID,
      parentSessionId: '55555555-5555-4555-8555-555555555555',
      taskIds: [TASK_ID],
      projectId: '44444444-4444-4444-8444-444444444444',
    });

    expect(result.reused).toBe(false);
    expect(graph.created[0]?.parentSessionId).toBe('55555555-5555-4555-8555-555555555555');
    expect(graph.created[0]?.title).toBe('fixture task 1');
    expect(pty.hasSession(result.sessionId)).toBe(true);
    expect(result.cwd).toBe(projectDir);

    // The file the agent reads and the row the graph knows are BOTH written,
    // and neither is derived from the other.
    const onDisk = JSON.parse(await readFile(result.manifestPath, 'utf8'));
    expect(onDisk.sessionId).toBe(result.sessionId);
    expect(graph.manifests).toHaveLength(1);
    expect(graph.manifests[0]?.sessionId).toBe(result.sessionId);

    // Secret redaction: names only ever leave this process, never values.
    expect(result.envVarNames).toContain('TM8_MANIFEST_PATH');
    expect(result.envVarNames).toContain('TM8_AGENT_TOKEN');
    expect(graph.manifests[0]?.envVarNames).toContain('TM8_SESSION_ID');
    expect(graph.issuedAgentTokens).toEqual([{
      sessionId: result.sessionId,
      teamMemberId: MEMBER_ID,
    }]);
    expect(JSON.stringify(graph.manifests[0])).not.toContain('sk-ant');
    expect(JSON.stringify(graph.manifests[0])).not.toContain('fixture-agent-secret');

    // The agent proves it parsed the manifest at the path we put in its env.
    const output = await waitForOutput(pty, result.sessionId, 'TM8-ECHO-READY');
    expect(output).toContain(`TM8-ECHO-MANIFEST ok session=${result.sessionId}`);
    expect(output).toContain('tasks=1');
    expect(output).toContain(`cwd=${projectDir}`);
    // The agent's own process.cwd() — realpath'd because macOS resolves
    // /var/folders through the /private symlink and node reports the target.
    expect(output).toContain(`TM8-ECHO-CWD ${await realpath(projectDir)}`);
    expect(output).toContain('TM8-ECHO-BASE-URL http://127.0.0.1:4614');

    expect(graph.statusesFor(result.sessionId)).toEqual(['running']);
  }, 30000);

  it('makes session data private and repairs roots left by older versions', async () => {
    const sessionId = '66666666-6666-4666-8666-666666666666';
    const manifests = join(dataDir, 'manifests');
    const journals = join(dataDir, 'journals');
    const scratch = join(dataDir, 'scratch');
    const oldScratch = join(scratch, 'old-session');

    await Promise.all([
      mkdir(manifests, { recursive: true, mode: 0o755 }),
      mkdir(journals, { recursive: true, mode: 0o755 }),
      mkdir(oldScratch, { recursive: true, mode: 0o755 }),
    ]);
    await Promise.all([
      chmod(manifests, 0o755),
      chmod(journals, 0o755),
      chmod(scratch, 0o755),
      chmod(oldScratch, 0o755),
    ]);

    const oldManifest = join(manifests, 'old.json');
    const oldTemp = join(manifests, 'orphan.json.tmp');
    const oldJournal = join(journals, 'old.jsonl');
    await Promise.all([
      writeFile(oldManifest, '{}\n', { mode: 0o644 }),
      writeFile(oldTemp, '{}\n', { mode: 0o644 }),
      writeFile(oldJournal, '{}\n', { mode: 0o644 }),
    ]);
    await Promise.all([
      chmod(oldManifest, 0o644),
      chmod(oldTemp, 0o644),
      chmod(oldJournal, 0o644),
    ]);

    // A stale fixed-name temp symlink must be unlinked, never followed. The
    // victim models any file outside the manifest root that the service user
    // can write; its bytes must survive the spawn unchanged.
    const victim = join(dataDir, 'victim.txt');
    await writeFile(victim, 'do not touch\n', { mode: 0o644 });
    await symlink(victim, join(manifests, `${sessionId}.json.tmp`));

    graph = new FakeGraph({ workingDir: projectDir, withProject: false, sessionId });
    service = new SpawnService({
      graph,
      pty,
      baseUrl: 'http://127.0.0.1:4614',
      dataDir,
      nodeId: 'test-node',
      env: { ...process.env, TM8_AGENT_CMD: 'echo-agent' },
    });

    const result = await service.spawn(AUTH, {
      spaceId: SPACE_ID,
      teamMemberId: MEMBER_ID,
      taskIds: [TASK_ID],
    });
    await waitForOutput(pty, result.sessionId, 'TM8-ECHO-READY');

    const permissions = async (path: string): Promise<number> => (await stat(path)).mode & 0o777;
    await expect(Promise.all([
      permissions(manifests),
      permissions(journals),
      permissions(scratch),
      permissions(oldScratch),
      permissions(result.cwd),
    ])).resolves.toEqual([0o700, 0o700, 0o700, 0o700, 0o700]);
    await expect(Promise.all([
      permissions(oldManifest),
      permissions(oldTemp),
      permissions(oldJournal),
      permissions(result.manifestPath),
    ])).resolves.toEqual([0o600, 0o600, 0o600, 0o600]);
    await expect(readFile(victim, 'utf8')).resolves.toBe('do not touch\n');
  }, 30000);

  it('execution.prompt reaches the PTY — asserted on the bytes the agent echoed', async () => {
    const result = await service.spawn(AUTH, {
      spaceId: SPACE_ID,
      teamMemberId: MEMBER_ID,
      taskIds: [TASK_ID],
    });
    await waitForOutput(pty, result.sessionId, 'TM8-ECHO-READY');

    const message = 'draco-prompt-round-trip-9f3c';
    const promptResult = await service.prompt(AUTH, result.sessionId, message);
    expect(promptResult.delivered).toBe(true);

    // THE assertion. `TM8-ECHO: ` can only be produced by the agent process
    // reading that line off its own stdin. A database-only check would pass
    // here even if deliverPrompt were never called.
    const output = await waitForOutput(pty, result.sessionId, `TM8-ECHO: ${message}`);
    expect(output).toContain(`TM8-ECHO: ${message}`);

    // And the ledger row exists too — but it is the corroboration, not the proof.
    expect(graph.commands).toHaveLength(1);
    expect(graph.commands[0]?.operation).toBe('execution.prompt');
    expect(graph.commands[0]?.sessionId).toBe(result.sessionId);
  }, 30000);

  it('delivers several prompts in order without interleaving their Enter keys', async () => {
    const result = await service.spawn(AUTH, { spaceId: SPACE_ID, teamMemberId: MEMBER_ID });
    await waitForOutput(pty, result.sessionId, 'TM8-ECHO-READY');

    await service.prompt(AUTH, result.sessionId, 'alpha-1');
    await service.prompt(AUTH, result.sessionId, 'bravo-2');
    await service.prompt(AUTH, result.sessionId, 'charlie-3');

    const output = await waitForOutput(pty, result.sessionId, 'TM8-ECHO: charlie-3');
    const order = ['TM8-ECHO: alpha-1', 'TM8-ECHO: bravo-2', 'TM8-ECHO: charlie-3'].map((m) =>
      output.indexOf(m),
    );
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  }, 40000);

  it('refuses to ledger a prompt for a session with no live terminal', async () => {
    // The exact silent failure this seam is prone to: without the liveness
    // pre-check the ledger would record a delivery that physically cannot have
    // happened, and every downstream reader would believe it.
    await expect(service.prompt(AUTH, 'no-such-session', 'into the void')).rejects.toBeInstanceOf(
      SpawnError,
    );
    expect(graph.commands).toHaveLength(0);
  });

  // REMOVED in the identity composite <- main merge (2026-08-04). This guarded
  // the composite's own SpawnService `credentials` port, which `main` superseded
  // with `graph.issueWorkSessionAgentToken` (an `auth_sessions` mint, covered by
  // spawn-manifest.test.ts). The mint survives; REVOKE-ON-TERMINATE DOES NOT —
  // main's agent tokens are TTL-bounded only. That is a known, recorded gap, not
  // an oversight: re-add revocation against `auth_sessions`, then re-add a test.

  it('terminate kills the PTY and moves the session to exited', async () => {
    const result = await service.spawn(AUTH, { spaceId: SPACE_ID, teamMemberId: MEMBER_ID });
    await waitForOutput(pty, result.sessionId, 'TM8-ECHO-READY');

    const { outcome } = await service.terminate(AUTH, result.sessionId, { force: true });
    expect(outcome).toBe('killed');
    expect(pty.hasSession(result.sessionId)).toBe(false);
    expect(graph.commands.at(-1)?.operation).toBe('execution.terminate');
    expect(graph.statusesFor(result.sessionId)).toEqual(['running', 'exited']);
  }, 30000);

  it('a natural agent exit transitions the session using the spawner claims', async () => {
    // R29's single writer. The exit happens with no request in flight, so the
    // only identity available is the one captured at spawn — without it
    // require_space_member raises 42501 and the row stays 'running' forever.
    //
    // The service and the host are mutually dependent — the host needs the exit
    // sink at construction, the sink needs the service that captured the claims.
    // A closure that resolves the service lazily is what breaks the cycle, and
    // it is the same shape createExecutionPtyHost uses on the server side.
    let svc!: SpawnService;
    const host = new PtyHostService({ onSessionStatus: (id, s, exit) => svc.handlePtyExit(id, s, exit) });
    svc = new SpawnService({
      graph,
      pty: host,
      baseUrl: 'http://127.0.0.1:4614',
      dataDir,
      env: { ...process.env, TM8_AGENT_CMD: 'echo-agent' },
    });

    try {
      const result = await svc.spawn(AUTH, { spaceId: SPACE_ID, teamMemberId: MEMBER_ID });
      await waitForOutput(host, result.sessionId, 'TM8-ECHO-READY');

      // `/exit` makes the agent exit(0) of its own accord — a natural exit, not
      // a kill, so the transition can only come from the onSessionStatus sink.
      await svc.prompt(AUTH, result.sessionId, '/exit');

      const deadline = Date.now() + 15000;
      while (Date.now() < deadline && !graph.statusesFor(result.sessionId).includes('exited')) {
        await new Promise((r) => setTimeout(r, 25));
      }

      expect(graph.statusesFor(result.sessionId)).toContain('exited');
      expect(graph.authSeen).toContain(AUTH);
    } finally {
      host.shutdownAll();
    }
  }, 40000);

  it('marks the session failed when spawn fails after the row exists', async () => {
    // Without this the row keeps a slot against the concurrency cap forever and
    // the UI shows a session that was never alive.
    // `/dev/null` is a character device, so mkdir beneath it fails with ENOTDIR
    // on every POSIX host — a reliable way to break manifest writing AFTER
    // execution_spawn has already created the row.
    const svc = new SpawnService({
      graph,
      pty,
      baseUrl: 'http://127.0.0.1:4614',
      dataDir: '/dev/null/tm8-unwritable',
      env: { ...process.env, TM8_AGENT_CMD: 'echo-agent' },
    });

    await expect(svc.spawn(AUTH, { spaceId: SPACE_ID, teamMemberId: MEMBER_ID })).rejects.toThrow();

    expect(graph.created).toHaveLength(1);
    expect(graph.transitions).toHaveLength(1);
    expect(graph.transitions[0]?.status).toBe('failed');
    expect(pty.hasSession(graph.transitions[0]!.sessionId)).toBe(false);
  }, 30000);
});
