/** GitHub's DB-gated spawn delivery and the negative no-fallback property. */
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PtyHostService } from '../src/pty/PtyHostService.js';
import { SpawnService } from '../src/spawn/SpawnService.js';
import type {
  AgentCredentialHomePort,
  GitHubCredential,
  GitHubCredentialPort,
  GraphAuth,
} from '../src/spawn/index.js';
import { FakeGraph } from './fake-graph.js';

const SPACE_ID = '11111111-1111-4111-8111-111111111111';
const MEMBER_ID = '22222222-2222-4222-8222-222222222222';
const ALICE = { identityId: 'identity-alice', actorId: 'actor-alice' };
const BOB = { identityId: 'identity-bob', actorId: 'actor-bob' };
const TOKEN = `ghp_${'I'.repeat(36)}`;

function homePort(dataDir: string): AgentCredentialHomePort {
  return {
    async resolve(auth: GraphAuth) {
      const identity = (auth as typeof ALICE).identityId;
      return {
        provider: 'anthropic',
        homeDir: `${dataDir}/credentials/${identity}`,
        configDir: `${dataDir}/credentials/${identity}/anthropic`,
      };
    },
  };
}

function gitHubPort(seen: GraphAuth[]): GitHubCredentialPort {
  return {
    async resolve(auth: GraphAuth): Promise<GitHubCredential | null> {
      seen.push(auth);
      return (auth as typeof ALICE).identityId === ALICE.identityId
        ? { provider: 'github', login: 'alice-gh', token: TOKEN }
        : null;
    },
  };
}

