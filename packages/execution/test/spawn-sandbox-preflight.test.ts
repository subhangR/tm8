// Coverage for the codex sandbox preflight (tm8 task 019fbec1, defect #1).
//
// THE DEFECT, as reproduced on the live prod node 2026-08-02: `buildAgentCommand`
// emitted `--sandbox workspace-write` for every codex posture except
// `bypassPermissions`, on a node where no sandbox could start. The spawn
// returned in 0.77s, the work_session went `running`, `session liveness` listed
// it, the agent reached "Ready when you are." and accepted a message — and then
// every shell command inside it died with
//
//     bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted
//
// with tm8 still reporting the session as healthy. Emitting a sandbox flag was
// being treated as having a sandbox.
//
// THE STUBS ARE REAL EXECUTABLES, not a mocked child_process. The bug was
// entirely about what the provider's sandbox does when actually run, so a suite
// that mocked the run would be asserting the same assumption that produced the
// bug. `codex-broken` reproduces the live failure exactly: bwrap's message on
// stderr, nothing on stdout.

import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PtyHostService } from '../src/pty/PtyHostService.js';
import { SpawnService } from '../src/spawn/SpawnService.js';
import { buildAgentCommand } from '../src/spawn/manifest.js';
import { probeCodexSandbox, resetSandboxProbeCache } from '../src/spawn/sandbox-probe.js';
import { SpawnError } from '../src/spawn/types.js';
import { FakeGraph } from './fake-graph.js';

const AUTH = { identityId: 'identity-1', actorId: 'actor-1' };
const REQUEST = {
  clientMutationId: 'mutation-1',
  spaceId: '11111111-1111-4111-8111-111111111111',
  teamMemberId: '22222222-2222-4222-8222-222222222222',
  projectId: '33333333-3333-4333-8333-333333333333',
  interactionProfileId: '44444444-4444-4444-8444-444444444444',
};

/** A codex whose sandbox works: `codex sandbox -- <cmd>` runs the command. */
const CODEX_OK = `#!/bin/sh
if [ "$1" = "sandbox" ]; then shift; [ "$1" = "--" ] && shift; exec "$@"; fi
exec /bin/true
`;

/** A codex whose sandbox cannot start — the live node's exact failure. */
const CODEX_BROKEN = `#!/bin/sh
if [ "$1" = "sandbox" ]; then
  echo "bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted" >&2
  exit 1
fi
exec /bin/true
`;

/** A codex whose sandbox fails but still exits 0 with no output — codex really
 *  does degrade silently on some paths, so the probe must not trust exit 0. */
const CODEX_SILENTLY_BROKEN = `#!/bin/sh
if [ "$1" = "sandbox" ]; then exit 0; fi
exec /bin/true
`;

