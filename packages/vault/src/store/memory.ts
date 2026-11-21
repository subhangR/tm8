import { UUID_RE, HEX64_RE, ISO_MS_RE, B64URL_RE, ARGON2ID_RE, PRINTABLE_RE, ITEM_TYPES, EXPOSURE_TIERS, SESSION_END_REASONS, CHALLENGE_PURPOSES, OPERATION_KINDS, FINAL_OPERATION_STATES, SYSTEM_PURPOSES, AUDIT_ACTIONS, bad, uuid, nullableUuid, hex64, isIsoMs, iso, text, nullableText, bool, int, oneOf, strings, sortedUnique, actorRecord, scopeActor, auditParams, jsonValue, metadataPatch, secretVersion, earliest, deepFreeze, out, outSecret, clampLimit, encodeCursor, decodeCursor, timeCursor, seqCursor, compareTimeKey, newestFirst, pageByTime, pageBySeq, checkScope, argon2idHash, oldestCodeFirst, oldestOperationFirst } from './validation.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { VAULT_AUDIT_ACTIONS, VAULT_ITEM_TYPES, VAULT_STEP_UP_ACTIONS } from '@tm8/contract';
import { AUDIT_GENESIS_HASH, sealAuditEvent } from '../audit/chain.js';
import { VAULT_CIPHER_SUITE, type EncryptedSecretVersion } from '../crypto/aead.js';
import { APPROVAL_KINDS, digestEquals } from '../intent/hash.js';
import {
  AuditUnavailableError,
  SYSTEM_ACTOR,
  StoreDuplicateError,
  StoreNotFoundError,
  StoreScopeError,
  StoreStateError,
  StoreUnavailableError,
  StoreVersionConflictError,
  VaultError,
  effectiveApprovalState,
  isoNow,
  systemClock,
  type ActorRecord,
  type ApprovalKind,
  type ApprovalRecord,
  type ApprovalState,
  type ApprovalsRepo,
  type AuditBody,
  type AuditEventRecord,
  type AuditParam,
  type AuditRepo,
  type CaptureLinkRecord,
  type CaptureLinksRepo,
  type ChallengePurpose,
  type ChallengeRecord,
  type ChallengesRepo,
  type CheckpointRecord,
  type Clock,
  type CodeRecord,
  type DeletionLedgerEntry,
  type DeletionLedgerRepo,
  type EnrollmentCodeRecord,
  type EnrollmentCodesRepo,
  type GrantConstraints,
  type GrantRecord,
  type GrantsRepo,
  type IsoTime,
  type ItemMetadataFields,
  type ItemRecord,
  type ItemsRepo,
  type NewApproval,
  type NewItem,
  type OperationKind,
  type OperationRecord,
  type OperationState,
  type OperationsRepo,
  type Page,
  type PageQuery,
  type PasskeyRecord,
  type PasskeysRepo,
  type PoliciesRepo,
  type PolicyInput,
  type PolicyRecord,
  type RecoveryCodesRepo,
  type RefreshRotation,
  type SecretVersionRecord,
  type SessionEndReason,
  type SpendRepo,
  type SpendRequestRecord,
  type StoreScope,
  type VaultSessionRecord,
  type VaultSessionsRepo,
  type VaultStore,
  type VaultTx,
} from '../core-types.js';

/**
 * The reference `VaultStore`: every rule in core-types.ts, in memory. It is
 * the specification wherever core-types leaves room, and F's conformance suite
 * runs the Postgres store against it.
 *
 * - Transactions are serialized (one at a time) and copy-on-write: a
 *   transaction works on a fork of the committed state, and only a resolved
 *   `fn` swaps it in. A nested transaction throws instead of deadlocking.
 * - Stored records are deep-frozen and never mutated: a write stores a new
 *   object. Callers get clones, so nothing they do reaches the store.
 * - Inputs are copied field by field, so a stray field (a token, a bound
 *   param) is never kept: the same effect as a fixed set of columns.
 * - It refuses value-shaped data where metadata belongs: every hash must be a
 *   64-hex digest, a code hash an Argon2id string, `last4` four digits.
 * - Ids are UUIDs, lowercased as Postgres returns them. Times are
 *   `toISOString()` form. A malformed id or time is a broker bug: TypeError.
 *
 * Use it in tests and in `dev` mode only. A transaction that never settles
 * blocks every later one.
 */
export interface MemoryStoreFaults {
  /** Every new transaction, every repo call and every commit fails with StoreUnavailableError. */
  unavailable: boolean;
  /** Every audit append fails with AuditUnavailableError. */
  auditAppend: boolean;
}

/** Opaque. From `testing.snapshot()`. */
export type MemoryStoreSnapshot = { readonly __memoryStoreSnapshot: never };

type SystemPurpose = Extract<StoreScope, { kind: 'system' }>['purpose'];

interface MemoryState {
  readonly items: Map<string, ItemRecord>;
  /** itemId -> stored versions. Rotation and tombstone delete old ones. */
  readonly secrets: Map<string, readonly SecretVersionRecord[]>;
  readonly policies: Map<string, PolicyRecord>;
  readonly grants: Map<string, GrantRecord>;
  readonly approvals: Map<string, ApprovalRecord>;
  /** `${memberId}|${operationId}` */
  readonly operations: Map<string, OperationRecord>;
  /** approvalId -> request */
  readonly spend: Map<string, SpendRequestRecord>;
  readonly passkeys: Map<string, PasskeyRecord>;
  readonly sessions: Map<string, VaultSessionRecord>;
  /** Superseded refresh hash -> session id, to detect reuse. */
  readonly supersededRefresh: Map<string, string>;
  readonly challenges: Map<string, ChallengeRecord>;
  readonly recoveryCodes: Map<string, CodeRecord>;
  readonly enrollmentCodes: Map<string, EnrollmentCodeRecord>;
  readonly captureLinks: Map<string, CaptureLinkRecord>;
  /** itemId -> mirror row */
  readonly deletionLedger: Map<string, DeletionLedgerEntry>;
  readonly audit: AuditEventRecord[];
  readonly checkpoints: CheckpointRecord[];
}

function emptyState(): MemoryState {
  return {
    items: new Map(), secrets: new Map(), policies: new Map(), grants: new Map(), approvals: new Map(),
    operations: new Map(), spend: new Map(), passkeys: new Map(), sessions: new Map(), supersededRefresh: new Map(),
    challenges: new Map(), recoveryCodes: new Map(), enrollmentCodes: new Map(), captureLinks: new Map(),
    deletionLedger: new Map(), audit: [], checkpoints: [],
  };
}

function forkState(s: MemoryState): MemoryState {
  return {
    items: new Map(s.items), secrets: new Map(s.secrets), policies: new Map(s.policies), grants: new Map(s.grants),
    approvals: new Map(s.approvals), operations: new Map(s.operations), spend: new Map(s.spend),
    passkeys: new Map(s.passkeys), sessions: new Map(s.sessions), supersededRefresh: new Map(s.supersededRefresh),
    challenges: new Map(s.challenges), recoveryCodes: new Map(s.recoveryCodes), enrollmentCodes: new Map(s.enrollmentCodes),
    captureLinks: new Map(s.captureLinks), deletionLedger: new Map(s.deletionLedger),
    audit: s.audit.slice(), checkpoints: s.checkpoints.slice(),
  };
}

const SNAPSHOTS = new WeakMap<object, MemoryState>();
const noop = (): void => undefined;

// ---------------------------------------------------------------------------
// Input checks. Each returns a fresh copy of what it accepts.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

export class MemoryVaultStore implements VaultStore {
  readonly faults: MemoryStoreFaults = { unavailable: false, auditAppend: false };
  readonly #clock: Clock;
  readonly #inTransaction = new AsyncLocalStorage<true>();
  #state: MemoryState = emptyState();
  #tail: Promise<unknown> = Promise.resolve();
  #closed = false;

  constructor(options: { clock?: Clock } = {}) {
    this.#clock = options.clock ?? systemClock;
  }

