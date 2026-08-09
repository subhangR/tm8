// PR5 — the claims in `agent-credentials.test.ts`, PROVEN against real things.
//
// Every assertion in this file runs a real process: a real PTY, a real `bash`
// in its three invocation forms, and the real `claude` CLI. That is not
// thoroughness for its own sake — each of these is a claim that a pure unit
// test would happily assert while being WRONG:
//
//  * "omitting a key clears it" is a claim about node-pty and the OS, not about
//    tm8. `pty-env.test.ts` mocks node-pty, so it proves tm8 passes the record
//    verbatim and proves NOTHING about what the child actually sees. The two
//    comments in this repo disagree about it — `PtyHostService.ts:418` says the
//    env is never merged, and `spawn-manifest.test.ts` says "node-pty merges
//    over process.env". One of them is wrong, and the entire C5 fix rests on
//    which.
//  * "an injected per-user value survives the agent's tool shells" is a claim
//    about `.bashrc` / `.profile`, which is exactly the mechanism that produced
//    the machine-wide `export GH_TOKEN` defect in the first place.
//  * "two identities resolve to different auth states" is a claim about the
//    vendor CLI's resolution order, which is version-scoped behaviour that no
//    amount of internal consistency can establish.
//
// NO REAL CREDENTIAL IS READ OR WRITTEN. The `claude` proof uses throwaway
// directories under the OS temp dir and a SYNTHETIC token that is obviously not
// a secret. The live `~/.claude` is never referenced.

import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PtyHostService } from '../src/pty/PtyHostService.js';
import { SpawnService } from '../src/spawn/SpawnService.js';
import { composeEnv, composeManifest, resolveAgentBinary } from '../src/spawn/manifest.js';
import type { AgentCredentialHome, AgentCredentialHomePort } from '../src/spawn/agent-credentials.js';
import type { SpawnContext, SpawnRequest } from '../src/spawn/types.js';
import { FakeGraph } from './fake-graph.js';

const SPACE_ID = '11111111-1111-4111-8111-111111111111';
const MEMBER_ID = '22222222-2222-4222-8222-222222222222';
const AUTH = { identityId: 'identity-alice', actorId: 'actor-1' };

/** Read the PTY output ring until `needle` shows up, or fail loudly. */
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
    `timed out after ${timeoutMs}ms waiting for ${JSON.stringify(needle)}.\n--- output ---\n${seen}\n--- end ---`,
  );
}

// ---------------------------------------------------------------------------
// 1. Omitting a key really does clear it — against a REAL pty.
// ---------------------------------------------------------------------------

