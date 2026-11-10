import { mcpResult, providerRequestHeaders } from '@tm8/integrations';
import type { DbClaims } from '../db/types.js';
import type { McpCredentialBinding, McpCredentialStore, McpOAuthSecret, McpRefreshFailure } from './credential-store.js';
import { FirstPartyUnauthorized, type FirstPartyHost } from './first-party/host.js';
import { OAuthTokenError, refreshOAuth } from './oauth.js';
import { mcpStdio } from './stdio.js';
import { mcpHttp } from './transport.js';

export interface McpProxyDefinition {
  id:string;spaceId:string;version?:number;approved:boolean;enabled?:boolean;transport:'http'|'stdio';url?:string;allowPrivateNetwork?:boolean;
  command?:string;args?:string[];stdioTrusted?:boolean;
  auth:{type:'none'|'api_key'|'oauth2';headerName?:string;envKey?:string;prefix?:'Bearer'|'none'};
  catalogId?:string;firstParty?:boolean;gates?:Record<string,boolean>;
}
export interface McpRuntimeClaims extends DbClaims { authSessionId?:string }
export interface McpProxyGrant { sessionId:string;identityId:string;launcherIdentityId?:string;spaceId:string;serverId:string;credentialId?:string;
  /**
   * §6's recorded provenance (343). The ROOT is the human the connection
   * belongs to, so it is the identity every credential read runs under, and the
   * chain is what an audit row names. Absent on a binding written before 343.
   */
  rootIdentityId?:string|null;rootMemberId?:string|null;chain?:string[];chainSpaceIds?:string[] }
