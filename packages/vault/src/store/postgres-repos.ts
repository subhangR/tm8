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
  type ApprovalConsumedLedgerEntry,
  type DeletionLedgerEntry,
  type DeletionLedgerRepo,
  type GrantRevokedLedgerEntry,
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


import type { PoolClient } from 'pg';
import { auditBodyText } from '../audit/chain.js';
import { UUID_RE, HEX64_RE, ISO_MS_RE, B64URL_RE, ARGON2ID_RE, PRINTABLE_RE, ITEM_TYPES, EXPOSURE_TIERS, SESSION_END_REASONS, CHALLENGE_PURPOSES, OPERATION_KINDS, FINAL_OPERATION_STATES, SYSTEM_PURPOSES, AUDIT_ACTIONS, bad, uuid, nullableUuid, hex64, isIsoMs, iso, text, nullableText, bool, int, oneOf, strings, sortedUnique, actorRecord, scopeActor, auditParams, jsonValue, metadataPatch, secretVersion, earliest, deepFreeze, out, outSecret, clampLimit, encodeCursor, decodeCursor, timeCursor, seqCursor, compareTimeKey, newestFirst, pageByTime, pageBySeq, checkScope, argon2idHash, oldestCodeFirst, oldestOperationFirst } from './validation.js';

const TABLES = {
  items: ['items', ['id']], policies: ['broker_policies', ['itemId']], grants: ['grants', ['id']],
  approvals: ['approvals', ['id']], operations: ['operations', ['memberId', 'operationId']],
  spend: ['spend_requests', ['approvalId']], passkeys: ['passkeys', ['id']], sessions: ['vault_sessions', ['id']],
  challenges: ['challenges', ['id']], recoveryCodes: ['recovery_codes', ['id']],
  enrollmentCodes: ['enrollment_codes', ['id']], captureLinks: ['capture_links', ['id']],
  deletionLedger: ['deletion_ledger', ['itemId']], supersededRefresh: ['superseded_refresh', ['hash']],
} as const;
type TableKey = keyof typeof TABLES;
const snake = (name: string): string => name.replace(/[A-Z]/g, (part) => `_${part.toLowerCase()}`);
/**
 * Column names are the only record-derived text interpolated into SQL (identifiers cannot be bound).
 * They come from store-built records, but a stray key must fail closed rather than reach the query.
 */
const SQL_IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/;
export function sqlColumn(name: string): string {
  const column = snake(name);
  if (!SQL_IDENTIFIER.test(column)) throw new TypeError('vault store: invalid column');
  return column;
}
const camel =(name: string): string => name.replace(/_([a-z])/g, (_, part: string) => part.toUpperCase());
const JSON_FIELDS = new Set(['createdBy','revokedBy','constraints','boundParams','requestedBy','decidedBy','lookalike','spend','actor','result','injection','evidence','registration']);
const READ_METHODS = new Set(['get','list','listForItem','countActive','countOwned','activeForCaller','countPending','findPending','findUsable','currentSecret','getByCredentialId','getByTokenHash','getByApproval','listForMember','listUnknown','listUnused','countUnused','listUsable','getUsable','head','range','latestCheckpoint','fillFailureStreak']);
const AUTH_REPOS = new Set(['passkeys', 'sessions', 'challenges', 'recoveryCodes', 'enrollmentCodes']);
const ID_FIELDS = new Set(['id','itemId','memberId','ownerMemberId','spaceId','operationId','approvalId','consumedByOperationId','sessionId','passkeyId','codeId','requesterMemberId','granteeId']);
const POSITIONAL_IDS: Record<string, number[]> = {
  get: [0], update: [0], setProperties: [0], addOrigin: [0], replaceSecret: [0], currentSecret: [0], tombstone: [0],
  set: [0], listForItem: [0], fillFailureStreak: [0], revoke: [0], activeForCaller: [0], countActive: [0], findPending: [0], findUsable: [0],
  decide: [0], consume: [0], countPending: [0], complete: [0], resolveUnknown: [0, 1], getByApproval: [0],
  markExecuted: [0], recordUse: [0], touch: [0], revokeForPasskey: [0], markUsed: [0], getUsable: [0], markOpened: [0],
};

/** Validate all id/time arguments before even the savepoint reaches SQL. */
function preflight(repo: string, method: string, args: unknown[]): void {
  for (const at of POSITIONAL_IDS[method] ?? []) {
    if (typeof args[at] === 'string') uuid(args[at]);
  }
  if (repo === 'audit' && method === 'listForItem') iso(args[1], 'since');
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object' || Buffer.isBuffer(value)) return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    for (const [key, child] of Object.entries(value)) {
      if (ID_FIELDS.has(key) && child !== null && child !== undefined) uuid(child);
      else if (key.endsWith('At') && child !== null && child !== undefined) iso(child, 'time');
      else if (!['params','boundParams','result','injection'].includes(key)) visit(child);
    }
  };
  args.forEach(visit);
}

function decode<T>(row: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (key === 'ordinal') continue;
    const name = camel(key);
    out[name] = value instanceof Date ? value.toISOString() : (['seq','amountMinor','counter'].includes(name) && typeof value === 'string') ? Number(value) : value;
  }
  return out as T;
}