describe('C5 — a polluted parent XDG_CONFIG_HOME cannot reach a real child process', () => {
  let pty: PtyHostService;

  beforeEach(() => {
    pty = new PtyHostService();
  });
  afterEach(() => {
    pty.shutdownAll();
  });

  it('gives the child ONLY the composed environment, so an omitted key is an absent variable', async () => {
    // The server process itself is polluted for the duration of this test —
    // which is the whole scenario: one `Environment=` line in the unit file.
    // BOTH XDG variables are polluted, so the control is exact: the two are
    // adjacent in the same allowlist and only ONE of them is a credential
    // lookup path. A test that dropped both would look identical here and would
    // be a blunter change than the finding calls for.
    const previousConfig = process.env.XDG_CONFIG_HOME;
    const previousCache = process.env.XDG_CACHE_HOME;
    process.env.XDG_CONFIG_HOME = '/home/tm8/.config';
    process.env.XDG_CACHE_HOME = '/home/tm8/.cache';

    try {
      const env = composeEnv(
        composeManifest({
          sessionId: 'sess-live-1',
          request: { spaceId: SPACE_ID, teamMemberId: MEMBER_ID } as SpawnRequest,
          context: liveContext(),
          launch: {
            mode: 'worker',
            model: 'opus',
            agentTool: 'claude-code',
            permissionMode: 'acceptEdits',
            accessMode: 'acceptEdits',
            reasoningEffort: null,
          },
          workdir: { mode: 'scratch', path: tmpdir() },
          command: 'true',
          baseUrl: 'http://127.0.0.1:4610',
        }),
        '/tmp/m.json',
        'http://127.0.0.1:4610',
        process.env,
      );

      // Precondition, asserted rather than assumed: the pollution IS visible to
      // this process, so a passing result cannot be explained by it being unset.
      expect(process.env.XDG_CONFIG_HOME).toBe('/home/tm8/.config');
      expect(env).not.toHaveProperty('XDG_CONFIG_HOME');

      pty.spawn({
        sessionId: 'sess-live-1',
        // The marker is printed with a delimiter on both sides so an empty
        // value is distinguishable from a missing line.
        //
        // The trailing `sleep` is not padding: a child that exits immediately
        // takes its PTY entry with it, and `getReplay` then answers null before
        // the first poll — an empty read that looks exactly like "the variable
        // leaked nothing" while actually proving nothing at all. Measured while
        // writing this test. The assertion still resolves as soon as the marker
        // appears, so the sleep costs nothing when it passes.
        command:
          'echo "XDG=[${XDG_CONFIG_HOME}]"; echo "CACHE=[${XDG_CACHE_HOME}]"; echo LIVE-DONE; sleep 5',
        cwd: tmpdir(),
        env,
      });

      const out = await waitForOutput(pty, 'sess-live-1', 'LIVE-DONE');

      // THE assertion this whole finding rests on.
      expect(out).toContain('XDG=[]');
      expect(out).not.toContain('/home/tm8/.config');
      // Positive control: a variable that IS in the composed env arrives, so
      // the empty result above is not "the child got no environment at all".
      expect(out).toContain('CACHE=[/home/tm8/.cache]');
      expect(env.XDG_CACHE_HOME).toBe('/home/tm8/.cache');
    } finally {
      if (previousConfig === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousConfig;
      if (previousCache === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = previousCache;
    }
  }, 30000);
});

function liveContext(): SpawnContext {
  return {
    spaceId: SPACE_ID,
    project: { id: 'proj-1', name: 'tm8', workingDir: tmpdir(), trust: 'trusted' },
    teamMember: {
      id: MEMBER_ID,
      name: 'Fixture Member',
      role: 'fixture',
      identity: 'fixture',
      memories: [],
      model: 'opus',
      agentTool: null,
      mode: 'worker',
      permissionMode: null,
      avatar: null,
      capabilities: {},
      commandPermissions: {},
    },
    tasks: [],
  };
}

// ---------------------------------------------------------------------------
// 2. The shell-form regression (criterion 7 / sub-doc 11 §I).
// ---------------------------------------------------------------------------

describe('an injected per-user value survives the shells an agent actually spawns', () => {
  /**
   * The PTY's own shell is `bash -c`, which reads neither `.bashrc` nor
   * `.profile`. The defect lived one process further down: the agent's TOOL
   * shells are interactive or login, and those DO read them — which is how a
   * machine-wide `export GH_TOKEN` in `/home/tm8/.bashrc` overrode whatever tm8
   * injected, silently misattributing every push.
   *
   * Those two export lines have since been removed from the deployed box. This
   * test is what makes their return visible: it goes red on any machine whose
   * shell startup files export one of these names, which is precisely the
   * condition that must never be true again.
   *
   * `GH_TOKEN` is asserted BY NAME on purpose here — unlike the env-composition
   * tests, the thing under test is this machine's shell configuration, and the
   * historical defect was specific to that variable.
   */
  const FORMS: ReadonlyArray<readonly [string, string]> = [
    ['plain (-c) — the PTY own shell', '-c'],
    ['interactive (-ic) — reads .bashrc', '-ic'],
    ['login (-lc) — reads .profile', '-lc'],
  ];

  it.each(FORMS)('%s delivers the injected values unchanged', (_label, flag) => {
    const injected = {
      GH_TOKEN: 'per-user-gh-token-pr5',
      TM8_CREDENTIAL_PROBE: 'per-user-marker-pr5',
    };

    const result = spawnSync(
      '/bin/bash',
      [flag, 'echo "GH=[$GH_TOKEN]"; echo "MARK=[$TM8_CREDENTIAL_PROBE]"'],
      {
        encoding: 'utf8',
        env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp', ...injected },
      },
    );

    // stdout only: `bash -ic` without a tty writes "no job control" to stderr,
    // which is noise and not a failure.
    expect(result.stdout).toContain('GH=[per-user-gh-token-pr5]');
    expect(result.stdout).toContain('MARK=[per-user-marker-pr5]');
  });
});

// ---------------------------------------------------------------------------
// 3. Two identities, two auth states — the real CLI (criterion 2).
// ---------------------------------------------------------------------------

/**
 * A SYNTHETIC Claude credential file.
 *
 * Deliberately shaped like the real thing and deliberately not one: the token
 * strings say so in their own text. What is being proved is the CLI's
 * RESOLUTION — that `CLAUDE_CONFIG_DIR` alone decides which auth state it
 * reports — and a fabricated file proves that as well as a real one would,
 * without any secret existing in the repository or in a test process.
 */
const SYNTHETIC_CREDENTIALS = JSON.stringify({
  claudeAiOauth: {
    accessToken: 'sk-ant-oat01-PR5-SYNTHETIC-NOT-A-REAL-TOKEN',
    refreshToken: 'sk-ant-ort01-PR5-SYNTHETIC-NOT-A-REAL-TOKEN',
    expiresAt: 4102444800000,
    scopes: ['user:inference'],
    subscriptionType: 'pro',
  },
});

describe('two identities credential directories resolve to DIFFERENT auth states', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'tm8-pr5-identities-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const claudeBinary = resolveAgentBinary('claude', process.env.PATH ?? '');

  it.runIf(claudeBinary !== null)(
    'runs the real claude CLI under each identity composed env and gets opposite answers',
    async () => {
      // Alice has connected: her credential home holds a credential file.
      // Bob has not: his exists and is empty, which is what a member who has
      // never completed a login actually has.
      const alice = await identityHome(root, 'identity-alice', true);
      const bob = await identityHome(root, 'identity-bob', false);

      const aliceStatus = authStatus(alice);
      const bobStatus = authStatus(bob);

      // The two directories are genuinely different paths — otherwise the rest
      // of this test would be comparing a thing with itself.
      expect(alice.configDir).not.toBe(bob.configDir);

      // DIFFERENT auth states, from the same binary, same moment, same machine
      // — the ONLY difference is the injected config directory.
      expect(aliceStatus.loggedIn).toBe(true);
      expect(bobStatus.loggedIn).toBe(false);
      expect(aliceStatus.authMethod).toBe('claude.ai');
      expect(bobStatus.authMethod).toBe('none');
      expect(aliceStatus.authMethod).not.toBe(bobStatus.authMethod);

      // And Bob did NOT inherit the node's login — which is the security claim,
      // not merely a difference. `loggedIn: false` under a per-identity dir on
      // a machine whose real ~/.claude IS logged in is exactly that proof.
      expect(bobStatus.loggedIn).toBe(false);
    },
    120000,
  );

  /** Build one identity's credential home the way PR2's launcher does. */
  async function identityHome(
    dataRoot: string,
    identityId: string,
    connected: boolean,
  ): Promise<AgentCredentialHome> {
    const homeDir = join(dataRoot, 'credentials', identityId);
    const configDir = join(homeDir, 'anthropic');
    await mkdirp(configDir);
    if (connected) {
      await writeFile(join(configDir, '.credentials.json'), SYNTHETIC_CREDENTIALS, { mode: 0o600 });
    }
    return { provider: 'anthropic', homeDir, configDir };
  }

  /**
   * Run `claude auth status` under an env composed by the REAL `composeEnv`,
   * with this identity's credential injected.
   *
   * Composed rather than hand-built on purpose: what is under test is the
   * environment tm8 will actually hand a spawned agent, so hand-writing
   * `CLAUDE_CONFIG_DIR` here would prove the CLI works and prove nothing about
   * tm8. `PATH` is taken from the test process because `claude` is installed
   * outside the bin directories `withAgentBinDirs` knows about.
   */
  function authStatus(home: AgentCredentialHome): {
    loggedIn: boolean;
    authMethod: string;
    apiKeySource?: string;
  } {
    const env = composeEnv(
      composeManifest({
        sessionId: 'sess-auth-probe',
        request: { spaceId: SPACE_ID, teamMemberId: MEMBER_ID } as SpawnRequest,
        context: liveContext(),
        launch: {
          mode: 'worker',
          model: 'opus',
          agentTool: 'claude-code',
          permissionMode: 'acceptEdits',
          accessMode: 'acceptEdits',
          reasoningEffort: null,
        },
        workdir: { mode: 'scratch', path: tmpdir() },
        command: 'claude',
        baseUrl: 'http://127.0.0.1:4610',
      }),
      '/tmp/m.json',
      'http://127.0.0.1:4610',
      // A node that HAS an API key set, so this doubles as the live half of
      // C8: the suppression must leave the member's own login deciding.
      { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '/tmp', ANTHROPIC_API_KEY: 'sk-ant-api03-PR5-SYNTHETIC' },
      undefined,
      undefined,
      home,
    );

    // The node's key is gone, so nothing competes with the member's credential.
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(env.CLAUDE_CONFIG_DIR).toBe(home.configDir);

    const result = spawnSync(claudeBinary as string, ['auth', 'status'], {
      encoding: 'utf8',
      env,
      timeout: 60000,
    });

    try {
      return JSON.parse(result.stdout);
    } catch {
      throw new Error(
        `claude auth status did not return JSON.\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
      );
    }
  }
});

async function mkdirp(path: string): Promise<void> {
  const { mkdir } = await import('node:fs/promises');
  await mkdir(path, { recursive: true, mode: 0o700 });
}

// ---------------------------------------------------------------------------
// 4. SpawnService actually asks the port, and the answer reaches the child.
// ---------------------------------------------------------------------------

describe('SpawnService injects the resolved credential home into a real spawn', () => {
  let dataDir: string;
  let projectDir: string;
  let pty: PtyHostService;
  let graph: FakeGraph;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'tm8-pr5-data-'));
    projectDir = await mkdtemp(join(tmpdir(), 'tm8-pr5-proj-'));
    graph = new FakeGraph({ workingDir: projectDir });
    pty = new PtyHostService();
  });

  afterEach(async () => {
    pty.shutdownAll();
    await rm(dataDir, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
  });

  function serviceWith(port?: AgentCredentialHomePort): SpawnService {
    return new SpawnService({
      graph,
      pty,
      baseUrl: 'http://127.0.0.1:4614',
      dataDir,
      nodeId: 'test-node',
      env: { ...process.env, TM8_AGENT_CMD: 'echo-agent', XDG_CONFIG_HOME: '/home/tm8/.config' },
      ...(port ? { credentialHome: port } : {}),
    });
  }

  it('records the config-dir variable in the manifest env names when a credential resolves', async () => {
    const asked: Array<{ agentTool: string }> = [];
    const service = serviceWith({
      async resolve(_auth, input) {
        asked.push(input);
        return {
          provider: 'anthropic',
          homeDir: `${dataDir}/credentials/identity-alice`,
          configDir: `${dataDir}/credentials/identity-alice/anthropic`,
        };
      },
    });

    const result = await service.spawn(AUTH, { spaceId: SPACE_ID, teamMemberId: MEMBER_ID });

    // The port was consulted with the session's RESOLVED tool, not a guess.
    expect(asked).toEqual([{ agentTool: 'claude-code' }]);
    expect(result.envVarNames).toContain('CLAUDE_CONFIG_DIR');
    expect(result.envVarNames).toContain('XDG_CONFIG_HOME');
    // Names only ever leave the process — the manifest must not carry the value.
    expect(JSON.stringify(graph.manifests[0])).not.toContain('identity-alice');
  }, 30000);

  it('injects nothing, and still clears XDG_CONFIG_HOME, when no port is wired', async () => {
    const service = serviceWith();
    const result = await service.spawn(AUTH, { spaceId: SPACE_ID, teamMemberId: MEMBER_ID });

    // A node with no credential wiring behaves exactly as before...
    expect(result.envVarNames).not.toContain('CLAUDE_CONFIG_DIR');
    // ...except that the server's own polluted XDG no longer rides along. This
    // is the half of C5 that protects members who have connected NOTHING.
    expect(result.envVarNames).not.toContain('XDG_CONFIG_HOME');
  }, 30000);

  it('injects nothing when the identity has not connected this provider', async () => {
    const service = serviceWith({ async resolve() { return null; } });
    const result = await service.spawn(AUTH, { spaceId: SPACE_ID, teamMemberId: MEMBER_ID });

    expect(result.envVarNames).not.toContain('CLAUDE_CONFIG_DIR');
    expect(result.envVarNames).not.toContain('XDG_CONFIG_HOME');
  }, 30000);

  it('FAILS THE SPAWN when the credential home cannot be resolved', async () => {
    // Deliberately not swallowed. A member who HAS connected and silently gets
    // the node's machine account back is the misattribution this build exists
    // to end, and it is invisible: the session runs perfectly and commits as
    // somebody else.
    const service = serviceWith({
      async resolve() {
        throw new Error('credential index unavailable');
      },
    });

    await expect(
      service.spawn(AUTH, { spaceId: SPACE_ID, teamMemberId: MEMBER_ID }),
    ).rejects.toThrow('credential index unavailable');
  }, 30000);

  // -------------------------------------------------------------------------
  // 5. The launch-time choice: credentialSource.
  //
  // Three values, three different obligations. Auto (absent) is the behaviour
  // every assertion above already pins. 'node' must not even ASK the port —
  // a member who chose the node account may not have a credential to leak,
  // but the lookup is an RLS-scoped read and skipping it is what makes the
  // choice legible in the code. 'member' must REFUSE rather than fall back:
  // running a member as the node after they explicitly asked to run as
  // themselves is the misattribution this store exists to end.
  // -------------------------------------------------------------------------

  it("credentialSource 'node' skips the port entirely and injects nothing", async () => {
    let asked = 0;
    const service = serviceWith({
      async resolve() {
        asked += 1;
        return {
          provider: 'anthropic',
          homeDir: `${dataDir}/credentials/identity-alice`,
          configDir: `${dataDir}/credentials/identity-alice/anthropic`,
        };
      },
    });

    const result = await service.spawn(AUTH, {
      spaceId: SPACE_ID,
      teamMemberId: MEMBER_ID,
      credentialSource: 'node',
    });

    expect(asked).toBe(0);
    expect(result.envVarNames).not.toContain('CLAUDE_CONFIG_DIR');
    // The choice is durable: a resume or a child spawn reads it back from here.
    expect(graph.manifests[0]?.manifest.launch.credentialSource).toBe('node');
  }, 30000);

  it("credentialSource 'member' injects the member credential and records the choice", async () => {
    const service = serviceWith({
      async resolve() {
        return {
          provider: 'anthropic',
          homeDir: `${dataDir}/credentials/identity-alice`,
          configDir: `${dataDir}/credentials/identity-alice/anthropic`,
        };
      },
    });

    const result = await service.spawn(AUTH, {
      spaceId: SPACE_ID,
      teamMemberId: MEMBER_ID,
      credentialSource: 'member',
    });

    expect(result.envVarNames).toContain('CLAUDE_CONFIG_DIR');
    expect(graph.manifests[0]?.manifest.launch.credentialSource).toBe('member');
  }, 30000);

  it("credentialSource 'member' REFUSES the launch when no credential is connected", async () => {
    const service = serviceWith({ async resolve() { return null; } });

    await expect(
      service.spawn(AUTH, {
        spaceId: SPACE_ID,
        teamMemberId: MEMBER_ID,
        credentialSource: 'member',
      }),
    ).rejects.toMatchObject({ name: 'SpawnError', code: 'conflict' });
  }, 30000);

  it("credentialSource 'member' refuses on a node with no credential wiring at all", async () => {
    const service = serviceWith();

    await expect(
      service.spawn(AUTH, {
        spaceId: SPACE_ID,
        teamMemberId: MEMBER_ID,
        credentialSource: 'member',
      }),
    ).rejects.toMatchObject({ name: 'SpawnError', code: 'conflict' });
  }, 30000);

  it('auto (absent) still records what it did, as null', async () => {
    const service = serviceWith({ async resolve() { return null; } });
    await service.spawn(AUTH, { spaceId: SPACE_ID, teamMemberId: MEMBER_ID });
    expect(graph.manifests[0]?.manifest.launch.credentialSource).toBeNull();
  }, 30000);
});
