/**
 * The spawn loop's view of SPACE credentials (206): `SpaceCredentialPort` over
 * `DbSpaceCredentialStore`, plus the one status read the post-spawn recheck
 * needs (M7).
 *
 * Every call runs under the CALLER's claims. For an agent those are the root
 * human launcher's (the auth session's minting account), so membership, the
 * `last_used_at` stamp and the re-pointed launcher all follow the launcher,
 * never the persona's owner (C2/C3).
 *
 * Refusals come back as REASONS, not as errors, so the resolver can phrase a
 * sentence naming the fix (I3). Anything else — the database down, 206 absent —
 * is thrown and the spawn refuses on it. No secret reaches an error, a log line
 * or a returned reason (I5); a decrypt failure is reported as `unreadable`.
 */
import { join } from 'node:path';

import { CollabError } from '@tm8/contract';
import { SpawnError } from '@tm8/execution';
import type {
  GraphAuth,
  SpaceCredentialPolicies,
  SpaceCredentialPort,
  SpaceCredentialProvider,
  SpaceCredentialRead,
  SpaceCredentialRefusalReason,
  SpaceCredentialRepoint,
} from '@tm8/execution';

import type { Db, DbClaims } from '../db/types.js';
import { DbSpaceCredentialStore, type DbSpaceCredentialStoreOptions } from './space-credential-store.js';

const UNREADABLE_MESSAGE = 'stored space credential is unreadable';
const REFUSAL_REASONS: ReadonlySet<string> = new Set<SpaceCredentialRefusalReason>([
  'no_default',
  'not_found',
  'pending',
  'stale',
  'revoked',
  'not_usable',
]);

/** A login credential's file home (design §3); the provider dir sits under it. */
export function spaceCredentialLoginHome(dataDir: string, spaceId: string, credentialId: string): string {
  return join(dataDir, 'credentials', 'spaces', spaceId, credentialId);
}

function refusalReason(error: unknown): SpaceCredentialRefusalReason | null {
  if (!(error instanceof CollabError)) return null;
  const reason = error.details?.reason;
  return typeof reason === 'string' && REFUSAL_REASONS.has(reason)
    ? (reason as SpaceCredentialRefusalReason)
    : null;
}

export class DbSpaceCredentialPort implements SpaceCredentialPort {
  private readonly db: Db;
  private readonly store: DbSpaceCredentialStore;
  private readonly dataDir: string;

  constructor(options: { db: Db; store: DbSpaceCredentialStore; dataDir: string }) {
    this.db = options.db;
    this.store = options.store;
    this.dataDir = options.dataDir;
  }

  async readPolicies(auth: GraphAuth, spaceId: string): Promise<SpaceCredentialPolicies> {
    const claims = auth as DbClaims;
    try {
      const [space, node] = await Promise.all([
        this.store.readSpacePolicy(claims, spaceId),
        this.store.readNodePolicy(claims),
      ]);
      return { space, node };
    } catch (error) {
      // 206 reads the space policy only for a member. A non-member is a
      // refusal with a reason, not an unanswerable question to retry.
      if (error instanceof CollabError && error.details?.sqlstate === '42501') {
        throw new SpawnError(
          'you are not a member of this space, so you cannot launch or resume a session on its ' +
            'credentials — ask a space admin to add you',
          'forbidden',
          { spaceId },
        );
      }
      throw error;
    }
  }

  async read(
    auth: GraphAuth,
    spaceId: string,
    provider: SpaceCredentialProvider,
    credentialId: string | null,
  ): Promise<SpaceCredentialRead> {
    let found;
    try {
      found = await this.store.readForSpawn(auth as DbClaims, spaceId, provider, credentialId);
    } catch (error) {
      if (error instanceof Error && error.message === UNREADABLE_MESSAGE) {
        return { ok: false, reason: 'unreadable' };
      }
      const reason = refusalReason(error);
      if (reason) return { ok: false, reason };
      throw error;
    }
    // 206 already refuses a credential of another space; this is the second
    // lock on the same door, in the one place a wrong answer would inject.
    if (found.spaceId !== spaceId || found.provider !== provider) {
      return { ok: false, reason: 'not_found' };
    }
    if (found.kind === 'login') {
      return {
        ok: true,
        grant: {
          kind: 'login',
          credentialId: found.credentialId,
          provider: found.provider,
          label: found.label,
          displayLogin: found.displayLogin,
          homeDir: spaceCredentialLoginHome(this.dataDir, found.spaceId, found.credentialId),
        },
      };
    }
    return {
      ok: true,
      grant: {
        kind: 'secret',
        credentialId: found.credentialId,
        provider: found.provider,
        shape: found.shape,
        label: found.label,
        displayLogin: found.displayLogin,
        secret: found.secret,
      },
    };
  }

