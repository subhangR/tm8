import { CollabError, McpCallAuditOutcomeSchema, decodeCursor, encodeCursor, type McpAuditListResult } from '@tm8/contract';
import type { Db, DbClaims } from '../db/types.js';
import type { FacadeDeps } from '../facade/deps.js';
import type { HandlerRegistry } from '../facade/registry.js';
import { claimsFor, limitOf, requireUuidParam } from '../facade/context.js';
import type { McpProxyGrant } from './proxy.js';

/*
 * §5.6 per-call audit (346). Every proxied call writes a row, a refused one
 * included, and no row ever holds an argument or a result: the tool name and
 * the byte sizes are all that is kept. Root and chain come from the grant that
 * `read_mcp_session_binding` produced; a call refused before there was a grant
 * leaves them null and `record_mcp_call_audit` reads the same recorded binding.
 */

/**
 * Why a call was refused, as a short stable slug, or null when the error is not
 * a refusal (an upstream failure is `failed`, not `denied`). Keyed on the
 * messages the authorize/proxy refusals already throw, so none of them changes.
 */
const DENY_REASONS: ReadonlyArray<readonly [string, string]> = [
 ['MCP runtime unavailable','runtime_unavailable'],
 ['MCP session bearer mismatch','session_mismatch'],
 ['MCP connector is not selected','not_selected'],
 ['MCP connector access has changed','access_changed'],
 ['MCP provenance root is no longer a member of every space in the chain','root_left_chain_space'],
 ['MCP provenance root is no longer a member of this space','root_not_member'],
 ['MCP session unavailable','session_unavailable'],
 ['MCP session changed','session_changed'],
 ['MCP connector definition changed','definition_changed'],
 ['MCP connector unavailable','connector_unavailable'],
 ['MCP executable is not trusted','executable_untrusted'],
 ['Select an MCP account before launch','credential_required'],
 ['MCP credential changed','credential_changed'],
 ['MCP account binding mismatch','credential_changed'],
 ['MCP root member is not a member','root_not_member'],
];
export function mcpDenyReason(error:unknown):string|null {
 const message=error instanceof Error?error.message:'';
 for(const [prefix,reason] of DENY_REASONS)if(message.startsWith(prefix))return reason;
 // The caller's own membership, checked by the binding reader before §6's.
 if(/not a member of this space/.test(message))return 'not_member';
 const code=(error as {code?:unknown}|null)?.code;
 if(error instanceof CollabError && code==='forbidden')return 'forbidden';
 if(code==='42501')return 'forbidden';
 return null;
}

export interface McpCallAuditEntry {
 sessionId:string; serverId:string; method:'tools/list'|'tools/call'; tool:string|null;
 outcome:'started'|'succeeded'|'failed'|'denied';
 grant?:McpProxyGrant|undefined; denyReason?:string|null; latencyMs?:number; requestBytes:number; responseBytes?:number|null;
}
/** Written under the session's own runtime bearer: the writer accepts no other. */
export function recordMcpCall(db:Pick<Db,'rpc'>,claims:DbClaims,entry:McpCallAuditEntry):Promise<unknown> {
 return db.rpc(claims,'record_mcp_call_audit',[entry.sessionId,entry.serverId,entry.grant?.credentialId??null,entry.method,entry.tool,entry.outcome,
  entry.grant?.rootMemberId??null,entry.grant?.chain?.length?entry.grant.chain:null,entry.denyReason??null,
  entry.latencyMs===undefined?null:Math.max(0,Math.round(entry.latencyMs)),entry.requestBytes,entry.responseBytes??null]);
}
/** The tool a `tools/call` names, never its arguments. */
export function mcpToolName(method:string,params:unknown):string|null {
 if(method!=='tools/call' || !params || typeof params!=='object')return null;
 const name=(params as {name?:unknown}).name;
 return typeof name==='string' && name.trim()?name.trim().slice(0,200):null;
}
export function byteSize(value:unknown):number {
 return value===undefined?0:Buffer.byteLength(JSON.stringify(value) ?? '');
}

interface AuditRow { id:string }
export function registerMcpAuditHandlers(registry:HandlerRegistry,deps:FacadeDeps):void {
 registry.register('mcp.audit.list',async ctx=>{
  const spaceId=requireUuidParam(ctx,'spaceId');
  const limit=limitOf(ctx.query.get('limit'));
  const uuid=(name:string)=>{const value=ctx.query.get(name);if(!value)return null;
   if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))throw new CollabError('invalid_input',`${name} must be a uuid`);return value;};
  const rawOutcome=ctx.query.get('outcome');
  const outcome=rawOutcome?McpCallAuditOutcomeSchema.safeParse(rawOutcome):null;
  if(outcome && !outcome.success)throw new CollabError('invalid_input',`outcome must be one of ${McpCallAuditOutcomeSchema.options.join(', ')}`);
  const cursor=ctx.query.get('cursor');let before:string|null=null;
  if(cursor){const {k}=decodeCursor(cursor);if(k.length!==2||k[0]!==spaceId||typeof k[1]!=='string'||!/^[0-9]+$/.test(k[1]))throw new CollabError('invalid_cursor','Invalid MCP audit cursor');before=k[1];}
  const result=await deps.db.rpc<{items:AuditRow[];scope:'space'|'own'}>(claimsFor(await deps.owner(),ctx),'list_mcp_call_audit',
   [spaceId,uuid('sessionId'),uuid('chatId'),uuid('serverId'),uuid('memberId'),outcome?.data??null,before,limit+1]);
  const page=result.items.slice(0,limit);
  return {items:page,scope:result.scope,nextCursor:result.items.length>limit?encodeCursor([spaceId,page.at(-1)!.id]):null} as McpAuditListResult;
 });
}
