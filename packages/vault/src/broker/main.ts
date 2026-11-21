import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { disabledSpendProcessor } from '../actions/disabled-spend.js';
import { createAgentActionHandlers } from '../actions/handlers.js';
import { markUnknownOperations, sweepExpiredApprovals } from '../actions/maintenance.js';
import { AuditCheckpointer, FileCheckpointSink, LocalEd25519CheckpointSigner } from '../audit/checkpointer.js';
import { VaultAuditGate } from '../audit/gate.js';
import { DEFAULT_FILL_TIMEOUT_MS } from '../browser/protocol.js';
import { RemoteFillDriver } from '../browser/remote-driver.js';
import { buildCanarySet } from '../canary/index.js';
import { CaptureKeyPair } from '../capture/seal.js';
import {
  VaultError, type BrokerComponents, type BrokerConfig, type CheckpointSigner, type CheckpointSink, type VaultHandlers,
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
 * Composition root of the vault broker process:
 *
 *   node packages/vault/dist/broker/main.js                      serve
 *   node packages/vault/dist/broker/main.js enroll <member> <space> <ttlSeconds>
 *
 * Mode `off` (the default) exits 0 before it opens a database, a KMS, a file or
 * a socket. Every value below is read only here; BROKER_ENV_KNOBS (config.ts)
 * covers the policy knobs. No startup error prints an environment value.
 */
export const BROKER_RUNTIME_ENV_KNOBS = [
  { name: 'TM8_VAULT_DATABASE_URL', default: '', meaning: 'Postgres URL of a LOGIN role whose only membership is tm8_vault_broker; no inline password (use PGPASSFILE); required unless mode is off' },
  { name: 'TM8_VAULT_BROKER_SOCKET', default: '/run/tm8-vault/broker.sock', meaning: 'Unix socket in an owner-only (0700) directory' },
  { name: 'TM8_VAULT_RELAY_PUBLIC_KEY_FILE', default: '', meaning: 'Ed25519 public key (PEM) that verifies relay attestations; required unless mode is off' },
  { name: 'TM8_VAULT_BROKER_MTLS_LISTEN', default: '', meaning: 'host:port of the mTLS listener for a relay on another host; required in production' },
  { name: 'TM8_VAULT_BROKER_TLS_KEY_FILE', default: '', meaning: 'mTLS listener private key (PEM)' },
  { name: 'TM8_VAULT_BROKER_TLS_CERT_FILE', default: '', meaning: 'mTLS listener certificate (PEM)' },
  { name: 'TM8_VAULT_BROKER_TLS_CA_FILE', default: '', meaning: 'CA (PEM) that issues the relay client certificate' },
  { name: 'TM8_VAULT_FILL_SOCKET', default: '/run/tm8-vault-fill/fill.sock', meaning: 'Fill worker socket; the worker reads the same knob' },
  { name: 'TM8_VAULT_FILL_TIMEOUT_MS', default: String(DEFAULT_FILL_TIMEOUT_MS), meaning: 'Fill timeout 100..120000; the worker reads the same knob' },
  { name: 'TM8_VAULT_LOCAL_KEK_FILE', default: '', meaning: 'local-dev KEK file, created 0600 when absent; dev and pre_review only' },
  { name: 'TM8_VAULT_GCP_KMS_KEY', default: '', meaning: 'Cloud KMS cryptoKey resource name when TM8_VAULT_KMS_KIND=gcp-kms' },
  { name: 'TM8_VAULT_CHECKPOINT_KEY_FILE', default: '', meaning: 'Ed25519 PKCS#8 key (0600) for local checkpoint signatures; dev and pre_review only' },
  { name: 'TM8_VAULT_GCP_CHECKPOINT_KEY_VERSION', default: '', meaning: 'Cloud KMS asymmetric-sign cryptoKeyVersion for checkpoint signatures' },
  { name: 'TM8_VAULT_CHECKPOINT_DIR', default: '', meaning: 'Checkpoint directory when TM8_VAULT_AUDIT_SINK=file' },
  { name: 'TM8_VAULT_GCS_BUCKET', default: '', meaning: 'Checkpoint bucket when TM8_VAULT_AUDIT_SINK=gcs; tm8 never sets, holds or locks its retention' },
  { name: 'TM8_VAULT_CHECKPOINT_INTERVAL_MS', default: '300000', meaning: 'Checkpoint period, 10000..86400000' },
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

async function buildCheckpointer(env: Env, config: BrokerConfig, store: PgVaultStore,
  gcp: () => Required<Pick<GcpEndpoints, 'tokens'>> & GcpEndpoints): Promise<AuditCheckpointer | null> {
  if (config.auditSink === 'off') {
    if (config.mode === 'production') throw new BrokerConfigError('TM8_VAULT_AUDIT_SINK');
    return null;
  }
  let signer: CheckpointSigner;
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
  let healthy = false;
  try { healthy = (await sink.health()).ok; } catch { healthy = false; }
  if (!healthy) throw VaultError.reason('audit_unavailable');
  return new AuditCheckpointer({ store, signer, sink });
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
  const socketPath = path(env, 'TM8_VAULT_BROKER_SOCKET', '/run/tm8-vault/broker.sock', 100);
  const relayPublicKeyFile = path(env, 'TM8_VAULT_RELAY_PUBLIC_KEY_FILE');
  const ledgerFile = ledgerPath(env);
  const fillSocket = path(env, 'TM8_VAULT_FILL_SOCKET', '/run/tm8-vault-fill/fill.sock', 100);
  const fillTimeoutMs = integer(env, 'TM8_VAULT_FILL_TIMEOUT_MS', DEFAULT_FILL_TIMEOUT_MS, 100, 120_000);
  const intervalMs = integer(env, 'TM8_VAULT_CHECKPOINT_INTERVAL_MS', 300_000, 10_000, 86_400_000);
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
    const checkpointer = await buildCheckpointer(env, config, store, gcp);
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
    const audit = new VaultAuditGate({ store });
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
    });
    let running: Promise<unknown> | null = null;
    const checkpoint = (): Promise<unknown> => {
      if (!checkpointer || running) return running ?? Promise.resolve();
      running = checkpointer.checkpointIfAdvanced()
        .catch(() => log({ event: 'vault_checkpoint_failed' }))
        .finally(() => { running = null; });
      return running;
    };
    // After startBroker: the chain has been verified, so only a verified head is anchored.
    await checkpoint();
    const timer = checkpointer ? setInterval(() => { void checkpoint(); }, intervalMs) : null;
    timer?.unref();
    let closing: Promise<void> | null = null;
    return {
      server, config, alerts, checkpointer, databaseRole,
      close() {
        closing ??= (async () => {
          if (timer) clearInterval(timer);
          try { await server.close(); }
          finally {
            await running?.catch(() => undefined);
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

export function failureMessage(error: unknown): string {
  if (error instanceof BrokerConfigError) return error.message;
  if (error instanceof VaultError) return `vault broker: refused (${error.reason ?? error.code})`;
  return 'vault broker: start failed';
}

async function main(argv: readonly string[]): Promise<void> {
  process.umask(0o077);
  if (argv[0] === 'enroll') { await enroll(process.env, argv.slice(1)); return; }
  if (argv.length > 0) throw new BrokerConfigError('arguments');
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
