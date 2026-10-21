import { afterAll, beforeAll, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseInvocation } from '../src/args.js';
import { resolveContext } from '../src/context.js';
import { createOutput } from '../src/output.js';
import { MCP_COMMANDS, mcpSelectionFlag } from '../src/commands/mcp.js';
const SPACE='00000000-0000-4000-8000-000000000001',ID='00000000-0000-4000-8000-000000000002';
let server:Server,baseUrl:string,temp:string;
const requests:Array<{method:string;path:string;body:unknown}>=[];
/**
 * What `mcp.servers.get` answers, so `mcp connect` can be driven down each of
 * its doors. Mutable because the door is a property of the CONNECTOR, which is
 * the whole reason that command reads one first.
 */
let definition:Record<string,unknown>|undefined;
beforeAll(async()=>{
 temp=await mkdtemp(join(tmpdir(),'mcp-cli-'));
 server=createServer((req,res)=>{const chunks:Buffer[]=[];req.on('data',c=>chunks.push(c));req.on('end',()=>{
  const raw=Buffer.concat(chunks).toString();requests.push({method:req.method!,path:req.url!,body:raw?JSON.parse(raw):undefined});
  res.setHeader('content-type','application/json');
  const data=/^\/v2\/mcp\/servers\/[^/?]+(\?|$)/.test(req.url!)&&req.method==='GET'&&definition
   ? {id:ID,spaceId:SPACE,version:1,definition,allowed:{register:true,approve:true,manage:true,attach:true}}
   : {ok:true};
  res.end(JSON.stringify({data,requestId:'test'}));
 });});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address();if(!address||typeof address==='string')throw new Error('address');baseUrl=`http://127.0.0.1:${address.port}`;
});
afterAll(async()=>{await new Promise<void>(r=>server.close(()=>r()));await rm(temp,{recursive:true,force:true});});
function context(args:string[]){const parsed=parseInvocation(['--space',SPACE,...args]);return {parsed,ctx:resolveContext({globals:parsed.globals,session:{baseUrl},config:{}}),out:createOutput({format:'input',streams:{stdout(){},stderr(){}}})};}
/** The same context with NO Space in it, for the one read that works without one. */
function spaceless(args:string[]){const parsed=parseInvocation(args);return {parsed,ctx:resolveContext({globals:parsed.globals,session:{baseUrl},config:{}}),out:createOutput({format:'input',streams:{stdout(){},stderr(){}}})};}
async function invoke(args:string[]){const {parsed,ctx,out}=context(args);const mod=MCP_COMMANDS.find(c=>c.path.every((p,i)=>p===parsed.positionals[i]))!;
 return mod.run({path:mod.path,args:parsed.positionals.slice(mod.path.length),options:parsed.options,passthrough:parsed.passthrough,ctx,out});}
