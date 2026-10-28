/**
 * THE MCP TOKENS PORT — Settings → MCP tokens (plan §10.7, decision D9).
 *
 * The same rule as `settings-space-links/port.ts`: the section takes this
 * narrow surface and never imports a seam, so a fixture and a real node are
 * indistinguishable to it.
 *
 * THE SECRET EXISTS IN EXACTLY ONE PLACE AND FOR ONE RENDER. `create` is the
 * only operation that ever carries it (`mcp.tokens.create` → `secret`), there
 * is no reveal operation to pair with it, and nothing in this module writes it
 * anywhere — no storage, no URL, no log, no second component. The section
 * holds it in React state until the member dismisses the show-once panel, and
 * that state is the whole of its lifetime (surface security item e).
 *
 * EVERY OPERATION HERE IS HUMAN-ONLY, at the facade (`humanOnly` in the
 * catalog, `requireHumanSession`) and again in SQL
 * (`internal.require_human_auth_kind()`): a token that acts as a member is
 * minted by that member, never by their agent carrying their identity. A
 * refusal is rendered as a refusal, never swallowed.
 */
import type { McpTokenCreateResult, McpTokenView } from '@tm8/contract';
import type { HttpClient } from '../data/real/http';
import type { Seam } from '../data/seam';

/** A space the viewer belongs to: the picker's rows, and the names a row reads. */
export interface McpTokenSpace {
  id: string;
  name: string;
}

export interface McpTokenCreateFields {
  label: string;
  /**
   * REQUIRED and nullable, exactly as the contract has it: `null` is "every
   * Space I belong to now or join later", which is a choice with real reach,
   * so no code path here may reach it by leaving a field out.
   */
  spaceIds: string[] | null;
  /** 30 / 90 / 365 or a custom day count. Absent takes the server's 90. */
  expiresInDays?: number;
}

export interface McpTokensPort {
  list(): Promise<McpTokenView[]>;
  /** The one response that carries a secret. Called once per [Create]. */
  create(fields: McpTokenCreateFields): Promise<McpTokenCreateResult>;
  revoke(tokenId: string): Promise<McpTokenView>;
  /** The viewer's spaces, for the picker and for naming a listed space. */
  spaces(): Promise<McpTokenSpace[]>;
}

const mutation = () => ({ clientMutationId: `mcp-token-${crypto.randomUUID()}` });

/**
 * Built on the transport rather than on a seam method per operation, the same
 * shape `mcp/adapter.ts` uses: these three operations are node-level — a token
 * carries a Space ARRAY and is minted outside any one Space — so there is no
 * space id to bind the port to.
 */
export function createMcpTokensPort(http: HttpClient, seam: Pick<Seam, 'spaces'>): McpTokensPort {
  return {
    list: async () => (await http.call<{ items: McpTokenView[] }>('mcp.tokens.list')).items,
    create: (fields) => http.call<McpTokenCreateResult>('mcp.tokens.create', {
      body: {
        ...mutation(),
        label: fields.label,
        spaceIds: fields.spaceIds,
        ...(fields.expiresInDays === undefined ? {} : { expiresInDays: fields.expiresInDays }),
      },
    }),
    revoke: (tokenId) => http.call<McpTokenView>('mcp.tokens.revoke', { params: { tokenId }, body: mutation() }),
    spaces: async () => (await seam.spaces()).map((space) => ({ id: space.id, name: space.name })),
  };
}
