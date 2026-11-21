/**
 * The broker core seam. WS-A owns this file. The workstreams build against it
 * in parallel:
 *
 *   F  data: the Postgres `VaultStore`, migrations, RLS, the audit chain, gate
 *      and checkpoints, and the deletion ledger
 *   G  owner auth: `OwnerAuth`, passkeys, vault sessions, step-up and recovery,
 *      plus the handlers in `OWNER_AUTH_OPS`
 *   H  broker runtime: the server, attestation check, dispatcher, authority and
 *      mode gates, plus the handlers in `BROKER_CORE_OPS`
 *   J  agent actions: operations, approvals and spend, plus the handlers in
 *      `AGENT_ACTION_OPS`
 *   K  GCP adapters: the Cloud KMS provider, the KMS checkpoint signer and the
 *      GCS checkpoint sink (code and fake-server tests only; nothing is provisioned)
 *
 * `store/memory.ts` is the reference `VaultStore`. Its behaviour is the
 * specification wherever a comment here leaves room. F's conformance suite runs
 * against both stores, and any disagreement is a bug in one of them. To change
 * this file, ask on your subtask; nobody but WS-A edits it.
 *
 * Rules for every implementation:
 * - No value, token, cookie, code, full URL or PII goes in a log, an error
 *   message or an audit param (R5, R12). Errors carry a fixed message and a
 *   typed code.
 * - Every state change appends its audit event in the SAME store transaction.
 *   If the append fails, the transaction rolls back and the call answers
 *   `audit_unavailable`.
 * - The broker never writes secret material to disk. It writes exactly two
 *   things there, both metadata only: the deletion ledger file and the file
 *   checkpoint sink.
 */
import type {
  VAULT_OPERATIONS,
  VaultErrorReason,
  VaultInput,
  VaultOperationName,
  VaultOutput,
  VaultStepUpAction,
  VaultStepUpProof,
} from '@tm8/contract';
import type { CaptureKeyPair } from './capture/seal.js';
import type { EncryptedSecretVersion } from './crypto/aead.js';
import type { KmsProvider } from './crypto/kms.js';
import type { ApprovalKind } from './intent/hash.js';
import type {
  BrokerPolicy,
  CanarySet,
  EgressExecutor,
  ExposureTier,
  FillDriver,
  HttpMethod,
  ImportParser,
  KeyInjection,
  PasteDetector,
  VaultMode,
} from './types.js';

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** UTC, millisecond precision, `Date.prototype.toISOString()` form: `2026-11-20T21:05:00.000Z`. */
export type IsoTime = string;

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export function isoNow(clock: Clock): IsoTime {
  return clock.now().toISOString();
}

export interface Page<T> {
  rows: T[];
  /** Opaque. Null on the last page. */
  nextCursor: string | null;
}

export interface PageQuery {
  /** From a previous page. A cursor the store cannot parse throws `VaultError('invalid_cursor')`. */
  cursor?: string;
  /** Clamped to 1..200. Default 50. */
  limit?: number;
}

export type ItemState = 'active' | 'blocked_until_rotated' | 'tombstoned';
export type GranteeKind = 'space' | 'member';
/** One definition, in intent/hash.ts next to `APPROVAL_KINDS`. */
export type { ApprovalKind };
export type ApprovalState = 'pending' | 'approved' | 'denied' | 'expired' | 'consumed';
export type OperationKind = 'fill' | 'call_api' | 'spend';
export type OperationState = 'in_progress' | 'done' | 'refused' | 'approval_required' | 'unknown';
/** Audit param values: metadata only (origins, hosts, methods, path prefixes, amounts, codes). */
export type AuditParam = string | number | boolean | null | string[];

// ---------------------------------------------------------------------------
// Who is calling
// ---------------------------------------------------------------------------

/**
 * The tm8 identity the relay authenticated, from its signed attestation
 * (`relay/attestation.ts`). This is the `member` authority level and nothing
 * more: on this host every tm8 credential is agent-forgeable, so a caller here
 * never proves the owner is present. Owner authority comes only from a vault
 * session (passkey) and a step-up assertion (`OwnerAuth`).
 */
export interface VaultCaller {
  /** `agent`: a tm8 agent session acting as its launching member. Attribution only, never authority. */
  kind: 'member' | 'agent';
  memberId: string;
  spaceId: string;
  /** The tm8 session, for agents. */
  sessionId: string | null;
  /** Display name for attribution. Never used for a decision. */
  name: string | null;
  /** A space admin. `pre_review` admits admins only. */
  isSpaceAdmin: boolean;
  /** The client address the relay saw. Rate limits only. Never logged, never audited. */
  ip: string | null;
}

/** Contract `VaultActor`. */
export interface ActorRecord {
  kind: 'member' | 'agent' | 'system';
  memberId: string | null;
  sessionId: string | null;
  name: string | null;
}

export const SYSTEM_ACTOR: ActorRecord = Object.freeze({ kind: 'system', memberId: null, sessionId: null, name: null });

