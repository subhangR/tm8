/**
 * 323 against a real Postgres: `internal.node_settings`, its two doors, the
 * auto-owner lockout guard, and `w2_update_space`'s new `visibility` key.
 *
 * Pinned here:
 *   - only an active node admin on a human session reads or writes settings;
 *     tm8_app has no direct access to the table;
 *   - the name allow-list is the table's;
 *   - TM8_NODE_MODE=multi / TM8_DISABLE_AUTO_OWNER=true are refused for an
 *     admin whose account has no password (they could not sign in after the
 *     restart), allowed for one with a password; turning loopback sign-in back
 *     on is never refused;
 *   - the service refuses the same writes from the auto-owner arm;
 *   - the boot read (`readStoredNodeSettings`) sees what the doors stored.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { CollabError } from '@tm8/contract';

import { readStoredNodeSettings } from '../../src/configs/node-settings.js';
import { ConfigsService } from '../../src/configs/service.js';
import { createDb, type Db } from '../../src/db/index.js';
import type { DbClaims } from '../../src/db/types.js';

import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 300_000 });

const ADMIN = 'ns-323-admin';
const NO_PASSWORD_ADMIN = 'ns-323-nopw';
const MEMBER = 'ns-323-member';

let database: W1ScratchDatabase;
let facadeDb: Db;
let spaceId: string;

type Q = (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

async function as<T>(
  identityId: string,
  opts: { nodeAdmin?: boolean; authKind?: string },
  fn: (q: Q) => Promise<T>,
): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_app');
    await client.query(
      `select set_config('tm8.identity_id',$1,true),set_config('tm8.actor_id','',true),
              set_config('tm8.node_admin',$2,true),set_config('tm8.request_id','req-323',true),
              set_config('tm8.auth_kind',$3,true)`,
      [identityId, String(opts.nodeAdmin ?? false), opts.authKind ?? 'browser'],
    );
    return fn(async (sql, params = []) => (await client.query(sql, params)).rows as Record<string, unknown>[]);
  });
}

async function sqlState(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

const set = (identityId: string, name: string, value: string | null) =>
  as(identityId, { nodeAdmin: true }, (q) => q('select public.set_node_setting($1,$2) r', [name, value]));

const claims = (identityId: string): DbClaims => ({
  identityId,
  nodeAdmin: true,
  authKind: 'browser',
  requestId: 'req-323',
});

beforeAll(async () => {
  database = await createW1ScratchDatabase('node_settings_323');
  database.apply(migrationFiles());
  facadeDb = createDb(database.url);
  spaceId = await database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    await client.query(
      `insert into public.accounts(identity_id, username, is_node_admin, is_owner, password_algorithm, password_hash)
       values ($1, 'ns-admin', false, true, 'scrypt', 'x'),
              ($2, 'ns-nopw', true, false, null, null),
              ($3, 'ns-member', false, false, 'scrypt', 'x')`,
      [ADMIN, NO_PASSWORD_ADMIN, MEMBER],
    );
    const id = (await client.query<{ id: string }>('select internal.new_id()::text id')).rows[0]!.id;
    const memberId = (await client.query<{ id: string }>('select internal.new_id()::text id')).rows[0]!.id;
    await client.query(`insert into public.user_profiles(identity_id,display_name) values($1,'Admin')`, [ADMIN]);
    await client.query(`insert into public.spaces(id,name,created_by_identity) values($1,'Settings',$2)`, [id, ADMIN]);
    await client.query(
      `insert into public.entities(id,space_id,kind,parent_id,position,created_by) values($1,$2,'member',null,0,$1)`,
      [memberId, id],
    );
    await client.query(
      `insert into public.members(entity_id,space_id,identity_id,role,display_name) values($1,$2,$3,'owner','Admin')`,
      [memberId, id, ADMIN],
    );
    return id;
  });
});

afterAll(async () => {
  await facadeDb?.close?.();
  await database?.destroy();
});

describe('323 node settings doors', () => {
  it('stores, lists and clears a setting for a node admin', async () => {
    await set(ADMIN, 'TM8_SESSION_CAP', '32');
    const listed = await as(ADMIN, { nodeAdmin: true }, (q) => q('select public.node_settings_list() r'));
    expect((listed[0]!.r as Record<string, { value: string }>).TM8_SESSION_CAP!.value).toBe('32');
    await set(ADMIN, 'TM8_SESSION_CAP', null);
    const cleared = await as(ADMIN, { nodeAdmin: true }, (q) => q('select public.node_settings_list() r'));
    expect(cleared[0]!.r).toEqual({});
  });

  it('refuses a non-admin, an agent session, and direct table access', async () => {
    expect(await sqlState(as(MEMBER, {}, (q) => q('select public.node_settings_list()')))).toBe('42501');
    expect(await sqlState(as(MEMBER, {}, (q) => q(`select public.set_node_setting('TM8_SESSION_CAP','8')`)))).toBe('42501');
    expect(await sqlState(as(ADMIN, { nodeAdmin: true, authKind: 'agent' }, (q) =>
      q(`select public.set_node_setting('TM8_SESSION_CAP','8')`)))).toBe('42501');
    expect(await sqlState(as(ADMIN, { nodeAdmin: true }, (q) => q('select * from internal.node_settings')))).toBe('42501');
  });

  it('only stores names on the curated list', async () => {
    expect(await sqlState(set(ADMIN, 'TM8_DATABASE_URL', 'postgres://x'))).toBe('23514');
  });
});

describe('323 lockout guard', () => {
  it('refuses turning off loopback sign-in for an admin without a password', async () => {
    expect(await sqlState(set(NO_PASSWORD_ADMIN, 'TM8_NODE_MODE', 'multi'))).toBe('42501');
    expect(await sqlState(set(NO_PASSWORD_ADMIN, 'TM8_DISABLE_AUTO_OWNER', 'true'))).toBe('42501');
    // Turning it back on, or any other setting, is never refused.
    await set(NO_PASSWORD_ADMIN, 'TM8_NODE_MODE', 'single');
    await set(NO_PASSWORD_ADMIN, 'TM8_DISABLE_AUTO_OWNER', 'false');
    await set(NO_PASSWORD_ADMIN, 'TM8_WORKTREE_CAP', '3');
  });

  it('allows it for an admin who can sign in with a password', async () => {
    await set(ADMIN, 'TM8_NODE_MODE', 'multi');
    await set(ADMIN, 'TM8_NODE_MODE', null);
  });

  it('the service names the refusal, and refuses the auto-owner arm before the RPC', async () => {
    const service = new ConfigsService(facadeDb, {}, () => ({ pinnedByEnv: new Set(), applied: new Map() }));
    const viaPassword = { claims: claims(NO_PASSWORD_ADMIN), authKind: 'browser', viaAutoOwner: false };
    await expect(service.setNodeSetting(viaPassword, 'TM8_NODE_MODE', 'multi')).rejects.toMatchObject({
      code: 'forbidden',
      details: { reason: 'auto_owner_lockout' },
    });
    const viaAutoOwner = { claims: claims(ADMIN), authKind: 'browser', viaAutoOwner: true };
    await expect(service.setNodeSetting(viaAutoOwner, 'TM8_DISABLE_AUTO_OWNER', 'true')).rejects.toBeInstanceOf(CollabError);
    const listed = await as(ADMIN, { nodeAdmin: true }, (q) => q('select public.node_settings_list() r'));
    // Still the 'false' stored above: the refused write changed nothing.
    expect((listed[0]!.r as Record<string, { value: string }>).TM8_DISABLE_AUTO_OWNER!.value).toBe('false');

    // A normal write reports the restart it needs.
    const result = await service.setNodeSetting(
      { claims: claims(ADMIN), authKind: 'browser', viaAutoOwner: false },
      'TM8_TERMINAL_CAP',
      ' Unlimited ',
    );
    expect(result).toEqual({ name: 'TM8_TERMINAL_CAP', stored: 'unlimited', pinnedByEnv: false, restartPending: true });
  });
});

describe('323 boot read', () => {
  it('reads what the doors stored, as the graph owner', async () => {
    await set(ADMIN, 'TM8_PROJECT_ROOTS', '/srv/projects');
    const rows = await readStoredNodeSettings(database.url);
    expect(rows).toEqual(expect.arrayContaining([{ name: 'TM8_PROJECT_ROOTS', value: '/srv/projects' }]));
  });
});

describe('323 space visibility', () => {
  it('w2_update_space writes visibility and refuses an unknown value', async () => {
    const result = await as(ADMIN, {}, (q) =>
      q(`select public.w2_update_space($1, '{"visibility":"public"}'::jsonb, 'ns-323-vis-1') r`, [spaceId]));
    expect((result[0]!.r as { space: { visibility: string } }).space.visibility).toBe('public');
    expect(await sqlState(as(ADMIN, {}, (q) =>
      q(`select public.w2_update_space($1, '{"visibility":"secret"}'::jsonb, 'ns-323-vis-2')`, [spaceId])))).toBe('22023');
  });
});
