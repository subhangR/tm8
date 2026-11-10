import { CollabError, McpTestResultSchema, McpServerDefinitionSchema, McpResolveInputSchema, McpServerCreateInputSchema,
  McpServerUpdateInputSchema, McpServerDeleteInputSchema, McpServerImportInputSchema, McpServerRequestInputSchema,
  McpSessionProvenanceSchema,
  MCP_CATALOG, mcpCatalogEntry,
  type McpServerView, type McpResolveInput, type McpResolveResult, type McpResolvedSelection, type McpSelection,
  type McpSkippedSelection, type McpCredentialSource, type McpReadinessReason,
  type McpCatalogEntry, type McpCatalogAdded, type McpServerDefinition } from '@tm8/contract';
import type { Querier } from '../db/types.js';
import type { FacadeDeps } from '../facade/deps.js';
import type { HandlerRegistry } from '../facade/registry.js';
import { claimsFor, commandEnvelope, requireUuidParam, optionalUuid, limitOf } from '../facade/context.js';
import { requireHumanSession } from '../facade/handlers/w2/credentials.js';
import { encodeCursor, decodeCursor } from '@tm8/contract';

type DefinitionRow = { id: string; space_id: string; version: number; security_revision?: number; definition: unknown; member: boolean; health?: unknown };
const SELECT = `select e.id,e.space_id,e.version,m.mcp_security_revision as security_revision,m.definition,internal.is_space_member(e.space_id) as member,
  (select h.result from public.mcp_server_health h where h.server_id=e.id and h.member_id=internal.current_member_id(e.space_id) and h.definition_version=e.version) as health
  from public.entities e join public.mcp_servers m on m.entity_id=e.id
  where e.kind='mcp_server' and e.deleted_at is null`;

export async function canAttachMcp(q: Querier, spaceId: string, targetId?: string): Promise<boolean> {
  if (!targetId) return false;
  const rows = await q.query<{ allowed: boolean }>(`select internal.is_space_member($2::uuid) and exists(select 1 from public.entities where id=$1 and space_id=$2
    and internal.entity_readable(id) and deleted_at is null) as allowed`, [targetId,spaceId]);
  return rows[0]?.allowed === true;
}
function view(row: DefinitionRow, attach: boolean): McpServerView & {securityRevision?:number} {
  const definition=McpServerDefinitionSchema.parse(row.definition);
  return { id:row.id, spaceId:row.space_id, version:row.version, ...(row.security_revision !== undefined ? {securityRevision:Number(row.security_revision)} : {}), definition, ...(row.health ? {health:McpTestResultSchema.parse(row.health)} : {}),
    // 405: there is no approval step, so any member registers and manages.
    allowed:{register:row.member,approve:row.member,manage:row.member,attach:attach && definition.approved && definition.enabled !== false} };
}
function publicView(server: McpServerView & {securityRevision?:number}): McpServerView {
  const {securityRevision: _securityRevision, ...publicServer}=server;
  return publicServer;
}
export async function loadMcpServer(q: Querier, serverId: string, targetId?: string): Promise<McpServerView & {securityRevision:number}> {
  const [row]=await q.query<DefinitionRow>(`${SELECT} and e.id=$1`,[serverId]);
  if (!row) throw new CollabError('not_found','MCP connector is unavailable');
  const loaded=view(row,await canAttachMcp(q,row.space_id,targetId));
  if (loaded.securityRevision === undefined) throw new CollabError('upstream_unavailable','MCP security revision unavailable');
  return loaded as McpServerView & {securityRevision:number};
}
/**
 * The definition a CATALOG request carries. Taken from the catalog, never from
 * the member's body, so "please add Slack" cannot arrive pointing somewhere
 * else — and so a request body for a catalog entry is one id, with nothing in
 * it a reviewer has to read closely.
 *
 * No narrowing is needed on the way through: `McpCatalogEntrySchema` already
 * holds every entry to an unapproved https definition that names no server
 * secret variable and ships every gate closed, which is what
 * `internal.mcp_definition_is_request` admits for a catalog request (349 lets
 * a first-party entry carry the `firstParty` flag and closed `gates` its
 * catalog row fixes).
 */
