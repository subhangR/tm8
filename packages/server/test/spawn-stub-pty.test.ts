import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerExecutionHandlers } from '../src/facade/execution-handlers.js';
import { HandlerRegistry } from '../src/facade/registry.js';
import type { Db, DbClaims, Querier } from '../src/db/types.js';

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
      // The real function returns the inserted auth_sessions row as jsonb minus
      // token_hash (072_session_io_routes.sql); the mint only reads `.id`, and
      // refuses with upstream_unavailable when it is absent. The catch-all `{}`
      // below is that refusal, so this stub has to answer explicitly.
      return { id: AUTH_SESSION } as T;
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
    if (fn === 'read_account_git_credential') {
      // No member GitHub row in this fixture. The RPC's real absent shape is
      // SQL NULL, not the catch-all object used by unrelated fake calls.
      return null as T;
    }
    return {} as T;
  }

  async query<R>(): Promise<R[]> { return []; }
  async end(): Promise<void> {}
}

/**
 * A `codex` on PATH that answers the two questions the spawn gate asks, and
 * nothing else.
 *
 * `SpawnService.assertAgentRuntime` resolves the agent binary on PATH and then,
 * for codex outside bypassPermissions, EXECUTES it twice —
 * `preflightCodexNetworkPolicy` runs `features list` and `--version` and fails
 * closed on either. This suite's subject is what reaches the CLI builder, not
 * Codex's runtime, and it was passing only on machines with a real Codex
 * installed; a bare runner answered `agent CLI 'codex' was not found`. An empty
 * file would not do: `existsSync` would accept it and the preflight would then
 * fail on the exec.
 */
async function stubCodexOnPath(): Promise<string> {
  const binDir = await mkdtemp(join(tmpdir(), 'tm8-stub-bin-'));
  await writeFile(
    join(binDir, 'codex'),
    '#!/bin/sh\n'
      + 'if [ "$1" = "sandbox" ]; then echo "TM8_SANDBOX_PROBE_OK"; exit 0; fi\n'
      + 'case "$*" in\n'
      + '  *--version*) echo "codex-cli 999.0.0" ;;\n'
      + '  *) echo "network_proxy   stable   true" ;;\n'
      + 'esac\n',
    { mode: 0o755 },
  );
  vi.stubEnv('PATH', `${binDir}:${process.env['PATH'] ?? ''}`);
  return binDir;
}

describe('server spawn integration with a stub PTY', () => {
  let dataDir: string | undefined;
  let binDir: string | undefined;
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
    if (binDir) await rm(binDir, { recursive: true, force: true });
  });

  it('carries the project, provider tool, and concrete model through DbGraphPort into the CLI builder', async () => {
    binDir = await stubCodexOnPath();
    dataDir = await mkdtemp(join(tmpdir(), 'tm8-server-stub-pty-'));
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
        // The command assertion is specifically the workspace-write posture;
        // make it request-owned so a node-wide test-runner override cannot
        // silently turn this unrelated integration test into full access.
        accessMode: 'acceptEdits',
        model: 'gpt-5.6-sol',
        agentTool: 'codex',
        credentialSources: { openai: 'node', github: 'member' },
        clientMutationId: 'spawn-stub-pty-1',
      },
    );

    expect(result.sessionId).toBe(SESSION);
    expect(result.manifest.launch.credentialSources).toEqual({
      anthropic: null,
      openai: 'node',
      github: 'member',
    });
    expect(spawnIfAbsent).toHaveBeenCalledOnce();
    expect(spawnIfAbsent).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: SESSION,
      cwd: process.cwd(),
      // The `.*` is the codex loopback network policy, not slack: for
      // agentTool 'codex' outside bypassPermissions, `resolveCommandNetworkPolicy`
      // renders CODEX_LOOPBACK_CONFIG_OVERRIDES between `--sandbox
      // workspace-write` and `--no-alt-screen`. This pattern predates that and
      // matched nothing once it landed. The overrides are asserted by name just
      // below so the wildcard cannot swallow their disappearance; their contents
      // are owned by test/codex-loopback.integration.test.ts in packages/execution.
      command: expect.stringMatching(
        /^codex --model 'gpt-5\.6-sol' --ask-for-approval never --sandbox workspace-write .*--no-alt-screen -c /,
      ),
      env: expect.objectContaining({
        TM8_MODEL: 'gpt-5.6-sol',
        TM8_AGENT_TOOL: 'codex',
        TM8_PROJECT_ID: PROJECT,
      }),
    }));
    // Names the wildcard's contents, so the pattern above cannot pass on a
    // command that lost the loopback policy entirely.
    const rendered = spawnIfAbsent.mock.calls[0]?.[0] as unknown as { command: string };
    expect(rendered.command).toContain("features.network_proxy.enabled=true");
    expect(db.rpcCalls.find(({ fn }) => fn === 'public.execution_spawn')?.args)
      .toEqual(expect.arrayContaining([PROJECT, 'project', 'gpt-5.6-sol', 'codex']));
    expect(db.rpcCalls.find(({ fn }) => fn === 'public.execution_spawn')?.args.at(-1))
      .toBe(PARENT_SESSION);
  });
});
