#!/usr/bin/env node
/** Disposable private-free Game fixture. All mutations use shipping RPCs. */
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createDb } from '../../packages/server/dist/db/client.js';
import { resolveLoopbackOwner } from '../../packages/server/dist/identity/loopback.js';
import { loadConfig } from '../../packages/server/dist/http/config.js';
import { bootstrap } from '../../packages/server/dist/main.js';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const {Pool}=createRequire(import.meta.url)(resolve(root,'packages/server/node_modules/pg'));
const dir=process.env.GAME_FIXTURE_DIR??'/tmp/tm8-live-verifier-infra-01a11c29';
await mkdir(dir,{recursive:true});
const databaseUrl=process.env.GAME_DATABASE_URL??'postgres://live_fixture@127.0.0.1:18532/game_live';
if(process.env.GAME_REUSE_FIXTURE!=='1'){
const admin=new Pool({connectionString:databaseUrl.replace('/game_live','/postgres'),max:1});
await admin.query('drop database if exists game_live with (force)');
await admin.query('create database game_live'); await admin.end();
for(const name of (await readdir(resolve(root,'db/migrations'))).filter(n=>/^\d{3}_[a-z0-9_]+\.sql$/.test(n)).sort()){
 const r=spawnSync('psql',['--no-psqlrc','-v','ON_ERROR_STOP=1','-1','-q',databaseUrl,'-f',resolve(root,'db/migrations',name)],{encoding:'utf8'});
 if(r.status!==0)throw new Error(`${name}: ${r.stderr}`);
}
}
const db=createDb(databaseUrl),owner=await resolveLoopbackOwner(db);
const claims={identityId:owner.identityId,authKind:'browser',nodeAdmin:true};
const rpc=async(op,args,sessionId)=>{try{return await db.rpc({...claims,...(sessionId?{workSessionId:sessionId,actorId:teamMemberId}:{})},op,args);}catch(error){console.error('RPC failed',op);throw error;}};
const id=r=>r.entity?.id??r.space?.id??r.spaceId??r.id;
let spaceId,foreignSpaceId,teamMemberId,storyId,taskIds=[];
if(process.env.GAME_REUSE_FIXTURE==='1')({spaceId,foreignSpaceId,teamMemberId,storyId,taskIds}=JSON.parse(await readFile(resolve(dir,'fixture.json'),'utf8')));
else{
spaceId=id(await rpc('create_space',['Synthetic worker verification','Disposable Game browser evidence','private',null,randomUUID()]));
foreignSpaceId=id(await rpc('create_space',['Foreign synthetic scope','Isolation only','private',null,randomUUID()]));
teamMemberId=id(await rpc('create_team_member',[spaceId,'Synthetic worker',null,'Synthetic fixture','Browser verifier','claude-sonnet-4-5','claude-code','worker','bypassPermissions',{},{}]));
storyId=id(await rpc('create_story_entity',[spaceId,'Synthetic live-worker story']));
for(const title of ['Build navigation','Assemble scene','Ship verification']){
 const taskId=id(await rpc('create_task',[spaceId,title,null,'Synthetic fixture',{},null,null,'medium',JSON.stringify([{id:'proof',text:'Verified',done:false}]),3]));
 await rpc('set_collection_item',[storyId,taskId]);taskIds.push(taskId);
}
}
const vendor=resolve(dir,'synthetic-agent.mjs');
await writeFile(vendor,"import {createInterface} from 'node:readline';console.log('SYNTHETIC-GAME-READY');createInterface({input:process.stdin}).on('line',line=>{if(line.trim()==='/fail')process.exit(7);if(line.trim()==='/exit')process.exit(0);});\n");
process.env.TM8_AGENT_CMD=`${process.execPath} ${vendor}`;
const config=loadConfig({TM8_BIND:'127.0.0.1',TM8_PORT:'18531',TM8_DATABASE_URL:databaseUrl,TM8_DATA_DIR:resolve(dir,'data'),TM8_PROJECT_DIR:dir,
 TM8_ALLOWED_ORIGINS:'http://127.0.0.1:18533',TM8_LAUNCH_BOOTSTRAP:'0',TM8_SPACE_SESSIONS:'off'});
const boot=await bootstrap({config,startBackgroundJobs:false});
const fixturePool=new Pool({connectionString:databaseUrl,max:1});
const operations=[];
const control=createServer(async(req,res)=>{
 try {
  if(req.method!=='POST')throw new Error('POST required');
  let raw='';for await(const chunk of req)raw+=chunk;
  const {op,args,sessionId}=JSON.parse(raw);
  if(op==='processFail'){boot.execution.pty.write(sessionId,'/fail\r');res.end('{}');return;}
  if(op==='receipt'){
   const ownerMember=(await fixturePool.query('select entity_id from public.members where space_id=$1 and identity_id=$2',[spaceId,owner.identityId])).rows[0].entity_id;
   const message=(await fixturePool.query("insert into public.entities(space_id,kind,parent_id,position,created_by) values($1,'message',null,0,$2) returning id",[spaceId,ownerMember])).rows[0].id;
   await fixturePool.query('insert into public.messages(entity_id,anchor_id,author_id,body) values($1,$2,$3,$4)',[message,args[0],ownerMember,'Synthetic verification close-out']);
   res.end(JSON.stringify({messageId:message}));return;
  }
  const permitted=['execution_spawn','work_session_transition','create_task','create_story_entity','set_collection_item','write_edge','update_edge','delete_edge','set_work_state','release_task_claim','post_message','complete_work_session','stop_work_session','tick_task','complete_task','update_task'];
  if(!permitted.includes(op))throw new Error('Fixture operation not allowed');
  const result=await rpc(op,args,sessionId);
  if(op==='execution_spawn')await fixturePool.query("select internal.settle_credential_binding($1, '{\"effectiveCredentialSources\":{\"anthropic\":\"node\"}}'::jsonb)",[id(result)]);
  operations.push({op,args,sessionId,result});
  res.setHeader('content-type','application/json');res.end(JSON.stringify(result));
 } catch(error){res.statusCode=400;res.end(JSON.stringify({error:String(error),details:error.details}));}
});
await new Promise(r=>control.listen(0,'127.0.0.1',r));
const fixture={ready:true,spaceId,foreignSpaceId,teamMemberId,storyId,taskIds,token:'',controlUrl:`http://127.0.0.1:${control.address().port}`,databaseUrl,
 sourceHead:spawnSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).stdout.trim(),renderer:'Software WebGL behavior only; no native hardware claim'};
await writeFile(resolve(dir,'fixture.json'),JSON.stringify(fixture,null,2));
console.log(JSON.stringify(fixture));
let closed=false;
async function close(){if(closed)return;closed=true;await writeFile(resolve(dir,'operations.json'),JSON.stringify(operations,null,2));control.close();boot.execution?.pty.shutdownAll();await boot.server.close();await boot.db.end();await db.end();await fixturePool.end();process.exit();}
process.on('SIGINT',close);process.on('SIGTERM',close);
