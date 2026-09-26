/**
 * 256 (W7p): a resume is link-bound off the session it MINTS, not the
 * resumer's claims.
 *
 * A work session that ran under a space link keeps the link in SQL: whoever
 * resumes it, `link_provenance_for` stamps the new agent session with the
 * link's `via_link_id`. The credential policy (`resolveLinkBoundCredentials`)
 * is TS, so it must follow that stamp. Keyed on the resumer's claims alone, a
 * member with no link of their own resuming such a session would hand it
 * their account model key and account git login — this file pins that the
 * member ports are never asked.
 */
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PtyHostService } from '../src/pty/PtyHostService.js';
import { SpawnService } from '../src/spawn/SpawnService.js';
import type {
  AgentCredentialHomePort,
  GitHubCredentialPort,
  GraphAuth,
} from '../src/spawn/index.js';
import { SpawnError, type WorkSessionResumeInfo } from '../src/spawn/types.js';
import { FakeGraph } from './fake-graph.js';

const SESSION_ID = '44444444-4444-4444-8444-444444444444';
const SPACE_ID = '11111111-1111-4111-8111-111111111111';
const MEMBER_ID = '22222222-2222-4222-8222-222222222222';
/** A member with no link of their own: nothing in these claims is link-bound. */
const RESUMER = { identityId: 'identity-resumer', actorId: 'actor-resumer' };
/** What FakeGraph mints for SESSION_ID. */
const MINTED = `tm8s_${SESSION_ID}.fixture-agent-secret`;

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
  title: 'a session that ran under a space link',
  status: 'exited',
  nativeSessionId: 'pre-minted-claude-uuid',
  agentConfigDir: null,
};

/** The SQL stamp, as the graph reports it: only tokens in `stamped` are link-bound. */
class LinkGraph extends FakeGraph {
  readonly stamped = new Set<string>();
  readonly linkBoundAsked: Array<{ auth: GraphAuth; token: string }> = [];

  async isLinkBound(auth: GraphAuth, agentToken: string): Promise<boolean> {
    this.linkBoundAsked.push({ auth, token: agentToken });
    return this.stamped.has(agentToken);
  }
}

describe('W7p — a non-link member resuming a link-provenance session', () => {
  let dataDir: string;
  let binDir: string;
  let graph: LinkGraph;
  let pty: PtyHostService;
  let homeAsked: GraphAuth[];
  let gitAsked: GraphAuth[];

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'tm8-link-resume-'));
    binDir = await mkdtemp(join(tmpdir(), 'tm8-link-resume-bin-'));
    await writeFile(join(binDir, 'claude'), '#!/bin/sh\nexec /bin/true\n', 'utf8');
    await chmod(join(binDir, 'claude'), 0o755);
    graph = new LinkGraph({ workingDir: dataDir, withProject: false });
    graph.resumeInfo = { ...RESUME_INFO };
    pty = new PtyHostService();
    homeAsked = [];
    gitAsked = [];
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    pty.shutdownAll();
    await rm(dataDir, { recursive: true, force: true });
    await rm(binDir, { recursive: true, force: true });
  });

  function service(): SpawnService {
    const home: AgentCredentialHomePort = {
      async resolve(auth) {
        homeAsked.push(auth);
        return {
          provider: 'anthropic',
          homeDir: `${dataDir}/credentials/resumer`,
          configDir: `${dataDir}/credentials/resumer/anthropic`,
        };
      },
    };
    const git: GitHubCredentialPort = {
      async resolve(auth) {
        gitAsked.push(auth);
        return { provider: 'github', login: 'resumer-gh', token: `ghp_${'R'.repeat(36)}` };
      },
    };
    return new SpawnService({
      graph,
      pty,
      baseUrl: 'http://127.0.0.1:4610',
      dataDir,
      env: { PATH: `${binDir}:${process.env.PATH ?? ''}`, HOME: `${dataDir}/node-home` },
      bootSettlementMs: 5,
      credentialHome: home,
      gitHubCredentials: git,
    });
  }

  it('the minted session is stamped: no account key, no account git, a named link refusal', async () => {
    graph.stamped.add(MINTED);
    const error = await service()
      .resume(RESUMER, { sessionId: SESSION_ID })
      .then(() => null, (e: unknown) => e);

    expect(graph.linkBoundAsked).toEqual([{ auth: RESUMER, token: MINTED }]);
    expect(homeAsked).toEqual([]);
    expect(gitAsked).toEqual([]);
    // No space port here, so there is no space GitHub default: the link path
    // refuses by name rather than falling back to the member's login.
    expect(error).toBeInstanceOf(SpawnError);
    expect((error as SpawnError).code).toBe('forbidden');
    expect((error as SpawnError).detail).toMatchObject({
      provider: 'github',
      reason: 'no_git_credential',
      spaceLink: true,
    });
  });

  it('control: the same resumer on an unstamped session reaches both member ports', async () => {
    vi.spyOn(pty, 'spawnIfAbsent').mockReturnValue({ reused: false });
    vi.spyOn(pty, 'waitForBootSettlement').mockResolvedValue(null);
    await service().resume(RESUMER, { sessionId: SESSION_ID });

    expect(graph.linkBoundAsked).toEqual([{ auth: RESUMER, token: MINTED }]);
    expect(homeAsked).toEqual([RESUMER]);
    expect(gitAsked).toEqual([RESUMER]);
  });
});
