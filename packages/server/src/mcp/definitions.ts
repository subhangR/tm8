import { CollabError, McpTestResultSchema, McpServerDefinitionSchema, McpResolveInputSchema, McpServerCreateInputSchema,
  McpServerUpdateInputSchema, McpServerDeleteInputSchema, McpServerImportInputSchema,
  type McpServerView, type McpResolveInput, type McpResolveResult, type McpSelection,
  type McpReadinessReason } from '@tm8/contract';
import type { Querier } from '../db/types.js';
import type { FacadeDeps } from '../facade/deps.js';
import type { HandlerRegistry } from '../facade/registry.js';
import { claimsFor, commandEnvelope, requireUuidParam, limitOf } from '../facade/context.js';
import { encodeCursor, decodeCursor } from '@tm8/contract';

type DefinitionRow = { id: string; space_id: string; version: number; security_revision?: number; definition: unknown; admin: boolean; health?: unknown };
const SELECT = `select e.id,e.space_id,e.version,m.mcp_security_revision as security_revision,m.definition,internal.is_space_admin(e.space_id) as admin,
  (select h.result from public.mcp_server_health h where h.server_id=e.id and h.member_id=internal.current_member_id(e.space_id) and h.definition_version=e.version) as health
  from public.entities e join public.mcp_servers m on m.entity_id=e.id
  where e.kind='mcp_server' and e.deleted_at is null`;

