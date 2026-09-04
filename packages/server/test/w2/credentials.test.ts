/**
 * `credentials.*` — the human-only guard (R2), the merged status view and its
 * honest degradation, and R3's Disconnect ordering.
 *
 * WHY THIS SUITE IS NOT A REAL-POSTGRES SUITE, stated so nobody "fixes" it:
 * every assertion here is about TYPESCRIPT behaviour that a database cannot
 * observe — which principal the registration wrapper refuses, what shape the
 * merged view has when one of its two tables is missing, and the ORDER in which
 * Disconnect issues its calls. Ordering in particular is invisible to a real
 * database: by the time the rows have settled, "revoked before killed" and
 * "killed before revoked" look identical. A recording fake is the only
 * instrument that can see it.
 *
 * The things that DO need real Postgres are already covered where they belong:
 * PR1's `test/db/credential-sessions.pg.test.ts` proves the row-level security
 * and the four RPC gates against a live chain, and PR2's
 * `test/db/credential-service.pg.test.ts` proves the `tm8.auth_kind` binding
 * end to end through the real `Db`. This file deliberately does not restate
 * either.
 *
 * EVERY REFUSAL BELOW HAS A MATCHING POSITIVE CONTROL. A guard test with no
 * positive control passes identically when the guard works and when the whole
 * feature is broken, and this lane's own history is full of that failure.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CollabError } from '@tm8/contract';
import type { CredentialProviderName, OperationName } from '@tm8/contract';
import {
  CredentialsDeleteResultSchema,
  CredentialsLoginSessionFinishResultSchema,
  CredentialsLoginSessionStartResultSchema,
  CredentialsStatusViewSchema,
  OPERATIONS,
} from '@tm8/contract';
import { CREDENTIAL_LOGIN_COMMANDS } from '@tm8/execution';

import type { Db, DbClaims, Querier } from '../../src/db/types.js';
import type { FacadeDeps } from '../../src/facade/deps.js';
import { HandlerRegistry } from '../../src/facade/registry.js';
import {
  CREDENTIAL_OPERATIONS,
  CREDENTIALS_HUMAN_ONLY,
  registerCredentialHandlers,
} from '../../src/facade/handlers/w2/credentials.js';
import { W2CredentialCatalogService } from '../../src/facade/services/w2/credential-catalog.js';
import { W2CredentialSessionsService } from '../../src/facade/services/w2/credential-sessions.js';
import type { RequestContext } from '../../src/http/types.js';

const SPACE_ID = '00000000-0000-7000-8000-000000000001';
const SESSION_ID = '00000000-0000-7000-8000-0000000000a1';
const AGENT_SESSION_ID = '00000000-0000-7000-8000-0000000000b1';

// Handler composition intentionally uses the process environment, just like
// production. Give every existing status/start positive control an executable
// without making this suite depend on whichever vendor CLIs CI happens to have.
const ORIGINAL_PATH = process.env['PATH'];
let credentialBinDir = '';

beforeAll(() => {
  credentialBinDir = mkdtempSync(join(tmpdir(), 'tm8-credential-bins-'));
  const binaries = new Set(
    Object.values(CREDENTIAL_LOGIN_COMMANDS).map((command) => command.split(/\s+/, 1)[0]!),
  );
  for (const binary of binaries) {
    const path = join(credentialBinDir, binary);
    writeFileSync(path, '#!/bin/sh\nexit 1\n');
    chmodSync(path, 0o755);
  }
  process.env['PATH'] = `${credentialBinDir}:${ORIGINAL_PATH ?? ''}`;
});

afterAll(() => {
  if (ORIGINAL_PATH === undefined) delete process.env['PATH'];
  else process.env['PATH'] = ORIGINAL_PATH;
  if (credentialBinDir) rmSync(credentialBinDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// instruments
// ---------------------------------------------------------------------------

type QueryHandler = (sql: string, params: readonly unknown[]) => Promise<unknown[]>;
type RpcHandler = (fn: string, args: readonly unknown[]) => Promise<unknown>;

/** Records every call IN ORDER — that ordering is the point for R3. */
class FakeDb implements Db {
  readonly calls: string[] = [];
  readonly rpcCalls: Array<{ fn: string; args: readonly unknown[] }> = [];
  readonly queryCalls: Array<{ sql: string; params: readonly unknown[] }> = [];

  constructor(
    private readonly onQuery: QueryHandler = async () => [],
    private readonly onRpc: RpcHandler = async () => ({}),
  ) {}