describe('member GitHub credential injection', () => {
  let dataDir: string;
  let binDir: string;
  let projectDir: string;
  let graph: FakeGraph;
  let pty: PtyHostService;
  let logs: unknown[];

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'tm8-github-inject-'));
    projectDir = await mkdtemp(join(tmpdir(), 'tm8-github-project-'));
    // `assertAgentRuntime` requires the agent binary to EXIST before any
    // credential logic runs; a CI runner has no real `claude`, and this suite
    // is about env injection, not binary presence — so a do-nothing shim.
    binDir = await mkdtemp(join(tmpdir(), 'tm8-github-bin-'));
    await writeFile(join(binDir, 'claude'), '#!/bin/sh\nexec /bin/true\n', 'utf8');
    await chmod(join(binDir, 'claude'), 0o755);
    graph = new FakeGraph({ workingDir: projectDir });
    pty = new PtyHostService();
    logs = [];
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    pty.shutdownAll();
    await rm(dataDir, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
    await rm(binDir, { recursive: true, force: true });
  });

  function service(seen: GraphAuth[]): SpawnService {
    const capture = (message: string, fields?: unknown): void => {
      logs.push(message, fields);
    };
    return new SpawnService({
      graph,
      pty,
      baseUrl: 'http://127.0.0.1:4610',
      dataDir,
      env: {
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        HOME: `${dataDir}/node-home`,
        GH_TOKEN: `ghp_${'N'.repeat(36)}`,
        GITHUB_TOKEN: `ghp_${'M'.repeat(36)}`,
      },
      bootSettlementMs: 5,
      logger: { info: capture, warn: capture, error: capture },
      credentialHome: homePort(dataDir),
      gitHubCredentials: gitHubPort(seen),
    });
  }

  it('injects Alice token into her child env and nowhere durable', async () => {
    const seen: GraphAuth[] = [];
    const spawnIfAbsent = vi.spyOn(pty, 'spawnIfAbsent').mockReturnValue({ reused: false });
    vi.spyOn(pty, 'waitForBootSettlement').mockResolvedValue(null);
    const result = await service(seen).spawn(ALICE, {
      spaceId: SPACE_ID,
      teamMemberId: MEMBER_ID,
      credentialSource: 'member',
    });

    expect(seen).toEqual([ALICE]);
    const env = spawnIfAbsent.mock.calls[0]![0].env as Record<string, string>;
    expect(env.GH_TOKEN).toBe(TOKEN);
    expect(env.GITHUB_TOKEN).toBe(TOKEN);
    expect(env.XDG_CONFIG_HOME).toBe(`${dataDir}/credentials/${ALICE.identityId}/.config`);
    expect(env.GIT_CONFIG_COUNT).toBe('2');
    expect(env.GIT_CONFIG_VALUE_0).toBe('');
    expect(env.GIT_CONFIG_VALUE_1).toContain('$GH_TOKEN');
    expect(env.GIT_CONFIG_VALUE_1).not.toContain(TOKEN);
    expect(env.GIT_AUTHOR_NAME).toBe('alice-gh');

    // Names only cross the launch-artifact boundary.
    expect(result.envVarNames).toContain('GH_TOKEN');
    expect(JSON.stringify(graph.manifests)).not.toContain(TOKEN);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(await readFile(result.manifestPath, 'utf8')).not.toContain(TOKEN);
    expect(JSON.stringify(logs)).not.toContain(TOKEN);
  });

  it('gives Bob an isolated empty GitHub posture, never Alice or the node fallback', async () => {
    const seen: GraphAuth[] = [];
    const spawnIfAbsent = vi.spyOn(pty, 'spawnIfAbsent').mockReturnValue({ reused: false });
    vi.spyOn(pty, 'waitForBootSettlement').mockResolvedValue(null);
    await service(seen).spawn(BOB, {
      spaceId: SPACE_ID,
      teamMemberId: MEMBER_ID,
      credentialSource: 'member',
    });

    expect(seen).toEqual([BOB]);
    const env = spawnIfAbsent.mock.calls[0]![0].env as Record<string, string>;
    expect(env.GH_TOKEN).toBe('');
    expect(env.GITHUB_TOKEN).toBe('');
    expect(env.XDG_CONFIG_HOME).toBe(`${dataDir}/credentials/${BOB.identityId}/.config`);
    expect(env.GIT_CONFIG_COUNT).toBe('1');
    expect(env.GIT_CONFIG_VALUE_0).toBe('');
    expect(env).not.toHaveProperty('GIT_CONFIG_KEY_1');
    expect(env).not.toHaveProperty('GIT_AUTHOR_NAME');
    expect(JSON.stringify(env)).not.toContain(TOKEN);
  });

  it("credentialSource 'node' skips the member GitHub store", async () => {
    const seen: GraphAuth[] = [];
    const spawnIfAbsent = vi.spyOn(pty, 'spawnIfAbsent').mockReturnValue({ reused: false });
    vi.spyOn(pty, 'waitForBootSettlement').mockResolvedValue(null);
    await service(seen).spawn(ALICE, {
      spaceId: SPACE_ID,
      teamMemberId: MEMBER_ID,
      credentialSource: 'node',
    });

    expect(seen).toEqual([]);
    const env = spawnIfAbsent.mock.calls[0]![0].env as Record<string, string>;
    expect(env).not.toHaveProperty('GH_TOKEN');
    expect(env).not.toHaveProperty('GIT_CONFIG_COUNT');
  });

  it('can use node agent auth and member GitHub auth independently', async () => {
    const seen: GraphAuth[] = [];
    const spawnIfAbsent = vi.spyOn(pty, 'spawnIfAbsent').mockReturnValue({ reused: false });
    vi.spyOn(pty, 'waitForBootSettlement').mockResolvedValue(null);
    const result = await service(seen).spawn(ALICE, {
      spaceId: SPACE_ID,
      teamMemberId: MEMBER_ID,
      credentialSources: { anthropic: 'node', github: 'member' },
    });

    expect(seen).toEqual([ALICE]);
    const env = spawnIfAbsent.mock.calls[0]![0].env as Record<string, string>;
    expect(env).not.toHaveProperty('CLAUDE_CONFIG_DIR');
    expect(env.GH_TOKEN).toBe(TOKEN);
    expect(result.manifest.launch.credentialSources).toEqual({
      anthropic: 'node',
      openai: null,
      github: 'member',
    });
  });

  it('can use member agent auth and node GitHub auth independently', async () => {
    const seen: GraphAuth[] = [];
    const spawnIfAbsent = vi.spyOn(pty, 'spawnIfAbsent').mockReturnValue({ reused: false });
    vi.spyOn(pty, 'waitForBootSettlement').mockResolvedValue(null);
    await service(seen).spawn(ALICE, {
      spaceId: SPACE_ID,
      teamMemberId: MEMBER_ID,
      credentialSources: { anthropic: 'member', github: 'node' },
    });

    expect(seen).toEqual([]);
    const env = spawnIfAbsent.mock.calls[0]![0].env as Record<string, string>;
    expect(env.CLAUDE_CONFIG_DIR).toContain('/credentials/identity-alice/anthropic');
    expect(env).not.toHaveProperty('GH_TOKEN');
    expect(env).not.toHaveProperty('GIT_CONFIG_COUNT');
  });
});
