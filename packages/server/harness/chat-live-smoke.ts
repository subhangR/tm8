/** Opt-in subscription smoke: owned scratch DB, no tools, two portable generations.
 * TM8_CHAT_LIVE_SMOKE=1 TM8_W1_ADMIN_DATABASE_URL=postgres://tm8@127.0.0.1:5443/postgres bun packages/server/harness/chat-live-smoke.ts
 */
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createW1ScratchDatabase,migrationFiles} from '../test/db/w1-pg.ts';
import {PgDb} from '../src/db/client.ts';
import {ChatOrchestrator} from '../src/chat/orchestrator.ts';
import {composeChatHarnessFoundation} from '../src/chat/compose.ts';
import {ChatTurnPublisher} from '../src/chat/publisher.ts';
import {SubscriptionRegistry} from '../src/events/subscriptions.ts';
if(process.env.TM8_CHAT_LIVE_SMOKE!=='1')throw new Error('Explicit live-smoke opt-in required');
const database=await createW1ScratchDatabase('chat_live_smoke');
const dataDir=await mkdtemp(join(tmpdir(),'tm8-chat-live-'));
const cwd=join(dataDir,'workspace');await mkdir(cwd);
const id=randomUUID(),space=randomUUID(),member=randomUUID(),teammate=randomUUID();
const identity=`chat-live-${randomUUID()}`,nonce=`TM8_${randomUUID().replaceAll('-','').slice(0,16)}`;
let db:PgDb|undefined;
let clean=false;let stage='setup';let inferenceSubmitted=false;
try {
 database.apply(migrationFiles());
 await database.transaction(async q=>{
  await q.query('set local role tm8_graph_owner');
  await q.query('insert into user_profiles(identity_id,display_name) values($1,$2)',[identity,'Live smoke']);
  await q.query('insert into accounts(identity_id,username) values($1,$2)',[identity,identity]);
  await q.query('insert into spaces(id,name,created_by_identity) values($1,$2,$3)',[space,'Isolated live smoke',identity]);
  await q.query("insert into entities(id,space_id,kind,position,created_by) values($1,$3,'member',0,$1),($2,$3,'team_member',1,$1)",[member,teammate,space]);
  await q.query("insert into members(entity_id,space_id,identity_id,role,display_name) values($1,$2,$3,'owner','Live smoke')",[member,space,identity]);
  await q.query("insert into team_members(entity_id,owner_member_id,name,role,model,agent_tool) values($1,$2,'Live smoke','helper','gpt-6.1-sol','codex')",[teammate,member]);
 });
 db=new PgDb({databaseUrl:database.url});
 const claims={identityId:identity,authKind:'browser'};
 const common={db,dataDir,baseUrl:'http://127.0.0.1:9',nodeId:'isolated-live-smoke'};
 const foundation=composeChatHarnessFoundation(common);
 const errors:string[]=[];
 const orchestrator=new ChatOrchestrator({...common,registry:foundation.harnessRegistry,resolvePreparedLaunch:foundation.resolvePreparedLaunch,
  publisher:new ChatTurnPublisher(new SubscriptionRegistry()),onError:e=>errors.push((e as any)?.code??(e as any)?.name??'runtime_error')});
 await db.rpc(claims,'start_chat',[id,space,teammate,'gpt-6.1-sol','openai','codex','ask','scratch',null,randomUUID(),cwd,null,
  `Reply only with ${nonce}. Do not use any tools or write files.`,[],null,randomUUID()]);
 const target={model:'gpt-6.1-sol',provider:'openai',agentTool:'codex',reasoningEffort:'low',credentialSelection:{source:'node'},
  credentialIntent:{defaultChoice:{source:'node'},byProvider:{openai:{source:'node'}}}};
 await db.rpc(claims,'set_chat_configuration',[id,1,JSON.stringify(target),randomUUID()]);
 stage='turn';inferenceSubmitted=true;await orchestrator.wake(id,identity);
 const first=(await database.query('select state,agent_message_id from chat_turns where chat_id=$1 order by turn_ordinal',[id]))[0];
 const firstBody=(await database.query('select body from messages where entity_id=$1',[first.agent_message_id]))[0]?.body??'';
 console.log(JSON.stringify({turn:1,state:first.state,nonceMatched:firstBody.includes(nonce),errorKinds:errors}));
 if(first.state!=='completed'||!firstBody.includes(nonce))throw new Error('Live first turn did not complete');
 await db.rpc(claims,'set_chat_configuration',[id,2,JSON.stringify({...target,reasoningEffort:'medium'}),randomUUID()]);
 await db.rpc(claims,'w2_post_message_batch',[[id],'Repeat the exact nonce from the earlier user request, and nothing else. Do not use tools or write files.',null,[],[],null,null,randomUUID(),null,null]);
 await orchestrator.wake(id,identity);
 const turns=await database.query('select state,agent_message_id from chat_turns where chat_id=$1 order by turn_ordinal',[id]);
 const body=(await database.query('select body from messages where entity_id=$1',[turns[1].agent_message_id]))[0]?.body??'';
 const attempts=await database.query('select native_generation,configuration_snapshot from chat_turn_attempts where chat_id=$1 order by created_at',[id]);
 const active=await database.query('select runtime_phase from chats where entity_id=$1',[id]);
 console.log(JSON.stringify({turn:2,state:turns[1].state,nonceMatched:body.includes(nonce),generations:attempts.map(x=>Number(x.native_generation)),
  efforts:attempts.map(x=>x.configuration_snapshot.desired.reasoningEffort),runtimePhase:active[0].runtime_phase,errorKinds:errors}));
 if(turns[1].state!=='completed'||!body.includes(nonce))throw new Error('Portable live continuity failed');
 clean=active[0].runtime_phase==='idle';
} catch(e) {
 console.log(JSON.stringify({liveSmokePassed:false,stage,errorKind:(e as any)?.code??(e as any)?.name??'failure',}));
 process.exitCode=1;
} finally {
 if(!inferenceSubmitted)clean=true;
 else if(!clean) {
  const rows=await database.query('select runtime_phase from chats where entity_id=$1',[id]).catch(()=>[]);
  clean=rows[0]?.runtime_phase==='idle';
 }
 await db?.end();await database.destroy();
 if(clean)await rm(dataDir,{recursive:true,force:true});
 console.log(JSON.stringify({liveSmokePassed:process.exitCode!==1,ownedResourcesRemoved:clean,inferenceSubmitted}));
}
