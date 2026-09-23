/**
 * SC-3 — `credentials.space.*` and `node.credentials.*`, the TypeScript half.
 *
 * What a database cannot observe lives here: the ORDER delete issues its calls
 * in (revoke → read → kill → stamp → files), that a refused key never reaches
 * the store (I6), that no response, error or log line quotes a secret (I5),
 * and that the node-admin gate refuses before a query. The rights SQL decides
 * — D11, the space-admin and node-admin policy writers, containment across
 * launchers against real rows — are proven in
 * `test/db/space-credential-operations.pg.test.ts`.
 *
 * Test names carry the acceptance criterion (t3-N) they evidence.
 */
import { describe, expect, it } from 'vitest';

import { CollabError } from '@tm8/contract';
import type { OperationName } from '@tm8/contract';

import type { DbClaims } from '../../src/db/types.js';
import {
  createVendorProbe,
  type SpaceCredentialProbe,
  type SpaceCredentialProbeResult,
} from '../../src/credentials/space-credential-probe.js';
import type {
  SpaceCredential,
  SpaceCredentialLiveSessions,
} from '../../src/credentials/space-credential-store.js';
import type { FacadeDeps } from '../../src/facade/deps.js';
import { HandlerRegistry } from '../../src/facade/registry.js';
import { registerCredentialHandlers } from '../../src/facade/handlers/w2/credentials.js';
import { SpaceCredentialCatalogService } from '../../src/facade/services/w2/space-credential-catalog.js';
import type { RequestContext } from '../../src/http/types.js';

const SPACE = '00000000-0000-7000-8000-000000000001';
const CRED = '00000000-0000-7000-8000-0000000000c1';
const LOGIN_A = '00000000-0000-7000-8000-0000000000d1';
const LOGIN_B = '00000000-0000-7000-8000-0000000000d2';
const AGENT_A = '00000000-0000-7000-8000-0000000000e1';
const AGENT_B = '00000000-0000-7000-8000-0000000000e2';
/** Every I5 assertion greps for THIS string; it appears nowhere else. */
const SECRET = 'sk-ant-SC3-canary-3f9c1e7a5b2d4e6f8a0c';

const HUMAN: DbClaims = { identityId: 'identity-human', nodeAdmin: false, requestId: 'r', authKind: 'browser' } as DbClaims;

function row(overrides: Partial<SpaceCredential> = {}): SpaceCredential {
  return {
    id: CRED,
    spaceId: SPACE,
    provider: 'anthropic',
    shape: 'api_key',
    label: 'Team key',
    isDefault: true,
    status: 'active',
    createdByAccountId: '00000000-0000-7000-8000-000000000099',
    displayLogin: null,
    keyHint: SECRET.slice(-4),
    pendingExpiresAt: null,
    createdAt: '2026-09-23T00:00:00.000Z',
    updatedAt: '2026-09-23T00:00:00.000Z',
    lastUsedAt: null,
    lastProbeAt: null,
    ...overrides,
  };
}

/** A recording store: every call lands in `calls`, in order. */
function fakeStore(options: {
  calls: string[];
  live?: SpaceCredentialLiveSessions | Error;
  revoked?: SpaceCredential & { revoked: boolean };
  revokeError?: Error;
  finishError?: (ws: string) => Error | undefined;
  createError?: Error;
}) {
  const { calls } = options;
  const stored: Array<{ op: string; args: unknown[] }> = [];
  const store = {
    stored,
    list: async () => { calls.push('list'); return [row()]; },
    create: async (_c: DbClaims, input: unknown) => {
      calls.push('create');
      stored.push({ op: 'create', args: [input] });
      if (options.createError) throw options.createError;
      return row();
    },
    rekey: async (_c: DbClaims, id: string, secret: string, displayLogin?: string | null) => {
      calls.push('rekey');
      stored.push({ op: 'rekey', args: [id, secret, displayLogin] });
      return row();
    },
    rename: async () => { calls.push('rename'); return row({ label: 'Renamed' }); },
    setDefault: async () => { calls.push('setDefault'); return row(); },
    revoke: async () => {
      calls.push('revoke');
      if (options.revokeError) throw options.revokeError;
      return options.revoked ?? { ...row({ status: 'revoked' }), revoked: true };
    },
    liveSessions: async () => {
      calls.push('liveSessions');
      if (options.live instanceof Error) throw options.live;
      return options.live ?? { credentialId: CRED, sessions: [], loginTerminals: [] };
    },
    finishLogin: async (_c: DbClaims, ws: string, ok: boolean) => {
      calls.push(`finishLogin:${ws}:${String(ok)}`);
      const error = options.finishError?.(ws);
      if (error) throw error;
      return { workSessionId: ws, finished: true as const, connected: false, credential: row({ status: 'revoked' }) };
    },
    readSpacePolicy: async () => { calls.push('readSpacePolicy'); return { anthropic: ['space' as const] }; },
    setSpacePolicy: async (_c: DbClaims, spaceId: string, provider: 'anthropic', allowedSources: Array<'space'> | null) => {
      calls.push('setSpacePolicy');
      return { spaceId, provider, allowedSources };
    },
    readNodePolicy: async () => { calls.push('readNodePolicy'); return { openai: false }; },
    setNodePolicy: async (_c: DbClaims, provider: 'anthropic', allowNode: boolean | null) => {
      calls.push('setNodePolicy');
      return { provider, allowNode };
    },
  };
  return store;
}