  async activeIds(auth: GraphAuth, credentialIds: readonly string[]): Promise<ReadonlySet<string>> {
    if (credentialIds.length === 0) return new Set();
    // The recorder's gate, asked again: active, in a space the caller still
    // belongs to, and public, space-owned or the launcher's own (R1). A
    // credential switched to private since commit is not usable here.
    const ids = await this.db.rpc<string[] | null>(auth as DbClaims, 'usable_space_credential_ids', [credentialIds]);
    return new Set(ids ?? []);
  }

  async myDefaultId(auth: GraphAuth, spaceId: string, provider: SpaceCredentialProvider): Promise<string | null> {
    return this.store.myDefaultId(auth as DbClaims, spaceId, provider);
  }

  async repointSession(
    auth: GraphAuth,
    sessionId: string,
    providers?: readonly SpaceCredentialProvider[],
  ): Promise<SpaceCredentialRepoint> {
    try {
      const result = await this.store.repointSession(auth as DbClaims, sessionId, providers);
      return { ok: true, credentials: result.credentials };
    } catch (error) {
      if (error instanceof CollabError && error.details?.sqlstate === '23514') {
        return { ok: false, reason: 'inactive' };
      }
      if (error instanceof CollabError && error.details?.reason === 'not_usable') {
        return { ok: false, reason: 'not_usable' };
      }
      throw error;
    }
  }
}

/** The port both execution constructions hand SpawnService, over one store. */
export function spaceCredentialPort(
  db: Db,
  dataDir: string,
  logger?: DbSpaceCredentialStoreOptions['logger'],
): DbSpaceCredentialPort {
  const store = new DbSpaceCredentialStore({ db, dataDir, ...(logger ? { logger } : {}) });
  return new DbSpaceCredentialPort({ db, store, dataDir });
}

// ─── Server-side GitHub (doc 01a0e248 §10.5, §10.6; stage S5) ──────────────
//
// The server's own GitHub calls — the tracking pollers and PR/commit
// hydration, and the UI merge — read their token HERE, from the space the
// pull request lives in, and from nowhere else. The node's environment
// (`TM8_GITHUB_TOKEN` → `GITHUB_TOKEN` → `GH_TOKEN`) was a second node rung
// (§2.4 item 8); it is deleted, and gate 6 bans reading it again.
//
//   * A POLLER reads the space's OWN credential: active, space-owned
//     (`owner_account_id is null`), public. Which one is S7's `canPoll`
//     answer, so the readiness a person sees and the token a poller spends are
//     one predicate, not two. None means the poller reads ANONYMOUSLY and says
//     why. A member's credential is never read by a poller, private or public:
//     a background job would otherwise be a side door onto someone's key.
//   * A MERGE reads the ACTING member's own credential in that space
//     (`owner_account_id` = the caller's account), their my_default first.
//     None refuses with the fix named. A space-owned or another member's
//     credential never merges: every write on the forge is attributable to
//     the person whose credential made it.
//
// Both open the secret through the spawn reader (`read_space_credential_for_spawn`
// with a pinned id), so the active and visibility checks, the AAD and the
// decrypt are the ones every launch already runs. Neither returns a secret
// in a reason, and neither ever throws on a missing credential.

/** A token a server-side GitHub call may spend, and which credential it is. */
export interface ServerGithubToken {
  readonly token: string;
  readonly credentialId: string;
  readonly label: string;
}

/** The pollers' read. `reason` is a sentence for a log or a job outcome; never a secret. */
export type PollGithubToken =
  | ({ readonly ok: true } & ServerGithubToken)
  | { readonly ok: false; readonly reason: string };

/** Why a member cannot merge. Each is phrased by `memberGithubRefusal`. */
export type MemberGithubRefusal = 'none' | 'stale' | 'unreadable';

export type MemberGithubToken =
  | ({ readonly ok: true } & ServerGithubToken)
  | { readonly ok: false; readonly reason: MemberGithubRefusal; readonly label?: string };

export interface ServerGithubCredentialReader {
  /** The project's space's own GitHub credential, or a reason to read anonymously. */
  readPollToken(claims: DbClaims, spaceId: string): Promise<PollGithubToken>;
  /** The caller's own GitHub credential in this space, or why there is none. */
  readMemberToken(claims: DbClaims, spaceId: string): Promise<MemberGithubToken>;
}