export function actorOf(caller: VaultCaller): ActorRecord {
  return { kind: caller.kind, memberId: caller.memberId, sessionId: caller.sessionId, name: caller.name };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type VaultErrorCode =
  | 'invalid_input' | 'invalid_cursor' | 'unauthenticated' | 'forbidden' | 'not_found'
  | 'version_conflict' | 'conflict' | 'invariant_violation' | 'payload_too_large'
  | 'rate_limited' | 'not_implemented' | 'upstream_unavailable';

/** HTTP status and code for every vault reason. The broker answers exactly this. */
export const VAULT_REASON_STATUS: { readonly [R in VaultErrorReason]: readonly [number, VaultErrorCode] } = {
  vault_disabled: [503, 'upstream_unavailable'],
  vault_unavailable: [503, 'upstream_unavailable'],
  audit_unavailable: [503, 'upstream_unavailable'],
  kms_unavailable: [503, 'upstream_unavailable'],
  vault_session_required: [401, 'unauthenticated'],
  step_up_required: [401, 'unauthenticated'],
  step_up_invalid: [403, 'forbidden'],
  passkey_required: [403, 'forbidden'],
  code_invalid: [403, 'forbidden'],
  // 403, not 404: the UI maps every 404 to one generic copy.
  capture_link_invalid: [403, 'forbidden'],
  capture_key_rotated: [409, 'conflict'],
  item_blocked: [409, 'conflict'],
  wrong_item_type: [400, 'invalid_input'],
  origin_refused: [400, 'invalid_input'],
  approval_not_pending: [409, 'conflict'],
  approval_hash_mismatch: [409, 'conflict'],
  operation_id_reused: [409, 'conflict'],
  operation_in_progress: [409, 'conflict'],
  spend_disabled: [403, 'forbidden'],
  import_disabled: [403, 'forbidden'],
  secret_in_metadata: [400, 'invalid_input'],
  pre_review_limit: [403, 'forbidden'],
  value_request_refused: [403, 'forbidden'],
  last_passkey: [409, 'conflict'],
};

const DEFAULT_STATUS: { readonly [C in VaultErrorCode]: number } = {
  invalid_input: 400, invalid_cursor: 400, unauthenticated: 401, forbidden: 403, not_found: 404,
  version_conflict: 409, conflict: 409, invariant_violation: 500, payload_too_large: 413,
  rate_limited: 429, not_implemented: 501, upstream_unavailable: 503,
};

/**
 * The only error a handler throws on purpose. The dispatcher turns it into
 * `{ error: { code, message, details: { reason, currentVersion? } } }`.
 * `message` is a fixed string. Never put request data in it.
 */
export class VaultError extends Error {
  readonly status: number;
  constructor(
    readonly code: VaultErrorCode,
    readonly reason: VaultErrorReason | null = null,
    readonly extra: { currentVersion?: number; retryAfterSeconds?: number } = {},
  ) {
    super(reason ? `vault: ${reason}` : `vault: ${code}`);
    this.name = 'VaultError';
    this.status = reason ? VAULT_REASON_STATUS[reason][0] : DEFAULT_STATUS[code];
  }

  static reason(reason: VaultErrorReason): VaultError {
    return new VaultError(VAULT_REASON_STATUS[reason][1], reason);
  }
}

/** The row is missing or not visible to the transaction's scope. One answer for both (test 19). */
export class StoreNotFoundError extends Error {
  constructor() { super('vault store: not found'); this.name = 'StoreNotFoundError'; }
}

/** A compare-and-set lost: `expectedVersion` is stale. */
export class StoreVersionConflictError extends Error {
  constructor(readonly currentVersion: number) { super('vault store: version conflict'); this.name = 'StoreVersionConflictError'; }
}

/** A unique key already exists (credential id, operation id, capture id). */
export class StoreDuplicateError extends Error {
  constructor() { super('vault store: duplicate'); this.name = 'StoreDuplicateError'; }
}

/** A state machine refused the transition. `state` is the row's current state. */
export class StoreStateError extends Error {
  constructor(readonly state: string) { super('vault store: invalid state transition'); this.name = 'StoreStateError'; }
}

/**
 * The audit append failed, so the whole transaction rolled back. Answer
 * `audit_unavailable`. `cause` is for the broker's own log; it never reaches
 * a response.
 */
export class AuditUnavailableError extends Error {
  constructor(options?: { cause?: unknown }) { super('vault audit unavailable', options); this.name = 'AuditUnavailableError'; }
}

/** The database is unreachable or failed. Answer `vault_unavailable`. */
export class StoreUnavailableError extends Error {
  constructor() { super('vault store unavailable'); this.name = 'StoreUnavailableError'; }
}

/** A repo method ran in the wrong kind of scope. Always a broker bug (500). */
export class StoreScopeError extends Error {
  constructor(readonly required: 'member' | 'system') { super(`vault store: needs ${required} scope`); this.name = 'StoreScopeError'; }
}

// ---------------------------------------------------------------------------
// Records (one per table; see plan doc 01a1fab7 §3)
// ---------------------------------------------------------------------------

export interface ItemRecord {
  id: string;
  spaceId: string;
  ownerMemberId: string;
  /** Row version for compare-and-set. Every metadata, origin, policy, secret or state change increments it. */
  version: number;
  type: 'login' | 'api_key' | 'card' | 'note' | 'identity';
  name: string;
  state: ItemState;
  exposureTier: ExposureTier | null;
  /** Login items: the exact bound origins, sorted, unique. */
  origins: string[];
  devMode: boolean;
  username: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
  connector: string | null;
  hasTotp: boolean;
  hasNotes: boolean;
  fieldNames: string[];
  /** The live secret version. It is in the AAD, so a version swap fails to decrypt. */
  secretVersion: number;
  createdAt: IsoTime;
  updatedAt: IsoTime;
  rotatedAt: IsoTime | null;
  tombstonedAt: IsoTime | null;
  createdBy: ActorRecord;
}

/** Metadata the broker derives from a capture or an import row. Never a value. */
export type ItemMetadataFields = Pick<ItemRecord,
  'name' | 'username' | 'last4' | 'expMonth' | 'expYear' | 'connector' | 'hasTotp' | 'hasNotes' | 'fieldNames'>;

export interface NewItem extends ItemMetadataFields {
  /** Broker-generated (`randomUUID`). It must exist before encryption because it is in the AAD. */
  id: string;
  type: ItemRecord['type'];
  state: 'active' | 'blocked_until_rotated';
  exposureTier: ExposureTier | null;
  origins: string[];
  devMode: boolean;
  createdBy: ActorRecord;
}

export interface SecretVersionRecord extends EncryptedSecretVersion {
  itemId: string;
  version: number;
  createdAt: IsoTime;
}

export interface PolicyRecord extends Omit<BrokerPolicy, 'keyId'> {
  itemId: string;
  createdAt: IsoTime;
  createdBy: ActorRecord;
}

export interface PolicyInput {
  mode: 'connector' | 'generic';
  connector: string | null;
  hosts: string[];
  methods: HttpMethod[];
  pathPrefixes: string[];
  maxRequestBytes: number;
  maxResponseBytes: number;
  injection: KeyInjection;
}

export interface GrantConstraints {
  /** A subset of the item's origins. Null = all of them. */
  origins: string[] | null;
  /** A subset of the policy's hosts. Null = all of them. */
  hosts: string[] | null;
  requireApprovalPerUse: boolean;
}

/** Use-only. Grants live in the item's own space; a `space` grantee is that space. */
export interface GrantRecord {
  id: string;
  itemId: string;
  spaceId: string;
  granteeKind: GranteeKind;
  granteeId: string;
  constraints: GrantConstraints;
  expiresAt: IsoTime | null;
  createdAt: IsoTime;
  createdBy: ActorRecord;
  revokedAt: IsoTime | null;
  revokedBy: ActorRecord | null;
}

export interface LookalikeFindingRecord {
  kind: 'confusable' | 'mixed_script' | 'edit_distance' | 'brand_embedding';
  similarTo: string | null;
}

export interface SpendDetails {
  merchant: string;
  amountMinor: number;
  currency: string;
  itemSummary: string;
  instrumentTier: 'tier1';
}

/**
 * PENDING -> APPROVED | DENIED | EXPIRED, and a one-use APPROVED -> CONSUMED | EXPIRED.
 * Terminal states never reopen (a trigger enforces it in Postgres). A standing
 * `new_origin` approval is approved with `oneUse` false: the decide handler adds
 * the origin to the item in the same transaction, and the approval stays
 * APPROVED as the record of that decision.
 *
 * Expiry is lazy: the sweeper persists it, but every read, filter and state
 * check uses `effectiveApprovalState`, so an approval past `expiresAt` is
 * expired even before the sweeper runs.
 */
export interface ApprovalRecord {
  id: string;
  itemId: string;
  spaceId: string;
  /** The item owner: the only member who can decide. */
  ownerMemberId: string;
  kind: ApprovalKind;
  state: ApprovalState;
  oneUse: boolean;
  /** `intentHash(kind, boundParams)` from intent/hash.ts. */
  intentHash: string;
  boundParams: Record<string, AuditParam>;
  requestedBy: ActorRecord;
  /** The member the request acts for (the requester's member, also for agents). */
  requesterMemberId: string;
  purpose: string | null;
  lookalike: LookalikeFindingRecord[];
  spend: SpendDetails | null;
  /** The operation whose `approval_required` result created it, if any. */
  operationId: string | null;
  createdAt: IsoTime;
  expiresAt: IsoTime;
  decidedAt: IsoTime | null;
  decidedBy: ActorRecord | null;
  /** `new_origin` approved as standing (the origin was added to the item). */
  standing: boolean;
  consumedAt: IsoTime | null;
  consumedByOperationId: string | null;
}

export function effectiveApprovalState(approval: Pick<ApprovalRecord, 'state' | 'oneUse' | 'consumedAt' | 'expiresAt'>, now: IsoTime): ApprovalState {
  const lapsed = Date.parse(approval.expiresAt) <= Date.parse(now);
  if (approval.state === 'pending' && lapsed) return 'expired';
  if (approval.state === 'approved' && approval.oneUse && approval.consumedAt === null && lapsed) return 'expired';
  return approval.state;
}

export interface NewApproval {
  id: string;
  itemId: string;
  kind: ApprovalKind;
  oneUse: boolean;
  intentHash: string;
  boundParams: Record<string, AuditParam>;
  requestedBy: ActorRecord;
  purpose: string | null;
  lookalike: LookalikeFindingRecord[];
  spend: SpendDetails | null;
  operationId: string | null;
  expiresAt: IsoTime;
}

/** Caller-keyed idempotency: the key is (member, operationId). */
export interface OperationRecord {
  operationId: string;
  memberId: string;
  spaceId: string;
  kind: OperationKind;
  itemId: string;
  /** Over the request's bound params. The same operationId with another hash is `operation_id_reused`. */
  intentHash: string;
  state: OperationState;
  /** The stored contract result, exactly as the first call returned it, minus any upstream body. Null while in progress. */
  result: unknown;
  approvalId: string | null;
  actor: ActorRecord;
  createdAt: IsoTime;
  completedAt: IsoTime | null;
}

export interface SpendRequestRecord extends SpendDetails {
  approvalId: string;
  itemId: string;
  /** SHA-256 of the evidence PNG, and its size. The image itself is not stored. */
  evidence: { sha256: string; width: number; height: number; maskedRegions: number } | null;
  createdAt: IsoTime;
  executedAt: IsoTime | null;
  processorRef: string | null;
}

export interface PasskeyRecord {
  id: string;
  memberId: string;
  /** base64url credential id. Unique across the whole store. */
  credentialId: string;
  /** base64url COSE public key. */
  publicKey: string;
  counter: number;
  transports: string[];
  backedUp: boolean;
  deviceType: 'singleDevice' | 'multiDevice';
  aaguid: string | null;
  name: string;
  createdAt: IsoTime;
  lastUsedAt: IsoTime | null;
  revokedAt: IsoTime | null;
}

export type SessionEndReason = 'ended' | 'revoked' | 'refresh_reuse' | 'recovery' | 'passkey_revoked' | 'expired';

/**
 * One row per refresh family. Tokens are 32 random bytes, base64url, sent only
 * as HttpOnly cookies. The store keeps SHA-256 hashes, never a token.
 */
export interface VaultSessionRecord {
  id: string;
  memberId: string;
  passkeyId: string;
  deviceLabel: string | null;
  tokenHash: string;
  refreshHash: string;
  /** Increments on every refresh. Superseded refresh hashes are kept to detect reuse. */
  refreshVersion: number;
  createdAt: IsoTime;
  lastUsedAt: IsoTime;
  expiresAt: IsoTime;
  refreshExpiresAt: IsoTime;
  /** Absolute cap (contract `VAULT_REFRESH_FAMILY_TTL_SECONDS`). */
  familyExpiresAt: IsoTime;
  revokedAt: IsoTime | null;
  revokedReason: SessionEndReason | null;
}

export type ChallengePurpose = 'sign_in' | 'step_up' | 'registration';

/**
 * A WebAuthn ceremony. For a step-up, the record keeps ONLY the intent hash of
 * the bound params, never the params: the body can carry a link token or a
 * sealed blob.
 */
export interface ChallengeRecord {
  id: string;
  memberId: string;
  purpose: ChallengePurpose;
  action: VaultStepUpAction | null;
  intentHash: string | null;
  /** base64url WebAuthn challenge bytes. A nonce, not a secret. */
  challenge: string;
  /** Registration only. */
  registration: { name: string; via: 'enrollment_code' | 'recovery_code' | 'step_up'; codeId: string | null; userHandle: string } | null;
  createdAt: IsoTime;
  expiresAt: IsoTime;
  consumedAt: IsoTime | null;
}

export interface CodeRecord {
  id: string;
  memberId: string;
  /** Argon2id encoded hash (hash-wasm). Never the code. */
  hash: string;
  createdAt: IsoTime;
  usedAt: IsoTime | null;
}

export interface EnrollmentCodeRecord extends CodeRecord {
  spaceId: string;
  expiresAt: IsoTime;
  /** Operator label from the minting CLI (no PII). */
  mintedBy: string;
}

export interface CaptureLinkRecord {
  /** The captureId in the link path. */
  id: string;
  memberId: string;
  spaceId: string;
  itemType: ItemRecord['type'];
  purpose: 'create' | 'replace';
  itemId: string | null;
  name: string | null;
  /** SHA-256 of the 32-byte link token from the URL fragment. */
  tokenHash: string;
  /** The broker capture key the link was made for. A different live key means `capture_key_rotated`. */
  captureKid: string;
  createdAt: IsoTime;
  expiresAt: IsoTime;
  openedAt: IsoTime | null;
  consumedAt: IsoTime | null;
  createdBy: ActorRecord;
}

export interface AuditBody {
  action: string;
  actor: ActorRecord;
  itemId: string | null;
  /** Whose vault the event belongs to. `vault.audit.list` shows a member exactly the events where this is them. */
  subjectMemberId: string | null;
  spaceId: string | null;
  params: Record<string, AuditParam>;
}

export interface AuditEventRecord extends AuditBody {
  /** Global, gapless, from 1. */
  seq: number;
  at: IsoTime;
  prevHash: string;
  entryHash: string;
  /** `canonicalJson(body)`, exactly as hashed (audit/chain.ts). */
  bodyText: string;
}

export interface AuditVerification {
  status: 'verified' | 'broken' | 'unverified';
  checkedThroughSeq: number;
  headHash: string;
  firstBrokenSeq: number | null;
}

export type CheckpointSinkKind = 'off' | 'file' | 'gcs';

export interface CheckpointRecord {
  seq: number;
  headHash: string;
  at: IsoTime;
  sink: CheckpointSinkKind;
  anchored: boolean;
  /** Object name or file path. Never a signed URL. */
  location: string | null;
  keyId: string | null;
  /** base64url signature over `checkpointSigningInput` (audit/chain.ts). */
  signature: string | null;
}

export interface DeletionLedgerEntry {
  itemId: string;
  spaceId: string;
  ownerMemberId: string;
  tombstonedAt: IsoTime;
}

/**
 * The other terminal states the deletion/revocation ledger keeps across a
 * database restore (MSG 12, failure case 13, test 17). A ledger line with a
 * `kind` is one of these; a line without one is a `DeletionLedgerEntry`.
 * `ownerMemberId` is the item owner, the subject of the replay's audit event.
 */
export interface GrantRevokedLedgerEntry {
  kind: 'grant_revoked';
  grantId: string;
  itemId: string;
  spaceId: string;
  ownerMemberId: string;
  revokedAt: IsoTime;
}

export interface ApprovalConsumedLedgerEntry {
  kind: 'approval_consumed';
  approvalId: string;
  itemId: string;
  spaceId: string;
  ownerMemberId: string;
  operationId: string;
  consumedAt: IsoTime;
}

export type RevocationLedgerEntry = GrantRevokedLedgerEntry | ApprovalConsumedLedgerEntry;

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

/**
 * Every transaction runs under one scope, and the store enforces it (RLS in
 * Postgres, the same rules in memory). A broker bug that forgets a check then
 * finds nothing instead of another member's row.
 *
 * Member scope (m = memberId, s = spaceId) sees:
 * - an item when it is in space s and owned by m, or has an ACTIVE grant
 *   (not revoked, not expired) to member m or to space s. Secret versions and
 *   the policy follow the item.
 * - a grant in space s when m owns its item or it names m or s;
 * - an approval in space s when m owns its item or m is the requester;
 * - its own operations, passkeys, sessions, challenges and recovery codes,
 *   and its own enrollment codes and capture links in space s;
 * - audit events whose `subjectMemberId` is m (and, through
 *   `audit.listForItem` only, events on a visible item; see there).
 * Owner-only writes (item, policy, grant changes, decide) act only on items
 * that m owns. On anything else they throw StoreNotFoundError.
 * A compare-and-set write checks, in this order: visibility (StoreNotFoundError),
 * tombstone (StoreStateError('tombstoned')), version (StoreVersionConflictError),
 * then its own rules (StoreStateError). Counts count what the scope can see.
 * A getter (`get`, `getBy*`, `currentSecret`, `policies.get`) returns null for
 * a row that is missing or not visible; every other method throws
 * StoreNotFoundError for one. A call that throws changes nothing.
 *
 * System scope sees and writes everything. Only these use it: startup
 * reconciliation, approval expiry, audit verification and checkpoints,
 * deletion-ledger replay, the enrollment-code CLI, and challenge cleanup.
 * A method documented for one scope kind throws StoreScopeError in the other.
 *
 * After AuditUnavailableError or StoreUnavailableError the transaction is
 * dead: every later call throws the same error, and it rolls back even if `fn`
 * catches and resolves (Postgres aborts the transaction). Any other repo error
 * leaves it usable, so the Postgres store uses conditional statements or
 * savepoints, never a failing statement, for those.
 */
export type StoreScope =
  | { kind: 'member'; memberId: string; spaceId: string }
  | { kind: 'system'; purpose: 'reconcile' | 'expire' | 'audit' | 'deletion_ledger' | 'enrollment' | 'cleanup' };

export function memberScope(caller: Pick<VaultCaller, 'memberId' | 'spaceId'>): StoreScope {
  return { kind: 'member', memberId: caller.memberId, spaceId: caller.spaceId };
}

export interface VaultStore {
  /**
   * One database transaction (READ COMMITTED; compare-and-set and state
   * transitions are single conditional statements). It commits when `fn`
   * resolves and rolls back when it throws. Never hold one across a fill, an
   * egress call or a processor call; those happen between transactions.
   * Repos THROW only for failures. An outcome that must persist (a refresh
   * reuse revokes the family) is RETURNED, so the transaction can commit
   * before the handler raises its error.
   */
  transaction<T>(scope: StoreScope, fn: (tx: VaultTx) => Promise<T>): Promise<T>;
  health(): Promise<{ ok: boolean }>;
  close(): Promise<void>;
}

export interface VaultTx {
  readonly now: IsoTime;
  readonly scope: StoreScope;
  readonly items: ItemsRepo;
  readonly policies: PoliciesRepo;
  readonly grants: GrantsRepo;
  readonly approvals: ApprovalsRepo;
  readonly operations: OperationsRepo;
  readonly spend: SpendRepo;
  readonly passkeys: PasskeysRepo;
  readonly sessions: VaultSessionsRepo;
  readonly challenges: ChallengesRepo;
  readonly recoveryCodes: RecoveryCodesRepo;
  readonly enrollmentCodes: EnrollmentCodesRepo;
  readonly captureLinks: CaptureLinksRepo;
  readonly audit: AuditRepo;
  readonly deletionLedger: DeletionLedgerRepo;
}

export interface ItemsRepo {
  /** Member scope only; owner and space come from the scope. Writes secret version `item.secretVersion` = 1. */
  create(item: NewItem, secret: EncryptedSecretVersion): Promise<ItemRecord>;
  get(itemId: string): Promise<ItemRecord | null>;
  /** Newest first. `access: owner` = items m owns, `grant` = items shared to m. Tombstoned items are excluded unless asked. */
  list(query: PageQuery & { type?: ItemRecord['type']; access?: 'owner' | 'grant'; includeTombstoned?: boolean }): Promise<Page<ItemRecord>>;
  /** Owner only. Compare-and-set on `version`. */
  update(itemId: string, expectedVersion: number, patch: { name?: string; username?: string | null }): Promise<ItemRecord>;
  /** Owner only. Compare-and-set. Origins are added and removed as exact strings; the result stays sorted and unique. */
  setProperties(itemId: string, expectedVersion: number, change: { addOrigins?: string[]; removeOrigins?: string[]; devMode?: boolean }): Promise<ItemRecord>;
  /** A standing `new_origin` approval. Owner only (the decide transaction). No-op if already bound; bumps `version` otherwise. */
  addOrigin(itemId: string, origin: string): Promise<ItemRecord>;
  /**
   * Rotation. Owner only. Compare-and-set. `secret` must be encrypted for
   * version `item.secretVersion + 1`. Deletes every older version, sets
   * `rotatedAt`, applies the metadata patch, and turns `blocked_until_rotated`
   * into `active`.
   */
  replaceSecret(itemId: string, expectedVersion: number, secret: EncryptedSecretVersion, metadata: Partial<ItemMetadataFields>): Promise<ItemRecord>;
  /** The live version, or null for a tombstoned item. Visibility follows the item. */
  currentSecret(itemId: string): Promise<SecretVersionRecord | null>;
  /**
   * Owner only. Compare-and-set. StoreStateError('tombstoned') if it already is.
   * In one statement set: delete every secret version (wrapped DEKs and
   * ciphertext), set state `tombstoned`, revoke every grant not yet revoked
   * (`revokedBy` = `actor`), expire pending and unconsumed one-use approvals,
   * and add the deletion-ledger mirror row. The metadata row and the policy
   * stay for the audit trail.
   */
  tombstone(itemId: string, expectedVersion: number, actor: ActorRecord): Promise<ItemRecord>;
  /** Items m owns that are not tombstoned (the `pre_review` cap). */
  countOwned(): Promise<number>;
  /**
   * System scope: deletion-ledger replay after a restore. Applies the same
   * effects as `tombstone` without compare-and-set (a missing item is fine),
   * keeps the entry's `tombstonedAt`, and adds the mirror row if missing.
   * Returns true when anything changed, so replay can audit `item.tombstone_replayed`.
   */
  forceTombstone(entry: DeletionLedgerEntry): Promise<boolean>;
}

export interface PoliciesRepo {
  get(itemId: string): Promise<PolicyRecord | null>;
  /** Owner only. Compare-and-set on the ITEM version; bumps it and the policy version (first policy = 1). */
  set(itemId: string, expectedItemVersion: number, policy: PolicyInput, createdBy: ActorRecord): Promise<{ policy: PolicyRecord; item: ItemRecord }>;
}

export interface GrantsRepo {
  /**
   * Owner only, on a live item; does not bump the item version. The grant's
   * space is the item's space. A `space` grantee must be that space, else
   * StoreStateError('cross_space'); a `member` grantee that is the owner is
   * StoreStateError('self_grant').
   */
  create(grant: { id: string; itemId: string; granteeKind: GranteeKind; granteeId: string; constraints: GrantConstraints; expiresAt: IsoTime | null; createdBy: ActorRecord }): Promise<GrantRecord>;
  get(grantId: string): Promise<GrantRecord | null>;
  /** Owner only. Newest first, revoked included. */
  listForItem(itemId: string): Promise<GrantRecord[]>;
  /** Owner only. Idempotent: an already revoked grant comes back unchanged. */
  revoke(grantId: string, revokedBy: ActorRecord): Promise<GrantRecord>;
  /**
   * System scope: ledger replay after a restore. Revokes the grant at the
   * entry's time, by the system, if the restore brought it back active. A
   * missing or already revoked grant is left alone. True when it changed, so
   * replay can audit `grant.revoke_replayed`.
   */
  forceRevoke(entry: GrantRevokedLedgerEntry): Promise<boolean>;
  /** Active grants on the item that name the scope member or space. Read at every use; never cached (revocation bound, test 12). */
  activeForCaller(itemId: string): Promise<GrantRecord[]>;
  countActive(itemId: string): Promise<number>;
}

export interface ApprovalsRepo {
  /** The item must be visible. The requester is the scope member. */
  create(approval: NewApproval): Promise<ApprovalRecord>;
  get(approvalId: string): Promise<ApprovalRecord | null>;
  list(query: PageQuery & { state?: ApprovalState; itemId?: string }): Promise<Page<ApprovalRecord>>;
  /** A pending, unexpired approval with this exact intent, requested by the scope member: repeated asks reuse it. */
  findPending(itemId: string, kind: ApprovalKind, intentHash: string): Promise<ApprovalRecord | null>;
  /** An approved, one-use, unconsumed, unexpired approval with this exact intent, requested by the scope member. */
  findUsable(itemId: string, kind: ApprovalKind, intentHash: string): Promise<ApprovalRecord | null>;
  /**
   * Owner only. Effective state pending, else StoreStateError(effective state).
   * `standing` is allowed only when approving a `new_origin` approval, else
   * StoreStateError('standing_not_allowed'); it sets `oneUse` to false.
   */
  decide(approvalId: string, decision: { state: 'approved' | 'denied'; decidedBy: ActorRecord; standing: boolean }): Promise<ApprovalRecord>;
  /**
   * Requester only. Effective state approved, one-use and unconsumed, else
   * StoreStateError(effective state), or StoreStateError('not_one_use') for a
   * standing approval. Exactly one concurrent caller wins.
   */
  consume(approvalId: string, operationId: string): Promise<ApprovalRecord>;
  /**
   * System scope: ledger replay after a restore. A stored state the restore
   * brought back approved (one-use) becomes `consumed` with the entry's time and
   * operation. A pending one becomes `expired`: it was consumed once, so nobody
   * may approve and use it again. Any other state, or a missing approval, is
   * left alone. True when it changed (`approval.consume_replayed`).
   */
  forceConsume(entry: ApprovalConsumedLedgerEntry): Promise<boolean>;
  /** System scope. Pending, and approved one-use, past expiry become `expired`. Returns them for audit. */
  expireDue(): Promise<ApprovalRecord[]>;
  countPending(itemId: string): Promise<number>;
}

export interface OperationsRepo {
  /**
   * Inserts (scope member, operationId) as `in_progress`, or returns the
   * existing row with `created: false`. Exactly one concurrent caller gets
   * `created: true`.
   */
  reserve(operation: { operationId: string; kind: OperationKind; itemId: string; intentHash: string; actor: ActorRecord; approvalId: string | null }): Promise<{ created: boolean; operation: OperationRecord }>;
  /** Only from `in_progress`, else StoreStateError. */
  complete(operationId: string, outcome: { state: Exclude<OperationState, 'in_progress'>; result: unknown; approvalId?: string | null }): Promise<OperationRecord>;
  get(operationId: string): Promise<OperationRecord | null>;
  /** System scope, at broker start: every `in_progress` row becomes `unknown` (the broker died mid-operation). Returns them for audit and spend reconciliation. */
  markInProgressUnknown(): Promise<OperationRecord[]>;
  /** System scope: `unknown` operations of this kind, oldest first, for reconciliation. */
  listUnknown(kind: OperationKind): Promise<OperationRecord[]>;
  /** System scope: reconciliation found the outcome. Only from `unknown`, else StoreStateError. */
  resolveUnknown(memberId: string, operationId: string, outcome: { state: 'done' | 'refused'; result: unknown }): Promise<OperationRecord>;
}

export interface SpendRepo {
  /** The approval must be a visible `spend` approval. One request per approval (StoreDuplicateError). */
  create(request: Omit<SpendRequestRecord, 'createdAt' | 'executedAt' | 'processorRef'>): Promise<SpendRequestRecord>;
  /** Follows the approval's visibility. */
  getByApproval(approvalId: string): Promise<SpendRequestRecord | null>;
  /** The requester, or system scope for reconciliation. StoreStateError('executed') if already executed. */
  markExecuted(approvalId: string, processorRef: string): Promise<SpendRequestRecord>;
}

export interface PasskeysRepo {
  /** Scope member. A duplicate credential id anywhere is StoreDuplicateError. */
  create(passkey: Omit<PasskeyRecord, 'memberId' | 'createdAt' | 'lastUsedAt' | 'revokedAt'>): Promise<PasskeyRecord>;
  get(passkeyId: string): Promise<PasskeyRecord | null>;
  /** The scope member's passkey with this credential id, revoked or not. */
  getByCredentialId(credentialId: string): Promise<PasskeyRecord | null>;
  listForMember(): Promise<PasskeyRecord[]>;
  countActive(): Promise<number>;
  /**
   * After a verified assertion. The counter must grow, unless both are 0
   * (authenticators without a counter). Otherwise StoreStateError('counter_regression'):
   * a possible cloned authenticator.
   */
  recordUse(passkeyId: string, newCounter: number): Promise<PasskeyRecord>;
  revoke(passkeyId: string): Promise<PasskeyRecord>;
}

export type RefreshRotation =
  | { result: 'rotated'; session: VaultSessionRecord }
  /** A superseded refresh token of a live family: the family was revoked (`refresh_reuse`) in this transaction. */
  | { result: 'reused'; session: VaultSessionRecord }
  | { result: 'ended'; session: VaultSessionRecord }
  | { result: 'unknown' };

export interface VaultSessionsRepo {
  create(session: Omit<VaultSessionRecord, 'memberId' | 'refreshVersion' | 'createdAt' | 'lastUsedAt' | 'revokedAt' | 'revokedReason'>): Promise<VaultSessionRecord>;
  get(sessionId: string): Promise<VaultSessionRecord | null>;
  /** The scope member's session with this token hash, in any state. The caller checks expiry and revocation. */
  getByTokenHash(tokenHash: string): Promise<VaultSessionRecord | null>;
  listForMember(): Promise<VaultSessionRecord[]>;
  touch(sessionId: string): Promise<void>;
  /** Atomic. `ended` = revoked, or past refresh or family expiry. */
  rotateRefresh(input: { refreshHash: string; newTokenHash: string; newRefreshHash: string; expiresAt: IsoTime; refreshExpiresAt: IsoTime }): Promise<RefreshRotation>;
  /** Idempotent. */
  revoke(sessionId: string, reason: SessionEndReason): Promise<VaultSessionRecord>;
  revokeAllForMember(reason: SessionEndReason): Promise<VaultSessionRecord[]>;
  revokeForPasskey(passkeyId: string): Promise<VaultSessionRecord[]>;
}

export interface ChallengesRepo {
  create(challenge: Omit<ChallengeRecord, 'memberId' | 'createdAt' | 'consumedAt'>): Promise<ChallengeRecord>;
  /** Single use. The scope member's unconsumed, unexpired challenge of this purpose, now consumed; null for every other case. */
  consume(challengeId: string, purpose: ChallengePurpose): Promise<ChallengeRecord | null>;
  /** System scope. */
  deleteExpired(): Promise<number>;
}

export interface RecoveryCodesRepo {
  /** Deletes every unused code of the scope member, then inserts these. */
  replaceAll(codes: { id: string; hash: string }[]): Promise<void>;
  listUnused(): Promise<CodeRecord[]>;
  /** Compare-and-set: false when already used. */
  markUsed(codeId: string): Promise<boolean>;
  countUnused(): Promise<number>;
}

export interface EnrollmentCodesRepo {
  /** System scope only (the broker-uid CLI). */
  create(code: Omit<EnrollmentCodeRecord, 'createdAt' | 'usedAt'>): Promise<EnrollmentCodeRecord>;
  /** The scope member's unused, unexpired codes. */
  listUsable(): Promise<EnrollmentCodeRecord[]>;
  markUsed(codeId: string): Promise<boolean>;
}

export interface CaptureLinksRepo {
  create(link: Omit<CaptureLinkRecord, 'memberId' | 'spaceId' | 'createdAt' | 'openedAt' | 'consumedAt'>): Promise<CaptureLinkRecord>;
  /** The scope member's link if unconsumed, unexpired and the token hash matches (constant time). Null otherwise. */
  getUsable(captureId: string, tokenHash: string): Promise<CaptureLinkRecord | null>;
  markOpened(captureId: string): Promise<void>;
  /** Compare-and-set on the same conditions as `getUsable`. Exactly one concurrent caller gets the record. */
  consume(captureId: string, tokenHash: string): Promise<CaptureLinkRecord | null>;
}

export interface AuditRepo {
  /**
   * Appends at the head of the ONE global chain, inside this transaction.
   * `seq`, `at` and `prevHash` are assigned under a lock on the head, so two
   * appends never share a parent. Postgres does this in a SECURITY DEFINER
   * function, and the entry hash follows audit/chain.ts. Any failure throws
   * AuditUnavailableError, so the caller's transaction rolls back.
   */
  append(event: AuditBody): Promise<AuditEventRecord>;
  /** Newest first. Visibility: `subjectMemberId` = scope member. */
  list(query: PageQuery & { itemId?: string; action?: string }): Promise<Page<AuditEventRecord>>;
  /**
   * Events for one visible item at or after `since`, newest first, at most
   * `limit`. The owner sees every event; anyone else sees only events where
   * `actor.memberId` is them, so a grantee never learns how others use the item.
   */
  listForItem(itemId: string, since: IsoTime, limit: number): Promise<AuditEventRecord[]>;
  /**
   * Count-only and global for one visible item and origin: the number of
   * `fill.refused` events with `params.attempted === true` and this exact
   * `params.origin`, newest first, back to the latest attempted `fill.done`
   * for the same origin. It counts EVERY caller's events, which `listForItem`
   * would hide from a grantee, and it has no window, so neither failures
   * spread over several requesters nor a burst of other events can keep the
   * repeated-failure alert from firing. Only the integer leaves the store.
   * Call it after the completion append: the head lock serializes concurrent
   * completions, and the count includes the event just appended.
   */
  fillFailureStreak(itemId: string, origin: string): Promise<number>;
  /** Global head. `{seq: 0, hash: AUDIT_GENESIS_HASH}` for an empty chain. */
  head(): Promise<{ seq: number; hash: string }>;
  /** System scope. Ascending, inclusive. */
  range(fromSeq: number, toSeq: number): Promise<AuditEventRecord[]>;
  /** System scope. */
  recordCheckpoint(checkpoint: CheckpointRecord): Promise<void>;
  latestCheckpoint(): Promise<CheckpointRecord | null>;
}

/** The database mirror of the deletion ledger. The durable copy is `DeletionLedger` (a file). */
export interface DeletionLedgerRepo {
  /** System scope. */
  list(): Promise<DeletionLedgerEntry[]>;
}

// ---------------------------------------------------------------------------
// Durability outside the database
// ---------------------------------------------------------------------------

/**
 * The deletion/revocation ledger that survives a database restore (MSG 12,
 * failure case 13, test 17). It is written FIRST (fsync), before the
 * transaction that makes the state terminal:
 * - the tombstone handler, before its tombstone transaction;
 * - the grant revoke handler, before its revoke transaction;
 * - every one-use approval consumption, inside the reserving transaction
 *   before it commits, so a fill, call or spend that cannot record its
 *   consumption never runs.
 * At start, before serving, the broker replays every entry: tombstones with
 * `items.forceTombstone`, then revocations with `grants.forceRevoke` and
 * `approvals.forceConsume`. A restore therefore never revives a dead item, a
 * revoked grant or a consumed approval. A crash or a rolled-back transaction
 * after the append errs toward the terminal state: the item is deleted, the
 * grant revoked, the approval used up, and the requester asks again.
 */
export interface DeletionLedger {
  append(entry: DeletionLedgerEntry): Promise<void>;
  entries(): Promise<DeletionLedgerEntry[]>;
  /** The same file and the same fsync as `append`. */
  appendRevocation(entry: RevocationLedgerEntry): Promise<void>;
  revocations(): Promise<RevocationLedgerEntry[]>;
}

// ---------------------------------------------------------------------------
// Audit gate and checkpoints (F; GCS sink and KMS signer: K)
// ---------------------------------------------------------------------------

/**
 * Fails closed when audit is unhealthy (MSG 11, test 18). Fill, callApi,
 * spend and grants call `assertHealthy()` before they reserve anything. Their
 * `*.started` event is then appended in the reserving transaction, so an append
 * failure also stops them.
 */
export interface AuditGate {
  /**
   * Throws VaultError(audit_unavailable) while the chain is known broken, an
   * append failed in the last `cooldownMs`, or (with an anchor, review F01) an
   * event has stayed unanchored or the retained anchor unverified for longer
   * than the anchor budget.
   */
  assertHealthy(): void;
  /** The dispatcher calls this whenever a transaction failed with AuditUnavailableError. */
  reportAppendFailure(): void;
  /**
   * Verifies from the last verified seq to the head, and with an anchor checks
   * the head the sink itself retains. A break, a rollback, a conflict or an
   * unverifiable anchor trips the gate until an operator restarts the broker.
   */
  verifyIncremental(): Promise<AuditVerification>;
  /** Full walk from seq 1 (`vault.audit.verify`, and the broker's periodic full verification). */
  verifyAll(): Promise<AuditVerification>;
  status(): 'ok' | 'unavailable' | 'disabled';
}

export interface CheckpointSigner {
  readonly keyId: string;
  sign(input: Buffer): Promise<Buffer>;
}

/**
 * Checks a retained checkpoint's signature (review F01). A key the verifier
 * does not hold or cannot vouch for is `false`, never an error: the gate
 * treats that as an unverifiable anchor and fails closed.
 */
export interface CheckpointVerifier {
  /** Throws CheckpointReadError('unavailable') only when the key cannot be fetched right now. */
  verify(keyId: string, input: Buffer, signature: Buffer): Promise<boolean>;
}

/**
 * A read on the anchor path failed. Only `unavailable` is transient; `conflict`
 * (two retained checkpoints claim one seq) and `invalid` (a retained object is
 * malformed) are evidence and trip the audit gate until a restart.
 */
export class CheckpointReadError extends Error {
  constructor(readonly code: 'unavailable' | 'conflict' | 'invalid') {
    super(`vault checkpoint read ${code}`);
    this.name = 'CheckpointReadError';
  }
}

/** A signed checkpoint as the sink itself retains it: read back, never taken from vault.checkpoints. */
export interface RetainedCheckpoint {
  seq: number;
  headHash: string;
  at: IsoTime;
  keyId: string;
  /** base64url, exactly as retained. */
  signature: string;
  /** Object name or file path. Never a signed URL. */
  location: string;
}

/**
 * Where signed chain heads go. Create-only: an existing object is never
 * overwritten. NO implementation may set, change or lock a retention policy
 * or enable Bucket Lock or object holds (operator note 01a1fac7-ee88). It may
 * only READ the retention state for health.
 */
export interface CheckpointSink {
  readonly kind: CheckpointSinkKind;
  put(checkpoint: { seq: number; headHash: string; at: IsoTime; keyId: string; signature: string }): Promise<{ anchored: boolean; location: string | null }>;
  health(): Promise<{ ok: boolean; retention: 'locked' | 'unlocked' | 'none' | 'unknown' | 'not_applicable' }>;
  /**
   * The highest-seq checkpoint the sink retains with seq >= `from` (default 0),
   * or null when it retains none. `from` only narrows a listing. Throws
   * CheckpointReadError.
   */
  latest(from?: number): Promise<RetainedCheckpoint | null>;
}

// ---------------------------------------------------------------------------
// Owner authentication (G)
// ---------------------------------------------------------------------------

export interface OwnerSession {
  sessionId: string;
  memberId: string;
  passkeyId: string;
  expiresAt: IsoTime;
}

export interface StepUpBinding {
  action: VaultStepUpAction;
  pathParams: Readonly<Record<string, string>>;
  /** The parsed input. `stepUp` and `clientMutationId` are dropped by `vaultStepUpBoundParams`. */
  body: Readonly<Record<string, unknown>>;
}

export interface StepUpVerified {
  challengeId: string;
  passkeyId: string;
  intentHash: string;
  at: IsoTime;
}

export interface OwnerAuth {
  /**
   * The vault session from the forwarded cookie: live, not revoked, and
   * belonging to the attested member. Null otherwise. Touches `lastUsedAt`.
   */
  resolveSession(caller: VaultCaller, cookies: VaultCookies): Promise<OwnerSession | null>;
  /**
   * Checks a step-up proof for exactly this binding and consumes its challenge
   * (single use), in its OWN transaction. The audit event (`step_up.verified`
   * or `step_up.failed`) is committed whatever the action does next, so a
   * failed attempt is never lost. Throws VaultError `step_up_required` with no
   * proof, `step_up_invalid` for every other failure, `passkey_required` when
   * the member has no passkey.
   */
  verifyStepUp(caller: VaultCaller, session: OwnerSession, proof: VaultStepUpProof | undefined, binding: StepUpBinding): Promise<StepUpVerified>;
  /** For `vault.status`. */
  viewer(caller: VaultCaller, cookies: VaultCookies): Promise<{ passkeys: number; recoveryCodesRemaining: number | null; session: OwnerSession | null }>;
}

// ---------------------------------------------------------------------------
// Spend (J). v1 refuses every spend; the flow is proven with a test processor.
// ---------------------------------------------------------------------------

export type SpendCharge =
  | { state: 'done'; processorRef: string; amountMinor: number; currency: string }
  | { state: 'declined' }
  /** The outcome is not known (timeout, crash). Reconcile with `lookup` before anything else runs for the approval. */
  | { state: 'unknown' };

export interface SpendProcessor {
  /** `disabled` in every v1 deployment. `test` exists only in the test harness. */
  readonly kind: 'disabled' | 'test' | (string & {});
  readonly configured: boolean;
  /** Idempotent on `idempotencyKey` (the operation id). */
  charge(input: { idempotencyKey: string; merchant: string; amountMinor: number; currency: string; signal?: AbortSignal }): Promise<SpendCharge>;
  lookup(idempotencyKey: string): Promise<SpendCharge | { state: 'not_found' }>;
}

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

export const VAULT_ALERT_KINDS = [
  'egress_refused', 'canary_detected', 'value_request_refused', 'fill_repeated_failures',
  'passkey_new_device', 'recovery_code_used', 'refresh_reuse_detected', 'approval_requested', 'audit_unavailable',
] as const;
export type VaultAlertKind = (typeof VAULT_ALERT_KINDS)[number];

/**
 * Metadata only. The broker carries pending alerts to the relay in the
 * `x-tm8-vault-alerts` header of attested responses (src/broker/alerts.ts);
 * the relay strips that header and notifies the owner in tm8.
 */
export interface VaultAlert {
  kind: VaultAlertKind;
  memberId: string;
  spaceId: string;
  itemId: string | null;
  params: Record<string, AuditParam>;
  at: IsoTime;
}

export interface AlertSink {
  raise(alert: VaultAlert): void;
}

// ---------------------------------------------------------------------------
// Broker configuration
// ---------------------------------------------------------------------------

export interface BrokerConfig {
  mode: VaultMode;
  /** `passed` only after the independent review AND the pen test. `production` mode refuses to start without it. */
  reviewGate: 'open' | 'passed';
  /** The tm8 public origin: capture links are `${publicOrigin}/vault/capture/<id>#t=<token>&s=<spaceId>`. */
  publicOrigin: string;
  webauthn: { rpId: string; rpName: string; origins: string[] };
  features: { capture: boolean; fill: boolean; callApi: boolean; spend: false; import: boolean; grants: boolean };
  /** Applies in `pre_review`: admins only, import off, test destinations only. */
  preReview: {
    maxItemsPerMember: number;
    /** Exact origins a fill may target. Empty = every fill refused with `pre_review_limit`. */
    allowedFillOrigins: string[];
    /** Exact hosts an API call may reach. Empty = every call refused with `pre_review_limit`. */
    allowedApiHosts: string[];
  };
  auditSink: CheckpointSinkKind;
}

export const VAULT_COOKIE_NAMES = { session: 'tm8_vault_session', refresh: 'tm8_vault_refresh' } as const;

export interface VaultCookies {
  session: string | null;
  refresh: string | null;
}

/**
 * The broker emits exactly these attributes, and the relay forwards nothing
 * else: HttpOnly; Secure; SameSite=Strict. The path is `/v2/vault` for the
 * session cookie and `/v2/vault/session` for the refresh cookie. A null value
 * clears the cookie (Max-Age=0).
 */
export interface VaultSetCookie {
  name: (typeof VAULT_COOKIE_NAMES)[keyof typeof VAULT_COOKIE_NAMES];
  value: string | null;
  maxAgeSeconds: number;
}

// ---------------------------------------------------------------------------
// Handlers and the dispatcher (H builds the dispatcher; G, H and J the handlers)
// ---------------------------------------------------------------------------

/** In-memory components. None of them writes to the store or audits. */
export interface BrokerComponents {
  kms: KmsProvider;
  /** In memory, regenerated at every start. */
  captureKeys: CaptureKeyPair;
  fillDriver: FillDriver;
  egress: EgressExecutor;
  canaries: CanarySet;
  pasteDetector: PasteDetector;
  importParser: ImportParser;
  spend: SpendProcessor;
  deletionLedger: DeletionLedger;
  alerts: AlertSink;
}

export interface HandlerContext {
  readonly op: VaultOperationName;
  /** The attestation `rid`. */
  readonly requestId: string;
  readonly caller: VaultCaller;
  readonly actor: ActorRecord;
  readonly config: BrokerConfig;
  readonly clock: Clock;
  readonly store: VaultStore;
  readonly auth: OwnerAuth;
  readonly audit: AuditGate;
  readonly components: BrokerComponents;
  /**
   * Set by the dispatcher for `owner_session` and `owner_step_up` ops (it has
   * answered `vault_session_required` otherwise). For `owner_step_up` ops the
   * dispatcher has ALSO verified the step-up before the handler runs. A handler
   * whose step-up is conditional (`approvals.decide` approving,
   * `passkeys.registerBegin` with `stepUp`) calls `auth.verifyStepUp` itself.
   */
  readonly ownerSession: OwnerSession | null;
  readonly stepUp: StepUpVerified | null;
  /** Only the two vault cookies. */
  readonly cookies: VaultCookies;
  readonly signal: AbortSignal;
}

type OpRow<Op extends VaultOperationName> = Extract<(typeof VAULT_OPERATIONS)[number], { name: Op }>;
type PathParamNames<P extends string> =
  P extends `${string}:${infer Name}/${infer Rest}` ? Name | PathParamNames<`/${Rest}`>
    : P extends `${string}:${infer Name}` ? Name : never;

/** `{ itemId: string }` for `/v2/vault/items/:itemId`. The dispatcher has checked each is a UUID. */
export type VaultPathParams<Op extends VaultOperationName> = { readonly [K in PathParamNames<OpRow<Op>['path']>]: string };

export interface HandlerResult<T> {
  data: T;
  setCookies?: VaultSetCookie[];
}

/** `input` was parsed with `VAULT_INPUT_SCHEMAS[op]`; the dispatcher validates `data` with `VAULT_OUTPUT_SCHEMAS[op]`. */
export type VaultHandler<Op extends VaultOperationName> = (
  ctx: HandlerContext,
  request: { params: VaultPathParams<Op>; input: VaultInput<Op> },
) => Promise<HandlerResult<VaultOutput<Op>>>;

export type HandlersFor<Ops extends VaultOperationName> = { readonly [Op in Ops]: VaultHandler<Op> };

/** G: `createOwnerAuthHandlers` in `src/owner-auth/handlers.ts`. */
export const OWNER_AUTH_OPS = [
  'vault.webauthn.challenge', 'vault.session.begin', 'vault.session.refresh', 'vault.session.end',
  'vault.passkeys.registerBegin', 'vault.passkeys.registerFinish', 'vault.passkeys.list', 'vault.passkeys.revoke',
  'vault.sessions.list', 'vault.sessions.revoke', 'vault.recovery.codes.create',
] as const satisfies readonly VaultOperationName[];

/** J: `createAgentActionHandlers` in `src/actions/handlers.ts`. */
export const AGENT_ACTION_OPS = [
  'vault.fill', 'vault.callApi', 'vault.origins.requestAdd', 'vault.spend.request', 'vault.spend.execute',
  'vault.operations.get', 'vault.approvals.list', 'vault.approvals.get', 'vault.approvals.decide',
] as const satisfies readonly VaultOperationName[];

/** H: `createBrokerCoreHandlers` in `src/broker/handlers/index.ts`. */
export const BROKER_CORE_OPS = [
  'vault.status', 'vault.items.list', 'vault.items.get', 'vault.items.activity',
  'vault.captureLinks.create', 'vault.captures.open', 'vault.captures.submit',
  'vault.items.update', 'vault.items.setProperties', 'vault.items.delete', 'vault.policies.set',
  'vault.grants.list', 'vault.grants.create', 'vault.grants.revoke',
  'vault.imports.begin', 'vault.imports.upload', 'vault.imports.commit', 'vault.imports.cancel',
  'vault.audit.list', 'vault.audit.verify',
] as const satisfies readonly VaultOperationName[];

export type OwnerAuthOp = (typeof OWNER_AUTH_OPS)[number];
export type AgentActionOp = (typeof AGENT_ACTION_OPS)[number];
export type BrokerCoreOp = (typeof BROKER_CORE_OPS)[number];

/** Compile-time proof that the three groups cover every op exactly once. */
type Missing = Exclude<VaultOperationName, OwnerAuthOp | AgentActionOp | BrokerCoreOp>;
type Overlap = (OwnerAuthOp & AgentActionOp) | (OwnerAuthOp & BrokerCoreOp) | (AgentActionOp & BrokerCoreOp);
export const OP_PARTITION_IS_EXACT: [Missing, Overlap] extends [never, never] ? true : never = true;

export type VaultHandlers = HandlersFor<VaultOperationName>;