function catalogRequestDefinition(catalogId:string):McpServerDefinition {
  const entry=mcpCatalogEntry(catalogId);
  if(!entry)throw new CollabError('not_found','Unknown connector catalog entry');
  if(!entry.available || !entry.definition)throw new CollabError('invalid_input',`${entry.title} is not available yet`);
  return entry.definition;
}
export type McpCredentialReadiness = (selection:McpSelection,server:McpServerView)=>Promise<McpReadinessReason>;
/** What `resolve_mcp_account` (migration 341) answers: §3's order below the pin. */
interface ResolvedAccount {
  credentialId?:string; scope?:'member'|'space'; source?:Exclude<McpCredentialSource,'pinned'>;
  unusable?:{credentialId:string;reason:McpReadinessReason};
}
export interface McpResolveOptions {
  /** Server-derived session/chat subjects; separate from the public 32-target budget. */
  contextTargetIds?: string[];
  credentialReady?:McpCredentialReadiness;
  /**
   * §6's provenance root, ALWAYS derived by the server — it is a parameter and
   * never a field of `McpResolveInput`, so it cannot arrive in a request body.
   * Absent means "the claims in force", which is what bind and authorize supply
   * today by running resolution under the launcher's claims. t-provenance
   * supplies the chain root here without this resolver changing shape.
   */
  rootMemberId?:string;
  /**
   * Refuse to infer an account: only a pinned `credentialId` counts. `authorize`
   * sets it so a live session re-checks the EXACT row `bind` wrote and can never
   * re-pick a different connection mid-session.
   */
  pinnedOnly?:boolean;
  /**
   * §6.1, B17/B19: NO HUMAN IS PROVABLY BEHIND THIS LAUNCH, so no connector that
   * needs an account may be lent to it.
   *
   * The caller decides this, because only the caller can see the bearer facts
   * §6 admits: a human bearer is a root, an agent bearer hops to its own
   * session's binding root, and anything else — the in-process loop executor,
   * which spawns under the node's LOOPBACK OWNER with no `authKind` at all, or a
   * legacy chat whose `requesterAuthKind` was never recorded — has no root.
   *
   * Without this, 341's `resolve_mcp_account` tier 1 searches "the root's own
   * connection" under the claims in force, and for the loop shape those claims
   * are the NODE OWNER's: any member's schedule could reach the node owner's
   * personal Gmail. So the account is never even resolved here; a pinned
   * `credentialId` is refused too, since the pin is the caller's assertion and
   * the whole point is that this caller cannot vouch for one.
   *
   * It is a READINESS reason, not an exception, so the two existing rules apply
   * unchanged and uniformly to all three sources: a `defaultOn` or `equips`
   * default is dropped into `skipped`, and an EXPLICIT selection stays in
   * `selections` with `ready:false` so `bind` refuses the launch out loud.
   */
  noHumanRoot?:boolean;
}
/** A default is weaker than any `equips` attachment, however distant. */
const DEFAULT_ON_DEPTH=1_000_000;
/**
 * Caller-readable same-space attachments, plus `defaultOn` connectors (§7.3).
 *
 * TWO THINGS ARE NEW HERE versus "never infers an account" (G15):
 *  - a connector with no pinned account resolves one through §3's order
 *    (pinned -> the root's personal -> the Space's shared), and
 *  - a connector that came from the DEFAULT set and is not ready is reported in
 *    `skipped` and dropped, instead of failing the whole launch. An EXPLICIT
 *    selection that is not ready still lands in `selections` with ready:false,
 *    so asking for something unusable by name is still an error.
 */
