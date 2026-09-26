/**
 * The SPACE LINK store (migrations 250/251, plan 01a0d9eb §3 W6): typed
 * wrappers for the spaceLinks.* RPCs, and the only module that seals or opens
 * a member's stored link session.
 *
 * Sealed as 206's space credentials are: AES-256-GCM under the node key, bound
 * to `<home_space_id>|<link_id>|<member_id>|<target_space_id>`
 * (`SpaceLinkSecretBinding`). The binding is RECOMPUTED from the row's columns
 * on open, never read from the stored `aad`, so a ciphertext copied to another
 * row, member or target does not open (T19).
 *
 * The plaintext is a `link` auth session token minted here: session id and
 * secret generated in this process, only the sha256 sent to SQL. The token is
 * never logged, never put in an error, and returned only by `use`, to the
 * server-side caller that forwards it (W7). Management is human-only in SQL
 * (the strict `internal.require_human_auth_kind`).
 */
import { randomUUID } from 'node:crypto';

import type { Db, DbClaims } from '../db/types.js';
import { isCollabError } from '@tm8/contract';
import { formatToken, generateSecret, hashToken } from '../identity/crypto.js';
import { isInvalidTokenError, resolveBearerIdentity, type ResolvedAuthSession } from '../identity/pg-auth.js';
import { DEFAULT_SESSION_TTL_MS } from '../identity/service.js';
import { loadOrCreateCredentialKey } from './credential-key.js';
import { bindingAad, openSecret, sealSecret, type SpaceLinkSecretBinding } from './secret-box.js';

export type SpaceLinkStatus = 'signed_in' | 'signed_out' | 'left' | 'unreachable';

/** The caller's own row: metadata only, never the sealed bytes. */
export interface SpaceLinkMine {
  memberId: string;
  status: SpaceLinkStatus;
  allowSpawn: boolean;
  spawnBudget: number;
  alias: string | null;
  sessionId: string | null;
  expiresAt: string | null;
  lastUsedAt: string | null;
}

/** One link as a home-space member sees it (251 `internal.space_link_json`). */
export interface SpaceLink {
  id: string;
  homeSpaceId: string;
  targetSpaceId: string;
  targetServerId: string | null;
  /** Only when the caller is a member of the target (P8). */
  targetSpaceName: string | null;
  createdAt: string;
  statusSummary: { signedIn: number; signedOut: number; left: number; unreachable: number };
  mine: SpaceLinkMine | null;
}

interface OpenedRow {
  linkId: string;
  homeSpaceId: string;
  memberId: string;
  targetSpaceId: string;
  sessionId: string;
  allowSpawn: boolean;
  spawnBudget: number;
  ciphertext: string;
  nonce: string;
}

/** A usable link: the target identity it resolves to, and the bearer to present. */
export interface SpaceLinkUse {
  linkId: string;
  targetSpaceId: string;
  allowSpawn: boolean;
  spawnBudget: number;
  session: ResolvedAuthSession;
  /** The stored bearer. Forward it; never log it. */
  token: string;
}

/** Why a use failed. `signed_out`/`left`/`unreachable` are terminal until a human acts. */
export class SpaceLinkUnusable extends Error {
  constructor(readonly linkId: string, readonly status: SpaceLinkStatus | 'unreadable') {
    super(`space link is ${status}`);
    this.name = 'SpaceLinkUnusable';
  }
}

export interface SpaceLinkStaleNotice {
  linkId: string;
  status: SpaceLinkStatus;
  /** The work session that was using the link, if an agent was. */
  callerWorkSessionId?: string;
}

export interface DbSpaceLinkStoreOptions {
  db: Db;
  dataDir: string;
  logger?: { warn?: (message: string, fields?: Record<string, unknown>) => void };
  /**
   * Called once when a use marks a link stale (messages the calling agent session).
   *
   * W7-BOUND. Nothing in W6 calls `use()` outside tests: the only path that
   * presents a stored link session to the target is W7's cross-space invoke,
   * which owns the caller's claims and work session. So the composition root
   * wires no `onStale` yet. The member's half needs no hook: 251's
   * `mark_space_link_stale` and the leave/remove trigger raise attention in
   * SQL. The agent-message half lands with W7's caller.
   */
  onStale?: (notice: SpaceLinkStaleNotice) => Promise<void> | void;
  now?: () => number;
}

export class DbSpaceLinkStore {
  private readonly db: Db;
  private readonly dataDir: string;
  private readonly logger: DbSpaceLinkStoreOptions['logger'];
  private readonly onStale: DbSpaceLinkStoreOptions['onStale'];
  private readonly now: () => number;

  constructor(options: DbSpaceLinkStoreOptions) {
    this.db = options.db;
    this.dataDir = options.dataDir;
    this.logger = options.logger;
    this.onStale = options.onStale;
    this.now = options.now ?? Date.now;
  }

  list(claims: DbClaims, spaceId: string): Promise<SpaceLink[]> {
    return this.db.rpc<SpaceLink[]>(claims, 'list_space_links', [spaceId]);
  }

  add(claims: DbClaims, input: { spaceId: string; targetSpaceId: string; alias?: string | null; clientMutationId?: string | null }): Promise<SpaceLink> {
    return this.db.rpc<SpaceLink>(claims, 'add_space_link', [
      input.spaceId, input.targetSpaceId, input.alias ?? null, input.clientMutationId ?? null,
    ]);
  }

