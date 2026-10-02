/**
 * `handlers/w2/styles.ts` — the read-modify-write logic the facade owns on top
 * of migration 282 (styles spec 01a0fc22 v8 §4, §6.4, §6.5).
 *
 * The database decides WHO and WHEN; these cases pin what the handler decides
 * before it ever reaches the database: how a merge patch folds onto the row it
 * read, that a stale version is refused WITHOUT a write, how a prefs request
 * merges onto the stored prefs, that the human-only door refuses an agent, and
 * how `styles.list` seats the built-ins.
 *
 * The resolver seam is mocked so these cases test the handler and nothing
 * else: `normalizeForWrite` echoes the document it is given (so the test can
 * read exactly what the handler asked to store) and `resolveDoc` returns a
 * fixed table.
 */
import { describe, expect, it, vi } from 'vitest';

import { CollabError, type OperationName } from '@tm8/contract';

import type { Db, DbClaims, Querier } from '../../src/db/types.js';
import type { FacadeDeps } from '../../src/facade/deps.js';
import { HandlerRegistry } from '../../src/facade/registry.js';
import type { RequestContext } from '../../src/http/types.js';

vi.mock('../../src/facade/services/w2/style-validation.js', () => {
  const BUILTINS = new Set(['builtin:atelier-light', 'builtin:atelier-dark']);
  const fail = (message: string): never => {
    throw new CollabError('invalid_input', message);
  };
  return {
    DEFAULT_STYLE_REF: 'builtin:atelier-light',
    isBuiltinId: (id: string) => BUILTINS.has(id),
    assertKnownRef: (ref: string, field: string) => {
      if (ref.startsWith('builtin:') && !BUILTINS.has(ref)) fail(`${field}: no built-in style "${ref}"`);
    },
    builtinDoc: (id: string) => ({ schemaVersion: 1, foundation: id, vars: {}, css: null }),
    builtinTitle: (id: string) => (id === 'builtin:atelier-dark' ? 'Atelier Dark' : 'Atelier Light'),
    builtinRevision: () => 1,
    parseRefOrUuid: (raw: string) => {
      const value = decodeURIComponent(raw);
      const at = value.indexOf(':');
      if (at < 0) return { kind: 'bare', id: value };
      const kind = value.slice(0, at);
      return kind === 'builtin' ? { kind, id: value } : { kind, id: value.slice(at + 1) };
    },
    normalizeForWrite: (doc: unknown) => ({ doc, warnings: [], clamped: [], hash: 'sha256:normalized' }),
    resolveDoc: () => ({ cssVars: {}, warnings: [], hash: 'sha256:resolved' }),
    exportDoc: () => '',
  };
});

// Imported AFTER the mock is declared (vi.mock is hoisted; this keeps intent obvious).
const { registerW2StyleHandlers } = await import('../../src/facade/handlers/w2/styles.js');

const SPACE_ID = '00000000-0000-7000-8000-000000000001';
const PERSONAL_ID = '00000000-0000-7000-8000-000000000002';
const STYLE_ID = '00000000-0000-7000-8000-000000000003';
const TRUST_A = '00000000-0000-7000-8000-00000000000a';
const TRUST_B = '00000000-0000-7000-8000-00000000000b';
const TRUST_C = '00000000-0000-7000-8000-00000000000c';

type RpcHandler = (fn: string, args: readonly unknown[]) => unknown;

class FakeDb implements Db {
  readonly rpcCalls: Array<{ fn: string; args: readonly unknown[] }> = [];

  constructor(private readonly onRpc: RpcHandler) {}

  private readonly querier: Querier = {
    query: async <R>(): Promise<R[]> => [],
    rpc: async <T>(fn: string, args: readonly unknown[] = []): Promise<T> => {
      this.rpcCalls.push({ fn, args });
      return (await this.onRpc(fn, args)) as T;
    },
  };

  async tx<T>(_claims: DbClaims, fn: (q: Querier) => Promise<T>): Promise<T> {
    return fn(this.querier);
  }

  async query<R>(_claims: DbClaims, sql: string, params: readonly unknown[] = []): Promise<R[]> {
    return this.querier.query<R>(sql, params);
  }

  async rpc<T>(_claims: DbClaims, fn: string, args: readonly unknown[] = []): Promise<T> {
    return this.querier.rpc<T>(fn, args);
  }

  async end(): Promise<void> {}

  fns(): string[] {
    return this.rpcCalls.map((c) => c.fn);
  }
}

