import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { disabledSpendProcessor } from '../actions/disabled-spend.js';
import { createAgentActionHandlers } from '../actions/handlers.js';
import { markUnknownOperations, sweepExpiredApprovals } from '../actions/maintenance.js';
import { AuditCheckpointer, FileCheckpointSink, LocalEd25519CheckpointSigner } from '../audit/checkpointer.js';
import { VaultAuditGate, type AuditAnchorFailure } from '../audit/gate.js';
import { DEFAULT_FILL_TIMEOUT_MS } from '../browser/protocol.js';
import { RemoteFillDriver } from '../browser/remote-driver.js';
import { buildCanarySet } from '../canary/index.js';
import { CaptureKeyPair } from '../capture/seal.js';
import {
  VaultError, type AuditGate, type BrokerComponents, type BrokerConfig, type CheckpointSigner, type CheckpointSink, type CheckpointVerifier,
  type VaultHandlers,
} from '../core-types.js';
import { LocalDevKms, type KmsProvider } from '../crypto/kms.js';
import { createEgressExecutor } from '../egress/index.js';
import { GcsCheckpointSink } from '../gcp/gcs.js';
import { GcpKmsProvider, requireKeyName } from '../gcp/kms.js';
import { KmsCheckpointSigner } from '../gcp/signer.js';
import { MetadataTokenSource, type TokenSource } from '../gcp/token.js';
import { createImportParser } from '../import/index.js';
import { createOwnerAuth } from '../owner-auth/auth.js';
import { runEnrollmentCli } from '../owner-auth/enroll-cli.js';
import { createOwnerAuthHandlers } from '../owner-auth/handlers.js';
import { createPasteDetector, tokenSpanScanner } from '../paste/index.js';
import { FileDeletionLedger, replayDeletionLedger } from '../store/deletion-ledger.js';
import { PgVaultStore } from '../store/postgres.js';
import type { VaultMode } from '../types.js';
import { RelayAlertQueue } from './alerts.js';
import { BrokerConfigError, loadBrokerConfig } from './config.js';
import { createBrokerCoreHandlers } from './handlers/index.js';
import type { BrokerServer } from './server.js';
import { startBroker } from './start.js';

/**
 * Composition root of the vault broker process. With no argument it serves;
 * its only subcommand is enroll. Any other argument, `serve` included, is
 * refused (brokerCommand):
 *
 *   node packages/vault/dist/broker/main.js
 *   node packages/vault/dist/broker/main.js enroll <member> <space> <ttlSeconds>
 *
 * Mode `off` (the default) exits 0 before it opens a database, a KMS, a file or
 * a socket. Every value below is read only here; BROKER_ENV_KNOBS (config.ts)
 * covers the policy knobs. No startup error prints an environment value.
 */
/**
 * The broker's own socket. Its directory must be 0700 and the broker's own
 * (listen() refuses anything else), so it is never /run/tm8-vault: the fill
 * worker's tmpfiles.conf makes that one group-shared (2770) with the worker.
 * Under systemd, `RuntimeDirectory=tm8-vault-broker` with mode 0700 creates it.
 */
export const DEFAULT_BROKER_SOCKET = '/run/tm8-vault-broker/broker.sock';
/** The fill worker's socket: the path its unit (deploy/vault/fill-worker) listens on. */
export const DEFAULT_FILL_SOCKET = '/run/tm8-vault/fill.sock';

