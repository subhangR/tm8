import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { EntityStateSchema } from '@tm8/contract';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';
import { ENTITY_COLUMNS, ENTITY_FROM, loadEntitySummariesByIds, type EntityRow } from '../../src/facade/entity-read.js';
import { buildUniversalDetail, loadUniversalSummaries } from '../../src/facade/services/w2/entities-commands-tracking.js';
import { buildDetail } from '../../src/facade/handlers/entities.js';
import { PgEntityProjector } from '../../src/events/projector.js';
import { WorkspaceEventMapper, type WorkspaceEventRow } from '../../src/events/mapper.js';
import type { Querier } from '../../src/db/types.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });
let db: W1ScratchDatabase;
let dir: string;
const space = randomUUID(), member = randomUUID(), teammate = randomUUID(), legacy = randomUUID(), spell = randomUUID();
const identity = 'skill-reference-test';
const description = 'A complete description. '.repeat(30);
const projector = new PgEntityProjector();
const q: Querier = {
  query: async <R>(sql: string, params: readonly unknown[] = []) => (await db.pool.query(sql, [...params])).rows as R[],
  rpc: async <T>(fn: string, args: readonly unknown[] = []) => {
    const result = await db.pool.query(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(',')}) as value`, [...args]);
    return result.rows[0]?.value as T;
  },
};
async function entity(kind: string, id = randomUUID()): Promise<string> {
  await db.query('insert into public.entities(id,space_id,kind,created_by) values($1,$2,$3,$4)', [id,space,kind,member]);
  return id;
}
async function rows(ids: string[]): Promise<EntityRow[]> {
  return q.query(`select ${ENTITY_COLUMNS} ${ENTITY_FROM} where e.id = any($1::uuid[])`, [ids]);
}
beforeAll(async () => {
  db = await createW1ScratchDatabase('skill_refs');
  dir = await mkdtemp(join(tmpdir(), 'tm8-skill-ref-'));
  db.apply(migrationFiles().filter((name) => !name.startsWith('197_')));
  await db.query("insert into public.user_profiles(identity_id,display_name) values($1,'Skill owner')", [identity]);
  await db.query("insert into public.spaces(id,name,created_by_identity) values($1,'Skills',$2)", [space,identity]);
  await entity('member',member);
  await db.query("insert into public.members(entity_id,space_id,identity_id,role,display_name) values($1,$2,$3,'owner','Skill owner')", [member,space,identity]);
  await entity('team_member',teammate);
  await db.query("insert into public.team_members(entity_id,owner_member_id,name) values($1,$2,'Teammate')", [teammate,member]);
  await entity('skill',legacy);
  await db.query("insert into public.skills(entity_id,name,description,content) values($1,'Legacy',$2,'Original body')", [legacy,description]);
  await entity('spell',spell);
  await db.query(`insert into public.spells(entity_id,name,description,rule) values($1,'Spell','Spell description','{"test":true}')`, [spell]);
  await db.query("insert into public.edges(space_id,src_id,dst_id,type,created_by) values($1,$2,$3,'equips',$4)", [space,teammate,legacy,member]);
  db.apply(['197_skill_filesystem_references.sql']);
});
afterAll(async () => { if (db) await db.destroy(); if (dir) await rm(dir, {recursive:true,force:true}); });

describe('filesystem skill references', () => {
  it('preserves legacy identities, content, status and edges; new skills are resolved', async () => {
    const [old] = await db.query('select s.*,e.status_category from public.skills s join public.entities e on e.id=s.entity_id where e.id=$1',[legacy]);
    expect(old).toMatchObject({entity_id:legacy,provider:'tm8',level:'space',content:'Original body',status_category:'to_do'});
    const id = await entity('skill');
    expect((await db.query('select internal.is_resolved($1) resolved,status_category from public.entities where id=$1',[id]))[0]).toMatchObject({resolved:true,status_category:'done'});
    expect((await db.query("select count(*)::int n from public.edges where dst_id=$1 and type='equips'",[legacy]))[0]?.n).toBe(1);
  });
  it('projects skill and spell names, descriptions, content and equipment consistently', async () => {
    const read = await loadEntitySummariesByIds(q,[legacy,spell],identity);
    const universal = await loadUniversalSummaries(q,await rows([legacy,spell]),identity);
    const events = await projector.entitySummaries(q,[legacy,spell]);
    for (const skill of [read[0],universal.find(x=>x.id===legacy),events.get(legacy)]) {
      expect(skill).toMatchObject({title:'Legacy',state:{kind:'skill',description,equipped:true,provider:'tm8',level:'space',changedOnDisk:false}});
      expect(EntityStateSchema.safeParse(skill?.state).success).toBe(true);
    }
    for (const value of [read[1],universal.find(x=>x.id===spell),events.get(spell)]) expect(value).toMatchObject({title:'Spell',state:{description:'Spell description',equipped:false}});
    expect((await buildUniversalDetail(q,legacy,identity)).content).toMatchObject({content:'Original body'});
    expect((await buildDetail(q,spell,identity)).content).toMatchObject({rule:{test:true}});
    expect((await buildUniversalDetail(q,teammate,identity)).content).toMatchObject({equipped:[{id:legacy}]});
    expect((await buildDetail(q,teammate,identity)).content).toMatchObject({equipped:[{id:legacy}]});
  });
  it('enforces one reference per path but permits repeated display names', async () => {
    const a = await entity('skill'), b = await entity('skill');
    await db.query("insert into public.skills(entity_id,name,source_path) values($1,'Same',$2)",[a,join(dir,'unique.md')]);
    await expect(db.query("insert into public.skills(entity_id,name,source_path) values($1,'Same',$2)",[b,join(dir,'unique.md')])).rejects.toMatchObject({code:'23505'});
    await db.query("insert into public.skills(entity_id,name,source_path) values($1,'Same',$2)",[b,join(dir,'other.md')]);
    await expect(db.query("update public.skills set content='Competing copy' where entity_id=$1",[a])).rejects.toMatchObject({code:'23514'});
  });
  it('loads current disk bytes only on detail, flags mismatch/missing, and preserves equips', async () => {
    const id = await entity('skill');
    const path = join(dir,'SKILL.md');
    const original = '---\nname: File\n---\nOriginal body';
    await writeFile(path,original);
    await db.query("insert into public.skills(entity_id,name,description,provider,level,source_path,content_hash,frontmatter) values($1,'File',$2,'agents','project',$3,$4,$5)",[id,description,path,createHash('sha256').update(original).digest('hex'),{description,unknownKey:'retained'}]);
    expect((await buildUniversalDetail(q,id,identity)).state).toMatchObject({changedOnDisk:false,frontmatter:{unknownKey:'retained'}});
    await writeFile(path,'Current disk body');
    for (const read of [buildDetail,buildUniversalDetail]) {
      const detail = await read(q,id,identity);
      expect(detail.content).toMatchObject({content:'Current disk body'});
      expect(detail.state).toMatchObject({changedOnDisk:true});
    }
    // A directory throws EISDIR if a list attempts to read its body.
    await db.query('update public.skills set source_path=$2 where entity_id=$1',[id,dir]);
    const listed = await loadUniversalSummaries(q,await rows([id]),identity);
    expect(listed[0]?.state).toMatchObject({changedOnDisk:false,description});
    expect((await projector.entitySummaries(q,[id])).get(id)?.state).toMatchObject({changedOnDisk:false});
    await db.query('update public.skills set source_path=$2 where entity_id=$1',[id,path]);
    await db.query("insert into public.edges(space_id,src_id,dst_id,type,created_by) values($1,$2,$3,'equips',$4)", [space,teammate,id,member]);
    await rm(path);
    expect((await buildUniversalDetail(q,id,identity)).state).toMatchObject({missing:true,changedOnDisk:false,equipped:true});
    await writeFile(path,original);
    const returned = await buildUniversalDetail(q,id,identity);
    expect(returned).toMatchObject({id,state:{missing:false,changedOnDisk:false,equipped:true},content:{content:original}});
    // Leave the teammate fixture with its original equipment for the event case.
    await db.query("delete from public.edges where src_id=$1 and dst_id=$2 and type='equips'", [teammate,id]);
  });
  it('rehydrates equipped state on both edge creation and removal events', async () => {
    const mapper = new WorkspaceEventMapper(projector);
    for (const equipped of [false,true]) {
      if (equipped) await db.query("insert into public.edges(space_id,src_id,dst_id,type,created_by) values($1,$2,$3,'equips',$4)",[space,teammate,legacy,member]);
      else await db.query("delete from public.edges where src_id=$1 and dst_id=$2 and type='equips'",[teammate,legacy]);
      const captured = await q.query<WorkspaceEventRow>("select * from public.workspace_events where space_id=$1 and event_type=$2 and payload->>'type'='equips' order by seq desc limit 1",[space,equipped?'edge.upsert':'edge.deleted']);
      const events = await mapper.mapRows(q,captured);
      expect(events).toHaveLength(1);
      const event = events[0];
      if (event?.type !== 'edge.upsert' && event?.type !== 'edge.deleted') throw new Error('missing edge event');
      expect(event.edge.target.state).toMatchObject({equipped});
      expect((await loadEntitySummariesByIds(q,[legacy],identity))[0]?.state).toMatchObject({equipped});
      expect((await buildUniversalDetail(q,teammate,identity)).content).toMatchObject({equipped:equipped?[{id:legacy}]:[]});
    }
  });
});