function deps(db: Db): FacadeDeps {
  return {
    db,
    config: { host: '127.0.0.1', port: 0, uiDir: undefined, maxBodyBytes: 1024, databaseUrl: undefined },
    owner: async () => ({
      identityId: 'identity-owner',
      accountId: '00000000-0000-7000-8000-000000000099',
      username: 'owner',
      isNodeAdmin: true,
      isOwner: true,
    }),
  } as FacadeDeps;
}

function context(
  opName: OperationName,
  options: { params?: Record<string, string>; body?: unknown; query?: string; authKind?: 'browser' | 'agent' } = {},
): RequestContext {
  return {
    op: { name: opName, method: 'GET', path: '/test', kind: 'read', status: 'v1' },
    opName,
    params: options.params ?? {},
    query: new URLSearchParams(options.query ?? ''),
    body: options.body,
    requestId: 'req-styles',
    identity: { kind: 'bearer', identityId: 'identity-human', authKind: options.authKind ?? 'browser' },
    headers: {},
    method: 'GET',
    path: '/test',
  } as RequestContext;
}

function handlers(db: FakeDb) {
  const registry = new HandlerRegistry();
  registerW2StyleHandlers(registry, deps(db));
  return (name: OperationName) => {
    const handler = registry.get(name);
    if (!handler) throw new Error(`no handler for ${name}`);
    return handler;
  };
}

async function codeOf(run: () => unknown): Promise<{ code: string; details: unknown }> {
  try {
    await run();
  } catch (err) {
    if (err instanceof CollabError) return { code: err.code, details: err.details };
    throw err;
  }
  return { code: 'ok', details: undefined };
}

const CURRENT = {
  id: PERSONAL_ID,
  ref: `personal:${PERSONAL_ID}`,
  title: 'Midnight',
  description: 'kept',
  tags: ['dark'],
  version: 3,
  doc: {
    schemaVersion: 1,
    foundation: 'builtin:atelier-dark',
    vars: { '--pn-brand': '#111111', '--pn-paper': '#222222', '--pn-ink': '#333333' },
    css: null,
  },
  resolvedHash: 'sha256:old',
  publishedAs: null,
  pulledFrom: null,
  createdAt: '2026-10-02T00:00:00.000Z',
  updatedAt: '2026-10-02T00:00:00.000Z',
};

function personalDb(): FakeDb {
  return new FakeDb((fn) => {
    if (fn === 'get_personal_style') return CURRENT;
    if (fn === 'update_personal_style') return { style: { ...CURRENT, version: 4 } };
    throw new Error(`unexpected rpc ${fn}`);
  });
}

/** The `p_vars` argument the handler stored (update_personal_style arg 5). */
function storedVars(db: FakeDb): Record<string, string> {
  const call = db.rpcCalls.find((c) => c.fn === 'update_personal_style');
  if (!call) throw new Error('no update_personal_style call');
  return JSON.parse(call.args[5] as string) as Record<string, string>;
}

describe('styles.personal.update — merge patch over the row as read', () => {
  it('sets present keys, unsets null keys, leaves absent keys untouched', async () => {
    const db = personalDb();
    await handlers(db)('styles.personal.update')(context('styles.personal.update', {
      params: { id: PERSONAL_ID },
      body: {
        clientMutationId: 'cmid-1',
        expectedVersion: 3,
        vars: { '--pn-brand': '#ABCDEF', '--pn-paper': null, '--pn-line': '#444444' },
      },
    }));
    expect(storedVars(db)).toEqual({ '--pn-brand': '#ABCDEF', '--pn-ink': '#333333', '--pn-line': '#444444' });
    const args = db.rpcCalls.find((c) => c.fn === 'update_personal_style')!.args;
    // id, expectedVersion, then the fields the patch did not name are KEPT.
    expect(args.slice(0, 5)).toEqual([PERSONAL_ID, 3, 'Midnight', 'kept', 'builtin:atelier-dark']);
    expect(args[7]).toEqual(['dark']);
    // The hash stored is the one the resolver computed for THIS document.
    expect(args[8]).toBe('sha256:normalized');
  });

  it('varsReplace replaces the whole map', async () => {
    const db = personalDb();
    await handlers(db)('styles.personal.update')(context('styles.personal.update', {
      params: { id: PERSONAL_ID },
      body: { clientMutationId: 'cmid-2', expectedVersion: 3, varsReplace: { '--pn-scrim': '#000000' } },
    }));
    expect(storedVars(db)).toEqual({ '--pn-scrim': '#000000' });
  });

  it('a stale expectedVersion is version_conflict with currentVersion, and NOTHING is written', async () => {
    const db = personalDb();
    const result = await codeOf(() => handlers(db)('styles.personal.update')(context('styles.personal.update', {
      params: { id: PERSONAL_ID },
      body: { clientMutationId: 'cmid-3', expectedVersion: 2, vars: { '--pn-brand': '#ABCDEF' } },
    })));
    expect(result.code).toBe('version_conflict');
    expect((result.details as { currentVersion?: number }).currentVersion).toBe(3);
    expect(db.fns()).toEqual(['get_personal_style']);
  });

  it('description: null clears it; title and tags replace when given', async () => {
    const db = personalDb();
    await handlers(db)('styles.personal.update')(context('styles.personal.update', {
      params: { id: PERSONAL_ID },
      body: { clientMutationId: 'cmid-4', expectedVersion: 3, title: 'Dusk', description: null, tags: ['warm'] },
    }));
    const args = db.rpcCalls.find((c) => c.fn === 'update_personal_style')!.args;
    expect(args[2]).toBe('Dusk');
    expect(args[3]).toBeNull();
    expect(args[7]).toEqual(['warm']);
    // No vars in the request: the map is the one read, unchanged.
    expect(storedVars(db)).toEqual(CURRENT.doc.vars);
  });
});

