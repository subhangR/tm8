import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerExecutionHandlers } from '../src/facade/execution-handlers.js';
import { HandlerRegistry } from '../src/facade/registry.js';
import type { Db, DbClaims, Querier } from '../src/db/types.js';

/**
 * A `codex` that PASSES every runtime preflight, put on PATH for this test.
 *
 * WHY IT IS NEEDED. The codex command line this file asserts is not decided by
 * the launch config alone — before building it, a spawn interrogates the
 * INSTALLED binary three times, and each answer can change or refuse the launch:
 *
 *   codex sandbox -- <cmd>        can this node confine a command at all?
 *                                 (spawn/sandbox-probe.ts). A node that cannot
 *                                 — no codex, or AppArmor's unprivileged-userns
 *                                 restriction, the state of every Ubuntu 24.04
 *                                 box — degrades the launch to
 *                                 `--dangerously-bypass-approvals-and-sandbox`.
 *   codex <-c …> features list    does this binary know `network_proxy`, and is
 *                                 it enabled? (spawn/codex-network-preflight.ts)
 *                                 A no is a `not_implemented` refusal.
 *   codex --version               is it >= 0.146.0? Older runtimes parse the
 *                                 loopback policy but cannot enforce it.
 *
 * So those answers are PINNED rather than inherited from whichever machine
 * happens to run the suite; otherwise this test reports on the host's codex
 * install instead of on what it measures (that the project, tool and model
 * reach the CLI builder through DbGraphPort). The `features list` row is the
 * real one, copied from codex-cli 0.146.0 on the node this was written against:
 *
 *     network_proxy                        experimental       true
 *
 * A REAL executable, not a mocked child_process, for the same reason
 * `packages/execution/test/spawn-sandbox-preflight.test.ts` uses one: what
 * these probes measure IS what the provider does when actually run. The
 * refusal paths are those suites' subject and stay there.
 */
const CODEX_THAT_PASSES_PREFLIGHT = `#!/bin/sh
case "$1" in
  --version) echo 'codex-cli 0.146.0'; exit 0 ;;
  sandbox) shift; [ "$1" = "--" ] && shift; exec "$@" ;;
esac
# 'features list' arrives after tm8's own -c overrides, so scan for the pair.
prev=''
for arg in "$@"; do
  if [ "$prev" = 'features' ] && [ "$arg" = 'list' ]; then
    echo 'network_proxy                        experimental       true'
    exit 0
  fi
  prev=$arg
done
exec /bin/true
`;

/**
 * The exact command line a CONFINED codex launch must render, up to the
 * developer-instructions payload.
 *
 * Written out rather than derived from `codexLoopbackConfigArgs()`, so that this
 * states independently what reaches the PTY — a test that built its expectation
 * from the same helper the builder uses would agree with any change to either.
 * The argv itself is pinned upstream in
 * `packages/execution/test/spawn-manifest.test.ts` ('builds the exact Codex argv
 * for every posture'); this is the same policy observed one seam later, after
 * shell quoting, through the server's DbGraphPort wiring.
 */
const CONFINED_CODEX_PREFIX =
  "codex --model 'gpt-5.6-sol' --ask-for-approval never --sandbox workspace-write" +
  " -c 'sandbox_workspace_write.network_access=true'" +
  " -c 'features.network_proxy.enabled=true'" +
  ' -c \'features.network_proxy.domains={"127.0.0.1"="allow", "localhost"="allow"}\'' +
  " -c 'features.network_proxy.allow_local_binding=false'" +
  ' --no-alt-screen -c ';

const SPACE = '11111111-1111-4111-8111-111111111111';
const TEAMMATE = '22222222-2222-4222-8222-222222222222';
const PROJECT = '33333333-3333-4333-8333-333333333333';
const SESSION = '44444444-4444-4444-8444-444444444444';
const PARENT_SESSION = '55555555-5555-4555-8555-555555555555';
const AUTH_SESSION = '66666666-6666-4666-8666-666666666666';