export const BROKER_RUNTIME_ENV_KNOBS = [
  { name: 'TM8_VAULT_DATABASE_URL', default: '', meaning: 'Postgres URL of a LOGIN role whose only membership is tm8_vault_broker; no inline password (use PGPASSFILE); required unless mode is off' },
  { name: 'TM8_VAULT_BROKER_SOCKET', default: DEFAULT_BROKER_SOCKET, meaning: 'Unix socket in an owner-only (0700) directory' },
  { name: 'TM8_VAULT_RELAY_PUBLIC_KEY_FILE', default: '', meaning: 'Ed25519 public key (PEM) that verifies relay attestations; required unless mode is off' },
  { name: 'TM8_VAULT_BROKER_MTLS_LISTEN', default: '', meaning: 'host:port of the mTLS listener for a relay on another host; required in production' },
  { name: 'TM8_VAULT_BROKER_TLS_KEY_FILE', default: '', meaning: 'mTLS listener private key (PEM)' },
  { name: 'TM8_VAULT_BROKER_TLS_CERT_FILE', default: '', meaning: 'mTLS listener certificate (PEM)' },
  { name: 'TM8_VAULT_BROKER_TLS_CA_FILE', default: '', meaning: 'CA (PEM) that issues the relay client certificate' },
  { name: 'TM8_VAULT_FILL_SOCKET', default: DEFAULT_FILL_SOCKET, meaning: 'Fill worker socket; the worker reads the same knob' },
  { name: 'TM8_VAULT_FILL_TIMEOUT_MS', default: String(DEFAULT_FILL_TIMEOUT_MS), meaning: 'Fill timeout 100..120000; the worker reads the same knob' },
  { name: 'TM8_VAULT_LOCAL_KEK_FILE', default: '', meaning: 'local-dev KEK file, created 0600 when absent; dev and pre_review only' },
  { name: 'TM8_VAULT_GCP_KMS_KEY', default: '', meaning: 'Cloud KMS cryptoKey resource name when TM8_VAULT_KMS_KIND=gcp-kms' },
  { name: 'TM8_VAULT_CHECKPOINT_KEY_FILE', default: '', meaning: 'Ed25519 PKCS#8 key (0600) for local checkpoint signatures; dev and pre_review only' },
  { name: 'TM8_VAULT_GCP_CHECKPOINT_KEY_VERSION', default: '', meaning: 'Cloud KMS asymmetric-sign cryptoKeyVersion for checkpoint signatures' },
  { name: 'TM8_VAULT_CHECKPOINT_DIR', default: '', meaning: 'Checkpoint directory when TM8_VAULT_AUDIT_SINK=file' },
  { name: 'TM8_VAULT_GCS_BUCKET', default: '', meaning: 'Checkpoint bucket when TM8_VAULT_AUDIT_SINK=gcs; tm8 never sets, holds or locks its retention' },
  { name: 'TM8_VAULT_CHECKPOINT_INTERVAL_MS', default: '300000', meaning: 'Checkpoint period, 10000..86400000; each period also verifies the chain from its last verified seq against the retained anchor' },
  { name: 'TM8_VAULT_AUDIT_VERIFY_INTERVAL_MS', default: '3600000', meaning: 'Full audit chain verification period (every event from seq 1, against the retained anchor), 60000..86400000' },
  { name: 'TM8_VAULT_AUDIT_ANCHOR_BUDGET_MS', default: '900000', meaning: 'Longest an audit event may stay unanchored, or the retained anchor go unverified, before audited actions fail closed; 20000..172800000 and at least twice the checkpoint period' },
  { name: 'TM8_VAULT_DELETION_LEDGER', default: '', meaning: 'Append-only tombstone ledger file outside the database; required unless mode is off' },
  { name: 'TM8_VAULT_CANARY_FILE', default: '', meaning: 'Optional operator decoy values (0600), one per line, 12+ characters each' },
] as const;

type Env = Readonly<Record<string, string | undefined>>;

/** Loopback endpoints for tests. Production passes nothing and reaches Google's fixed hosts. */
export interface GcpEndpoints { tokens?: TokenSource; kmsBaseUrl?: string; gcsBaseUrl?: string }

export interface ComposedBroker {
  readonly server: BrokerServer;
  readonly config: BrokerConfig;
  readonly alerts: RelayAlertQueue;
  readonly checkpointer: AuditCheckpointer | null;
  readonly databaseRole: DatabaseRoleReport;
  close(): Promise<void>;
}

export interface DatabaseRoleReport {
  /** True when the login role is not a superuser, has no BYPASSRLS, CREATEROLE or CREATEDB, and belongs to tm8_vault_broker only. */
  dedicated: boolean;
}

const optional = (env: Env, knob: string): string | null => {
  const value = env[knob];
  return value === undefined || value === '' ? null : value;
};
const required = (env: Env, knob: string): string => optional(env, knob) ?? (() => { throw new BrokerConfigError(knob); })();

