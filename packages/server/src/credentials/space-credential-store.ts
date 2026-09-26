/**
 * The SPACE CREDENTIAL store (migration 206, design 01a0cfa8): typed wrappers
 * for every 206 RPC, and the only module that seals or opens a space
 * credential's secret.
 *
 * Sealed as 203's service keys are: AES-256-GCM under the node key, but bound
 * to `<space_id>|<credential_id>|<provider>` (`SpaceSecretBinding`), so a
 * ciphertext copied to another row, another space or a member table does not
 * open. The id is chosen HERE, before sealing, because the seal binds it.
 *
 * No catalog operation lives here (SC-3 owns those) and nothing here decides
 * a launch's source (SC-2). The secret is never logged, never put in an error
 * and never returned by anything but `readForSpawn` (I5). Management methods
 * are human-only in SQL (`internal.require_human_auth_kind`, I2); callers add
 * the facade gate on top.
 */
import { randomUUID } from 'node:crypto';

import type { Db, DbClaims } from '../db/types.js';
import { refuseLinkBearer } from '../identity/link-bearer.js';
import { loadOrCreateCredentialKey } from './credential-key.js';
import { openSecret, sealSecret } from './secret-box.js';

export const SPACE_CREDENTIAL_PROVIDERS = ['anthropic', 'openai', 'github'] as const;
export type SpaceCredentialProvider = (typeof SPACE_CREDENTIAL_PROVIDERS)[number];

export const SPACE_CREDENTIAL_SHAPES = ['login', 'api_key', 'token'] as const;
export type SpaceCredentialShape = (typeof SPACE_CREDENTIAL_SHAPES)[number];

export type SpaceCredentialStatus = 'pending' | 'active' | 'stale' | 'revoked';

/** A launch source as a space policy names it (D5). */
export type SpaceCredentialSource = 'member' | 'space' | 'node';

/** How many trailing characters of a key the screen may show. */
export const SPACE_CREDENTIAL_HINT_LENGTH = 4;

/** Who may launch on a credential (doc 13 §3a): its owner only, or every member. */
export type SpaceCredentialVisibility = 'private' | 'public';

/** A live session another launcher holds on a credential just made private. */
export interface SpaceCredentialKillSession {
  workSessionId: string;
  provider: SpaceCredentialProvider;
  launcherAccountId: string | null;
  status: 'spawning' | 'running' | 'idle';
}

/** Metadata only — 206 answers no secret column to anything but the spawn reader. */
export interface SpaceCredential {
  id: string;
  spaceId: string;
  provider: SpaceCredentialProvider;
  shape: SpaceCredentialShape;
  label: string;
  isDefault: boolean;
  status: SpaceCredentialStatus;
  createdByAccountId: string | null;
  /** Null = space-owned (always public). Doc 13 §7, migration 239. */
  ownerAccountId: string | null;
  visibility: SpaceCredentialVisibility;
  mayBeSpaceDefault: boolean;
  /** Masked to null by visibility (R3): private, owner only; public, every member (206 picker contract). */
  displayLogin: string | null;
  keyHint: string | null;
  pendingExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
  lastProbeAt: string | null;
}

export interface SpaceCredentialLogin {
  workSessionId: string;
  spaceId: string;
  provider: SpaceCredentialProvider;
  expiresAt: string;
  credential: SpaceCredential;
}

export interface SpaceCredentialLoginFinish {
  workSessionId: string;
  finished: true;
  connected: boolean;
  credential: SpaceCredential;
}

/** The directory key of a login credential's file home (design §3). */
export interface SpaceCredentialHomeKey {
  spaceId: string;
  credentialId: string;
  provider: SpaceCredentialProvider;
}

/** What the spawn path gets: a plaintext string, or where a login lives. */
export type SpaceCredentialForSpawn =
  | {
      kind: 'secret';
      credentialId: string;
      spaceId: string;
      provider: SpaceCredentialProvider;
      shape: 'api_key' | 'token';
      label: string;
      displayLogin: string | null;
      secret: string;
    }
  | {
      kind: 'login';
      credentialId: string;
      spaceId: string;
      provider: SpaceCredentialProvider;
      shape: 'login';
      label: string;
      displayLogin: string | null;
      home: SpaceCredentialHomeKey;
    };

export interface SpaceCredentialLiveSessions {
  credentialId: string;
  sessions: Array<{ workSessionId: string; provider: SpaceCredentialProvider; launcherAccountId: string | null; status: string }>;
  loginTerminals: Array<{ workSessionId: string; accountId: string; expiresAt: string }>;
}

