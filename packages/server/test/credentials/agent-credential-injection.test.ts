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
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  API_KEY_CREDENTIAL_PROVIDERS,
  API_KEY_FILENAME,
  apiKeyBackendAgentTool,
  apiKeyBackendDisplaces,
  isApiKeyBackend,
  isApiKeyCredentialProvider,
} from '@tm8/execution';

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
    // The API-key backends are in this table because it answers "where can this
    // credential REACH", not "where did it come from". Disconnect reads it to
    // find the live processes that may still hold the provider, and a `kimi`
    // row reporting no tools would revoke the index row, leave every
    // `claude-code` process running with the key still in its environment, and
    // report success.
    expect(AGENT_TOOLS_BY_CREDENTIAL_PROVIDER).toEqual({
      anthropic: ['claude-code'],
      openai: ['codex'],
      gemini: ['gemini'],
      hermes: ['hermes'],
      cursor: ['cursor'],
      kimi: ['claude-code'],
      groq: ['codex'],
      // Both codex backends REACH codex, and both must be listed. This table
      // answers containment, not precedence: a member who connected Grok and is
      // outranked by Groq still has the Grok key nowhere, but a member who
      // connected only Grok has it in every live `codex` process. A projection
      // that dropped the losing backend would make Disconnect miss exactly the
      // processes that hold the key.
      grok: ['codex'],
    });

    // THE REVERSE DIRECTION IS NO LONGER ONE-TO-ONE, AND IS DELIBERATELY NOT
    // ASSERTED AS IF IT WERE. `credentialProviderForAgentTool` reads execution's
    // tool-to-provider table, which names the provider a tool NATIVELY
    // authenticates with: `claude-code` answers `anthropic` there even for a
    // member whose sessions run on Kimi. That is the property that stops a
    // backend from displacing Anthropic for members who never connected one, so
    // widening this loop to demand `claude-code -> kimi` would be asserting a
    // containment hole rather than a fix.
    //
    // The round trip is therefore checked for the NATIVE providers, and the
    // backends are checked against the thing they actually claim — that each one
    // reaches exactly the tool it routes, whose native provider is the one it
    // displaces.
    for (const [provider, tools] of Object.entries(AGENT_TOOLS_BY_CREDENTIAL_PROVIDER)) {
      // Keyed on backend-hood, not on credential shape: a native api-key
      // provider such as `gemini` round-trips exactly like a file-shaped one.
      if (isApiKeyCredentialProvider(provider) && isApiKeyBackend(provider)) continue;
      for (const tool of tools) expect(credentialProviderForAgentTool(tool)).toBe(provider);
    }
    // Only the BACKENDS make that claim. `API_KEY_CREDENTIAL_PROVIDERS` also
    // holds `gemini`, which is an api-key provider that backs nothing — it
    // reaches its own `gemini` tool through the native table in the first loop
    // above, and `apiKeyBackendAgentTool` answers `null` for it. Running it
    // through this loop would compare against `[null]` and assert a claim
    // nobody makes.
    for (const provider of API_KEY_CREDENTIAL_PROVIDERS) {
      const agentTool = apiKeyBackendAgentTool(provider);
      if (agentTool === null) {
        // The native half, asserted rather than skipped: a non-backend gets its
        // tools from the same table every file-shaped provider uses, and
        // displaces nobody.
        expect(isApiKeyBackend(provider)).toBe(false);
        expect(apiKeyBackendDisplaces(provider)).toBeNull();
        for (const tool of AGENT_TOOLS_BY_CREDENTIAL_PROVIDER[provider]) {
          expect(credentialProviderForAgentTool(tool)).toBe(provider);
        }
        continue;
      }
      expect(isApiKeyBackend(provider)).toBe(true);
      expect(AGENT_TOOLS_BY_CREDENTIAL_PROVIDER[provider]).toEqual([agentTool]);
      expect(credentialProviderForAgentTool(agentTool)).toBe(apiKeyBackendDisplaces(provider));
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
    // ONE parameter, not one per provider: the query is
    // `provider = any($1::text[])`, so a single round trip answers for the
    // API-key backend and the native provider together. The ORDER inside it is
    // the preference order and is asserted here — `kimi` first, because a
    // connected key is the account-wide default and outranks the native login.
    // Reordering this array silently changes which vendor every `claude-code`
    // session of a doubly-connected member runs on.
    expect(recorded[0]?.params).toEqual([['kimi', 'anthropic']]);
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
    // No API-key backend routes these three tools, so the candidate array holds
    // the native provider alone — still one array parameter, not a bare string.
    expect(recorded[0]?.params).toEqual([[provider]]);
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

/**
 * A NATIVE API-KEY PROVIDER RESOLVES DOWN TWO PATHS, AND ONLY ONE OF THEM IS
 * NEW.
 *
 * `gemini` joining `API_KEY_CREDENTIAL_PROVIDERS` re-pointed an existing branch
 * at it: every api-key provider whose key file could not be read returned
 * `null`, on the reasoning that a backend with no key has nothing else to fall
 * back to. That reasoning does not hold for Gemini. An OAuth-connected member
 * has an active row, a config directory holding `oauth_creds.json`, and no
 * pasted key — so the unchanged branch would have stopped injecting for every
 * one of them the moment this shipped, turning a working session into an
 * unauthenticated one with nothing in the product that changed.
 *
 * The distinction the code now draws is SECOND ROUTE OR NO SECOND ROUTE, and
 * these two cases are the two sides of it.
 */
describe('DbAgentCredentialHome — gemini resolves by key OR by file', () => {
  const IDENTITY_B = 'identity-bob';
  const CLAIMS_B: DbClaims = { identityId: IDENTITY_B, actorId: 'actor-2' };

  function dataDirWithKey(provider: string | null, key: string): string {
    const dataDir = mkdtempSync(join(tmpdir(), 'tm8-inject-'));
    if (provider !== null) {
      const dir = join(dataDir, 'credentials', IDENTITY_B, provider);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(join(dir, API_KEY_FILENAME), key, { mode: 0o600 });
    }
    return dataDir;
  }

  function resolveGemini(dataDir: string, rows: Array<{ provider: string }>) {
    return new DbAgentCredentialHome({ db: stubDb(rows, []), dataDir }).resolve(CLAIMS_B, {
      agentTool: 'gemini',
    });
  }

  it('carries the pasted key when the member has one', async () => {
    const dataDir = dataDirWithKey('gemini', 'AIzaMemberKey\n');
    const home = await resolveGemini(dataDir, [{ provider: 'gemini' }]);

    // Trimmed: the paste harness writes a trailing newline, and a newline
    // inside an API header is a request that fails for a reason nobody would
    // guess from the message.
    expect(home?.apiKey).toBe('AIzaMemberKey');
    expect(home?.provider).toBe('gemini');
    expect(home?.configDir).toBe(join(dataDir, 'credentials', IDENTITY_B, 'gemini'));
  });

  it('still injects the home when the member connected by OAuth and has no key', async () => {
    // THE REGRESSION GUARD. No key file exists at all, and the correct result
    // is the file-shaped home this provider has always been given — not null.
    const dataDir = dataDirWithKey(null, '');
    const home = await resolveGemini(dataDir, [{ provider: 'gemini' }]);

    expect(home).not.toBeNull();
    expect(home?.provider).toBe('gemini');
    expect(home?.homeDir).toBe(join(dataDir, 'credentials', IDENTITY_B));
    // No key, and none invented. `composeEnv` sets `GEMINI_API_KEY` only when
    // this field is present, so its absence is what keeps the OAuth member on
    // their file credential instead of an empty variable.
    expect(home?.apiKey).toBeUndefined();
  });

  it('but a BACKEND with no key still injects nothing, which is the older rule intact', async () => {
    // Kimi has no second route: the key IS the credential. Falling through here
    // would hand the session an empty Anthropic config directory and an agent
    // with no authentication, which is the failure the `null` exists to avoid.
    const dataDir = dataDirWithKey(null, '');
    const home = await new DbAgentCredentialHome({
      db: stubDb([{ provider: 'kimi' }], []),
      dataDir,
    }).resolve(CLAIMS_B, { agentTool: 'claude-code' });

    expect(home).toBeNull();
  });
})
;
