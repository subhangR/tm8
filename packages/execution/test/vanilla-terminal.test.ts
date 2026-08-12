// VANILLA TERMINALS (100), against a REAL PTY.
//
// A real PtyHostService rather than a fake, for the same reason spawn-loop.test
// uses one: the claims worth testing here are about a live shell process, and a
// fake PTY would let every one of them pass against a service that never
// started anything. The oracle throughout is bytes the shell actually emitted
// — `echo` output read back out of the output ring — because a shell that
// spawns and immediately dies looks identical to a working one from the graph's
// side, which is precisely the failure this feature could ship with.
//
// These cover test cases 2, 3 and 4 from the task. Case 1 (arrow keys, Ctrl-C,
// resize in a real interactive program) stays MANUAL and is stated as such
// rather than approximated by an assertion that would pass without them.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PtyHostService } from '../src/pty/PtyHostService.js';
import { SpawnService } from '../src/spawn/SpawnService.js';
import {
  SHELL_ENV_KEYS,
  ShellSessionLauncher,
  composeShellEnv,
  loginShellCommand,
  resolveLoginShell,
} from '../src/shell/index.js';
import { FakeGraph } from './fake-graph.js';

const SPACE_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '44444444-4444-4444-8444-444444444444';
const AUTH = { identityId: 'identity-1', actorId: 'actor-1' };

/** Poll the output ring until `needle` appears. Same helper as spawn-loop's,
 *  and the same reason: a subscription opened after the call returns races the
 *  shell's own startup output. */
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
    `timed out after ${String(timeoutMs)}ms waiting for ${JSON.stringify(needle)}.\n` +
      `--- terminal output (${String(seen.length)} bytes) ---\n${seen}\n--- end ---`,
  );
}

describe('the vanilla-terminal argv is closed', () => {
  it('execs the login shell in place, so the member IS the PTY process', () => {
    // `exec` is the whole assertion. Without it there are TWO processes on this
    // PTY — the `-c` wrapper waiting on the interactive shell — and then `exit`
    // returns to a second prompt, the PTY's exit code is the wrapper's, and
    // Ctrl-C races between them.
    expect(loginShellCommand('/bin/bash')).toBe("exec '/bin/bash' -l -i");
  });

  it('single-quotes a shell path with spaces rather than word-splitting it', () => {
    expect(loginShellCommand('/opt/my shell/bash')).toBe("exec '/opt/my shell/bash' -l -i");
  });

  it('resolves an inherited SHELL, and refuses one that is not on this machine', () => {
    expect(resolveLoginShell({ SHELL: '/bin/sh' })).toBe('/bin/sh');
    // A SHELL naming a missing binary is WORSE than the fallback: the PTY would
    // spawn, fail ENOENT, and read as a terminal that opened and instantly died
    // with no stated cause.
    expect(resolveLoginShell({ SHELL: '/nonexistent/zsh' })).not.toBe('/nonexistent/zsh');
    expect(resolveLoginShell({ SHELL: '/nonexistent/zsh' }).startsWith('/')).toBe(true);
  });
});

