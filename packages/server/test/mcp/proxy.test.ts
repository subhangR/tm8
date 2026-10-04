import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { McpProxy } from '../../src/mcp/proxy.js';
import { mcpHttp } from '../../src/mcp/transport.js';
import { McpOAuth } from '../../src/mcp/oauth.js';
const servers:Server[]=[];
afterEach(async()=>{await Promise.all(servers.splice(0).map(server=>new Promise<void>(resolve=>server.close(()=>resolve()))));});
async function fixture(handler:Parameters<typeof createServer>[0]) {
 const server=createServer(handler);servers.push(server);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));return `http://127.0.0.1:${(server.address() as {port:number}).port}`;
}
describe('MCP guarded proxy fixtures',()=>{
 it('initializes, lists and calls with server-side auth; refuses revoked grants and changed launcher',async()=>{
  const seen:string[]=[];let revoked=false;
  const url=await fixture(async(req,res)=>{const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(chunk as Buffer);const message=JSON.parse(Buffer.concat(chunks).toString());seen.push(message.method);expect(req.headers.authorization).toBe('Bearer fixture-secret');res.setHeader('content-type','application/json');if(message.method==='notifications/initialized'){res.writeHead(202);res.end();return;}res.end(JSON.stringify({jsonrpc:'2.0',id:1,result:message.method==='tools/list'?{tools:[{name:'echo',inputSchema:{type:'object'}}]}:{text:'fixture-secret'}}));});
  const grant={sessionId:'session',identityId:'human',spaceId:'space',serverId:'server',credentialId:'account'};
  const proxy=new McpProxy({authorize:async()=>grant,definition:async()=>({id:'server',spaceId:'space',approved:true,transport:'http',url,allowPrivateNetwork:true,auth:{type:'api_key'}}),credentials:{read:async()=>{if(revoked)throw new Error('revoked');return {secret:{kind:'api_key',value:'fixture-secret'},nonce:'n'};},replace:async()=>{}}});
  expect(await proxy.request({identityId:'human'},'session','server','tools/list')).toEqual({tools:[{name:'echo',inputSchema:{type:'object'}}]});
  expect(await proxy.request({identityId:'human'},'session','server','tools/call',{name:'echo',arguments:{}})).toEqual({text:'[redacted]'});
  expect(seen).toEqual(['initialize','notifications/initialized','tools/list','tools/call']);
  revoked=true;await expect(proxy.request({identityId:'human'},'session','server','tools/call')).rejects.toThrow('revoked');
  await expect(proxy.request({identityId:'other'},'session','server','tools/list')).rejects.toThrow('unavailable');
  expect(seen).toHaveLength(4);
 });
 it('refuses private endpoints without admin policy and never follows redirects',async()=>{
  let count=0;const url=await fixture((_req,res)=>{count++;res.writeHead(302,{location:'http://127.0.0.1:1/secret'});res.end();});
  await expect(mcpHttp({url,method:'GET'})).rejects.toThrow();expect(count).toBe(0);
  await expect(mcpHttp({url,method:'GET'},true)).rejects.toThrow('redirect');expect(count).toBe(1);
 });
 it('requires explicit credential and refuses wrong server binding before network access',async()=>{
  let reads=0;const proxy=new McpProxy({authorize:async()=>({sessionId:'s',identityId:'h',spaceId:'p',serverId:'m'}),definition:async()=>({id:'m',spaceId:'p',approved:true,transport:'http',url:'https://example.test',auth:{type:'api_key'}}),credentials:{read:async()=>{reads++;throw new Error();},replace:async()=>{}}});
  await expect(proxy.request({identityId:'h'},'s','m','tools/list')).rejects.toThrow('Select');expect(reads).toBe(0);
 });
 it('binds OAuth state to a human, uses PKCE/resource and consumes callback once',async()=>{
  let origin='';let tokenCalls=0;
  origin=await fixture(async(req,res)=>{res.setHeader('content-type','application/json');if(req.url?.startsWith('/.well-known/')){res.end(JSON.stringify({issuer:origin,authorization_endpoint:origin+'/authorize',token_endpoint:origin+'/token',code_challenge_methods_supported:['S256']}));return;}
   tokenCalls++;const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(chunk as Buffer);const body=new URLSearchParams(Buffer.concat(chunks).toString());expect(body.get('code_verifier')?.length).toBeGreaterThan(40);expect(body.get('resource')).toBe(origin+'/mcp');res.end(JSON.stringify({access_token:'access',refresh_token:'refresh',token_type:'Bearer',expires_in:3600}));});
  const oauth=new McpOAuth('https://tm8.test/callback');const started=await oauth.begin({identityId:'h',spaceId:'p',serverId:'s',resource:origin+'/mcp',issuer:origin,clientId:'client',allowPrivateNetwork:true});const auth=new URL(started.authorizationUrl);expect(auth.searchParams.get('code_challenge_method')).toBe('S256');const state=auth.searchParams.get('state')!;
  await expect(oauth.callback('other',{state,code:'code'})).rejects.toThrow('state');expect(tokenCalls).toBe(0);
  const result=await oauth.callback('h',{state,code:'code'});expect(result.secret.accessToken).toBe('access');
  await expect(oauth.callback('h',{state,code:'code'})).rejects.toThrow('state');expect(tokenCalls).toBe(1);
 });
});