function path(env: Env, knob: string, fallback?: string, max = 4096): string {
  const value = optional(env, knob) ?? fallback ?? null;
  if (value === null || !value.startsWith('/') || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw new BrokerConfigError(knob);
  return value;
}

function integer(env: Env, knob: string, fallback: number, min: number, max: number): number {
  const value = optional(env, knob) ?? String(fallback);
  if (!/^[0-9]{1,9}$/.test(value) || Number(value) < min || Number(value) > max) throw new BrokerConfigError(knob);
  return Number(value);
}

function listenAddress(value: string): { host: string; port: number } {
  const match = /^(\[[0-9A-Fa-f:.]{2,45}\]|[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?):([0-9]{1,5})$/.exec(value);
  const port = Number(match?.[2]);
  if (!match || port < 1 || port > 65535) throw new BrokerConfigError('TM8_VAULT_BROKER_MTLS_LISTEN');
  return { host: match[1]!.replace(/^\[|\]$/g, ''), port };
}

function mtlsOptions(env: Env, mode: VaultMode) {
  const files = ['TM8_VAULT_BROKER_TLS_KEY_FILE', 'TM8_VAULT_BROKER_TLS_CERT_FILE', 'TM8_VAULT_BROKER_TLS_CA_FILE'] as const;
  const listen = optional(env, 'TM8_VAULT_BROKER_MTLS_LISTEN');
  if (listen === null) {
    for (const knob of files) if (optional(env, knob) !== null) throw new BrokerConfigError(knob);
    // Topology A: in production the relay is on another host and reaches the broker only over mTLS.
    if (mode === 'production') throw new BrokerConfigError('TM8_VAULT_BROKER_MTLS_LISTEN');
    return undefined;
  }
  return { ...listenAddress(listen), keyFile: path(env, files[0]), certFile: path(env, files[1]), caFile: path(env, files[2]) };
}

function databaseUrl(env: Env): string {
  const value = required(env, 'TM8_VAULT_DATABASE_URL');
  try {
    const url = new URL(value);
    // A password reaches the driver from PGPASSFILE only, so no URL form can carry one into a log or a dump.
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.password !== '' || url.searchParams.has('password')) throw new Error();
  } catch { throw new BrokerConfigError('TM8_VAULT_DATABASE_URL'); }
  return value;
}

/** Decoys planted by the operator elsewhere. The file is refused unless it is a private regular file. */
function readCanaries(env: Env): string[] {
  const file = optional(env, 'TM8_VAULT_CANARY_FILE');
  if (file === null) return [];
  path(env, 'TM8_VAULT_CANARY_FILE');
  let fd: number | undefined;
  let bytes: Buffer | undefined;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 64 * 1024) throw new Error();
    bytes = readFileSync(fd);
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).split('\n').map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#'));
  } catch { throw new BrokerConfigError('TM8_VAULT_CANARY_FILE'); }
  finally {
    bytes?.fill(0);
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * A missing ledger reads as empty (a fresh install), so a wrong path would only
 * surface at the first deletion. Its directory must exist, and no other user may
 * write to it.
 */
function ledgerPath(env: Env): string {
  const file = path(env, 'TM8_VAULT_DELETION_LEDGER');
  try {
    const stat = lstatSync(dirname(file));
    if (!stat.isDirectory() || (stat.mode & 0o022) !== 0) throw new Error();
  } catch { throw new BrokerConfigError('TM8_VAULT_DELETION_LEDGER'); }
  return file;
}

function canarySet(env: Env) {
  const values = readCanaries(env);
  try { return buildCanarySet(values); } catch { throw new BrokerConfigError('TM8_VAULT_CANARY_FILE'); }
  finally { values.fill(''); }
}

/**
 * Refused before any KMS, database or network call; the components check the same
 * things again. The review gate is the independent security review (brief MSG 15):
 * no flag-on production broker exists until an operator records it as passed.
 */
function productionPrerequisites(env: Env): void {
  if (env.TM8_VAULT_REVIEW_GATE !== 'passed') throw new BrokerConfigError('TM8_VAULT_REVIEW_GATE');
  if ((env.TM8_VAULT_KMS_KIND ?? 'local-dev') !== 'gcp-kms') throw new BrokerConfigError('TM8_VAULT_KMS_KIND');
  if ((env.TM8_VAULT_AUDIT_SINK ?? 'off') === 'off') throw new BrokerConfigError('TM8_VAULT_AUDIT_SINK');
  if (optional(env, 'TM8_VAULT_GCP_CHECKPOINT_KEY_VERSION') === null) throw new BrokerConfigError('TM8_VAULT_GCP_CHECKPOINT_KEY_VERSION');
  if (optional(env, 'TM8_VAULT_LOCAL_KEK_FILE') !== null) throw new BrokerConfigError('TM8_VAULT_LOCAL_KEK_FILE');
  if (optional(env, 'TM8_VAULT_CHECKPOINT_KEY_FILE') !== null) throw new BrokerConfigError('TM8_VAULT_CHECKPOINT_KEY_FILE');
}

async function buildKms(env: Env, mode: VaultMode, gcp: () => Required<Pick<GcpEndpoints, 'tokens'>> & GcpEndpoints): Promise<KmsProvider> {
  const kind = env.TM8_VAULT_KMS_KIND ?? 'local-dev';
  if (kind === 'local-dev') {
    // Checked before fromFile, which creates a missing KEK file.
    if (mode !== 'dev' && mode !== 'pre_review') throw new BrokerConfigError('TM8_VAULT_KMS_KIND');
    const file = path(env, 'TM8_VAULT_LOCAL_KEK_FILE');
    try { return LocalDevKms.fromFile(file); } catch { throw new BrokerConfigError('TM8_VAULT_LOCAL_KEK_FILE'); }
  }
  if (kind === 'gcp-kms') {
    const keyName = required(env, 'TM8_VAULT_GCP_KMS_KEY');
    try { requireKeyName(keyName); } catch { throw new BrokerConfigError('TM8_VAULT_GCP_KMS_KEY'); }
    const endpoints = gcp();
    try {
      return await GcpKmsProvider.connect({ keyName, tokens: endpoints.tokens,
        ...(endpoints.kmsBaseUrl === undefined ? {} : { kmsBaseUrl: endpoints.kmsBaseUrl }) });
    } catch { throw VaultError.reason('kms_unavailable'); }
  }
  // vault-transit has no adapter in v1; test-fake exists only inside the test harness.
  throw new BrokerConfigError('TM8_VAULT_KMS_KIND');
}

/** The checkpointer and what the audit gate reads its anchor back with (review F01). */
interface AuditAnchorParts { checkpointer: AuditCheckpointer; sink: CheckpointSink; verifier: CheckpointVerifier }

async function buildCheckpointer(env: Env, config: BrokerConfig, store: PgVaultStore,
  gcp: () => Required<Pick<GcpEndpoints, 'tokens'>> & GcpEndpoints, log: (record: Record<string, unknown>) => void): Promise<AuditAnchorParts | null> {
  if (config.auditSink === 'off') {
    if (config.mode === 'production') throw new BrokerConfigError('TM8_VAULT_AUDIT_SINK');
    return null;
  }
  let signer: CheckpointSigner & CheckpointVerifier;
  const keyVersion = optional(env, 'TM8_VAULT_GCP_CHECKPOINT_KEY_VERSION');
  if (keyVersion === null && config.mode === 'production') throw new BrokerConfigError('TM8_VAULT_GCP_CHECKPOINT_KEY_VERSION');
  if (keyVersion !== null) {
    try { requireKeyName(keyVersion, true); } catch { throw new BrokerConfigError('TM8_VAULT_GCP_CHECKPOINT_KEY_VERSION'); }
    const endpoints = gcp();
    try {
      signer = await KmsCheckpointSigner.connect({ keyVersionName: keyVersion, tokens: endpoints.tokens,
        ...(endpoints.kmsBaseUrl === undefined ? {} : { kmsBaseUrl: endpoints.kmsBaseUrl }) });
    } catch { throw VaultError.reason('audit_unavailable'); }
  } else {
    const keyFile = path(env, 'TM8_VAULT_CHECKPOINT_KEY_FILE');
    // The local signer refuses production itself.
    try { signer = new LocalEd25519CheckpointSigner({ name: 'broker', keyFile, mode: config.mode }); }
    catch { throw new BrokerConfigError('TM8_VAULT_CHECKPOINT_KEY_FILE'); }
  }
  let sink: CheckpointSink;
  if (config.auditSink === 'file') sink = new FileCheckpointSink(path(env, 'TM8_VAULT_CHECKPOINT_DIR'));
  else {
    const bucket = required(env, 'TM8_VAULT_GCS_BUCKET');
    const endpoints = gcp();
    // The sink only writes create-only objects; no retention, hold or lock call exists in src (test/gcp/no-retention-writes).
    try { sink = new GcsCheckpointSink({ bucket, tokens: endpoints.tokens, ...(endpoints.gcsBaseUrl === undefined ? {} : { gcsBaseUrl: endpoints.gcsBaseUrl }) }); }
    catch { throw new BrokerConfigError('TM8_VAULT_GCS_BUCKET'); }
  }
  let health: Awaited<ReturnType<CheckpointSink['health']>>;
  try { health = await sink.health(); } catch { health = { ok: false, retention: 'unknown' }; }
  log({ event: 'vault_checkpoint_sink', sink: sink.kind, ok: health.ok, retention: health.retention });
  if (!health.ok) throw VaultError.reason('audit_unavailable');
  // Review F01: a production anchor must outlive a compromised broker, so the bucket must already carry a
  // retention policy. tm8 only reads it; setting or locking one is the bucket owner's decision.
  if (config.mode === 'production' && sink.kind === 'gcs' && health.retention !== 'locked' && health.retention !== 'unlocked') {
    throw VaultError.reason('audit_unavailable');
  }
  return { checkpointer: new AuditCheckpointer({ store, signer, sink }), sink, verifier: signer };
}

/**
 * The HIGH review finding: a superuser or BYPASSRLS login ignores vault RLS, so
 * production refuses anything but a dedicated role (topology A). Earlier modes
 * hold test secrets only and are reported, not refused.
 */
async function inspectDatabaseRole(connectionString: string, mode: VaultMode): Promise<DatabaseRoleReport> {
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 10_000, query_timeout: 10_000 });
  client.on('error', () => undefined);
  let dedicated = false;
  try {
    await client.connect();
    const row = (await client.query(`select r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb,
        (select count(*) from pg_auth_members m join pg_roles g on g.oid = m.roleid
          where m.member = r.oid and g.rolname <> 'tm8_vault_broker')::int as others,
        exists (select 1 from pg_auth_members m join pg_roles g on g.oid = m.roleid
          where m.member = r.oid and g.rolname = 'tm8_vault_broker') as broker
      from pg_roles r where r.rolname = session_user`)).rows[0] as
      { rolsuper: boolean; rolbypassrls: boolean; rolcreaterole: boolean; rolcreatedb: boolean; others: number; broker: boolean } | undefined;
    dedicated = row !== undefined && !row.rolsuper && !row.rolbypassrls && !row.rolcreaterole && !row.rolcreatedb
      && row.others === 0 && row.broker;
  } catch { throw VaultError.reason('vault_unavailable'); }
  finally { await client.end().catch(() => undefined); }
  if (mode === 'production' && !dedicated) throw new BrokerConfigError('TM8_VAULT_DATABASE_URL');
  return { dedicated };
}