/** The sentence a refused merge carries. It names the fix (§10.6). */
export function memberGithubRefusal(refusal: { reason: MemberGithubRefusal; label?: string }): string {
  const where = 'under Space settings → Credentials';
  switch (refusal.reason) {
    case 'stale':
      return `your GitHub credential "${refusal.label ?? 'GitHub'}" in this space is stale — re-key it ${where}, then merge again`;
    case 'unreadable':
      return `your GitHub credential "${refusal.label ?? 'GitHub'}" in this space cannot be read on this node — re-key it ${where}, then merge again`;
    default:
      return `you have no GitHub credential of your own in this space — connect a GitHub token ${where} (owned by you), then merge again`;
  }
}

type ServerGithubStore = Pick<DbSpaceCredentialStore, 'readiness' | 'readForSpawn' | 'myDefaultId'>;

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class DbServerGithubCredentials implements ServerGithubCredentialReader {
  private readonly db: Pick<Db, 'query'>;
  private readonly store: ServerGithubStore;

  constructor(options: { db: Pick<Db, 'query'>; store: ServerGithubStore }) {
    this.db = options.db;
    this.store = options.store;
  }

  /**
   * NEVER THROWS. A poller that dies on an unreadable credential stops
   * refreshing everything, which is worse than refreshing anonymously and
   * saying why.
   */
  async readPollToken(claims: DbClaims, spaceId: string): Promise<PollGithubToken> {
    let credentialId: string | null;
    try {
      const readiness = await this.store.readiness(claims, spaceId);
      credentialId = readiness.canPoll.credentialId;
      if (!credentialId) {
        return {
          ok: false,
          reason: readiness.canPoll.reason === 'stale'
            ? 'the space\'s own GitHub credential is stale — re-key it under Space settings → Credentials'
            : 'the space has no space-owned GitHub credential — connect one under Space settings → Credentials',
        };
      }
    } catch (error) {
      if (error instanceof CollabError && error.details?.sqlstate === '42501') {
        return { ok: false, reason: 'the node owner is not a member of this space, so it reads no credential there' };
      }
      return { ok: false, reason: `the space's GitHub credential could not be looked up (${describe(error)})` };
    }
    try {
      const found = await this.store.readForSpawn(claims, spaceId, 'github', credentialId);
      if (found.kind !== 'secret') return { ok: false, reason: 'the space\'s GitHub credential holds no token' };
      return { ok: true, token: found.secret, credentialId: found.credentialId, label: found.label };
    } catch (error) {
      return { ok: false, reason: `the space's GitHub credential could not be read (${describe(error)})` };
    }
  }

  async readMemberToken(claims: DbClaims, spaceId: string): Promise<MemberGithubToken> {
    // RLS answers a non-member nothing, which refuses as `none`: the fix named
    // is still the right one once they are a member.
    const owned = await this.db.query<{ id: string; status: string; label: string }>(
      claims,
      `select id, status, label
         from public.space_credentials
        where space_id = $1 and provider = 'github'
          and owner_account_id = internal.current_account_id()
          and status in ('active', 'stale')
        order by created_at, id`,
      [spaceId],
    );
    const active = owned.filter((row) => row.status === 'active');
    if (active.length === 0) {
      const stale = owned[0];
      return stale ? { ok: false, reason: 'stale', label: stale.label } : { ok: false, reason: 'none' };
    }
    const myDefault = await this.store.myDefaultId(claims, spaceId, 'github');
    const chosen = active.find((row) => row.id === myDefault) ?? active[0]!;
    try {
      const found = await this.store.readForSpawn(claims, spaceId, 'github', chosen.id);
      if (found.kind !== 'secret') return { ok: false, reason: 'unreadable', label: chosen.label };
      return { ok: true, token: found.secret, credentialId: found.credentialId, label: found.label };
    } catch (error) {
      if (error instanceof Error && error.message === UNREADABLE_MESSAGE) {
        return { ok: false, reason: 'unreadable', label: chosen.label };
      }
      // Revoked or re-scoped between the select and the read.
      const reason = refusalReason(error);
      if (reason === 'stale') return { ok: false, reason: 'stale', label: chosen.label };
      if (reason) return { ok: false, reason: 'none' };
      throw error;
    }
  }
}

/** The server-side GitHub reader over one store. */
export function serverGithubCredentials(
  db: Db,
  dataDir: string,
  logger?: DbSpaceCredentialStoreOptions['logger'],
): DbServerGithubCredentials {
  const store = new DbSpaceCredentialStore({ db, dataDir, ...(logger ? { logger } : {}) });
  return new DbServerGithubCredentials({ db, store });
}