const EXISTING_PREFS = {
  currentStyle: `space:${STYLE_ID}`,
  darkStyle: 'builtin:atelier-dark',
  followOs: true,
  trustedCss: [TRUST_A, TRUST_B],
  snapshot: { current: null, dark: null, currentHash: null, currentTitle: null },
  revision: 4,
  updatedAt: '2026-10-02T00:00:00.000Z',
};

function prefsDb(existing: unknown = EXISTING_PREFS): FakeDb {
  return new FakeDb((fn, args) => {
    if (fn === 'get_identity_style_prefs') return { prefs: existing };
    if (fn === 'set_identity_style_prefs') {
      return {
        prefs: {
          ...EXISTING_PREFS,
          currentStyle: args[0], darkStyle: args[1], followOs: args[2], trustedCss: args[3], revision: 5,
        },
      };
    }
    throw new Error(`unexpected rpc ${fn}`);
  });
}

function setArgs(db: FakeDb): readonly unknown[] {
  const call = db.rpcCalls.find((c) => c.fn === 'set_identity_style_prefs');
  if (!call) throw new Error('no set_identity_style_prefs call');
  return call.args;
}

describe('identity.stylePrefs.set — merges onto the stored prefs', () => {
  it('absent fields keep the stored value; darkStyle null clears; trustedCss add/remove', async () => {
    const db = prefsDb();
    await handlers(db)('identity.stylePrefs.set')(context('identity.stylePrefs.set', {
      body: { clientMutationId: 'cmid-p1', darkStyle: null, trustedCss: { add: [TRUST_C], remove: [TRUST_A] } },
    }));
    const [current, dark, followOs, trusted, expectedRevision] = setArgs(db);
    expect(current).toBe(`space:${STYLE_ID}`);
    expect(dark).toBeNull();
    expect(followOs).toBe(true);
    expect([...(trusted as string[])].sort()).toEqual([TRUST_B, TRUST_C].sort());
    expect(expectedRevision).toBeNull();
  });

  it('a first choice (no stored prefs) starts from the default, and passes expectedRevision through', async () => {
    const db = prefsDb(null);
    await handlers(db)('identity.stylePrefs.set')(context('identity.stylePrefs.set', {
      body: { clientMutationId: 'cmid-p2', expectedRevision: 0, followOs: true },
    }));
    expect(setArgs(db)).toEqual(['builtin:atelier-light', null, true, [], 0, 'cmid-p2']);
  });

  it('an unknown built-in is invalid_input BEFORE any write', async () => {
    const db = prefsDb();
    const result = await codeOf(() => handlers(db)('identity.stylePrefs.set')(context('identity.stylePrefs.set', {
      body: { clientMutationId: 'cmid-p3', currentStyle: 'builtin:no-such-style' },
    })));
    expect(result.code).toBe('invalid_input');
    expect(db.fns()).not.toContain('set_identity_style_prefs');
  });

  it('an unknown built-in as darkStyle is refused the same way', async () => {
    const db = prefsDb();
    const result = await codeOf(() => handlers(db)('identity.stylePrefs.set')(context('identity.stylePrefs.set', {
      body: { clientMutationId: 'cmid-p4', darkStyle: 'builtin:no-such-style' },
    })));
    expect(result.code).toBe('invalid_input');
    expect(db.fns()).not.toContain('set_identity_style_prefs');
  });
});

