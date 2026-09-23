/**
 * Lane K — the TypeSafe key as a per-user SERVICE KEY, against a REAL
 * PostgreSQL with migration 203 applied, running as `tm8_app` under each
 * caller's claims so RLS, the column grant and the human-only gate are live.
 *
 *   · the store: sealed at rest, only the last four characters readable,
 *     cipher columns ungranted, one member's key invisible to another, and
 *     agents can neither set nor read a key;
 *   · `launch.suggest` spends the CALLER's key: theirs over the node's; the
 *     node's when they have none; `no_key` when neither exists; and another
 *     member's key never, even in the same space.
 *
 * Every rule has a control beside it that shows the assertion can fail.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import type { LaunchSuggestResult } from '@tm8/contract';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { resetCredentialKeyCache } from '../../src/credentials/credential-key.js';
import { DbServiceKeyStore } from '../../src/credentials/service-key-store.js';
import { createDb } from '../../src/db/index.js';
import type { Db, DbClaims } from '../../src/db/types.js';
import type { FacadeDeps } from '../../src/facade/deps.js';
import { HandlerRegistry } from '../../src/facade/registry.js';
import type { RequestContext } from '../../src/http/types.js';
import { createJevAdvisorResolver } from '../../src/jev/advisor.js';
import { registerJevHandlers } from '../../src/jev/handlers.js';
import type { JevAdvisorPort } from '../../src/jev/port.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 300_000 });

const OWNER = 'svckey-owner';
const MATE = 'svckey-mate';
const OWNER_KEY = 'ts_owner_0123456789abcdefOWNR';
const NODE_KEY = 'ts_node_9876543210zyxwvuNODE';

let database: W1ScratchDatabase;
let db: Db;
let dataDir: string;
let store: DbServiceKeyStore;
const ids: Record<string, string> = {};

const claims = (identityId: string, authKind = 'browser'): DbClaims =>
  ({ identityId, nodeAdmin: false, requestId: randomUUID(), authKind }) as DbClaims;

async function asOwner<T>(fn: (client: import('pg').PoolClient) => Promise<T>): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    return fn(client);
  });
}

const newId = async (c: import('pg').PoolClient): Promise<string> =>
  (await c.query<{ id: string }>('select internal.new_id()::text id')).rows[0]!.id;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'tm8-svckey-'));
  resetCredentialKeyCache();
  database = await createW1ScratchDatabase('service_keys');
  database.apply(migrationFiles());
  db = createDb(database.url);
  store = new DbServiceKeyStore({ db, dataDir });
  await asOwner(async (c) => {
    await c.query(
      `insert into public.user_profiles(identity_id, display_name) values ($1, 'Owner'), ($2, 'Mate')`,
      [OWNER, MATE],
    );
    await c.query(
      `insert into public.accounts(identity_id, username, display_name, is_node_admin, is_owner)
       values ($1, 'svckey-owner', 'Owner', false, true), ($2, 'svckey-mate', 'Mate', false, false)`,
      [OWNER, MATE],
    );
    const space = ids.space = await newId(c);
    await c.query(`insert into public.spaces(id, name, created_by_identity) values ($1, 'Keys', $2)`, [space, OWNER]);
    // BOTH identities are members of the one space: the per-user rule must
    // hold between colleagues, not merely between strangers.
    for (const [identity, role] of [[OWNER, 'owner'], [MATE, 'member']] as const) {
      const member = ids[`member:${identity}`] = await newId(c);
      await c.query(`insert into public.entities(id, space_id, kind, position, created_by) values ($1, $2, 'member', 0, $1)`, [member, space]);
      await c.query(
        `insert into public.members(entity_id, space_id, identity_id, role, display_name) values ($1, $2, $3, $4, $3)`,
        [member, space, identity, role],
      );
    }
    ids.task = await newId(c);
    await c.query(
      `insert into public.entities(id, space_id, kind, position, created_by) values ($1, $2, 'task', 0, $3)`,
      [ids.task, space, ids[`member:${OWNER}`]],
    );
    await c.query(`insert into public.tasks(entity_id, title, description) values ($1, 'Fix login', 'SSO lands on 404')`, [ids.task]);
  });
}, 300_000);

afterAll(async () => {
  await db?.end();
  await database?.destroy();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
  resetCredentialKeyCache();
});

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

describe('the service key store (203)', () => {
  it('seals the key at rest and answers only its last four characters', async () => {
    const stored = await store.put(claims(OWNER), 'typesafe', `  ${OWNER_KEY}\n`);
    expect(stored).toMatchObject({ provider: 'typesafe', keyHint: 'OWNR' });

    const [row] = await asOwner(async (c) => (await c.query<{ key_ciphertext: Buffer; key_hint: string }>(
      `select key_ciphertext, key_hint from public.account_service_keys k
         join public.accounts a on a.id = k.account_id where a.identity_id = $1`, [OWNER],
    )).rows);
    expect(row!.key_hint).toBe('OWNR');
    // Control: the plaintext IS findable when it is there — search a buffer
    // that holds it, so the negative below is a real measurement.
    expect(Buffer.from(`x${OWNER_KEY}x`).includes(OWNER_KEY)).toBe(true);
    expect(row!.key_ciphertext.includes(OWNER_KEY)).toBe(false);
    expect(row!.key_ciphertext.includes(OWNER_KEY.slice(0, 12))).toBe(false);

    expect(await store.status(claims(OWNER))).toEqual([
      expect.objectContaining({ provider: 'typesafe', keyHint: 'OWNR' }),
    ]);
    expect(await store.resolve(claims(OWNER), 'typesafe')).toBe(OWNER_KEY);
  });

  it('never grants the cipher columns to tm8_app (control: the hint column is readable)', async () => {
    await expect(db.query(claims(OWNER), 'select key_hint from public.account_service_keys')).resolves.toHaveLength(1);
    await expect(db.query(claims(OWNER), 'select key_ciphertext from public.account_service_keys'))
      .rejects.toThrow(/permission denied/);
    await expect(db.query(claims(OWNER), 'select key_nonce from public.account_service_keys'))
      .rejects.toThrow(/permission denied/);
  });

  it('one member never sees another member’s key (control: the owner does)', async () => {
    expect(await store.status(claims(MATE))).toEqual([]);
    expect(await store.resolve(claims(MATE), 'typesafe')).toBeNull();
    expect(await store.resolve(claims(OWNER), 'typesafe')).toBe(OWNER_KEY);
  });

  it('an agent session can neither read nor set a key (control: a browser session can)', async () => {
    await expect(store.resolve(claims(OWNER, 'agent'), 'typesafe')).rejects.toThrow(/human-only/);
    await expect(store.put(claims(OWNER, 'agent'), 'typesafe', 'ts_agent_attempt_1234')).rejects.toThrow(/human-only/);
    await expect(store.delete(claims(OWNER, 'agent'), 'typesafe')).rejects.toThrow(/human-only/);
    expect(await store.resolve(claims(OWNER, 'browser'), 'typesafe')).toBe(OWNER_KEY);
  });

  it('refuses a provider outside 203’s set', async () => {
    await expect(store.put(claims(OWNER), 'github' as never, 'ghp_not_a_service_key')).rejects.toThrow(/unsupported service key provider/);
  });

  it('delete is idempotent and leaves no key behind', async () => {
    await store.put(claims(MATE), 'typesafe', 'ts_mate_temporary_MATE');
    expect(await store.delete(claims(MATE), 'typesafe')).toBe(true);
    expect(await store.delete(claims(MATE), 'typesafe')).toBe(false);
    expect(await store.resolve(claims(MATE), 'typesafe')).toBeNull();
    // Deleting Mate's key touched nothing of the owner's.
    expect(await store.resolve(claims(OWNER), 'typesafe')).toBe(OWNER_KEY);
  });
});

// ---------------------------------------------------------------------------
// launch.suggest spends the caller's key
// ---------------------------------------------------------------------------

/** An advisor that remembers which key built it; every group answers ok. */
function recordingAdvisors() {
  const built: string[] = [];
  const advisorForKey = (apiKey: string): JevAdvisorPort => {
    built.push(apiKey);
    const call = { jevModel: 'jev-1.13.0', inputTokens: 10, outputTokens: 1, costUsd: 0, latencyMs: 1, outcome: 'ok' as const };
    return {
      async rank({ candidates }) { return { ok: true, ranked: candidates.map((c) => ({ id: c.id, score: 2 })), calls: [call] }; },
      async model() {
        return { ok: true, call, verdict: { tier: 'standard', model: 'claude-sonnet-5', agentTool: 'claude-code', effort: 'medium', need: 1, workKind: 'bugfix', reasons: [] } };
      },
    };
  };
  return { built, advisorForKey };
}

