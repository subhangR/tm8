/**
 * `gitCredentials.*` — the caller's own third-party git identity.
 *
 * THE ONE RULE THIS FILE EXISTS TO KEEP: no operation here ever has a decrypted
 * token in scope. `set` encrypts before the value leaves this function and
 * hands Postgres bytes; `status` reads through the RLS-limited SELECT, whose
 * column grant does not include the ciphertext at all; `delete` names nothing.
 * The decrypt path lives in `git-credentials-port.ts` and is reachable only
 * from spawn — see db/migrations/079 for why that separation is structural
 * rather than stylistic.
 *
 * There is no `list` and no `get by account`: every operation's subject is the
 * identity bound to the transaction, and no parameter anywhere can name another
 * account. That is not a missing feature, it is the authorization model.
 */
import { CollabError } from '@tm8/contract';
import type {
  GitCredentialDeleteResult,
  GitCredentialProvider,
  GitCredentialSetInput,
  GitCredentialStatus,
} from '@tm8/contract';

import { loadOrCreateCredentialKey, sealSecret } from '../../../credentials/index.js';
import type { DbClaims } from '../../../db/types.js';
import type { RequestContext } from '../../../http/types.js';
import { claimsFor } from '../../context.js';
import type { FacadeDeps } from '../../deps.js';

/** The only provider 079's CHECK constraint admits. */
const DEFAULT_PROVIDER: GitCredentialProvider = 'github';

interface StatusRow {
  provider: string;
  login: string | null;
  updated_at: Date | string;
}

interface SetResult {
  connected: boolean;
  provider: string;
  login: string | null;
  updatedAt: string;
}

interface DeleteResult {
  connected: false;
  provider: string;
  deleted: boolean;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function disconnected(provider: GitCredentialProvider): GitCredentialStatus {
  return { connected: false, provider, login: null, updatedAt: null };
}

/**
 * The provider named in a query string, validated against the same closed set
 * the database enforces. Rejecting here rather than letting Postgres raise
 * keeps the error a 400 with a useful message instead of a constraint violation.
 */
function providerParam(ctx: RequestContext): GitCredentialProvider {
  const raw = ctx.query.get('provider');
  if (raw === null || raw === '') return DEFAULT_PROVIDER;
  if (raw !== 'github') {
    throw new CollabError('invalid_input', `unsupported git credential provider: ${raw}`);
  }
  return raw;
}

export interface W2GitCredentialsServiceOptions {
  /**
   * Where this node keeps its private state. The credential key is created
   * beside the file-upload grant key, and is never the same key.
   */
  readonly dataDir: string;
}

export class W2GitCredentialsService {
  constructor(
    private readonly deps: FacadeDeps,
    private readonly options: W2GitCredentialsServiceOptions,
  ) {}

  /**
   * Store (or replace) the caller's credential.
   *
   * The account id used as encryption AAD is resolved by Postgres from the
   * identity bound to this transaction, not computed here from anything the
   * client sent — there is no client-supplied account in this flow, so the
   * upsert below cannot write a row the AAD does not match. The plaintext
   * exists as a local for the duration of one `sealSecret` call and is never
   * logged, returned, or placed in an error message.
   */
  readonly set = async (ctx: RequestContext): Promise<GitCredentialStatus> => {
    const owner = await this.deps.owner();
    const input = ctx.body as GitCredentialSetInput;
    const claims = claimsFor(owner, ctx);

    const accountId = await this.resolveAccountId(claims);
    const key = await loadOrCreateCredentialKey(this.options.dataDir);
    const sealed = sealSecret(key, input.token, { accountId, provider: input.provider });

    const result = await this.deps.db.rpc<SetResult>(
      claims,
      'public.set_account_git_credential',
      [input.provider, input.login, sealed.ciphertext, sealed.nonce],
    );
    return {
      connected: true,
      provider: input.provider,
      login: result.login,
      updatedAt: iso(result.updatedAt),
    };
  };

  /**
   * Is a credential connected, and whose is it.
   *
   * A plain SELECT under the caller's claims, deliberately: the RLS policy and
   * the column-level grant are the authorization, so this read cannot return
   * another account's row and cannot return a token even if this code were
   * wrong. Naming `token_ciphertext` in this statement would raise 42501.
   */
  readonly status = async (ctx: RequestContext): Promise<GitCredentialStatus> => {
    const owner = await this.deps.owner();
    const provider = providerParam(ctx);
    const rows = await this.deps.db.query<StatusRow>(
      claimsFor(owner, ctx),
      `select provider, login, updated_at
         from public.account_git_credentials
        where provider = $1`,
      [provider],
    );
    const row = rows[0];
    if (!row) return disconnected(provider);
    return {
      connected: true,
      provider,
      login: row.login,
      updatedAt: iso(row.updated_at),
    };
  };

  /** Forget the caller's credential. Idempotent, and never a 404. */
  readonly delete = async (ctx: RequestContext): Promise<GitCredentialDeleteResult> => {
    const owner = await this.deps.owner();
    const provider = providerParam(ctx);
    const result = await this.deps.db.rpc<DeleteResult>(
      claimsFor(owner, ctx),
      'public.delete_account_git_credential',
      [provider],
    );
    return { connected: false, provider, deleted: result.deleted };
  };

  /**
   * The caller's account id, for use as encryption AAD.
   *
   * `internal.current_account_id()` resolves it from the transaction's identity
   * inside Postgres. Doing it in SQL rather than trusting a value carried in
   * from the HTTP layer is what makes the AAD binding meaningful: a ciphertext
   * is bound to the account the DATABASE says is writing, so it cannot later be
   * opened for a row it does not belong to.
   */
  private async resolveAccountId(claims: DbClaims): Promise<string> {
    const rows = await this.deps.db.query<{ account_id: string | null }>(
      claims,
      'select internal.current_account_id() as account_id',
    );
    const accountId = rows[0]?.account_id ?? null;
    if (!accountId) {
      throw new CollabError('unauthenticated', 'no active account for this identity');
    }
    return accountId;
  }
}
