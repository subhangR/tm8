import {
 CollabError, McpCredentialCreateInputSchema, McpCredentialCommandInputSchema,
 McpCredentialShareInputSchema, McpOAuthBeginInputSchema, McpOAuthCallbackInputSchema,
 McpServerTestInputSchema, McpProxyRequestInputSchema, type McpCredentialView, type McpServerView,
} from '@tm8/contract';
import type { FacadeDeps } from '../facade/deps.js';
import type { HandlerRegistry } from '../facade/registry.js';
import { claimsFor } from '../facade/context.js';
import type { RequestContext } from '../http/types.js';
import { requireHumanSession } from '../facade/handlers/w2/credentials.js';
import { DbSpaceCredentialStore } from '../credentials/space-credential-store.js';
import { McpCredentialStore } from './credential-store.js';
import { McpProxy, type McpProxyPorts } from './proxy.js';
import { McpOAuth } from './oauth.js';
import type { DbClaims } from '../db/types.js';

export interface McpRuntimeHandlerOptions {
 dataDir:string; callbackUrl:string;
 definition(claims:DbClaims,serverId:string):Promise<McpServerView>;
 authorize:McpProxyPorts['authorize'];
 recordTest?:(claims:DbClaims,serverId:string,result:unknown)=>Promise<void>;
}
export function registerMcpRuntimeHandlers(registry:HandlerRegistry,deps:FacadeDeps,options:McpRuntimeHandlerOptions):void {
 const credentials=new McpCredentialStore(deps.db,options.dataDir);
 const store=new DbSpaceCredentialStore({db:deps.db,dataDir:options.dataDir});
 const oauth=new McpOAuth(options.callbackUrl);
 const definition=async(claims:DbClaims,id:string)=>{const view=await options.definition(claims,id);return {id:view.id,spaceId:view.spaceId,...view.definition};};
 const proxy=new McpProxy({credentials,authorize:options.authorize,definition});
 const claims=async(ctx:RequestContext)=>claimsFor(await deps.owner(),ctx);
 const path=(ctx:RequestContext,name:string)=>{const value=ctx.params[name];if(!value)throw new CollabError('invalid_input',`${name} required`);return value;};
 const views=(auth:DbClaims,serverId:string|null,id:string|null=null)=>deps.db.rpc<McpCredentialView[]>(auth,'list_mcp_credentials',[serverId,id]);
 const view=async(auth:DbClaims,id:string)=>{const row=(await views(auth,null,id))[0];if(!row)throw new CollabError('not_found','MCP account unavailable');return row;};
 const approved=async(auth:DbClaims,id:string)=>{const server=await options.definition(auth,id);if(!server.definition.approved)throw new CollabError('forbidden','MCP connector is not approved');return server;};
 registry.registerAll({
  'mcp.credentials.create':requireHumanSession(async ctx=>{
   const input=McpCredentialCreateInputSchema.parse({...ctx.body as object,serverId:path(ctx,'serverId')});const auth=await claims(ctx);const server=await approved(auth,input.serverId);
   if(server.definition.auth.type!=='api_key')throw new CollabError('invalid_input','Connector requires OAuth');
   const result=await credentials.create(auth,{spaceId:server.spaceId,serverId:server.id,label:input.label,secret:{kind:'api_key',value:input.secret}}) as {id:string};return view(auth,result.id);
  }),
  'mcp.credentials.list':async ctx=>{const auth=await claims(ctx);const id=path(ctx,'serverId');await options.definition(auth,id);return views(auth,id);},
  'mcp.credentials.readiness':async ctx=>view(await claims(ctx),path(ctx,'credentialId')),
  'mcp.credentials.revoke':requireHumanSession(async ctx=>{const input=McpCredentialCommandInputSchema.parse({...ctx.body as object,credentialId:path(ctx,'credentialId')});const auth=await claims(ctx);await view(auth,input.credentialId);await store.revoke(auth,input.credentialId);return view(auth,input.credentialId);}),
  'mcp.credentials.share':requireHumanSession(async ctx=>{
   const input=McpCredentialShareInputSchema.parse({...ctx.body as object,credentialId:path(ctx,'credentialId')});const auth=await claims(ctx);const current=await view(auth,input.credentialId);
   if(!current.manageable)throw new CollabError('forbidden','Only the account owner can share');
   // Narrow first; if any later grant fails, no unintended public access remains.
   await store.setVisibility(auth,input.credentialId,'private');
   for(const share of await store.listShares(auth,input.credentialId))await store.unshare(auth,input.credentialId,share.granteeAccountId);
   if(input.visibility==='selected')for(const id of input.memberIds)await store.share(auth,input.credentialId,id);
   if(input.visibility==='space')await store.setVisibility(auth,input.credentialId,'public');
   return view(auth,input.credentialId);
  }),
  'mcp.credentials.unshare':requireHumanSession(async ctx=>{
   const input=McpCredentialCommandInputSchema.parse({...ctx.body as object,credentialId:path(ctx,'credentialId')});const auth=await claims(ctx);const current=await view(auth,input.credentialId);
   if(!current.manageable)throw new CollabError('forbidden','Only the account owner can share');
   await store.setVisibility(auth,input.credentialId,'private');for(const share of await store.listShares(auth,input.credentialId))await store.unshare(auth,input.credentialId,share.granteeAccountId);return view(auth,input.credentialId);
  }),
  'mcp.oauth.begin':requireHumanSession(async ctx=>{
   const input=McpOAuthBeginInputSchema.parse({...ctx.body as object,serverId:path(ctx,'serverId')});const auth=await claims(ctx);const server=await approved(auth,input.serverId);const config=server.definition.auth;
   if(config.type!=='oauth2' || !server.definition.url || !auth.identityId)throw new CollabError('invalid_input','OAuth connector required');
   return oauth.begin({identityId:auth.identityId,spaceId:server.spaceId,serverId:server.id,resource:server.definition.url,...(config.authorizationUrl?{issuer:new URL(config.authorizationUrl).origin}:{}),...(config.clientId?{clientId:config.clientId}:{}),label:input.label,scopes:config.scopes,allowPrivateNetwork:server.definition.allowPrivateNetwork===true});
  }),
  'mcp.oauth.callback':requireHumanSession(async ctx=>{const input=McpOAuthCallbackInputSchema.parse(ctx.body);const auth=await claims(ctx);if(!auth.identityId)throw new CollabError('unauthenticated','Human session required');const result=await oauth.callback(auth.identityId,input);await approved(auth,result.serverId);const created=await credentials.create(auth,{...result}) as {id:string};return view(auth,created.id);}),
  'mcp.servers.test':requireHumanSession(async ctx=>{
   const input=McpServerTestInputSchema.parse({...ctx.body as object,serverId:path(ctx,'serverId')});const auth=await claims(ctx);const server=await approved(auth,input.serverId);
   const test=new McpProxy({credentials,definition,authorize:async()=>({sessionId:'test',identityId:auth.identityId!,spaceId:server.spaceId,serverId:server.id,...(input.credentialId?{credentialId:input.credentialId}:{})})});
   let result;try{const listed=await test.request(auth,'test',server.id,'tools/list') as {tools:unknown[]};result={ready:true,reason:'ready',tools:listed.tools,checkedAt:new Date().toISOString()};}catch{result={ready:false,reason:'server_unavailable',tools:[],checkedAt:new Date().toISOString()};}
   await options.recordTest?.(auth,server.id,result);return result;
  }),
  'mcp.proxy.request':async ctx=>{
   const input=McpProxyRequestInputSchema.parse({...ctx.body as object,sessionId:path(ctx,'sessionId'),serverId:path(ctx,'serverId')});const method=input.message.method;
   if(method!=='tools/list' && method!=='tools/call')throw new CollabError('invalid_input','Unsupported MCP method');
   const params=input.message.params;if(params!==undefined && (!params || typeof params!=='object' || Array.isArray(params)))throw new CollabError('invalid_input','Invalid MCP params');
   return proxy.request(await claims(ctx),input.sessionId,input.serverId,method,(params??{}) as Record<string,unknown>);
  },
 });
}