  transaction<T>(scope: StoreScope, fn: (tx: VaultTx) => Promise<T>): Promise<T> {
    if (this.#inTransaction.getStore()) return Promise.reject(new Error('vault store: nested transaction'));
    let checked: StoreScope;
    try {
      checked = checkScope(scope);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.#exclusive(() => this.#run(checked, fn));
  }

  async health(): Promise<{ ok: boolean }> {
    return { ok: !this.#closed && !this.faults.unavailable };
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.#tail;
  }

  /** Test hooks. Nothing reaches these from a request. */
  readonly testing = {
    /** The committed state now. Cheap: committed state is never mutated. */
    snapshot: (): MemoryStoreSnapshot => {
      const token = Object.freeze({}) as MemoryStoreSnapshot;
      SNAPSHOTS.set(token, this.#state);
      return token;
    },
    /** A database restore: back to `snapshot`, losing everything after it. */
    restore: (snapshot: MemoryStoreSnapshot): Promise<void> => this.#exclusive(async () => {
      const state = SNAPSHOTS.get(snapshot);
      if (!state) throw new TypeError('vault store: unknown snapshot');
      this.#state = state;
    }),
    /** Edits a stored audit event behind the chain's back (tamper-evidence tests). */
    tamperAuditEvent: (seq: number, patch: Partial<AuditEventRecord>): Promise<void> => this.#exclusive(async () => {
      const next = forkState(this.#state);
      const index = next.audit.findIndex((event) => event.seq === seq);
      const event = next.audit[index];
      if (!event) throw new TypeError('vault store: no such audit event');
      next.audit[index] = deepFreeze({ ...out(event), ...out(patch) });
      this.#state = next;
    }),
    deleteAuditEvent: (seq: number): Promise<void> => this.#exclusive(async () => {
      const next = forkState(this.#state);
      const index = next.audit.findIndex((event) => event.seq === seq);
      if (index < 0) throw new TypeError('vault store: no such audit event');
      next.audit.splice(index, 1);
      this.#state = next;
    }),
    /** Stored secret versions for an item, whatever its state. */
    secretVersionCount: (itemId: string): number => this.#state.secrets.get(itemId.toLowerCase())?.length ?? 0,
  };