export interface MemberSpaceCredentialSessions {
  /** Null when the question spanned every space. */
  spaceId: string | null;
  accountId: string;
  sessions: Array<{
    workSessionId: string;
    provider: SpaceCredentialProvider;
    spaceId: string;
    spaceCredentialId: string;
    status: string;
  }>;
}

export interface SpaceCredentialMyDefault {
  spaceId: string;
  provider: SpaceCredentialProvider;
  credentialId: string | null;
}

/** How a launch picked its space credential (§6c); null on rows recorded before W10b. */
export type SpaceCredentialPick = 'pinned' | 'my_default' | 'space_default';

export interface SpaceCredentialUsage {
  credentialId: string;
  sessions: Array<{
    workSessionId: string;
    provider: SpaceCredentialProvider;
    source: SpaceCredentialPick | null;
    credentialId: string;
    ownerAccountId: string | null;
    launcherAccountId: string | null;
    agentSessionId: string | null;
    status: string;
    recordedAt: string;
    updatedAt: string;
  }>;
}

/** One non-owner launch whose files in a shared login home are its own. */
export interface SpaceCredentialForeignLaunch {
  workSessionId: string;
  provider: string;
  /** Claude's `--session-id`; null for codex, whose rollout is found by marker. */
  nativeSessionId: string | null;
}

export interface SpaceCredentialUnusableSession {
  workSessionId: string;
  provider: SpaceCredentialProvider;
  credentialId: string;
  status: 'spawning' | 'running' | 'idle';
  reason: 'revoked' | 'private';
}

export interface RepointedSessionSpaceCredentials {
  workSessionId: string;
  launcherAccountId: string;
  credentials: Array<{ provider: SpaceCredentialProvider; spaceCredentialId: string }>;
}

/** Absent provider = every source allowed. */
export type SpaceCredentialPolicy = Partial<Record<SpaceCredentialProvider, SpaceCredentialSource[]>>;
/** Absent provider = node fallback allowed. */
export type NodeCredentialPolicy = Partial<Record<SpaceCredentialProvider, boolean>>;

interface SpawnRow {
  credentialId: string;
  spaceId: string;
  provider: SpaceCredentialProvider;
  shape: SpaceCredentialShape;
  label: string;
  displayLogin: string | null;
  secretCiphertext: string | null;
  secretNonce: string | null;
}

interface MetadataRow {
  space_id: string;
  provider: SpaceCredentialProvider;
}

export interface DbSpaceCredentialStoreOptions {
  db: Db;
  dataDir: string;
  logger?: { warn?: (message: string, fields?: Record<string, unknown>) => void };
}

function normaliseSecret(secret: string): string {
  const value = secret.trim();
  // Neither the value nor its length is echoed.
  if (value.length < SPACE_CREDENTIAL_HINT_LENGTH) throw new Error('credential is too short');
  return value;
}

export class DbSpaceCredentialStore {
  private readonly db: Db;
  private readonly dataDir: string;
  private readonly logger: DbSpaceCredentialStoreOptions['logger'];

  constructor(options: DbSpaceCredentialStoreOptions) {
    this.db = options.db;
    this.dataDir = options.dataDir;
    this.logger = options.logger;
  }

  /** Whether 206 is applied on this node. Absent is "unknown", never "no credential". */
  async present(claims: DbClaims): Promise<boolean> {
    const [row] = await this.db.query<{ present: boolean }>(
      claims,
      `select to_regclass('public.space_credentials') is not null as present`,
    );
    return row?.present === true;
  }

  /**
   * A space's credentials, metadata only, through the member RLS policy and
   * the column grant. Revoked tombstones are left out unless asked for.
   */
  async list(claims: DbClaims, spaceId: string, options: { includeRevoked?: boolean } = {}): Promise<SpaceCredential[]> {
    // R3: key_hint and display_login are not granted to tm8_app; the definer
    // reader masks them per caller.
    return this.db.rpc<SpaceCredential[]>(claims, 'list_space_credentials', [
      spaceId,
      options.includeRevoked === true,
    ]);
  }

  /** One card by id, masked like `list`; null when absent or not the caller's space. */
  async read(claims: DbClaims, credentialId: string): Promise<SpaceCredential | null> {
    return this.db.rpc<SpaceCredential | null>(claims, 'read_space_credential', [credentialId]);
  }

