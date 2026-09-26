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
  API_KEY_CREDENTIAL_PROVIDERS,
  apiKeyBackendAgentTool,
  apiKeyBackendNativeProvider,
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
    });

    // THE REVERSE DIRECTION IS NO LONGER ONE-TO-ONE, AND IS DELIBERATELY NOT
    // ASSERTED AS IF IT WERE. `credentialProviderForAgentTool` reads execution's
    // tool-to-provider table, which names the provider a tool NATIVELY
    // authenticates with: `claude-code` answers `anthropic` there even for a
    // member who has Kimi connected, because only a Kimi MODEL is routed to the
    // Kimi key (`apiKeyBackendForModel`). Widening this loop to demand
    // `claude-code -> kimi` would be asserting a containment hole rather than a
    // fix.
    //
    // The round trip is therefore checked for the NATIVE providers, and the
    // backends are checked against the thing they actually claim — that each one
    // reaches exactly the tool it routes, whose native provider keeps serving
    // that tool's other models.
    for (const [provider, tools] of Object.entries(AGENT_TOOLS_BY_CREDENTIAL_PROVIDER)) {
      if (isApiKeyCredentialProvider(provider)) continue;
      for (const tool of tools) expect(credentialProviderForAgentTool(tool)).toBe(provider);
    }
    for (const backend of API_KEY_CREDENTIAL_PROVIDERS) {
      const agentTool = apiKeyBackendAgentTool(backend);
      expect(AGENT_TOOLS_BY_CREDENTIAL_PROVIDER[backend]).toEqual([agentTool]);
      expect(credentialProviderForAgentTool(agentTool)).toBe(apiKeyBackendNativeProvider(backend));
    }
  });

  it('resolves an active anthropic credential to PR2 credential-home layout', async () => {
    const recorded: RecordedQuery[] = [];
    const home = await resolver([{ provider: 'anthropic' }], recorded).resolve(CLAIMS, {
      agentTool: 'claude-code',
      model: 'claude-opus-5-5',
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
    // Exactly ONE provider is asked for: the one the model is served by. A
    // Claude model never looks at the Kimi row at all, so connecting Kimi
    // cannot change which account a Claude session runs on.
    expect(recorded[0]?.params).toEqual(['anthropic']);
    expect(recorded[0]?.sql).not.toMatch(/account_id/i);
  });

  it('resolves codex to the openai provider directory', async () => {
    const home = await resolver([{ provider: 'openai' }]).resolve(CLAIMS, {
      agentTool: 'codex',
      model: 'gpt-6-astra',
    });
    expect(home?.provider).toBe('openai');
    expect(home?.configDir).toBe(`${DATA_DIR}/credentials/${IDENTITY}/openai`);
  });

  it.each([
    ['gemini', 'gemini'],
    ['hermes', 'hermes'],
    ['cursor', 'cursor'],
  ] as const)('resolves the %s tool to its own %s provider directory', async (agentTool, provider) => {
    const recorded: RecordedQuery[] = [];
    const home = await resolver([{ provider }], recorded).resolve(CLAIMS, { agentTool, model: null });

    expect(home).toEqual({
      provider,
      homeDir: `${DATA_DIR}/credentials/${IDENTITY}`,
      configDir: `${DATA_DIR}/credentials/${IDENTITY}/${provider}`,
    });
    // No API-key backend routes these three tools: the native provider alone.
    expect(recorded[0]?.params).toEqual([provider]);
  });

  it('returns null when the member has not connected this provider', async () => {
    // The ordinary case, and NOT an error. Injecting here would hand the member
    // an empty config directory and therefore an unauthenticated agent.
    const home = await resolver([]).resolve(CLAIMS, { agentTool: 'claude-code', model: 'opus' });
    expect(home).toBeNull();
  });

  it('never queries at all for a tool that authenticates against nothing', async () => {
    const recorded: RecordedQuery[] = [];
    const home = await resolver([{ provider: 'anthropic' }], recorded).resolve(CLAIMS, {
      agentTool: 'echo-agent',
      model: null,
    });

    expect(home).toBeNull();
    expect(recorded).toHaveLength(0);
  });

  it('returns null, without querying, when there is no identity in the claims', async () => {
    const recorded: RecordedQuery[] = [];
    const home = await resolver([{ provider: 'anthropic' }], recorded).resolve(
      {} as DbClaims,
      { agentTool: 'claude-code', model: 'opus' },
    );

    expect(home).toBeNull();
    expect(recorded).toHaveLength(0);
  });

  /**
   * EACH MODEL RUNS ON ITS OWN VENDOR'S CREDENTIAL.
   *
   * This replaced an account-wide override (#638), under which a connected Kimi
   * key took over EVERY `claude-code` session, Claude models included, and the
   * Anthropic card said "Not currently used". The stub answers with both rows
   * whatever it is asked, so these tests see the resolver's own choice, not a
   * WHERE clause doing the work.
   */
  it.each([
    ['claude-opus-5-5', 'anthropic'],
    ['claude-sonnet-5', 'anthropic'],
    ['opus', 'anthropic'],
    [null, 'anthropic'],
    ['kimi-k2-thinking', 'kimi'],
    ['kimi-k2-turbo-preview', 'kimi'],
  ] as const)(
    'with Kimi AND Anthropic connected, claude-code model %s runs on %s',
    async (model, expected) => {
      const recorded: RecordedQuery[] = [];
      const home = await resolver(
        [{ provider: 'kimi' }, { provider: 'anthropic' }],
        recorded,
      ).resolve(CLAIMS, { agentTool: 'claude-code', model });

      expect(home?.provider).toBe(expected);
      expect(home?.configDir).toBe(`${DATA_DIR}/credentials/${IDENTITY}/${expected}`);
      expect(recorded[0]?.params).toEqual([expected]);
    },
  );

  it.each([
    ['gpt-6-astra', 'openai'],
    ['qwen/qwen3-32b', 'groq'],
    // Named Kimi, served by Groq: the serving vendor decides.
    ['moonshotai/kimi-k2-instruct-0905', 'groq'],
  ] as const)(
    'with Groq AND OpenAI connected, codex model %s runs on %s',
    async (model, expected) => {
      const recorded: RecordedQuery[] = [];
      const home = await resolver(
        [{ provider: 'groq' }, { provider: 'openai' }],
        recorded,
      ).resolve(CLAIMS, { agentTool: 'codex', model });

      expect(home?.provider).toBe(expected);
      expect(recorded[0]?.params).toEqual([expected]);
    },
  );

  it('a Kimi model does not fall back to the Anthropic login when no Kimi key is connected', async () => {
    // Only the Anthropic row exists. Sending a Kimi model to Anthropic is a
    // request to a server that does not serve it; spawn turns this `null` into
    // a refusal naming the Kimi key.
    const home = await resolver([{ provider: 'anthropic' }]).resolve(CLAIMS, {
      agentTool: 'claude-code',
      model: 'kimi-k2-thinking',
    });
    expect(home).toBeNull();
  });

  it('a Claude model does not borrow the Kimi key when no Anthropic login is connected', async () => {
    const home = await resolver([{ provider: 'kimi' }]).resolve(CLAIMS, {
      agentTool: 'claude-code',
      model: 'claude-opus-5-5',
    });
    expect(home).toBeNull();
  });

  /**
   * AN UNREADABLE KEY MUST NOT SILENTLY BILL THE NODE'S ACCOUNT.
   *
   * `DATA_DIR` is `/var/lib/tm8`, which does not exist under the test runner, so
   * `readApiKey` genuinely fails here — ENOENT from a real `readFile`, not a
   * mocked rejection. That is the whole class: an `active` index row whose key
   * file cannot be read. A partial write, a restored backup that skipped the
   * 0700 directory, an operator `chown`; the row says connected and the bytes
   * are not there.
   *
   * WHAT MAKES `null` THE WRONG ANSWER, AND WHY IT LOOKS LIKE THE RIGHT ONE.
   * `null` is documented as "this identity has not connected this provider",
   * and for that member it is exactly right — injecting an empty config
   * directory would leave an unconnected member with no agent authentication at
   * all, which is the over-eager failure the header of this file warns about.
   * But this member DID connect. Returning the unconnected answer for a
   * connected member is not conservative; it is a different claim, and it is
   * false.
   *
   * The consequence is measured in `@tm8/execution`'s `spawn-manifest.test.ts`
   * ("a keyless credential home suppresses the node key that a null home leaves
   * behind") rather than asserted here, because it belongs to `composeEnv`:
   * every line that removes the node's own `ANTHROPIC_API_KEY` lives inside
   * `if (credentialHome)`, and `AUTH_ENV_KEYS` forwards that key a few lines
   * earlier. So `null` does not mean "inject nothing" — it means the node's
   * Anthropic key stays in the environment and a member who deliberately
   * connected Kimi runs `claude-code` on the NODE's account. Wrong vendor,
   * wrong bill, and nothing red anywhere.
   *
   * A KEYLESS HOME IS THE HONEST ANSWER. It carries the provider, so suppression
   * runs and `CLAUDE_CONFIG_DIR` is pinned to the member's own `kimi/`
   * directory; `apiKey` is `undefined`, so the routing step injects nothing.
   * The session starts with no credential for anyone and fails visibly and
   * attributably — the same treatment this file's own header already demands
   * for a `stale` row, owed equally to a row that is active but unreadable.
   */
  it('returns a KEYLESS home, not null, when an active API key cannot be read', async () => {
    const home = await resolver([{ provider: 'kimi' }]).resolve(CLAIMS, {
      agentTool: 'claude-code',
      model: 'kimi-k2-thinking',
    });

    // Not null. The member connected; the answer must say so.
    expect(home).not.toBeNull();
    // Asserted with `toEqual` on the whole object rather than field by field,
    // because the ABSENCE of `apiKey` is the load-bearing half: a home carrying
    // an empty-string key would pass every per-field check and then route the
    // session to Moonshot with no credential, which is a 401 a long way from
    // here instead of an immediately legible failure.
    expect(home).toEqual({
      provider: 'kimi',
      homeDir: `${DATA_DIR}/credentials/${IDENTITY}`,
      configDir: `${DATA_DIR}/credentials/${IDENTITY}/kimi`,
    });
    expect(home).not.toHaveProperty('apiKey');
  });

  /**
   * An unreadable Kimi key is still Kimi's problem. A doubly-connected member
   * whose Kimi key is unreadable, launching a Kimi model, must not quietly be
   * handed their working Anthropic login: that sends a Kimi model to a server
   * that does not serve it. They get Kimi, keyless, and spawn refuses with
   * "reconnect".
   */
  it('does not fall through to the native provider when the Kimi key is unreadable', async () => {
    const home = await resolver([{ provider: 'kimi' }, { provider: 'anthropic' }]).resolve(
      CLAIMS,
      { agentTool: 'claude-code', model: 'kimi-k2-thinking' },
    );

    expect(home?.provider).toBe('kimi');
    expect(home).not.toHaveProperty('apiKey');
  });

  it('asks only for ACTIVE credentials, so stale and revoked never inject', async () => {
    const recorded: RecordedQuery[] = [];
    await resolver([{ provider: 'anthropic' }], recorded).resolve(CLAIMS, {
      agentTool: 'claude-code',
      model: 'opus',
    });

    // Asserted on the predicate rather than by feeding a 'stale' row back,
    // because the stub cannot enforce a WHERE clause — the filter has to be in
    // the SQL or it is nowhere.
    expect(recorded[0]?.sql).toContain("status = 'active'");
  });

  /**
   * 992 (W7p): a link-bound caller never runs on the linking human's model
   * login. In Postgres the restrictive policy already hides the row, which
   * masks this guard; the stub answers WITH the row, as a database missing
   * that policy would, so this cell is the guard's own red.
   */
  it('a link-bound caller gets null WITHOUT querying, even when the row would be returned', async () => {
    const cases: DbClaims[] = [
      { ...CLAIMS, authKind: 'link', viaLinkId: 'link-1', sessionSpaceId: 'space-b' },
      { ...CLAIMS, authKind: 'agent', viaLinkId: 'link-1', sessionSpaceId: 'space-b' },
    ];
    for (const claims of cases) {
      const recorded: RecordedQuery[] = [];
      const home = await resolver([{ provider: 'anthropic' }], recorded).resolve(claims, {
        agentTool: 'claude-code',
        model: 'opus',
      });
      expect(home, JSON.stringify(claims)).toBeNull();
      expect(recorded).toHaveLength(0);
    }
    // Paired positive: the same row, an ordinary agent of the same human.
    const home = await resolver([{ provider: 'anthropic' }]).resolve(
      { ...CLAIMS, authKind: 'agent', sessionSpaceId: 'space-b' },
      { agentTool: 'claude-code', model: 'opus' },
    );
    expect(home?.provider).toBe('anthropic');
  });
});
