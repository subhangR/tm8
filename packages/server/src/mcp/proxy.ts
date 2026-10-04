import type { DbClaims } from '../db/types.js';
import type { McpCredentialBinding, McpCredentialStore } from './credential-store.js';
import { refreshOAuth } from './oauth.js';
import { mcpStdio } from './stdio.js';
import { mcpHttp } from './transport.js';

export interface McpProxyDefinition {
  id:string;spaceId:string;approved:boolean;enabled?:boolean;transport:'http'|'stdio';url?:string;allowPrivateNetwork?:boolean;
  command?:string;args?:string[];stdioTrusted?:boolean;
  auth:{type:'none'|'api_key'|'oauth2';headerName?:string;envKey?:string;prefix?:'Bearer'|'none'};
}
export interface McpProxyGrant { sessionId:string;identityId:string;spaceId:string;serverId:string;credentialId?:string }
export interface McpProxyPorts {
  credentials: Pick<McpCredentialStore,'read'|'replace'> & Partial<Pick<McpCredentialStore,'withRefreshLock'>>;
  /** Must read live session, launcher, selected connector/account and current membership from DB. */
  authorize(claims:DbClaims,sessionId:string,serverId:string):Promise<McpProxyGrant>;
  definition(claims:DbClaims,serverId:string):Promise<McpProxyDefinition>;
}
interface Connection { upstreamSession?:string; initialized:boolean }
/** No vendor credential leaves this service. A runtime bearer cannot pick another account. */
export class McpProxy {
  private readonly connections=new Map<string,Connection>();
  private readonly locks=new Map<string,Promise<void>>();
  constructor(private readonly ports:McpProxyPorts) {}
  async request(claims:DbClaims,sessionId:string,serverId:string,method:'tools/list'|'tools/call',params:Record<string,unknown>={}):Promise<unknown> {
    if(!['tools/list','tools/call'].includes(method))throw new Error('MCP method refused');
    const grant=await this.ports.authorize(claims,sessionId,serverId);
    if(grant.sessionId!==sessionId || grant.serverId!==serverId || grant.identityId!==claims.identityId || claims.viaLinkId)throw new Error('MCP session unavailable');
    const definition=await this.ports.definition(claims,serverId);
    if(!definition.approved || definition.enabled===false || definition.spaceId!==grant.spaceId)throw new Error('MCP connector unavailable');
    if(definition.transport==='stdio') {
      if(!definition.stdioTrusted || !definition.command || definition.auth.type==='oauth2')throw new Error('MCP executable is not trusted');
      const env:Record<string,string>={};let secretValue='';
      const check=async()=>{
        const live=await this.ports.authorize(claims,sessionId,serverId);
        if(JSON.stringify(live)!==JSON.stringify(grant))throw new Error('MCP session changed');
        const current=await this.ports.definition(claims,serverId);
        if(JSON.stringify(current)!==JSON.stringify(definition))throw new Error('MCP connector unavailable; definition changed');
        if(definition.auth.type==='api_key') {
          if(!grant.credentialId || !definition.auth.envKey || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(definition.auth.envKey))throw new Error('Select an MCP account before launch');
          const opened=await this.ports.credentials.read(claims,{spaceId:grant.spaceId,serverId,credentialId:grant.credentialId});
          if(opened.secret.kind!=='api_key')throw new Error('MCP account binding mismatch');
          if(secretValue && secretValue!==opened.secret.value)throw new Error('MCP credential changed');
          secretValue=opened.secret.value;env[definition.auth.envKey]=secretValue;
        }
      };
      await check();
      const result=await mcpStdio({command:definition.command,args:definition.args??[],env,method,params,beforeSend:check});
      return redactMcpResult(result,secretValue?[secretValue]:[]);
    }
    if(!definition.url)throw new Error('MCP connector unavailable');
    const key=JSON.stringify([sessionId,grant.identityId,grant.spaceId,serverId,grant.credentialId]);
    // Serialize each connection, including initialize and concurrent refresh attempts.
    const previous=this.locks.get(key)??Promise.resolve();
    let release!:()=>void;
    const held=new Promise<void>(resolve=>{release=resolve;});
    const chain=previous.then(()=>held);
    this.locks.set(key,chain);
    await previous;
    try {
      const current=await this.ports.authorize(claims,sessionId,serverId);
      if(JSON.stringify(current)!==JSON.stringify(grant))throw new Error('MCP session changed');
      const headers:Record<string,string>={'content-type':'application/json',accept:'application/json, text/event-stream','mcp-protocol-version':'2025-03-26'};
      const redactions:string[]=[];
      const loadAuthorization=async(forceToken?:string)=>{
        if(definition.auth.type==='none')return;
        if(!grant.credentialId)throw new Error('Select an MCP account before launch');
        const binding:McpCredentialBinding={spaceId:grant.spaceId,serverId,credentialId:grant.credentialId};
        await credentialLock(JSON.stringify(binding),async()=>{
          const run=async(store:Pick<McpCredentialStore,'read'|'replace'>)=>{
          const opened=await store.read(claims,binding);
          let secret=opened.secret;
          if(secret.kind==='oauth') {
            if(definition.auth.type!=='oauth2' || secret.resource!==definition.url)throw new Error('MCP account binding mismatch');
            redactions.push(secret.accessToken,...(secret.refreshToken?[secret.refreshToken]:[]));
            if((forceToken!==undefined && secret.accessToken===forceToken) || (secret.expiresAt!==undefined && secret.expiresAt<Date.now()+30000)) {
              secret=await refreshOAuth(secret,definition.allowPrivateNetwork===true);
              await store.replace(claims,binding,opened.nonce,secret);
              await store.read(claims,binding);
            }
            headers.authorization=`Bearer ${secret.accessToken}`;
            redactions.push(secret.accessToken,...(secret.refreshToken?[secret.refreshToken]:[]));
          } else {
            if(definition.auth.type!=='api_key' || /[\r\n\0]/.test(secret.value))throw new Error('MCP account binding mismatch');
            const name=definition.auth.headerName??'Authorization';
            if(!/^[A-Za-z][A-Za-z0-9-]*$/.test(name) || ['host','cookie','connection','content-length','transfer-encoding','proxy-authorization','proxy-connection','te','trailer','upgrade','accept','content-type','mcp-session-id','mcp-protocol-version'].includes(name.toLowerCase()))throw new Error('MCP authorization header refused');
            headers[name]=definition.auth.prefix==='none'?secret.value:name.toLowerCase()==='authorization'?`Bearer ${secret.value}`:secret.value;
            redactions.push(secret.value);
          }
          };
          if(this.ports.credentials.withRefreshLock)await this.ports.credentials.withRefreshLock(claims,binding,run);
          else await run(this.ports.credentials);
        });
      };
      await loadAuthorization();
      const connection=this.connections.get(key)??{initialized:false};
      const rpc=async(rpcMethod:string,rpcParams:Record<string,unknown>,notification=false):Promise<unknown>=>{
        // Recheck selected grants and credential sharing immediately before every send.
        const live=await this.ports.authorize(claims,sessionId,serverId);
        if(JSON.stringify(live)!==JSON.stringify(grant))throw new Error('MCP session changed');
        const liveDefinition=await this.ports.definition(claims,serverId);
        if(JSON.stringify(liveDefinition)!==JSON.stringify(definition))throw new Error('MCP connector unavailable; definition changed');
        if(grant.credentialId)await this.ports.credentials.read(claims,{spaceId:grant.spaceId,serverId,credentialId:grant.credentialId});
        if(connection.upstreamSession)headers['mcp-session-id']=connection.upstreamSession;
        await loadAuthorization();
        const send=()=>mcpHttp({url:definition.url!,method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',...(notification?{}:{id:1}),method:rpcMethod,params:rpcParams})},definition.allowPrivateNetwork===true);
        let response=await send();
        if(response.status===401 && definition.auth.type==='oauth2') {
          await loadAuthorization(headers.authorization?.slice(7));
          const retryGrant=await this.ports.authorize(claims,sessionId,serverId);
          if(JSON.stringify(retryGrant)!==JSON.stringify(grant))throw new Error('MCP session changed');
          response=await send(); // exactly one recovery; never retry a failed tool result
        }
        if(response.status<200 || response.status>=300)throw new Error('MCP upstream request failed');
        if(response.headers['mcp-session-id'])connection.upstreamSession=response.headers['mcp-session-id'];
        if(notification)return null;
        let body=response.body;
        if(response.headers['content-type']?.includes('text/event-stream')) {
          const messages=body.split(/\r?\n\r?\n/).map(event=>event.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n')).filter(Boolean);
          body=messages.find(message=>{try{return (JSON.parse(message) as {id?:unknown}).id===1;}catch{return false;}})??'';
        }
        let value:{id?:unknown;result?:unknown;error?:unknown};
        try{value=JSON.parse(body) as typeof value;}catch{throw new Error('MCP response invalid');}
        if(value.id!==1 || value.error || value.result===undefined)throw new Error('MCP upstream request failed');
        return redactMcpResult(value.result,redactions);
      };
      if(!connection.initialized) {
        await rpc('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'tm8',version:'1'}});
        await rpc('notifications/initialized',{},true);
        connection.initialized=true;this.connections.set(key,connection);
      }
      return await rpc(method,params);
    } finally {release();if(this.locks.get(key)===chain)this.locks.delete(key);}
  }
  forgetSession(sessionId:string):void {for(const key of this.connections.keys())if((JSON.parse(key) as string[])[0]===sessionId)this.connections.delete(key);}
}

const credentialLocks=new Map<string,Promise<void>>();
async function credentialLock<T>(key:string,run:()=>Promise<T>):Promise<T> {
 const previous=credentialLocks.get(key)??Promise.resolve();let release!:()=>void;
 const held=new Promise<void>(resolve=>{release=resolve;});const chain=previous.then(()=>held);credentialLocks.set(key,chain);
 await previous;
 try{return await run();}finally{release();if(credentialLocks.get(key)===chain)credentialLocks.delete(key);}
}

export function redactMcpResult(value:unknown,secrets:readonly string[]):unknown {
 if(typeof value==='string'){let result=value;for(const secret of secrets)if(secret)result=result.split(secret).join('[redacted]');return result;}
 if(Array.isArray(value))return value.map(item=>redactMcpResult(item,secrets));
 if(value && typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[redactMcpResult(key,secrets) as string,redactMcpResult(item,secrets)]));
 return value;
}