  #exclusive<T>(job: () => Promise<T>): Promise<T> {
    const run = this.#tail.then(job);
    this.#tail = run.then(noop, noop);
    return run;
  }

  async #run<T>(scope: StoreScope, fn: (tx: VaultTx) => Promise<T>): Promise<T> {
    if (this.#closed || this.faults.unavailable) throw new StoreUnavailableError();
    const draft = forkState(this.#state);
    const ctx = new Ctx(draft, scope, isoNow(this.#clock), this.#clock, this.faults);
    try {
      const result = await this.#inTransaction.run(true, () => fn(ctx.tx));
      if (ctx.dead) throw ctx.deadError();
      if (this.faults.unavailable) throw new StoreUnavailableError();
      this.#state = draft;
      return result;
    } finally {
      ctx.closed = true;
    }
  }
}

/** One transaction: the forked state, the scope, and the visibility rules. */
class Ctx {
  readonly nowMs: number;
  closed = false;
  dead: 'audit' | 'store' | null = null;
  readonly tx: VaultTx;

  constructor(
    readonly s: MemoryState,
    readonly scope: StoreScope,
    readonly now: IsoTime,
    readonly clock: Clock,
    readonly faults: MemoryStoreFaults,
  ) {
    this.nowMs = Date.parse(now);
    this.tx = Object.freeze({
      now,
      scope,
      items: new Items(this),
      policies: new Policies(this),
      grants: new Grants(this),
      approvals: new Approvals(this),
      operations: new Operations(this),
      spend: new Spend(this),
      passkeys: new Passkeys(this),
      sessions: new Sessions(this),
      challenges: new Challenges(this),
      recoveryCodes: new RecoveryCodes(this),
      enrollmentCodes: new EnrollmentCodes(this),
      captureLinks: new CaptureLinks(this),
      audit: new Audit(this),
      deletionLedger: new DeletionLedgerMirror(this),
    });
  }

  deadError(): Error {
    return this.dead === 'audit' ? new AuditUnavailableError() : new StoreUnavailableError();
  }

  /** Every repo call starts here. */
  enter(): void {
    if (this.closed) throw new Error('vault store: the transaction has ended');
    if (this.dead) throw this.deadError();
    if (this.faults.unavailable) {
      this.dead = 'store';
      throw new StoreUnavailableError();
    }
  }

  member(): { memberId: string; spaceId: string } {
    if (this.scope.kind !== 'member') throw new StoreScopeError('member');
    return this.scope;
  }

  system(purpose?: SystemPurpose): void {
    if (this.scope.kind !== 'system' || (purpose !== undefined && this.scope.purpose !== purpose)) throw new StoreScopeError('system');
  }

  get isSystem(): boolean {
    return this.scope.kind === 'system';
  }

  /** True once `at` has passed. */
  lapsed(at: IsoTime): boolean {
    return Date.parse(at) <= this.nowMs;
  }

  grantLive(grant: GrantRecord): boolean {
    return grant.revokedAt === null && (grant.expiresAt === null || !this.lapsed(grant.expiresAt));
  }

  grantNamesScope(grant: GrantRecord): boolean {
    if (this.scope.kind !== 'member') return false;
    const { memberId, spaceId } = this.scope;
    return grant.spaceId === spaceId
      && ((grant.granteeKind === 'member' && grant.granteeId === memberId) || (grant.granteeKind === 'space' && grant.granteeId === spaceId));
  }

  owns(item: ItemRecord): boolean {
    if (this.scope.kind === 'system') return true;
    return item.spaceId === this.scope.spaceId && item.ownerMemberId === this.scope.memberId;
  }

  canSeeItem(item: ItemRecord): boolean {
    if (this.owns(item)) return true;
    for (const grant of this.s.grants.values()) {
      if (grant.itemId === item.id && this.grantLive(grant) && this.grantNamesScope(grant)) return true;
    }
    return false;
  }

  visibleItem(itemId: string): ItemRecord {
    const item = this.s.items.get(uuid(itemId, 'itemId'));
    if (!item || !this.canSeeItem(item)) throw new StoreNotFoundError();
    return item;
  }

  ownedItem(itemId: string): ItemRecord {
    const item = this.s.items.get(uuid(itemId, 'itemId'));
    if (!item || !this.owns(item)) throw new StoreNotFoundError();
    return item;
  }

  ownedLiveItem(itemId: string): ItemRecord {
    const item = this.ownedItem(itemId);
    if (item.state === 'tombstoned') throw new StoreStateError('tombstoned');
    return item;
  }

  /** The compare-and-set preamble, in the documented order. */
  casItem(itemId: string, expectedVersion: number): ItemRecord {
    const item = this.ownedLiveItem(itemId);
    if (expectedVersion !== item.version) throw new StoreVersionConflictError(item.version);
    return item;
  }

  canSeeGrant(grant: GrantRecord): boolean {
    if (this.scope.kind === 'system') return true;
    if (grant.spaceId !== this.scope.spaceId) return false;
    return this.s.items.get(grant.itemId)?.ownerMemberId === this.scope.memberId || this.grantNamesScope(grant);
  }

  canSeeApproval(approval: ApprovalRecord): boolean {
    if (this.scope.kind === 'system') return true;
    return approval.spaceId === this.scope.spaceId
      && (approval.ownerMemberId === this.scope.memberId || approval.requesterMemberId === this.scope.memberId);
  }

  viewApproval(approval: ApprovalRecord): ApprovalRecord {
    const view = out(approval);
    view.state = effectiveApprovalState(approval, this.now);
    return view;
  }

  putItem(next: ItemRecord): ItemRecord {
    this.s.items.set(next.id, deepFreeze(next));
    return out(next);
  }

  bumpItem(item: ItemRecord, patch: Partial<ItemRecord>): ItemRecord {
    return this.putItem({ ...item, ...patch, version: item.version + 1, updatedAt: this.now });
  }

  /** The effects every tombstone shares. True when anything changed. */
  tombstoneEffects(entry: DeletionLedgerEntry, actor: ActorRecord): boolean {
    let changed = false;
    if (this.s.secrets.delete(entry.itemId)) changed = true;
    for (const grant of this.s.grants.values()) {
      if (grant.itemId === entry.itemId && grant.revokedAt === null) {
        this.s.grants.set(grant.id, deepFreeze({ ...grant, revokedAt: this.now, revokedBy: actor }));
        changed = true;
      }
    }
    for (const approval of this.s.approvals.values()) {
      if (approval.itemId === entry.itemId
        && (approval.state === 'pending' || (approval.state === 'approved' && approval.oneUse && approval.consumedAt === null))) {
        this.s.approvals.set(approval.id, deepFreeze({ ...approval, state: 'expired' }));
        changed = true;
      }
    }
    if (!this.s.deletionLedger.has(entry.itemId)) {
      this.s.deletionLedger.set(entry.itemId, deepFreeze({ ...entry }));
      changed = true;
    }
    return changed;
  }

  hashInUse(hash: string): boolean {
    for (const session of this.s.sessions.values()) {
      if (session.tokenHash === hash || session.refreshHash === hash) return true;
    }
    return this.s.supersededRefresh.has(hash);
  }

  sessionEnded(session: VaultSessionRecord): boolean {
    return session.revokedAt !== null || this.lapsed(session.refreshExpiresAt) || this.lapsed(session.familyExpiresAt);
  }
}

// ---------------------------------------------------------------------------
// Repos
// ---------------------------------------------------------------------------

class Items implements ItemsRepo {
  constructor(private readonly c: Ctx) {}

  async create(item: NewItem, secret: EncryptedSecretVersion): Promise<ItemRecord> {
    const c = this.c;
    c.enter();
    const { memberId, spaceId } = c.member();
    const id = uuid(item.id, 'itemId');
    if (c.s.items.has(id)) throw new StoreDuplicateError();
    const type = oneOf(item.type, ITEM_TYPES, 'item type');
    const origins = strings(item.origins, 'origins');
    if (type !== 'login' && origins.length > 0) throw new StoreStateError('wrong_item_type');
    const meta = metadataPatch(item);
    const record: ItemRecord = {
      id,
      spaceId,
      ownerMemberId: memberId,
      version: 1,
      type,
      name: text(item.name, 'name', 500),
      state: oneOf(item.state, ['active', 'blocked_until_rotated'] as const, 'item state'),
      exposureTier: item.exposureTier === null ? null : oneOf(item.exposureTier, EXPOSURE_TIERS, 'exposureTier'),
      origins: sortedUnique(origins),
      devMode: bool(item.devMode, 'devMode'),
      username: meta.username ?? null,
      last4: meta.last4 ?? null,
      expMonth: meta.expMonth ?? null,
      expYear: meta.expYear ?? null,
      connector: meta.connector ?? null,
      hasTotp: bool(item.hasTotp, 'hasTotp'),
      hasNotes: bool(item.hasNotes, 'hasNotes'),
      fieldNames: meta.fieldNames ?? bad('fieldNames'),
      secretVersion: 1,
      createdAt: c.now,
      updatedAt: c.now,
      rotatedAt: null,
      tombstonedAt: null,
      createdBy: scopeActor(item.createdBy, memberId),
    };
    c.s.secrets.set(id, Object.freeze([secretVersion(secret, id, 1, c.now)]));
    return c.putItem(record);
  }

  async get(itemId: string): Promise<ItemRecord | null> {
    const c = this.c;
    c.enter();
    const item = c.s.items.get(uuid(itemId, 'itemId'));
    return item && c.canSeeItem(item) ? out(item) : null;
  }

  async list(query: PageQuery & { type?: ItemRecord['type']; access?: 'owner' | 'grant'; includeTombstoned?: boolean }): Promise<Page<ItemRecord>> {
    const c = this.c;
    c.enter();
    if (query.access !== undefined) {
      c.member();
      oneOf(query.access, ['owner', 'grant'] as const, 'access');
    }
    const type = query.type === undefined ? undefined : oneOf(query.type, ITEM_TYPES, 'item type');
    const rows: ItemRecord[] = [];
    for (const item of c.s.items.values()) {
      if (!c.canSeeItem(item)) continue;
      if (type !== undefined && item.type !== type) continue;
      if (!query.includeTombstoned && item.state === 'tombstoned') continue;
      if (query.access === 'owner' && !c.owns(item)) continue;
      if (query.access === 'grant' && c.owns(item)) continue;
      rows.push(item);
    }
    return pageByTime(rows, query, out);
  }

  async update(itemId: string, expectedVersion: number, patch: { name?: string; username?: string | null }): Promise<ItemRecord> {
    const c = this.c;
    c.enter();
    const item = c.casItem(itemId, expectedVersion);
    const change: Partial<ItemRecord> = {};
    if (patch.name !== undefined) change.name = text(patch.name, 'name', 500);
    if (patch.username !== undefined) change.username = nullableText(patch.username, 'username', 500);
    return c.bumpItem(item, change);
  }

  async setProperties(itemId: string, expectedVersion: number, change: { addOrigins?: string[]; removeOrigins?: string[]; devMode?: boolean }): Promise<ItemRecord> {
    const c = this.c;
    c.enter();
    const item = c.casItem(itemId, expectedVersion);
    const add = change.addOrigins === undefined ? [] : strings(change.addOrigins, 'addOrigins');
    const remove = change.removeOrigins === undefined ? [] : strings(change.removeOrigins, 'removeOrigins');
    if ((add.length > 0 || remove.length > 0) && item.type !== 'login') throw new StoreStateError('wrong_item_type');
    const removed = new Set(remove);
    const patch: Partial<ItemRecord> = { origins: sortedUnique([...item.origins, ...add]).filter((origin) => !removed.has(origin)) };
    if (change.devMode !== undefined) patch.devMode = bool(change.devMode, 'devMode');
    return c.bumpItem(item, patch);
  }

  async addOrigin(itemId: string, origin: string): Promise<ItemRecord> {
    const c = this.c;
    c.enter();
    const item = c.ownedLiveItem(itemId);
    if (item.type !== 'login') throw new StoreStateError('wrong_item_type');
    const value = text(origin, 'origin', 2000);
    if (item.origins.includes(value)) return out(item);
    return c.bumpItem(item, { origins: sortedUnique([...item.origins, value]) });
  }

  async replaceSecret(itemId: string, expectedVersion: number, secret: EncryptedSecretVersion, metadata: Partial<ItemMetadataFields>): Promise<ItemRecord> {
    const c = this.c;
    c.enter();
    const item = c.casItem(itemId, expectedVersion);
    const next = item.secretVersion + 1;
    const patch = metadataPatch(metadata);
    const stored = secretVersion(secret, item.id, next, c.now);
    c.s.secrets.set(item.id, Object.freeze([stored]));
    return c.bumpItem(item, { ...patch, secretVersion: next, rotatedAt: c.now, state: 'active' });
  }

  async currentSecret(itemId: string): Promise<SecretVersionRecord | null> {
    const c = this.c;
    c.enter();
    const item = c.s.items.get(uuid(itemId, 'itemId'));
    if (!item || !c.canSeeItem(item) || item.state === 'tombstoned') return null;
    const live = c.s.secrets.get(item.id)?.find((version) => version.version === item.secretVersion);
    return live ? outSecret(live) : null;
  }

  async tombstone(itemId: string, expectedVersion: number, actor: ActorRecord): Promise<ItemRecord> {
    const c = this.c;
    c.enter();
    const item = c.casItem(itemId, expectedVersion);
    const by = actorRecord(actor);
    c.tombstoneEffects({ itemId: item.id, spaceId: item.spaceId, ownerMemberId: item.ownerMemberId, tombstonedAt: c.now }, by);
    return c.bumpItem(item, { state: 'tombstoned', tombstonedAt: c.now });
  }

  async countOwned(): Promise<number> {
    const c = this.c;
    c.enter();
    const { memberId, spaceId } = c.member();
    let count = 0;
    for (const item of c.s.items.values()) {
      if (item.spaceId === spaceId && item.ownerMemberId === memberId && item.state !== 'tombstoned') count += 1;
    }
    return count;
  }

  async forceTombstone(entry: DeletionLedgerEntry): Promise<boolean> {
    const c = this.c;
    c.enter();
    c.system();
    const checked: DeletionLedgerEntry = {
      itemId: uuid(entry.itemId, 'itemId'),
      spaceId: uuid(entry.spaceId, 'spaceId'),
      ownerMemberId: uuid(entry.ownerMemberId, 'ownerMemberId'),
      tombstonedAt: iso(entry.tombstonedAt, 'tombstonedAt'),
    };
    let changed = c.tombstoneEffects(checked, SYSTEM_ACTOR);
    const item = c.s.items.get(checked.itemId);
    if (item && item.state !== 'tombstoned') {
      c.bumpItem(item, { state: 'tombstoned', tombstonedAt: checked.tombstonedAt });
      changed = true;
    }
    return changed;
  }
}

class Policies implements PoliciesRepo {
  constructor(private readonly c: Ctx) {}

  async get(itemId: string): Promise<PolicyRecord | null> {
    const c = this.c;
    c.enter();
    const item = c.s.items.get(uuid(itemId, 'itemId'));
    if (!item || !c.canSeeItem(item)) return null;
    const policy = c.s.policies.get(item.id);
    return policy ? out(policy) : null;
  }

  async set(itemId: string, expectedItemVersion: number, policy: PolicyInput, createdBy: ActorRecord): Promise<{ policy: PolicyRecord; item: ItemRecord }> {
    const c = this.c;
    c.enter();
    const item = c.casItem(itemId, expectedItemVersion);
    if (item.type !== 'api_key') throw new StoreStateError('wrong_item_type');
    const record: PolicyRecord = {
      itemId: item.id,
      version: (c.s.policies.get(item.id)?.version ?? 0) + 1,
      mode: oneOf(policy.mode, ['connector', 'generic'] as const, 'policy mode'),
      connector: nullableText(policy.connector, 'connector', 100),
      hosts: strings(policy.hosts, 'hosts'),
      methods: strings(policy.methods, 'methods') as PolicyRecord['methods'],
      pathPrefixes: strings(policy.pathPrefixes, 'pathPrefixes'),
      maxRequestBytes: int(policy.maxRequestBytes, 'maxRequestBytes', 0),
      maxResponseBytes: int(policy.maxResponseBytes, 'maxResponseBytes', 0),
      injection: structuredClone(policy.injection),
      createdAt: c.now,
      createdBy: actorRecord(createdBy),
    };
    c.s.policies.set(item.id, deepFreeze(record));
    return { policy: out(record), item: c.bumpItem(item, {}) };
  }
}

class Grants implements GrantsRepo {
  constructor(private readonly c: Ctx) {}

  async create(grant: { id: string; itemId: string; granteeKind: GrantRecord['granteeKind']; granteeId: string; constraints: GrantConstraints; expiresAt: IsoTime | null; createdBy: ActorRecord }): Promise<GrantRecord> {
    const c = this.c;
    c.enter();
    const item = c.ownedLiveItem(grant.itemId);
    const id = uuid(grant.id, 'grantId');
    if (c.s.grants.has(id)) throw new StoreDuplicateError();
    const granteeKind = oneOf(grant.granteeKind, ['space', 'member'] as const, 'granteeKind');
    const granteeId = uuid(grant.granteeId, 'granteeId');
    if (granteeKind === 'space' && granteeId !== item.spaceId) throw new StoreStateError('cross_space');
    if (granteeKind === 'member' && granteeId === item.ownerMemberId) throw new StoreStateError('self_grant');
    const constraints = grant.constraints;
    const record: GrantRecord = {
      id,
      itemId: item.id,
      spaceId: item.spaceId,
      granteeKind,
      granteeId,
      constraints: {
        origins: constraints.origins === null ? null : sortedUnique(strings(constraints.origins, 'constraint origins')),
        hosts: constraints.hosts === null ? null : sortedUnique(strings(constraints.hosts, 'constraint hosts')),
        requireApprovalPerUse: bool(constraints.requireApprovalPerUse, 'requireApprovalPerUse'),
      },
      expiresAt: grant.expiresAt === null ? null : iso(grant.expiresAt, 'expiresAt'),
      createdAt: c.now,
      createdBy: actorRecord(grant.createdBy),
      revokedAt: null,
      revokedBy: null,
    };
    c.s.grants.set(id, deepFreeze(record));
    return out(record);
  }

  async get(grantId: string): Promise<GrantRecord | null> {
    const c = this.c;
    c.enter();
    const grant = c.s.grants.get(uuid(grantId, 'grantId'));
    return grant && c.canSeeGrant(grant) ? out(grant) : null;
  }

  async listForItem(itemId: string): Promise<GrantRecord[]> {
    const c = this.c;
    c.enter();
    const item = c.ownedItem(itemId);
    return [...c.s.grants.values()].filter((grant) => grant.itemId === item.id).sort(newestFirst).map(out);
  }

  async revoke(grantId: string, revokedBy: ActorRecord): Promise<GrantRecord> {
    const c = this.c;
    c.enter();
    const grant = c.s.grants.get(uuid(grantId, 'grantId'));
    const item = grant ? c.s.items.get(grant.itemId) : undefined;
    if (!grant || !item || !c.owns(item)) throw new StoreNotFoundError();
    if (grant.revokedAt !== null) return out(grant);
    const next: GrantRecord = { ...grant, revokedAt: c.now, revokedBy: actorRecord(revokedBy) };
    c.s.grants.set(grant.id, deepFreeze(next));
    return out(next);
  }

  async activeForCaller(itemId: string): Promise<GrantRecord[]> {
    const c = this.c;
    c.enter();
    c.member();
    const id = uuid(itemId, 'itemId');
    return [...c.s.grants.values()]
      .filter((grant) => grant.itemId === id && c.grantLive(grant) && c.grantNamesScope(grant))
      .sort(newestFirst)
      .map(out);
  }

  async countActive(itemId: string): Promise<number> {
    const c = this.c;
    c.enter();
    const id = uuid(itemId, 'itemId');
    let count = 0;
    for (const grant of c.s.grants.values()) if (grant.itemId === id && c.grantLive(grant) && c.canSeeGrant(grant)) count += 1;
    return count;
  }
}

class Approvals implements ApprovalsRepo {
  constructor(private readonly c: Ctx) {}

  async create(approval: NewApproval): Promise<ApprovalRecord> {
    const c = this.c;
    c.enter();
    const { memberId } = c.member();
    const item = c.visibleItem(approval.itemId);
    if (item.state === 'tombstoned') throw new StoreStateError('tombstoned');
    const id = uuid(approval.id, 'approvalId');
    if (c.s.approvals.has(id)) throw new StoreDuplicateError();
    const kind = oneOf(approval.kind, APPROVAL_KINDS, 'approval kind');
    const record: ApprovalRecord = {
      id,
      itemId: item.id,
      spaceId: item.spaceId,
      ownerMemberId: item.ownerMemberId,
      kind,
      state: 'pending',
      oneUse: bool(approval.oneUse, 'oneUse'),
      intentHash: hex64(approval.intentHash, 'intentHash'),
      boundParams: auditParams(approval.boundParams, 'boundParams'),
      requestedBy: scopeActor(approval.requestedBy, memberId),
      requesterMemberId: memberId,
      purpose: nullableText(approval.purpose, 'purpose', 500),
      lookalike: approval.lookalike.map((finding) => ({
        kind: oneOf(finding.kind, ['confusable', 'mixed_script', 'edit_distance', 'brand_embedding'] as const, 'lookalike kind'),
        similarTo: nullableText(finding.similarTo, 'similarTo', 500),
      })),
      spend: approval.spend === null ? null : {
        merchant: text(approval.spend.merchant, 'merchant', 500),
        amountMinor: int(approval.spend.amountMinor, 'amountMinor', 1),
        currency: text(approval.spend.currency, 'currency', 3),
        itemSummary: text(approval.spend.itemSummary, 'itemSummary', 500),
        instrumentTier: oneOf(approval.spend.instrumentTier, ['tier1'] as const, 'instrumentTier'),
      },
      operationId: nullableUuid(approval.operationId, 'operationId'),
      createdAt: c.now,
      expiresAt: iso(approval.expiresAt, 'expiresAt'),
      decidedAt: null,
      decidedBy: null,
      standing: false,
      consumedAt: null,
      consumedByOperationId: null,
    };
    if ((kind === 'spend') !== (record.spend !== null)) bad('spend details (required for spend approvals only)');
    c.s.approvals.set(id, deepFreeze(record));
    return c.viewApproval(record);
  }

  async get(approvalId: string): Promise<ApprovalRecord | null> {
    const c = this.c;
    c.enter();
    const approval = c.s.approvals.get(uuid(approvalId, 'approvalId'));
    return approval && c.canSeeApproval(approval) ? c.viewApproval(approval) : null;
  }

  async list(query: PageQuery & { state?: ApprovalState; itemId?: string }): Promise<Page<ApprovalRecord>> {
    const c = this.c;
    c.enter();
    const itemId = query.itemId === undefined ? undefined : uuid(query.itemId, 'itemId');
    const rows = [...c.s.approvals.values()].filter((approval) => c.canSeeApproval(approval)
      && (itemId === undefined || approval.itemId === itemId)
      && (query.state === undefined || effectiveApprovalState(approval, c.now) === query.state));
    return pageByTime(rows, query, (row) => c.viewApproval(row));
  }

  async findPending(itemId: string, kind: ApprovalKind, intentHash: string): Promise<ApprovalRecord | null> {
    return this.#find(itemId, kind, intentHash, (approval) => effectiveApprovalState(approval, this.c.now) === 'pending');
  }

  async findUsable(itemId: string, kind: ApprovalKind, intentHash: string): Promise<ApprovalRecord | null> {
    return this.#find(itemId, kind, intentHash, (approval) => approval.oneUse
      && effectiveApprovalState(approval, this.c.now) === 'approved');
  }

  #find(itemId: string, kind: ApprovalKind, intentHash: string, accept: (approval: ApprovalRecord) => boolean): ApprovalRecord | null {
    const c = this.c;
    c.enter();
    const { memberId, spaceId } = c.member();
    const id = uuid(itemId, 'itemId');
    const hash = hex64(intentHash, 'intentHash');
    const match = [...c.s.approvals.values()]
      .filter((approval) => approval.itemId === id && approval.spaceId === spaceId && approval.kind === kind
        && approval.requesterMemberId === memberId && digestEquals(approval.intentHash, hash) && accept(approval))
      .sort(newestFirst)[0];
    return match ? c.viewApproval(match) : null;
  }

  async decide(approvalId: string, decision: { state: 'approved' | 'denied'; decidedBy: ActorRecord; standing: boolean }): Promise<ApprovalRecord> {
    const c = this.c;
    c.enter();
    const { memberId } = c.member();
    const approval = c.s.approvals.get(uuid(approvalId, 'approvalId'));
    if (!approval || !c.canSeeApproval(approval) || approval.ownerMemberId !== memberId) throw new StoreNotFoundError();
    const state = oneOf(decision.state, ['approved', 'denied'] as const, 'decision');
    const standing = bool(decision.standing, 'standing');
    const decidedBy = actorRecord(decision.decidedBy);
    if (decidedBy.kind !== 'member' || decidedBy.memberId !== memberId) bad('decidedBy (only the owner, as a member, decides)');
    const effective = effectiveApprovalState(approval, c.now);
    if (effective !== 'pending') throw new StoreStateError(effective);
    if (standing && (state !== 'approved' || approval.kind !== 'new_origin')) throw new StoreStateError('standing_not_allowed');
    const next: ApprovalRecord = { ...approval, state, decidedAt: c.now, decidedBy, standing, oneUse: standing ? false : approval.oneUse };
    c.s.approvals.set(approval.id, deepFreeze(next));
    return c.viewApproval(next);
  }

  async consume(approvalId: string, operationId: string): Promise<ApprovalRecord> {
    const c = this.c;
    c.enter();
    const { memberId } = c.member();
    const approval = c.s.approvals.get(uuid(approvalId, 'approvalId'));
    if (!approval || !c.canSeeApproval(approval) || approval.requesterMemberId !== memberId) throw new StoreNotFoundError();
    const effective = effectiveApprovalState(approval, c.now);
    if (effective !== 'approved') throw new StoreStateError(effective);
    if (!approval.oneUse) throw new StoreStateError('not_one_use');
    const next: ApprovalRecord = { ...approval, state: 'consumed', consumedAt: c.now, consumedByOperationId: uuid(operationId, 'operationId') };
    c.s.approvals.set(approval.id, deepFreeze(next));
    return c.viewApproval(next);
  }

  async expireDue(): Promise<ApprovalRecord[]> {
    const c = this.c;
    c.enter();
    c.system();
    const expired: ApprovalRecord[] = [];
    for (const approval of [...c.s.approvals.values()].sort(newestFirst).reverse()) {
      if (approval.state !== 'expired' && effectiveApprovalState(approval, c.now) === 'expired') {
        const next: ApprovalRecord = { ...approval, state: 'expired' };
        c.s.approvals.set(approval.id, deepFreeze(next));
        expired.push(out(next));
      }
    }
    return expired;
  }

  async countPending(itemId: string): Promise<number> {
    const c = this.c;
    c.enter();
    const id = uuid(itemId, 'itemId');
    let count = 0;
    for (const approval of c.s.approvals.values()) {
      if (approval.itemId === id && c.canSeeApproval(approval) && effectiveApprovalState(approval, c.now) === 'pending') count += 1;
    }
    return count;
  }
}