describe('spaces.styleDefault.set — human-only', () => {
  const defaultDb = () => new FakeDb((fn, args) => {
    if (fn === 'set_space_style_default') {
      return { spaceId: args[0], defaultStyle: args[1], setBy: null, revision: 1, updatedAt: null };
    }
    throw new Error(`unexpected rpc ${fn}`);
  });
  const body = { clientMutationId: 'cmid-d1', defaultStyle: `space:${STYLE_ID}` };

  it('an agent session is refused with forbidden, and the database is never asked', async () => {
    const db = defaultDb();
    const result = await codeOf(() => handlers(db)('spaces.styleDefault.set')(context('spaces.styleDefault.set', {
      params: { spaceId: SPACE_ID }, body, authKind: 'agent',
    })));
    expect(result.code).toBe('forbidden');
    expect(db.rpcCalls).toEqual([]);
  });

  it('a browser session reaches the door with the ref and the space', async () => {
    const db = defaultDb();
    await handlers(db)('spaces.styleDefault.set')(context('spaces.styleDefault.set', {
      params: { spaceId: SPACE_ID }, body, authKind: 'browser',
    }));
    expect(db.rpcCalls).toEqual([{ fn: 'set_space_style_default', args: [SPACE_ID, `space:${STYLE_ID}`, null, 'cmid-d1'] }]);
  });

  it('an unknown built-in default is invalid_input before the door', async () => {
    const db = defaultDb();
    const result = await codeOf(() => handlers(db)('spaces.styleDefault.set')(context('spaces.styleDefault.set', {
      params: { spaceId: SPACE_ID }, body: { clientMutationId: 'cmid-d2', defaultStyle: 'builtin:no-such-style' },
    })));
    expect(result.code).toBe('invalid_input');
    expect(db.rpcCalls).toEqual([]);
  });
});

describe('styles.list — built-ins first, flags computed', () => {
  const SPACE_ROW = {
    origin: 'space', id: STYLE_ID, ref: `space:${STYLE_ID}`, title: 'Midnight', foundation: 'builtin:atelier-dark',
    varCount: 2, hasCss: false, tags: ['dark'], version: 2, resolvedHash: 'sha256:x',
    pushedBy: '00000000-0000-7000-8000-000000000004', pushedAt: '2026-10-02T00:00:00.000Z',
    isDefault: false, inUseByMe: false, canPush: true,
  };
  const listDb = () => new FakeDb((fn) => {
    if (fn === 'list_space_styles') return { items: [SPACE_ROW], defaultStyle: 'builtin:atelier-dark', defaultDangling: false };
    if (fn === 'get_identity_style_prefs') {
      return { prefs: { ...EXISTING_PREFS, currentStyle: 'builtin:atelier-light', darkStyle: null } };
    }
    throw new Error(`unexpected rpc ${fn}`);
  });

  it('prepends every built-in, marks the default and the one in use, and keeps the space rows after', async () => {
    const db = listDb();
    const result = await handlers(db)('styles.list')(context('styles.list', { params: { spaceId: SPACE_ID } })) as {
      items: Array<Record<string, unknown>>; defaultStyle: string;
    };
    const builtins = result.items.filter((i) => i.origin === 'builtin');
    expect(builtins.length).toBeGreaterThanOrEqual(2);
    expect(result.items.slice(0, builtins.length)).toEqual(builtins);
    expect(result.items[result.items.length - 1]).toEqual(SPACE_ROW);

    const dark = builtins.find((b) => b.id === 'builtin:atelier-dark')!;
    const light = builtins.find((b) => b.id === 'builtin:atelier-light')!;
    expect(dark).toMatchObject({ isDefault: true, inUseByMe: false, canPush: false, ref: 'builtin:atelier-dark' });
    expect(light).toMatchObject({ isDefault: false, inUseByMe: true, canPush: false });
    expect(result.defaultStyle).toBe('builtin:atelier-dark');
  });

  it('?tag= filters every row, built-ins included', async () => {
    const db = listDb();
    const result = await handlers(db)('styles.list')(context('styles.list', {
      params: { spaceId: SPACE_ID }, query: 'tag=dark',
    })) as { items: Array<Record<string, unknown>> };
    expect(result.items).toEqual([SPACE_ROW]);
  });
});