class SpawnDb implements Db {
  readonly rpcCalls: Array<{ fn: string; args: readonly unknown[] }> = [];

  async tx<T>(_claims: DbClaims, run: (q: Querier) => Promise<T>): Promise<T> {
    const q: Querier = {
      query: async <R>(sql: string): Promise<R[]> => {
        if (sql.includes('from public.team_members')) {
          return [{
            entity_id: TEAMMATE, name: 'GPT 5.6 Teammate', role: 'Launch persona',
            identity: 'OpenAI GPT 5.6 via codex', memories: [], model: 'gpt-5.6-sol',
            agent_tool: 'codex', mode: 'worker', permission_mode: null, avatar: null,
            capabilities: {}, command_permissions: {},
          }] as R[];
        }
        if (sql.includes('from public.projects')) {
          return [{ id: PROJECT, name: 'tm8', working_dir: process.cwd(), trust: 'trusted' }] as R[];
        }
        return [];
      },
      rpc: async <T2>(fn: string, rpcArgs: readonly unknown[] = []): Promise<T2> =>
        this.rpc<T2>(_claims, fn, rpcArgs),
    };
    return run(q);
  }

  async rpc<T>(_claims: DbClaims, fn: string, args: readonly unknown[] = []): Promise<T> {
    this.rpcCalls.push({ fn, args });
    if (fn === 'public.execution_spawn') {
      return { entity: { id: SESSION }, patches: [], __tm8_replayed: false } as T;
    }
    if (fn === 'internal.w2_resolve_interaction_profile_for_launch') {
      return {
        profileId: null,
        profileVersion: null,
        templateKey: 'tm8.chat.core',
        templateVersion: 1,
        resolvedHash: 'core-hash',
        source: 'core_default',
        snapshot: { profile: { source: 'core_default' } },
      } as T;
    }
    if (fn === 'public.issue_work_session_agent_session') {
      // 072 mints the spawned agent's bearer credential and returns the
      // auth_sessions row it inserted, as jsonb, minus the token hash:
      //
      //   return to_jsonb(session_row) - 'token_hash';   (072:117)
      //
      // `DbGraphPort.issueWorkSessionAgentToken` reads `id` off it and refuses
      // the launch when it is absent — correctly, because a spawn whose agent
      // holds no credential cannot write to the graph it was spawned to work
      // in. This fake previously fell through to the catch-all `{}` and so
      // asserted, in effect, that the database answers nothing; the real
      // function cannot return without an inserted row. The whole shape is
      // reproduced rather than just `id`, so the fake keeps saying what the
      // RPC says if a later reader needs another field of it.
      return {
        id: AUTH_SESSION,
        account_id: 'owner-account',
        kind: 'agent',
        acting_as_team_member_id: args[1],
        work_session_id: args[0],
        label: args[4],
        created_at: '2026-07-29T00:00:00.000Z',
        expires_at: args[3],
        last_used_at: null,
        revoked_at: null,
      } as T;
    }
    if (fn === 'internal.w2_record_interaction_profile_pin') {
      return {
        workSessionId: SESSION,
        pinRevision: 1,
        profileId: null,
        profileVersion: null,
        templateKey: 'tm8.chat.core',
        templateVersion: 1,
        resolvedHash: 'core-hash',
        source: 'core_default',
        createdAt: '2026-07-29T00:00:00.000Z',
      } as T;
    }
    return {} as T;
  }

  async query<R>(): Promise<R[]> { return []; }
  async end(): Promise<void> {}
}