  /**
   * Seal and store a pasted api_key/token (D1: any member). The caller has
   * already probed it with the vendor (I6). A login is `startLogin` instead.
   */
  async create(
    claims: DbClaims,
    input: {
      spaceId: string;
      provider: SpaceCredentialProvider;
      shape: 'api_key' | 'token';
      label: string;
      secret: string;
      displayLogin?: string | null;
      /** E1: an owned credential's visibility. Exclusive with `spaceOwned`. */
      visibility?: SpaceCredentialVisibility | null;
      /** E1: nobody owns it; always public, never claimable. */
      spaceOwned?: boolean | null;
      /** An owned public credential's consent to be the space default (§3e). */
      mayBeSpaceDefault?: boolean;
    },
  ): Promise<SpaceCredential> {
    const secret = normaliseSecret(input.secret);
    const credentialId = randomUUID();
    // The AAD must be the text Postgres hands back to the spawn reader. A uuid
    // column accepts uppercase, braced and unhyphenated input but answers the
    // canonical form, so an id sealed as given never opens: seal under
    // Postgres's own rendering of it, as rekey seals under the stored row.
    const [canonical] = await this.db.query<{ space_id: string }>(
      claims,
      'select $1::uuid::text as space_id',
      [input.spaceId],
    );
    const spaceId = canonical!.space_id;
    const sealed = sealSecret(await this.key(), secret, {
      spaceId,
      credentialId,
      provider: input.provider,
    });
    return this.db.rpc<SpaceCredential>(claims, 'create_space_credential', [
      credentialId,
      spaceId,
      input.provider,
      input.shape,
      input.label,
      secret.slice(-SPACE_CREDENTIAL_HINT_LENGTH),
      sealed.ciphertext,
      sealed.nonce,
      input.displayLogin ?? null,
      input.visibility ?? null,
      input.spaceOwned ?? null,
      input.mayBeSpaceDefault ?? false,
    ]);
  }

  /**
   * Open a login terminal onto a new pending credential (no `credentialId`,
   * any member) or onto an existing one (creator or space admin, D11).
   */
  async startLogin(
    claims: DbClaims,
    input: {
      spaceId: string;
      provider: 'anthropic' | 'openai';
      label?: string | null;
      credentialId?: string | null;
      ttlSeconds?: number;
      sessionCap?: number;
    },
  ): Promise<SpaceCredentialLogin> {
    return this.db.rpc<SpaceCredentialLogin>(claims, 'start_space_credential_login', [
      input.spaceId,
      input.provider,
      input.label ?? null,
      input.credentialId ?? null,
      input.ttlSeconds ?? 900,
      input.sessionCap ?? 2,
    ]);
  }

  /**
   * Close a space login with the probe's verdict. On a REVOKED credential,
   * `ok = false` only stamps the terminal finished (the opener, the creator or
   * a space admin may; delete's second step), and `ok = true` is refused.
   */
  async finishLogin(
    claims: DbClaims,
    workSessionId: string,
    ok: boolean,
    displayLogin?: string | null,
  ): Promise<SpaceCredentialLoginFinish> {
    return this.db.rpc<SpaceCredentialLoginFinish>(claims, 'finish_space_credential_login', [
      workSessionId,
      ok,
      displayLogin ?? null,
    ]);
  }

  /** Rotate an api_key/token (owned: the owner; space-owned: creator or space admin; D7: next spawn or resume). */
  async rekey(
    claims: DbClaims,
    credentialId: string,
    newSecret: string,
    displayLogin?: string | null,
  ): Promise<SpaceCredential> {
    const secret = normaliseSecret(newSecret);
    // space_id and provider never change, so reading them before the locked
    // RPC cannot bind the seal to a stale value; a row the caller cannot see
    // fails here the same way the RPC would.
    const [row] = await this.db.query<MetadataRow>(
      claims,
      'select space_id, provider from public.space_credentials where id = $1',
      [credentialId],
    );
    if (!row) throw new Error('space credential not found');
    const sealed = sealSecret(await this.key(), secret, {
      spaceId: row.space_id,
      credentialId,
      provider: row.provider,
    });
    return this.db.rpc<SpaceCredential>(claims, 'rekey_space_credential', [
      credentialId,
      secret.slice(-SPACE_CREDENTIAL_HINT_LENGTH),
      sealed.ciphertext,
      sealed.nonce,
      displayLogin ?? null,
    ]);
  }

  async rename(claims: DbClaims, credentialId: string, label: string): Promise<SpaceCredential> {
    return this.db.rpc<SpaceCredential>(claims, 'rename_space_credential', [credentialId, label]);
  }

  async setDefault(claims: DbClaims, credentialId: string): Promise<SpaceCredential> {
    return this.db.rpc<SpaceCredential>(claims, 'set_space_credential_default', [credentialId]);
  }