function terminals(calls: string[], outcome: (id: string) => string = () => 'killed') {
  return {
    terminate: (id: string) => { calls.push(`kill:${id}`); return outcome(id); },
    hasLiveTerminal: () => true,
  };
}

const okProbe = (displayLogin: string | null = null): SpaceCredentialProbe => async () => ({ ok: true, displayLogin });
const probeSaying = (result: SpaceCredentialProbeResult): SpaceCredentialProbe => async () => result;

function service(options: {
  calls: string[];
  store?: ReturnType<typeof fakeStore>;
  probe?: SpaceCredentialProbe;
  terminate?: (id: string) => string;
  removeLoginHome?: () => Promise<void>;
  env?: Record<string, string | undefined>;
  dbRows?: unknown[];
}) {
  const store = options.store ?? fakeStore({ calls: options.calls });
  return {
    store,
    svc: new SpaceCredentialCatalogService({
      db: {
        query: async <R>() => {
          options.calls.push('query:space_credentials');
          return (options.dbRows ?? [{ provider: 'anthropic', shape: 'api_key' }]) as R[];
        },
      },
      store: store as never,
      probe: options.probe ?? okProbe(),
      terminals: terminals(options.calls, options.terminate),
      ...(options.removeLoginHome ? { removeLoginHome: options.removeLoginHome } : {}),
      env: options.env ?? {},
    }),
  };
}

async function caught(promise: Promise<unknown>): Promise<CollabError> {
  const error = await promise.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(CollabError);
  return error as CollabError;
}

