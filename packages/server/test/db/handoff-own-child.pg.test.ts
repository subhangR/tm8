import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';
vi.setConfig({ testTimeout: 120_000, hookTimeout: 300_000 });
let db: W1ScratchDatabase;
const ids: Record<string,string> = Object.fromEntries(['space','otherSpace','member','actor','childActor','story','parent','child','sibling','terminal','foreign'].map(k => [k,randomUUID()]));
const identity = 'handoff-child-test';
async function prepare(target: string, sourceSession: string | null, actor = ids.actor) {
  return db.transaction(async c => {
    await c.query('set local role tm8_app');
    await c.query(`select set_config('tm8.identity_id',$1,true),set_config('tm8.actor_id',$2,true),set_config('tm8.node_admin','false',true),set_config('tm8.session_space_id',$3,true)`,[identity,actor,ids.space]);
    return (await c.query(`select public.w2_prepare_handoff($1,$2,$3,null,null,null,$4) result`,[randomUUID(),ids.story,target,sourceSession])).rows[0]!.result;
  });
}
describe('own-child handoffs on the current migration chain', () => {
  beforeAll(async () => {
    db = await createW1ScratchDatabase('handoff_child');
    db.apply(migrationFiles());
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
      await entity('story','story');
      await c.query(`insert into public.stories(entity_id,title) values($1,'Context story')`,[ids.story]);
      for (const key of ['parent','child','sibling','terminal','foreign']) {
        await entity(key,'work_session',['child','terminal'].includes(key) ? ids.parent! : null,key === 'foreign' ? ids.otherSpace : ids.space);
        await c.query(`insert into public.work_sessions(entity_id,title,status,workdir_mode) values($1,$2,$3,'scratch')`,[ids[key],key,key === 'terminal' ? 'exited' : 'running']);
      }
      for (const [actor,target] of [['actor','parent'],['childActor','child'],['childActor','terminal'],['childActor','sibling']]) await c.query(`insert into public.edges(space_id,src_id,dst_id,type,created_by) values($1,$2,$3,'participates_in',$4)`,[ids.space,ids[actor!],ids[target!],ids.member]);
    });
  });
  afterAll(async () => { if(db) await db.destroy(); });
  it('keeps the definer under graph ownership with the restricted grant and search path', async () => {
    const rows = await db.query(`select pg_get_userbyid(proowner) owner, prosecdef,
      proconfig, has_function_privilege('tm8_app',oid,'EXECUTE') app_execute,
      exists (select 1 from aclexplode(proacl) a where a.grantee=0 and a.privilege_type='EXECUTE') public_execute
      from pg_proc where oid='public.w2_prepare_handoff(text,uuid,uuid,integer,uuid,text,uuid)'::regprocedure`);
    expect(rows[0]).toMatchObject({owner:'tm8_graph_owner',prosecdef:true,app_execute:true,public_execute:false});
    expect(rows[0]!.proconfig).toContain('search_path=public, internal, pg_temp');
  });
  it('permits parent and snapshots the story', async () => {
    const result = await prepare(ids.child!,ids.parent!);
    expect(result.handoff.sourceSnapshot).toMatchObject({entityId:ids.story,kind:'story'});
    expect(result.handoff.deliveryStatus).toBe('prepared');
  });
  it('preserves participant and participant-owner access', async () => {
    expect((await prepare(ids.child!,null,ids.childActor)).handoff.deliveryStatus).toBe('prepared');
    expect((await prepare(ids.child!,null,ids.member)).handoff.deliveryStatus).toBe('prepared');
  });
  it.each([
    ['missing parent','child',null,'handoff_parent_session_required'],
    ['sibling','sibling','parent','handoff_target_not_own_child'],
    ['other actor','child','sibling','handoff_parent_actor_mismatch'],
    ['foreign session','child','foreign','handoff_parent_actor_mismatch'],
    ['terminal child','terminal','parent','handoff_target_not_live'],
  ])('refuses %s with a named denial',async (_label,target,parent,detail) => {
    await expect(prepare(ids[target!]!,parent ? ids[parent]! : null)).rejects.toMatchObject({code:'42501',detail});
  });
});