const operationKey = (memberId: string, operationId: string): string => `${memberId}|${operationId}`;

class Operations implements OperationsRepo {
  constructor(private readonly c: Ctx) {}

  async reserve(operation: { operationId: string; kind: OperationKind; itemId: string; intentHash: string; actor: ActorRecord; approvalId: string | null }): Promise<{ created: boolean; operation: OperationRecord }> {
    const c = this.c;
    c.enter();
    const { memberId, spaceId } = c.member();
    const operationId = uuid(operation.operationId, 'operationId');
    const existing = c.s.operations.get(operationKey(memberId, operationId));
    if (existing) return { created: false, operation: out(existing) };
    const record: OperationRecord = {
      operationId,
      memberId,
      spaceId,
      kind: oneOf(operation.kind, OPERATION_KINDS, 'operation kind'),
      itemId: uuid(operation.itemId, 'itemId'),
      intentHash: hex64(operation.intentHash, 'intentHash'),
      state: 'in_progress',
      result: null,
      approvalId: nullableUuid(operation.approvalId, 'approvalId'),
      actor: scopeActor(operation.actor, memberId),
      createdAt: c.now,
      completedAt: null,
    };
    c.s.operations.set(operationKey(memberId, operationId), deepFreeze(record));
    return { created: true, operation: out(record) };
  }

