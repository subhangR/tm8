import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { run } from '../src/run.js';
import { ledger } from '../src/discovery/availability.js';

let server: Server, base: string, config: string;
const space='11111111-1111-4111-8111-111111111111', map='22222222-2222-4222-8222-222222222222', entity='33333333-3333-4333-8333-333333333333';
let recorded: { method:string;path:string;query:string;body:Record<string,unknown> }[]=[];
let conflict=false;
const vars=['TM8_BASE_URL','TM8_SPACE_ID','TM8_ACTOR_ID','TM8_CONFIG_PATH','TM8_SESSION_ID','TM8_AGENT_TOKEN','TM8_JOURNAL_CLASS','XDG_CONFIG_HOME'] as const;
const saved:Record<string,string|undefined>={};
beforeAll(async()=>{
  server=createServer((req,res)=>{
    const chunks:Buffer[]=[]; req.on('data',c=>chunks.push(c)); req.on('end',()=>{
      const url=new URL(req.url??'/','http://localhost'),raw=Buffer.concat(chunks).toString();
      recorded.push({method:req.method!,path:url.pathname,query:url.search,body:raw?JSON.parse(raw):{}});
      res.setHeader('content-type','application/json'); res.statusCode=conflict?409:200;
      res.end(JSON.stringify(conflict?{error:{code:'version_conflict',message:'placement changed',requestId:'test',retryable:false,details:{currentVersion:3}}}:{data:{id:map,mapId:map,version:1,editSeq:1},requestId:'test'}));
    });
  });
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r)); const addr=server.address();
  if (!addr || typeof addr==='string') throw new Error('no address'); base=`http://127.0.0.1:${addr.port}`;
});
afterAll(async()=>{await new Promise<void>(r=>server.close(()=>r()));});
beforeEach(()=>{
  for(const v of vars){saved[v]=process.env[v];delete process.env[v];}
  config=mkdtempSync(join(tmpdir(),'tm8-map-cli-')); process.env.XDG_CONFIG_HOME=config; process.env.TM8_BASE_URL=base; process.env.TM8_SPACE_ID=space; process.env.TM8_JOURNAL_CLASS='human';
  recorded=[];conflict=false;ledger.clear();
});
afterEach(()=>{for(const v of vars){if(saved[v]===undefined)delete process.env[v];else process.env[v]=saved[v];}rmSync(config,{recursive:true,force:true});ledger.clear();});
async function cli(args:string[]){
  const stdout:string[]=[],stderr:string[]=[];
  const out=vi.spyOn(process.stdout,'write').mockImplementation(c=>{stdout.push(String(c));return true;});
  const err=vi.spyOn(process.stderr,'write').mockImplementation(c=>{stderr.push(String(c));return true;});
  try{return {code:await run([...args,'--format','json']),stdout:stdout.join(''),stderr:stderr.join('')};}finally{out.mockRestore();err.mockRestore();}
}
it('opens the canonical type/scope via the catalog and pages context',async()=>{
  expect((await cli(['map','open','--type','town','--mutation-id','open-1'])).code).toBe(0);
  expect(recorded[0]).toMatchObject({method:'POST',path:`/v2/spaces/${space}/maps/open`,body:{type:'town',scope:{kind:'space',id:space},clientMutationId:'open-1'}});
  expect((await cli(['map','context',map,'--limit','1','--cursor',entity])).code).toBe(0);
  expect(recorded[1]!.query).toContain('limit=1');expect(recorded[1]!.query).toContain(`cursor=${entity}`);
},15000);
it('places real refs with deterministic retry identity and guarded move/remove',async()=>{
  const args=['map','place',map,entity,'--at','10,20','--mutation-id','place-1'];
  expect((await cli(args)).code).toBe(0);expect((await cli(args)).code).toBe(0);
  expect(recorded[0]!.body).toEqual(recorded[1]!.body);expect(recorded[0]!.body).toMatchObject({kind:'ref',entityId:entity,x:10,z:20,expectedVersion:0});
  const item=String(recorded[0]!.body.itemId);
  expect((await cli(['map','move',map,item,'--at','30,40','--expect-version','1'])).code).toBe(0);
  expect(recorded[2]).toMatchObject({method:'PATCH',path:`/v2/maps/${map}/placements/${item}`,body:{x:30,z:40,expectedVersion:1}});
  expect((await cli(['map','remove',map,item,'--expect-version','2'])).code).toBe(0);
});
it('rejects fabricated or non-finite refs before sending a request',async()=>{
  expect((await cli(['map','place',map,'--at','1,2'])).code).toBe(2);
  expect((await cli(['map','place',map,entity,'--at','Infinity,2'])).code).toBe(2);
  expect((await cli(['map','move',map,entity,'--at','1,2'])).code).toBe(2);
  expect(recorded).toEqual([]);
});
it('sends undo/audit parameters and surfaces CAS conflicts without retry',async()=>{
  expect((await cli(['map','undo',map,'--input','{"editSeq":7}'])).code).toBe(0);
  expect(recorded[0]).toMatchObject({path:`/v2/maps/${map}/undo`,body:{editSeq:7}});
  conflict=true;const result=await cli(['map','move',map,entity,'--at','1,2','--expect-version','1']);
  expect(result.code).not.toBe(0);expect(result.stderr+result.stdout).toContain('version_conflict');expect(recorded).toHaveLength(2);
});
it('navigation save preserves canonical state and expectedRevision',async()=>{
  const member='44444444-4444-4444-8444-444444444444';
  const save={version:1,spaceId:space,memberId:member,current:{type:'hub',scope:{kind:'space',id:space}},stack:[],maps:{}};
  expect((await cli(['map','navigation','save','--input',JSON.stringify({save,expectedRevision:3})])).code).toBe(0);
  expect(recorded[0]).toMatchObject({method:'PUT',path:`/v2/spaces/${space}/maps/navigation`,body:{save,expectedRevision:3}});
});