export async function resolveMcpSelections(q:Querier,input:McpResolveInput,options?:McpResolveOptions|McpCredentialReadiness):Promise<McpResolveResult> {
  const {credentialReady,rootMemberId,pinnedOnly,noHumanRoot,contextTargetIds}=typeof options==='function'
    ?{credentialReady:options,rootMemberId:undefined,pinnedOnly:undefined,noHumanRoot:undefined,contextTargetIds:undefined}:(options??{});
  const checked=McpResolveInputSchema.parse(input);
  let selections=checked.mcpSelections;
  const fromDefaults=selections===undefined;
  const skipped:McpSkippedSelection[]=[];
  if (selections===undefined) {
    if ((contextTargetIds?.length ?? 0)>34) throw new CollabError('invalid_input','MCP context exceeds the subject bound');
    const sources=[...new Set([...(contextTargetIds??[]),...(checked.targetIds??[]),...(checked.teamMemberId?[checked.teamMemberId]:[])])];
    // Validate every supplied target rather than silently resolving a partial set.
    for (const id of sources) if (!await canAttachMcp(q,checked.spaceId,id)) throw new CollabError('forbidden','MCP defaults target is unavailable');
    const lineage=await q.query<{id:string;parent_id:string|null;depth:number;path:string[]}>(`with recursive lineage as (
      select e.id,e.parent_id,0 as depth,array[e.id] as path from public.entities e
      where e.id=any($1::uuid[]) and e.space_id=$2 and e.deleted_at is null and internal.entity_readable(e.id)
      union all
      select p.id,p.parent_id,l.depth+1,l.path||p.id from lineage l join public.entities p on p.id=l.parent_id
      where p.space_id=$2 and p.deleted_at is null and internal.entity_readable(p.id) and l.depth<16 and not p.id=any(l.path)
    ) select id,parent_id,depth,path from lineage limit 1025`,[sources,checked.spaceId]);
    if(lineage.length>1024 || lineage.some(row=>row.parent_id && (row.path.includes(row.parent_id) || row.depth===16))) {
      throw new CollabError('invalid_input','MCP default ancestry exceeds the depth or cycle bound');
    }
    const depths=new Map<string,number>();
    for(const row of lineage)depths.set(row.id,Math.min(depths.get(row.id)??Infinity,row.depth));
    const rows=await q.query<{server_id:string;source_id:string;name:string}>(`select g.dst_id as server_id,g.src_id as source_id,m.definition->>'name' as name
      from public.edges g join public.entities d on d.id=g.dst_id join public.mcp_servers m on m.entity_id=d.id
      where g.type='equips' and g.src_id=any($1::uuid[]) and g.space_id=$2 and d.kind='mcp_server'
      and d.deleted_at is null order by g.dst_id,g.src_id limit 1025`,[[...depths.keys()],checked.spaceId]);
    if(rows.length>1024)throw new CollabError('invalid_input','Too many MCP default attachments');
    const nearest=new Map<string,{serverId:string;depth:number}>();
    // B9. A definition with no `name` cannot be loaded, named or collision-
    // checked, so it is dropped from the DEFAULT set and REPORTED — never
    // silently, and never for an explicit selection, which still refuses in
    // loadMcpServer because McpServerDefinitionSchema requires a name.
    // `definition->>'name'` yields NULL instead of raising, and one malformed
    // row must not crash every launch in the Space. Unreachable through any
    // supported write: internal.validate_mcp_definition demands a name.
    const unnamed=(serverId:string)=>{skipped.push({serverId,name:'',reason:'invalid_definition'});};
    for(const row of rows){
      const depth=depths.get(row.source_id);if(depth===undefined)continue;
      if(!row.name){unnamed(row.server_id);continue;}
      const name=row.name.toLowerCase(),previous=nearest.get(name);
      if(previous && previous.depth===depth && previous.serverId!==row.server_id)throw new CollabError('invalid_input','MCP connector name collision at the same attachment depth');
      if(!previous||depth<previous.depth)nearest.set(name,{serverId:row.server_id,depth});
    }
    // §7.3: the default set is `defaultOn` UNION the `equips` lineage. An
    // attachment at any depth beats a space-wide default of the same name.
    const defaultOn=await q.query<{server_id:string;name:string}>(`select e.id as server_id,m.definition->>'name' as name
      from public.entities e join public.mcp_servers m on m.entity_id=e.id
      where e.space_id=$1 and e.kind='mcp_server' and e.deleted_at is null
      and m.definition->>'defaultOn'='true' and m.definition->>'approved'='true' and coalesce(m.definition->>'enabled','true')='true'
      order by e.id limit 33`,[checked.spaceId]);
    if(defaultOn.length>32)throw new CollabError('invalid_input','Too many default MCP connectors');
    for(const row of defaultOn){
      if(!row.name){unnamed(row.server_id);continue;}
      const name=row.name.toLowerCase();
      if(!nearest.has(name))nearest.set(name,{serverId:row.server_id,depth:DEFAULT_ON_DEPTH});
    }
    if(nearest.size>32)throw new CollabError('invalid_input','Too many default MCP connectors');
    selections=[...nearest.values()].map(({serverId})=>({serverId}));
  }
  const resolved:McpResolvedSelection[]=[];
  const names=new Set<string>();
  for (const selection of selections) {
    const server=await loadMcpServer(q,selection.serverId);
    if(server.spaceId!==checked.spaceId) throw new CollabError('forbidden','MCP connector belongs to another space');
    const d=server.definition;
    if(names.has(d.name.toLowerCase())) throw new CollabError('invalid_input','MCP connector name collision');
    names.add(d.name.toLowerCase());
    let reason:McpReadinessReason='ready';
    let credentialId=selection.credentialId;
    let credentialSource:McpCredentialSource|undefined=credentialId?'pinned':undefined;
    let unusable:ResolvedAccount['unusable'];
    if(!d.approved) reason='not_approved';
    else if(d.enabled===false) reason='disabled';
    else if(d.transport==='stdio' && !d.stdioTrusted) reason='stdio_not_trusted';
    else if(d.auth.type!=='none') {
      // Before any account is resolved OR a pin honoured: a launch with no human
      // root gets no connection at all (§6.1, B17/B19).
      if(noHumanRoot===true) {credentialId=undefined;credentialSource=undefined;reason='no_human_provenance';}
      else if(!credentialId && pinnedOnly!==true) {
        // §3 below the pin. Runs under the claims in force, which bind and
        // authorize have already set to the root member's (see rootMemberId).
        const account=await q.rpc<ResolvedAccount|null>('resolve_mcp_account',[server.id,rootMemberId??null]);
        if(account?.credentialId){credentialId=account.credentialId;credentialSource=account.source;}
        // Worth reporting even when a shared connection carried the launch: the
        // UI shows the root's own broken connection as needing a reconnect.
        if(account?.unusable)unusable=account.unusable;
      }
      if(reason==='no_human_provenance') {/* decided above; never open a row for a rootless launch */}
      else if(!credentialId) reason=unusable?unusable.reason:'credential_required';
      else if(credentialReady) reason=await credentialReady({...selection,credentialId},server);
      else {
        const result=await q.rpc<{ready:boolean;reason:McpReadinessReason}>('mcp_credential_readiness',[server.id,credentialId]);
        reason=result.ready === true ? 'ready' : result.reason;
      }
    } else if(credentialId) reason='credential_unavailable';
    // G15. A default that is not ready is skipped and reported; it never fails
    // a launch. The caller asked for no connector in particular.
    if(fromDefaults && reason!=='ready') {
      names.delete(d.name.toLowerCase());
      skipped.push({serverId:server.id,name:d.name,reason});
      continue;
    }
    resolved.push({server,...(credentialId?{credentialId}:{}),ready:reason==='ready',reason,
      ...(credentialSource?{credentialSource}:{}),...(fromDefaults?{fromDefault:true}:{}),
      ...(unusable?{unusableCredential:unusable}:{})});
  }
  return {selections:resolved,ready:resolved.every(s=>s.ready),...(skipped.length?{skipped}:{})};
}

