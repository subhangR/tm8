#!/usr/bin/env node
// Start a real isolated facade + PostgreSQL backend for native browser MCP tests.
// Requires `bun run build` and disposable PostgreSQL on localhost:55483.
// Run: node tools/rigs/mcp-browser-fixture.mjs; stop with SIGINT/SIGTERM.
// Every credential/provider below is synthetic. No production database is used.
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const require=createRequire(join(root,'packages/server/package.json'));
const {Pool}=require('pg');
const adminUrl='postgres://mcp_fixture@127.0.0.1:55483/postgres';
const name=`tm8_mcp_browser_d_${process.pid}`;
const databaseUrl=adminUrl.replace('/postgres',`/${name}`);
const port=Number(process.env.MCP_FIXTURE_PORT??55591);
const dataDir=await mkdtemp(join(tmpdir(),'tm8-mcp-browser-'));
const admin=new Pool({connectionString:adminUrl,max:1});
let boot,seedDb,upstream;
let closing=false;
async function close(){
 if(closing)return;closing=true;
 boot?.execution?.pty.shutdownAll();
 await boot?.server.close().catch(()=>{});
 await boot?.db?.end().catch(()=>{});
 await seedDb?.end().catch(()=>{});
 if(upstream)await new Promise(r=>upstream.close(r));
 await admin.query(`drop database if exists ${name} with (force)`);
 await admin.end();await rm(dataDir,{recursive:true,force:true});
}
process.on('SIGTERM',()=>close().finally(()=>process.exit()));
process.on('SIGINT',()=>close().finally(()=>process.exit()));
try {
 await admin.query(`create database ${name}`);
 for(const file of (await readdir(join(root,'db/migrations'))).filter(f=>/^\d{3}_[a-z0-9_]+\.sql$/.test(f)).sort()){
  const result=spawnSync('psql',['--no-psqlrc','-v','ON_ERROR_STOP=1','-1','-q',databaseUrl,'-f',join(root,'db/migrations',file)],{encoding:'utf8'});
  if(result.status!==0)throw new Error(`${file}: ${result.stderr}`);
 }
 const {createDb}=await import(pathToFileURL(join(root,'packages/server/dist/db/client.js')));
 const {resolveLoopbackOwner}=await import(pathToFileURL(join(root,'packages/server/dist/identity/loopback.js')));
 seedDb=createDb(databaseUrl);
 const owner=await resolveLoopbackOwner(seedDb);
 const claims={identityId:owner.identityId,authKind:'browser',nodeAdmin:true};
 const createdSpace=await seedDb.rpc(claims,'create_space',['MCP Browser Fixture','Isolated synthetic MCP acceptance fixture','private',null,randomUUID()]);
 const spaceId=createdSpace.space?.id??createdSpace.spaceId??createdSpace.id;
 if(!spaceId)throw new Error(`No space id: ${JSON.stringify(createdSpace)}`);
 const teammate=await seedDb.rpc(claims,'create_team_member',[spaceId,'MCP Fixture Worker',null,'Synthetic local provider','Fixture worker','claude-sonnet-4-5','claude-code','worker','bypassPermissions',{},{}]);
 const task=await seedDb.rpc(claims,'create_task',[spaceId,'MCP browser launch fixture']);
 const calls=[];
 const evidencePath=join(dataDir,'bridge-evidence.jsonl');
 await writeFile(evidencePath,'',{mode:0o600});
 upstream=createServer(async(req,res)=>{
  if(req.url==='/stats'){res.setHeader('content-type','application/json');res.end(JSON.stringify({calls}));return;}
  if(!['Bearer fixture-mcp-key','Bearer synthetic-browser-fixture'].includes(req.headers.authorization)){res.statusCode=401;res.end();return;}
  let body='';for await(const chunk of req)body+=chunk;
  const message=JSON.parse(body);calls.push({method:message.method,at:new Date().toISOString()});
  res.setHeader('content-type','application/json');
  if(message.id===undefined){res.statusCode=202;res.end();return;}
  const result=message.method==='initialize'?{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'browser-fixture',version:'1'}}:
   message.method==='tools/list'?{tools:[{name:'fixture',description:'Returns a synthetic fixture result',inputSchema:{type:'object',properties:{}}}]}:
   {content:[{type:'text',text:'MCP browser fixture tool succeeded'}]};
  res.end(JSON.stringify({jsonrpc:'2.0',id:message.id,result}));
 });
 await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
 const bin=join(dataDir,'bin');await mkdir(bin);
 const smoke=pathToFileURL(join(root,'packages/execution/harness/echo-agent.mjs')).href;
 // A fixture executable substitutes only the vendor process. It consumes the
 // production launch argv and starts the production bridges unchanged.
 await writeFile(join(bin,'claude'),`#!${process.execPath}\nconst evidencePath=${JSON.stringify(evidencePath)};\n`+String.raw`
import {spawn} from 'node:child_process';
import {readFile,appendFile} from 'node:fs/promises';
import {createInterface} from 'node:readline';
if(process.argv.includes('--version')){console.log('2.0.0 (MCP fixture)');process.exit(0);}
const i=process.argv.indexOf('--mcp-config');
if(i!==-1){
 let source=process.argv[i+1];if(!source.startsWith('{'))source=await readFile(source,'utf8');
 for(const [name,cfg]of Object.entries(JSON.parse(source).mcpServers??{})){
  if(name==='tm8')continue;
  const child=spawn(cfg.command,cfg.args??[],{env:{...process.env,...cfg.env},stdio:['pipe','pipe','inherit']});
  const send=(id,method,params={})=>child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
  let tool;let count=3;
  createInterface({input:child.stdout}).on('line',line=>{
   const value=JSON.parse(line);
   if(value.id===1)send(2,'tools/list');
   else if(value.id===2){tool=value.result?.tools?.[0]?.name;if(tool){send(count++,'tools/call',{name:tool,arguments:{}});setInterval(()=>send(count++,'tools/call',{name:tool,arguments:{}}),500);}}
   else {console.log('MCP_FIXTURE_RESULT '+JSON.stringify(value));void appendFile(evidencePath,JSON.stringify({at:new Date().toISOString(),sessionId:process.env.TM8_SESSION_ID,result:value})+'\n');}
  });send(1,'initialize');
 }
}
`+`await import(${JSON.stringify(smoke)});\n`,{mode:0o700});
 process.env.PATH=`${bin}:${process.env.PATH??''}`;
 delete process.env.TM8_AGENT_CMD;
 const {loadConfig}=await import(pathToFileURL(join(root,'packages/server/dist/http/config.js')));
 const {bootstrap}=await import(pathToFileURL(join(root,'packages/server/dist/main.js')));
 const config=loadConfig({TM8_BIND:'127.0.0.1',TM8_PORT:String(port),TM8_DATABASE_URL:databaseUrl,TM8_DATA_DIR:dataDir,
  TM8_LAUNCH_BOOTSTRAP:'0',TM8_PROJECT_DIR:dataDir,TM8_UI_DIR:process.env.MCP_FIXTURE_UI_DIR,
  TM8_ALLOWED_ORIGINS:process.env.MCP_FIXTURE_ALLOWED_ORIGINS??`http://127.0.0.1:5173,http://localhost:5173,http://127.0.0.1:4691,http://localhost:4691,http://127.0.0.1:${port}`,TM8_SPACE_SESSIONS:'off'});
 boot=await bootstrap({config,startBackgroundJobs:false});
 const fixture={token:'',ready:true,url:boot.url,baseUrl:boot.url,databaseUrl,dataDir,evidencePath,spaceId,
  model:'claude-sonnet-4-5',agentTool:'claude-code',
  teammateId:teammate.entity?.id,teamMemberId:teammate.entity?.id,taskId:task.entity?.id,
  fixtureUrl:`http://127.0.0.1:${upstream.address().port}`,
  upstream:`http://127.0.0.1:${upstream.address().port}`,key:'fixture-mcp-key',
  auth:'loopback auto-owner, browser/cli human kind; no production identity',
  connector:{name:'browser_fixture',transport:'http',url:`http://127.0.0.1:${upstream.address().port}`,envKeys:[],headerKeys:['Authorization'],auth:{type:'api_key',headerName:'Authorization'},approved:true,allowPrivateNetwork:true}};
 const fixturePath=join(dataDir,'fixture.json');
 await writeFile(fixturePath,JSON.stringify(fixture,null,2),{mode:0o600});
 console.log(JSON.stringify({...fixture,fixturePath},null,2));
}catch(error){console.error(error);await close();process.exitCode=1;}
