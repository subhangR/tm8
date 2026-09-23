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
    const [space, node] = await Promise.all([
      this.store.readSpacePolicy(claims, spaceId),
      this.store.readNodePolicy(claims),
    ]);
    return { space, node };
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
    // RLS: a member sees its space's rows; a credential whose space the caller
    // has since left is invisible, and so is not active for this session.
    const rows = await this.db.query<{ id: string }>(
      auth as DbClaims,
      `select id from public.space_credentials
        where id = any($1::uuid[]) and status = 'active'`,
      [credentialIds],
    );
    return new Set(rows.map((row) => row.id));
  }

  async repointSession(auth: GraphAuth, sessionId: string): Promise<SpaceCredentialRepoint> {
    try {
      const result = await this.store.repointSession(auth as DbClaims, sessionId);
      return { ok: true, credentials: result.credentials };
    } catch (error) {
      if (error instanceof CollabError && error.details?.sqlstate === '23514') {
        return { ok: false, reason: 'inactive' };
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