function suggestAs(identity: string, opts: { nodeKey: string | null; authKind?: string }) {
  const advisors = recordingAdvisors();
  const registry = new HandlerRegistry();
  const deps = { db, config: {}, owner: async () => ({ identityId: identity, isNodeAdmin: false }) } as unknown as FacadeDeps;
  registerJevHandlers(registry, deps, {
    resolveAdvisor: createJevAdvisorResolver({
      readMemberKey: (c) => store.resolve(c, 'typesafe'),
      nodeKey: opts.nodeKey,
      advisorForKey: advisors.advisorForKey,
    }),
  });
  const handler = registry.get('launch.suggest')!;
  const run = () => handler({
    params: { spaceId: ids.space }, query: new URLSearchParams(),
    body: { runId: randomUUID(), requestId: randomUUID(), subjectId: ids.task, groups: ['model'] },
    requestId: randomUUID(), identity: { kind: 'loopback', authKind: opts.authKind ?? 'browser' },
    headers: {}, method: 'POST', path: '/',
  } as unknown as RequestContext) as Promise<LaunchSuggestResult>;
  return { run, built: advisors.built };
}

describe('launch.suggest resolves the key per caller', () => {
  it('the caller’s own key wins over the node’s', async () => {
    const asOwnerWithNode = suggestAs(OWNER, { nodeKey: NODE_KEY });
    const result = await asOwnerWithNode.run();
    expect(result.groups.model?.status).toBe('ok');
    expect(asOwnerWithNode.built).toEqual([OWNER_KEY]);
  });

  it('a caller with no key gets the node’s — never a colleague’s (control: the colleague gets theirs)', async () => {
    const asMate = suggestAs(MATE, { nodeKey: NODE_KEY });
    expect((await asMate.run()).groups.model?.status).toBe('ok');
    expect(asMate.built).toEqual([NODE_KEY]);
    expect(asMate.built).not.toContain(OWNER_KEY);
    // Control, same space, same moment: the owner's request DOES build from
    // the owner's key, so the absence above is the per-caller rule, not a
    // store that returned nothing to anybody.
    const asOwnerAgain = suggestAs(OWNER, { nodeKey: NODE_KEY });
    await asOwnerAgain.run();
    expect(asOwnerAgain.built).toEqual([OWNER_KEY]);
  });

  it('neither key → every group failed: no_key, and no client is built (control: the owner needs no node key)', async () => {
    const asMate = suggestAs(MATE, { nodeKey: null });
    const result = await asMate.run();
    expect(result.groups.model).toEqual({ status: 'failed', reason: 'no_key', cost: { calls: 0, inputTokens: 0, outputTokens: 0, usd: 0, latencyMs: 0 } });
    expect(asMate.built).toEqual([]);

    const asOwnerNoNode = suggestAs(OWNER, { nodeKey: null });
    expect((await asOwnerNoNode.run()).groups.model?.status).toBe('ok');
    expect(asOwnerNoNode.built).toEqual([OWNER_KEY]);
  });

  it('an agent session never spends its owner’s key — node key or nothing', async () => {
    const asAgent = suggestAs(OWNER, { nodeKey: NODE_KEY, authKind: 'agent' });
    await asAgent.run();
    expect(asAgent.built).toEqual([NODE_KEY]);
    const asAgentNoNode = suggestAs(OWNER, { nodeKey: null, authKind: 'agent' });
    expect((await asAgentNoNode.run()).groups.model).toMatchObject({ status: 'failed', reason: 'no_key' });
    expect(asAgentNoNode.built).toEqual([]);
  });
});
