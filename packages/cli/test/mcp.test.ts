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
beforeAll(async()=>{
 temp=await mkdtemp(join(tmpdir(),'mcp-cli-'));
 server=createServer((req,res)=>{const chunks:Buffer[]=[];req.on('data',c=>chunks.push(c));req.on('end',()=>{
  const raw=Buffer.concat(chunks).toString();requests.push({method:req.method!,path:req.url!,body:raw?JSON.parse(raw):undefined});
  res.setHeader('content-type','application/json');res.end(JSON.stringify({data:{ok:true},requestId:'test'}));
 });});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address();if(!address||typeof address==='string')throw new Error('address');baseUrl=`http://127.0.0.1:${address.port}`;
});
afterAll(async()=>{await new Promise<void>(r=>server.close(()=>r()));await rm(temp,{recursive:true,force:true});});
function context(args:string[]){const parsed=parseInvocation(['--space',SPACE,...args]);return {parsed,ctx:resolveContext({globals:parsed.globals,session:{baseUrl},config:{}}),out:createOutput({format:'input',streams:{stdout(){},stderr(){}}})};}
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
it('keeps omitted versus explicit empty MCP selections distinct',async()=>{
 const cmd=(args:string[])=>{const{parsed,ctx,out}=context(args);return{path:[],args:[],options:parsed.options,passthrough:[],ctx,out};};
 expect(await mcpSelectionFlag(cmd([]))).toBeUndefined();expect(await mcpSelectionFlag(cmd(['--mcp-selections','[]']))).toEqual([]);
 await expect(mcpSelectionFlag(cmd(['--mcp-selections','[{"serverId":"bad"}]']))).rejects.toThrow('array of');
});