  /**
   * W10b: the owner allows (or withdraws) their public credential as the
   * space default. Withdrawing clears `isDefault` in the same statement.
   */
  async setSpaceDefaultConsent(claims: DbClaims, credentialId: string, allowed: boolean): Promise<SpaceCredential> {
    return this.db.rpc<SpaceCredential>(claims, 'set_space_credential_default_consent', [credentialId, allowed]);
  }

  /** W10b: the creator of an unclaimed space-owned row (a migrated one) becomes its owner. */
  async claim(claims: DbClaims, credentialId: string): Promise<SpaceCredential> {
    return this.db.rpc<SpaceCredential>(claims, 'claim_space_credential', [credentialId]);
  }

  /** W10b: the caller's own default for this provider in this space; must be a credential they own. */
  async setMyDefault(claims: DbClaims, credentialId: string): Promise<SpaceCredentialMyDefault> {
    return this.db.rpc<SpaceCredentialMyDefault>(claims, 'set_my_space_credential_default', [credentialId]);
  }

  async clearMyDefault(
    claims: DbClaims,
    spaceId: string,
    provider: SpaceCredentialProvider,
  ): Promise<SpaceCredentialMyDefault & { cleared: boolean }> {
    return this.db.rpc<SpaceCredentialMyDefault & { cleared: boolean }>(
      claims,
      'clear_my_space_credential_default',
      [spaceId, provider],
    );
  }

  /** The auto rung's lookup: the launcher's own active default, or null. Works under agent claims. */
  async myDefaultId(claims: DbClaims, spaceId: string, provider: SpaceCredentialProvider): Promise<string | null> {
    return this.db.rpc<string | null>(claims, 'my_space_credential_default_id', [spaceId, provider]);
  }

  /** §6c: launches on a credential. The owner; admins too for public or space-owned. */
  async usage(claims: DbClaims, credentialId: string, limit?: number): Promise<SpaceCredentialUsage> {
    return this.db.rpc<SpaceCredentialUsage>(claims, 'space_credential_usage', [credentialId, limit ?? 100]);
  }

  /**
   * R8: every live session whose recorded credential is revoked, or private
   * and launched by someone else. Node admin (the server's sweep claims).
   */
  async unusableSessions(claims: DbClaims, limit?: number): Promise<SpaceCredentialUnusableSession[]> {
    return this.db.rpc<SpaceCredentialUnusableSession[]>(
      claims,
      'sweep_unusable_space_credential_sessions',
      [limit ?? 200],
    );
  }

  /**
   * The narrow login-home scrub's reader: exited non-owner launches on the
   * caller's own PRIVATE login credential, each attributable to that launch
   * alone (never re-pointed). The owner only; empty for any other shape.
   */
  async foreignLaunches(claims: DbClaims, credentialId: string): Promise<SpaceCredentialForeignLaunch[]> {
    return this.db.rpc<SpaceCredentialForeignLaunch[]>(claims, 'space_credential_foreign_launches', [credentialId, 500]);
  }

  /** A probe's verdict on an existing credential: active or stale (I6). */
  async recordProbe(claims: DbClaims, credentialId: string, ok: boolean): Promise<SpaceCredential> {
    return this.db.rpc<SpaceCredential>(claims, 'record_space_credential_probe', [credentialId, ok]);
  }

  /**
   * W10a: the owner switches their credential public or private. Going
   * private clears `mayBeSpaceDefault` and `isDefault` in the same statement
   * and returns `killSessions`: the live sessions (spawning included) whose
   * launcher is not the owner. Killing them is the caller's.
   */
  async setVisibility(
    claims: DbClaims,
    credentialId: string,
    visibility: SpaceCredentialVisibility,
  ): Promise<SpaceCredential & { killSessions: SpaceCredentialKillSession[] }> {
    return this.db.rpc<SpaceCredential & { killSessions: SpaceCredentialKillSession[] }>(
      claims,
      'set_space_credential_visibility',
      [credentialId, visibility],
    );
  }

  /**
   * Step 1 of delete (design §5): revoke the row and drop its sealed bytes.
   * `revoked` is false when it already was. Killing sessions
   * (`liveSessions`) and removing a login's file home are the caller's.
   */
  async revoke(claims: DbClaims, credentialId: string): Promise<SpaceCredential & { revoked: boolean }> {
    return this.db.rpc<SpaceCredential & { revoked: boolean }>(claims, 'delete_space_credential', [credentialId]);
  }

  /** Live agent sessions and open login terminals on a credential, whoever launched them. */
  async liveSessions(claims: DbClaims, credentialId: string): Promise<SpaceCredentialLiveSessions> {
    return this.db.rpc<SpaceCredentialLiveSessions>(claims, 'space_credential_live_sessions', [credentialId]);
  }

