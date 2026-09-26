/**
 * Lane K, hard rule: THE TYPESAFE KEY IS NEVER GIVEN TO A SPAWNED SESSION.
 *
 * A member who has stored a TypeSafe key (and a node whose own environment has
 * `TYPESAFE_API_KEY`) spawns a real session through `SpawnService`, the same
 * path production takes. Nothing TypeSafe may appear in what the PTY is handed
 * (env and command), in the manifest, or in any file under the node's data
 * directory — the member's credential home included — and spawn must not even
 * ask for the key.
 *
 * NEGATIVE CONTROL: the same spawn with the key pushed through a variable the
 * spawn allowlist DOES forward. The detector must find it there, which is what
 * makes its silence in the first test a measurement rather than a blind spot.
 */
import { CollabError } from '@tm8/contract';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SERVICE_KEY_PROVIDERS } from '../../src/credentials/service-key-store.js';
import type { Db, DbClaims, Querier } from '../../src/db/types.js';
import { registerExecutionHandlers } from '../../src/facade/execution-handlers.js';
import { HandlerRegistry } from '../../src/facade/registry.js';

const SPACE = '11111111-1111-4111-8111-111111111111';
const TEAMMATE = '22222222-2222-4222-8222-222222222222';
const PROJECT = '33333333-3333-4333-8333-333333333333';
const SESSION = '44444444-4444-4444-8444-444444444444';
const AUTH_SESSION = '66666666-6666-4666-8666-666666666666';

const MEMBER_KEY = 'ts_member_stored_key_0123456789MEMB';
const NODE_KEY = 'ts_node_env_key_9876543210NODE';

/** The spawn path's database, holding a stored TypeSafe key for the member. */
class SpawnDb implements Db {
  readonly rpcCalls: string[] = [];

  async tx<T>(claims: DbClaims, run: (q: Querier) => Promise<T>): Promise<T> {
    return run({
      query: async <R>(sql: string): Promise<R[]> => {
        if (sql.includes('from public.team_members')) {
          return [{
            entity_id: TEAMMATE, name: 'Claude Teammate', role: 'worker', identity: 'persona', memories: [],
            model: 'claude-sonnet-5', agent_tool: 'claude-code', mode: 'worker', permission_mode: null,
            avatar: null, capabilities: {}, command_permissions: {},
          }] as R[];
        }
        if (sql.includes('from public.projects') || sql.includes('public.resolve_project_ref')) {
          return [{ id: PROJECT, name: 'tm8', working_dir: process.cwd(), trust: 'trusted' }] as R[];
        }
        return [];
      },
      rpc: async <T2>(fn: string, args: readonly unknown[] = []): Promise<T2> => this.rpc<T2>(claims, fn, args),
    });
  }

  async rpc<T>(_claims: DbClaims, fn: string): Promise<T> {
    this.rpcCalls.push(fn);
    if (fn === 'public.execution_spawn') return { entity: { id: SESSION }, patches: [], __tm8_replayed: false } as T;
    // 256 (W7p): the spawn port re-resolves the minted token to read its
    // via_link stamp. The real mint always resolves; no link here.
    if (fn === 'resolve_auth_session') return { sessionId: AUTH_SESSION, viaLinkId: null } as T;
    if (fn === 'public.issue_work_session_agent_session') return { id: AUTH_SESSION } as T;
    if (fn === 'internal.w2_resolve_interaction_profile_for_launch') {
      return {
        profileId: null, profileVersion: null, templateKey: 'tm8.chat.core', templateVersion: 1,
        resolvedHash: 'core-hash', source: 'core_default', snapshot: { profile: { source: 'core_default' } },
      } as T;
    }
    if (fn === 'internal.w2_record_interaction_profile_pin') {
      return {
        workSessionId: SESSION, pinRevision: 1, profileId: null, profileVersion: null, templateKey: 'tm8.chat.core',
        templateVersion: 1, resolvedHash: 'core-hash', source: 'core_default', createdAt: '2026-09-23T00:00:00.000Z',
      } as T;
    }
    if (fn === 'read_account_git_credential') return null as T;
    // As 206's read_space_credential_for_spawn answers a space with no default:
    // P0002, which the Db maps to a CollabError carrying the reason.
    if (fn === 'read_space_credential_for_spawn') {
      throw new CollabError('not_found', 'this space has no default credential', { details: { reason: 'no_default' } });
    }
    // The member HAS a stored key: were spawn ever to ask, it would get one.
    if (fn === 'read_account_service_key') {
      return { accountId: 'owner-account', provider: 'typesafe', keyCiphertext: Buffer.from(MEMBER_KEY).toString('base64'), keyNonce: '' } as T;
    }
    return {} as T;
  }

  // The member ALSO has a connected Anthropic login, so spawn resolves and
  // injects their per-identity credential home — the place a key file could
  // most plausibly have been left for an agent to find.
  async query<R>(_claims: DbClaims, sql: string): Promise<R[]> {
    if (sql.includes('account_agent_credentials')) return [{ provider: 'anthropic' }] as R[];
    return [];
  }
  async end(): Promise<void> {}
}

async function stubClaudeOnPath(): Promise<string> {
  const binDir = await mkdtemp(join(tmpdir(), 'tm8-stub-bin-'));
  await writeFile(join(binDir, 'claude'), '#!/bin/sh\necho "claude 999.0.0"\n', { mode: 0o755 });
  vi.stubEnv('PATH', `${binDir}:${process.env['PATH'] ?? ''}`);
  return binDir;
}

