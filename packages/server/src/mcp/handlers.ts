import {
 CollabError, McpCredentialRotateInputSchema, McpCredentialCreateInputSchema, McpCredentialCommandInputSchema,
 McpCredentialShareInputSchema, McpOAuthBeginInputSchema, McpOAuthCallbackInputSchema,
 McpServerTestInputSchema, McpProxyRequestInputSchema, type McpCredentialView, type McpServerDefinition, type McpServerView,
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
import { byteSize, mcpDenyReason, mcpToolName, recordMcpCall, recordMcpCallSafely, recordMcpTestCall, recordMcpTestCallSafely, type McpCallAuditEntry, type McpTestAuditEntry } from './audit.js';
import { GOOGLE_OAUTH_ISSUER } from '@tm8/contract';
import { GoogleFirstPartyHost, googleScopesFor } from './first-party/google/host.js';
import { GOOGLE_NOT_CONFIGURED, type GoogleHostOptions } from './first-party/google/endpoints.js';
import { FirstPartyRefused } from './first-party/host.js';
import { createMcpEndpointRoute, type McpEndpointRoute } from './endpoint.js';

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
 /** The Google first-party host (§8.1). Defaults to Google's endpoints with no client configured. */
 google?:GoogleHostOptions;
 /**
  * §7.1 / G14: receives the `POST /mcp` route for the HTTP server to mount, built
  * from the very same proxy ports as `mcp.proxy.request` — one credential
  * reader, one definition reader, one first-party host. A second set would be a
  * second place for the access rule to be subtly different.
  *
  * Absent (every test that does not need it) simply mounts no endpoint, and an
  * MCP token then resolves nowhere at all.
  */
 onEndpoint?(route:McpEndpointRoute):void;
 /** The body cap the endpoint reads under; defaults to the frame's 1 MiB. */
 maxBodyBytes?:number;
}
export function registerMcpRuntimeHandlers(registry:HandlerRegistry,deps:FacadeDeps,options:McpRuntimeHandlerOptions):void {
 const keys=options.keys??localKeyProvider(options.dataDir);
 const credentials=new McpCredentialStore(deps.db,options.dataDir,keys);
 const store=new DbSpaceCredentialStore({db:deps.db,dataDir:options.dataDir});
 const oauth=new McpOAuth(options.callbackUrl,options.oauthPending??new DbMcpOAuthPendingStore(deps.db),keys);
 /**
  * S10/S12, B44: how many tools each connection CANNOT use for want of a
  * granted scope, so the Connectors page can draw the amber "Limited access"
  * badge on the row instead of only in the drawer.
  *
  * It reads the STORED plain `granted_scopes` the list already returns and the
  * first-party host's own tool→scope map. No decrypt (nothing here needs a
  * token), and no copy of the map in SQL — the host is the one place a tool's
  * scopes are stated, and a second copy would drift the moment a tool changed.
  *
  * NULL for a connector no host serves: a relayed connector's map lives at the
  * provider, so tm8 genuinely cannot say, and 0 would claim full coverage. A
  * definition the host refuses (a first-party flag with the wrong URL) is left
  * null for the same reason, which is also why the throw is caught rather than
  * surfaced: this is an annotation on a read, never its authority.
  */
 const limitedAccess=(definition:McpServerDefinition,rows:McpCredentialView[]):McpCredentialView[]=>{
  // The SAME predicate the proxy routes on, narrowed by identity: only the
  // Google host knows a tool's scopes, so only it can answer this.
  if(firstParty(definition)!==google)return rows;
  return rows.map(row=>{
   // An API-key connection has no OAuth grant to be partial, and a row that is
   // already revoked or pending has no coverage to report.
   if(row.authType!=='oauth2'||row.revoked||row.status==='pending')return row;
   try{return {...row,unavailableToolCount:host.uncovered(definition,row.grantedScopes).length};}
   catch{return row;}
  });
 };
 const definition=async(claims:DbClaims,id:string)=>{const view=await options.definition(claims,id);return {id:view.id,spaceId:view.spaceId,version:view.securityRevision ?? view.version,...view.definition};};
 const google=new GoogleFirstPartyHost(options.google??{client:()=>undefined});
 // §8.1: every first-party connector today is Google's; anything else is served by no host.
 const firstParty:McpProxyPorts['firstParty']=value=>value.catalogId?.startsWith('google.')?google:undefined;
 const proxy=new McpProxy({credentials,authorize:options.authorize,definition,firstParty});
 // §7.1: the remote endpoint is NOT a catalog operation — it authenticates its
 // own bearer, which every other transport refuses — so it is handed to the
 // HTTP frame as a route instead of being registered here.
 options.onEndpoint?.(createMcpEndpointRoute({db:deps.db,credentials,definition,firstParty,
  maxBodyBytes:options.maxBodyBytes ?? 1024*1024}));
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
  'mcp.credentials.list':async ctx=>{const auth=await claims(ctx);const id=path(ctx,'serverId');const server=await options.definition(auth,id);return limitedAccess(server.definition,await views(auth,id));},
  'mcp.credentials.readiness':async ctx=>view(await claims(ctx),path(ctx,'credentialId')),
  'mcp.credentials.revoke':requireHumanSession(async ctx=>{const input=McpCredentialCommandInputSchema.parse({...ctx.body as object,credentialId:path(ctx,'credentialId')});const auth=await claims(ctx);const current=await view(auth,input.credentialId);const server=await options.definition(auth,current.serverId);
   const opened=await credentials.read(auth,{spaceId:server.spaceId,serverId:server.id,credentialId:current.id}).catch(()=>null);
   await store.revoke(auth,input.credentialId);
   // NOT for a Google connection (B39): Gmail, Calendar and Drive of one Google
   // account are ONE grant on tm8's client (include_granted_scopes), and Google's
   // revoke ends that whole grant, silently breaking the same account's other
   // connections. Keyed on the STORED secret, never the live definition, so an
   // edit to the definition cannot turn a disconnect into a whole-account
   // revoke. (A first-party secret also carries no revocation endpoint.) The
   // local row keeps no ciphertext; the owner removes tm8 entirely at Google.
   if(opened?.secret.kind==='oauth' && opened.secret.issuer!==GOOGLE_OAUTH_ISSUER)await revokeOAuth(opened.secret,server.definition.allowPrivateNetwork===true).catch(()=>false);
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
   if(server.definition.firstParty===true) {
    // §8.1: Google's own begin — static endpoints and the node's client, never
    // discovery, and nothing from the definition but which service it is.
    let provider;
    try {provider=google.authorization(server.definition);}
    catch(error) {
     if(error instanceof FirstPartyRefused)throw new CollabError('invalid_input','First-party connector unavailable on this server');
     if(error instanceof Error && error.message===GOOGLE_NOT_CONFIGURED)throw new CollabError('invalid_input',GOOGLE_NOT_CONFIGURED);
     throw error;
    }
    return oauth.beginFirstParty(auth,{spaceId:server.spaceId,serverId:server.id,definitionVersion:server.securityRevision ?? server.version,resource:server.definition.url,label:input.label,...(input.scope?{scope:input.scope}:{}),...(input.returnTo?{returnTo:input.returnTo}:{})},provider);
   }
   // Fail loud: without its secret a preregistered confidential client would be
   // sent as a public one and refused at the token endpoint, after the consent screen.
   const clientSecret=config.clientSecretEnv?(options.clientSecret??(name=>process.env[name]))(config.clientSecretEnv):undefined;
   if(config.clientSecretEnv && !clientSecret)throw new CollabError('invalid_input',`OAuth client secret is not configured on this server: set ${config.clientSecretEnv}`);
   return oauth.begin(auth,{spaceId:server.spaceId,serverId:server.id,definitionVersion:server.securityRevision ?? server.version,resource:server.definition.url,...(config.issuer?{issuer:config.issuer}:config.authorizationUrl?{issuer:new URL(config.authorizationUrl).origin}:{}),...(config.clientId?{clientId:config.clientId}:{}),...(clientSecret?{clientSecret}:{}),label:input.label,...(input.scope?{scope:input.scope}:{}),...(input.returnTo?{returnTo:input.returnTo}:{}),...(config.scopes?{scopes:config.scopes}:{}),allowPrivateNetwork:server.definition.allowPrivateNetwork===true});
  }),
  'mcp.oauth.callback':requireHumanSession(async ctx=>{
   const input=McpOAuthCallbackInputSchema.parse(ctx.body);const auth=await claims(ctx);if(!auth.identityId)throw new CollabError('unauthenticated','Human session required');
   // The state is consumed before this guard runs, so a changed connector spends it too.
   const result=await oauth.callback(auth,input,async pending=>{const current=await options.definition(auth,pending.serverId);if(pending.definitionVersion!==undefined && (current.securityRevision ?? current.version)!==pending.definitionVersion)throw new CollabError('conflict','MCP connector changed; restart authorization');},
    // A first-party connect's client secret is read from configuration NOW; the pending row never held it.
    ()=>google.oauthClient())
    .catch(error=>{if(error instanceof Error && [GOOGLE_NOT_CONFIGURED,'OAuth state invalid or expired'].includes(error.message))throw new CollabError('invalid_input',error.message);throw error;});
   const server=await approved(auth,result.serverId);
   const firstParty=server.definition.firstParty===true;
   // §5.2: a first-party connection is labelled with the Google account it acts as.
   const accountLabel=firstParty?await google.accountLabel(result.secret.accessToken):undefined;
   // Google reports the account's WHOLE grant (include_granted_scopes); the row
   // records only this connector's part of it, never another connector's access.
   const grantedScopes=firstParty?googleScopesFor(google.service(server.definition),result.grantedScopes):result.grantedScopes;
   // The scope chosen at begin rides the pending row; create_mcp_credential re-checks admin for 'space'.
   const created=await credentials.create(auth,{spaceId:result.spaceId,serverId:result.serverId,label:result.label,secret:result.secret,expectedRevision:result.definitionVersion,scope:result.scope,...(grantedScopes?.length?{grantedScopes}:{}),...(accountLabel?{accountLabel}:{})}) as {id:string};
   // Granular consent can leave a connector with NO usable tool (every API
   // scope unticked). That connection is stored but marked, so the UI says
   // Reconnect rather than showing an empty connector. A partial grant stays
   // active with the tools its scopes cover.
   if(firstParty && google.tools(server.definition,result.secret.grantedScopes).length===0)
    await deps.db.rpc(auth,'mark_mcp_credential_needs_reconnect',[result.spaceId,result.serverId,created.id,'scope_reduced']);
   const connected=await view(auth,created.id);return result.returnTo?{...connected,returnTo:result.returnTo}:connected;
  }),
  'mcp.servers.test':requireHumanSession(async ctx=>{
   const input=McpServerTestInputSchema.parse({...ctx.body as object,serverId:path(ctx,'serverId')});const auth=await claims(ctx);const server=await approved(auth,input.serverId);
   const test=new McpProxy({credentials,definition,firstParty,authorize:async()=>({sessionId:'test',identityId:auth.identityId!,spaceId:server.spaceId,serverId:server.id,...(input.credentialId?{credentialId:input.credentialId}:{})})});
   let readiness='ready';
   if(server.definition.enabled===false)readiness='disabled';
   else if(server.definition.transport==='stdio' && !server.definition.stdioTrusted)readiness='stdio_not_trusted';
   else if(server.definition.auth.type!=='none')readiness=input.credentialId?(await deps.db.rpc<{reason:string}>(auth,'mcp_credential_readiness',[server.id,input.credentialId])).reason:'credential_required';
   /*
    * §7.5/B51 (359): a test uses the stored credential too, so it is audited
    * like any proxied call, via='test' with the caller as root. A test refused
    * before it reached the provider is `denied` with its readiness reason; the
    * `started` row fails closed (nothing has been sent yet), every later row is
    * written safely so it never replaces the test's own result.
    */
   const began=performance.now();
   const testRow=(entry:Pick<McpTestAuditEntry,'outcome'|'denyReason'|'responseBytes'>):McpTestAuditEntry=>
    ({serverId:server.id,credentialId:input.credentialId??null,latencyMs:performance.now()-began,requestBytes:byteSize({}),...entry});
   let result;
   if(readiness!=='ready'){
    await recordMcpTestCallSafely(deps.db,auth,testRow({outcome:'denied',denyReason:readiness}));
    result={ready:false,reason:readiness,tools:[],checkedAt:new Date().toISOString()};
   }
   else {
    await recordMcpTestCall(deps.db,auth,testRow({outcome:'started'}));
    try{
     const listed=await test.request(auth,'test',server.id,'tools/list') as {tools:unknown[]};
     await recordMcpTestCallSafely(deps.db,auth,testRow({outcome:'succeeded',responseBytes:byteSize(listed)}));
     result={ready:true,reason:'ready',tools:listed.tools,checkedAt:new Date().toISOString()};
    }catch(error){
     const denyReason=mcpDenyReason(error);
     await recordMcpTestCallSafely(deps.db,auth,testRow(denyReason?{outcome:'denied',denyReason}:{outcome:'failed'}));
     result={ready:false,reason:'server_unavailable',tools:[],checkedAt:new Date().toISOString()};
    }
   }
   // B41: a partial Google grant stays usable with fewer tools; say which are missing and which scope would restore each.
   if(result.ready && server.definition.firstParty===true && input.credentialId) {
    const opened=await credentials.read(auth,{spaceId:server.spaceId,serverId:server.id,credentialId:input.credentialId});
    const unavailableTools=opened.secret.kind==='oauth'?google.uncovered(server.definition,opened.secret.grantedScopes):[];
    if(unavailableTools.length)result={...result,unavailableTools};
   }
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
   type Entry=Omit<McpCallAuditEntry,keyof typeof base|'sessionId'>&{sessionId?:string};
   const row=(entry:Entry):McpCallAuditEntry=>({...base,sessionId:input.sessionId,latencyMs:performance.now()-began,...entry});
   // `started` is the one write that may fail the call: it runs BEFORE anything
   // reaches the provider, so failing closed there costs nothing.
   const audit=(entry:Entry)=>recordMcpCall(deps.db,runtimeClaims,row(entry));
   // Every later row is written safely: a refusal's row must never replace the
   // refusal, and a succeeded row must never turn a call the provider already
   // acted on into an error the caller might retry (a second email).
   const auditAfter=(entry:Entry)=>recordMcpCallSafely(deps.db,runtimeClaims,row(entry));
   if(!isRuntime || runtimeId!==input.sessionId) {
    // A runtime bearer naming another session is recorded against its OWN
    // session: that is the only session this bearer can write rows for.
    if(isRuntime && runtimeId)await auditAfter({sessionId:runtimeId,outcome:'denied',denyReason:'session_mismatch'});
    throw new CollabError('forbidden','MCP session bearer mismatch');
   }
   let grant;
   try {grant=await options.authorize(runtimeClaims,input.sessionId,input.serverId);}
   catch(error){await auditAfter({outcome:'denied',denyReason:mcpDenyReason(error)??'forbidden'});throw error;}
   await audit({outcome:'started',grant});
   let result;
   try {result=await proxy.request(runtimeClaims,input.sessionId,input.serverId,method,(params??{}) as Record<string,unknown>);}
   catch(error){
    // The proxy re-authorizes before every send, so access lost mid-call is a
    // refusal too; anything else (the provider, the network) is a failure.
    const denyReason=mcpDenyReason(error);
    await auditAfter(denyReason?{outcome:'denied',grant,denyReason}:{outcome:'failed',grant});throw error;
   }
   await auditAfter({outcome:'succeeded',grant,responseBytes:byteSize(result)});return result;
  },
 });
}