  /** Live sessions a member launched on this space's credentials (SC-6). */
  /** A null `spaceId` asks across every space (node admin, or the account itself). */
  async memberSessions(
    claims: DbClaims,
    spaceId: string | null,
    accountId: string,
  ): Promise<MemberSpaceCredentialSessions> {
    return this.db.rpc<MemberSpaceCredentialSessions>(claims, 'member_space_credential_sessions', [spaceId, accountId]);
  }

  /**
   * The spawn reader (A1). The pinned credential, or the launch space's
   * default when `credentialId` is null; refused unless the caller is a member
   * of the LAUNCH space and the credential is active and in it. Works under
   * agent claims: children inherit. Never under a link session's own claims
   * (ruling A'; SQL refuses it too).
   */
  async readForSpawn(
    claims: DbClaims,
    launchSpaceId: string,
    provider: SpaceCredentialProvider,
    credentialId?: string | null,
  ): Promise<SpaceCredentialForSpawn> {
    refuseLinkBearer(claims);
    const row = await this.db.rpc<SpawnRow>(claims, 'read_space_credential_for_spawn', [
      launchSpaceId,
      provider,
      credentialId ?? null,
    ]);
    const base = {
      credentialId: row.credentialId,
      spaceId: row.spaceId,
      provider: row.provider,
      label: row.label,
      displayLogin: row.displayLogin,
    };
    if (row.shape === 'login') {
      return {
        ...base,
        kind: 'login',
        shape: 'login',
        home: { spaceId: row.spaceId, credentialId: row.credentialId, provider: row.provider },
      };
    }
    if (!row.secretCiphertext || !row.secretNonce) throw new Error('stored space credential is unreadable');
    try {
      const secret = openSecret(
        await this.key(),
        { ciphertext: Buffer.from(row.secretCiphertext, 'base64'), nonce: Buffer.from(row.secretNonce, 'base64') },
        { spaceId: row.spaceId, credentialId: row.credentialId, provider: row.provider },
      );
      return { ...base, kind: 'secret', shape: row.shape, secret };
    } catch (error) {
      this.logger?.warn?.('space credential could not be decrypted', {
        credentialId: row.credentialId,
        provider: row.provider,
        reason: error instanceof Error ? error.name : 'unknown',
      });
      throw new Error('stored space credential is unreadable');
    }
  }

  /** Resume (C3): the resumer becomes the launcher, if every recorded credential is still active. */
  /**
   * With `providers` (R13), rows for every provider the resume did not resolve
   * to a space credential are dropped first, in the same transaction.
   */
  async repointSession(
    claims: DbClaims,
    workSessionId: string,
    providers?: readonly SpaceCredentialProvider[],
  ): Promise<RepointedSessionSpaceCredentials> {
    const args: unknown[] = providers ? [workSessionId, [...providers]] : [workSessionId];
    return this.db.rpc<RepointedSessionSpaceCredentials>(claims, 'repoint_session_space_credentials', args);
  }

  async readSpacePolicy(claims: DbClaims, spaceId: string): Promise<SpaceCredentialPolicy> {
    return this.db.rpc<SpaceCredentialPolicy>(claims, 'read_space_credential_policy', [spaceId]);
  }

  /** Space admin. `null` removes the provider's policy (every source allowed). */
  async setSpacePolicy(
    claims: DbClaims,
    spaceId: string,
    provider: SpaceCredentialProvider,
    allowedSources: SpaceCredentialSource[] | null,
  ): Promise<{ spaceId: string; provider: SpaceCredentialProvider; allowedSources: SpaceCredentialSource[] | null }> {
    return this.db.rpc(claims, 'set_space_credential_policy', [spaceId, provider, allowedSources]);
  }

  async readNodePolicy(claims: DbClaims): Promise<NodeCredentialPolicy> {
    return this.db.rpc<NodeCredentialPolicy>(claims, 'read_node_credential_policy', []);
  }

  /** Node admin. `null` removes the provider's policy (node fallback allowed). */
  async setNodePolicy(
    claims: DbClaims,
    provider: SpaceCredentialProvider,
    allowNode: boolean | null,
  ): Promise<{ provider: SpaceCredentialProvider; allowNode: boolean | null }> {
    return this.db.rpc(claims, 'set_node_credential_policy', [provider, allowNode]);
  }

  /** The pending-login sweep. Returns how many expired pending credentials it removed. */
  async expirePending(claims: DbClaims): Promise<number> {
    const result = await this.db.rpc<{ expired: number }>(claims, 'expire_pending_space_credentials', []);
    return result.expired;
  }

  private key(): Promise<Buffer> {
    return loadOrCreateCredentialKey(this.dataDir);
  }
}
