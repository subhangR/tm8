/**
 * The shared broker test kit. F, G, H, J and K build their tests on it, so
 * nobody writes a second fake of the same seam. It is test-only: nothing in
 * `src` imports it.
 *
 * Fixtures are obviously fake: `example.test` names, fixed UUIDs, and secret
 * values that say "test-only". A key-shaped string must be assembled at
 * runtime (the secret scan reads every pushed line).
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { vaultStepUpBoundParams, type VaultOperationName, type VaultStepUpProof } from '@tm8/contract';
import {
  AUDIT_GENESIS_HASH,
  CaptureKeyPair,
  LocalDevKms,
  MemoryVaultStore,
  SecretMaterial,
  VAULT_CIPHER_SUITE,
  VaultError,
  actorOf,
  encryptSecretVersion,
  intentHash,
  stepUpIntentHash,
  type AlertSink,
  type ApprovalKind,
  type AuditGate,
  type AuditParam,
  type AuditVerification,
  type BrokerComponents,
  type BrokerConfig,
  type CanarySet,
  type Clock,
  type DeletionLedger,
  type DeletionLedgerEntry,
  type EgressExecutor,
  type EncryptedSecretVersion,
  type FillDriver,
  type HandlerContext,
  type ImportParser,
  type IsoTime,
  type KmsProvider,
  type NewApproval,
  type NewItem,
  type OwnerAuth,
  type OwnerSession,
  type SpendProcessor,
  type StepUpBinding,
  type StepUpVerified,
  type StoreScope,
  type VaultAlert,
  type VaultCaller,
  type VaultCookies,
  type VaultStore,
} from '../../src/index.js';
import { buildCanarySet } from '../../src/canary/index.js';
import { createPasteDetector } from '../../src/paste/index.js';

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

export const T0 = '2026-11-20T12:00:00.000Z';

/** A clock that moves only when told to. */
export class FixedClock implements Clock {
  #ms: number;

  constructor(start: IsoTime | number = T0) {
    this.#ms = typeof start === 'number' ? start : Date.parse(start);
  }