  private readonly querier: Querier = {
    query: async <R>(sql: string, params: readonly unknown[] = []): Promise<R[]> => {
      this.queryCalls.push({ sql, params });
      this.calls.push(`query:${firstTable(sql)}`);
      return (await this.onQuery(sql, params)) as R[];
    },
    rpc: async <T>(fn: string, args: readonly unknown[] = []): Promise<T> => {
      this.rpcCalls.push({ fn, args });
      this.calls.push(`rpc:${fn}`);
      return (await this.onRpc(fn, args)) as T;
    },
  };

  async tx<T>(_claims: DbClaims, fn: (q: Querier) => Promise<T>): Promise<T> {
    return fn(this.querier);
  }
  async query<R>(_c: DbClaims, sql: string, params: readonly unknown[] = []): Promise<R[]> {
    return this.querier.query<R>(sql, params);
  }
  async rpc<T>(_c: DbClaims, fn: string, args: readonly unknown[] = []): Promise<T> {
    return this.querier.rpc<T>(fn, args);
  }
  async end(): Promise<void> {}
}

/** A coarse label for a SQL statement, enough to order-check it. */
function firstTable(sql: string): string {
  if (sql.includes('account_agent_credentials')) return 'account_agent_credentials';
  if (sql.includes('to_regclass')) return 'git_store_probe';
  if (sql.includes('account_git_credentials')) return 'account_git_credentials';
  if (sql.includes('credential_sessions')) return 'credential_sessions';
  if (sql.includes('work_sessions')) return 'work_sessions';
  return 'other';
}

/** Records terminate order alongside the database calls. */
class FakeTerminals {
  readonly terminated: string[] = [];
  constructor(
    private readonly sink: string[],
    private readonly outcome: (id: string) => string = () => 'killed',
  ) {}
  terminate(sessionId: string): string {
    this.terminated.push(sessionId);
    this.sink.push(`kill:${sessionId}`);
    return this.outcome(sessionId);
  }
  hasLiveTerminal(): boolean {
    return true;
  }
  // `launch` is never reached in this suite: nothing here calls
  // `loginSessions.start` through to the PTY without stubbing the RPC first.
  launch(): never {
    throw new Error('unexpected launch');
  }
}

function deps(db: Db): FacadeDeps {
  return {
    db,
    config: {
      host: '127.0.0.1',
      port: 0,
      uiDir: undefined,
      maxBodyBytes: 1024,
      databaseUrl: undefined,
    },
    owner: async () => ({
      identityId: 'identity-human',
      accountId: '00000000-0000-7000-8000-000000000099',
      username: 'human',
      isNodeAdmin: false,
      isOwner: true,
    }),
  };
}

/**
 * A request context whose `authKind` is what the guard will read.
 *
 * `undefined` is a real and important case, not a test artefact: it is what a
 * request whose resolver never established a session kind looks like, and the
 * guard must refuse it rather than admit it.
 */
function context(
  opName: OperationName,
  authKind: 'browser' | 'cli' | 'agent' | 'agent_runtime' | undefined,
  options: { params?: Record<string, string>; body?: unknown } = {},
): RequestContext {
  return {
    op: { name: opName, method: 'GET', path: '/test', kind: 'read', status: 'v1' },
    opName,
    params: options.params ?? {},
    query: new URLSearchParams(),
    body: options.body,
    requestId: 'req-cred',
    identity: {
      kind: 'bearer',
      identityId: 'identity-human',
      ...(authKind ? { authKind } : {}),
    },
    headers: {},
    method: 'GET',
    path: '/test',
  } as RequestContext;
}

function registryFor(
  db: Db,
  terminals: FakeTerminals = new FakeTerminals([]),
): HandlerRegistry {
  const registry = new HandlerRegistry();
  registerCredentialHandlers(registry, deps(db), {
    // Structurally a launcher for the two seams that use it here.
    launcher: terminals as never,
    dataDir: '/tmp/tm8-credentials-test',
  });
  return registry;
}

/** Invoke one registered operation, or fail loudly if it is not mounted. */
async function invoke(
  registry: HandlerRegistry,
  opName: OperationName,
  ctx: RequestContext,
): Promise<unknown> {
  const handler = registry.get(opName);
  if (!handler) throw new Error(`${opName} is not registered`);
  return handler(ctx);
}

/** A body good enough to reach the service for each command operation. */
function bodyFor(opName: OperationName): unknown {
  if (opName === 'credentials.loginSessions.start') {
    return { spaceId: SPACE_ID, provider: 'anthropic' };
  }
  return {};
}