describe('codex sandbox preflight', () => {
  let binDir: string;
  let dataDir: string;
  let projectDir: string;

  beforeEach(async () => {
    binDir = await mkdtemp(join(tmpdir(), 'tm8-sandbox-bin-'));
    dataDir = await mkdtemp(join(tmpdir(), 'tm8-sandbox-data-'));
    projectDir = await mkdtemp(join(tmpdir(), 'tm8-sandbox-project-'));
    resetSandboxProbeCache();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    resetSandboxProbeCache();
    await rm(binDir, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
  });

  async function installCodex(body: string): Promise<string> {
    const path = join(binDir, 'codex');
    await writeFile(path, body, 'utf8');
    await chmod(path, 0o755);
    return path;
  }

  /**
   * A do-nothing `claude` for the claude-code paths: `assertAgentRuntime`
   * checks the binary EXISTS before any probe logic runs, and a CI runner has
   * no real claude — without this shim the claude tests die on binary
   * resolution and say nothing about the probe behaviour they pin.
   */
  async function installClaude(): Promise<string> {
    const path = join(binDir, 'claude');
    await writeFile(path, '#!/bin/sh\nexec /bin/true\n', 'utf8');
    await chmod(path, 0o755);
    return path;
  }

  function makeService(env: NodeJS.ProcessEnv): { service: SpawnService; graph: FakeGraph } {
    const graph = new FakeGraph({ workingDir: projectDir, model: 'gpt-5.6-sol' });
    const service = new SpawnService({
      graph,
      pty: new PtyHostService(),
      baseUrl: 'http://127.0.0.1:4610',
      dataDir,
      env: { HOME: process.env.HOME, ...env, PATH: `${binDir}:${process.env.PATH ?? ''}` },
      bootSettlementMs: 25,
      // This suite isolates sandbox delivery. The independent command-network
      // preflight has its own tests and would reject these deliberately tiny
      // Codex shell stubs before the sandbox seam is reached.
      codexNetworkPreflight: async () => {},
    });
    return { service, graph };
  }

  describe('the probe itself', () => {
    it('reports usable when the provider can actually run a command confined', async () => {
      const binary = await installCodex(CODEX_OK);
      await expect(probeCodexSandbox({ binary })).resolves.toEqual({ usable: true });
    });

    it('reports unusable, and quotes the reason, when the sandbox cannot start', async () => {
      const binary = await installCodex(CODEX_BROKEN);
      const result = await probeCodexSandbox({ binary });
      expect(result.usable).toBe(false);
      // The operator has to be able to act on this without going and reproducing
      // it themselves, so the provider's own words are carried through verbatim.
      expect(result.usable === false && result.detail).toContain('RTM_NEWADDR');
    });

    it('does not trust exit 0 — a silent sandbox failure is still a failure', async () => {
      const binary = await installCodex(CODEX_SILENTLY_BROKEN);
      const result = await probeCodexSandbox({ binary });
      expect(result.usable).toBe(false);
    });

    it('reports unusable rather than assuming, when the CLI is not installed', async () => {
      const result = await probeCodexSandbox({ binary: join(binDir, 'no-such-codex') });
      expect(result).toMatchObject({ usable: false, reason: 'binary_missing' });
    });
  });

  describe('the command line it produces', () => {
    const launch = {
      mode: 'worker' as const,
      model: 'gpt-5.6-sol',
      agentTool: 'codex',
      permissionMode: 'auto' as const,
      accessMode: 'auto' as const,
      reasoningEffort: null,
    };

    it('emits --sandbox as usual when the node can sandbox', () => {
      const command = buildAgentCommand(launch, {}, { sandboxUnavailable: false });
      expect(command).toContain('--sandbox');
      expect(command).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    });

    it('stops claiming a sandbox it cannot provide, and asks for no approvals it cannot get', () => {
      const command = buildAgentCommand(launch, {}, { sandboxUnavailable: true });
      expect(command).not.toContain('--sandbox ');
      // Approvals without a sandbox would be an unattended hang for no
      // confinement in return — see the comment on this branch.
      expect(command).not.toContain('--ask-for-approval');
      expect(command).toContain('--dangerously-bypass-approvals-and-sandbox');
    });
  });

  describe('what a spawn is allowed to do about it', () => {
    it('still launches when the node cannot sandbox — and RECORDS that it did', async () => {
      // The behaviour old maestro had, which is the bar: it ran fifteen real
      // codex sessions to completion on the node this was measured against,
      // because it never resolved a posture that demanded a sandbox. Refusing
      // here would make tm8 stricter than its own behavioural oracle while
      // still running no codex at all.
      await installCodex(CODEX_BROKEN);
      const { service } = makeService({});
      const pty = (service as unknown as { pty: PtyHostService }).pty;
      vi.spyOn(pty, 'beginPromptHandoff').mockImplementation(() => {});
      vi.spyOn(pty, 'spawnIfAbsent').mockReturnValue({ reused: false });
      vi.spyOn(pty, 'waitForBootSettlement').mockResolvedValue(null);

      const result = await service.spawn(AUTH, REQUEST);
      expect(result.sessionId).toBeTruthy();
      expect(result.command).toContain('--dangerously-bypass-approvals-and-sandbox');
      expect(result.command).not.toContain('--sandbox ');

      // The half that makes this honest rather than merely convenient: the
      // manifest says the posture was NOT delivered, and why. Without it,
      // `permissionMode: 'auto'` is a record of what was asked for and nothing
      // records what happened.
      const manifest = JSON.parse(
        await readFile(join(dataDir, 'manifests', `${result.sessionId}.json`), 'utf8'),
      ) as { launch: { sandboxDegraded: string | null; permissionMode: string } };
      expect(manifest.launch.permissionMode).toBe('auto');
      expect(manifest.launch.sandboxDegraded).toContain('RTM_NEWADDR');
    });

    it('refuses instead, naming the precondition, when an operator demands confinement', async () => {
      await installCodex(CODEX_BROKEN);
      const { service, graph } = makeService({ TM8_REQUIRE_CODEX_SANDBOX: '1' });

      let caught: unknown;
      try {
        await service.spawn(AUTH, REQUEST);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(SpawnError);
      const err = caught as SpawnError;
      expect(err.code).toBe('conflict');
      // Actionable: it names what failed AND what the operator can do about it.
      expect(err.message).toContain('cannot sandbox codex');
      expect(err.message).toContain('bubblewrap');
      // And it fails BEFORE booting anything, so there is no half-created
      // session left looking alive — the whole point of preflighting.
      expect(graph.transitions.map((t) => t.status)).not.toContain('running');
    });

    it('leaves a healthy node alone — the sandbox flags go out unchanged', async () => {
      await installCodex(CODEX_OK);
      const { service } = makeService({});
      const pty = (service as unknown as { pty: PtyHostService }).pty;
      vi.spyOn(pty, 'beginPromptHandoff').mockImplementation(() => {});
      vi.spyOn(pty, 'spawnIfAbsent').mockReturnValue({ reused: false });
      vi.spyOn(pty, 'waitForBootSettlement').mockResolvedValue(null);

      const result = await service.spawn(AUTH, REQUEST);
      expect(result.command).toContain('--sandbox');
      expect(result.command).not.toContain('--dangerously-bypass-approvals-and-sandbox');

      // Nothing was degraded, so the manifest must not claim anything was.
      const manifest = JSON.parse(
        await readFile(join(dataDir, 'manifests', `${result.sessionId}.json`), 'utf8'),
      ) as { launch: { sandboxDegraded: string | null } };
      expect(manifest.launch.sandboxDegraded).toBeNull();
    });

    it('never probes for claude-code, whose permission modes are in-agent', async () => {
      // No CODEX stub installed at all: if the claude path probed, this would
      // fail on a missing codex binary instead of spawning. The claude shim
      // only satisfies binary resolution (see installClaude).
      await installClaude();
      const graph = new FakeGraph({ workingDir: projectDir, model: 'claude-opus-5' });
      const service = new SpawnService({
        graph,
        pty: new PtyHostService(),
        baseUrl: 'http://127.0.0.1:4610',
        dataDir,
        env: { HOME: process.env.HOME, PATH: `${binDir}:${process.env.PATH ?? ''}` },
        bootSettlementMs: 25,
      });
      const pty = (service as unknown as { pty: PtyHostService }).pty;
      vi.spyOn(pty, 'beginPromptHandoff').mockImplementation(() => {});
      vi.spyOn(pty, 'spawnIfAbsent').mockReturnValue({ reused: false });
      vi.spyOn(pty, 'waitForBootSettlement').mockResolvedValue(null);

      const result = await service.spawn(AUTH, REQUEST);
      expect(result.command).toContain('claude');
    });

    it('does not probe for a teammate that was never going to be confined', async () => {
      // bypassPermissions asks for no sandbox, so there is nothing to lose and
      // no reason to pay for a probe — asserted by installing a codex whose
      // sandbox is broken and expecting the spawn to succeed regardless.
      await installCodex(CODEX_BROKEN);
      const graph = new FakeGraph({
        workingDir: projectDir,
        model: 'gpt-5.6-sol',
        permissionMode: 'bypassPermissions',
      });
      const service = new SpawnService({
        graph,
        pty: new PtyHostService(),
        baseUrl: 'http://127.0.0.1:4610',
        dataDir,
        env: { HOME: process.env.HOME, PATH: `${binDir}:${process.env.PATH ?? ''}` },
        bootSettlementMs: 25,
      });
      const pty = (service as unknown as { pty: PtyHostService }).pty;
      vi.spyOn(pty, 'beginPromptHandoff').mockImplementation(() => {});
      vi.spyOn(pty, 'spawnIfAbsent').mockReturnValue({ reused: false });
      vi.spyOn(pty, 'waitForBootSettlement').mockResolvedValue(null);

      const result = await service.spawn(AUTH, REQUEST);
      expect(result.command).toContain('--dangerously-bypass-approvals-and-sandbox');
    });
  });
});