  now(): Date {
    return new Date(this.#ms);
  }

  iso(offsetMs = 0): IsoTime {
    return new Date(this.#ms + offsetMs).toISOString();
  }

  set(at: IsoTime | number): void {
    this.#ms = typeof at === 'number' ? at : Date.parse(at);
  }

  advance(ms: number): void {
    this.#ms += ms;
  }

  advanceSeconds(seconds: number): void {
    this.#ms += seconds * 1000;
  }
}

export const MINUTE = 60_000;

// ---------------------------------------------------------------------------
// Who
// ---------------------------------------------------------------------------

export const SPACE_A = '0a000000-0000-4000-8000-00000000000a';
export const SPACE_B = '0b000000-0000-4000-8000-00000000000b';
export const OWNER_ID = '00000000-0000-4000-8000-0000000000a1';
export const MEMBER_ID = '00000000-0000-4000-8000-0000000000b2';
export const OUTSIDER_ID = '00000000-0000-4000-8000-0000000000c3';

export function makeCaller(overrides: Partial<VaultCaller> = {}): VaultCaller {
  return {
    kind: 'member',
    memberId: OWNER_ID,
    spaceId: SPACE_A,
    sessionId: null,
    name: 'Test owner',
    isSpaceAdmin: true,
    ip: '192.0.2.10',
    ...overrides,
  };
}

/** The item owner in space A. */
export const testCaller: VaultCaller = Object.freeze(makeCaller());
/** Another member of space A: a grantee when the owner shares. */
export const otherCaller: VaultCaller = Object.freeze(makeCaller({ memberId: MEMBER_ID, name: 'Test member', isSpaceAdmin: false }));
/** A member of space B. Never sees anything in space A. */
export const outsiderCaller: VaultCaller = Object.freeze(makeCaller({ memberId: OUTSIDER_ID, spaceId: SPACE_B, name: 'Test outsider' }));

/** An agent session acting as `caller`'s member. */
export function agentOf(caller: VaultCaller, sessionId: string = randomUUID()): VaultCaller {
  return { ...caller, kind: 'agent', sessionId, name: 'Test agent' };
}

export function scopeOf(caller: Pick<VaultCaller, 'memberId' | 'spaceId'>): StoreScope {
  return { kind: 'member', memberId: caller.memberId, spaceId: caller.spaceId };
}

export const SYSTEM_SCOPES = {
  reconcile: { kind: 'system', purpose: 'reconcile' },
  expire: { kind: 'system', purpose: 'expire' },
  audit: { kind: 'system', purpose: 'audit' },
  deletionLedger: { kind: 'system', purpose: 'deletion_ledger' },
  enrollment: { kind: 'system', purpose: 'enrollment' },
  cleanup: { kind: 'system', purpose: 'cleanup' },
} as const satisfies Record<string, StoreScope>;

// ---------------------------------------------------------------------------
// Values (all fake)
// ---------------------------------------------------------------------------

export function sha256hex(text: string | Buffer): string {
  return createHash('sha256').update(text).digest('hex');
}

/** A random 32-byte token as the broker mints it, and the hash the store keeps. */
export function tokenPair(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: sha256hex(token) };
}

/** Shaped like a hash-wasm Argon2id string. Not a hash of anything. */
export function fakeArgon2idHash(): string {
  const b64 = (n: number): string => randomBytes(n).toString('base64').replace(/=+$/, '');
  return `$argon2id$v=19$m=19456,t=2,p=1$${b64(16)}$${b64(32)}`;
}

/** Encrypted-looking bytes for store tests that never decrypt. */
export function fakeSecret(kekId = 'local-dev:test'): EncryptedSecretVersion {
  return { suite: VAULT_CIPHER_SUITE, kekId, wrappedDek: randomBytes(60), nonce: randomBytes(12), ciphertext: randomBytes(48) };
}

/** A real envelope under `kms`, for tests that decrypt. */
export async function testSecret(
  kms: KmsProvider,
  item: { id: string; ownerMemberId: string },
  version = 1,
  value = 'test-only secret value',
): Promise<EncryptedSecretVersion> {
  const material = SecretMaterial.fromUtf8(value);
  try {
    return await encryptSecretVersion(kms, material, { itemId: item.id, ownerId: item.ownerMemberId, version });
  } finally {
    material.dispose();
  }
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

export function newLogin(caller: VaultCaller = testCaller, overrides: Partial<NewItem> = {}): NewItem {
  return {
    id: randomUUID(),
    type: 'login',
    name: 'Example login',
    state: 'active',
    exposureTier: null,
    origins: ['https://login.example.test'],
    devMode: false,
    username: 'test-user',
    last4: null,
    expMonth: null,
    expYear: null,
    connector: null,
    hasTotp: false,
    hasNotes: false,
    fieldNames: [],
    createdBy: actorOf(caller),
    ...overrides,
  };
}

export function newApiKey(caller: VaultCaller = testCaller, overrides: Partial<NewItem> = {}): NewItem {
  return newLogin(caller, { type: 'api_key', name: 'Example API key', origins: [], username: null, connector: null, ...overrides });
}

export function newApproval(
  itemId: string,
  caller: VaultCaller,
  clock: FixedClock,
  overrides: Partial<NewApproval> & { kind?: ApprovalKind; boundParams?: Record<string, AuditParam> } = {},
): NewApproval {
  const kind = overrides.kind ?? 'use';
  const boundParams = overrides.boundParams ?? { itemId, origin: 'https://login.example.test' };
  return {
    id: randomUUID(),
    itemId,
    kind,
    oneUse: true,
    intentHash: intentHash(kind, boundParams),
    boundParams,
    requestedBy: actorOf(caller),
    purpose: null,
    lookalike: [],
    spend: null,
    operationId: null,
    expiresAt: clock.iso(15 * MINUTE),
    ...overrides,
  };
}

/** Creates an item as `caller` and returns it. */
export async function seedItem(store: VaultStore, caller: VaultCaller = testCaller, item: NewItem = newLogin(caller)) {
  return store.transaction(scopeOf(caller), (tx) => tx.items.create(item, fakeSecret()));
}

// ---------------------------------------------------------------------------
// Fakes for the seams in core-types.ts
// ---------------------------------------------------------------------------

/** `DeletionLedger` in memory. It survives `MemoryVaultStore.testing.restore`, as the real file survives a database restore. */
export class MemoryDeletionLedger implements DeletionLedger {
  readonly #entries: DeletionLedgerEntry[] = [];
  failAppend = false;

  async append(entry: DeletionLedgerEntry): Promise<void> {
    if (this.failAppend) throw new Error('deletion ledger: append failed (test)');
    this.#entries.push({ ...entry });
  }

  async entries(): Promise<DeletionLedgerEntry[]> {
    return this.#entries.map((entry) => ({ ...entry }));
  }
}

export class RecordingAlertSink implements AlertSink {
  readonly alerts: VaultAlert[] = [];

  raise(alert: VaultAlert): void {
    this.alerts.push(structuredClone(alert));
  }

  kinds(): string[] {
    return this.alerts.map((alert) => alert.kind);
  }
}

/** `AuditGate` with a settable status. F's real gate has its own tests. */
export class FakeAuditGate implements AuditGate {
  state: 'ok' | 'unavailable' | 'disabled' = 'ok';
  appendFailures = 0;
  verification: AuditVerification = { status: 'verified', checkedThroughSeq: 0, headHash: AUDIT_GENESIS_HASH, firstBrokenSeq: null };

  assertHealthy(): void {
    if (this.state !== 'ok') throw VaultError.reason('audit_unavailable');
  }

  reportAppendFailure(): void {
    this.appendFailures += 1;
    this.state = 'unavailable';
  }

  async verifyIncremental(): Promise<AuditVerification> {
    return { ...this.verification };
  }

  async verifyAll(): Promise<AuditVerification> {
    return { ...this.verification };
  }

  status(): 'ok' | 'unavailable' | 'disabled' {
    return this.state;
  }
}

/**
 * `OwnerAuth` without WebAuthn. It computes the step-up intent hash exactly as
 * the real one must (`vaultStepUpBoundParams` then `stepUpIntentHash`) and
 * records every binding, so a handler test can assert WHAT was bound.
 */
export class FakeOwnerAuth implements OwnerAuth {
  /** `ok`: any proof verifies. `required`: as if no proof. `invalid`: every proof fails. */
  mode: 'ok' | 'required' | 'invalid' = 'ok';
  session: OwnerSession | null;
  passkeys = 1;
  recoveryCodesRemaining: number | null = 10;
  readonly bindings: { action: StepUpBinding['action']; intentHash: string; proof: VaultStepUpProof | undefined }[] = [];

  constructor(private readonly clock: Clock, session: OwnerSession | null = null) {
    this.session = session;
  }

  /** A live session for `caller`. */
  static signedIn(clock: FixedClock, caller: VaultCaller = testCaller): FakeOwnerAuth {
    return new FakeOwnerAuth(clock, { sessionId: randomUUID(), memberId: caller.memberId, passkeyId: randomUUID(), expiresAt: clock.iso(15 * MINUTE) });
  }

  async resolveSession(caller: VaultCaller, cookies: VaultCookies): Promise<OwnerSession | null> {
    const session = this.session;
    if (!session || cookies.session === null || session.memberId !== caller.memberId) return null;
    return Date.parse(session.expiresAt) > this.clock.now().getTime() ? { ...session } : null;
  }

  async verifyStepUp(_caller: VaultCaller, session: OwnerSession, proof: VaultStepUpProof | undefined, binding: StepUpBinding): Promise<StepUpVerified> {
    const hash = stepUpIntentHash(binding.action, vaultStepUpBoundParams(binding.pathParams, binding.body));
    this.bindings.push({ action: binding.action, intentHash: hash, proof });
    if (this.passkeys === 0) throw VaultError.reason('passkey_required');
    if (proof === undefined || this.mode === 'required') throw VaultError.reason('step_up_required');
    if (this.mode === 'invalid') throw VaultError.reason('step_up_invalid');
    return { challengeId: proof.challengeId, passkeyId: session.passkeyId, intentHash: hash, at: this.clock.now().toISOString() };
  }

  async viewer(caller: VaultCaller, cookies: VaultCookies): Promise<{ passkeys: number; recoveryCodesRemaining: number | null; session: OwnerSession | null }> {
    return { passkeys: this.passkeys, recoveryCodesRemaining: this.recoveryCodesRemaining, session: await this.resolveSession(caller, cookies) };
  }
}

/** A proof-shaped value for FakeOwnerAuth. It proves nothing. */
export function fakeStepUpProof(): VaultStepUpProof {
  return {
    challengeId: randomUUID(),
    assertion: {
      id: 'dGVzdC1jcmVkZW50aWFs',
      rawId: 'dGVzdC1jcmVkZW50aWFs',
      type: 'public-key',
      response: { clientDataJSON: 'e30', authenticatorData: 'AAAA', signature: 'AAAA' },
      clientExtensionResults: {},
    },
  };
}

function unexpected(what: string): never {
  throw new Error(`test kit: ${what} was called but the test did not provide one`);
}

/** Every v1 deployment refuses spend. */
export const disabledSpendProcessor: SpendProcessor = Object.freeze({
  kind: 'disabled',
  configured: false,
  charge: async () => unexpected('spend.charge'),
  lookup: async () => unexpected('spend.lookup'),
});

export function testConfig(overrides: Partial<BrokerConfig> = {}): BrokerConfig {
  return {
    mode: 'dev',
    reviewGate: 'open',
    publicOrigin: 'https://tm8.example.test',
    webauthn: { rpId: 'tm8.example.test', rpName: 'tm8 (test)', origins: ['https://tm8.example.test'] },
    features: { capture: true, fill: true, callApi: true, spend: false, import: true, grants: true },
    preReview: { maxItemsPerMember: 20, allowedFillOrigins: [], allowedApiHosts: [] },
    auditSink: 'off',
    ...overrides,
  };
}

/** Real crypto, the real paste detector and an empty canary set; every outbound component throws unless the test supplies one. */
export function testComponents(overrides: Partial<BrokerComponents> = {}): BrokerComponents {
  const fillDriver: FillDriver = { fill: async () => unexpected('fillDriver.fill'), close: async () => undefined };
  const egress: EgressExecutor = { execute: async () => unexpected('egress.execute') };
  const importParser: ImportParser = { parse: () => unexpected('importParser.parse') };
  const canaries: CanarySet = buildCanarySet([]);
  return {
    kms: LocalDevKms.ephemeral(),
    captureKeys: CaptureKeyPair.generate(),
    fillDriver,
    egress,
    canaries,
    pasteDetector: createPasteDetector(),
    importParser,
    spend: disabledSpendProcessor,
    deletionLedger: new MemoryDeletionLedger(),
    alerts: new RecordingAlertSink(),
    ...overrides,
  };
}

export interface TestBroker {
  clock: FixedClock;
  store: MemoryVaultStore;
  auth: FakeOwnerAuth;
  audit: FakeAuditGate;
  config: BrokerConfig;
  components: BrokerComponents;
  /** A HandlerContext for one call. */
  context(op: VaultOperationName, options?: { caller?: VaultCaller; cookies?: Partial<VaultCookies>; stepUp?: StepUpVerified | null; signal?: AbortSignal }): Promise<HandlerContext>;
}

/** One broker's worth of fakes sharing a clock and a store. */
export function testBroker(options: { config?: Partial<BrokerConfig>; components?: Partial<BrokerComponents>; clock?: FixedClock } = {}): TestBroker {
  const clock = options.clock ?? new FixedClock();
  const store = new MemoryVaultStore({ clock });
  const auth = FakeOwnerAuth.signedIn(clock);
  const audit = new FakeAuditGate();
  const config = testConfig(options.config);
  const components = testComponents(options.components);
  return {
    clock, store, auth, audit, config, components,
    async context(op, { caller = testCaller, cookies = {}, stepUp = null, signal } = {}) {
      const jar: VaultCookies = { session: 'test-session-cookie', refresh: null, ...cookies };
      return {
        op,
        requestId: randomUUID(),
        caller,
        actor: actorOf(caller),
        config,
        clock,
        store,
        auth,
        audit,
        components,
        ownerSession: await auth.resolveSession(caller, jar),
        stepUp,
        cookies: jar,
        signal: signal ?? new AbortController().signal,
      };
    },
  };
}