async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries.filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name));
}

/** Every place a TypeSafe key or name could have reached. Empty means none. */
function typesafeLeaks(surface: { env: Record<string, string>; command: string; manifest: unknown; files: Record<string, string> }): string[] {
  const secrets = [MEMBER_KEY, NODE_KEY];
  const hit = (text: string) => /typesafe/i.test(text) || secrets.some((secret) => text.includes(secret));
  return [
    ...Object.entries(surface.env).filter(([k, v]) => hit(k) || hit(v)).map(([k]) => `env:${k}`),
    ...(hit(surface.command) ? ['command'] : []),
    ...(hit(JSON.stringify(surface.manifest)) ? ['manifest'] : []),
    ...Object.entries(surface.files).filter(([, text]) => hit(text)).map(([path]) => `file:${path}`),
  ];
}

async function spawnWithStoredKey(dataDir: string) {
  // The member's Anthropic login, as the login terminal would have left it.
  const anthropicHome = join(dataDir, 'credentials', 'owner-identity', 'anthropic');
  await mkdir(anthropicHome, { recursive: true, mode: 0o700 });
  await writeFile(join(anthropicHome, '.credentials.json'), '{"claudeAiOauth":{"accessToken":"sk-ant-member"}}', { mode: 0o600 });
  const db = new SpawnDb();
  const spawnIfAbsent = vi.fn(() => ({ reused: false }));
  const runtime = registerExecutionHandlers(new HandlerRegistry(), {
    db,
    pty: { beginPromptHandoff: vi.fn(), spawnIfAbsent, waitForBootSettlement: vi.fn(async () => null), liveSessionIds: () => [] } as never,
    dataDir,
    config: { host: '127.0.0.1', port: 4610 } as never,
    owner: async () => ({ identityId: 'owner-identity', accountId: 'owner-account', username: 'owner', isNodeAdmin: true, isOwner: true }),
  });
  const result = await runtime.spawnService.spawn(
    { identityId: 'owner-identity', nodeAdmin: true },
    {
      spaceId: SPACE, teamMemberId: TEAMMATE, projectId: PROJECT, workdir: { mode: 'project' }, mode: 'worker',
      accessMode: 'acceptEdits', model: 'claude-sonnet-5', agentTool: 'claude-code',
      clientMutationId: `svckey-spawn-${String(Math.random())}`,
    },
  );
  const handed = spawnIfAbsent.mock.calls[0]?.[0] as unknown as { env: Record<string, string>; command: string };
  const files: Record<string, string> = {};
  for (const path of await filesUnder(dataDir)) files[path] = await readFile(path, 'utf8').catch(() => '');
  return { db, handed, manifest: result.manifest, files };
}

describe('a stored TypeSafe key never reaches a spawned session', () => {
  let dataDir: string | undefined;
  let binDir: string | undefined;
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
    if (binDir) await rm(binDir, { recursive: true, force: true });
  });

  it('is marked not-injected in the service key table', () => {
    for (const provider of Object.values(SERVICE_KEY_PROVIDERS)) expect(provider.injectedAtSpawn).toBe(false);
  });

  it('spawn with a stored member key AND a node TYPESAFE_API_KEY carries nothing TypeSafe anywhere', async () => {
    binDir = await stubClaudeOnPath();
    dataDir = await mkdtemp(join(tmpdir(), 'tm8-svckey-spawn-'));
    vi.stubEnv('TYPESAFE_API_KEY', NODE_KEY);

    const { db, handed, manifest, files } = await spawnWithStoredKey(dataDir);

    expect(handed).toBeDefined();
    // The sweep saw real spawn output: the manifest AND the member's
    // credential home, which spawn really did hand the session.
    expect(Object.keys(files).some((path) => path.includes('/manifests/'))).toBe(true);
    expect(Object.keys(files).some((path) => path.includes('/credentials/owner-identity/'))).toBe(true);
    expect(handed.env['CLAUDE_CONFIG_DIR']).toBe(join(dataDir, 'credentials', 'owner-identity', 'anthropic'));
    expect(typesafeLeaks({ env: handed.env, command: handed.command, manifest, files })).toEqual([]);
    // Spawn never even asks for the key.
    expect(db.rpcCalls).not.toContain('read_account_service_key');
    // The manifest's credential table names no TypeSafe provider at all.
    expect(Object.keys((manifest as { launch: { credentialSources: object } }).launch.credentialSources))
      .not.toContain('typesafe');
  });

  it('NEGATIVE CONTROL: the key pushed through a forwarded variable is caught', async () => {
    binDir = await stubClaudeOnPath();
    dataDir = await mkdtemp(join(tmpdir(), 'tm8-svckey-spawn-'));
    // OPENAI_API_KEY is on the spawn allowlist and, for a claude-code session,
    // not suppressed by the member's Anthropic home: this is the injection the
    // rule forbids, done on purpose, so the detector must go red.
    vi.stubEnv('OPENAI_API_KEY', NODE_KEY);

    const { handed, manifest, files } = await spawnWithStoredKey(dataDir);

    expect(typesafeLeaks({ env: handed.env, command: handed.command, manifest, files })).toContain('env:OPENAI_API_KEY');
  });
});
