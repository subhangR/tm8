import { McpTokenCreateInputSchema, McpTokenRevokeInputSchema,
 type McpTokenCreateResult, type McpTokenListResult, type McpTokenView } from '@tm8/contract';
import type { FacadeDeps } from '../facade/deps.js';
import type { RequestContext } from '../http/types.js';
import type { HandlerRegistry } from '../facade/registry.js';
import { claimsFor, requireUuidParam } from '../facade/context.js';
import { requireHumanSession } from '../facade/handlers/w2/credentials.js';
import { formatMcpToken, generateSecret, hashToken } from '../identity/crypto.js';
import { MCP_ENDPOINT_PATH } from './endpoint.js';

/*
 * §5.5 / §10.7 — `mcp.tokens.create|list|revoke`.
 *
 * THE TOKEN IS SHOWN ONCE. The secret is generated here, hashed here, and only
 * the hash is handed to `create_mcp_token`; the plaintext exists in this process
 * for the length of one response and is never written anywhere — not to the
 * row, not to the ledger, not to a log. There is deliberately no "reveal"
 * operation, which is why §10.7's modal says "You won't see this token again".
 *
 * All three are human-only at BOTH layers, as `credentials.*` is: the facade
 * guard here (`requireHumanSession`, pinned by the catalog's `humanOnly`) and
 * `internal.require_human_auth_kind()` inside the three RPCs. A token that acts
 * as a member is minted by that member, never by their agent carrying their
 * identity — and never by another MCP token, which the transport refusal and the
 * `mcp` auth kind both stop.
 *
 * A node admin has no door here at all (§5.5: "Node admin rights never widen
 * it"), and neither has a Space admin: their lever is the membership.
 */
export function registerMcpTokenHandlers(registry:HandlerRegistry,deps:FacadeDeps):void {
 const claims=async(ctx:RequestContext)=>claimsFor(await deps.owner(),ctx);
 // Where an MCP client points. `publicOrigin` when the operator set one, else
 // the bound address — the same fallback `mcp.oauth.begin`'s callback URL uses,
 // so the two never disagree about what this node is called.
 const endpoint=()=>`${deps.config.publicOrigin ?? `http://${deps.config.host}:${deps.config.port}`}${MCP_ENDPOINT_PATH}`;
 registry.registerAll({
  'mcp.tokens.create':requireHumanSession(async ctx=>{
   const input=McpTokenCreateInputSchema.parse(ctx.body);
   // The id rides in the token so verification is one indexed lookup, so it has
   // to be known before the row is written: `create_mcp_token` would otherwise
   // have to hand back an id the secret was already formatted without.
   const secret=generateSecret();
   const expiresAt=input.expiresInDays===undefined?null
    :new Date(Date.now()+input.expiresInDays*24*60*60*1000).toISOString();
   const token=await deps.db.rpc<McpTokenView>(await claims(ctx),'create_mcp_token',
    [input.label,input.spaceIds,hashToken(secret),expiresAt]);
   return {token,secret:formatMcpToken(token.id,secret),endpoint:endpoint()} satisfies McpTokenCreateResult;
  }),
  'mcp.tokens.list':requireHumanSession(async ctx=>
   ({items:await deps.db.rpc<McpTokenView[]>(await claims(ctx),'list_mcp_tokens',[])} satisfies McpTokenListResult)),
  'mcp.tokens.revoke':requireHumanSession(async ctx=>{
   McpTokenRevokeInputSchema.parse(ctx.body);
   return deps.db.rpc<McpTokenView>(await claims(ctx),'revoke_mcp_token',[requireUuidParam(ctx,'tokenId')]);
  }),
 });
}
