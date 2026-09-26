/**
 * W6 guard cells: layer 1 of the human-only rule (`requireHumanLinkSession`,
 * facade/handlers/w2/space-links.ts). Layer 2, the strict SQL gate, is
 * space-links.pg.test.ts's "human-only management" block.
 *
 * Every refusal is paired with a positive over the SAME registered handler, and
 * the store is a recording stub: a refused call must never reach it, and an
 * admitted one must. `spaceLinks.list` is the one open door — an agent needs it
 * to know which linked spaces its human has signed in to — so the agent and
 * link cells on it are positives.
 */
import { describe, expect, it } from 'vitest';

import { CollabError } from '@tm8/contract';
import type { OperationName } from '@tm8/contract';

import type { Db } from '../../src/db/types.js';
import type { FacadeDeps } from '../../src/facade/deps.js';
import { HandlerRegistry } from '../../src/facade/registry.js';
import {
  SPACE_LINKS_HUMAN_ONLY,
  registerSpaceLinkHandlers,
} from '../../src/facade/handlers/w2/space-links.js';
import type { DbSpaceLinkStore } from '../../src/credentials/space-link-store.js';
import type { RequestContext } from '../../src/http/types.js';

type AuthKind = 'browser' | 'cli' | 'agent' | 'agent_runtime' | 'link';

const SPACE = '01a0dc00-0000-7000-8000-000000000001';
const TARGET = '01a0dc00-0000-7000-8000-000000000002';
const LINK = '01a0dc00-0000-7000-8000-000000000003';

/** Each write, with a body that parses, so an admitted call reaches the store. */
const WRITES: ReadonlyArray<{ op: OperationName; method: keyof DbSpaceLinkStore; body: unknown }> = [
  { op: 'spaceLinks.add', method: 'add', body: { targetSpaceId: TARGET, clientMutationId: 'cm-add' } },
  { op: 'spaceLinks.login', method: 'login', body: { clientMutationId: 'cm-login' } },
  { op: 'spaceLinks.relogin', method: 'login', body: { clientMutationId: 'cm-relogin' } },
  { op: 'spaceLinks.logout', method: 'logout', body: { clientMutationId: 'cm-logout' } },
  { op: 'spaceLinks.remove', method: 'remove', body: { clientMutationId: 'cm-remove' } },
  { op: 'spaceLinks.setSpawn', method: 'setSpawn', body: { allowSpawn: false, clientMutationId: 'cm-spawn' } },
];

function recordingStore(): { store: DbSpaceLinkStore; calls: string[] } {
  const calls: string[] = [];
  const record = (name: string) => async () => {
    calls.push(name);
    return name === 'list' ? [] : { id: LINK };
  };
  const store = {
    list: record('list'),
    add: record('add'),
    login: record('login'),
    logout: record('logout'),
    remove: record('remove'),
    setSpawn: record('setSpawn'),
  } as unknown as DbSpaceLinkStore;
  return { store, calls };
}

function registryWith(store: DbSpaceLinkStore): HandlerRegistry {
  const deps = {
    db: {} as Db,
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
  registerSpaceLinkHandlers(registry, deps, { dataDir: '/tmp/tm8-space-links-guard', store });
  return registry;
}

function context(op: OperationName, authKind: AuthKind | undefined, body?: unknown): RequestContext {
  return {
    op: { name: op, method: 'POST', path: '/test', kind: 'command', status: 'v1' },
    opName: op,
    params: { spaceId: SPACE, linkId: LINK },
    query: new URLSearchParams(),
    body,
    requestId: 'req-space-links-guard',
    identity: { kind: 'bearer', identityId: 'identity-human', ...(authKind ? { authKind } : {}) },
    headers: {},
    method: 'POST',
    path: '/test',
  } as RequestContext;
}

async function invoke(registry: HandlerRegistry, ctx: RequestContext): Promise<unknown> {
  const handler = registry.get(ctx.opName as OperationName);
  if (!handler) throw new Error(`${ctx.opName} is not registered`);
  return handler(ctx);
}

describe('W6 layer-1 guard — spaceLinks.* writes are human-only', () => {
  // `undefined` is a resolver that established no kind: the guard fails closed.
  const REFUSED: ReadonlyArray<AuthKind | undefined> = ['agent', 'agent_runtime', 'link', undefined];
  const ADMITTED: readonly AuthKind[] = ['browser', 'cli'];

  for (const { op, method, body } of WRITES) {
    for (const kind of REFUSED) {
      it(`${op}: kind ${JSON.stringify(kind ?? null)} is refused forbidden/${SPACE_LINKS_HUMAN_ONLY}, and the store is never reached`, async () => {
        const { store, calls } = recordingStore();
        const error = await invoke(registryWith(store), context(op, kind, body)).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(CollabError);
        expect((error as CollabError).code).toBe('forbidden');
        expect((error as CollabError).details).toEqual({ reason: SPACE_LINKS_HUMAN_ONLY });
        expect(calls).toEqual([]);
      });
    }
    for (const kind of ADMITTED) {
      it(`positive — ${op}: kind ${kind} reaches store.${method}`, async () => {
        const { store, calls } = recordingStore();
        await invoke(registryWith(store), context(op, kind, body));
        expect(calls).toEqual([method]);
      });
    }
  }

  it('the refusal happens before input parsing: a malformed body from an agent is still space_links_human_only', async () => {
    const { store, calls } = recordingStore();
    const error = await invoke(registryWith(store), context('spaceLinks.add', 'agent', { nonsense: true }))
      .catch((e: unknown) => e);
    expect((error as CollabError).details).toEqual({ reason: SPACE_LINKS_HUMAN_ONLY });
    expect(calls).toEqual([]);
  });

  it('positive — the same malformed body from a browser gets past the guard and fails on input', async () => {
    const { store, calls } = recordingStore();
    const error = await invoke(registryWith(store), context('spaceLinks.add', 'browser', { nonsense: true }))
      .catch((e: unknown) => e);
    expect((error as { details?: unknown }).details).not.toEqual({ reason: SPACE_LINKS_HUMAN_ONLY });
    expect(calls).toEqual([]);
  });
});

describe('W6 layer-1 guard — spaceLinks.list is open (no secret, read-only)', () => {
  for (const kind of ['agent', 'agent_runtime', 'link', 'browser', 'cli'] as const) {
    it(`positive — kind ${kind} lists`, async () => {
      const { store, calls } = recordingStore();
      await expect(invoke(registryWith(store), context('spaceLinks.list', kind))).resolves.toEqual([]);
      expect(calls).toEqual(['list']);
    });
  }

  it('an anonymous caller is still refused on list (open to members, not to the world)', async () => {
    const { store, calls } = recordingStore();
    const ctx = { ...context('spaceLinks.list', 'agent'), identity: { kind: 'anonymous' } } as RequestContext;
    const error = await invoke(registryWith(store), ctx).catch((e: unknown) => e);
    expect((error as CollabError).code).toBe('unauthenticated');
    expect(calls).toEqual([]);
  });
});