/** Everything a caller or an operator could ever see of an error. */
function surfaceOf(error: unknown): string {
  if (error instanceof CollabError) {
    return JSON.stringify({ code: error.code, message: error.message, details: error.details ?? null, stack: error.stack });
  }
  return error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ''}` : String(error);
}

// ---------------------------------------------------------------------------
// the vendor probe
// ---------------------------------------------------------------------------

describe('t3-3: the vendor probe', () => {
  type Seen = { url: string; headers: Record<string, string> };
  function fetchAnswering(status: number, body: unknown = {}, seen: Seen[] = []) {
    return async (url: string, init: { headers: Record<string, string> }) => {
      seen.push({ url, headers: init.headers });
      return { status, ok: status >= 200 && status < 300, json: async () => body };
    };
  }

  it('asks each vendor one authenticated read, with the secret in a header and nowhere else', async () => {
    const seen: Seen[] = [];
    const probe = createVendorProbe({ fetch: fetchAnswering(200, { login: 'octocat' }, seen) });
    for (const provider of ['anthropic', 'openai', 'github'] as const) {
      await probe({ provider, secret: SECRET });
    }
    expect(seen.map((s) => s.url)).toEqual([
      'https://api.anthropic.com/v1/models?limit=1',
      'https://api.openai.com/v1/models',
      'https://api.github.com/user',
    ]);
    expect(seen[0]!.headers['x-api-key']).toBe(SECRET);
    expect(seen[1]!.headers['authorization']).toBe(`Bearer ${SECRET}`);
    expect(seen[2]!.headers['authorization']).toBe(`Bearer ${SECRET}`);
    for (const s of seen) expect(s.url).not.toContain(SECRET);
  });

  it('401 and 403 are a REFUSAL; 5xx is unreachable; 200 is ok — and GitHub names its login (D10)', async () => {
    expect(await createVendorProbe({ fetch: fetchAnswering(401) })({ provider: 'anthropic', secret: SECRET }))
      .toEqual({ ok: false, reason: 'rejected', detail: 'HTTP 401' });
    expect(await createVendorProbe({ fetch: fetchAnswering(403) })({ provider: 'openai', secret: SECRET }))
      .toEqual({ ok: false, reason: 'rejected', detail: 'HTTP 403' });
    expect(await createVendorProbe({ fetch: fetchAnswering(503) })({ provider: 'anthropic', secret: SECRET }))
      .toEqual({ ok: false, reason: 'unreachable', detail: 'HTTP 503' });
    expect(await createVendorProbe({ fetch: fetchAnswering(200) })({ provider: 'anthropic', secret: SECRET }))
      .toEqual({ ok: true, displayLogin: null });
    expect(await createVendorProbe({ fetch: fetchAnswering(200, { login: ' octocat ' }) })({ provider: 'github', secret: SECRET }))
      .toEqual({ ok: true, displayLogin: 'octocat' });
  });

  it('t3-10: a transport error that QUOTES the secret is reported by its name only', async () => {
    const probe = createVendorProbe({
      fetch: async () => { throw new TypeError(`connect failed for header x-api-key: ${SECRET}`); },
    });
    const result = await probe({ provider: 'anthropic', secret: SECRET });
    expect(result).toEqual({ ok: false, reason: 'unreachable', detail: 'TypeError' });
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });
});

// ---------------------------------------------------------------------------
// create / rekey — the probe gates the write
// ---------------------------------------------------------------------------

describe('t3-3: a key the vendor refuses is never stored; status comes from the probe', () => {
  it('rejected → invalid_input, and store.create is NEVER called', async () => {
    const calls: string[] = [];
    const { svc, store } = service({ calls, probe: probeSaying({ ok: false, reason: 'rejected', detail: 'HTTP 401' }) });
    const error = await caught(svc.create(HUMAN, SPACE, { provider: 'anthropic', shape: 'api_key', label: 'k', secret: SECRET }));
    expect(error.code).toBe('invalid_input');
    expect(error.details?.['reason']).toBe('credential_rejected');
    expect(store.stored).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('unreachable → upstream_unavailable, and still nothing stored (never an unmeasured key)', async () => {
    const calls: string[] = [];
    const { svc, store } = service({ calls, probe: probeSaying({ ok: false, reason: 'unreachable', detail: 'TimeoutError' }) });
    const error = await caught(svc.create(HUMAN, SPACE, { provider: 'openai', shape: 'api_key', label: 'k', secret: SECRET }));
    expect(error.code).toBe('upstream_unavailable');
    expect(error.details?.['reason']).toBe('credential_probe_unreachable');
    expect(store.stored).toEqual([]);
  });

  it('CONTROL: an accepted key is stored with the probe\'s display login, and the view is metadata only', async () => {
    const calls: string[] = [];
    const { svc, store } = service({ calls, probe: okProbe('octocat') });
    const view = await svc.create(HUMAN, SPACE, { provider: 'github', shape: 'token', label: 'bot', secret: SECRET });
    expect(store.stored).toEqual([{ op: 'create', args: [expect.objectContaining({ displayLogin: 'octocat', secret: SECRET })] }]);
    expect(view.status).toBe('active');
    expect(Object.keys(view)).not.toContain('pendingExpiresAt');
    expect(JSON.stringify(view)).not.toContain(SECRET);
  });

  it('a too-short key is invalid_input, not a 500', async () => {
    const calls: string[] = [];
    const store = fakeStore({ calls, createError: new Error('credential is too short') });
    const { svc } = service({ calls, store });
    const error = await caught(svc.create(HUMAN, SPACE, { provider: 'anthropic', shape: 'api_key', label: 'k', secret: 'abc' }));
    expect(error.code).toBe('invalid_input');
  });

  it('t3-7: rekey probes the NEW key before replacing the old; a refused one leaves the old in place', async () => {
    const calls: string[] = [];
    const { svc, store } = service({ calls, probe: probeSaying({ ok: false, reason: 'rejected', detail: 'HTTP 401' }) });
    const error = await caught(svc.rekey(HUMAN, CRED, SECRET));
    expect(error.code).toBe('invalid_input');
    expect(store.stored).toEqual([]);
    expect(calls).toEqual(['query:space_credentials']);
  });

  it('t3-7 CONTROL: an accepted new key reaches store.rekey', async () => {
    const calls: string[] = [];
    const { svc, store } = service({ calls });
    await svc.rekey(HUMAN, CRED, SECRET);
    expect(store.stored).toEqual([{ op: 'rekey', args: [CRED, SECRET, null] }]);
  });

  it('rekey refuses a login credential (renewed by logging in) and answers not_found for an unseen id', async () => {
    const login = service({ calls: [], dbRows: [{ provider: 'anthropic', shape: 'login' }] });
    expect((await caught(login.svc.rekey(HUMAN, CRED, SECRET))).code).toBe('invalid_input');
    expect(login.store.stored).toEqual([]);
    const missing = service({ calls: [], dbRows: [] });
    expect((await caught(missing.svc.rekey(HUMAN, CRED, SECRET))).code).toBe('not_found');
  });
});

// ---------------------------------------------------------------------------
// delete — the order is the point
// ---------------------------------------------------------------------------

describe('t3-4/t3-8: delete revokes, reads, kills every launcher\'s sessions, then stamps', () => {
  const live: SpaceCredentialLiveSessions = {
    credentialId: CRED,
    sessions: [
      { workSessionId: AGENT_A, provider: 'anthropic', launcherAccountId: 'acct-a', status: 'running' },
      { workSessionId: AGENT_B, provider: 'anthropic', launcherAccountId: 'acct-b', status: 'running' },
    ],
    loginTerminals: [
      { workSessionId: LOGIN_A, accountId: 'acct-a', expiresAt: '2026-09-23T01:00:00.000Z' },
      { workSessionId: LOGIN_B, accountId: 'acct-b', expiresAt: '2026-09-23T01:00:00.000Z' },
    ],
  };

  it('revoke → liveSessions → kill every PTY → stamp each killed login → file home', async () => {
    const calls: string[] = [];
    const store = fakeStore({ calls, live, revoked: { ...row({ shape: 'login', status: 'revoked' }), revoked: true } });
    const { svc } = service({ calls, store, removeLoginHome: async () => { calls.push('removeLoginHome'); } });
    const result = await svc.delete(HUMAN, CRED);

    expect(calls).toEqual([
      'revoke',
      'liveSessions',
      `kill:${LOGIN_A}`,
      `kill:${LOGIN_B}`,
      `kill:${AGENT_A}`,
      `kill:${AGENT_B}`,
      `finishLogin:${LOGIN_A}:false`,
      `finishLogin:${LOGIN_B}:false`,
      'removeLoginHome',
    ]);
    expect(result).toEqual({
      credentialId: CRED,
      revoked: true,
      terminatedLoginSessionIds: [LOGIN_A, LOGIN_B],
      terminatedAgentSessionIds: [AGENT_A, AGENT_B],
      failures: [],
    });
  });

  it('an api_key delete has no file home to remove', async () => {
    const calls: string[] = [];
    const { svc } = service({ calls, removeLoginHome: async () => { calls.push('removeLoginHome'); } });
    await svc.delete(HUMAN, CRED);
    expect(calls).toEqual(['revoke', 'liveSessions']);
  });

  it('a refused revoke is the answer — nothing is read, killed or stamped', async () => {
    const calls: string[] = [];
    const store = fakeStore({ calls, live, revokeError: new CollabError('not_found', 'space credential not found') });
    const { svc } = service({ calls, store });
    expect((await caught(svc.delete(HUMAN, CRED))).code).toBe('not_found');
    expect(calls).toEqual(['revoke']);
  });

  it('a terminal the host could not kill is NOT stamped, and is reported', async () => {
    const calls: string[] = [];
    const store = fakeStore({ calls, live });
    const { svc } = service({ calls, store, terminate: (id) => (id === LOGIN_B || id === AGENT_B ? 'error' : 'killed') });
    const result = await svc.delete(HUMAN, CRED);
    expect(calls.filter((c) => c.startsWith('finishLogin'))).toEqual([`finishLogin:${LOGIN_A}:false`]);
    expect(result.terminatedLoginSessionIds).toEqual([LOGIN_A]);
    expect(result.terminatedAgentSessionIds).toEqual([AGENT_A]);
    expect(result.failures.map((f) => [f.step, f.sessionId])).toEqual([
      ['loginSession', LOGIN_B],
      ['agentSession', AGENT_B],
    ]);
  });

  it('an agent session with no PTY on this node counts as terminated (not_found is the state asked for)', async () => {
    const calls: string[] = [];
    const { svc } = service({ calls, store: fakeStore({ calls, live }), terminate: () => 'not_found' });
    const result = await svc.delete(HUMAN, CRED);
    expect(result.terminatedAgentSessionIds).toEqual([AGENT_A, AGENT_B]);
  });

  it('a stamp refusal and a liveSessions failure are named, never thrown — the revoke already happened', async () => {
    const calls: string[] = [];
    const stampRefused = fakeStore({
      calls,
      live,
      finishError: (ws) => (ws === LOGIN_A ? new CollabError('not_found', 'no space login terminal of yours') : undefined),
    });
    const first = await service({ calls, store: stampRefused }).svc.delete(HUMAN, CRED);
    expect(first.revoked).toBe(true);
    expect(first.terminatedLoginSessionIds).toEqual([LOGIN_B]);
    expect(first.failures).toEqual([{ step: 'loginSession', sessionId: LOGIN_A, reason: 'no space login terminal of yours' }]);

    const unread = await service({ calls: [], store: fakeStore({ calls: [], live: new Error('pool exhausted') }) }).svc.delete(HUMAN, CRED);
    expect(unread.failures).toEqual([{ step: 'agentSession', reason: 'pool exhausted' }]);
  });

  it('a file-home failure is named last, after every kill and stamp', async () => {
    const calls: string[] = [];
    const store = fakeStore({ calls, live, revoked: { ...row({ shape: 'login', status: 'revoked' }), revoked: true } });
    const { svc } = service({ calls, store, removeLoginHome: async () => { throw new Error('EACCES'); } });
    const result = await svc.delete(HUMAN, CRED);
    expect(result.failures).toEqual([{ step: 'files', reason: 'EACCES' }]);
    expect(result.terminatedLoginSessionIds).toEqual([LOGIN_A, LOGIN_B]);
  });
});

// ---------------------------------------------------------------------------
// policies and node status
// ---------------------------------------------------------------------------

describe('policy and node status views', () => {
  it('policy.get lists every provider, absent meaning "every source"; node status says only whether a key is PRESENT', async () => {
    const { svc } = service({ calls: [], env: { ANTHROPIC_API_KEY: SECRET, GITHUB_TOKEN: '  ' } });
    expect(await svc.policy(HUMAN, SPACE)).toEqual({
      spaceId: SPACE,
      providers: [
        { provider: 'anthropic', allowedSources: ['space'] },
        { provider: 'openai', allowedSources: null },
        { provider: 'github', allowedSources: null },
      ],
      node: [
        { provider: 'anthropic', allowNode: null },
        { provider: 'openai', allowNode: false },
        { provider: 'github', allowNode: null },
      ],
    });
    const status = await svc.nodeStatus(HUMAN);
    expect(status.providers.map((p) => [p.provider, p.envKeyPresent])).toEqual([
      ['anthropic', true],
      ['openai', false],
      ['github', false],
    ]);
    // I5: the node's own key is reported by presence, never by value.
    expect(JSON.stringify(status)).not.toContain(SECRET);
  });
});

// ---------------------------------------------------------------------------
// handler-level: the node-admin gate and I5 on every refusal path
// ---------------------------------------------------------------------------

type QueryCall = { sql: string; params: readonly unknown[] };

function handlerHarness(probe: SpaceCredentialProbe) {
  const queries: QueryCall[] = [];
  const rpcs: string[] = [];
  const db = {
    tx: async <T>(_c: DbClaims, fn: (q: unknown) => Promise<T>) => fn({
      query: async (sql: string, params: readonly unknown[] = []) => { queries.push({ sql, params }); return []; },
      rpc: async (fn: string) => { rpcs.push(fn); return {}; },
    }),
    query: async (_c: DbClaims, sql: string, params: readonly unknown[] = []) => {
      queries.push({ sql, params });
      // rekey pre-reads provider/shape; answer it so the probe is reached.
      return sql.includes('select provider, shape from public.space_credentials')
        ? [{ provider: 'anthropic', shape: 'api_key' }]
        : [];
    },
    rpc: async (_c: DbClaims, fn: string) => { rpcs.push(fn); return {}; },
    end: async () => undefined,
  };
  const deps = {
    db,
    config: { host: '127.0.0.1', port: 0, uiDir: undefined, maxBodyBytes: 1024, databaseUrl: undefined },
    owner: async () => ({
      identityId: 'identity-human',
      accountId: '00000000-0000-7000-8000-000000000099',
      username: 'human',
      isNodeAdmin: false,
      isOwner: true,
    }),
  } as unknown as FacadeDeps;
  const registry = new HandlerRegistry();
  registerCredentialHandlers(registry, deps, {
    launcher: { terminate: () => 'killed', hasLiveTerminal: () => false, launch: () => { throw new Error('unexpected'); } } as never,
    dataDir: '/tmp/tm8-sc3-unit',
    probeSpaceCredential: probe,
  });
  return { registry, queries, rpcs };
}

function ctx(
  opName: OperationName,
  options: { params?: Record<string, string>; body?: unknown; nodeAdmin?: boolean } = {},
): RequestContext {
  return {
    op: { name: opName, method: 'POST', path: '/test', kind: 'command', status: 'v1' },
    opName,
    params: options.params ?? {},
    query: new URLSearchParams(),
    body: options.body,
    requestId: 'req-sc3',
    identity: { kind: 'bearer', identityId: 'identity-human', authKind: 'browser', nodeAdmin: options.nodeAdmin === true },
    headers: {},
    method: 'POST',
    path: '/test',
  } as RequestContext;
}

async function run(registry: HandlerRegistry, opName: OperationName, context: RequestContext) {
  const handler = registry.get(opName);
  if (!handler) throw new Error(`${opName} not mounted`);
  return handler(context).then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}

describe('t3-5: node.credentials.* refuse a non-node-admin before any query', () => {
  for (const [opName, params, body] of [
    ['node.credentials.status', {}, undefined],
    ['node.credentials.policy.set', { provider: 'openai' }, { allowNode: false }],
  ] as const) {
    it(`${opName}: a signed-in member who is not a node admin is forbidden, with no query made`, async () => {
      const { registry, queries, rpcs } = handlerHarness(okProbe());
      const outcome = await run(registry, opName, ctx(opName, { params, body }));
      expect(outcome.ok).toBe(false);
      const error = (outcome as { error: CollabError }).error;
      expect(error.code).toBe('forbidden');
      expect(error.details?.['reason']).toBe('node_admin_required');
      expect(queries).toEqual([]);
      expect(rpcs).toEqual([]);
    });

    it(`${opName} CONTROL: a node admin is admitted through to the store`, async () => {
      const { registry, queries, rpcs } = handlerHarness(okProbe());
      await run(registry, opName, ctx(opName, { params, body, nodeAdmin: true }));
      expect(queries.length + rpcs.length).toBeGreaterThan(0);
    });
  }
});

describe('t3-2/t3-10: no error path quotes the secret', () => {
  const probes: Array<[string, SpaceCredentialProbe]> = [
    ['rejected', probeSaying({ ok: false, reason: 'rejected', detail: 'HTTP 401' })],
    ['unreachable', probeSaying({ ok: false, reason: 'unreachable', detail: 'TimeoutError' })],
    // The real probe, over a transport that puts the key in its own message.
    ['transport error', createVendorProbe({ fetch: async () => { throw new Error(`socket hang up (x-api-key: ${SECRET})`); } })],
  ];

  for (const [label, probe] of probes) {
    for (const [opName, params, body] of [
      ['credentials.space.create', { spaceId: SPACE }, { provider: 'anthropic', shape: 'api_key', label: 'k', secret: SECRET }],
      ['credentials.space.rekey', { credentialId: CRED }, { secret: SECRET }],
    ] as const) {
      it(`${opName}, probe ${label}: the refusal carries no secret`, async () => {
        const { registry, rpcs } = handlerHarness(probe);
        const outcome = await run(registry, opName, ctx(opName, { params, body }));
        expect(outcome.ok).toBe(false);
        expect(surfaceOf((outcome as { error: unknown }).error)).not.toContain(SECRET);
        // And nothing was written: no management RPC ran.
        expect(rpcs).toEqual([]);
      });
    }
  }

  it('a malformed body is refused without echoing the secret', async () => {
    const { registry } = handlerHarness(okProbe());
    const outcome = await run(registry, 'credentials.space.create', ctx('credentials.space.create', {
      params: { spaceId: SPACE },
      body: { provider: 'not-a-vendor', shape: 'api_key', label: 'k', secret: SECRET },
    }));
    expect(outcome.ok).toBe(false);
    expect(surfaceOf((outcome as { error: unknown }).error)).not.toContain(SECRET);
  });
});