/** Exactly the catalog: OP_PARTITION_IS_EXACT (core-types.ts) proves the three groups at compile time. */
export function createVaultHandlers(): VaultHandlers {
  return { ...createOwnerAuthHandlers(), ...createBrokerCoreHandlers(), ...createAgentActionHandlers() };
}

function logLine(record: Record<string, unknown>): void {
  try { process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`); }
  catch { /* A log failure cannot change an outcome. */ }
}

/** Starts the broker, or returns null in mode `off` without touching anything. */
export async function composeBroker(env: Env, options: { gcp?: GcpEndpoints; log?: (record: Record<string, unknown>) => void } = {}): Promise<ComposedBroker | null> {
  const mode = env.TM8_VAULT_MODE ?? 'off';
  if (mode === 'off') return null;
  if (!['dev', 'pre_review', 'production'].includes(mode)) throw new BrokerConfigError('TM8_VAULT_MODE');
  if (mode === 'production') productionPrerequisites(env);
  const log = options.log ?? logLine;
  const connectionString = databaseUrl(env);
  const socketPath = path(env, 'TM8_VAULT_BROKER_SOCKET', DEFAULT_BROKER_SOCKET, 100);
  const relayPublicKeyFile = path(env, 'TM8_VAULT_RELAY_PUBLIC_KEY_FILE');
  const ledgerFile = ledgerPath(env);
  const fillSocket = path(env, 'TM8_VAULT_FILL_SOCKET', DEFAULT_FILL_SOCKET, 100);
  const fillTimeoutMs = integer(env, 'TM8_VAULT_FILL_TIMEOUT_MS', DEFAULT_FILL_TIMEOUT_MS, 100, 120_000);
  const intervalMs = integer(env, 'TM8_VAULT_CHECKPOINT_INTERVAL_MS', 300_000, 10_000, 86_400_000);
  const verifyIntervalMs = integer(env, 'TM8_VAULT_AUDIT_VERIFY_INTERVAL_MS', 3_600_000, 60_000, 86_400_000);
  const anchorBudgetMs = integer(env, 'TM8_VAULT_AUDIT_ANCHOR_BUDGET_MS', 900_000, 20_000, 172_800_000);
  // One missed checkpoint must not fail the broker closed; a stopped checkpointer must.
  if (anchorBudgetMs < 2 * intervalMs) throw new BrokerConfigError('TM8_VAULT_AUDIT_ANCHOR_BUDGET_MS');
  const mtls = mtlsOptions(env, mode as VaultMode);
  const canaries = canarySet(env);
  let tokens: TokenSource | undefined = options.gcp?.tokens;
  const gcp = () => ({ ...options.gcp, tokens: tokens ??= new MetadataTokenSource() });

  // The first step with an effect: a local-dev KMS creates its KEK file, gcp-kms reads the key.
  const kms = await buildKms(env, mode as VaultMode, gcp);
  const config = loadBrokerConfig(env, kms);
  const databaseRole = await inspectDatabaseRole(connectionString, config.mode);
  if (!databaseRole.dedicated) log({ event: 'vault_broker_database_role_not_dedicated', mode: config.mode });

  const store = new PgVaultStore({ connectionString, role: 'tm8_vault_broker' });
  let fillDriver: RemoteFillDriver | undefined;
  try {
    const anchorParts = await buildCheckpointer(env, config, store, gcp, log);
    const checkpointer = anchorParts?.checkpointer ?? null;
    const pasteDetector = createPasteDetector();
    const alerts = new RelayAlertQueue({ canaries });
    fillDriver = new RemoteFillDriver(fillSocket, { timeoutMs: fillTimeoutMs + 5_000 });
    const components: BrokerComponents = {
      kms,
      captureKeys: CaptureKeyPair.generate(),
      fillDriver,
      egress: createEgressExecutor({ scanTokens: tokenSpanScanner(pasteDetector) }),
      canaries,
      pasteDetector,
      importParser: createImportParser(),
      spend: disabledSpendProcessor,
      deletionLedger: new FileDeletionLedger(ledgerFile),
      alerts,
    };
    // Review F01: with a sink, every verification reads the newest signed checkpoint back from the sink itself.
    const audit = new VaultAuditGate({ store, ...(anchorParts ? { anchor: {
      sink: anchorParts.sink, verifier: anchorParts.verifier, budgetMs: anchorBudgetMs,
      onFailure: (reason: AuditAnchorFailure) => log({ event: 'vault_audit_anchor_failed', reason }),
    } } : {}) });
    const checkpoint = async (): Promise<void> => {
      if (!checkpointer) return;
      try { await checkpointer.checkpointIfAdvanced(); } catch { log({ event: 'vault_checkpoint_failed' }); }
    };
    const maintenance = auditMaintenance({ audit, checkpoint, verifyIntervalMs, log });
    const server = await startBroker({
      config, store, audit, components, handlers: createVaultHandlers(),
      auth: createOwnerAuth({ store, config }),
      socketPath, relayPublicKeyFile, ...(mtls ? { mtls } : {}), alertOutbox: alerts,
      // Longer than the slowest handler (a fill), shorter than the relay's upstream timeout.
      requestTimeoutMs: fillTimeoutMs + 60_000,
      log: (record) => log({ event: 'vault_broker_request', ...record }),
      beforeServe: [
        // Tombstones first: a restored backup must never serve a deleted item.
        async () => { await replayDeletionLedger(store, components.deletionLedger); },
        async () => { await markUnknownOperations(store); },
        async () => { await sweepExpiredApprovals(store); },
      ],
      // Only a verified head is anchored, and startBroker verifies again, anchor included, before it binds.
      afterVerify: checkpointer ? [checkpoint] : [],
    });
    const timer = setInterval(() => { void maintenance.tick(); }, intervalMs);
    timer.unref();
    let closing: Promise<void> | null = null;
    return {
      server, config, alerts, checkpointer, databaseRole,
      close() {
        closing ??= (async () => {
          clearInterval(timer);
          try { await server.close(); }
          finally {
            await maintenance.idle();
            await fillDriver?.close().catch(() => undefined);
            await store.close();
          }
        })();
        return closing;
      },
    };
  } catch (error) {
    await fillDriver?.close().catch(() => undefined);
    await store.close().catch(() => undefined);
    throw error;
  }
}

/** Operator-only: the enrollment code is the root of trust for a member's first passkey. */
export async function enroll(env: Env, args: readonly string[], stdout: Pick<NodeJS.WriteStream, 'write'> = process.stdout): Promise<void> {
  const mode = env.TM8_VAULT_MODE ?? 'off';
  if (!['dev', 'pre_review', 'production'].includes(mode)) throw new BrokerConfigError('TM8_VAULT_MODE');
  const store = new PgVaultStore({ connectionString: databaseUrl(env), role: 'tm8_vault_broker' });
  try { await runEnrollmentCli(store, args, stdout); }
  finally { await store.close(); }
}

/**
 * Review F01: the broker's periodic audit work. Each tick anchors a new head, then verifies the chain against the
 * retained anchor: incrementally from the last verified seq, or, once `verifyIntervalMs` has passed since the last
 * full walk was due, every event from seq 1, which also finds an old row edited in place. A full walk that cannot
 * finish is logged and comes round again a period later; incremental verification still runs every tick. Overlapping
 * ticks share one run. A failure trips the gate itself; this only logs it.
 */
export function auditMaintenance(options: {
  audit: Pick<AuditGate, 'verifyIncremental' | 'verifyAll'>;
  checkpoint: () => Promise<void>;
  verifyIntervalMs: number;
  log: (record: Record<string, unknown>) => void;
  now?: () => number;
}): { tick(): Promise<void>; idle(): Promise<void> } {
  const now = options.now ?? Date.now;
  // A tick runs from a timer, so nothing in it may reject: a log failure cannot change an outcome either.
  const log = (record: Record<string, unknown>): void => { try { options.log(record); } catch { /* ignored */ } };
  let running: Promise<void> | null = null;
  let fullDueAt = now() + options.verifyIntervalMs;
  const tick = (): Promise<void> => running ??= (async () => {
    try { await options.checkpoint(); } catch { log({ event: 'vault_checkpoint_failed' }); }
    const full = now() >= fullDueAt;
    if (full) fullDueAt = now() + options.verifyIntervalMs;
    let status: string;
    try { status = (full ? await options.audit.verifyAll() : await options.audit.verifyIncremental()).status; }
    catch { status = 'unverified'; }
    if (status !== 'verified') log({ event: 'vault_audit_verification_failed', status, full });
  })().finally(() => { running = null; });
  return { tick, idle: async () => { await running?.catch(() => undefined); } };
}

export function failureMessage(error: unknown): string {
  if (error instanceof BrokerConfigError) return error.message;
  if (error instanceof VaultError) return `vault broker: refused (${error.reason ?? error.code})`;
  return 'vault broker: start failed';
}

/** What the process was asked to do: serve with no argument, or enroll. Anything else is refused before any I/O. */
export function brokerCommand(argv: readonly string[]): { command: 'serve' } | { command: 'enroll'; args: readonly string[] } {
  if (argv[0] === 'enroll') return { command: 'enroll', args: argv.slice(1) };
  if (argv.length > 0) throw new BrokerConfigError('arguments');
  return { command: 'serve' };
}

async function main(argv: readonly string[]): Promise<void> {
  process.umask(0o077);
  const command = brokerCommand(argv);
  if (command.command === 'enroll') { await enroll(process.env, command.args); return; }
  const broker = await composeBroker(process.env);
  if (!broker) { logLine({ event: 'vault_broker_off' }); return; }
  logLine({ event: 'vault_broker_listening', mode: broker.config.mode, mtls: broker.server.https !== null,
    auditSink: broker.config.auditSink, databaseRoleDedicated: broker.databaseRole.dedicated });
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void broker.close().then(() => { process.exitCode = 0; }, () => { process.exitCode = 1; });
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    // Fixed vocabulary only: never a driver, file system, KMS or network message.
    process.stderr.write(`${failureMessage(error)}\n`);
    process.exitCode = 1;
  });
}
