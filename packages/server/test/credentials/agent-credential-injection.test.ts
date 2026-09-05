// PR5 — the gate that decides whether a spawn gets a member's own credential.
//
// The interesting assertions here are all NEGATIVE, and each one is a specific
// way this feature could silently do the wrong thing:
//
//  * inject for a member who has not connected -> `CLAUDE_CONFIG_DIR` REPLACES
//    the default config location, so an empty per-identity directory means an
//    agent with NO authentication at all. That is a total launch regression for
//    every unconnected member, and it is the failure an over-eager version of
//    this file produces.
//  * inject on a `stale` or `revoked` row -> a member whose credential has
//    expired silently falls back to the node's identity. Their work is then
//    attributed to the machine account under their name, which is the exact lie
//    this build exists to stop telling.
//  * inject for a tool that authenticates against nothing -> `echo-agent` and
//    operator wrappers must not be guessed at.
//
// The query is asserted to run under the CALLER'S claims with no account
// parameter, because 082's RLS (`account_id = internal.current_account_id()`)
// is what scopes it and there is deliberately no node-admin bypass to lean on.

import { describe, expect, it } from 'vitest';

import {
  AGENT_TOOLS_BY_CREDENTIAL_PROVIDER,
  DbAgentCredentialHome,
  credentialProviderForAgentTool,
} from '../../src/credentials/agent-credential-injection.js';
import type { Db, DbClaims } from '../../src/db/types.js';

const DATA_DIR = '/var/lib/tm8';
const IDENTITY = 'identity-alice';
const CLAIMS: DbClaims = { identityId: IDENTITY, actorId: 'actor-1' };

interface RecordedQuery {
  claims: DbClaims;
  sql: string;
  params: readonly unknown[] | undefined;
}

/**
 * A Db that records what it was asked and answers with fixed rows.
 *
 * A stub rather than a real Postgres on purpose: what is under test here is the
 * DECISION (which rows count as connected, which key builds the path, whether
 * the query is scoped by claims), not the RLS policy — that is 082's own
 * real-DB suite and PR1 already proved it with 22 tests.
 */
function stubDb(rows: Array<{ provider: string }>, recorded: RecordedQuery[]): Db {
  return {
    async query(claims: DbClaims, sql: string, params?: readonly unknown[]) {
      recorded.push({ claims, sql, params });
      return rows as never;
    },
    async rpc() {
      throw new Error('resolving a credential home must never write');
    },
    async tx() {
      throw new Error('unexpected tx');
    },
    async end() {},
  } as unknown as Db;
}

function resolver(rows: Array<{ provider: string }>, recorded: RecordedQuery[] = []) {
  return new DbAgentCredentialHome({ db: stubDb(rows, recorded), dataDir: DATA_DIR });
}

describe('DbAgentCredentialHome', () => {
  it('uses the execution tool map in both directions for every file-shaped provider', () => {
    expect(AGENT_TOOLS_BY_CREDENTIAL_PROVIDER).toEqual({
      anthropic: ['claude-code'],
      openai: ['codex'],
      gemini: ['gemini'],
      hermes: ['hermes'],
      cursor: ['cursor'],
    });
    for (const [provider, tools] of Object.entries(AGENT_TOOLS_BY_CREDENTIAL_PROVIDER)) {
      for (const tool of tools) expect(credentialProviderForAgentTool(tool)).toBe(provider);
    }
  });

  it('resolves an active anthropic credential to PR2 credential-home layout', async () => {
    const recorded: RecordedQuery[] = [];
    const home = await resolver([{ provider: 'anthropic' }], recorded).resolve(CLAIMS, {
      agentTool: 'claude-code',
    });

    // Keyed on identityId, and byte-identical to what PR2's login terminal
    // writes. An agent reading any other path reads a directory nobody wrote.
    expect(home).toEqual({
      provider: 'anthropic',
      homeDir: `${DATA_DIR}/credentials/${IDENTITY}`,
      configDir: `${DATA_DIR}/credentials/${IDENTITY}/anthropic`,
    });

    // Scoped by the caller's own claims, and no account id is passed in —
    // RLS decides whose row this is, not this layer.
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.claims).toBe(CLAIMS);
    expect(recorded[0]?.params).toEqual(['anthropic']);
    expect(recorded[0]?.sql).not.toMatch(/account_id/i);
  });

  it('resolves codex to the openai provider directory', async () => {
    const home = await resolver([{ provider: 'openai' }]).resolve(CLAIMS, { agentTool: 'codex' });
    expect(home?.provider).toBe('openai');
    expect(home?.configDir).toBe(`${DATA_DIR}/credentials/${IDENTITY}/openai`);
  });

  it.each([
    ['gemini', 'gemini'],
    ['hermes', 'hermes'],
    ['cursor', 'cursor'],
  ] as const)('resolves the %s tool to its own %s provider directory', async (agentTool, provider) => {
    const recorded: RecordedQuery[] = [];
    const home = await resolver([{ provider }], recorded).resolve(CLAIMS, { agentTool });

    expect(home).toEqual({
      provider,
      homeDir: `${DATA_DIR}/credentials/${IDENTITY}`,
      configDir: `${DATA_DIR}/credentials/${IDENTITY}/${provider}`,
    });
    expect(recorded[0]?.params).toEqual([provider]);
  });

  it('returns null when the member has not connected this provider', async () => {
    // The ordinary case, and NOT an error. Injecting here would hand the member
    // an empty config directory and therefore an unauthenticated agent.
    const home = await resolver([]).resolve(CLAIMS, { agentTool: 'claude-code' });
    expect(home).toBeNull();
  });

  it('never queries at all for a tool that authenticates against nothing', async () => {
    const recorded: RecordedQuery[] = [];
    const home = await resolver([{ provider: 'anthropic' }], recorded).resolve(CLAIMS, {
      agentTool: 'echo-agent',
    });

    expect(home).toBeNull();
    expect(recorded).toHaveLength(0);
  });

  it('returns null, without querying, when there is no identity in the claims', async () => {
    const recorded: RecordedQuery[] = [];
    const home = await resolver([{ provider: 'anthropic' }], recorded).resolve(
      {} as DbClaims,
      { agentTool: 'claude-code' },
    );

    expect(home).toBeNull();
    expect(recorded).toHaveLength(0);
  });

  it('asks only for ACTIVE credentials, so stale and revoked never inject', async () => {
    const recorded: RecordedQuery[] = [];
    await resolver([{ provider: 'anthropic' }], recorded).resolve(CLAIMS, {
      agentTool: 'claude-code',
    });

    // Asserted on the predicate rather than by feeding a 'stale' row back,
    // because the stub cannot enforce a WHERE clause — the filter has to be in
    // the SQL or it is nowhere.
    expect(recorded[0]?.sql).toContain("status = 'active'");
  });
});