export async function canAttachMcp(q: Querier, spaceId: string, targetId?: string): Promise<boolean> {
  if (!targetId) return false;
  const rows = await q.query<{ allowed: boolean }>(`select internal.is_space_member($2::uuid) and exists(select 1 from public.entities where id=$1 and space_id=$2
    and kind in ('task','team_member','work_session') and deleted_at is null) as allowed`, [targetId,spaceId]);
  return rows[0]?.allowed === true;
}
function view(row: DefinitionRow, attach: boolean): McpServerView & {securityRevision?:number} {
  const definition=McpServerDefinitionSchema.parse(row.definition);
  return { id:row.id, spaceId:row.space_id, version:row.version, ...(row.security_revision !== undefined ? {securityRevision:Number(row.security_revision)} : {}), definition, ...(row.health ? {health:McpTestResultSchema.parse(row.health)} : {}),
    allowed:{register:row.admin,approve:row.admin,manage:row.admin,attach:attach && definition.approved && definition.enabled !== false} };
}
export async function loadMcpServer(q: Querier, serverId: string, targetId?: string): Promise<McpServerView> {
  const [row]=await q.query<DefinitionRow>(`${SELECT} and e.id=$1`,[serverId]);
  if (!row) throw new CollabError('not_found','MCP connector is unavailable');
  return view(row,await canAttachMcp(q,row.space_id,targetId));
}
export type McpCredentialReadiness = (selection:McpSelection,server:McpServerView)=>Promise<McpReadinessReason>;
/** Uses only caller-readable same-space attachments; never infers an account. */
export async function resolveMcpSelections(q:Querier,input:McpResolveInput,credentialReady?:McpCredentialReadiness):Promise<McpResolveResult> {
  const checked=McpResolveInputSchema.parse(input);
  let selections=checked.mcpSelections;
  if (selections===undefined) {
    const sources=[...new Set([...(checked.targetIds??[]),...(checked.teamMemberId?[checked.teamMemberId]:[])])];
    // Validate every supplied target rather than silently resolving a partial set.
    for (const id of sources) if (!await canAttachMcp(q,checked.spaceId,id)) throw new CollabError('forbidden','MCP defaults target is unavailable');
    const lineage=await q.query<{id:string;parent_id:string|null;depth:number;path:string[]}>(`with recursive lineage as (
      select e.id,e.parent_id,0 as depth,array[e.id] as path from public.entities e
      where e.id=any($1::uuid[]) and e.space_id=$2 and e.deleted_at is null
      union all
      select p.id,p.parent_id,l.depth+1,l.path||p.id from lineage l join public.entities p on p.id=l.parent_id
      where p.space_id=$2 and p.deleted_at is null and l.depth<16 and not p.id=any(l.path)
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
    for(const row of rows){
      const depth=depths.get(row.source_id);if(depth===undefined)continue;
      const name=row.name.toLowerCase(),previous=nearest.get(name);
      if(previous && previous.depth===depth && previous.serverId!==row.server_id)throw new CollabError('invalid_input','MCP connector name collision at the same attachment depth');
      if(!previous||depth<previous.depth)nearest.set(name,{serverId:row.server_id,depth});
    }
    if(nearest.size>32)throw new CollabError('invalid_input','Too many default MCP connectors');
    selections=[...nearest.values()].map(({serverId})=>({serverId}));
  }
  const resolved=[];
  const names=new Set<string>();
  for (const selection of selections) {
    const server=await loadMcpServer(q,selection.serverId);
    if(server.spaceId!==checked.spaceId) throw new CollabError('forbidden','MCP connector belongs to another space');
    const d=server.definition;
    if(names.has(d.name.toLowerCase())) throw new CollabError('invalid_input','MCP connector name collision');
    names.add(d.name.toLowerCase());
    let reason:McpReadinessReason='ready';
    if(!d.approved) reason='not_approved';
    else if(d.enabled===false) reason='disabled';
    else if(d.transport==='stdio' && !d.stdioTrusted) reason='stdio_not_trusted';
    else if(d.auth.type!=='none') {
      if(!selection.credentialId) reason='credential_required';
      else if(credentialReady) reason=await credentialReady(selection,server);
      else {
        const result=await q.rpc<{ready:boolean;reason:McpReadinessReason}>('mcp_credential_readiness',[server.id,selection.credentialId]);
        reason=result.ready === true ? 'ready' : result.reason;
      }
    } else if(selection.credentialId) reason='credential_unavailable';
    resolved.push({server,...(selection.credentialId?{credentialId:selection.credentialId}:{}),ready:reason==='ready',reason});
  }
  return {selections:resolved,ready:resolved.every(s=>s.ready)};
}

export function registerMcpDefinitionHandlers(registry:HandlerRegistry,deps:FacadeDeps):void {
  registry.register('mcp.servers.list',async ctx=>{
    const spaceId=requireUuidParam(ctx,'spaceId');
    const limit=limitOf(ctx.query.get('limit'));
    const cursor=ctx.query.get('cursor'); let after:string|null=null;
    if(cursor){const {k}=decodeCursor(cursor);if(k.length!==2||k[0]!==spaceId||typeof k[1]!=='string')throw new CollabError('invalid_cursor','Invalid MCP cursor');after=k[1];}
    return deps.db.tx(claimsFor(await deps.owner(),ctx),async q=>{
      const [permission]=await q.query<{admin:boolean}>(`select internal.is_space_admin($1::uuid) as admin`,[spaceId]);
      const attach=await canAttachMcp(q,spaceId,ctx.query.get('targetId')??undefined);
      const rows=await q.query<DefinitionRow>(`${SELECT} and e.space_id=$1 and ($2::uuid is null or e.id>$2::uuid) order by e.id limit $3`,[spaceId,after,limit+1]);
      const page=rows.slice(0,limit);
      return {items:page.map(row=>view(row,attach)),allowed:{register:permission?.admin??false,attach},nextCursor:rows.length>limit?encodeCursor([spaceId,page.at(-1)!.id]):null};
    });
  });
  registry.register('mcp.servers.get',async ctx=>deps.db.tx(claimsFor(await deps.owner(),ctx),q=>loadMcpServer(q,requireUuidParam(ctx,'serverId'),ctx.query.get('targetId')??undefined)));
  registry.register('mcp.resolve',async ctx=>{
    const input=McpResolveInputSchema.parse({...(ctx.body as Record<string, unknown>),spaceId:requireUuidParam(ctx,'spaceId')});
    return deps.db.tx(claimsFor(await deps.owner(),ctx),q=>resolveMcpSelections(q,input));
  });
  registry.register('mcp.servers.create',async ctx=>{
    const input=McpServerCreateInputSchema.parse({...(ctx.body as Record<string, unknown>),spaceId:requireUuidParam(ctx,'spaceId')});
    return deps.db.tx(claimsFor(await deps.owner(),ctx,commandEnvelope(ctx)),async q=>{
      const raw=await q.rpc<{entity:{id:string}}>('create_mcp_server_entity',[input.spaceId,JSON.stringify(input.definition),input.actorId??null,input.clientMutationId]);
      return loadMcpServer(q,raw.entity.id);
    });
  });
  registry.register('mcp.servers.update',async ctx=>{
    const input=McpServerUpdateInputSchema.parse({...(ctx.body as Record<string, unknown>),serverId:requireUuidParam(ctx,'serverId')});
    return deps.db.tx(claimsFor(await deps.owner(),ctx,commandEnvelope(ctx)),async q=>{
      await q.rpc('update_mcp_server_entity',[input.serverId,input.expectedVersion,JSON.stringify(input.definition),input.actorId??null,input.clientMutationId]);
      return loadMcpServer(q,input.serverId);
    });
  });
  registry.register('mcp.servers.delete',async ctx=>{
    const input=McpServerDeleteInputSchema.parse({...(ctx.body as Record<string, unknown>),serverId:requireUuidParam(ctx,'serverId')});
    return deps.db.tx(claimsFor(await deps.owner(),ctx,commandEnvelope(ctx)),async q=>{
      await q.query('select id from public.entities where id=$1 for update',[input.serverId]);
      const server=await loadMcpServer(q,input.serverId);
      if(!server.allowed.manage) throw new CollabError('forbidden','Only administrators can delete MCP connectors');
      if(server.version!==input.expectedVersion) throw new CollabError('version_conflict','MCP connector changed');
      await q.rpc('delete_entity',[input.serverId,input.actorId??null,input.clientMutationId]);
      return {deleted:true,serverId:input.serverId};
    });
  });
  registry.register('mcp.servers.import',async ctx=>{
    const input=McpServerImportInputSchema.parse({...(ctx.body as Record<string, unknown>),spaceId:requireUuidParam(ctx,'spaceId')});
    if(new Set(input.definitions.map(d=>d.name.toLowerCase())).size!==input.definitions.length)throw new CollabError('invalid_input','Duplicate imported connector names');
    return deps.db.tx(claimsFor(await deps.owner(),ctx,commandEnvelope(ctx)),async q=>{
      const items=[];
      for(const [index,definition] of input.definitions.entries()){
        const raw=await q.rpc<{entity:{id:string}}>('create_mcp_server_entity',[input.spaceId,JSON.stringify(definition),input.actorId??null,`${input.clientMutationId}:${index}`]);
        items.push(await loadMcpServer(q,raw.entity.id));
      }
      return {items};
    });
  });
}