/**
 * B25. An admin adding a catalog connector a member has ALREADY requested means
 * "approve that one" — the open request holds the name, so without this they
 * would meet a bare unique-index violation and no id to act on.
 *
 * Answering `conflict` with the existing `serverId` makes adoption reachable
 * from every door, the CLI included: approve it with `mcp.servers.update`
 * (approved=true) instead of creating a second connector for one provider.
 */
async function refuseIfOpenCatalogRequest(q:Querier,spaceId:string,definition:McpServerDefinition):Promise<void> {
  if(!definition.catalogId)return;
  const open=await q.rpc<string|null>('open_mcp_catalog_request',[spaceId,definition.catalogId]);
  if(open)throw new CollabError('conflict',
    `An open request for ${definition.catalogId} exists in this space; approve it instead of adding a second connector`,
    {details:{serverId:open,catalogId:definition.catalogId}});
}

export function registerMcpDefinitionHandlers(registry:HandlerRegistry,deps:FacadeDeps):void {
  registry.register('mcp.servers.list',async ctx=>{
    const spaceId=requireUuidParam(ctx,'spaceId');
    const limit=limitOf(ctx.query.get('limit'));
    const cursor=ctx.query.get('cursor'); let after:string|null=null;
    if(cursor){const {k}=decodeCursor(cursor);if(k.length!==2||k[0]!==spaceId||typeof k[1]!=='string')throw new CollabError('invalid_cursor','Invalid MCP cursor');after=k[1];}
    return deps.db.tx(claimsFor(await deps.owner(),ctx),async q=>{
      const [permission]=await q.query<{member:boolean}>(`select internal.is_space_member($1::uuid) as member`,[spaceId]);
      const attach=await canAttachMcp(q,spaceId,ctx.query.get('targetId')??undefined);
      const rows=await q.query<DefinitionRow>(`${SELECT} and e.space_id=$1 and ($2::uuid is null or e.id>$2::uuid) order by e.id limit $3`,[spaceId,after,limit+1]);
      const page=rows.slice(0,limit);
      return {items:page.map(row=>publicView(view(row,attach))),allowed:{register:permission?.member??false,attach},nextCursor:rows.length>limit?encodeCursor([spaceId,page.at(-1)!.id]):null};
    });
  });
  registry.register('mcp.servers.get',async ctx=>deps.db.tx(claimsFor(await deps.owner(),ctx),async q=>publicView(await loadMcpServer(q,requireUuidParam(ctx,'serverId'),ctx.query.get('targetId')??undefined))));
  registry.register('mcp.resolve',async ctx=>{
    const input=McpResolveInputSchema.parse({...(ctx.body as Record<string, unknown>),spaceId:requireUuidParam(ctx,'spaceId')});
    return deps.db.tx(claimsFor(await deps.owner(),ctx),q=>resolveMcpSelections(q,input));
  });
  registry.register('mcp.servers.create',async ctx=>{
    const input=McpServerCreateInputSchema.parse({...(ctx.body as Record<string, unknown>),spaceId:requireUuidParam(ctx,'spaceId')});
    return deps.db.tx(claimsFor(await deps.owner(),ctx,commandEnvelope(ctx)),async q=>{
      await refuseIfOpenCatalogRequest(q,input.spaceId,input.definition);
      const raw=await q.rpc<{entity:{id:string}}>('create_mcp_server_entity',[input.spaceId,JSON.stringify(input.definition),input.actorId??null,input.clientMutationId]);
      return publicView(await loadMcpServer(q,raw.entity.id));
    });
  });
  registry.register('mcp.servers.update',async ctx=>{
    const input=McpServerUpdateInputSchema.parse({...(ctx.body as Record<string, unknown>),serverId:requireUuidParam(ctx,'serverId')});
    return deps.db.tx(claimsFor(await deps.owner(),ctx,commandEnvelope(ctx)),async q=>{
      await q.rpc('update_mcp_server_entity',[input.serverId,input.expectedVersion,JSON.stringify(input.definition),input.actorId??null,input.clientMutationId]);
      return publicView(await loadMcpServer(q,input.serverId));
    });
  });
  registry.register('mcp.servers.delete',async ctx=>{
    const input=McpServerDeleteInputSchema.parse({...(ctx.body as Record<string, unknown>),serverId:requireUuidParam(ctx,'serverId')});
    return deps.db.tx(claimsFor(await deps.owner(),ctx,commandEnvelope(ctx)),async q=>{
      // Serialize with definition edits and credential writes on the advisory
      // lock they already take (297). NOT `select ... for update`: tm8_app has
      // no UPDATE privilege on public.entities, so that refused every delete.
      await q.query('select pg_advisory_xact_lock(hashtextextended($1::text,297))',[input.serverId]);
      const server=await loadMcpServer(q,input.serverId);
      if(!server.allowed.manage) throw new CollabError('forbidden','Only space members can delete MCP connectors');
      if(server.version!==input.expectedVersion) throw new CollabError('version_conflict','MCP connector changed');
      await q.rpc('delete_entity',[input.serverId,input.actorId??null,input.clientMutationId]);
      return {deleted:true,serverId:input.serverId};
    });
  });
  // §11. The catalog is NODE-level static data — see contract/mcp-catalog.ts
  // for why it is not UI data any more. `spaceId` is OPTIONAL: without it this
  // is the bare list (what the CLI prints), and with it each entry also reports
  // where it is already registered in that Space, which is what Discover's
  // "Added" and "Requested" states read (B16). The join is on
  // `definition.catalogId`, under the CALLER's claims, so a non-member learns
  // nothing about a Space's connectors beyond the static list they could read
  // anyway.
  registry.register('mcp.catalog.list',async ctx=>{
    const spaceId=optionalUuid(ctx.query.get('spaceId'),'spaceId');
    if(spaceId===null)return {items:[...MCP_CATALOG]};
    return deps.db.tx(claimsFor(await deps.owner(),ctx),async q=>{
      const rows=await q.query<{server_id:string;catalog_id:string;approved:boolean}>(`select e.id as server_id,m.definition->>'catalogId' as catalog_id,
        coalesce((m.definition->>'approved')='true',false) as approved
        from public.entities e join public.mcp_servers m on m.entity_id=e.id
        where e.space_id=$1 and e.kind='mcp_server' and e.deleted_at is null and m.definition->>'catalogId' is not null
        order by e.id limit 256`,[spaceId]);
      const added=new Map<string,McpCatalogAdded[]>();
      for(const row of rows){
        const list=added.get(row.catalog_id)??[];
        // One Space can hold several connectors from one entry (two Notion
        // workspaces, say), and the cap keeps the response bounded.
        if(list.length<32)list.push({serverId:row.server_id,approved:row.approved===true});
        added.set(row.catalog_id,list);
      }
      return {items:MCP_CATALOG.map((entry):McpCatalogEntry=>{
        const here=added.get(entry.id);
        return here?.length?{...entry,added:here}:entry;
      })};
    });
  });
  // §11, §10.1. A MEMBER asks the Space's admins for a connector. It creates the
  // real `mcp_server` entity UNAPPROVED and raises an attention request on it,
  // so the member sees it in the Yours tab as "Awaiting approval" and approving
  // is the existing `mcp.servers.update` with approved=true (B13).
  registry.registerAll({'mcp.servers.request':requireHumanSession(async ctx=>{
    const spaceId=requireUuidParam(ctx,'spaceId');
    const input=McpServerRequestInputSchema.parse(ctx.body);
    const definition=input.catalogId!==undefined?catalogRequestDefinition(input.catalogId):input.definition!;
    return deps.db.tx(claimsFor(await deps.owner(),ctx,commandEnvelope(ctx)),async q=>{
      const raw=await q.rpc<{entity:{id:string}}>('request_mcp_server_entity',
        [spaceId,JSON.stringify(definition),input.note??null,input.actorId??null,input.clientMutationId]);
      return publicView(await loadMcpServer(q,raw.entity.id));
    });
  })});
  /*
   * §6/§10.6 (S6). The provenance OUTCOME of a launch, for the debug view.
   *
   * A PASS-THROUGH, and deliberately nothing more. `public.mcp_session_provenance`
   * holds the whole of §6: it refuses a link caller, refuses a session the
   * caller cannot read, and answers `recorded:false` for a session that has no
   * provenance row — one nothing ever bound, or one whose binding went with its
   * auth session when that was pruned. (It USED to mean "a chat on Space
   * defaults" as well; 358 moved the read onto `mcp_session_bindings`, so a
   * bound chat now answers with its real root.) Every one of those is an ANSWER
   * this handler must not improve on.
   * Catching the refusals to soften them, or filling in a chain from parts the
   * facade can see, would put a second copy of the access rule in TypeScript
   * beside the one in SQL, and the §10.6 surface would then be reporting the
   * copy rather than the rule. The parse at the end is the only addition: it
   * proves the shape the UI is typed against, and `recorded:false` is a member
   * of that union rather than an error.
   *
   * `humanOnly`: a provenance answer names the human behind a running agent,
   * and the view that reads it is a person's debug tab. The RPC's own gate
   * stops a LINK caller; this one stops an agent session.
   */
  registry.registerAll({'mcp.sessions.provenance':requireHumanSession(async ctx=>{
    const sessionId=requireUuidParam(ctx,'sessionId');
    const raw=await deps.db.tx(claimsFor(await deps.owner(),ctx),q=>q.rpc<unknown>('mcp_session_provenance',[sessionId]));
    return McpSessionProvenanceSchema.parse(raw);
  })});
  registry.register('mcp.servers.import',async ctx=>{
    const input=McpServerImportInputSchema.parse({...(ctx.body as Record<string, unknown>),spaceId:requireUuidParam(ctx,'spaceId')});
    if(new Set(input.definitions.map(d=>d.name.toLowerCase())).size!==input.definitions.length)throw new CollabError('invalid_input','Duplicate imported connector names');
    return deps.db.tx(claimsFor(await deps.owner(),ctx,commandEnvelope(ctx)),async q=>{
      const items=[];
      for(const [index,definition] of input.definitions.entries()){
        await refuseIfOpenCatalogRequest(q,input.spaceId,definition);
        const raw=await q.rpc<{entity:{id:string}}>('create_mcp_server_entity',[input.spaceId,JSON.stringify(definition),input.actorId??null,`${input.clientMutationId}:${index}`]);
        items.push(publicView(await loadMcpServer(q,raw.entity.id)));
      }
      return {items};
    });
  });
}