export interface McpProxyPorts {
  credentials: Pick<McpCredentialStore,'read'|'replace'> & Partial<Pick<McpCredentialStore,'withRefreshLock'|'touch'|'reportFailure'>>;
  /** Must read live session, launcher, selected connector/account and current membership from DB. */
  authorize(claims:McpRuntimeClaims,sessionId:string,serverId:string):Promise<McpProxyGrant>;
  definition(claims:DbClaims,serverId:string):Promise<McpProxyDefinition>;
  /** §8.1: the in-process host serving a first-party definition, or undefined when this node serves none. */
  firstParty?(definition:McpProxyDefinition):FirstPartyHost|undefined;
}
interface Connection { upstreamSession?:string; initialized:boolean; protocolVersion?:string }
/** Per-call observers. `refreshed` runs once after a refreshed token is saved (§5.6's 'refreshed' audit row). */
export interface McpProxyEvents { refreshed?():Promise<void> }
/** What a caller sees when a refresh leaves the connection needing its owner (§7.2). */
export const MCP_RECONNECT_REQUIRED='MCP OAuth account requires reconnect';
/** No vendor credential leaves this service. A runtime bearer cannot pick another account. */
export class McpProxy {
  private readonly connections=new Map<string,Connection>();
  private readonly locks=new Map<string,Promise<void>>();
  constructor(private readonly ports:McpProxyPorts) {}
  async request(claims:McpRuntimeClaims,sessionId:string,serverId:string,method:'tools/list'|'tools/call',params:Record<string,unknown>={},events:McpProxyEvents={}):Promise<unknown> {
    if(!['tools/list','tools/call'].includes(method))throw new Error('MCP method refused');
    const grant=await this.ports.authorize(claims,sessionId,serverId);
    if(grant.sessionId!==sessionId || grant.serverId!==serverId || grant.identityId!==claims.identityId || claims.viaLinkId)throw new Error('MCP session unavailable');
    // §6: the connection belongs to the ROOT, so the opener runs as the root.
    // The launcher identity is the same human for every bearer chain; it stays
    // as the fallback for a binding written before 343 recorded a root.
    const credentialClaims:DbClaims={...claims,identityId:grant.rootIdentityId??grant.launcherIdentityId??grant.identityId,actorId:undefined,nodeAdmin:false};
    const definition=await this.ports.definition(credentialClaims,serverId);
    if(!definition.approved || definition.enabled===false || definition.spaceId!==grant.spaceId)throw new Error('MCP connector unavailable');
    if(definition.transport==='stdio') {
      if(!definition.stdioTrusted || !definition.command || definition.auth.type==='oauth2')throw new Error('MCP executable is not trusted');
      const env:Record<string,string>={};let secretValue='';
      const check=async()=>{
        const live=await this.ports.authorize(claims,sessionId,serverId);
        if(JSON.stringify(live)!==JSON.stringify(grant))throw new Error('MCP session changed');
        const current=await this.ports.definition(credentialClaims,serverId);
        if(JSON.stringify(current)!==JSON.stringify(definition))throw new Error('MCP connector unavailable; definition changed');
        if(definition.auth.type==='api_key') {
          if(!grant.credentialId || !definition.auth.envKey || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(definition.auth.envKey))throw new Error('Select an MCP account before launch');
          const opened=await this.ports.credentials.read(credentialClaims,{spaceId:grant.spaceId,serverId,credentialId:grant.credentialId});
          if(definition.version !== undefined && opened.definitionVersion !== definition.version)throw new Error('MCP connector definition changed; reconnect required');
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
    // §8.1: a first-party connector is served in-process. It is never relayed to
    // its URL — that URL is an identity — and it is OAuth or nothing.
    const host=definition.firstParty===true?this.ports.firstParty?.(definition):undefined;
    if(definition.firstParty===true && (!host || definition.auth.type!=='oauth2'))throw new Error('MCP connector unavailable');
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
      const headers:Record<string,string>={'content-type':'application/json',accept:'application/json, text/event-stream','mcp-protocol-version':'2025-03-26',...providerRequestHeaders(definition.catalogId,definition.url)};
      const redactions:string[]=[];
      let connected:McpOAuthSecret|undefined;
      const loadAuthorization=async(forceToken?:string):Promise<boolean>=>{
        if(definition.auth.type==='none')return false;
        let refreshed=false;
        if(!grant.credentialId)throw new Error('Select an MCP account before launch');
        const binding:McpCredentialBinding={spaceId:grant.spaceId,serverId,credentialId:grant.credentialId};
        // §7.2: set inside the refresh lock, reported after it. A refused grant
        // throws inside (nothing to save); a scope-reduced one is saved first,
        // because a rotated refresh token must never be lost.
        let failure:McpRefreshFailure|undefined;
        const reconnect=async(reason:McpRefreshFailure):Promise<never>=>{
          await this.ports.credentials.reportFailure?.(credentialClaims,binding,reason)
            .catch(error=>{console.warn(`mcp: could not record a ${reason} refresh failure: ${String(error)}`);});
          throw new Error(MCP_RECONNECT_REQUIRED);
        };
        try {
        await credentialLock(JSON.stringify(binding),async()=>{
          const run=async(store:Pick<McpCredentialStore,'read'|'replace'>)=>{
          const opened=await store.read(credentialClaims,binding);
          if(definition.version !== undefined && opened.definitionVersion !== definition.version)throw new Error('MCP connector definition changed; reconnect required');
          let secret=opened.secret;
          if(secret.kind==='oauth') {
            if(definition.auth.type!=='oauth2' || secret.resource!==definition.url)throw new Error('MCP account binding mismatch');
            redactions.push(secret.accessToken,...(secret.refreshToken?[secret.refreshToken]:[]));
            if((forceToken!==undefined && secret.accessToken===forceToken) || (secret.expiresAt!==undefined && secret.expiresAt<Date.now()+30000)) {
              try {secret=host?await host.refresh(secret):await refreshOAuth(secret,definition.allowPrivateNetwork===true);}
              catch(error) {if(error instanceof OAuthTokenError && error.oauthError==='invalid_grant')failure='invalid_grant';throw error;}
              await store.replace(credentialClaims,binding,opened.nonce,secret);
              await store.read(credentialClaims,binding);
              refreshed=true;
              // B41: a partial grant stays active with its covered tools; none covered needs a reconnect.
              if(host?.covers && !host.covers(definition,secret.grantedScopes)) {failure='scope_reduced';return;}
            }
            headers.authorization=`Bearer ${secret.accessToken}`;connected=secret;
            redactions.push(secret.accessToken,...(secret.refreshToken?[secret.refreshToken]:[]));
          } else {
            if(definition.auth.type!=='api_key' || /[\r\n\0]/.test(secret.value))throw new Error('MCP account binding mismatch');
            const name=definition.auth.headerName??'Authorization';
            if(!/^[A-Za-z][A-Za-z0-9-]*$/.test(name) || ['host','cookie','connection','content-length','transfer-encoding','proxy-authorization','proxy-connection','te','trailer','upgrade','accept','content-type','mcp-session-id','mcp-protocol-version'].includes(name.toLowerCase()))throw new Error('MCP authorization header refused');
            headers[name]=definition.auth.prefix==='none'?secret.value:name.toLowerCase()==='authorization'?`Bearer ${secret.value}`:secret.value;
            redactions.push(secret.value);
          }
          };
          if(this.ports.credentials.withRefreshLock)await this.ports.credentials.withRefreshLock(credentialClaims,binding,run);
          else await run(this.ports.credentials);
        });
        } catch(error) {if(failure==='invalid_grant')await reconnect(failure);throw error;}
        if(failure)await reconnect(failure);
        if(refreshed)await events.refreshed?.();
        return refreshed;
      };
      await loadAuthorization();
      const connection=this.connections.get(key)??{initialized:false};
      const recheck=async()=>{
        const liveGrant=await this.ports.authorize(claims,sessionId,serverId);
        if(JSON.stringify(liveGrant)!==JSON.stringify(grant))throw new Error('MCP session changed');
        const liveDefinition=await this.ports.definition(credentialClaims,serverId);
        if(JSON.stringify(liveDefinition)!==JSON.stringify(definition) || !liveDefinition.approved || liveDefinition.enabled===false)throw new Error('MCP connector unavailable; definition changed');
      };
      const rpc=async(rpcMethod:string,rpcParams:Record<string,unknown>,notification=false):Promise<unknown>=>{
        // Recheck selected grants and credential sharing immediately before every send.
        const live=await this.ports.authorize(claims,sessionId,serverId);
        if(JSON.stringify(live)!==JSON.stringify(grant))throw new Error('MCP session changed');
        const liveDefinition=await this.ports.definition(credentialClaims,serverId);
        if(JSON.stringify(liveDefinition)!==JSON.stringify(definition))throw new Error('MCP connector unavailable; definition changed');
        if(grant.credentialId) {
          const bound=await this.ports.credentials.read(credentialClaims,{spaceId:grant.spaceId,serverId,credentialId:grant.credentialId});
          if(definition.version !== undefined && bound.definitionVersion !== definition.version)throw new Error('MCP connector definition changed; reconnect required');
        }
        if(connection.upstreamSession)headers['mcp-session-id']=connection.upstreamSession;
        if(connection.protocolVersion)headers['mcp-protocol-version']=connection.protocolVersion;
        const refreshed=await loadAuthorization();
        if(refreshed)await recheck();
        if(host) {
          const call=()=>host.request(definition,rpcMethod as 'tools/list'|'tools/call',rpcParams,{accessToken:connected!.accessToken,...(connected!.grantedScopes?{grantedScopes:connected!.grantedScopes}:{})});
          let result:unknown;
          try {result=await call();}
          catch(error) {
            if(!(error instanceof FirstPartyUnauthorized))throw error;
            await loadAuthorization(headers.authorization!.slice(7));
            await recheck();
            // exactly one recovery, as for a relay's 401
            try {result=await call();}
            catch(retryError) {if(retryError instanceof FirstPartyUnauthorized)throw new Error('MCP upstream request failed');throw retryError;}
          }
          return redactMcpResult(result,redactions);
        }
        const send=()=>mcpHttp({url:definition.url!,method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',...(notification?{}:{id:1}),method:rpcMethod,params:rpcParams})},definition.allowPrivateNetwork===true);
        let response=await send();
        if(response.status===401 && definition.auth.type==='oauth2') {
          await loadAuthorization(headers.authorization?.slice(7));
          await recheck();
          response=await send(); // exactly one recovery; never retry a failed tool result
        }
        if(response.status<200 || response.status>=300)throw new Error('MCP upstream request failed');
        if(response.headers['mcp-session-id'])connection.upstreamSession=response.headers['mcp-session-id'];
        if(notification)return null;
        return redactMcpResult(mcpResult(response, 1),redactions);
      };
      // §5.2 "Make the proxy write it": last_used_at is what the Connectors page
      // shows and what the reuse heuristic reads. Best-effort — a failed stamp
      // must never fail a tool call that is otherwise authorized.
      if(grant.credentialId && this.ports.credentials.touch) {
        await this.ports.credentials.touch(credentialClaims,{spaceId:grant.spaceId,serverId,credentialId:grant.credentialId}).catch(()=>{});
      }
      // A first-party host has no MCP session to initialize.
      if(!connection.initialized && !host) {
        const initialization=await rpc('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'tm8',version:'1'}}) as {protocolVersion?:string};
        if(initialization.protocolVersion && !['2024-11-05','2025-03-26','2025-06-18'].includes(initialization.protocolVersion))throw new Error('MCP protocol version unsupported');
        connection.protocolVersion=initialization.protocolVersion??'2025-03-26';
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
