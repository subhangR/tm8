import {
 CollabError, McpCredentialRotateInputSchema, McpCredentialCreateInputSchema, McpCredentialCommandInputSchema,
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
import { DbMcpOAuthPendingStore, McpOAuth, revokeOAuth, type McpOAuthPendingStore } from './oauth.js';
import { localKeyProvider, type KeyProvider } from '../credentials/key-provider.js';
import type { DbClaims } from '../db/types.js';
import { byteSize, mcpDenyReason, mcpToolName, recordMcpCall, type McpCallAuditEntry } from './audit.js';

export interface McpRuntimeHandlerOptions {
 dataDir:string; callbackUrl:string;
 /** Reads a preregistered OAuth client secret by its declared variable name. Defaults to process.env. */
 clientSecret?:(envName:string)=>string|undefined;
 definition(claims:DbClaims,serverId:string):Promise<McpServerView & {securityRevision?:number}>;
 authorize:McpProxyPorts['authorize'];
 recordTest?:(claims:DbClaims,serverId:string,result:unknown)=>Promise<void>;
 /** Pending sign-ins (§5.4). Defaults to Postgres; tests without a database pass their own. */
 oauthPending?:McpOAuthPendingStore;
 /** Seals pending sign-ins and connections. Defaults to the node-local key under dataDir. */
 keys?:KeyProvider;
}
export function registerMcpRuntimeHandlers(registry:HandlerRegistry,deps:FacadeDeps,options:McpRuntimeHandlerOptions):void {
 const keys=options.keys??localKeyProvider(options.dataDir);
 const credentials=new McpCredentialStore(deps.db,options.dataDir,keys);
 const store=new DbSpaceCredentialStore({db:deps.db,dataDir:options.dataDir});
 const oauth=new McpOAuth(options.callbackUrl,options.oauthPending??new DbMcpOAuthPendingStore(deps.db),keys);
 const definition=async(claims:DbClaims,id:string)=>{const view=await options.definition(claims,id);return {id:view.id,spaceId:view.spaceId,version:view.securityRevision ?? view.version,...view.definition};};
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
   // scope 'space' creates a Space-owned row; create_mcp_credential enforces the
   // admin rule itself (§5.2), so this handler never has to repeat it.
   const result=await credentials.create(auth,{spaceId:server.spaceId,serverId:server.id,label:input.label,expectedRevision:server.securityRevision,secret:{kind:'api_key',value:input.secret},
    ...(input.scope?{scope:input.scope}:{}),...(input.accountLabel?{accountLabel:input.accountLabel}:{})}) as {id:string};return view(auth,result.id);
  }),
  'mcp.credentials.rotate':requireHumanSession(async ctx=>{
   const input=McpCredentialRotateInputSchema.parse({...ctx.body as object,credentialId:path(ctx,'credentialId')});const auth=await claims(ctx);const current=await view(auth,input.credentialId);
   if(!current.manageable || current.authType!=='api_key')throw new CollabError('forbidden','Only the API key owner can rotate');
   const server=await approved(auth,current.serverId);await credentials.rotate(auth,{spaceId:server.spaceId,serverId:server.id,credentialId:current.id},input.secret);return view(auth,current.id);
  }),
  'mcp.credentials.list':async ctx=>{const auth=await claims(ctx);const id=path(ctx,'serverId');await options.definition(auth,id);return views(auth,id);},
  'mcp.credentials.readiness':async ctx=>view(await claims(ctx),path(ctx,'credentialId')),
  'mcp.credentials.revoke':requireHumanSession(async ctx=>{const input=McpCredentialCommandInputSchema.parse({...ctx.body as object,credentialId:path(ctx,'credentialId')});const auth=await claims(ctx);const current=await view(auth,input.credentialId);const server=await options.definition(auth,current.serverId);
   const opened=await credentials.read(auth,{spaceId:server.spaceId,serverId:server.id,credentialId:current.id}).catch(()=>null);
   await store.revoke(auth,input.credentialId);
   if(opened?.secret.kind==='oauth')await revokeOAuth(opened.secret,server.definition.allowPrivateNetwork===true).catch(()=>false);
   return view(auth,input.credentialId);}),
  'mcp.credentials.share':requireHumanSession(async ctx=>{
   const input=McpCredentialShareInputSchema.parse({...ctx.body as object,credentialId:path(ctx,'credentialId')});const auth=await claims(ctx);const current=await view(auth,input.credentialId);
   if(!current.manageable)throw new CollabError('forbidden','Only the account owner can share');
   if(current.ownerId===null)throw new CollabError('invalid_input','A Space connection is already shared with the whole Space; its visibility cannot be changed');
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
   // A Space connection is owned by nobody and is public by construction, so
   // set_space_credential_visibility refuses it (22023). An admin reads as
   // `manageable` on one, so without this the UI would offer unshare and then
   // surface an opaque invariant error. Revoking it is the real lever.
   if(current.ownerId===null)throw new CollabError('invalid_input','A Space connection cannot be unshared; revoke it instead');
   await store.setVisibility(auth,input.credentialId,'private');for(const share of await store.listShares(auth,input.credentialId))await store.unshare(auth,input.credentialId,share.granteeAccountId);return view(auth,input.credentialId);
  }),
  'mcp.oauth.begin':requireHumanSession(async ctx=>{
   const input=McpOAuthBeginInputSchema.parse({...ctx.body as object,serverId:path(ctx,'serverId')});const auth=await claims(ctx);const server=await approved(auth,input.serverId);const config=server.definition.auth;
   if(config.type!=='oauth2' || !server.definition.url || !auth.identityId)throw new CollabError('invalid_input','OAuth connector required');
   // Fail loud: without its secret a preregistered confidential client would be
   // sent as a public one and refused at the token endpoint, after the consent screen.
   const clientSecret=config.clientSecretEnv?(options.clientSecret??(name=>process.env[name]))(config.clientSecretEnv):undefined;
   if(config.clientSecretEnv && !clientSecret)throw new CollabError('invalid_input',`OAuth client secret is not configured on this server: set ${config.clientSecretEnv}`);
   return oauth.begin(auth,{spaceId:server.spaceId,serverId:server.id,definitionVersion:server.securityRevision ?? server.version,resource:server.definition.url,...(config.issuer?{issuer:config.issuer}:config.authorizationUrl?{issuer:new URL(config.authorizationUrl).origin}:{}),...(config.clientId?{clientId:config.clientId}:{}),...(clientSecret?{clientSecret}:{}),label:input.label,...(input.scope?{scope:input.scope}:{}),...(input.returnTo?{returnTo:input.returnTo}:{}),...(config.scopes?{scopes:config.scopes}:{}),allowPrivateNetwork:server.definition.allowPrivateNetwork===true});
  }),
  'mcp.oauth.callback':requireHumanSession(async ctx=>{
   const input=McpOAuthCallbackInputSchema.parse(ctx.body);const auth=await claims(ctx);if(!auth.identityId)throw new CollabError('unauthenticated','Human session required');
   // The state is consumed before this guard runs, so a changed connector spends it too.
   const result=await oauth.callback(auth,input,async pending=>{const current=await options.definition(auth,pending.serverId);if(pending.definitionVersion!==undefined && (current.securityRevision ?? current.version)!==pending.definitionVersion)throw new CollabError('conflict','MCP connector changed; restart authorization');})
    .catch(error=>{if(error instanceof Error && error.message==='OAuth state invalid or expired')throw new CollabError('invalid_input',error.message);throw error;});
   await approved(auth,result.serverId);
   // The scope chosen at begin rides the pending row; create_mcp_credential re-checks admin for 'space'.
   const created=await credentials.create(auth,{spaceId:result.spaceId,serverId:result.serverId,label:result.label,secret:result.secret,expectedRevision:result.definitionVersion,scope:result.scope,...(result.grantedScopes?{grantedScopes:result.grantedScopes}:{})}) as {id:string};
   const connected=await view(auth,created.id);return result.returnTo?{...connected,returnTo:result.returnTo}:connected;
  }),
  'mcp.servers.test':requireHumanSession(async ctx=>{
   const input=McpServerTestInputSchema.parse({...ctx.body as object,serverId:path(ctx,'serverId')});const auth=await claims(ctx);const server=await approved(auth,input.serverId);
   const test=new McpProxy({credentials,definition,authorize:async()=>({sessionId:'test',identityId:auth.identityId!,spaceId:server.spaceId,serverId:server.id,...(input.credentialId?{credentialId:input.credentialId}:{})})});
   let readiness='ready';
   if(server.definition.enabled===false)readiness='disabled';
   else if(server.definition.transport==='stdio' && !server.definition.stdioTrusted)readiness='stdio_not_trusted';
   else if(server.definition.auth.type!=='none')readiness=input.credentialId?(await deps.db.rpc<{reason:string}>(auth,'mcp_credential_readiness',[server.id,input.credentialId])).reason:'credential_required';
   let result;
   if(readiness!=='ready')result={ready:false,reason:readiness,tools:[],checkedAt:new Date().toISOString()};
   else try{const listed=await test.request(auth,'test',server.id,'tools/list') as {tools:unknown[]};result={ready:true,reason:'ready',tools:listed.tools,checkedAt:new Date().toISOString()};}catch{result={ready:false,reason:'server_unavailable',tools:[],checkedAt:new Date().toISOString()};}
   if(options.recordTest)await options.recordTest(auth,server.id,result);
   else await deps.db.rpc(auth,'record_mcp_server_health',[server.id,result]);return result;
  }),
  'mcp.proxy.request':async ctx=>{
   const input=McpProxyRequestInputSchema.parse({...ctx.body as object,sessionId:path(ctx,'sessionId'),serverId:path(ctx,'serverId')});const method=input.message.method;
   if(method!=='tools/list' && method!=='tools/call')throw new CollabError('invalid_input','Unsupported MCP method');
   const params=input.message.params;if(params!==undefined && (!params || typeof params!=='object' || Array.isArray(params)))throw new CollabError('invalid_input','Invalid MCP params');
   const runtimeId=ctx.identity.workSessionId??ctx.identity.runtimeChatId;
   const isRuntime=Boolean(ctx.identity.sessionId) && ['agent','agent_runtime'].includes(ctx.identity.authKind??'');
   const runtimeClaims={...await claims(ctx),authSessionId:ctx.identity.sessionId};
   /*
    * §5.6: EVERY call leaves a row, a refusal included, written under the
    * session's own runtime bearer (346's writer accepts no other). The row names
    * the tool and the sizes, never an argument or a result. Root and chain are
    * the grant's — what read_mcp_session_binding returned; a call refused before
    * there was a grant passes none and the writer reads the recorded binding.
    */
   const began=performance.now();
   const base={serverId:input.serverId,method,tool:mcpToolName(method,params),requestBytes:byteSize(params??{})} as const;
   const audit=(entry:Omit<McpCallAuditEntry,keyof typeof base|'sessionId'>&{sessionId?:string})=>
    recordMcpCall(deps.db,runtimeClaims,{...base,sessionId:input.sessionId,latencyMs:performance.now()-began,...entry});
   // A refusal's row must never replace the refusal itself.
   const auditRefusal=(entry:Parameters<typeof audit>[0])=>audit(entry).catch(error=>{console.warn(`mcp audit: could not record a ${entry.outcome} call: ${String(error)}`);});
   if(!isRuntime || runtimeId!==input.sessionId) {
    // A runtime bearer naming another session is recorded against its OWN
    // session: that is the only session this bearer can write rows for.
    if(isRuntime && runtimeId)await auditRefusal({sessionId:runtimeId,outcome:'denied',denyReason:'session_mismatch'});
    throw new CollabError('forbidden','MCP session bearer mismatch');
   }
   let grant;
   try {grant=await options.authorize(runtimeClaims,input.sessionId,input.serverId);}
   catch(error){await auditRefusal({outcome:'denied',denyReason:mcpDenyReason(error)??'forbidden'});throw error;}
   await audit({outcome:'started',grant});
   let result;
   try {result=await proxy.request(runtimeClaims,input.sessionId,input.serverId,method,(params??{}) as Record<string,unknown>);}
   catch(error){
    // The proxy re-authorizes before every send, so access lost mid-call is a
    // refusal too; anything else (the provider, the network) is a failure.
    const denyReason=mcpDenyReason(error);
    await auditRefusal(denyReason?{outcome:'denied',grant,denyReason}:{outcome:'failed',grant});throw error;
   }
   await audit({outcome:'succeeded',grant,responseBytes:byteSize(result)});return result;
  },
 });
}