describe('the vanilla-terminal environment', () => {
  const parentEnv: NodeJS.ProcessEnv = {
    PATH: '/usr/bin:/bin',
    HOME: '/home/tm8',
    USER: 'tm8',
    LOGNAME: 'tm8',
    COLORTERM: 'truecolor',
    TMPDIR: '/tmp',
    LANG: 'en_GB.UTF-8',
    // Every one of these is a thing the server holds and a shell must not get.
    TM8_AGENT_TOKEN: 'agent-token-value',
    GH_TOKEN: 'gh-token-value',
    GITHUB_TOKEN: 'github-token-value',
    ANTHROPIC_API_KEY: 'sk-ant-secret',
    DATABASE_URL: 'postgres://user:pw@localhost/tm8',
  };

  /**
   * THE EXACT KEY SET, not the absence of particular names.
   *
   * A per-name assertion (`expect(env.GH_TOKEN).toBeUndefined()`) keeps passing
   * on the day someone adds `TM8_AGENT_TOKEN` to the composer, and an allowlist
   * regression is exactly the failure that would then ship unnoticed. This is
   * the same shape `credential-env.test.ts` uses, for the same reason.
   */
  it('emits exactly SHELL_ENV_KEYS and nothing else', () => {
    const env = composeShellEnv({ shell: '/bin/bash', parentEnv });
    expect(Object.keys(env).sort()).toEqual([...SHELL_ENV_KEYS].sort());
  });

  it('omits an inherited key the server does not have, rather than emitting it empty', () => {
    // SHELL_ENV_KEYS is the MAXIMAL set. A server with no COLORTERM must
    // produce a child with no COLORTERM — an empty string is a different value
    // from absent, and shells branch on presence.
    const env = composeShellEnv({ shell: '/bin/bash', parentEnv: { PATH: '/usr/bin' } });
    expect(env.COLORTERM).toBeUndefined();
    expect(env.TMPDIR).toBeUndefined();
    expect(Object.keys(env).every((key) => (SHELL_ENV_KEYS as readonly string[]).includes(key))).toBe(true);
    // The four written unconditionally still arrive, so a bare server still
    // produces a usable terminal.
    expect(Object.keys(env).sort()).toEqual(['LANG', 'PATH', 'SHELL', 'TERM', 'TM8_TERMINAL']);
  });

  it('carries no agent identity and no vendor or node credential', () => {
    const env = composeShellEnv({ shell: '/bin/bash', parentEnv });
    // Named individually as well, because the key-set assertion above states
    // WHAT is present and this states WHY these four in particular are not.
    // TM8_AGENT_TOKEN is the spawning human's FULL identity, and a shell is a
    // prompt a person types `curl` into.
    expect(env.TM8_AGENT_TOKEN).toBeUndefined();
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined();
  });

  it('agrees with PtyHostService about which binary runs', () => {
    // `PtyHostService.spawn` resolves `env.SHELL || process.env.SHELL || …`.
    // Writing the resolved shell into SHELL is what makes the host pick THIS
    // value rather than re-deriving one that could differ.
    const env = composeShellEnv({ shell: '/bin/dash', parentEnv });
    expect(env.SHELL).toBe('/bin/dash');
  });
});

