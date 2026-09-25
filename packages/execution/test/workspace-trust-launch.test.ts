// Both launch doors seed the stable trust root and arm the trust watchdog.
//
// SpawnService reaches a claude PTY through TWO paths — `spawn` and `resume`,
// each with its own loadSpawnContext call — and a fix wired into one of them
// leaves the other hanging at the trust dialog. The PTY boundary is mocked (no
// child), and HOME is a temp dir, so the config written is inspectable and the
// developer's own `~/.claude.json` is never touched.

import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PtyHostService } from '../src/pty/PtyHostService.js';
import { ECHO_AGENT_CMD } from '../src/spawn/manifest.js';
import { SpawnService } from '../src/spawn/SpawnService.js';
import type { WorkSessionResumeInfo } from '../src/spawn/types.js';
import { FakeGraph } from './fake-graph.js';

const AUTH = { identityId: 'identity-1', actorId: 'actor-1' };
const SESSION_ID = '44444444-4444-4444-8444-444444444444';
const SPACE_ID = '11111111-1111-4111-8111-111111111111';
const MEMBER_ID = '22222222-2222-4222-8222-222222222222';
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

describe('claude trust at both launch doors', () => {
  let dataDir: string;
  let home: string;
  let graph: FakeGraph;
  let pty: PtyHostService;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'tm8-trust-launch-data-'));
    home = await mkdtemp(join(tmpdir(), 'tm8-trust-launch-home-'));
    graph = new FakeGraph({ workingDir: '/tmp', withProject: false });
    graph.resumeInfo = { ...RESUME_INFO };
    pty = new PtyHostService();
    vi.spyOn(pty, 'beginPromptHandoff').mockImplementation(() => {});
    vi.spyOn(pty, 'spawnIfAbsent').mockReturnValue({ reused: false } as never);
    vi.spyOn(pty, 'waitForBootSettlement').mockResolvedValue(null);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dataDir, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  function service(env: NodeJS.ProcessEnv): SpawnService {
    return new SpawnService({
      graph,
      pty,
      baseUrl: 'http://127.0.0.1:4614',
      dataDir,
      env: { PATH: process.env.PATH ?? '', HOME: home, ...env },
      bootSettlementMs: 25,
    });
  }

  async function trustedPaths(): Promise<string[]> {
    const config = JSON.parse(await readFile(join(home, '.claude.json'), 'utf8'));
    return Object.entries(config.projects as Record<string, { hasTrustDialogAccepted?: boolean }>)
      .filter(([, entry]) => entry.hasTrustDialogAccepted === true)
      .map(([path]) => path);
  }

  it('spawn: seeds the lane AND the scratch root, then arms the watchdog', async () => {
    const svc = service({ TM8_AGENT_CMD: ECHO_AGENT_CMD });
    const watch = vi.spyOn(svc as unknown as { watchWorkspaceTrust: () => void }, 'watchWorkspaceTrust');

    const result = await svc.spawn(AUTH, {
      clientMutationId: 'mutation-1',
      spaceId: SPACE_ID,
      teamMemberId: MEMBER_ID,
    });

    const paths = await trustedPaths();
    expect(paths.some((p) => p.endsWith(join('scratch', result.sessionId)))).toBe(true);
    expect(paths).toContain(await realpath(join(dataDir, 'scratch')));
    expect(watch).toHaveBeenCalledWith(result.sessionId, result.manifestPath, expect.anything(), expect.anything());
  });

  it('resume: seeds the same root and arms the same watchdog', async () => {
    const svc = service({});
    // The binary preflight is not under test and fails closed without claude.
    vi.spyOn(svc as unknown as { assertAgentRuntime: () => Promise<void> }, 'assertAgentRuntime')
      .mockResolvedValue(undefined);
    const watch = vi.spyOn(svc as unknown as { watchWorkspaceTrust: () => void }, 'watchWorkspaceTrust');

    await svc.resume(AUTH, { sessionId: SESSION_ID });

    const paths = await trustedPaths();
    expect(paths.some((p) => p.endsWith(join('scratch', SESSION_ID)))).toBe(true);
    expect(paths).toContain(await realpath(join(dataDir, 'scratch')));
    expect(watch).toHaveBeenCalledWith(SESSION_ID, expect.any(String), expect.anything(), expect.anything());
  });

  it('a reused PTY is not watched — it is not a fresh boot', async () => {
    vi.mocked(pty.spawnIfAbsent).mockReturnValue({ reused: true } as never);
    const svc = service({ TM8_AGENT_CMD: ECHO_AGENT_CMD });
    const watch = vi.spyOn(svc as unknown as { watchWorkspaceTrust: () => void }, 'watchWorkspaceTrust');

    await svc.spawn(AUTH, {
      clientMutationId: 'mutation-2',
      spaceId: SPACE_ID,
      teamMemberId: MEMBER_ID,
    });

    expect(watch).not.toHaveBeenCalled();
  });
});
