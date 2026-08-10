/**
 * A Space the NODE OWNER does not belong to, against real Postgres.
 *
 * Every tm8 node starts with one Space whose creator is also the loopback
 * auto-owner, and on that Space "the caller" and "the node owner" are the same
 * identity — so a membership check that reads the wrong one of the two looks
 * perfect. The second Space, created by anybody else, is where they diverge.
 * `spaces.settings` is the read that proves it: it is a BOOT read, so a Space
 * that refuses it cannot be opened in the workspace at all.
 *
 * Real Postgres and not the FakeDb because the refusal has two independent
 * sources that must agree — the handler's own `select ... from public.members`
 * and the `members_select` RLS policy, which filters that very query through
 * `internal.identity_id()`. A fake answers the query the test tells it to and
 * can only ever prove which identity was PASSED; this proves what the database
 * hands back when the identity is bound for real.
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createDb } from '../../src/db/client.js';
import type { Db } from '../../src/db/types.js';
import type { FacadeDeps } from '../../src/facade/deps.js';
import { registerW2IdentitySpacesHandlers } from '../../src/facade/handlers/w2/identity-spaces.js';
import { HandlerRegistry } from '../../src/facade/registry.js';
import type { RequestContext } from '../../src/http/types.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 300_000 });

const NODE_OWNER = 'id_node_owner';
const CREATOR = 'id_creator';
const OUTSIDER = 'id_outsider';

let database: W1ScratchDatabase;
let db: Db;
let registry: HandlerRegistry;
let ownSpaceId: string;
let othersSpaceId: string;

function deps(): FacadeDeps {
  return {
    db,
    config: {
      host: '127.0.0.1',
      port: 0,
      uiDir: undefined,
      maxBodyBytes: 1024 * 1024,
      databaseUrl: database.url,
    },
    // The loopback auto-owner: a real identity, and NOT the one calling below.
    owner: async () => ({
      identityId: NODE_OWNER,
      accountId: '00000000-0000-7000-8000-0000000000ff',
      username: 'owner',
      isNodeAdmin: true,
      isOwner: true,
    }),
  };
}

function context(
  opName: string,
  spaceId: string,
  identityId: string,
): RequestContext {
  return {
    op: { name: opName, method: 'GET', path: '/test', kind: 'read', status: 'v1' },
    opName,
    params: { spaceId },
    query: new URLSearchParams(),
    body: undefined,
    requestId: `req-${randomUUID().slice(0, 8)}`,
    identity: {
      kind: 'bearer',
      identityId,
      token: `tm8s_${identityId}.secret`,
      nodeAdmin: false,
    },
    headers: {},
    method: 'GET',
    path: '/test',
  } as RequestContext;
}

async function createSpaceAs(identityId: string, name: string): Promise<string> {
  const result = await db.rpc<{ space: { id: string } }>(
    { identityId, nodeAdmin: false, requestId: `req-${name}` },
    'create_space',
    [name, '', 'private', null, `cmid-${randomUUID()}`],
  );
  return result.space.id;
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('space_owned_by_other');
  database.apply(migrationFiles());
  await database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    await client.query(
      `insert into public.user_profiles(identity_id, display_name)
       values ($1,'Node owner'), ($2,'Creator'), ($3,'Outsider')`,
      [NODE_OWNER, CREATOR, OUTSIDER],
    );
  });
  db = createDb(database.url);
  registry = new HandlerRegistry();
  registerW2IdentitySpacesHandlers(registry, deps());

  ownSpaceId = await createSpaceAs(NODE_OWNER, 'Node owner space');
  othersSpaceId = await createSpaceAs(CREATOR, 'Tharak');
});

afterAll(async () => {
  await db?.end();
  await database?.destroy();
});

describe('a Space whose creator is not the node owner', () => {
  it('opens for the member who owns it', async () => {
    const settings = await registry.get('spaces.settings')!(
      context('spaces.settings', othersSpaceId, CREATOR),
    );

    // The whole bug in one assertion: before the fix this rejected with
    // `forbidden: not a member of this space`, addressed to the Space's own
    // owner, because the check asked about NODE_OWNER — who has no member row
    // here and never will.
    expect(settings).toMatchObject({
      space: { id: othersSpaceId, name: 'Tharak' },
      members: [{ role: 'owner' }],
    });
  });

  it('still refuses a caller with no member row', async () => {
    await expect(
      registry.get('spaces.settings')!(context('spaces.settings', othersSpaceId, OUTSIDER)),
    ).rejects.toMatchObject({ code: 'forbidden', message: 'not a member of this space' });
  });

  it('refuses the node owner too — membership is not ownership of the node', async () => {
    await expect(
      registry.get('spaces.settings')!(context('spaces.settings', othersSpaceId, NODE_OWNER)),
    ).rejects.toMatchObject({ code: 'forbidden', message: 'not a member of this space' });
  });

  it('leaves the node owner’s own Space readable, as it always was', async () => {
    const settings = await registry.get('spaces.settings')!(
      context('spaces.settings', ownSpaceId, NODE_OWNER),
    );
    expect(settings).toMatchObject({ space: { id: ownSpaceId, name: 'Node owner space' } });
  });

  it('gates the other five G01 membership reads on the caller as well', async () => {
    const gated: ReadonlyArray<readonly [string, string]> = [
      ['spaces.members.list', othersSpaceId],
      ['spaces.invites.list', othersSpaceId],
      ['spaces.taskAxes.list', othersSpaceId],
      ['spaces.leaderboard', othersSpaceId],
      ['spaces.awards', othersSpaceId],
    ];
    for (const [opName, spaceId] of gated) {
      await expect(
        registry.get(opName)!(context(opName, spaceId, CREATOR)),
      ).resolves.toBeDefined();
      await expect(
        registry.get(opName)!(context(opName, spaceId, OUTSIDER)),
      ).rejects.toMatchObject({ code: 'forbidden' });
    }
  });
});