function paramsFor(opName: OperationName): Record<string, string> {
  if (opName === 'credentials.delete') return { provider: 'anthropic' };
  if (opName === 'credentials.loginSessions.finish') return { id: SESSION_ID };
  return {};
}

// ---------------------------------------------------------------------------
// the catalog itself
// ---------------------------------------------------------------------------

describe('the four credential operations exist in the contract', () => {
  it('binds each to the method and path sub-doc 11 §D specifies', () => {
    const bound = OPERATIONS.filter((op) => op.name.startsWith('credentials.'))
      .map((op) => `${op.method} ${op.path}`);
    expect(bound).toEqual([
      'GET /v2/identity/credentials',
      'DELETE /v2/identity/credentials/:provider',
      'POST /v2/identity/credentials/login-sessions',
      'POST /v2/identity/credentials/login-sessions/:id/finish',
    ]);
  });

  /**
   * THE REGISTRATION-SHAPE TEST — R2's own named floor, and the reason the
   * guard may be spelled once per operation in an auditable object literal
   * rather than looped over a computed record.
   *
   * `registerAll` is required by `tools/conformance/.../source-inventory.ts` to
   * take an OBJECT LITERAL with literal keys, because the conformance manifest
   * enumerates mounted operations by PARSING the source rather than by running
   * the server. A `for` loop applying the wrapper would make this seam's
   * operations invisible to that inventory. So the machine check moves here:
   * the list is derived from the CATALOG, so a fifth `credentials.*` row is in
   * front of this test the moment it is added, and stays red until it is
   * registered AND guarded.
   */
  it('EVERY credentials.* operation in the catalog is mounted — no row left behind', () => {
    const registry = registryFor(new FakeDb());
    const inCatalog = OPERATIONS.map((op) => op.name).filter((n) => n.startsWith('credentials.'));

    expect(CREDENTIAL_OPERATIONS).toEqual(inCatalog);
    for (const name of inCatalog) {
      expect(registry.has(name as OperationName), `${name} is in the catalog but not mounted`)
        .toBe(true);
    }
  });

  it('and every mounted one REFUSES an agent — the guard is proven per row, not assumed', async () => {
    // Paired with the test above this is the whole guarantee: the catalog says
    // which operations exist, that test says all of them are mounted, and this
    // one says every mounted one is behind the guard. A new operation cannot
    // satisfy all three without being wrapped.
    const registry = registryFor(new FakeDb());
    for (const name of CREDENTIAL_OPERATIONS) {
      const error = await invoke(
        registry,
        name,
        context(name, 'agent', { params: paramsFor(name), body: bodyFor(name) }),
      ).then(() => null, (e: unknown) => e);
      expect((error as CollabError | null)?.details?.['reason'], `${name} is not guarded`)
        .toBe(CREDENTIALS_HUMAN_ONLY);
    }
  });

  it('and every mounted one explicitly REFUSES agent_runtime before touching the database', async () => {
    const db = new FakeDb();
    const registry = registryFor(db);
    for (const name of CREDENTIAL_OPERATIONS) {
      const error = await invoke(
        registry,
        name,
        context(name, 'agent_runtime', { params: paramsFor(name), body: bodyFor(name) }),
      ).then(() => null, (e: unknown) => e);
      expect(error).toBeInstanceOf(CollabError);
      expect((error as CollabError).code).toBe('forbidden');
      expect((error as CollabError).details?.['reason'], `${name} admitted agent_runtime`)
        .toBe(CREDENTIALS_HUMAN_ONLY);
    }
    expect(db.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// R2 — the guard. Every refusal paired with its positive control.
// ---------------------------------------------------------------------------

describe('R2 — credential operations are human-only, status included', () => {
  /**
   * The whole point of the lane. An agent bearer token carries its OWNER'S full
   * identity (finding C7), so an unguarded `status` reads the owner's login
   * metadata and an unguarded `delete` revokes their token.
   */
  for (const opName of CREDENTIAL_OPERATIONS) {
    it(`REFUSES an agent session on ${opName} with the typed code`, async () => {
      const db = new FakeDb();
      const registry = registryFor(db);
      const ctx = context(opName, 'agent', {
        params: paramsFor(opName),
        body: bodyFor(opName),
      });

      const error = await invoke(registry, opName, ctx).then(
        () => null,
        (e: unknown) => e,
      );

      expect(error).toBeInstanceOf(CollabError);
      expect((error as CollabError).code).toBe('forbidden');
      expect((error as CollabError).details?.['reason']).toBe(CREDENTIALS_HUMAN_ONLY);
      expect(CREDENTIALS_HUMAN_ONLY).toBe('credentials_human_only');

      // FAILS CLOSED, AND FAILS EARLY. Not one database call was made — the
      // refusal happened before any credential was read or written, so a
      // refused agent cannot even learn whether a row exists by timing.
      expect(db.calls).toEqual([]);
    });

    /**
     * THE POSITIVE CONTROL. Without it, every refusal above would pass just as
     * happily against a handler that throws unconditionally, or against a
     * feature that does not work at all.
     *
     * What it asserts is that the request got PAST THE GUARD and into the
     * service — not that the whole operation succeeded. Those are different
     * claims, and conflating them is what made the first draft of this test
     * wrong: `loginSessions.finish` legitimately answers `not_found` for a
     * session this node never started, and that 404 is *itself* proof the
     * guard admitted the caller. Each operation additionally has a fully green
     * end-to-end path further down this file, so "admitted" is never the only
     * evidence that the operation works.
     */
    for (const humanKind of ['browser', 'cli'] as const) {
      it(`POSITIVE CONTROL: a ${humanKind} session is ADMITTED on ${opName}`, async () => {
        // `cli` is human. A person at a terminal has exactly the entitlement of
        // a person in the settings screen — the guard separates human from
        // agent, not browser from everything else.
        const db = new FakeDb(serviceQueries, serviceRpcs);
        const registry = registryFor(db, new FakeTerminals([]));
        const ctx = context(opName, humanKind, {
          params: paramsFor(opName),
          body: bodyFor(opName),
        });

        const outcome = await invoke(registry, opName, ctx).then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        );

        if (!outcome.ok) {
          // Admitted, then refused by the service for its own reasons. The one
          // thing it must NOT be is the guard.
          expect((outcome.error as CollabError).details?.['reason'])
            .not.toBe(CREDENTIALS_HUMAN_ONLY);
        }
        // And the request reached something that talks to the database or the
        // node's session registry — it was not stopped at the door.
        expect(outcome.ok || db.calls.length > 0 || outcome.error instanceof CollabError).toBe(true);
      });
    }

    it(`REFUSES a request that established no session kind at all on ${opName}`, async () => {
      // Fail closed. An allowlist, not `!== 'agent'` — so a session kind added
      // to `auth_sessions.kind` in future is refused until somebody decides
      // otherwise, instead of silently inheriting credential access.
      const db = new FakeDb();
      const registry = registryFor(db);
      const ctx = context(opName, undefined, {
        params: paramsFor(opName),
        body: bodyFor(opName),
      });

      const error = await invoke(registry, opName, ctx).then(
        () => null,
        (e: unknown) => e,
      );
      expect((error as CollabError).details?.['reason']).toBe(CREDENTIALS_HUMAN_ONLY);
      expect(db.calls).toEqual([]);
    });
  }

  it('reads the kind the SERVER resolved, and nothing the client can set', async () => {
    // The body and the headers both claim to be a browser. Neither is
    // consulted: `ctx.identity.authKind` comes out of the session row
    // `resolveBearerIdentity` looked up by token hash.
    const db = new FakeDb();
    const registry = registryFor(db);
    const ctx = {
      ...context('credentials.status', 'agent'),
      body: { authKind: 'browser', kind: 'browser' },
      headers: { 'x-auth-kind': 'browser' },
    } as RequestContext;

    const error = await invoke(registry, 'credentials.status', ctx).then(
      () => null,
      (e: unknown) => e,
    );
    expect((error as CollabError).details?.['reason']).toBe(CREDENTIALS_HUMAN_ONLY);
  });
});

// ---------------------------------------------------------------------------
// the service doubles the positive controls run against
// ---------------------------------------------------------------------------

const serviceQueries: QueryHandler = async (sql) => {
  if (sql.includes('to_regclass')) return [{ present: false }];
  if (sql.includes('account_agent_credentials')) return [];
  if (sql.includes('credential_sessions')) return [];
  if (sql.includes('work_sessions')) return [];
  return [];
};

const serviceRpcs: RpcHandler = async (fn) => {
  if (fn === 'start_credential_session') {
    return {
      workSessionId: SESSION_ID,
      spaceId: SPACE_ID,
      provider: 'anthropic',
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
    };
  }
  if (fn === 'delete_account_agent_credential') return { deleted: true };
  return {};
};

// ---------------------------------------------------------------------------
// credentials.status — the merged view and its honest degradation
// ---------------------------------------------------------------------------

describe('credentials.status merges two stores and degrades honestly', () => {
  it('answers all five providers in display order even when nothing is connected', async () => {
    const db = new FakeDb(serviceQueries);
    const registry = registryFor(db);
    const view = await invoke(registry, 'credentials.status', context('credentials.status', 'browser'));

    const parsed = CredentialsStatusViewSchema.parse(view);
    expect(parsed.providers.map((p) => p.provider)).toEqual([
      'anthropic',
      'openai',
      'github',
      'gemini',
      'hermes',
    ]);
    expect(parsed.providers.every((p) => p.connected === false)).toBe(true);
  });

  it('reports an absent CLI as unavailable, never as a measured disconnection', async () => {
    const catalog = new W2CredentialCatalogService({
      db: new FakeDb(serviceQueries),
      terminals: new FakeTerminals([]),
      dataDir: '/tmp/tm8-credentials-test',
      env: { HOME: '/server-home', PATH: '/server-path' },
      binaryResolver: ({ binary }) =>
        binary === 'hermes' ? null : `/test/bin/${binary}`,
    });

    const view = await catalog.status({
      identityId: 'identity-human',
      claims: { identityId: 'identity-human', authKind: 'browser' },
    });
    const hermes = view.providers.find((entry) => entry.provider === 'hermes');

    expect(hermes?.connected).toBe(false);
    expect((hermes as { status?: string } | undefined)?.status).toBe('unavailable');
    // `status:null` is this view's encoding of disconnected. The two facts
    // must remain different even though both have connected:false.
    expect((hermes as { status?: string | null } | undefined)?.status).not.toBeNull();
  });

  it('reports the string-shaped store ABSENT rather than claiming GitHub is disconnected', async () => {
    // THE ACCEPTANCE CRITERION. `account_git_credentials` ships in 079 on the
    // deployed staging line and is reachable from no local git object. A view
    // that let an absent table read as "no rows, therefore not connected" would
    // put a confident, measured-looking "Not connected" in front of a member
    // whose connection state was never actually observed.
    const db = new FakeDb(serviceQueries);
    const registry = registryFor(db);
    const view = CredentialsStatusViewSchema.parse(
      await invoke(registry, 'credentials.status', context('credentials.status', 'browser')),
    );

    expect(view.gitCredentialStore).toBe('absent');
    // And it did not pretend to read a table it had established was not there.
    expect(db.calls).toContain('query:git_store_probe');
    expect(db.calls).not.toContain('query:account_git_credentials');
  });

  it('MERGES the string-shaped store when it IS present', async () => {
    // The positive control for the degradation test above: without it, a status
    // view hardcoded to `absent` would pass that test perfectly.
    const db = new FakeDb(async (sql) => {
      if (sql.includes('to_regclass')) return [{ present: true }];
      if (sql.includes('account_git_credentials')) return [{ provider: 'github', login: 'octocat' }];
      if (sql.includes('account_agent_credentials')) {
        return [{
          provider: 'anthropic',
          login: null,
          auth_method: 'oauth',
          status: 'active',
          connected_at: new Date('2026-08-07T00:00:00.000Z'),
          last_verified_at: null,
        }];
      }
      return [];
    });
    const registry = registryFor(db);
    const view = CredentialsStatusViewSchema.parse(
      await invoke(registry, 'credentials.status', context('credentials.status', 'browser')),
    );

    expect(view.gitCredentialStore).toBe('present');
    const byProvider = Object.fromEntries(view.providers.map((p) => [p.provider, p]));
    expect(byProvider['github']?.connected).toBe(true);
    expect(byProvider['github']?.login).toBe('octocat');
    // A NULL login is a legal anthropic shape: rows minted under the original
    // R4 verb (`claude setup-token`) never learned an email. Post-amendment
    // rows (`claude auth login` grants `user:profile`) carry one, but the view
    // must keep passing NULL through, not fabricate or drop the field.
    expect(byProvider['anthropic']?.connected).toBe(true);
    expect(byProvider['anthropic']?.login).toBeNull();
    expect(byProvider['openai']?.connected).toBe(false);
  });

  it('does NOT render a revoked or stale row as connected', async () => {
    const db = new FakeDb(async (sql) => {
      if (sql.includes('to_regclass')) return [{ present: false }];
      if (sql.includes('account_agent_credentials')) {
        return [
          { provider: 'anthropic', login: null, auth_method: null, status: 'revoked',
            connected_at: new Date('2026-08-07T00:00:00.000Z'), last_verified_at: null },
          { provider: 'openai', login: 'someone', auth_method: null, status: 'stale',
            connected_at: new Date('2026-08-07T00:00:00.000Z'), last_verified_at: null },
        ];
      }
      return [];
    });
    const registry = registryFor(db);
    const view = CredentialsStatusViewSchema.parse(
      await invoke(registry, 'credentials.status', context('credentials.status', 'browser')),
    );
    const byProvider = Object.fromEntries(view.providers.map((p) => [p.provider, p]));
    expect(byProvider['anthropic']?.connected).toBe(false);
    expect(byProvider['anthropic']?.status).toBe('revoked');
    expect(byProvider['openai']?.connected).toBe(false);
    expect(byProvider['openai']?.status).toBe('stale');
  });
});

// ---------------------------------------------------------------------------
// R3 — Disconnect terminates, in order
// ---------------------------------------------------------------------------

describe('R3 — credentials.delete revokes first, then terminates', () => {
  function disconnectFixture(provider: CredentialProviderName) {
    const order: string[] = [];
    const db = new FakeDb(
      async (sql) => {
        if (sql.includes('credential_sessions')) return [{ work_session_id: SESSION_ID }];
        if (sql.includes('work_sessions')) return [{ work_session_id: AGENT_SESSION_ID }];
        return [];
      },
      async (fn) => (fn === 'delete_account_agent_credential' ? { deleted: true } : {}),
    );
    // One shared sink so database calls and kills interleave in real order.
    (db as unknown as { calls: string[] }).calls = order;
    const terminals = new FakeTerminals(order);
    const registry = registryFor(db, terminals);
    const catalog = new W2CredentialCatalogService({
      db,
      terminals,
      dataDir: '/tmp/tm8-credentials-test',
      removeCredentialFiles: async () => undefined,
    });
    return { order, db, terminals, registry, catalog, provider };
  }

  it('revokes BEFORE it kills anything — the order is the security property', async () => {
    const { order, registry } = disconnectFixture('anthropic');
    const result = CredentialsDeleteResultSchema.parse(
      await invoke(
        registry,
        'credentials.delete',
        context('credentials.delete', 'browser', { params: { provider: 'anthropic' }, body: {} }),
      ),
    );

    const revokeAt = order.indexOf('rpc:delete_account_agent_credential');
    const firstKillAt = order.findIndex((c) => c.startsWith('kill:'));
    expect(revokeAt).toBeGreaterThanOrEqual(0);
    expect(firstKillAt).toBeGreaterThanOrEqual(0);
    // If a kill happened first, a spawn racing this operation could re-inject
    // the credential into a brand new session after we had cleaned up.
    expect(revokeAt).toBeLessThan(firstKillAt);
    expect(result.revoked).toBe(true);
  });

  it('kills the login terminal BEFORE the agent sessions, and stamps the row after the kill', async () => {
    const { order, registry } = disconnectFixture('anthropic');
    await invoke(
      registry,
      'credentials.delete',
      context('credentials.delete', 'browser', { params: { provider: 'anthropic' }, body: {} }),
    );

    expect(order.indexOf(`kill:${SESSION_ID}`)).toBeLessThan(order.indexOf(`kill:${AGENT_SESSION_ID}`));
    // R7: `finish_credential_session` stamps `finished_at` only, and must not
    // be stamped while the PTY is still streaming.
    expect(order.indexOf(`kill:${SESSION_ID}`))
      .toBeLessThan(order.indexOf('rpc:finish_credential_session'));
  });

  it('targets the claude tool for anthropic and codex for openai, and EVERY tool for github', async () => {
    for (const [provider, expected] of [
      ['anthropic', ['claude-code']],
      ['openai', ['codex']],
      ['github', null],
    ] as const) {
      const { db, registry } = disconnectFixture(provider);
      await invoke(
        registry,
        'credentials.delete',
        context('credentials.delete', 'browser', { params: { provider }, body: {} }),
      );
      const agentQuery = db.queryCalls.find((c) => c.sql.includes('work_sessions'));
      expect(agentQuery, `${provider} did not query for agent sessions`).toBeDefined();
      // github passes null — meaning EVERY tool, not none. The git credential
      // injects universally, so narrowing it would leave live sessions holding
      // a token the member believes they just disconnected.
      expect(agentQuery?.params[2]).toEqual(expected);
    }
  });

  it.each([
    ['gemini', ['gemini']],
    ['hermes', ['hermes']],
  ] as const)('disconnecting %s kills only live %s agent sessions', async (provider, expected) => {
    const { catalog, db, terminals } = disconnectFixture(provider);
    const result = await catalog.delete(provider, {
      identityId: 'identity-human',
      claims: { identityId: 'identity-human', authKind: 'browser' },
    });

    const agentQuery = db.queryCalls.find((call) => call.sql.includes('work_sessions'));
    expect(agentQuery?.params[2]).toEqual(expected);
    expect(terminals.terminated).toContain(AGENT_SESSION_ID);
    expect(result.terminatedAgentSessionIds).toEqual([AGENT_SESSION_ID]);
  });

  it('revokes GitHub through the dedicated string-shaped store', async () => {
    const { registry } = disconnectFixture('github');
    const result = CredentialsDeleteResultSchema.parse(
      await invoke(
        registry,
        'credentials.delete',
        context('credentials.delete', 'browser', { params: { provider: 'github' }, body: {} }),
      ),
    );
    expect(result.revoked).toBe(true);
    expect(result.failures.some((f) => f.step === 'revoke')).toBe(false);
    // It also terminates every agent session because GitHub injection applies
    // independently of the agent tool.
    expect(result.terminatedAgentSessionIds).toEqual([AGENT_SESSION_ID]);
  });

  it('reports a GitHub cleanup partial failure through failures[] after DB revocation', async () => {
    const db = new FakeDb(serviceQueries);
    const catalog = new W2CredentialCatalogService({
      db,
      terminals: new FakeTerminals([]),
      dataDir: '/tmp/tm8-credentials-test',
      revokeGitCredential: async () => undefined,
      removeCredentialFiles: async () => {
        throw new Error('simulated cleanup refusal');
      },
    });

    const result = await catalog.delete('github', {
      identityId: 'identity-human',
      claims: { identityId: 'identity-human', authKind: 'browser' },
    });

    // The DB row is the injection gate, so it stays revoked. The abandoned
    // login-directory cleanup is an explicit partial failure, never swallowed
    // and never promoted to a bare error after the security-critical step won.
    expect(result.revoked).toBe(true);
    expect(result.failures).toEqual([{
      step: 'revoke',
      reason: 'credential files: simulated cleanup refusal',
    }]);
  });

  it('a kill that FAILS is reported and never resurrects the credential', async () => {
    const order: string[] = [];
    const db = new FakeDb(
      async (sql) => {
        if (sql.includes('credential_sessions')) return [{ work_session_id: SESSION_ID }];
        if (sql.includes('work_sessions')) return [{ work_session_id: AGENT_SESSION_ID }];
        return [];
      },
      async (fn) => (fn === 'delete_account_agent_credential' ? { deleted: true } : {}),
    );
    (db as unknown as { calls: string[] }).calls = order;
    const terminals = new FakeTerminals(order, (id) => (id === AGENT_SESSION_ID ? 'error' : 'killed'));
    const registry = registryFor(db, terminals);

    const result = CredentialsDeleteResultSchema.parse(
      await invoke(
        registry,
        'credentials.delete',
        context('credentials.delete', 'browser', { params: { provider: 'anthropic' }, body: {} }),
      ),
    );

    // `revoked: true` WITH a failure is the correct description of a partial
    // disconnect. Rolling the revoke back would restore a credential the member
    // asked us to forget because we could not kill a process.
    expect(result.revoked).toBe(true);
    expect(result.failures.some((f) => f.step === 'agentSession')).toBe(true);
    expect(result.terminatedAgentSessionIds).not.toContain(AGENT_SESSION_ID);
  });

  it('refuses a provider that is not in the fixed list before it names a directory', async () => {
    const { registry } = disconnectFixture('anthropic');
    const error = await invoke(
      registry,
      'credentials.delete',
      context('credentials.delete', 'browser', { params: { provider: '../../etc' }, body: {} }),
    ).then(() => null, (e: unknown) => e);
    expect((error as CollabError).code).toBe('invalid_input');
  });
});

// ---------------------------------------------------------------------------
// the login-session pair
// ---------------------------------------------------------------------------

describe('the login session operations answer their contract shapes', () => {
  it('refuses an absent binary before it mints a work_session or launches a PTY', async () => {
    const db = new FakeDb(serviceQueries, serviceRpcs);
    const launched: unknown[] = [];
    const launcher = {
      launch: (request: unknown) => {
        launched.push(request);
        throw new Error('launch must not be reached');
      },
      terminate: () => 'not_found',
      hasLiveTerminal: () => false,
    };
    const service = new W2CredentialSessionsService({
      db,
      launcher: launcher as never,
      dataDir: '/tmp/tm8-credentials-test',
      env: { HOME: '/server-home', PATH: '/server-path' },
      binaryResolver: () => null,
    });

    const error = await service.start(
      { spaceId: SPACE_ID, provider: 'hermes' },
      {
        identityId: 'identity-human',
        claims: { identityId: 'identity-human', authKind: 'browser' },
      },
    ).then(() => null, (reason: unknown) => reason);

    expect(error).toBeInstanceOf(CollabError);
    expect((error as CollabError).code).toBe('invalid_input');
    expect((error as Error).message).toContain("'hermes'");
    expect((error as Error).message).toMatch(/install/i);
    expect(db.calls).toEqual([]);
    expect(launched).toEqual([]);
  });

  it('start returns the command it ACTUALLY launched, and takes none from the caller', async () => {
    const order: string[] = [];
    const db = new FakeDb(serviceQueries, serviceRpcs);
    (db as unknown as { calls: string[] }).calls = order;
    const launched: unknown[] = [];
    const launcher = {
      launch: (req: unknown) => {
        launched.push(req);
        return {
          sessionId: SESSION_ID,
          provider: 'anthropic',
          command: 'claude auth login',
          cwd: '/tmp',
          env: {},
          reused: false,
        };
      },
      terminate: () => 'killed',
      hasLiveTerminal: () => true,
    };
    const registry = new HandlerRegistry();
    registerCredentialHandlers(registry, deps(db), {
      launcher: launcher as never,
      dataDir: '/tmp/tm8-credentials-test',
    });

    const result = CredentialsLoginSessionStartResultSchema.parse(
      await invoke(
        registry,
        'credentials.loginSessions.start',
        context('credentials.loginSessions.start', 'browser', {
          // A hostile body. None of these fields exists on the DTO, and none
          // can reach argv — the command comes from a fixed server-side table.
          body: {
            spaceId: SPACE_ID,
            provider: 'anthropic',
            command: 'rm -rf /',
            args: ['--evil'],
            cols: 80,
          },
        }),
      ),
    );

    expect(result.command).toBe('claude auth login');
    expect(JSON.stringify(launched)).not.toContain('rm -rf');
    expect(JSON.stringify(launched)).not.toContain('--evil');
  });

  it('finish reports connected and stored as SEPARATE facts', async () => {
    // This route-level double has no authenticated `gh` subprocess. The
    // positive capture-and-store path is exercised with a controlled runner in
    // credential-service.pg.test.ts; here we keep proving that the two facts
    // remain independently represented on the HTTP contract.
    const db = new FakeDb(serviceQueries, serviceRpcs);
    const launcher = {
      launch: () => ({
        sessionId: SESSION_ID, provider: 'github', command: 'gh auth login',
        cwd: '/tmp', env: { HOME: '/tmp', PATH: process.env['PATH'] ?? '' }, reused: false,
      }),
      terminate: () => 'killed',
      hasLiveTerminal: () => true,
    };
    const registry = new HandlerRegistry();
    registerCredentialHandlers(registry, deps(db), {
      launcher: launcher as never,
      dataDir: '/tmp/tm8-credentials-test',
    });

    // Start first, so the node's registry knows the session — `finish` refuses
    // a session this process did not start, which is itself correct.
    await invoke(
      registry,
      'credentials.loginSessions.start',
      context('credentials.loginSessions.start', 'browser', {
        body: { spaceId: SPACE_ID, provider: 'github' },
      }),
    );

    const finished = CredentialsLoginSessionFinishResultSchema.parse(
      await invoke(
        registry,
        'credentials.loginSessions.finish',
        context('credentials.loginSessions.finish', 'browser', {
          params: { id: SESSION_ID },
          body: {},
        }),
      ),
    );

    expect(finished.workSessionId).toBe(SESSION_ID);
    expect(typeof finished.connected).toBe('boolean');
    expect(typeof finished.stored).toBe('boolean');
    // No verified GitHub login means the persistence path must not run.
    expect(finished.stored).toBe(false);
  });
});
