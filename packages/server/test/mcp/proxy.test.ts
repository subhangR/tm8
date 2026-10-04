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
it('serializes rotating OAuth refresh across two sessions and refuses resource mismatch',async()=>{
 let refreshes=0;let origin='';
 origin=await fixture(async(req,res)=>{
  const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(chunk as Buffer);const body=Buffer.concat(chunks).toString();res.setHeader('content-type','application/json');
  if(req.url==='/token'){refreshes++;expect(new URLSearchParams(body).get('refresh_token')).toBe('initial-refresh');await new Promise(resolve=>setTimeout(resolve,20));res.end(JSON.stringify({access_token:'rotated-access',refresh_token:'rotated-refresh',token_type:'Bearer',expires_in:3600}));return;}
  expect(req.headers.authorization).toBe('Bearer rotated-access');const message=JSON.parse(body);if(message.id===undefined){res.writeHead(202);res.end();return;}res.end(JSON.stringify({id:1,result:message.method==='tools/list'?{tools:[]}:{protocolVersion:'2025-03-26'}}));
 });
 let secret={kind:'oauth' as const,accessToken:'expired-access',refreshToken:'initial-refresh',expiresAt:0,issuer:origin,tokenEndpoint:origin+'/token',resource:origin+'/mcp',clientId:'fixture'};
 const proxy=new McpProxy({authorize:async(_claims,sessionId)=>({sessionId,identityId:'h',spaceId:'p',serverId:'m',credentialId:'c'}),definition:async()=>({id:'m',spaceId:'p',approved:true,transport:'http',url:origin+'/mcp',allowPrivateNetwork:true,auth:{type:'oauth2'}}),credentials:{read:async()=>({secret,nonce:'n'}),replace:async(_claims,_binding,_nonce,updated)=>{if(updated.kind!=='oauth')throw new Error();secret=updated as typeof secret;}}});
 await Promise.all(['one','two'].map(session=>proxy.request({identityId:'h'},session,'m','tools/list')));expect(refreshes).toBe(1);
 secret={...secret,resource:origin+'/different'};await expect(proxy.request({identityId:'h'},'one','m','tools/list')).rejects.toThrow('binding mismatch');
});
it('executes a real trusted stdio fixture without inherited model secrets',async()=>{
 const code=`const readline=require('node:readline');readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id!==undefined)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:m.method==='tools/list'?{tools:[{name:'echo',inputSchema:{type:'object'}}]}:{content:[{type:'text',text:process.env.FIXTURE_KEY}],ambient:process.env.OPENAI_API_KEY??null}})+'\\n');});`;
 const proxy=new McpProxy({authorize:async()=>({sessionId:'s',identityId:'h',spaceId:'p',serverId:'m',credentialId:'c'}),definition:async()=>({id:'m',spaceId:'p',approved:true,transport:'stdio',stdioTrusted:true,command:process.execPath,args:['-e',code],auth:{type:'api_key',envKey:'FIXTURE_KEY'}}),credentials:{read:async()=>({secret:{kind:'api_key',value:'stdio-canary'},nonce:'n'}),replace:async()=>{}}});
 const result=await proxy.request({identityId:'h'},'s','m','tools/call',{name:'echo'});expect(result).toEqual({content:[{type:'text',text:'[redacted]'}],ambient:null});
});
it('discovers resource and authorization server and registers a public client',async()=>{
 let origin='';let registered=0;
 origin=await fixture(async(req,res)=>{res.setHeader('content-type','application/json');
  if(req.url==='/mcp'){res.writeHead(401,{'www-authenticate':`Bearer resource_metadata="${origin}/resource"`});res.end();return;}
  if(req.url==='/resource'){res.end(JSON.stringify({resource:origin+'/mcp',authorization_servers:[origin]}));return;}
  if(req.url?.startsWith('/.well-known/')){res.end(JSON.stringify({issuer:origin,authorization_endpoint:origin+'/authorize',token_endpoint:origin+'/token',registration_endpoint:origin+'/register',code_challenge_methods_supported:['S256']}));return;}
  registered++;const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(chunk as Buffer);expect(JSON.parse(Buffer.concat(chunks).toString()).token_endpoint_auth_method).toBe('none');res.writeHead(201);res.end(JSON.stringify({client_id:'registered',token_endpoint_auth_method:'none'}));
 });
 const oauth=new McpOAuth('https://tm8.test/callback');const result=await oauth.begin({identityId:'h',spaceId:'p',serverId:'s',resource:origin+'/mcp',allowPrivateNetwork:true});expect(new URL(result.authorizationUrl).searchParams.get('client_id')).toBe('registered');expect(registered).toBe(1);
 const state=new URL(result.authorizationUrl).searchParams.get('state')!;await expect(oauth.callback('h',{state,error:'access_denied'})).rejects.toThrow('denied');await expect(oauth.callback('h',{state,code:'late'})).rejects.toThrow('state');
});
