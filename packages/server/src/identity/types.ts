/**
 * Identity block — domain types.
 *
 * Provenance: 09-IMPLEMENTATION-PLAN §3.2, 01-LAWS T-L7 (auth always on; local
 * is the degenerate case) + T-L11 (per-transaction claims, low-privilege role),
 * 03-ENTITY-GRAPH-DELTAS §5 (opaque immutable identity_id), 07 R1/R2/R6,
 * 10-SECURITY-MODEL S5-S9.
 *
 * These are server-block types, NOT contract types. The contract is frozen; the
 * identity block is an internal seam consumed by the facade (W2) and, in Phase 2,
 * by the gateway's remote-facing auth surface (R1/T-L8).
 */

export type AccountId = string;
export type AuthSessionId = string;

/**
 * R6 re-key compatibility: the identity id is **opaque and immutable**. Display
 * names, usernames and (later) `user@server` addresses live elsewhere so they
 * can change without rekeying `user_profiles` or any authored history.
 */
export type IdentityId = string;

/** Entity id of a `member` entity (a human's presence in one space). */
export type MemberId = string;
/** Entity id of a `team_member` entity (an agent persona owned by a member). */
export type TeamMemberId = string;
export type SpaceId = string;

/**
 * W0 B1: the closed claim set for one delivery-adapter execution.
 *
 * This is deliberately unrelated to Account/AuthSession/ClaimSet. In
 * particular it carries no actor, membership, role, act-as, bearer-session, or
 * ambient spawner authority.
 */
export interface SystemDeliveryPrincipalClaims {
  readonly deliveryId: string;
  readonly messageId: string;
  readonly targetWorkSessionId: string;
  readonly reservationVersion: number;
  readonly expiresAt: string;
}

/** The stored reservation coordinates a consumer must bind before use. */
export interface SystemDeliveryPrincipalBinding {
  readonly deliveryId: string;
  readonly messageId: string;
  readonly targetWorkSessionId: string;
  readonly reservationVersion: number;
}

/*
 * Compile-time opacity complements the runtime mint registry in
 * system-delivery-principal.ts. The symbol is intentionally not exported, so
 * an object literal cannot structurally implement this interface.
 */
declare const systemDeliveryPrincipalBrand: unique symbol;

/**
 * Server-internal authority for exactly one governed delivery-adapter write.
 * Possessing a structurally identical record is insufficient; consumers must
 * validate the value through `isSystemDeliveryPrincipalFor`.
 */
export interface SystemDeliveryPrincipal {
  readonly principalType: 'system_delivery_adapter';
  readonly claims: Readonly<SystemDeliveryPrincipalClaims>;
  readonly [systemDeliveryPrincipalBrand]: true;
}

/**
 * R6 revocation: disabling an account kills its sessions. The member entity and
 * all authored history survive — the graph is a historical record of who acted.
 */
export type AccountStatus = 'active' | 'disabled';

export interface Account {
  id: AccountId;
  identityId: IdentityId;
  /** Login handle. Mutable, case-insensitively unique, never a key. */
  username: string;
  displayName: string;
  /**
   * Node-level role: accounts, invites, resource limits (T-L7). Deliberately
   * NOT mixed with space-level roles (owner/admin/member) and it never widens
   * `can_act_as`.
   */
  isNodeAdmin: boolean;
  /** The node owner — exactly one row per node (T-L7 degenerate case). */
  isOwner: boolean;
  status: AccountStatus;
  createdAt: string;
  updatedAt: string;
  disabledAt: string | null;
}

export type PasswordAlgorithm = 'scrypt';

export interface StoredCredential {
  accountId: AccountId;
  algorithm: PasswordAlgorithm;
  /** Encoded verifier (salt + parameters + derived key). Never a plaintext secret. */
  hash: string;
  updatedAt: string;
}

/**
 * S8: browser sessions back the cookie/CSRF posture (S6); the other kinds are
 * bearer-token clients. `agent` is a work-session worker. `agent_runtime` is a
 * chat thread's headless runtime, carrying its requesting human's authority
 * while authoring as the selected teammate.
 */
export type AuthSessionKind = 'browser' | 'cli' | 'agent' | 'agent_runtime';

export interface AuthSession {
  id: AuthSessionId;
  accountId: AccountId;
  kind: AuthSessionKind;
  actingAsTeamMemberId: TeamMemberId | null;
  /** sha256 of the token secret. The plaintext token is returned once, never stored. */
  tokenHash: string;
  label: string | null;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

/** A human's membership row in one space (the `member` entity's identity side). */
export interface MemberRecord {
  id: MemberId;
  spaceId: SpaceId;
  identityId: IdentityId;
  role: 'owner' | 'admin' | 'member';
  displayName: string;
  avatar: string | null;
  joinedAt: string;
}

/** An agent persona. `ownerMemberId` governs configuration, not shared launch authority. */
export interface TeamMemberRecord {
  id: TeamMemberId;
  spaceId: SpaceId;
  ownerMemberId: MemberId;
  displayName: string;
  avatar: string | null;
}

/**
 * The claim set the db layer applies with `SET LOCAL` inside each transaction
 * (T-L11/R2). This block PRODUCES claims; it never opens a connection, never
 * mints a JWT (JWTs exist only at verifying boundaries — the bridge, Phase 2),
 * and never holds database credentials.
 */
export interface ClaimSet {
  identityId: IdentityId;
  accountId: AccountId;
  /** Node-level admin. RLS may use it for node-admin tables; it grants no space rights. */
  isNodeAdmin: boolean;
  /** Every space the identity is a member of. */
  memberIds: MemberId[];
  /** Every team_member in a space the identity has joined. */
  teamMemberIds: TeamMemberId[];
  /**
   * Who this request is *authored by*. `null` = the human acts as themselves.
   * When set, it is always a member of `canActAs`.
   */
  actingAsTeamMemberId: TeamMemberId | null;
  /**
   * Effective author id: the acting team_member if present, else the primary
   * member. Agents act as themselves; authorization still resolves through the
   * launching identity's space membership.
   */
  actorId: MemberId | TeamMemberId;
  /** Shared personas in the identity's spaces. Node-admin does not widen this. */
  canActAs: TeamMemberId[];
}

/** What the facade gets back from every authentication path. */
export interface AuthContext {
  account: Account;
  /** null for the loopback auto-owner path, which resolves identity without issuing a token. */
  session: AuthSession | null;
  claims: ClaimSet;
}

/** Returned exactly once at issuance; the plaintext is never recoverable afterwards. */
export interface IssuedSession {
  session: AuthSession;
  token: string;
}
