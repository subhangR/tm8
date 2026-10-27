/**
 * Filesystem path grants (migration 282; space-scoped projects design, doc
 * 01a0fb62 §4, lane L1).
 *
 * A node admin lets ONE account browse ONE root and select a folder under it.
 * Two layers, as for every node-admin write: here, the server-resolved
 * `nodeAdmin` claim (which `claimsFor` already clears for a space-pinned
 * session, K6); in SQL, `internal.require_gate_admin()`.
 *
 * THE PATH IS DECIDED HERE, NOT IN SQL. A root is realpath'd and required inside
 * the canonical `TM8_PROJECT_ROOTS` before it is stored, and a member's grants
 * are realpath'd again on every browse (`grantedBrowseRoots`), so neither a
 * symlink in the request nor one swapped in later can widen a grant.
 */
import {
  CollabError,
  isHumanAuthKind,
  PathGrantCreateInputSchema,
  PathGrantRevokeInputSchema,
  type NodeAccountListView,
  type NodeAccountView,
  type PathGrantListView,
  type PathGrantView,
} from '@tm8/contract';

import type { DbClaims } from '../../../db/types.js';
import type { RequestContext } from '../../../http/types.js';
import { claimsFor } from '../../context.js';
import type { FacadeDeps } from '../../deps.js';
import { canonicalDirectory, canonicalRoots, grantedBrowseRoots, requireAllowed } from './project-directories.js';

/** `internal.path_grant_json` (282): nulls stripped, timestamps as Postgres prints them. */
interface PathGrantRow {
  id: string;
  accountId: string;
  rootPath: string;
  mode: 'select';
  grantedAt: string;
  revokedAt?: string;
  note?: string;
  grantee?: NodeAccountView;
  grantedBy?: { accountId: string; username: string };
}

function isoTimestamp(value: string): string {
  return new Date(value).toISOString();
}

export function pathGrantView(row: PathGrantRow): PathGrantView {
  return {
    ...row,
    grantedAt: isoTimestamp(row.grantedAt),
    ...(row.revokedAt ? { revokedAt: isoTimestamp(row.revokedAt) } : {}),
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class PathGrantsService {
  constructor(
    private readonly deps: Pick<FacadeDeps, 'db' | 'owner'>,
    /** Test seam; production reads `TM8_PROJECT_ROOTS`. */
    private readonly rawRoots?: readonly string[],
  ) {}

  /** `node.pathGrants.list` — every grant on the node; `?includeRevoked=true` adds the revoked ones. */
  readonly list = async (ctx: RequestContext): Promise<PathGrantListView> => {
    const claims = await this.adminClaims(ctx);
    const includeRevoked = ctx.query.get('includeRevoked') === 'true';
    const rows = await this.deps.db.rpc<PathGrantRow[]>(claims, 'list_path_grants', [includeRevoked]);
    return { grants: rows.map(pathGrantView) };
  };

  /** `node.pathGrants.create` — canonicalize, confine to the node's roots, store. */
  readonly create = async (ctx: RequestContext): Promise<PathGrantView> => {
    const claims = await this.adminClaims(ctx);
    const input = PathGrantCreateInputSchema.parse(ctx.body);
    const root = await canonicalDirectory(input.rootPath.trim());
    requireAllowed(root, await canonicalRoots(this.rawRoots ? [...this.rawRoots] : undefined));
    const row = await this.deps.db.rpc<PathGrantRow>(
      claims,
      'create_path_grant',
      [input.accountId, root, input.note ?? null],
    );
    return pathGrantView(row);
  };

  /** `node.pathGrants.revoke`. */
  readonly revoke = async (ctx: RequestContext): Promise<PathGrantView> => {
    const claims = await this.adminClaims(ctx);
    PathGrantRevokeInputSchema.parse(ctx.body ?? {});
    const grantId = ctx.params.grantId;
    if (!grantId || !UUID_RE.test(grantId)) {
      throw new CollabError('invalid_input', 'grantId must be a path grant id');
    }
    const row = await this.deps.db.rpc<PathGrantRow>(claims, 'revoke_path_grant', [grantId]);
    return pathGrantView(row);
  };

  /** `node.accounts.list` — who a grant can be addressed to. */
  readonly accounts = async (ctx: RequestContext): Promise<NodeAccountListView> => {
    const claims = await this.adminClaims(ctx);
    const accounts = await this.deps.db.rpc<NodeAccountView[]>(claims, 'list_node_accounts', []);
    return { accounts };
  };

  /** `identity.pathGrants.list` — the caller's own live grants. */
  readonly mine = async (ctx: RequestContext): Promise<PathGrantListView> => {
    const claims = claimsFor(await this.deps.owner(), ctx);
    const rows = await this.deps.db.rpc<PathGrantRow[]>(claims, 'my_path_grants', []);
    return { grants: rows.map(pathGrantView) };
  };

  /**
   * What `projects.directories.list` browses for a caller who is not a node
   * admin: their live grants ∩ the canonical roots. Empty means "no grant".
   */
  async browseRoots(claims: DbClaims): Promise<string[]> {
    const rows = await this.deps.db.rpc<PathGrantRow[]>(claims, 'my_path_grants', []);
    return grantedBrowseRoots(rows.map((row) => row.rootPath), this.rawRoots);
  }

  private async adminClaims(ctx: RequestContext): Promise<DbClaims> {
    // First, so an anonymous caller is `unauthenticated`, not `forbidden`.
    const claims = claimsFor(await this.deps.owner(), ctx);
    if (!isHumanAuthKind(ctx.identity.authKind)) {
      throw new CollabError('forbidden', 'filesystem path grants are managed from human sessions only', {
        details: { reason: 'human_session_required' },
      });
    }
    if (claims.nodeAdmin !== true) {
      throw new CollabError('forbidden', 'filesystem path grants are managed by node admins only', {
        details: { reason: 'node_admin_required' },
      });
    }
    return claims;
  }
}
