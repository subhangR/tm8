import { randomUUID } from 'node:crypto';
import { createDb, type Db } from '../../src/db/index.js';
import { loadStoryContextForTask } from '../../src/facade/spawn-story.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';
vi.setConfig({ testTimeout: 120_000, hookTimeout: 300_000 });
let db: W1ScratchDatabase;
let facadeDb: Db;
let previousOwner: string;
const ids: Record<string,string> = Object.fromEntries(['space','otherSpace','member','actor','childActor','story','parent','child','sibling','terminal','foreign','otherStory','foreignStory','task'].map(k => [k,randomUUID()]));
const identity = 'direct-story-test';
async function spawn(options: {story?: string; parent?: string; source?: string; task?: string; actor?: string; mutation?: string} = {}) {
  return db.transaction(async c => {
    await c.query('set local role tm8_app');
    await c.query(`select set_config('tm8.identity_id',$1,true),set_config('tm8.actor_id',$2,true),set_config('tm8.node_admin','false',true),set_config('tm8.session_space_id',$3,true)`,[identity,options.actor ?? ids.actor,ids.space]);
    return (await c.query(`select public.execution_spawn($1,$2,$3::uuid[],null,'scratch',null,null,'coordinator',null,null,'story run',null,true,64,null,$4,$5,null,$6,$7) result`,[ids.space,ids.childActor,options.task ? [options.task] : [],options.mutation ?? randomUUID(),options.parent ?? null,options.story ?? null,options.source ?? null])).rows[0]!.result;
  });
}
async function anchors(session: string) {
  return db.query(`select src_id from public.edges where dst_id=$1 and type='contains'`,[session]);
}
describe('direct story spawn on the current migration chain', () => {
  beforeAll(async () => {
    db = await createW1ScratchDatabase('story_spawn');
    const files = migrationFiles();
    const migration = files.find(file => file.endsWith('_direct_story_spawn.sql'))!;
    db.apply(files.filter(file => file !== migration));
    previousOwner = (await db.query(`select pg_get_userbyid(proowner) owner from pg_proc
      where oid='public.execution_spawn(uuid,uuid,uuid[],uuid,text,text,text,text,text,text,text,text,boolean,integer,uuid,text,uuid,text)'::regprocedure`))[0]!.owner;
    db.apply([migration]);
    facadeDb = createDb(db.url);
    await db.transaction(async c => {
      await c.query('set local role tm8_graph_owner');
      await c.query(`insert into public.user_profiles(identity_id,display_name) values($1,'handoff')`,[identity]);
      for (const space of [ids.space,ids.otherSpace]) await c.query(`insert into public.spaces(id,name,created_by_identity) values($1,'handoff',$2)`,[space,identity]);
      const entity = async (key: string, kind: string, parent: string | null = null, space = ids.space) => c.query(`insert into public.entities(id,space_id,kind,position,created_by,parent_id) values($1,$2,$3,0,$4,$5)`,[ids[key],space,kind,ids.member,parent]);
      await entity('member','member');
      await c.query(`insert into public.members(entity_id,space_id,identity_id,role,display_name) values($1,$2,$3,'owner','handoff')`,[ids.member,ids.space,identity]);
      for (const key of ['actor','childActor']) {
        await entity(key,'team_member');
        await c.query(`insert into public.team_members(entity_id,owner_member_id,name,role,identity) values($1,$2,$3,'','persona')`,[ids[key],ids.member,key]);
      }
      for (const key of ['story', 'otherStory', 'foreignStory']) {
        await entity(key, 'story', null, key === 'foreignStory' ? ids.otherSpace : ids.space);
        await c.query(`insert into public.stories(entity_id,title) values($1,$2)`, [ids[key], key]);
      }
      await entity('task', 'task');
      await c.query(`insert into public.tasks(entity_id,title) values($1,'Child work')`, [ids.task]);
      for (const key of ['parent','child','sibling','terminal','foreign']) {
        await entity(key,'work_session',['child','terminal'].includes(key) ? ids.parent! : null,key === 'foreign' ? ids.otherSpace : ids.space);
        await c.query(`insert into public.work_sessions(entity_id,title,status,workdir_mode) values($1,$2,$3,'scratch')`,[ids[key],key,key === 'terminal' ? 'exited' : 'running']);
      }
      for (const [actor,target] of [['actor','parent'],['childActor','child'],['childActor','terminal'],['childActor','sibling']]) await c.query(`insert into public.edges(space_id,src_id,dst_id,type,created_by) values($1,$2,$3,'participates_in',$4)`,[ids.space,ids[actor!],ids[target!],ids.member]);
    });
  });
  afterAll(async () => { await facadeDb?.end(); if(db) await db.destroy(); });
  it('preserves ownership, restricted grants and search path after replacing the signature', async () => {
    const [row] = await db.query(`select pg_get_userbyid(proowner) owner, prosecdef, proconfig,
      has_function_privilege('tm8_app',oid,'EXECUTE') app_execute,
      exists(select 1 from aclexplode(proacl) a where a.grantee=0 and a.privilege_type='EXECUTE') public_execute
      from pg_proc where oid='public.execution_spawn(uuid,uuid,uuid[],uuid,text,text,text,text,text,text,text,text,boolean,integer,uuid,text,uuid,text,uuid,uuid)'::regprocedure`);
    expect(row).toMatchObject({ owner: previousOwner, prosecdef: true, app_execute: true, public_execute: false });
    expect(row!.proconfig).toContain('search_path=public, internal, pg_temp');
    expect((await db.query(`select count(*)::int n from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname='execution_spawn'`))[0]!.n).toBe(1);
  });
  it('persists a direct story anchor, creates no task, replays once, and leaves status manual', async () => {
    const before = await db.query('select count(*)::int n from public.tasks');
    const mutation = randomUUID();
    const first = await spawn({story:ids.story,mutation});
    const replay = await spawn({story:ids.story,mutation});
    expect(replay.entity.id).toBe(first.entity.id);
    expect(replay.__tm8_replayed).toBe(true);
    expect(await anchors(first.entity.id)).toEqual([{src_id:ids.story}]);
    expect(await db.query('select count(*)::int n from public.tasks')).toEqual(before);
    expect((await db.query('select status_category from public.entities where id=$1',[ids.story]))[0]!.status_category).toBe('to_do');
  });
  it('inherits from its verified actor-bound parent and recursively reaches grandchildren', async () => {
    const parent = await spawn({story:ids.story});
    const child = await spawn({parent:parent.entity.id,source:parent.entity.id,actor:ids.childActor});
    expect(await anchors(child.entity.id)).toEqual([{src_id:ids.story}]);
    const grandchild = await spawn({parent:child.entity.id,source:child.entity.id,actor:ids.childActor});
    expect(await anchors(grandchild.entity.id)).toEqual([{src_id:ids.story}]);
  });
  it('loads persisted direct and inherited context, including a child with its own task', async () => {
    const parent = await spawn({ story: ids.story });
    const child = await spawn({ parent: parent.entity.id, source: parent.entity.id, actor: ids.childActor, task: ids.task });
    const claims = { identityId: identity, actorId: ids.childActor, sessionSpaceId: ids.space };
    for (const [session, task] of [[parent.entity.id, undefined], [child.entity.id, ids.task]]) {
      const context = await loadStoryContextForTask(facadeDb, claims, task, session);
      expect(context).toMatchObject({ id: ids.story, taskId: null, snapshot: 'loaded', viaRootId: session });
      expect(context!.live!.map(row => row.id)).toContain(session);
    }
    expect(await db.query(`select dst_id from public.edges where src_id=$1 and type='working_on'`, [child.entity.id]))
      .toEqual([{ dst_id: ids.task }]);
  });
  it('allows an explicit story to override inherited context', async () => {
    const parent = await spawn({ story: ids.story });
    const child = await spawn({ story: ids.otherStory, parent: parent.entity.id, source: parent.entity.id, actor: ids.childActor });
    expect(await anchors(child.entity.id)).toEqual([{ src_id: ids.otherStory }]);
  });
  it('rejects a story from another Space before creating a session', async () => {
    const before = await db.query('select count(*)::int n from public.work_sessions');
    await expect(spawn({ story: ids.foreignStory })).rejects.toBeDefined();
    expect(await db.query('select count(*)::int n from public.work_sessions')).toEqual(before);
  });
  it('does not inherit from a claimed parent without matching actor-bound provenance', async () => {
    const parent = await spawn({story:ids.story});
    for (const options of [{parent:parent.entity.id},{parent:parent.entity.id,source:ids.parent},{parent:parent.entity.id,source:parent.entity.id,actor:ids.actor}]) {
      const result = await spawn(options);
      expect(await anchors(result.entity.id)).toEqual([]);
    }
  });
  it('refuses task/story combination atomically and rejects a nonstory anchor', async () => {
    await expect(spawn({story:ids.story,task:ids.story})).rejects.toMatchObject({code:'22023',detail:'story_spawn_conflict'});
    await expect(spawn({story:ids.parent})).rejects.toBeDefined();
  });
});