  async complete(operationId: string, outcome: { state: Exclude<OperationState, 'in_progress'>; result: unknown; approvalId?: string | null }): Promise<OperationRecord> {
    const c = this.c;
    c.enter();
    const { memberId } = c.member();
    const key = operationKey(memberId, uuid(operationId, 'operationId'));
    const operation = c.s.operations.get(key);
    if (!operation) throw new StoreNotFoundError();
    if (operation.state !== 'in_progress') throw new StoreStateError(operation.state);
    const next: OperationRecord = {
      ...operation,
      state: oneOf(outcome.state, FINAL_OPERATION_STATES, 'operation state'),
      result: jsonValue(outcome.result),
      approvalId: outcome.approvalId === undefined ? operation.approvalId : nullableUuid(outcome.approvalId, 'approvalId'),
      completedAt: c.now,
    };
    c.s.operations.set(key, deepFreeze(next));
    return out(next);
  }

  async get(operationId: string): Promise<OperationRecord | null> {
    const c = this.c;
    c.enter();
    const { memberId } = c.member();
    const operation = c.s.operations.get(operationKey(memberId, uuid(operationId, 'operationId')));
    return operation ? out(operation) : null;
  }

  async markInProgressUnknown(): Promise<OperationRecord[]> {
    const c = this.c;
    c.enter();
    c.system();
    const marked: OperationRecord[] = [];
    for (const [key, operation] of c.s.operations) {
      if (operation.state !== 'in_progress') continue;
      const next: OperationRecord = { ...operation, state: 'unknown', result: null };
      c.s.operations.set(key, deepFreeze(next));
      marked.push(out(next));
    }
    return marked.sort(oldestOperationFirst);
  }

  async listUnknown(kind: OperationKind): Promise<OperationRecord[]> {
    const c = this.c;
    c.enter();
    c.system();
    const wanted = oneOf(kind, OPERATION_KINDS, 'operation kind');
    return [...c.s.operations.values()]
      .filter((operation) => operation.state === 'unknown' && operation.kind === wanted)
      .sort(oldestOperationFirst)
      .map(out);
  }

  async resolveUnknown(memberId: string, operationId: string, outcome: { state: 'done' | 'refused'; result: unknown }): Promise<OperationRecord> {
    const c = this.c;
    c.enter();
    c.system();
    const key = operationKey(uuid(memberId, 'memberId'), uuid(operationId, 'operationId'));
    const operation = c.s.operations.get(key);
    if (!operation) throw new StoreNotFoundError();
    if (operation.state !== 'unknown') throw new StoreStateError(operation.state);
    const next: OperationRecord = {
      ...operation,
      state: oneOf(outcome.state, ['done', 'refused'] as const, 'operation state'),
      result: jsonValue(outcome.result),
      completedAt: c.now,
    };
    c.s.operations.set(key, deepFreeze(next));
    return out(next);
  }
}

class Spend implements SpendRepo {
  constructor(private readonly c: Ctx) {}

  async create(request: Omit<SpendRequestRecord, 'createdAt' | 'executedAt' | 'processorRef'>): Promise<SpendRequestRecord> {
    const c = this.c;
    c.enter();
    c.member();
    const approval = c.s.approvals.get(uuid(request.approvalId, 'approvalId'));
    if (!approval || !c.canSeeApproval(approval)) throw new StoreNotFoundError();
    if (approval.kind !== 'spend') throw new StoreStateError('not_spend');
    if (uuid(request.itemId, 'itemId') !== approval.itemId) throw new StoreStateError('item_mismatch');
    if (c.s.spend.has(approval.id)) throw new StoreDuplicateError();
    const evidence = request.evidence;
    const record: SpendRequestRecord = {
      approvalId: approval.id,
      itemId: approval.itemId,
      merchant: text(request.merchant, 'merchant', 500),
      amountMinor: int(request.amountMinor, 'amountMinor', 1),
      currency: text(request.currency, 'currency', 3),
      itemSummary: text(request.itemSummary, 'itemSummary', 500),
      instrumentTier: oneOf(request.instrumentTier, ['tier1'] as const, 'instrumentTier'),
      evidence: evidence === null ? null : {
        sha256: hex64(evidence.sha256, 'evidence sha256'),
        width: int(evidence.width, 'evidence width', 0),
        height: int(evidence.height, 'evidence height', 0),
        maskedRegions: int(evidence.maskedRegions, 'maskedRegions', 0),
      },
      createdAt: c.now,
      executedAt: null,
      processorRef: null,
    };
    c.s.spend.set(approval.id, deepFreeze(record));
    return out(record);
  }

  async getByApproval(approvalId: string): Promise<SpendRequestRecord | null> {
    const c = this.c;
    c.enter();
    const approval = c.s.approvals.get(uuid(approvalId, 'approvalId'));
    if (!approval || !c.canSeeApproval(approval)) return null;
    const request = c.s.spend.get(approval.id);
    return request ? out(request) : null;
  }

  async markExecuted(approvalId: string, processorRef: string): Promise<SpendRequestRecord> {
    const c = this.c;
    c.enter();
    const approval = c.s.approvals.get(uuid(approvalId, 'approvalId'));
    const requester = c.scope.kind === 'system'
      || (approval !== undefined && c.canSeeApproval(approval) && approval.requesterMemberId === c.scope.memberId);
    const request = approval && requester ? c.s.spend.get(approval.id) : undefined;
    if (!request) throw new StoreNotFoundError();
    if (request.executedAt !== null) throw new StoreStateError('executed');
    const ref = text(processorRef, 'processorRef', 200);
    if (!PRINTABLE_RE.test(ref)) bad('processorRef');
    const next: SpendRequestRecord = { ...request, executedAt: c.now, processorRef: ref };
    c.s.spend.set(request.approvalId, deepFreeze(next));
    return out(next);
  }
}

class Passkeys implements PasskeysRepo {
  constructor(private readonly c: Ctx) {}