describe('SpawnService.startShell — a real shell, no agent', () => {
  let dataDir: string;
  let projectDir: string;
  let pty: PtyHostService;
  let graph: FakeGraph;
  let service: SpawnService;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'tm8-shell-data-'));
    projectDir = await mkdtemp(join(tmpdir(), 'tm8-shell-proj-'));
    graph = new FakeGraph({ workingDir: projectDir });
    pty = new PtyHostService();
    service = new SpawnService({
      graph,
      pty,
      baseUrl: 'http://127.0.0.1:4614',
      dataDir,
      nodeId: 'test-node',
    });
  });

  afterEach(async () => {
    pty.shutdownAll();
    await rm(dataDir, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
  });

  it('starts a live shell in the project root that runs what is typed at it', async () => {
    const result = await service.startShell(AUTH, { spaceId: SPACE_ID, projectId: PROJECT_ID });

    expect(pty.hasSession(result.sessionId)).toBe(true);
    // The PROJECT ROOT, never a provisioned worktree — a worktree exists so
    // concurrent agents do not collide on one checkout, and a human who names a
    // project means that directory.
    expect(result.cwd).toBe(projectDir);
    expect(graph.shellsCreated).toHaveLength(1);
    expect(graph.shellsCreated[0]?.nodeId).toBe('test-node');
    // The ROW records where the shell is, so a reader does not have to
    // re-derive it from a project id and a convention.
    expect(graph.shellsCreated[0]?.workdirPath).toBe(projectDir);

    // The oracle: bytes the shell process itself produced. A graph row and a
    // `hasSession` are both true of a shell that died on its first instruction.
    pty.write(result.sessionId, 'echo TM8-SHELL-ALIVE\n');
    await waitForOutput(pty, result.sessionId, 'TM8-SHELL-ALIVE');
  });

  /**
   * TEST CASE 4 — no agent setup runs for a session with no agent.
   */
  it('composes no prompt, writes no manifest, mints no agent token, pins no profile', async () => {
    await service.startShell(AUTH, { spaceId: SPACE_ID, projectId: PROJECT_ID });

    expect(graph.manifests).toEqual([]);
    expect(graph.issuedAgentTokens).toEqual([]);
    expect(graph.profilePins).toEqual([]);
    // And it never took the agent path at all: `loadSpawnContext` is the read
    // that pulls the persona, its skills and its memory working set.
    expect(graph.created).toEqual([]);
  });

  it('records agentTool nowhere — the row has no agent field to fill', async () => {
    await service.startShell(AUTH, { spaceId: SPACE_ID, projectId: PROJECT_ID });
    const created = graph.shellsCreated[0];
    // Not `agentTool: null` — there is no such KEY. A field that does not exist
    // cannot be filled in by a later refactor.
    expect(created && 'agentTool' in created).toBe(false);
    expect(created && 'teamMemberId' in created).toBe(false);
  });

  /**
   * TEST CASE 2 — the failure `PtyHostService.ts:596` explicitly warns about.
   *
   * `spawn()` KILLS an existing PTY before replacing it. For an agent that
   * costs a boot; for a vanilla terminal it destroys whatever the member was
   * running. A reconnecting browser, a second tab and a double-click on the
   * start button must all land on the SAME live shell.
   */
  it('reattaches to the running shell instead of killing it', async () => {
    const first = await service.startShell(AUTH, { spaceId: SPACE_ID, projectId: PROJECT_ID });

    pty.write(first.sessionId, 'MARKER=survivor\n');
    pty.write(first.sessionId, 'echo TM8-FIRST-READY\n');
    await waitForOutput(pty, first.sessionId, 'TM8-FIRST-READY');
    const epochBefore = pty.getEpoch(first.sessionId);

    // Same session id, second start — the double-click / reconnect.
    const launcher = new ShellSessionLauncher({ pty });
    const again = launcher.launch({ sessionId: first.sessionId, cwd: projectDir });
    expect(again.reused).toBe(true);

    // THE ORACLE IS THE SHELL'S OWN MEMORY, not the `reused` flag. A variable
    // set before the second start still resolves, which no freshly-spawned
    // shell could do — so this proves the ORIGINAL process is still running,
    // and a `reused: true` returned by a service that had quietly respawned
    // could not fake it.
    pty.write(first.sessionId, 'echo "TM8-STILL-$MARKER"\n');
    await waitForOutput(pty, first.sessionId, 'TM8-STILL-survivor');
    // A replaced PTY restarts output at offset 0 under a NEW epoch. Same epoch
    // ⇒ the stream a reconnecting client resumes onto is the same stream.
    expect(pty.getEpoch(first.sessionId)).toBe(epochBefore);
  });

  it('a disconnecting client does not touch the shell', async () => {
    const started = await service.startShell(AUTH, { spaceId: SPACE_ID, projectId: PROJECT_ID });
    pty.write(started.sessionId, 'echo TM8-BEFORE-DETACH\n');
    await waitForOutput(pty, started.sessionId, 'TM8-BEFORE-DETACH');

    // Subscribe and drop, which is all a browser reload is on this seam.
    const sink = { send: () => undefined, close: () => undefined };
    expect(pty.addSubscriber(started.sessionId, sink as never)).toBe(true);
    pty.removeSubscriber(started.sessionId, sink as never);

    expect(pty.hasSession(started.sessionId)).toBe(true);
    pty.write(started.sessionId, 'echo TM8-AFTER-DETACH\n');
    await waitForOutput(pty, started.sessionId, 'TM8-AFTER-DETACH');
  });

  it('exits through the ordinary single writer, so the row never ghosts', async () => {
    const started = await service.startShell(AUTH, { spaceId: SPACE_ID, projectId: PROJECT_ID });
    graph.transitions.length = 0;

    // The claims captured at start are what let the exit transition be written
    // at all — see `SpawnService.sessionAuth`. Terminating exercises the same
    // path a real `exit` takes.
    await service.terminate(AUTH, started.sessionId);

    expect(graph.transitions.map((t) => t.status)).toContain('exited');
  });

  it('opens a projectless terminal in a server-owned scratch directory', async () => {
    const projectless = new FakeGraph({ workingDir: projectDir, withProject: false });
    const svc = new SpawnService({
      graph: projectless,
      pty,
      baseUrl: 'http://127.0.0.1:4614',
      dataDir,
      nodeId: 'test-node',
    });

    const result = await svc.startShell(AUTH, { spaceId: SPACE_ID, projectId: null });

    // Never the server's own cwd, which would let a member write into the tm8
    // checkout from a terminal.
    expect(result.cwd).toBe(join(dataDir, 'scratch', result.sessionId));
    // NULL in the row, not `.../pending`: the directory is named for a session
    // id that does not exist when the row is written, and a path no process
    // ever had is worse than an honest absence.
    expect(projectless.shellsCreated[0]?.workdirPath).toBeNull();
    pty.write(result.sessionId, 'pwd\n');
    await waitForOutput(pty, result.sessionId, result.sessionId);
  });
});
