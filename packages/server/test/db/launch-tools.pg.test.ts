/**
 * `loadSpaceTools` (Tools v2 PR-E, design doc 01a182cb §5): the server read
 * behind the launch `<context_index>` `tools` group, against a REAL PostgreSQL
 * under the caller's claims.
 *
 *   · order: the most recently run tool first (run ids are time-ordered), a
 *     tool never run after every run one, then by name in byte order;
 *   · `total` counts every readable tool BEFORE the limit, so the composer can
 *     declare the rest (`omitted`) instead of dropping them silently;
 *   · RLS: a non-member of the space reads no tool and a zero total.
 *
 * The fixture mirrors tools.pg.test.ts: tools are born through
 * `create_tool_entity`, runs through `start_tool_session`.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb } from '../../src/db/index.js';
import type { Db, DbClaims } from '../../src/db/types.js';
import { loadSpaceTools } from '../../src/launch/tools.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 300_000 });

let database: W1ScratchDatabase;
let db: Db;
const space = randomUUID(), owner = randomUUID(), persona = randomUUID(), parent = randomUUID();
const OWNER = 'lt-owner';
/** An identity that exists but is not a member of the space. */
const STRANGER = 'lt-stranger';
const auth = (identityId = OWNER, authKind = 'browser'): DbClaims => ({ identityId, authKind, sessionSpaceId: space });
const definition = (name: string) => ({
  name, description: `${name} fixture`, help: '', runtime: 'bash', source: 'echo ok', tm8Access: 'none', timeoutSeconds: 60, inputs: [],
});

async function version(id: string): Promise<number> {
  return (await database.query<{ version: number }>('select version from public.entities where id=$1', [id]))[0]!.version;
}
async function create(name: string): Promise<string> {
  const result = await db.rpc<{ entity: { id: string } }>(auth(), 'create_tool_entity', [space, definition(name), null, randomUUID()]);
  return result.entity.id;
}
async function run(tool: string): Promise<string> {
  const result = await db.rpc<{ entity: { id: string } }>(auth(), 'start_tool_session',
    [space, tool, await version(tool), {}, false, 'launch-tools-test', '/tmp', 100, null, randomUUID()]);
  return result.entity.id;
}
const read = (limit: number, claims = auth()) => db.tx(claims, (q) => loadSpaceTools(q, { spaceId: space, limit }));
const names = async (limit: number, claims = auth()) => (await read(limit, claims)).tools.map((row) => row.name);

beforeAll(async () => {
  database = await createW1ScratchDatabase('launch-tools');
  database.apply(migrationFiles());
  db = createDb(database.url);
  await database.transaction(async (c) => {
    await c.query('set local role tm8_graph_owner');
    for (const identity of [OWNER, STRANGER]) {
      await c.query('insert into public.user_profiles(identity_id,display_name) values($1,$1)', [identity]);
      await c.query('insert into public.accounts(identity_id,username,display_name) values($1,$1,$1)', [identity]);
    }
    await c.query("insert into public.spaces(id,name,created_by_identity) values($1,'Launch tools fixture',$2)", [space, OWNER]);
    await c.query("insert into public.entities(id,space_id,kind,position,created_by) values($1,$2,'member',0,$1)", [owner, space]);
    await c.query("insert into public.members(entity_id,space_id,identity_id,role,display_name) values($1,$2,$3,'owner',$3)", [owner, space, OWNER]);
    await c.query("select set_config('tm8.identity_id',$1,true),set_config('tm8.auth_kind','browser',true)", [OWNER]);
    await c.query("insert into public.entities(id,space_id,kind,position,created_by) values($1,$3,'team_member',0,$4),($2,$3,'work_session',0,$1)", [persona, parent, space, owner]);
    await c.query("insert into public.team_members(entity_id,owner_member_id,name,role,identity) values($1,$2,'Tool invoker','','persona')", [persona, owner]);
    await c.query("insert into public.work_sessions(entity_id,title,status,share_mode) values($1,'Invoker','spawning','none')", [parent]);
    await c.query("insert into public.edges(space_id,src_id,dst_id,type,created_by) values($1,$2,$3,'participates_in',$2)", [space, persona, parent]);
  });
});
afterAll(async () => { await db?.end(); await database?.destroy(); });

describe('loadSpaceTools (the context index tools group)', () => {
  it('reads nothing from a space without tools', async () => {
    expect(await read(8)).toEqual({ tools: [], total: 0 });
  });

  it('orders never-run tools by name in byte order, created order notwithstanding, and counts them all', async () => {
    for (const name of ['c-tool', 'a-tool', 'b-tool']) await create(name);
    const result = await read(8);
    expect(result.tools.map((row) => row.name)).toEqual(['a-tool', 'b-tool', 'c-tool']);
    expect(result.total).toBe(3);
    // Each row names the tool's entity, the id the header read and the index entry use.
    const ids = await database.query<{ id: string; name: string }>(
      "select e.id, t.definition->>'name' as name from public.entities e join public.tools t on t.entity_id=e.id where e.space_id=$1 order by 2", [space]);
    expect(result.tools).toEqual(ids.map((row) => ({ entityId: row.id, name: row.name })));
  });

  it('puts the most recently run tool first and a never-run tool after every run one', async () => {
    const byName = Object.fromEntries((await read(8)).tools.map((row) => [row.name, row.entityId]));
    await run(byName['b-tool']!);
    expect(await names(8)).toEqual(['b-tool', 'a-tool', 'c-tool']);
    // A later run of another tool overtakes it; a second run of the same tool changes nothing.
    await run(byName['c-tool']!);
    expect(await names(8)).toEqual(['c-tool', 'b-tool', 'a-tool']);
    await run(byName['c-tool']!);
    expect(await names(8)).toEqual(['c-tool', 'b-tool', 'a-tool']);
  });

  it('lists at most `limit` tools and still declares the total, so the rest can be omitted rather than lost', async () => {
    const result = await read(2);
    expect(result.tools.map((row) => row.name)).toEqual(['c-tool', 'b-tool']);
    expect(result.total).toBe(3);
    expect(await read(1)).toMatchObject({ total: 3 });
    expect((await read(1)).tools).toHaveLength(1);
  });

  it('RLS: a non-member of the space reads no tool and a zero total', async () => {
    expect(await read(8, auth(STRANGER))).toEqual({ tools: [], total: 0 });
  });
});