describe('server spawn integration with a stub PTY', () => {
  let dataDir: string | undefined;
  let binDir: string | undefined;
  let originalPath: string | undefined;
  let originalAutoTrust: string | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (originalPath === undefined) delete process.env['PATH'];
    else process.env['PATH'] = originalPath;
    if (originalAutoTrust === undefined) delete process.env['TM8_AUTO_TRUST_WORKSPACE'];
    else process.env['TM8_AUTO_TRUST_WORKSPACE'] = originalAutoTrust;
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
    if (binDir) await rm(binDir, { recursive: true, force: true });
  });

  it('carries the project, provider tool, and concrete model through DbGraphPort into the CLI builder', async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'tm8-server-stub-pty-'));
    // `registerExecutionHandlers` takes no env, so SpawnService reads
    // `process.env` — which is also where the sandbox probe resolves `codex`.
    binDir = await mkdtemp(join(tmpdir(), 'tm8-server-stub-pty-bin-'));
    await writeFile(join(binDir, 'codex'), CODEX_THAT_PASSES_PREFLIGHT, 'utf8');
    await chmod(join(binDir, 'codex'), 0o755);
    originalPath = process.env['PATH'];
    process.env['PATH'] = `${binDir}:${originalPath ?? ''}`;
    // The launch seeds the CLI's per-workspace trust record before spawning, and
    // this test's cwd is the repo — no unit test should be appending a project
    // table to the developer's own ~/.codex/config.toml to prove a command line.
    originalAutoTrust = process.env['TM8_AUTO_TRUST_WORKSPACE'];
    process.env['TM8_AUTO_TRUST_WORKSPACE'] = 'false';
    const db = new SpawnDb();
    const spawnIfAbsent = vi.fn(() => ({ reused: false }));
    const pty = {
      beginPromptHandoff: vi.fn(),
      spawnIfAbsent,
      waitForBootSettlement: vi.fn(async () => null),
      liveSessionIds: () => [],
    };
    const runtime = registerExecutionHandlers(new HandlerRegistry(), {
      db,
      pty: pty as never,
      dataDir,
      config: { host: '127.0.0.1', port: 4610 } as never,
      owner: async () => ({
        identityId: 'owner-identity', accountId: 'owner-account', username: 'owner',
        isNodeAdmin: true, isOwner: true,
      }),
    });

    const result = await runtime.spawnService.spawn(
      { identityId: 'owner-identity', nodeAdmin: true },
      {
        spaceId: SPACE,
        teamMemberId: TEAMMATE,
        parentSessionId: PARENT_SESSION,
        projectId: PROJECT,
        workdir: { mode: 'project' },
        mode: 'worker',
        model: 'gpt-5.6-sol',
        agentTool: 'codex',
        clientMutationId: 'spawn-stub-pty-1',
      },
    );

    expect(result.sessionId).toBe(SESSION);
    expect(spawnIfAbsent).toHaveBeenCalledOnce();
    expect(spawnIfAbsent).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: SESSION,
      cwd: process.cwd(),
      command: expect.stringMatching(
        new RegExp(`^${CONFINED_CODEX_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
      ),
      env: expect.objectContaining({
        TM8_MODEL: 'gpt-5.6-sol',
        TM8_AGENT_TOOL: 'codex',
        TM8_PROJECT_ID: PROJECT,
        // The minted credential reaches the child, and carries the auth session
        // the mint returned — `tm8s_<authSessionId>.<secret>` (identity/crypto
        // formatToken). Asserted so the fake's answer above is load-bearing:
        // without it, a mint that returned the wrong row would still pass.
        TM8_AGENT_TOKEN: expect.stringMatching(new RegExp(`^tm8s_${AUTH_SESSION}\\.[\\w-]+$`)),
      }),
    }));
    expect(db.rpcCalls.find(({ fn }) => fn === 'public.execution_spawn')?.args)
      .toEqual(expect.arrayContaining([PROJECT, 'project', 'gpt-5.6-sol', 'codex']));
    expect(db.rpcCalls.find(({ fn }) => fn === 'public.execution_spawn')?.args.at(-1))
      .toBe(PARENT_SESSION);
  });
});