  #own(passkeyId: string): PasskeyRecord | undefined {
    const c = this.c;
    const passkey = c.s.passkeys.get(uuid(passkeyId, 'passkeyId'));
    if (!passkey) return undefined;
    return c.scope.kind === 'system' || passkey.memberId === c.scope.memberId ? passkey : undefined;
  }

  async create(passkey: Omit<PasskeyRecord, 'memberId' | 'createdAt' | 'lastUsedAt' | 'revokedAt'>): Promise<PasskeyRecord> {
    const c = this.c;
    c.enter();
    const { memberId } = c.member();
    const id = uuid(passkey.id, 'passkeyId');
    const credentialId = text(passkey.credentialId, 'credentialId', 1366);
    if (!B64URL_RE.test(credentialId)) bad('credentialId');
    if (c.s.passkeys.has(id)) throw new StoreDuplicateError();
    for (const existing of c.s.passkeys.values()) if (existing.credentialId === credentialId) throw new StoreDuplicateError();
    const publicKey = text(passkey.publicKey, 'publicKey', 4096);
    if (!B64URL_RE.test(publicKey)) bad('publicKey');
    const record: PasskeyRecord = {
      id,
      memberId,
      credentialId,
      publicKey,
      counter: int(passkey.counter, 'counter', 0),
      transports: strings(passkey.transports, 'transports'),
      backedUp: bool(passkey.backedUp, 'backedUp'),
      deviceType: oneOf(passkey.deviceType, ['singleDevice', 'multiDevice'] as const, 'deviceType'),
      aaguid: nullableText(passkey.aaguid, 'aaguid', 64),
      name: text(passkey.name, 'name', 200),
      createdAt: c.now,
      lastUsedAt: null,
      revokedAt: null,
    };
    c.s.passkeys.set(id, deepFreeze(record));
    return out(record);
  }

  async get(passkeyId: string): Promise<PasskeyRecord | null> {
    this.c.enter();
    const passkey = this.#own(passkeyId);
    return passkey ? out(passkey) : null;
  }

  async getByCredentialId(credentialId: string): Promise<PasskeyRecord | null> {
    const c = this.c;
    c.enter();
    const { memberId } = c.member();
    for (const passkey of c.s.passkeys.values()) {
      if (passkey.memberId === memberId && passkey.credentialId === credentialId) return out(passkey);
    }
    return null;
  }

  async listForMember(): Promise<PasskeyRecord[]> {
    const c = this.c;
    c.enter();
    const { memberId } = c.member();
    return [...c.s.passkeys.values()].filter((passkey) => passkey.memberId === memberId).sort(newestFirst).map(out);
  }

  async countActive(): Promise<number> {
    const c = this.c;
    c.enter();
    const { memberId } = c.member();
    let count = 0;
    for (const passkey of c.s.passkeys.values()) if (passkey.memberId === memberId && passkey.revokedAt === null) count += 1;
    return count;
  }

  async recordUse(passkeyId: string, newCounter: number): Promise<PasskeyRecord> {
    const c = this.c;
    c.enter();
    c.member();
    const passkey = this.#own(passkeyId);
    if (!passkey) throw new StoreNotFoundError();
    if (passkey.revokedAt !== null) throw new StoreStateError('revoked');
    const counter = int(newCounter, 'counter', 0);
    if (!(counter > passkey.counter || (counter === 0 && passkey.counter === 0))) throw new StoreStateError('counter_regression');
    const next: PasskeyRecord = { ...passkey, counter, lastUsedAt: c.now };
    c.s.passkeys.set(passkey.id, deepFreeze(next));
    return out(next);
  }

  async revoke(passkeyId: string): Promise<PasskeyRecord> {
    const c = this.c;
    c.enter();
    c.member();
    const passkey = this.#own(passkeyId);
    if (!passkey) throw new StoreNotFoundError();
    if (passkey.revokedAt !== null) return out(passkey);
    const next: PasskeyRecord = { ...passkey, revokedAt: c.now };
    c.s.passkeys.set(passkey.id, deepFreeze(next));
    return out(next);
  }
}

class Sessions implements VaultSessionsRepo {
  constructor(private readonly c: Ctx) {}

