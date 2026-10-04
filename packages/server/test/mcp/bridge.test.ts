import { createServer, type Server } from 'node:http';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { getOperation } from '@tm8/contract';
import { HandlerRegistry } from '../../src/facade/registry.js';
import type { FacadeDeps } from '../../src/facade/deps.js';
import type { RequestContext } from '../../src/http/types.js';
import { registerMcpRuntimeHandlers } from '../../src/mcp/handlers.js';
const servers:Server[]=[];const children:ChildProcessWithoutNullStreams[]=[];
afterEach(async()=>{for(const child of children.splice(0))child.kill('SIGKILL');await Promise.all(servers.splice(0).map(server=>new Promise<void>(resolve=>server.close(()=>resolve()))));});
async function listen(handler:Parameters<typeof createServer>[0]){const server=createServer(handler);servers.push(server);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));return `http://127.0.0.1:${(server.address() as {port:number}).port}`;}
it.each(['agent','agent_runtime'] as const)('real bridge invokes registered proxy handler using a bound %s fixture bearer',async kind=>{
 const serverId='00000000-0000-4000-8000-000000000001';const sessionId='00000000-0000-4000-8000-000000000002';const spaceId='00000000-0000-4000-8000-000000000003';
 const upstream=await listen(async(req,res)=>{const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(chunk as Buffer);const message=JSON.parse(Buffer.concat(chunks).toString());res.setHeader('content-type','application/json');if(message.id===undefined){res.writeHead(202);res.end();return;}res.end(JSON.stringify({jsonrpc:'2.0',id:1,result:message.method==='initialize'?{protocolVersion:'2025-03-26'}:message.method==='tools/list'?{tools:[{name:'echo',inputSchema:{type:'object'}}]}:{content:[{type:'text',text:'fixture tool called'}]}}));});
 const audit:unknown[][]=[];const registry=new HandlerRegistry();
 const deps={db:{rpc:async(_claims:unknown,fn:string,args:unknown[])=>{expect(fn).toBe('record_mcp_call');audit.push(args);}},owner:async()=>({identityId:'owner',nodeAdmin:false}),config:{}} as unknown as FacadeDeps;
 registerMcpRuntimeHandlers(registry,deps,{dataDir:'/unused',callbackUrl:'https://tm8.test/mcp/oauth/callback',definition:async()=>({id:serverId,spaceId,version:1,allowed:{register:false,manage:false,approve:false,attach:false},definition:{name:'fixture',transport:'http',url:upstream,envKeys:[],headerKeys:[],auth:{type:'none'},approved:true,allowPrivateNetwork:true}}),authorize:async(claims,id,server)=>{expect(claims.authSessionId).toBe('verified-bearer');expect(id).toBe(sessionId);expect(server).toBe(serverId);return {sessionId,serverId,spaceId,identityId:'human'};}});
 const facade=await listen(async(req,res)=>{try{expect(req.headers.authorization).toBe('Bearer fixture-runtime-token');const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(chunk as Buffer);const body=JSON.parse(Buffer.concat(chunks).toString());const context={op:getOperation('mcp.proxy.request'),opName:'mcp.proxy.request',params:{sessionId,serverId},query:new URLSearchParams(),body,requestId:'fixture-request',identity:{kind:'bearer',identityId:'human',authKind:kind,sessionId:'verified-bearer',...(kind==='agent'?{workSessionId:sessionId}:{runtimeChatId:sessionId}),sessionSpaceId:spaceId},headers:req.headers,method:'POST',path:req.url} as RequestContext;const data=await registry.get('mcp.proxy.request')!(context);res.setHeader('content-type','application/json');res.end(JSON.stringify({data,requestId:'fixture-request'}));}catch{res.writeHead(403);res.end('{}');}});
 const child=spawn(process.execPath,[fileURLToPath(new URL('../../../mcp/dist/cli.js',import.meta.url)),'--connector',serverId],{env:{PATH:process.env.PATH,TM8_BASE_URL:facade,...(kind==='agent'?{TM8_AGENT_TOKEN:'fixture-runtime-token',TM8_SESSION_ID:sessionId}:{TM8_AGENT_RUNTIME_TOKEN:'fixture-runtime-token',TM8_CHAT_ID:sessionId})},stdio:['pipe','pipe','pipe']});children.push(child);
 const lines=createInterface({input:child.stdout});const waiting=new Map<number,(value:unknown)=>void>();lines.on('line',line=>{const message=JSON.parse(line);waiting.get(message.id)?.(message);waiting.delete(message.id);});
 const call=(id:number,method:string,params={})=>new Promise<unknown>((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('bridge fixture timed out')),10000);waiting.set(id,value=>{clearTimeout(timeout);resolve(value);});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});
 expect(await call(1,'initialize')).toMatchObject({result:{serverInfo:{name:'tm8-connector'}}});
 expect(await call(2,'tools/list')).toMatchObject({result:{tools:[{name:'echo'}]}});
 expect(await call(3,'tools/call',{name:'echo'})).toMatchObject({result:{content:[{text:'fixture tool called'}]}});
 expect(audit.map(row=>row[5])).toEqual(['started','succeeded','started','succeeded']);expect(JSON.stringify(audit)).not.toContain('fixture-runtime-token');lines.close();
});