class SqlMap<T> {
  readonly #table: string;
  readonly #keys: readonly string[];
  readonly #cache = new Map<string, T | undefined>();
  constructor(private readonly c: PgCtx, private readonly key: TableKey) {
    [this.#table, this.#keys] = TABLES[key];
  }
  clear(): void { this.#cache.clear(); }
  #parts(key: string): string[] { return this.#keys.length === 2 ? key.split('|') : [key]; }
  #key(record: Record<string, unknown>): string { return this.#keys.map((key) => record[key]).join('|'); }
  #where(offset = 0): string { return this.#keys.map((key, index) => `${snake(key)} = $${index + offset + 1}`).join(' and '); }
  #view(row: Record<string, unknown>): T {
    return this.key === 'supersededRefresh' ? row.session_id as T : decode<T>(row);
  }
  #record(key: string, value: T): Record<string, unknown> {
    return this.key === 'supersededRefresh' ? { hash: key, sessionId: value } : value as Record<string, unknown>;
  }
  async get(key: string): Promise<T | undefined> {
    let rows = await this.c.query(`select * from vault.${this.#table} where ${this.#where()}`, this.#parts(key));
    // Invisible and missing rows take the identical path and never wait for
    // another tenant's logical row lock. A visible row is re-read AFTER the
    // lock so an intervening revoke/state change cannot leave a stale result.
    // Operations also lock absent keys: their (member,id) key is private to
    // that member, and concurrent reserve must return the first result.
    if (this.c.lockRows && (rows.length || this.key === 'operations')) {
      await this.c.advisory(`vault:${this.#table}:${key}`);
      rows = await this.c.query(`select * from vault.${this.#table} where ${this.#where()}`, this.#parts(key));
    }
    const value = rows[0] ? this.#view(rows[0]) : undefined;
    this.#cache.set(key, value);
    return value;
  }
  async has(key: string): Promise<boolean> { return (await this.get(key)) !== undefined; }
  async values(): Promise<T[]> { return (await this.entries()).map(([, value]) => value); }
  async entries(): Promise<[string, T][]> {
    const rows = await this.c.query(`select * from vault.${this.#table}`);
    return rows.map((row) => {
      const record = decode<Record<string, unknown>>(row);
      const key = this.#key(record);
      const value = this.#view(row);
      this.#cache.set(key, value);
      return [key, value];
    });
  }
  async set(key: string, value: T): Promise<void> {
    const record = this.#record(key, value);
    const entries = Object.entries(record);
    const names = entries.map(([name]) => sqlColumn(name));
    const values = entries.map(([name, value]) => JSON_FIELDS.has(name) && value !== null ? JSON.stringify(value) : value);
    const previous = this.#cache.get(key);
    let rows: Record<string, unknown>[];
    if (previous !== undefined) {
      const old = this.#record(key, previous);
      const expected = JSON.stringify(Object.fromEntries(Object.entries(old).map(([name, value]) => [snake(name), value instanceof Uint8Array ? '\\x' + Buffer.from(value).toString('hex') : value])));
      // Conditional writes protect against sweepers or other clients changing a
      // row after a list read. No failed CAS ever overwrites the winning write.
      rows = await this.c.query(`update vault.${this.#table} as t set ${names.map((name, index) => `${name} = $${index + 1}`).join(', ')} where ${this.#where(values.length)} and to_jsonb(t) = to_jsonb(jsonb_populate_record(null::vault.${this.#table}, $${values.length + this.#keys.length + 1}::jsonb)) returning *`, [...values, ...this.#parts(key), JSON.parse(expected)]);
      // PostgreSQL's timestamp JSON format differs from ISO. The predicate is
      // constructed with typed rows, so compare their canonical SQL JSON form.
      if (!rows.length) {
        const current = await this.get(key);
        if (!current) throw new StoreNotFoundError();
        if (this.key === 'items') throw new StoreVersionConflictError((current as unknown as ItemRecord).version);
        throw new StoreStateError((current as { state?: string }).state ?? 'concurrent_change');
      }
    } else {
      rows = await this.c.query(`insert into vault.${this.#table} (${names.join(', ')}) values (${names.map((_, index) => `$${index + 1}`).join(', ')}) on conflict (${this.#keys.map(snake).join(', ')}) do nothing returning *`, values);
      if (!rows.length) throw new StoreDuplicateError();
    }
    this.#cache.set(key, value);
  }
  async delete(key: string): Promise<boolean> {
    const rows = await this.c.query(`delete from vault.${this.#table} where ${this.#where()} returning 1`, this.#parts(key));
    this.#cache.set(key, undefined);
    return rows.length > 0;
  }
}

class SecretMap {
  constructor(private readonly c: PgCtx) {}
  async get(itemId: string): Promise<readonly SecretVersionRecord[] | undefined> {
    const rows = await this.c.query('select * from vault.secret_versions where item_id = $1 order by version', [itemId]);
    return rows.length ? rows.map((row) => decode<SecretVersionRecord>(row)) : undefined;
  }
  async set(itemId: string, versions: readonly SecretVersionRecord[]): Promise<void> {
    await this.delete(itemId);
    for (const record of versions) await this.c.query('insert into vault.secret_versions(item_id,version,suite,kek_id,wrapped_dek,nonce,ciphertext,created_at) values ($1,$2,$3,$4,$5,$6,$7,$8)', [record.itemId, record.version, record.suite, record.kekId, record.wrappedDek, record.nonce, record.ciphertext, record.createdAt]);
  }
  async delete(itemId: string): Promise<boolean> { return (await this.c.query('delete from vault.secret_versions where item_id = $1 returning 1', [itemId])).length > 0; }
}

export class PgCtx {
  readonly nowMs: number;
  readonly tx: VaultTx;
  closed = false;
  dead: 'audit' | 'store' | null = null;
  #tail: Promise<unknown> = Promise.resolve();
  #auditAppending = false;
  readonly #heldLocks = new Set<string>();
  #auditStarted = false;
  lockRows = false;
  readonly s = {
    items: new SqlMap<ItemRecord>(this, 'items'), policies: new SqlMap<PolicyRecord>(this, 'policies'),
    grants: new SqlMap<GrantRecord>(this, 'grants'), approvals: new SqlMap<ApprovalRecord>(this, 'approvals'),
    operations: new SqlMap<OperationRecord>(this, 'operations'), spend: new SqlMap<SpendRequestRecord>(this, 'spend'),
    passkeys: new SqlMap<PasskeyRecord>(this, 'passkeys'), sessions: new SqlMap<VaultSessionRecord>(this, 'sessions'),
    supersededRefresh: new SqlMap<string>(this, 'supersededRefresh'), challenges: new SqlMap<ChallengeRecord>(this, 'challenges'),
    recoveryCodes: new SqlMap<CodeRecord>(this, 'recoveryCodes'), enrollmentCodes: new SqlMap<EnrollmentCodeRecord>(this, 'enrollmentCodes'),
    captureLinks: new SqlMap<CaptureLinkRecord>(this, 'captureLinks'), deletionLedger: new SqlMap<DeletionLedgerEntry>(this, 'deletionLedger'),
    secrets: new SecretMap(this),
  };

  constructor(readonly client: PoolClient, readonly scope: StoreScope, readonly now: IsoTime, readonly clock: Clock, readonly faults: { unavailable: boolean; auditAppend: boolean }) {
    this.nowMs = Date.parse(now);
    const wrap = <T extends object>(repo: string, value: T): T => new Proxy(value, { get: (target, prop) => {
      const method = Reflect.get(target, prop, target) as unknown;
      if (typeof method !== 'function') return method;
      return (...args: unknown[]) => {
        const run = this.#tail.then(() => this.#call(repo, String(prop), args, () => Reflect.apply(method, target, args)));
        this.#tail = run.then(() => undefined, () => undefined);
        return run;
      };
    } });
    this.tx = Object.freeze({ now, scope,
      items: wrap('items', new Items(this)), policies: wrap('policies', new Policies(this)), grants: wrap('grants', new Grants(this)),
      approvals: wrap('approvals', new Approvals(this)), operations: wrap('operations', new Operations(this)), spend: wrap('spend', new Spend(this)),
      passkeys: wrap('passkeys', new Passkeys(this)), sessions: wrap('sessions', new Sessions(this)), challenges: wrap('challenges', new Challenges(this)),
      recoveryCodes: wrap('recoveryCodes', new RecoveryCodes(this)), enrollmentCodes: wrap('enrollmentCodes', new EnrollmentCodes(this)),
      captureLinks: wrap('captureLinks', new CaptureLinks(this)), audit: wrap('audit', new Audit(this)), deletionLedger: wrap('deletionLedger', new DeletionLedgerMirror(this)),
    });
  }

  async drain(): Promise<void> { await this.#tail; }
  kill(kind: 'audit' | 'store'): void { this.dead ??= kind; }
  deadError(): Error { return this.dead === 'audit' ? new AuditUnavailableError() : new StoreUnavailableError(); }
  enter(): void {
    if (this.closed) throw new Error('vault store: the transaction has ended');
    if (this.faults.unavailable) this.kill('store');
    if (this.dead) throw this.deadError();
  }
  async query(sql: string, values: unknown[] = []): Promise<Record<string, unknown>[]> {
    this.enter();
    try { return (await this.client.query(sql, values)).rows as Record<string, unknown>[]; }
    catch (error) {
      const code = (error as { code?: string }).code;
      if (code === '40P01' || code === '40001') { this.kill('store'); throw this.deadError(); }
      if (code === '23505') throw new StoreDuplicateError();
      if (code === '23503' || code === '42501') throw new StoreNotFoundError();
      if (code === '23514') throw new StoreStateError('constraint');
      const connectionError = !code || code.startsWith('08') || ['57P01','57P02','57P03','ECONNRESET','EPIPE','ENOTFOUND','ECONNREFUSED','ETIMEDOUT'].includes(code);
      this.kill(this.#auditAppending && !connectionError ? 'audit' : 'store');
      throw this.deadError();
    }
  }
  async #call<T>(repo: string, method: string, args: unknown[], fn: () => Promise<T>): Promise<T> {
    this.enter();
    const audit = repo === 'audit' && method === 'append';
    this.lockRows = !READ_METHODS.has(method);
    try { preflight(repo, method, args); }
    catch (error) { if (audit) { this.kill('audit'); throw this.deadError(); } throw error; }
    if (AUTH_REPOS.has(repo)) {
      const target = this.scope.kind === 'member' ? this.scope.memberId
        : repo === 'enrollmentCodes' && method === 'create' ? (args[0] as EnrollmentCodeRecord).memberId.toLowerCase() : null;
      if (target) await this.advisory(`tm8-vault/member-auth/${target}`);
    }
    if (repo === 'approvals') {
      const itemId = method === 'list' ? (args[0] as { itemId?: string }).itemId
        : method === 'create' ? (args[0] as NewApproval).itemId
          : ['findPending', 'findUsable', 'countPending'].includes(method) ? args[0] as string : null;
      if (itemId) await this.advisory(`tm8-vault/approvals/${uuid(itemId, 'itemId')}`);
    }
    for (const map of Object.values(this.s)) if (map instanceof SqlMap) map.clear();
    if (audit) {
      this.#auditStarted = true;
      this.#auditAppending = true;
      try { return await fn(); }
      catch { this.kill('audit'); throw this.deadError(); }
      finally { this.#auditAppending = false; }
    }
    const locksBefore = new Set(this.#heldLocks);
    await this.query('savepoint vault_repo');
    try {
      const result = await fn();
      await this.query('release savepoint vault_repo');
      return result;
    } catch (error) {
      if (this.dead) throw this.deadError();
      try { await this.client.query('rollback to savepoint vault_repo'); await this.client.query('release savepoint vault_repo'); }
      catch { this.kill('store'); throw this.deadError(); }
      for (const key of this.#heldLocks) if (!locksBefore.has(key)) this.#heldLocks.delete(key);
      throw error;
    }
  }
  /** Acquire before the first append; audit holds its head row until commit. */
  async advisory(key: string): Promise<void> {
    this.enter();
    if (this.#heldLocks.has(key)) return;
    if (this.#auditStarted) { this.kill('store'); throw this.deadError(); }
    await this.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
    this.#heldLocks.add(key);
  }
  member(): { memberId: string; spaceId: string } { if (this.scope.kind !== 'member') throw new StoreScopeError('member'); return this.scope; }
  system(purpose?: Extract<StoreScope, { kind: 'system' }>['purpose']): void {
    if (this.scope.kind !== 'system' || (purpose !== undefined && this.scope.purpose !== purpose)) throw new StoreScopeError('system');
  }
  get isSystem(): boolean { return this.scope.kind === 'system'; }
  lapsed(at: IsoTime): boolean { return Date.parse(at) <= this.nowMs; }
  grantLive(grant: GrantRecord): boolean { return grant.revokedAt === null && (grant.expiresAt === null || !this.lapsed(grant.expiresAt)); }
  grantNamesScope(grant: GrantRecord): boolean {
    if (this.scope.kind !== 'member') return false;
    return grant.spaceId === this.scope.spaceId && ((grant.granteeKind === 'member' && grant.granteeId === this.scope.memberId) || (grant.granteeKind === 'space' && grant.granteeId === this.scope.spaceId));
  }
  owns(item: ItemRecord): boolean { return this.isSystem || (this.scope.kind === 'member' && item.spaceId === this.scope.spaceId && item.ownerMemberId === this.scope.memberId); }
  // A row returned by SQL has already passed RLS. No second visibility universe.
  canSeeItem(_item: ItemRecord): boolean { return true; }
  canSeeGrant(_grant: GrantRecord): boolean { return true; }
  canSeeApproval(_approval: ApprovalRecord): boolean { return true; }
  async visibleItem(itemId: string): Promise<ItemRecord> { const item = await this.s.items.get(uuid(itemId, 'itemId')); if (!item) throw new StoreNotFoundError(); return item; }
  async ownedItem(itemId: string): Promise<ItemRecord> { const item = await this.visibleItem(itemId); if (!this.owns(item)) throw new StoreNotFoundError(); return item; }
  async ownedLiveItem(itemId: string): Promise<ItemRecord> { const item = await this.ownedItem(itemId); if (item.state === 'tombstoned') throw new StoreStateError('tombstoned'); return item; }
  async casItem(itemId: string, expectedVersion: number): Promise<ItemRecord> {
    const item = await this.ownedLiveItem(itemId);
    if (item.version !== expectedVersion) throw new StoreVersionConflictError(item.version);
    return item;
  }
  viewApproval(approval: ApprovalRecord): ApprovalRecord { return { ...out(approval), state: effectiveApprovalState(approval, this.now) }; }
  async putItem(next: ItemRecord): Promise<ItemRecord> { await this.s.items.set(next.id, next); return out(next); }
  async bumpItem(item: ItemRecord, patch: Partial<ItemRecord>): Promise<ItemRecord> { return this.putItem({ ...item, ...patch, version: item.version + 1, updatedAt: this.now }); }
  async tombstoneEffects(entry: DeletionLedgerEntry, actor: ActorRecord): Promise<boolean> {
    let changed = await this.s.secrets.delete(entry.itemId);
    for (const grant of await this.s.grants.values()) {
      if (grant.itemId === entry.itemId && grant.revokedAt === null) { await this.s.grants.set(grant.id, { ...grant, revokedAt: this.now, revokedBy: actor }); changed = true; }
    }
    for (const approval of await this.s.approvals.values()) {
      if (approval.itemId === entry.itemId && (approval.state === 'pending' || (approval.state === 'approved' && approval.oneUse && approval.consumedAt === null))) {
        await this.s.approvals.set(approval.id, { ...approval, state: 'expired' }); changed = true;
      }
    }
    if (!(await this.s.deletionLedger.has(entry.itemId))) { await this.s.deletionLedger.set(entry.itemId, { ...entry }); changed = true; }
    return changed;
  }
  async hashInUse(hash: string): Promise<boolean> { return (await this.query('select vault.hash_in_use($1) as used', [hash]))[0]?.used === true; }
  sessionEnded(session: VaultSessionRecord): boolean { return session.revokedAt !== null || this.lapsed(session.refreshExpiresAt) || this.lapsed(session.familyExpiresAt); }
}
class Items implements ItemsRepo {
  constructor(private readonly c: PgCtx) {}

  async create(item: NewItem, secret: EncryptedSecretVersion): Promise<ItemRecord> {
    const c = this.c;
    c.enter();
    const { memberId, spaceId } = c.member();
    const id = uuid(item.id, 'itemId');
    if ((await c.s.items.has(id))) throw new StoreDuplicateError();
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
    const stored = secretVersion(secret, id, 1, c.now);
    await c.putItem(record);
    await c.s.secrets.set(id, [stored]);
    return out(record);
  }

  async get(itemId: string): Promise<ItemRecord | null> {
    const c = this.c;
    c.enter();
    const item = (await c.s.items.get(uuid(itemId, 'itemId')));
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
    for (const item of (await c.s.items.values())) {
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
    const item = (await c.casItem(itemId, expectedVersion));
    const change: Partial<ItemRecord> = {};
    if (patch.name !== undefined) change.name = text(patch.name, 'name', 500);
    if (patch.username !== undefined) change.username = nullableText(patch.username, 'username', 500);
    return (await c.bumpItem(item, change));
  }

  async setProperties(itemId: string, expectedVersion: number, change: { addOrigins?: string[]; removeOrigins?: string[]; devMode?: boolean }): Promise<ItemRecord> {
    const c = this.c;
    c.enter();
    const item = (await c.casItem(itemId, expectedVersion));
    const add = change.addOrigins === undefined ? [] : strings(change.addOrigins, 'addOrigins');
    const remove = change.removeOrigins === undefined ? [] : strings(change.removeOrigins, 'removeOrigins');
    if ((add.length > 0 || remove.length > 0) && item.type !== 'login') throw new StoreStateError('wrong_item_type');
    const removed = new Set(remove);
    const patch: Partial<ItemRecord> = { origins: sortedUnique([...item.origins, ...add]).filter((origin) => !removed.has(origin)) };
    if (change.devMode !== undefined) patch.devMode = bool(change.devMode, 'devMode');
    return (await c.bumpItem(item, patch));
  }

  async addOrigin(itemId: string, origin: string): Promise<ItemRecord> {
    const c = this.c;
    c.enter();
    const item = (await c.ownedLiveItem(itemId));
    if (item.type !== 'login') throw new StoreStateError('wrong_item_type');
    const value = text(origin, 'origin', 2000);
    if (item.origins.includes(value)) return out(item);
    return (await c.bumpItem(item, { origins: sortedUnique([...item.origins, value]) }));
  }

  async replaceSecret(itemId: string, expectedVersion: number, secret: EncryptedSecretVersion, metadata: Partial<ItemMetadataFields>): Promise<ItemRecord> {
    const c = this.c;
    c.enter();
    const item = (await c.casItem(itemId, expectedVersion));
    const next = item.secretVersion + 1;
    const patch = metadataPatch(metadata);
    const stored = secretVersion(secret, item.id, next, c.now);
    (await c.s.secrets.set(item.id, Object.freeze([stored])));
    return (await c.bumpItem(item, { ...patch, secretVersion: next, rotatedAt: c.now, state: 'active' }));
  }

  async currentSecret(itemId: string): Promise<SecretVersionRecord | null> {
    const c = this.c;
    c.enter();
    const item = (await c.s.items.get(uuid(itemId, 'itemId')));
    if (!item || !c.canSeeItem(item) || item.state === 'tombstoned') return null;
    const live = (await c.s.secrets.get(item.id))?.find((version) => version.version === item.secretVersion);
    return live ? outSecret(live) : null;
  }

  async tombstone(itemId: string, expectedVersion: number, actor: ActorRecord): Promise<ItemRecord> {
    const c = this.c;
    c.enter();
    const item = (await c.casItem(itemId, expectedVersion));
    const by = actorRecord(actor);
    (await c.tombstoneEffects({ itemId: item.id, spaceId: item.spaceId, ownerMemberId: item.ownerMemberId, tombstonedAt: c.now }, by));
    return (await c.bumpItem(item, { state: 'tombstoned', tombstonedAt: c.now }));
  }

  async countOwned(): Promise<number> {
    const c = this.c;
    c.enter();
    const { memberId, spaceId } = c.member();
    let count = 0;
    for (const item of (await c.s.items.values())) {
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
    // Serialize with rotation and grant creation before deleting their rows.
    const item = (await c.s.items.get(checked.itemId));
    let changed = (await c.tombstoneEffects(checked, SYSTEM_ACTOR));
    if (item && item.state !== 'tombstoned') {
      (await c.bumpItem(item, { state: 'tombstoned', tombstonedAt: checked.tombstonedAt }));
      changed = true;
    }
    return changed;
  }
}

class Policies implements PoliciesRepo {
  constructor(private readonly c: PgCtx) {}

  async get(itemId: string): Promise<PolicyRecord | null> {
    const c = this.c;
    c.enter();
    const item = (await c.s.items.get(uuid(itemId, 'itemId')));
    if (!item || !c.canSeeItem(item)) return null;
    const policy = (await c.s.policies.get(item.id));
    return policy ? out(policy) : null;
  }

  async set(itemId: string, expectedItemVersion: number, policy: PolicyInput, createdBy: ActorRecord): Promise<{ policy: PolicyRecord; item: ItemRecord }> {
    const c = this.c;
    c.enter();
    const item = (await c.casItem(itemId, expectedItemVersion));
    if (item.type !== 'api_key') throw new StoreStateError('wrong_item_type');
    const record: PolicyRecord = {
      itemId: item.id,
      version: ((await c.s.policies.get(item.id))?.version ?? 0) + 1,
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
    (await c.s.policies.set(item.id, deepFreeze(record)));
    return { policy: out(record), item: (await c.bumpItem(item, {})) };
  }
}

class Grants implements GrantsRepo {
  constructor(private readonly c: PgCtx) {}

  async create(grant: { id: string; itemId: string; granteeKind: GrantRecord['granteeKind']; granteeId: string; constraints: GrantConstraints; expiresAt: IsoTime | null; createdBy: ActorRecord }): Promise<GrantRecord> {
    const c = this.c;
    c.enter();
    const item = (await c.ownedLiveItem(grant.itemId));
    const id = uuid(grant.id, 'grantId');
    if ((await c.s.grants.has(id))) throw new StoreDuplicateError();
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
    (await c.s.grants.set(id, deepFreeze(record)));
    return out(record);
  }

  async get(grantId: string): Promise<GrantRecord | null> {
    const c = this.c;
    c.enter();
    const grant = (await c.s.grants.get(uuid(grantId, 'grantId')));
    return grant && c.canSeeGrant(grant) ? out(grant) : null;
  }

  async listForItem(itemId: string): Promise<GrantRecord[]> {
    const c = this.c;
    c.enter();
    const item = (await c.ownedItem(itemId));
    return [...(await c.s.grants.values())].filter((grant) => grant.itemId === item.id).sort(newestFirst).map(out);
  }

  async revoke(grantId: string, revokedBy: ActorRecord): Promise<GrantRecord> {
    const c = this.c;
    c.enter();
    const grant = (await c.s.grants.get(uuid(grantId, 'grantId')));
    const item = grant ? (await c.s.items.get(grant.itemId)) : undefined;
    if (!grant || !item || !c.owns(item)) throw new StoreNotFoundError();
    if (grant.revokedAt !== null) return out(grant);
    const next: GrantRecord = { ...grant, revokedAt: c.now, revokedBy: actorRecord(revokedBy) };
    (await c.s.grants.set(grant.id, deepFreeze(next)));
    return out(next);
  }
  async forceRevoke(entry: GrantRevokedLedgerEntry): Promise<boolean> {
    const c = this.c;
    c.enter();
    c.system();
    const grantId = uuid(entry.grantId, 'grantId');
    const itemId = uuid(entry.itemId, 'itemId');
    const revokedAt = iso(entry.revokedAt, 'revokedAt');
    const grant = (await c.s.grants.get(grantId));
    if (!grant) return false;
    if (grant.itemId !== itemId) throw new StoreStateError('ledger_mismatch');
    if (grant.revokedAt !== null) return false;
    const next: GrantRecord = { ...grant, revokedAt, revokedBy: SYSTEM_ACTOR };
    (await c.s.grants.set(grant.id, deepFreeze(next)));
    return true;
  }


  async activeForCaller(itemId: string): Promise<GrantRecord[]> {
    const c = this.c;
    c.enter();
    c.member();
    const id = uuid(itemId, 'itemId');
    return [...(await c.s.grants.values())]
      .filter((grant) => grant.itemId === id && c.grantLive(grant) && c.grantNamesScope(grant))
      .sort(newestFirst)
      .map(out);
  }

  async countActive(itemId: string): Promise<number> {
    const c = this.c;
    c.enter();
    const id = uuid(itemId, 'itemId');
    let count = 0;
    for (const grant of (await c.s.grants.values())) if (grant.itemId === id && c.grantLive(grant) && c.canSeeGrant(grant)) count += 1;
    return count;
  }
}

class Approvals implements ApprovalsRepo {
  constructor(private readonly c: PgCtx) {}

  async create(approval: NewApproval): Promise<ApprovalRecord> {
    const c = this.c;
    c.enter();
    const { memberId } = c.member();
    const item = (await c.visibleItem(approval.itemId));
    if (item.state === 'tombstoned') throw new StoreStateError('tombstoned');
    const id = uuid(approval.id, 'approvalId');
    if ((await c.s.approvals.has(id))) throw new StoreDuplicateError();
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
    (await c.s.approvals.set(id, deepFreeze(record)));
    return c.viewApproval(record);
  }

  async get(approvalId: string): Promise<ApprovalRecord | null> {
    const c = this.c;
    c.enter();
    const approval = (await c.s.approvals.get(uuid(approvalId, 'approvalId')));
    return approval && c.canSeeApproval(approval) ? c.viewApproval(approval) : null;
  }

  async list(query: PageQuery & { state?: ApprovalState; itemId?: string }): Promise<Page<ApprovalRecord>> {
    const c = this.c;
    c.enter();
    const itemId = query.itemId === undefined ? undefined : uuid(query.itemId, 'itemId');
    const rows = [...(await c.s.approvals.values())].filter((approval) => c.canSeeApproval(approval)
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

  async #find(itemId: string, kind: ApprovalKind, intentHash: string, accept: (approval: ApprovalRecord) => boolean): Promise<ApprovalRecord | null> {
    const c = this.c;
    c.enter();
    const { memberId, spaceId } = c.member();
    const id = uuid(itemId, 'itemId');
    const hash = hex64(intentHash, 'intentHash');
    const match = [...(await c.s.approvals.values())]
      .filter((approval) => approval.itemId === id && approval.spaceId === spaceId && approval.kind === kind
        && approval.requesterMemberId === memberId && digestEquals(approval.intentHash, hash) && accept(approval))
      .sort(newestFirst)[0];
    return match ? c.viewApproval(match) : null;
  }

  async decide(approvalId: string, decision: { state: 'approved' | 'denied'; decidedBy: ActorRecord; standing: boolean }): Promise<ApprovalRecord> {
    const c = this.c;
    c.enter();
    const { memberId } = c.member();
    const approval = (await c.s.approvals.get(uuid(approvalId, 'approvalId')));
    if (!approval || !c.canSeeApproval(approval) || approval.ownerMemberId !== memberId) throw new StoreNotFoundError();
    const state = oneOf(decision.state, ['approved', 'denied'] as const, 'decision');
    const standing = bool(decision.standing, 'standing');
    const decidedBy = actorRecord(decision.decidedBy);
    if (decidedBy.kind !== 'member' || decidedBy.memberId !== memberId) bad('decidedBy (only the owner, as a member, decides)');
    const effective = effectiveApprovalState(approval, c.now);
    if (effective !== 'pending') throw new StoreStateError(effective);
    if (standing && (state !== 'approved' || approval.kind !== 'new_origin')) throw new StoreStateError('standing_not_allowed');
    const next: ApprovalRecord = { ...approval, state, decidedAt: c.now, decidedBy, standing, oneUse: standing ? false : approval.oneUse };
    (await c.s.approvals.set(approval.id, deepFreeze(next)));
    return c.viewApproval(next);
  }

  async consume(approvalId: string, operationId: string): Promise<ApprovalRecord> {
    const c = this.c;
    c.enter();
    const { memberId } = c.member();
    const approval = (await c.s.approvals.get(uuid(approvalId, 'approvalId')));
    if (!approval || !c.canSeeApproval(approval) || approval.requesterMemberId !== memberId) throw new StoreNotFoundError();
    const effective = effectiveApprovalState(approval, c.now);
    if (effective !== 'approved') throw new StoreStateError(effective);
    if (!approval.oneUse) throw new StoreStateError('not_one_use');
    const next: ApprovalRecord = { ...approval, state: 'consumed', consumedAt: c.now, consumedByOperationId: uuid(operationId, 'operationId') };
    (await c.s.approvals.set(approval.id, deepFreeze(next)));
    return c.viewApproval(next);
  }
  async forceConsume(entry: ApprovalConsumedLedgerEntry): Promise<boolean> {
    const c = this.c;
    c.enter();
    c.system();
    const approvalId = uuid(entry.approvalId, 'approvalId');
    const itemId = uuid(entry.itemId, 'itemId');
    const operationId = uuid(entry.operationId, 'operationId');
    const consumedAt = iso(entry.consumedAt, 'consumedAt');
    const approval = (await c.s.approvals.get(approvalId));
    if (!approval) return false;
    if (approval.itemId !== itemId) throw new StoreStateError('ledger_mismatch');
    let next: ApprovalRecord;
    if (approval.state === 'approved' && approval.oneUse) next = { ...approval, state: 'consumed', consumedAt, consumedByOperationId: operationId };
    else if (approval.state === 'pending') next = { ...approval, state: 'expired' };
    else return false;
    (await c.s.approvals.set(approval.id, deepFreeze(next)));
    return true;
  }


  async expireDue(): Promise<ApprovalRecord[]> {
    const c = this.c;
    c.enter();
    c.system();
    const expired: ApprovalRecord[] = [];
    for (const approval of [...(await c.s.approvals.values())].sort(newestFirst).reverse()) {
      if (approval.state !== 'expired' && effectiveApprovalState(approval, c.now) === 'expired') {
        const next: ApprovalRecord = { ...approval, state: 'expired' };
        (await c.s.approvals.set(approval.id, deepFreeze(next)));
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
    for (const approval of (await c.s.approvals.values())) {
      if (approval.itemId === id && c.canSeeApproval(approval) && effectiveApprovalState(approval, c.now) === 'pending') count += 1;
    }
    return count;
  }
}

const operationKey = (memberId: string, operationId: string): string => `${memberId}|${operationId}`;

class Operations implements OperationsRepo {
  constructor(private readonly c: PgCtx) {}

  async reserve(operation: { operationId: string; kind: OperationKind; itemId: string; intentHash: string; actor: ActorRecord; approvalId: string | null }): Promise<{ created: boolean; operation: OperationRecord }> {
    const c = this.c;
    c.enter();
    const { memberId, spaceId } = c.member();
    const operationId = uuid(operation.operationId, 'operationId');
    const existing = (await c.s.operations.get(operationKey(memberId, operationId)));
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
    (await c.s.operations.set(operationKey(memberId, operationId), deepFreeze(record)));
    return { created: true, operation: out(record) };
  }

  async complete(operationId: string, outcome: { state: Exclude<OperationState, 'in_progress'>; result: unknown; approvalId?: string | null }): Promise<OperationRecord> {
    const c = this.c;
    c.enter();
    const { memberId } = c.member();
    const key = operationKey(memberId, uuid(operationId, 'operationId'));
    const operation = (await c.s.operations.get(key));
    if (!operation) throw new StoreNotFoundError();
    if (operation.state !== 'in_progress') throw new StoreStateError(operation.state);
    const next: OperationRecord = {
      ...operation,
      state: oneOf(outcome.state, FINAL_OPERATION_STATES, 'operation state'),
      result: jsonValue(outcome.result),
      approvalId: outcome.approvalId === undefined ? operation.approvalId : nullableUuid(outcome.approvalId, 'approvalId'),
      completedAt: c.now,
    };
    (await c.s.operations.set(key, deepFreeze(next)));
    return out(next);
  }

  async get(operationId: string): Promise<OperationRecord | null> {
    const c = this.c;
    c.enter();
    const { memberId } = c.member();
    const operation = (await c.s.operations.get(operationKey(memberId, uuid(operationId, 'operationId'))));
    return operation ? out(operation) : null;
  }

  async markInProgressUnknown(): Promise<OperationRecord[]> {
    const c = this.c;
    c.enter();
    c.system();
    const marked: OperationRecord[] = [];
    for (const [key, operation] of (await c.s.operations.entries())) {
      if (operation.state !== 'in_progress') continue;
      const next: OperationRecord = { ...operation, state: 'unknown', result: null };
      (await c.s.operations.set(key, deepFreeze(next)));
      marked.push(out(next));
    }
    return marked.sort(oldestOperationFirst);
  }

  async listUnknown(kind: OperationKind): Promise<OperationRecord[]> {
    const c = this.c;
    c.enter();
    c.system();
    const wanted = oneOf(kind, OPERATION_KINDS, 'operation kind');
    return [...(await c.s.operations.values())]
      .filter((operation) => operation.state === 'unknown' && operation.kind === wanted)
      .sort(oldestOperationFirst)
      .map(out);
  }

  async resolveUnknown(memberId: string, operationId: string, outcome: { state: 'done' | 'refused'; result: unknown }): Promise<OperationRecord> {
    const c = this.c;
    c.enter();
    c.system();
    const key = operationKey(uuid(memberId, 'memberId'), uuid(operationId, 'operationId'));
    const operation = (await c.s.operations.get(key));
    if (!operation) throw new StoreNotFoundError();
    if (operation.state !== 'unknown') throw new StoreStateError(operation.state);
    const next: OperationRecord = {
      ...operation,
      state: oneOf(outcome.state, ['done', 'refused'] as const, 'operation state'),
      result: jsonValue(outcome.result),
      completedAt: c.now,
    };
    (await c.s.operations.set(key, deepFreeze(next)));
    return out(next);
  }
}

class Spend implements SpendRepo {
  constructor(private readonly c: PgCtx) {}

  async create(request: Omit<SpendRequestRecord, 'createdAt' | 'executedAt' | 'processorRef'>): Promise<SpendRequestRecord> {
    const c = this.c;
    c.enter();
    c.member();
    const approval = (await c.s.approvals.get(uuid(request.approvalId, 'approvalId')));
    if (!approval || !c.canSeeApproval(approval)) throw new StoreNotFoundError();
    if (approval.kind !== 'spend') throw new StoreStateError('not_spend');
    if (uuid(request.itemId, 'itemId') !== approval.itemId) throw new StoreStateError('item_mismatch');
    if ((await c.s.spend.has(approval.id))) throw new StoreDuplicateError();
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
    (await c.s.spend.set(approval.id, deepFreeze(record)));
    return out(record);
  }

  async getByApproval(approvalId: string): Promise<SpendRequestRecord | null> {
    const c = this.c;
    c.enter();
    const approval = (await c.s.approvals.get(uuid(approvalId, 'approvalId')));
    if (!approval || !c.canSeeApproval(approval)) return null;
    const request = (await c.s.spend.get(approval.id));
    return request ? out(request) : null;
  }

  async markExecuted(approvalId: string, processorRef: string): Promise<SpendRequestRecord> {
    const c = this.c;
    c.enter();
    const approval = (await c.s.approvals.get(uuid(approvalId, 'approvalId')));
    const requester = c.scope.kind === 'system'
      || (approval !== undefined && c.canSeeApproval(approval) && approval.requesterMemberId === c.scope.memberId);
    const request = approval && requester ? (await c.s.spend.get(approval.id)) : undefined;
    if (!request) throw new StoreNotFoundError();
    if (request.executedAt !== null) throw new StoreStateError('executed');
    const ref = text(processorRef, 'processorRef', 200);
    if (!PRINTABLE_RE.test(ref)) bad('processorRef');
    const next: SpendRequestRecord = { ...request, executedAt: c.now, processorRef: ref };
    (await c.s.spend.set(request.approvalId, deepFreeze(next)));
    return out(next);
  }
}

class Passkeys implements PasskeysRepo {
  constructor(private readonly c: PgCtx) {}

  async #own(passkeyId: string): Promise<PasskeyRecord | undefined> {
    const c = this.c;
    const passkey = (await c.s.passkeys.get(uuid(passkeyId, 'passkeyId')));
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
    if ((await c.s.passkeys.has(id))) throw new StoreDuplicateError();
    for (const existing of (await c.s.passkeys.values())) if (existing.credentialId === credentialId) throw new StoreDuplicateError();
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
    (await c.s.passkeys.set(id, deepFreeze(record)));
    return out(record);
  }

  async get(passkeyId: string): Promise<PasskeyRecord | null> {
    this.c.enter();
    const passkey = (await this.#own(passkeyId));
    return passkey ? out(passkey) : null;
  }

  async getByCredentialId(credentialId: string): Promise<PasskeyRecord | null> {
    const c = this.c;
    c.enter();
    const { memberId } = c.member();
    for (const passkey of (await c.s.passkeys.values())) {
      if (passkey.memberId === memberId && passkey.credentialId === credentialId) return out(passkey);
    }
    return null;
  }

  async listForMember(): Promise<PasskeyRecord[]> {
    const c = this.c;
    c.enter();
    const { memberId } = c.member();
    return [...(await c.s.passkeys.values())].filter((passkey) => passkey.memberId === memberId).sort(newestFirst).map(out);
  }

  async countActive(): Promise<number> {
    const c = this.c;
    c.enter();
    const { memberId } = c.member();
    let count = 0;
    for (const passkey of (await c.s.passkeys.values())) if (passkey.memberId === memberId && passkey.revokedAt === null) count += 1;
    return count;
  }

  async recordUse(passkeyId: string, newCounter: number): Promise<PasskeyRecord> {
    const c = this.c;
    c.enter();
    c.member();
    const passkey = (await this.#own(passkeyId));
    if (!passkey) throw new StoreNotFoundError();
    if (passkey.revokedAt !== null) throw new StoreStateError('revoked');
    const counter = int(newCounter, 'counter', 0);
    if (!(counter > passkey.counter || (counter === 0 && passkey.counter === 0))) throw new StoreStateError('counter_regression');
    const next: PasskeyRecord = { ...passkey, counter, lastUsedAt: c.now };
    (await c.s.passkeys.set(passkey.id, deepFreeze(next)));
    return out(next);
  }

  async revoke(passkeyId: string): Promise<PasskeyRecord> {
    const c = this.c;
    c.enter();
    c.member();
    const passkey = (await this.#own(passkeyId));
    if (!passkey) throw new StoreNotFoundError();
    if (passkey.revokedAt !== null) return out(passkey);
    const next: PasskeyRecord = { ...passkey, revokedAt: c.now };
    (await c.s.passkeys.set(passkey.id, deepFreeze(next)));
    return out(next);
  }
}

class Sessions implements VaultSessionsRepo {
  constructor(private readonly c: PgCtx) {}

  async #own(sessionId: string): Promise<VaultSessionRecord | undefined> {
    const c = this.c;
    const session = (await c.s.sessions.get(uuid(sessionId, 'sessionId')));
    if (!session) return undefined;
    return c.scope.kind === 'system' || session.memberId === c.scope.memberId ? session : undefined;
  }

  async #put(next: VaultSessionRecord): Promise<VaultSessionRecord> {
    await this.c.s.sessions.set(next.id, deepFreeze(next));
    return out(next);
  }

  async #end(session: VaultSessionRecord, reason: SessionEndReason): Promise<VaultSessionRecord> {
    return (await this.#put({ ...session, revokedAt: this.c.now, revokedReason: reason }));
  }

  async #freshHashes(tokenHash: string, refreshHash: string): Promise<void> {
    if (tokenHash === refreshHash || (await this.c.hashInUse(tokenHash)) || (await this.c.hashInUse(refreshHash))) throw new StoreDuplicateError();
  }

  async create(session: Omit<VaultSessionRecord, 'memberId' | 'refreshVersion' | 'createdAt' | 'lastUsedAt' | 'revokedAt' | 'revokedReason'>): Promise<VaultSessionRecord> {
    const c = this.c;
    c.enter();
    const { memberId } = c.member();
    const id = uuid(session.id, 'sessionId');
    const passkey = (await c.s.passkeys.get(uuid(session.passkeyId, 'passkeyId')));
    if (!passkey || passkey.memberId !== memberId) throw new StoreNotFoundError();
    if (passkey.revokedAt !== null) throw new StoreStateError('passkey_revoked');
    if ((await c.s.sessions.has(id))) throw new StoreDuplicateError();
    const tokenHash = hex64(session.tokenHash, 'tokenHash');
    const refreshHash = hex64(session.refreshHash, 'refreshHash');
    (await this.#freshHashes(tokenHash, refreshHash));
    const familyExpiresAt = iso(session.familyExpiresAt, 'familyExpiresAt');
    return (await this.#put({
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
    }));
  }

  async get(sessionId: string): Promise<VaultSessionRecord | null> {
    this.c.enter();
    const session = (await this.#own(sessionId));
    return session ? out(session) : null;
  }

  async getByTokenHash(tokenHash: string): Promise<VaultSessionRecord | null> {
    const c = this.c;
    c.enter();
    const { memberId } = c.member();
    const hash = hex64(tokenHash, 'tokenHash');
    for (const session of (await c.s.sessions.values())) {
      if (session.memberId === memberId && session.tokenHash === hash) return out(session);
    }
    return null;
  }

  async listForMember(): Promise<VaultSessionRecord[]> {
    const c = this.c;
    c.enter();
    const { memberId } = c.member();
    return [...(await c.s.sessions.values())].filter((session) => session.memberId === memberId).sort(newestFirst).map(out);
  }

  async touch(sessionId: string): Promise<void> {
    const c = this.c;
    c.enter();
    c.member();
    const session = (await this.#own(sessionId));
    if (!session) throw new StoreNotFoundError();
    (await this.#put({ ...session, lastUsedAt: c.now }));
  }

  async rotateRefresh(input: { refreshHash: string; newTokenHash: string; newRefreshHash: string; expiresAt: IsoTime; refreshExpiresAt: IsoTime }): Promise<RefreshRotation> {
    const c = this.c;
    c.enter();
    const { memberId } = c.member();
    const presented = hex64(input.refreshHash, 'refreshHash');
    let current: VaultSessionRecord | undefined;
    for (const session of (await c.s.sessions.values())) {
      if (session.memberId === memberId && session.refreshHash === presented) current = session;
    }
    if (current) {
      if (c.sessionEnded(current)) return { result: 'ended', session: out(current) };
      const tokenHash = hex64(input.newTokenHash, 'newTokenHash');
      const refreshHash = hex64(input.newRefreshHash, 'newRefreshHash');
      const expiresAt = earliest(iso(input.expiresAt, 'expiresAt'), current.familyExpiresAt);
      const refreshExpiresAt = earliest(iso(input.refreshExpiresAt, 'refreshExpiresAt'), current.familyExpiresAt);
      (await this.#freshHashes(tokenHash, refreshHash));
      (await c.s.supersededRefresh.set(presented, current.id));
      return {
        result: 'rotated',
        session: (await this.#put({
          ...current,
          tokenHash,
          refreshHash,
          refreshVersion: current.refreshVersion + 1,
          lastUsedAt: c.now,
          expiresAt,
          refreshExpiresAt,
        })),
      };
    }
    const familyId = (await c.s.supersededRefresh.get(presented));
    const family = familyId === undefined ? undefined : (await c.s.sessions.get(familyId));
    if (!family || family.memberId !== memberId) return { result: 'unknown' };
    if (c.sessionEnded(family)) return { result: 'ended', session: out(family) };
    return { result: 'reused', session: (await this.#end(family, 'refresh_reuse')) };
  }

  async revoke(sessionId: string, reason: SessionEndReason): Promise<VaultSessionRecord> {
    const c = this.c;
    c.enter();
    const why = oneOf(reason, SESSION_END_REASONS, 'reason');
    const session = (await this.#own(sessionId));
    if (!session) throw new StoreNotFoundError();
    return session.revokedAt === null ? (await this.#end(session, why)) : out(session);
  }

  async revokeAllForMember(reason: SessionEndReason): Promise<VaultSessionRecord[]> {
    const c = this.c;
    c.enter();
    const { memberId } = c.member();
    const why = oneOf(reason, SESSION_END_REASONS, 'reason');
    return Promise.all([...(await c.s.sessions.values())]
      .filter((session) => session.memberId === memberId && session.revokedAt === null)
      .sort(newestFirst)
      .map(async (session) => this.#end(session, why)));
  }

  async revokeForPasskey(passkeyId: string): Promise<VaultSessionRecord[]> {
    const c = this.c;
    c.enter();
    const { memberId } = c.member();
    const id = uuid(passkeyId, 'passkeyId');
    return Promise.all([...(await c.s.sessions.values())]
      .filter((session) => session.memberId === memberId && session.passkeyId === id && session.revokedAt === null)
      .sort(newestFirst)
      .map(async (session) => this.#end(session, 'passkey_revoked')));
  }
}

class Challenges implements ChallengesRepo {
  constructor(private readonly c: PgCtx) {}

  async create(challenge: Omit<ChallengeRecord, 'memberId' | 'createdAt' | 'consumedAt'>): Promise<ChallengeRecord> {
    const c = this.c;
    c.enter();
    const { memberId } = c.member();
    const id = uuid(challenge.id, 'challengeId');
    if ((await c.s.challenges.has(id))) throw new StoreDuplicateError();
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
    (await c.s.challenges.set(id, deepFreeze(record)));
    return out(record);
  }

  async consume(challengeId: string, purpose: ChallengePurpose): Promise<ChallengeRecord | null> {
    const c = this.c;
    c.enter();
    const { memberId } = c.member();
    const challenge = (await c.s.challenges.get(uuid(challengeId, 'challengeId')));
    if (!challenge || challenge.memberId !== memberId || challenge.purpose !== purpose
      || challenge.consumedAt !== null || c.lapsed(challenge.expiresAt)) {
      return null;
    }
    const next: ChallengeRecord = { ...challenge, consumedAt: c.now };
    (await c.s.challenges.set(challenge.id, deepFreeze(next)));
    return out(next);
  }

  async deleteExpired(): Promise<number> {
    const c = this.c;
    c.enter();
    c.system();
    let count = 0;
    for (const [id, challenge] of (await c.s.challenges.entries())) {
      if (c.lapsed(challenge.expiresAt)) {
        (await c.s.challenges.delete(id));
        count += 1;
      }
    }
    return count;
  }
}

class RecoveryCodes implements RecoveryCodesRepo {
  constructor(private readonly c: PgCtx) {}

  async replaceAll(codes: { id: string; hash: string }[]): Promise<void> {
    const c = this.c;
    c.enter();
    const { memberId } = c.member();
    if (!Array.isArray(codes)) bad('codes');
    const fresh = codes.map((code) => ({ id: uuid(code.id, 'codeId'), hash: argon2idHash(code.hash) }));
    const replaced = (code: CodeRecord): boolean => code.memberId === memberId && code.usedAt === null;
    const ids = new Set<string>();
    for (const code of fresh) {
      const existing = (await c.s.recoveryCodes.get(code.id));
      // Checked before anything is deleted: a failed call changes nothing.
      if (ids.has(code.id) || (existing && !replaced(existing))) throw new StoreDuplicateError();
      ids.add(code.id);
    }
    for (const [id, code] of (await c.s.recoveryCodes.entries())) if (replaced(code)) (await c.s.recoveryCodes.delete(id));
    for (const code of fresh) {
      (await c.s.recoveryCodes.set(code.id, deepFreeze({ id: code.id, memberId, hash: code.hash, createdAt: c.now, usedAt: null })));
    }
  }

  async listUnused(): Promise<CodeRecord[]> {
    const c = this.c;
    c.enter();
    const { memberId } = c.member();
    return [...(await c.s.recoveryCodes.values())].filter((code) => code.memberId === memberId && code.usedAt === null).sort(oldestCodeFirst).map(out);
  }

  async markUsed(codeId: string): Promise<boolean> {
    const c = this.c;
    c.enter();
    const { memberId } = c.member();
    const code = (await c.s.recoveryCodes.get(uuid(codeId, 'codeId')));
    if (!code || code.memberId !== memberId || code.usedAt !== null) return false;
    (await c.s.recoveryCodes.set(code.id, deepFreeze({ ...code, usedAt: c.now })));
    return true;
  }

  async countUnused(): Promise<number> {
    const c = this.c;
    c.enter();
    const { memberId } = c.member();
    let count = 0;
    for (const code of (await c.s.recoveryCodes.values())) if (code.memberId === memberId && code.usedAt === null) count += 1;
    return count;
  }
}

class EnrollmentCodes implements EnrollmentCodesRepo {
  constructor(private readonly c: PgCtx) {}

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
    if ((await c.s.enrollmentCodes.has(id))) throw new StoreDuplicateError();
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
    (await c.s.enrollmentCodes.set(id, deepFreeze(record)));
    return out(record);
  }

  async listUsable(): Promise<EnrollmentCodeRecord[]> {
    const c = this.c;
    c.enter();
    return [...(await c.s.enrollmentCodes.values())].filter((code) => this.#usable(code)).sort(oldestCodeFirst).map(out);
  }

  async markUsed(codeId: string): Promise<boolean> {
    const c = this.c;
    c.enter();
    const code = (await c.s.enrollmentCodes.get(uuid(codeId, 'codeId')));
    if (!this.#usable(code)) return false;
    (await c.s.enrollmentCodes.set(code.id, deepFreeze({ ...code, usedAt: c.now })));
    return true;
  }
}

class CaptureLinks implements CaptureLinksRepo {
  constructor(private readonly c: PgCtx) {}

  async #usable(captureId: string, tokenHash: string): Promise<CaptureLinkRecord | null> {
    const c = this.c;
    const { memberId, spaceId } = c.member();
    const hash = hex64(tokenHash, 'tokenHash');
    const link = (await c.s.captureLinks.get(uuid(captureId, 'captureId')));
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
      const item = (await c.ownedLiveItem(link.itemId));
      if (item.type !== itemType) throw new StoreStateError('wrong_item_type');
      itemId = item.id;
    } else if (link.itemId !== null) {
      bad('itemId (a create link names no item)');
    }
    if ((await c.s.captureLinks.has(id))) throw new StoreDuplicateError();
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
    (await c.s.captureLinks.set(id, deepFreeze(record)));
    return out(record);
  }

  async getUsable(captureId: string, tokenHash: string): Promise<CaptureLinkRecord | null> {
    this.c.enter();
    const link = (await this.#usable(captureId, tokenHash));
    return link ? out(link) : null;
  }

  async markOpened(captureId: string): Promise<void> {
    const c = this.c;
    c.enter();
    const { memberId, spaceId } = c.member();
    const link = (await c.s.captureLinks.get(uuid(captureId, 'captureId')));
    if (!link || link.memberId !== memberId || link.spaceId !== spaceId) throw new StoreNotFoundError();
    if (link.openedAt === null) (await c.s.captureLinks.set(link.id, deepFreeze({ ...link, openedAt: c.now })));
  }

  async consume(captureId: string, tokenHash: string): Promise<CaptureLinkRecord | null> {
    const c = this.c;
    c.enter();
    const link = (await this.#usable(captureId, tokenHash));
    if (!link) return null;
    const next: CaptureLinkRecord = { ...link, consumedAt: c.now };
    (await c.s.captureLinks.set(link.id, deepFreeze(next)));
    return out(next);
  }
}

class Audit implements AuditRepo {
  constructor(private readonly c: PgCtx) {}
  async append(event: AuditBody): Promise<AuditEventRecord> {
    const c = this.c; c.enter();
    if (c.faults.auditAppend) throw new AuditUnavailableError();
    if (typeof event.action !== 'string' || !AUDIT_ACTIONS.has(event.action)) bad('audit action');
    const body: AuditBody = { action: event.action, actor: actorRecord(event.actor), itemId: nullableUuid(event.itemId, 'itemId'), subjectMemberId: nullableUuid(event.subjectMemberId, 'subjectMemberId'), spaceId: nullableUuid(event.spaceId, 'spaceId'), params: auditParams(event.params, 'params') };
    const at = iso(c.clock.now().toISOString(), 'audit time');
    const rows = await c.query('select * from vault.append_audit($1, $2::timestamptz)', [auditBodyText(body), at]);
    return decode<AuditEventRecord>(rows[0]!);
  }
  async list(query: PageQuery & { itemId?: string; action?: string }): Promise<Page<AuditEventRecord>> {
    const c = this.c; c.enter();
    const memberId = c.scope.kind === 'member' ? c.scope.memberId : null;
    const itemId = query.itemId === undefined ? undefined : uuid(query.itemId, 'itemId');
    const rows = (await c.query('select * from vault.audit_events')).map((row) => decode<AuditEventRecord>(row));
    return pageBySeq(rows.filter((event) => (memberId === null || event.subjectMemberId === memberId) && (itemId === undefined || event.itemId === itemId) && (query.action === undefined || event.action === query.action)), query);
  }
  async listForItem(itemId: string, since: IsoTime, limit: number): Promise<AuditEventRecord[]> {
    const c = this.c; c.enter();
    const item = await c.visibleItem(itemId);
    const owner = c.owns(item);
    const memberId = c.scope.kind === 'member' ? c.scope.memberId : null;
    const rows = await c.query('select * from vault.audit_events where item_id = $1 and at >= $2 and ($3::boolean or actor->>\'memberId\' = $4) order by seq desc limit $5', [item.id, iso(since, 'since'), owner, memberId, clampLimit(limit)]);
    return rows.map((row) => decode<AuditEventRecord>(row));
  }
  async fillFailureStreak(itemId: string, origin: string): Promise<number> {
    const c = this.c; c.enter();
    const item = await c.visibleItem(itemId);
    // A SECURITY DEFINER count: RLS would show a grantee only its own events, and only the integer comes back.
    const rows = await c.query('select vault.fill_failure_streak($1, $2) as streak', [item.id, text(origin, 'origin', 2048)]);
    return int(rows[0]?.streak, 'streak', 0);
  }
  async head(): Promise<{ seq: number; hash: string }> {
    const row = (await this.c.query('select seq, hash from vault.audit_head where singleton'))[0]!;
    return { seq: Number(row.seq), hash: String(row.hash) };
  }
  async range(fromSeq: number, toSeq: number): Promise<AuditEventRecord[]> {
    this.c.system();
    const from = int(fromSeq, 'fromSeq', 1); const to = int(toSeq, 'toSeq', 0);
    return (await this.c.query('select * from vault.audit_events where seq >= $1 and seq <= $2 order by seq', [from, to])).map((row) => decode<AuditEventRecord>(row));
  }
  async recordCheckpoint(checkpoint: CheckpointRecord): Promise<void> {
    const c = this.c; c.system();
    const seq = int(checkpoint.seq, 'checkpoint seq', 0); const headHash = hex64(checkpoint.headHash, 'checkpoint headHash');
    const expected = seq === 0 ? AUDIT_GENESIS_HASH : (await c.query('select entry_hash from vault.audit_events where seq = $1', [seq]))[0]?.entry_hash;
    if (expected !== headHash) throw new StoreStateError('checkpoint_mismatch');
    const signature = checkpoint.signature === null ? null : text(checkpoint.signature, 'signature', 4096);
    if (signature !== null && !B64URL_RE.test(signature)) bad('signature');
    await c.query('insert into vault.checkpoints(seq,head_hash,at,sink,anchored,location,key_id,signature) values ($1,$2,$3,$4,$5,$6,$7,$8)', [seq, headHash, iso(checkpoint.at, 'checkpoint at'), oneOf(checkpoint.sink, ['off','file','gcs'] as const, 'sink'), bool(checkpoint.anchored, 'anchored'), nullableText(checkpoint.location, 'location', 1000), nullableText(checkpoint.keyId, 'keyId', 200), signature]);
  }
  async latestCheckpoint(): Promise<CheckpointRecord | null> {
    const row = (await this.c.query('select * from vault.checkpoints order by seq desc, ordinal desc limit 1'))[0];
    return row ? decode<CheckpointRecord>(row) : null;
  }
}
class DeletionLedgerMirror implements DeletionLedgerRepo {
  constructor(private readonly c: PgCtx) {}
  async list(): Promise<DeletionLedgerEntry[]> { this.c.system(); return (await this.c.s.deletionLedger.values()).sort((a,b) => compareTimeKey([a.tombstonedAt,a.itemId],[b.tombstonedAt,b.itemId])).map(out); }
}
