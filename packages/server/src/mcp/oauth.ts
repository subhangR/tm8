import { createHash, randomBytes } from 'node:crypto';
import { mcpHttp } from './transport.js';
import type { McpOAuthSecret } from './credential-store.js';

interface Metadata { issuer: string; authorization_endpoint: string; token_endpoint: string; code_challenge_methods_supported?: string[]; response_types_supported?: string[] }
interface Pending { identityId: string; spaceId: string; serverId: string; verifier: string; redirectUri: string; clientId: string; resource: string; metadata: Metadata; expires: number; privateNetwork: boolean }
export class McpOAuth {
  private readonly pending = new Map<string,Pending>();
  constructor(private readonly callbackUrl: string) {}
  async begin(input: {identityId:string;spaceId:string;serverId:string;resource:string;issuer:string;clientId:string;scopes?:string[];allowPrivateNetwork:boolean}): Promise<{authorizationUrl:string;expiresAt:string}> {
    for(const [key,value] of this.pending) if(value.expires<Date.now())this.pending.delete(key);
    if(this.pending.size>=1000) throw new Error('Too many pending MCP connections');
    const issuer=new URL(input.issuer);
    const discovery=new URL('/.well-known/oauth-authorization-server'+issuer.pathname.replace(/\/$/,''),issuer.origin);
    const response=await mcpHttp({url:discovery.href,method:'GET'},input.allowPrivateNetwork);
    if(response.status!==200)throw new Error('OAuth discovery failed');
    let metadata: Metadata;
    try {metadata=JSON.parse(response.body) as Metadata;}catch{throw new Error('OAuth discovery failed');}
    if(metadata.issuer!==input.issuer || !metadata.code_challenge_methods_supported?.includes('S256'))throw new Error('OAuth issuer or PKCE unsupported');
    // Cross-origin authorization servers must be separately registered; no arbitrary token destination.
    for(const endpoint of [metadata.authorization_endpoint,metadata.token_endpoint]) {
      const parsed=new URL(endpoint);
      if(parsed.origin!==issuer.origin || parsed.username || parsed.password || parsed.hash)throw new Error('OAuth endpoint refused');
    }
    const state=randomBytes(32).toString('base64url');
    const verifier=randomBytes(48).toString('base64url');
    const expires=Date.now()+10*60*1000;
    this.pending.set(state,{identityId:input.identityId,spaceId:input.spaceId,serverId:input.serverId,resource:input.resource,clientId:input.clientId,metadata,verifier,redirectUri:this.callbackUrl,expires,privateNetwork:input.allowPrivateNetwork});
    const url=new URL(metadata.authorization_endpoint);
    const params={response_type:'code',client_id:input.clientId,redirect_uri:this.callbackUrl,state,code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256',resource:input.resource,scope:(input.scopes??[]).join(' ')};
    for(const [key,value] of Object.entries(params)) url.searchParams.set(key,value);
    return {authorizationUrl:url.href,expiresAt:new Date(expires).toISOString()};
  }
  async callback(identityId: string,input:{state:string;code:string;issuer?:string}):Promise<{spaceId:string;serverId:string;secret:McpOAuthSecret}> {
    const pending=this.pending.get(input.state);
    if(!pending || pending.identityId!==identityId || pending.expires<Date.now())throw new Error('OAuth state invalid or expired');
    this.pending.delete(input.state); // one use even on provider failure
    if(input.issuer!==undefined && input.issuer!==pending.metadata.issuer)throw new Error('OAuth issuer mismatch');
    const secret=await tokenRequest(pending.metadata.token_endpoint,new URLSearchParams({grant_type:'authorization_code',code:input.code,code_verifier:pending.verifier,redirect_uri:pending.redirectUri,client_id:pending.clientId,resource:pending.resource}),pending.privateNetwork);
    return {spaceId:pending.spaceId,serverId:pending.serverId,secret:{kind:'oauth',...secret,issuer:pending.metadata.issuer,tokenEndpoint:pending.metadata.token_endpoint,resource:pending.resource,clientId:pending.clientId}};
  }
}
async function tokenRequest(url:string,body:URLSearchParams,privateNetwork:boolean):Promise<{accessToken:string;refreshToken?:string;expiresAt?:number}> {
  const response=await mcpHttp({url,method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:body.toString()},privateNetwork);
  if(response.status!==200)throw new Error('OAuth token exchange failed');
  let value: Record<string,unknown>;
  try {value=JSON.parse(response.body) as Record<string,unknown>;}catch{throw new Error('OAuth token exchange failed');}
  if(typeof value.access_token!=='string' || !value.access_token || typeof value.token_type!=='string' || value.token_type.toLowerCase()!=='bearer')throw new Error('OAuth token response invalid');
  return {accessToken:value.access_token,...(typeof value.refresh_token==='string'?{refreshToken:value.refresh_token}:{}),...(typeof value.expires_in==='number'?{expiresAt:Date.now()+value.expires_in*1000}:{})};
}
export async function refreshOAuth(secret:McpOAuthSecret,privateNetwork:boolean):Promise<McpOAuthSecret> {
  if(!secret.refreshToken)throw new Error('MCP OAuth account requires reconnect');
  const token=await tokenRequest(secret.tokenEndpoint,new URLSearchParams({grant_type:'refresh_token',refresh_token:secret.refreshToken,client_id:secret.clientId,resource:secret.resource}),privateNetwork);
  return {...secret,...token};
}
