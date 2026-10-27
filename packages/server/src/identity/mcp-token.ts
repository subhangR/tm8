/**
 * §5.5 (D9): AN MCP TOKEN DOES NOTHING ANYWHERE BUT `/mcp`.
 *
 * The plan is explicit — "Accepted only on the new /mcp endpoint (G14). It is
 * refused on the REST facade and the CLI API" — and this file is both halves of
 * that: the REFUSAL every other transport runs, and the RESOLUTION only the
 * `/mcp` route calls. It is deliberately shaped like identity/link-bearer.ts,
 * whose layer (i) solves the same problem for a `link` session.
 *
 * (i) TRANSPORT. `createSessionIdentityResolver` (http/identity-resolver.ts) is
 *     the one closure every wire entry resolves a bearer through — the HTTP
 *     facade, the file-upload PUT, the clipboard POST, the named-Server relay,
 *     the events WS and the PTY attach WS. It calls `refuseMcpTokenOnTransport`
 *     on the raw carrier. There is no allow-list at this layer and there must
 *     never be one: the `/mcp` route does not go through that closure at all,
 *     it calls `resolveMcpTokenIdentity` itself.
 *
 *     THIS IS NOT COSMETIC, and the reason is worth stating because it is
 *     inverted from the link case. A `link` token has the normal `tm8s_`
 *     prefix, so without its refusal it would resolve as a full session. An MCP
 *     token has its OWN prefix, so it does not match the bearer arm at all —
 *     and the next arm is `autoOwnerResolver`, which on a loopback peer with no
 *     recognised credential returns the NODE OWNER. So the failure mode of
 *     omitting this refusal is not "the token works where it should not": it is
 *     "presenting an MCP token to any loopback route makes you the node owner".
 *     A node bound to loopback is the normal deployment. Hence an explicit,
 *     ordered arm, and a test that reverts it.
 *
 * (ii) CLAIMS. The identity this file produces carries `authKind: 'mcp'`, which
 *     `internal.require_human_auth_kind()` refuses — so `mcp.tokens.*`,
 *     `credentials.*`, `mcp.audit.list`, the OAuth doors and every rekey are
 *     closed to a token even if one ever reached a handler. What stays OPEN is
 *     what the proxy needs: `read_mcp_credential` and `resolve_mcp_account`
 *     refuse only a `link` claim, because they run under the ROOT's claims, and
 *     for an external call the root IS the token's member (§6.6).
 *
 * (iii) SPACE. A token is node-level and holds a Space ARRAY, so it is never
 *     pinned at rest. Each call names one `spaceId`, `mcp_token_space_member`
 *     (357) decides it against the token's list AND live membership, and only
 *     then does the request bind `tm8.session_space_id` to it. 227's pin is what
 *     narrows RLS for the rest of the call.
 */
import { CollabError } from '@tm8/contract';

import type { Db } from '../db/types.js';
import { MCP_TOKEN_PREFIX, hashToken, parseMcpToken } from './crypto.js';

export const MCP_TOKEN_TRANSPORT_REFUSED =
  'an MCP token is accepted only on the /mcp endpoint';

/**
 * What `public.resolve_mcp_token` (357) answers, and B63.3 fixes the shape: FOUR
 * FIELDS. No account id, no label, no connector list — the claim-free read
 * returns what the server needs to build claims and not one field more. The
 * per-token connector allow-list is applied in SQL by
 * `mcp_token_space_member`, so nothing here has to carry it.
 */
export interface ResolvedMcpToken {
  tokenId: string;
  identityId: string;
  /** null = every Space the member belongs to now or joins later (§5.5). */
  spaceIds: string[] | null;
  expiresAt: string;
}

/** Does this carrier even claim to be an MCP token? Prefix only; nothing verified. */
export function looksLikeMcpToken(raw: string): boolean {
  return raw.startsWith(MCP_TOKEN_PREFIX);
}

/**
 * Layer (i). Called on the RAW carrier — not on a resolved row, because an MCP
 * token never resolves to one here — by the one inbound resolver, before the
 * auto-owner arm can see it.
 */
export function refuseMcpTokenOnTransport(raw: string): void {
  if (looksLikeMcpToken(raw)) {
    throw new CollabError('forbidden', MCP_TOKEN_TRANSPORT_REFUSED, { details: { sqlstate: '42501' } });
  }
}

/**
 * Verify a presented `tm8m_…` token against `internal.mcp_tokens`.
 *
 * Claim-free, for the same reason `resolveBearerIdentity` is: the token IS the
 * identity claim. `resolve_mcp_token` refuses a revoked token, an expired one, a
 * disabled account and an unknown hash with ONE indistinguishable answer, so a
 * dead token dies here rather than at next expiry — and a caller probing the
 * endpoint cannot tell which of the four it hit (B63.3).
 *
 * ONLY `mcp/endpoint.ts` may call this. It is not wired into any resolver.
 */
export async function resolveMcpTokenIdentity(db: Db, raw: string, ip?: string): Promise<ResolvedMcpToken> {
  const parsed = parseMcpToken(raw);
  if (!parsed) throw invalidToken();
  // `ip` is the SOCKET peer, never a forwarded header, and it is stamped by the
  // resolution itself (B63.3) — rate-limited to one write a minute per token in
  // SQL, for the reason `AUTH_TOUCH_INTERVAL_MS` exists.
  const resolved = await db.rpc<ResolvedMcpToken | null>({}, 'resolve_mcp_token',
    [hashToken(parsed.secret), ip ?? null]);
  // The id in the token is a routing hint, never the credential: the sha256
  // lookup above is what authenticated. Refusing a mismatched pair costs
  // nothing and rejects spliced tokens (the rule `resolveBearerIdentity` uses).
  if (!resolved || resolved.tokenId !== parsed.tokenId) throw invalidToken();
  return resolved;
}

function invalidToken(): CollabError {
  return new CollabError('unauthenticated', 'invalid credentials');
}