it('routes catalog target permissions and versioned definition updates',async()=>{
 await invoke(['mcp','server','list','--target',ID]);expect(requests.at(-1)?.path).toBe(`/v2/spaces/${SPACE}/mcp/servers?targetId=${ID}`);
 await invoke(['mcp','server','update',ID,'--expected-version','2','--input','{"definition":{"name":"fixture"}}']);
 expect(requests.at(-1)).toMatchObject({method:'PATCH',path:`/v2/mcp/servers/${ID}`,body:{expectedVersion:2,definition:{name:'fixture'}}});
});
it('requires credential file/stdin sources and redacts malformed secret JSON errors',async()=>{
 const before=requests.length;
 await expect(invoke(['mcp','credential','create',ID,'--input','{"secret":"fixture-secret"}'])).rejects.toThrow('never pass secrets');
 expect(requests).toHaveLength(before);
 const path=join(temp,'secret.json');await writeFile(path,JSON.stringify({label:'fixture',secret:'fixture-secret'}),{mode:0o600});
 await invoke(['mcp','credential','create',ID,'--input',`@${path}`]);expect(requests.at(-1)?.body).toMatchObject({label:'fixture',secret:'fixture-secret'});
 await writeFile(path,'fixture-secret-is-not-json');await expect(invoke(['mcp','credential','rotate',ID,'--input',`@${path}`])).rejects.toThrow('Unable to read credential JSON input');
});
it('lists the catalog with the ambient space on the query, and without one at all',async()=>{
 await invoke(['mcp','catalog','list']);
 expect(requests.at(-1)).toMatchObject({method:'GET',path:`/v2/mcp/catalog?spaceId=${SPACE}`});
 // The catalog is node-level static data, so it answers before a caller has
 // chosen a Space — the one `mcp` read that does.
 const {parsed,ctx,out}=spaceless(['mcp','catalog','list']);
 const mod=MCP_COMMANDS.find(c=>c.path.join(' ')==='mcp catalog list')!;
 await mod.run({path:mod.path,args:[],options:parsed.options,passthrough:[],ctx,out});
 expect(requests.at(-1)?.path).toBe('/v2/mcp/catalog');
});
it('requests a connector by catalog id, carrying no url or auth of its own',async()=>{
 await invoke(['mcp','server','request','--input','{"catalogId":"notion","note":"we use Notion for specs"}']);
 const sent=requests.at(-1)!;
 expect(sent).toMatchObject({method:'POST',path:`/v2/spaces/${SPACE}/mcp/servers/request`});
 // The Space rides the PATH, not the body.
 expect(sent.body).toMatchObject({catalogId:'notion',note:'we use Notion for specs'});
 expect(sent.body).not.toHaveProperty('spaceId');
 expect(sent.body).not.toHaveProperty('definition');
 expect((sent.body as {clientMutationId?:string}).clientMutationId).toBeTruthy();
});
it('connect chooses its door from the connector, and never takes a secret in argv',async()=>{
 // OAuth: it begins the flow and the caller is handed a URL.
 definition={name:'notion',transport:'http',url:'https://mcp.notion.com/mcp',envKeys:[],headerKeys:[],auth:{type:'oauth2'},approved:true,enabled:true};
 await invoke(['mcp','connect',ID]);
 expect(requests.at(-2)?.path).toBe(`/v2/mcp/servers/${ID}`);
 expect(requests.at(-1)).toMatchObject({method:'POST',path:`/v2/mcp/servers/${ID}/oauth/begin`});
 expect((requests.at(-1)!.body as {label?:string}).label).toBe('notion account');
 // `--shared` on OAuth needs oauth.begin to carry a scope through the redirect
 // (§5.4). Until it does, this refuses rather than connecting personally and
 // calling it shared.
 await expect(invoke(['mcp','connect',ID,'--shared'])).rejects.toThrow('shared OAuth connection');

 // API key: a secret may only arrive by file or stdin.
 definition={name:'internaldocs',transport:'http',url:'https://docs.example.test/mcp',envKeys:[],headerKeys:['Authorization'],
  auth:{type:'api_key',headerName:'Authorization'},approved:true,enabled:true};
 await expect(invoke(['mcp','connect',ID,'--input','{"secret":"fixture-secret"}'])).rejects.toThrow('never pass secrets in arguments');
 const path=join(temp,'connect.json');await writeFile(path,JSON.stringify({secret:'fixture-secret'}),{mode:0o600});
 await invoke(['mcp','connect',ID,'--shared','--input',`@${path}`]);
 expect(requests.at(-1)).toMatchObject({method:'POST',path:`/v2/mcp/servers/${ID}/credentials`,
  body:{secret:'fixture-secret',scope:'space',label:'internaldocs account'}});

 // A connector with no auth needs no connection, and says so instead of
 // inventing a door.
 definition={name:'openserver',transport:'http',url:'https://open.example.test/mcp',envKeys:[],headerKeys:[],auth:{type:'none'},approved:true,enabled:true};
 await expect(invoke(['mcp','connect',ID])).rejects.toThrow('needs no connection');
});
it('keeps omitted versus explicit empty MCP selections distinct',async()=>{
 const cmd=(args:string[])=>{const{parsed,ctx,out}=context(args);return{path:[],args:[],options:parsed.options,passthrough:[],ctx,out};};
 expect(await mcpSelectionFlag(cmd([]))).toBeUndefined();expect(await mcpSelectionFlag(cmd(['--mcp-selections','[]']))).toEqual([]);
 await expect(mcpSelectionFlag(cmd(['--mcp-selections','[{"serverId":"bad"}]']))).rejects.toThrow('array of');
});