  /**
   * Mint a `link` session for the target and store it sealed. `relogin`
   * replaces the row's session in place; SQL revokes the old one.
   */
  async login(
    claims: DbClaims,
    linkId: string,
    options: { relogin?: boolean; clientMutationId?: string | null } = {},
  ): Promise<SpaceLink> {
    const binding = await this.db.rpc<SpaceLinkSecretBinding>(claims, 'space_link_seal_context', [linkId]);
    const sessionId = randomUUID();
    const secret = generateSecret();
    const sealed = sealSecret(await this.key(), formatToken(sessionId, secret), binding);
    const expiresAt = new Date(this.now() + DEFAULT_SESSION_TTL_MS.link).toISOString();
    return this.db.rpc<SpaceLink>(claims, 'store_space_link_session', [
      linkId, sessionId, hashToken(secret), expiresAt, sealed.ciphertext, sealed.nonce,
      options.relogin ? 'spaceLinks.relogin' : 'spaceLinks.login', options.clientMutationId ?? null,
    ]);
  }

  logout(claims: DbClaims, linkId: string, clientMutationId?: string | null): Promise<SpaceLink> {
    return this.db.rpc<SpaceLink>(claims, 'logout_space_link', [linkId, clientMutationId ?? null]);
  }

  remove(claims: DbClaims, linkId: string, clientMutationId?: string | null): Promise<SpaceLink> {
    return this.db.rpc<SpaceLink>(claims, 'remove_space_link', [linkId, clientMutationId ?? null]);
  }

  setSpawn(
    claims: DbClaims,
    input: { linkId: string; allowSpawn: boolean; spawnBudget?: number | null; clientMutationId?: string | null },
  ): Promise<SpaceLink> {
    return this.db.rpc<SpaceLink>(claims, 'set_space_link_spawn', [
      input.linkId, input.allowSpawn, input.spawnBudget ?? null, input.clientMutationId ?? null,
    ]);
  }

  /**
   * The use path (W7's invoke calls this). Opens the caller's own row and
   * checks the stored session still resolves on the target. A refusal (401)
   * marks the link `signed_out` with NO retry, raises attention for the member
   * (SQL) and tells `onStale` so a calling agent session is messaged.
   */
  async use(claims: DbClaims, linkId: string, caller: { workSessionId?: string } = {}): Promise<SpaceLinkUse> {
    let row: OpenedRow;
    try {
      row = await this.db.rpc<OpenedRow>(claims, 'open_space_link_token', [linkId]);
    } catch (error) {
      const status = statusOf(error);
      if (status) throw new SpaceLinkUnusable(linkId, status);
      throw error;
    }
    let token: string;
    try {
      token = openSecret(
        await this.key(),
        { ciphertext: Buffer.from(row.ciphertext, 'base64'), nonce: Buffer.from(row.nonce, 'base64') },
        { homeSpaceId: row.homeSpaceId, linkId: row.linkId, memberId: row.memberId, targetSpaceId: row.targetSpaceId },
      );
    } catch (error) {
      this.logger?.warn?.('space link session could not be decrypted', {
        linkId,
        reason: error instanceof Error ? error.name : 'unknown',
      });
      throw new SpaceLinkUnusable(linkId, 'unreadable');
    }
    let session: ResolvedAuthSession;
    try {
      session = await resolveBearerIdentity(this.db, token);
    } catch (error) {
      // Only a token the target no longer honours is `signed_out` (review
      // D2). A pool timeout, statement_timeout or restart says nothing about
      // the token, and marking stale on it would revoke every link on one
      // saturated minute. Those propagate; the link stays signed_in.
      if (!isInvalidTokenError(error)) throw error;
      await this.markStale(claims, linkId, 'signed_out', caller);
      throw new SpaceLinkUnusable(linkId, 'signed_out');
    }
    return {
      linkId: row.linkId,
      targetSpaceId: row.targetSpaceId,
      allowSpawn: row.allowSpawn,
      spawnBudget: row.spawnBudget,
      session,
      token,
    };
  }

  /** A use found the link dead. No retry: the row is marked and the member told. */
  async markStale(
    claims: DbClaims,
    linkId: string,
    status: 'signed_out' | 'unreachable',
    caller: { workSessionId?: string } = {},
  ): Promise<SpaceLink> {
    const link = await this.db.rpc<SpaceLink>(claims, 'mark_space_link_stale', [linkId, status]);
    try {
      await this.onStale?.({ linkId, status, ...(caller.workSessionId ? { callerWorkSessionId: caller.workSessionId } : {}) });
    } catch (error) {
      this.logger?.warn?.('space link stale notice failed', {
        linkId,
        reason: error instanceof Error ? error.message : 'unknown',
      });
    }
    return link;
  }

  private key(): Promise<Buffer> {
    return loadOrCreateCredentialKey(this.dataDir);
  }
}

/** The `aad` column value for a binding: what 251's CHECK holds the row to. */
export function spaceLinkAad(binding: SpaceLinkSecretBinding): string {
  return bindingAad(binding);
}

function statusOf(error: unknown): SpaceLinkStatus | null {
  // translateDbError spreads the RPC's JSON DETAIL into `details`.
  if (!isCollabError(error) || error.details?.['sqlstate'] !== '23514') return null;
  const status = error.details?.['status'];
  return status === 'signed_out' || status === 'left' || status === 'unreachable' ? status : null;
}
