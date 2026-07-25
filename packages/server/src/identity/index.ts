/**
 * The identity block's public seam (09 §3.2).
 *
 * Consumers: the HTTP facade (W2) and, in Phase 2, the gateway's remote-facing
 * auth surface (R1). Nothing outside this directory should import from a deeper
 * path — the sub-modules are free to move.
 *
 * What lives here: accounts, `auth_sessions`, `can_act_as` resolution, the v1
 * auto-owner path, and claim-set production. What deliberately does not: any
 * HTTP surface (Phase 1 has no remote surface at all — S1), any database
 * connection (the db layer owns it and applies the claims this block produces —
 * T-L11/R2), and any JWT (they exist only at the bridge, Phase 2).
 */

export type {
  Account,
  AccountId,
  AccountStatus,
  AuthContext,
  AuthSession,
  AuthSessionId,
  AuthSessionKind,
  ClaimSet,
  IdentityId,
  IssuedSession,
  MemberId,
  MemberRecord,
  PasswordAlgorithm,
  SpaceId,
  StoredCredential,
  TeamMemberId,
  TeamMemberRecord,
} from './types.js';

export type {
  AccountCredentialRow,
  ActorScope,
  CreateAccountInput,
  CreateAuthSessionInput,
  IdentityRepository,
} from './repository.js';

export type {
  AuthenticateInput,
  BootstrapOwnerInput,
  IdentityService,
  IdentityServiceOptions,
  IssueSessionInput,
  ResetCredentialsInput,
  ResolveClaimsInput,
} from './service.js';

export {
  DEFAULT_OWNER_DISPLAY_NAME,
  DEFAULT_OWNER_USERNAME,
  DEFAULT_SESSION_TTL_MS,
  IdentityServiceImpl,
  normalizeUsername,
} from './service.js';

export { InMemoryIdentityRepository } from './in-memory-store.js';
export { PgIdentityRepository, translatePgError, type SqlExecutor } from './pg-store.js';

export { CLAIM_NAMES, anonymousClaimBindings, toClaimBindings, type ClaimBinding } from './claims.js';

export {
  ManualClock,
  SequentialIds,
  systemClock,
  systemIds,
  type Clock,
  type IdGenerator,
} from './ids.js';

export {
  ScryptPasswordHasher,
  formatToken,
  hashToken,
  parseToken,
  type PasswordHasher,
} from './crypto.js';

/**
 * The v1 loopback auto-owner path (S5). Separate from `IdentityServiceImpl`
 * on purpose — see loopback.ts for why the PG-backed repository is not on the
 * G1A critical path.
 */
export {
  createLoopbackOwnerResolver,
  resolveLoopbackOwner,
  LOOPBACK_OWNER_USERNAME,
  LOOPBACK_OWNER_DISPLAY_NAME,
  type LoopbackOwner,
} from './loopback.js';