  #own(sessionId: string): VaultSessionRecord | undefined {
    const c = this.c;
    const session = c.s.sessions.get(uuid(sessionId, 'sessionId'));
    if (!session) return undefined;
    return c.scope.kind === 'system' || session.memberId === c.scope.memberId ? session : undefined;
  }

  #put(next: VaultSessionRecord): VaultSessionRecord {
    this.c.s.sessions.set(next.id, deepFreeze(next));
    return out(next);
  }

  #end(session: VaultSessionRecord, reason: SessionEndReason): VaultSessionRecord {
    return this.#put({ ...session, revokedAt: this.c.now, revokedReason: reason });
  }

  #freshHashes(tokenHash: string, refreshHash: string): void {
    if (tokenHash === refreshHash || this.c.hashInUse(tokenHash) || this.c.hashInUse(refreshHash)) throw new StoreDuplicateError();
  }

  async create(session: Omit<VaultSessionRecord, 'memberId' | 'refreshVersion' | 'createdAt' | 'lastUsedAt' | 'revokedAt' | 'revokedReason'>): Promise<VaultSessionRecord> {
    const c = this.c;
    c.enter();
    const { memberId } = c.member();
    const id = uuid(session.id, 'sessionId');
    const passkey = c.s.passkeys.get(uuid(session.passkeyId, 'passkeyId'));
    if (!passkey || passkey.memberId !== memberId) throw new StoreNotFoundError();
    if (passkey.revokedAt !== null) throw new StoreStateError('passkey_revoked');
    if (c.s.sessions.has(id)) throw new StoreDuplicateError();
    const tokenHash = hex64(session.tokenHash, 'tokenHash');
    const refreshHash = hex64(session.refreshHash, 'refreshHash');
    this.#freshHashes(tokenHash, refreshHash);
    const familyExpiresAt = iso(session.familyExpiresAt, 'familyExpiresAt');
    return this.#put({
      id,
      memberId,
      passkeyId: passkey.id,
      deviceLabel: nullableText(session.deviceLabel, 'deviceLabel', 200),
      tokenHash,
      refreshHash,
      refreshVersion: 1,
      createdAt: c.now,
      lastUsedAt: c.now,
      expiresAt: earliest(iso(session.expiresAt, 'expiresAt'), familyExpiresAt),
      refreshExpiresAt: earliest(iso(session.refreshExpiresAt, 'refreshExpiresAt'), familyExpiresAt),
      familyExpiresAt,
      revokedAt: null,
      revokedReason: null,
    });
  }

  async get(sessionId: string): Promise<VaultSessionRecord | null> {
    this.c.enter();
    const session = this.#own(sessionId);
    return session ? out(session) : null;
  }

  async getByTokenHash(tokenHash: string): Promise<VaultSessionRecord | null> {
    const c = this.c;
    c.enter();
    const { memberId } = c.member();
    const hash = hex64(tokenHash, 'tokenHash');
    for (const session of c.s.sessions.values()) {
      if (session.memberId === memberId && session.tokenHash === hash) return out(session);
    }
    return null;
  }

  async listForMember(): Promise<VaultSessionRecord[]> {
    const c = this.c;
    c.enter();
    const { memberId } = c.member();
    return [...c.s.sessions.values()].filter((session) => session.memberId === memberId).sort(newestFirst).map(out);
  }

  async touch(sessionId: string): Promise<void> {
    const c = this.c;
    c.enter();
    c.member();
    const session = this.#own(sessionId);
    if (!session) throw new StoreNotFoundError();
    this.#put({ ...session, lastUsedAt: c.now });
  }

  async rotateRefresh(input: { refreshHash: string; newTokenHash: string; newRefreshHash: string; expiresAt: IsoTime; refreshExpiresAt: IsoTime }): Promise<RefreshRotation> {
    const c = this.c;
    c.enter();
    const { memberId } = c.member();
    const presented = hex64(input.refreshHash, 'refreshHash');
    let current: VaultSessionRecord | undefined;
    for (const session of c.s.sessions.values()) {
      if (session.memberId === memberId && session.refreshHash === presented) current = session;
    }
    if (current) {
      if (c.sessionEnded(current)) return { result: 'ended', session: out(current) };
      const tokenHash = hex64(input.newTokenHash, 'newTokenHash');
      const refreshHash = hex64(input.newRefreshHash, 'newRefreshHash');
      const expiresAt = earliest(iso(input.expiresAt, 'expiresAt'), current.familyExpiresAt);
      const refreshExpiresAt = earliest(iso(input.refreshExpiresAt, 'refreshExpiresAt'), current.familyExpiresAt);
      this.#freshHashes(tokenHash, refreshHash);
      c.s.supersededRefresh.set(presented, current.id);
      return {
        result: 'rotated',
        session: this.#put({
          ...current,
          tokenHash,
          refreshHash,
          refreshVersion: current.refreshVersion + 1,
          lastUsedAt: c.now,
          expiresAt,
          refreshExpiresAt,
        }),
      };
    }
    const familyId = c.s.supersededRefresh.get(presented);
    const family = familyId === undefined ? undefined : c.s.sessions.get(familyId);
    if (!family || family.memberId !== memberId) return { result: 'unknown' };
    if (c.sessionEnded(family)) return { result: 'ended', session: out(family) };
    return { result: 'reused', session: this.#end(family, 'refresh_reuse') };
  }

  async revoke(sessionId: string, reason: SessionEndReason): Promise<VaultSessionRecord> {
    const c = this.c;
    c.enter();
    const why = oneOf(reason, SESSION_END_REASONS, 'reason');
    const session = this.#own(sessionId);
    if (!session) throw new StoreNotFoundError();
    return session.revokedAt === null ? this.#end(session, why) : out(session);
  }

  async revokeAllForMember(reason: SessionEndReason): Promise<VaultSessionRecord[]> {
    const c = this.c;
    c.enter();
    const { memberId } = c.member();
    const why = oneOf(reason, SESSION_END_REASONS, 'reason');
    return [...c.s.sessions.values()]
      .filter((session) => session.memberId === memberId && session.revokedAt === null)
      .sort(newestFirst)
      .map((session) => this.#end(session, why));
  }

  async revokeForPasskey(passkeyId: string): Promise<VaultSessionRecord[]> {
    const c = this.c;
    c.enter();
    const { memberId } = c.member();
    const id = uuid(passkeyId, 'passkeyId');
    return [...c.s.sessions.values()]
      .filter((session) => session.memberId === memberId && session.passkeyId === id && session.revokedAt === null)
      .sort(newestFirst)
      .map((session) => this.#end(session, 'passkey_revoked'));
  }
}

class Challenges implements ChallengesRepo {
  constructor(private readonly c: Ctx) {}

  async create(challenge: Omit<ChallengeRecord, 'memberId' | 'createdAt' | 'consumedAt'>): Promise<ChallengeRecord> {
    const c = this.c;
    c.enter();
    const { memberId } = c.member();
    const id = uuid(challenge.id, 'challengeId');
    if (c.s.challenges.has(id)) throw new StoreDuplicateError();
    const purpose = oneOf(challenge.purpose, CHALLENGE_PURPOSES, 'purpose');
    const action = challenge.action === null ? null : oneOf(challenge.action, VAULT_STEP_UP_ACTIONS, 'step-up action');
    const intentHash = challenge.intentHash === null ? null : hex64(challenge.intentHash, 'intentHash');
    const nonce = text(challenge.challenge, 'challenge', 1366);
    if (!B64URL_RE.test(nonce)) bad('challenge');
    const reg = challenge.registration;
    const registration = reg === null ? null : {
      name: text(reg.name, 'registration name', 200),
      via: oneOf(reg.via, ['enrollment_code', 'recovery_code', 'step_up'] as const, 'registration via'),
      codeId: nullableUuid(reg.codeId, 'registration codeId'),
      userHandle: text(reg.userHandle, 'userHandle', 512),
    };
    const shapeOk = purpose === 'step_up'
      ? action !== null && intentHash !== null && registration === null
      : purpose === 'registration'
        ? action === null && intentHash === null && registration !== null
        : action === null && intentHash === null && registration === null;
    if (!shapeOk) bad(`${purpose} challenge shape`);
    const record: ChallengeRecord = {
      id,
      memberId,
      purpose,
      action,
      intentHash,
      challenge: nonce,
      registration,
      createdAt: c.now,
      expiresAt: iso(challenge.expiresAt, 'expiresAt'),
      consumedAt: null,
    };
    c.s.challenges.set(id, deepFreeze(record));
    return out(record);
  }

  async consume(challengeId: string, purpose: ChallengePurpose): Promise<ChallengeRecord | null> {
    const c = this.c;
    c.enter();
    const { memberId } = c.member();
    const challenge = c.s.challenges.get(uuid(challengeId, 'challengeId'));
    if (!challenge || challenge.memberId !== memberId || challenge.purpose !== purpose
      || challenge.consumedAt !== null || c.lapsed(challenge.expiresAt)) {
      return null;
    }
    const next: ChallengeRecord = { ...challenge, consumedAt: c.now };
    c.s.challenges.set(challenge.id, deepFreeze(next));
    return out(next);
  }

  async deleteExpired(): Promise<number> {
    const c = this.c;
    c.enter();
    c.system();
    let count = 0;
    for (const [id, challenge] of c.s.challenges) {
      if (c.lapsed(challenge.expiresAt)) {
        c.s.challenges.delete(id);
        count += 1;
      }
    }
    return count;
  }
}

class RecoveryCodes implements RecoveryCodesRepo {
  constructor(private readonly c: Ctx) {}

  async replaceAll(codes: { id: string; hash: string }[]): Promise<void> {
    const c = this.c;
    c.enter();
    const { memberId } = c.member();
    if (!Array.isArray(codes)) bad('codes');
    const fresh = codes.map((code) => ({ id: uuid(code.id, 'codeId'), hash: argon2idHash(code.hash) }));
    const replaced = (code: CodeRecord): boolean => code.memberId === memberId && code.usedAt === null;
    const ids = new Set<string>();
    for (const code of fresh) {
      const existing = c.s.recoveryCodes.get(code.id);
      // Checked before anything is deleted: a failed call changes nothing.
      if (ids.has(code.id) || (existing && !replaced(existing))) throw new StoreDuplicateError();
      ids.add(code.id);
    }
    for (const [id, code] of c.s.recoveryCodes) if (replaced(code)) c.s.recoveryCodes.delete(id);
    for (const code of fresh) {
      c.s.recoveryCodes.set(code.id, deepFreeze({ id: code.id, memberId, hash: code.hash, createdAt: c.now, usedAt: null }));
    }
  }

  async listUnused(): Promise<CodeRecord[]> {
    const c = this.c;
    c.enter();
    const { memberId } = c.member();
    return [...c.s.recoveryCodes.values()].filter((code) => code.memberId === memberId && code.usedAt === null).sort(oldestCodeFirst).map(out);
  }

  async markUsed(codeId: string): Promise<boolean> {
    const c = this.c;
    c.enter();
    const { memberId } = c.member();
    const code = c.s.recoveryCodes.get(uuid(codeId, 'codeId'));
    if (!code || code.memberId !== memberId || code.usedAt !== null) return false;
    c.s.recoveryCodes.set(code.id, deepFreeze({ ...code, usedAt: c.now }));
    return true;
  }

  async countUnused(): Promise<number> {
    const c = this.c;
    c.enter();
    const { memberId } = c.member();
    let count = 0;
    for (const code of c.s.recoveryCodes.values()) if (code.memberId === memberId && code.usedAt === null) count += 1;
    return count;
  }
}

class EnrollmentCodes implements EnrollmentCodesRepo {
  constructor(private readonly c: Ctx) {}

  #usable(code: EnrollmentCodeRecord | undefined): code is EnrollmentCodeRecord {
    const c = this.c;
    const { memberId, spaceId } = c.member();
    return code !== undefined && code.memberId === memberId && code.spaceId === spaceId && code.usedAt === null && !c.lapsed(code.expiresAt);
  }

  async create(code: Omit<EnrollmentCodeRecord, 'createdAt' | 'usedAt'>): Promise<EnrollmentCodeRecord> {
    const c = this.c;
    c.enter();
    c.system('enrollment');
    const id = uuid(code.id, 'codeId');
    if (c.s.enrollmentCodes.has(id)) throw new StoreDuplicateError();
    const mintedBy = text(code.mintedBy, 'mintedBy', 100);
    if (!PRINTABLE_RE.test(mintedBy)) bad('mintedBy');
    const record: EnrollmentCodeRecord = {
      id,
      memberId: uuid(code.memberId, 'memberId'),
      spaceId: uuid(code.spaceId, 'spaceId'),
      hash: argon2idHash(code.hash),
      expiresAt: iso(code.expiresAt, 'expiresAt'),
      mintedBy,
      createdAt: c.now,
      usedAt: null,
    };
    c.s.enrollmentCodes.set(id, deepFreeze(record));
    return out(record);
  }

  async listUsable(): Promise<EnrollmentCodeRecord[]> {
    const c = this.c;
    c.enter();
    return [...c.s.enrollmentCodes.values()].filter((code) => this.#usable(code)).sort(oldestCodeFirst).map(out);
  }

  async markUsed(codeId: string): Promise<boolean> {
    const c = this.c;
    c.enter();
    const code = c.s.enrollmentCodes.get(uuid(codeId, 'codeId'));
    if (!this.#usable(code)) return false;
    c.s.enrollmentCodes.set(code.id, deepFreeze({ ...code, usedAt: c.now }));
    return true;
  }
}

class CaptureLinks implements CaptureLinksRepo {
  constructor(private readonly c: Ctx) {}

  #usable(captureId: string, tokenHash: string): CaptureLinkRecord | null {
    const c = this.c;
    const { memberId, spaceId } = c.member();
    const hash = hex64(tokenHash, 'tokenHash');
    const link = c.s.captureLinks.get(uuid(captureId, 'captureId'));
    if (!link || link.memberId !== memberId || link.spaceId !== spaceId || link.consumedAt !== null || c.lapsed(link.expiresAt)) return null;
    return digestEquals(link.tokenHash, hash) ? link : null;
  }

  async create(link: Omit<CaptureLinkRecord, 'memberId' | 'spaceId' | 'createdAt' | 'openedAt' | 'consumedAt'>): Promise<CaptureLinkRecord> {
    const c = this.c;
    c.enter();
    const { memberId, spaceId } = c.member();
    const id = uuid(link.id, 'captureId');
    const purpose = oneOf(link.purpose, ['create', 'replace'] as const, 'link purpose');
    const itemType = oneOf(link.itemType, ITEM_TYPES, 'item type');
    let itemId: string | null = null;
    if (purpose === 'replace') {
      if (link.itemId === null) bad('itemId (a replace link names its item)');
      const item = c.ownedLiveItem(link.itemId);
      if (item.type !== itemType) throw new StoreStateError('wrong_item_type');
      itemId = item.id;
    } else if (link.itemId !== null) {
      bad('itemId (a create link names no item)');
    }
    if (c.s.captureLinks.has(id)) throw new StoreDuplicateError();
    const record: CaptureLinkRecord = {
      id,
      memberId,
      spaceId,
      itemType,
      purpose,
      itemId,
      name: nullableText(link.name, 'name', 500),
      tokenHash: hex64(link.tokenHash, 'tokenHash'),
      captureKid: text(link.captureKid, 'captureKid', 200),
      createdAt: c.now,
      expiresAt: iso(link.expiresAt, 'expiresAt'),
      openedAt: null,
      consumedAt: null,
      createdBy: scopeActor(link.createdBy, memberId),
    };
    c.s.captureLinks.set(id, deepFreeze(record));
    return out(record);
  }

  async getUsable(captureId: string, tokenHash: string): Promise<CaptureLinkRecord | null> {
    this.c.enter();
    const link = this.#usable(captureId, tokenHash);
    return link ? out(link) : null;
  }

  async markOpened(captureId: string): Promise<void> {
    const c = this.c;
    c.enter();
    const { memberId, spaceId } = c.member();
    const link = c.s.captureLinks.get(uuid(captureId, 'captureId'));
    if (!link || link.memberId !== memberId || link.spaceId !== spaceId) throw new StoreNotFoundError();
    if (link.openedAt === null) c.s.captureLinks.set(link.id, deepFreeze({ ...link, openedAt: c.now }));
  }

  async consume(captureId: string, tokenHash: string): Promise<CaptureLinkRecord | null> {
    const c = this.c;
    c.enter();
    const link = this.#usable(captureId, tokenHash);
    if (!link) return null;
    const next: CaptureLinkRecord = { ...link, consumedAt: c.now };
    c.s.captureLinks.set(link.id, deepFreeze(next));
    return out(next);
  }
}

class Audit implements AuditRepo {
  constructor(private readonly c: Ctx) {}

  #head(): AuditEventRecord | undefined {
    return this.c.s.audit[this.c.s.audit.length - 1];
  }

  async append(event: AuditBody): Promise<AuditEventRecord> {
    const c = this.c;
    c.enter();
    try {
      if (c.faults.auditAppend) throw new Error('vault store: audit append fault (test)');
      if (typeof event.action !== 'string' || !AUDIT_ACTIONS.has(event.action)) bad('audit action');
      const body: AuditBody = {
        action: event.action,
        actor: actorRecord(event.actor),
        itemId: nullableUuid(event.itemId, 'itemId'),
        subjectMemberId: nullableUuid(event.subjectMemberId, 'subjectMemberId'),
        spaceId: nullableUuid(event.spaceId, 'spaceId'),
        params: auditParams(event.params, 'params'),
      };
      const head = this.#head();
      let at = isoNow(c.clock);
      // `at` never goes backwards along the chain, whatever the clock does.
      if (head && Date.parse(at) < Date.parse(head.at)) at = head.at;
      const record = sealAuditEvent(body, (head?.seq ?? 0) + 1, head?.entryHash ?? AUDIT_GENESIS_HASH, at);
      c.s.audit.push(deepFreeze(record));
      return out(record);
    } catch (error) {
      // Every failure, a malformed event included, kills the transaction, as a
      // failed definer call aborts it in Postgres. A handler that catches the
      // error still cannot commit its action without the event.
      c.dead = 'audit';
      throw new AuditUnavailableError({ cause: error });
    }
  }

  async list(query: PageQuery & { itemId?: string; action?: string }): Promise<Page<AuditEventRecord>> {
    const c = this.c;
    c.enter();
    const memberId = c.scope.kind === 'member' ? c.scope.memberId : null;
    const itemId = query.itemId === undefined ? undefined : uuid(query.itemId, 'itemId');
    const rows = c.s.audit.filter((event) => (memberId === null || event.subjectMemberId === memberId)
      && (itemId === undefined || event.itemId === itemId)
      && (query.action === undefined || event.action === query.action));
    return pageBySeq(rows, query);
  }

  async listForItem(itemId: string, since: IsoTime, limit: number): Promise<AuditEventRecord[]> {
    const c = this.c;
    c.enter();
    const item = c.visibleItem(itemId);
    const owner = c.owns(item);
    const memberId = c.scope.kind === 'member' ? c.scope.memberId : null;
    const sinceMs = Date.parse(iso(since, 'since'));
    const max = clampLimit(limit);
    const rows: AuditEventRecord[] = [];
    for (let index = c.s.audit.length - 1; index >= 0 && rows.length < max; index -= 1) {
      const event = c.s.audit[index];
      if (!event || event.itemId !== item.id || Date.parse(event.at) < sinceMs) continue;
      if (owner || event.actor.memberId === memberId) rows.push(out(event));
    }
    return rows;
  }

  async fillFailureStreak(itemId: string, origin: string): Promise<number> {
    const c = this.c;
    c.enter();
    const item = c.visibleItem(itemId);
    const wanted = text(origin, 'origin', 2048);
    let failures = 0;
    // Every caller's events, deliberately: only the count leaves this method.
    for (let index = c.s.audit.length - 1; index >= 0; index -= 1) {
      const event = c.s.audit[index];
      if (!event || event.itemId !== item.id || event.params.origin !== wanted || event.params.attempted !== true) continue;
      if (event.action === 'fill.done') break;
      if (event.action === 'fill.refused') failures += 1;
    }
    return failures;
  }

  async head(): Promise<{ seq: number; hash: string }> {
    this.c.enter();
    const head = this.#head();
    return head ? { seq: head.seq, hash: head.entryHash } : { seq: 0, hash: AUDIT_GENESIS_HASH };
  }

  async range(fromSeq: number, toSeq: number): Promise<AuditEventRecord[]> {
    const c = this.c;
    c.enter();
    c.system();
    const from = int(fromSeq, 'fromSeq', 1);
    const to = int(toSeq, 'toSeq', 0);
    return c.s.audit.filter((event) => event.seq >= from && event.seq <= to).sort((a, b) => a.seq - b.seq).map(out);
  }

  async recordCheckpoint(checkpoint: CheckpointRecord): Promise<void> {
    const c = this.c;
    c.enter();
    c.system();
    const seq = int(checkpoint.seq, 'checkpoint seq', 0);
    const headHash = hex64(checkpoint.headHash, 'checkpoint headHash');
    const expected = seq === 0 ? AUDIT_GENESIS_HASH : c.s.audit.find((event) => event.seq === seq)?.entryHash;
    if (expected !== headHash) throw new StoreStateError('checkpoint_mismatch');
    const signature = checkpoint.signature === null ? null : text(checkpoint.signature, 'signature', 4096);
    if (signature !== null && !B64URL_RE.test(signature)) bad('signature');
    c.s.checkpoints.push(deepFreeze({
      seq,
      headHash,
      at: iso(checkpoint.at, 'checkpoint at'),
      sink: oneOf(checkpoint.sink, ['off', 'file', 'gcs'] as const, 'sink'),
      anchored: bool(checkpoint.anchored, 'anchored'),
      location: nullableText(checkpoint.location, 'location', 1000),
      keyId: nullableText(checkpoint.keyId, 'keyId', 200),
      signature,
    }));
  }

  async latestCheckpoint(): Promise<CheckpointRecord | null> {
    const c = this.c;
    c.enter();
    let latest: CheckpointRecord | undefined;
    for (const checkpoint of c.s.checkpoints) if (!latest || checkpoint.seq >= latest.seq) latest = checkpoint;
    return latest ? out(latest) : null;
  }
}

class DeletionLedgerMirror implements DeletionLedgerRepo {
  constructor(private readonly c: Ctx) {}

  async list(): Promise<DeletionLedgerEntry[]> {
    const c = this.c;
    c.enter();
    c.system();
    return [...c.s.deletionLedger.values()]
      .sort((a, b) => compareTimeKey([a.tombstonedAt, a.itemId], [b.tombstonedAt, b.itemId]))
      .map(out);
  }
}
