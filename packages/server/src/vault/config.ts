/**
 * The vault relay's configuration, read once at boot (Secure Vault brief v2;
 * task 01a1fa87-dd1a, WS-A).
 *
 * OFF IS THE DEFAULT, and off reads nothing else: no key file is opened, no
 * broker is contacted, and every /v2/vault request answers 503 vault_disabled.
 * Any other mode refuses to start on the first missing or unsafe input. There
 * is no fallback key, socket or URL (security standard RULE 1).
 *
 * TOPOLOGY. The broker is a separate process (packages/vault, broker/main.ts).
 * The relay reaches it over the broker's owner-only Unix socket
 * (TM8_VAULT_BROKER_SOCKET, dev and pre_review only) or over mutual TLS
 * (TM8_VAULT_BROKER_URL plus the three TLS files, required in production, as
 * the broker requires TM8_VAULT_BROKER_MTLS_LISTEN there).
 *
 * THE SIGNING KEY. TM8_VAULT_RELAY_PRIVATE_KEY_FILE holds the PKCS#8 Ed25519
 * key the relay signs each forwarded request with; the broker holds only the
 * public half. The file must be a regular file owned by this process's user
 * and unreadable by group and others. That stops other local users, but not
 * a process running as the same user.
 *
 * PRODUCTION IS REFUSED (review F03). This server starts agent sessions,
 * terminals and tools as its own user (packages/execution: no spawn sets
 * another uid), so they can read the relay's signing key, its TLS key and
 * this process. A key they can read lets an agent sign as any member. So
 * production refuses here, before any key file is opened, and only a change
 * to this code lifts it: once agents run outside the relay's reach and the
 * staging forgery test has passed (deploy/vault/README.md, "Relay key
 * isolation"). dev and
 * pre_review hold synthetic test secrets only.
 *
 * THE AGENT BOUNDARY (review F03, design doc 01a1fe13 section 4, D5).
 * TM8_VAULT_AGENT_RUN_AS names where agent sessions run: one uid, a uid range,
 * or gVisor sandboxes mapped onto a uid range (boundary.ts; owner decision D2
 * picks the variant). Production requires it, and refuses a value that
 * includes this server's own uid. In any mode, when it is set, the relay
 * checks the host before it opens a key file (R1 to R6) and its TLS material
 * once read (R8), and refuses on any failure, listing them all. Without it,
 * dev and pre_review check nothing more than before. Order: the knob, every
 * file's metadata (stat, no read), R1 to R6, the production refusal, the
 * reads, R7, R8. A pass is not the boundary: the spawner does not read the
 * knob yet, and only the staging probe shows where agents really run.
 *
 * RETIRED KEYS (review F03, check R7). Every key a pre_review relay held is
 * treated as exposed. TM8_VAULT_RETIRED_KEY_SHA256 lists their fingerprints
 * (@tm8/vault/relay, retired-keys.ts), and the relay refuses to load a signing
 * key or a TLS client key that is on it. The broker refuses the same list (B2).
 * A malformed list refuses in every mode, so a typo never drops an entry unseen.
 */
import { readFileSync, statSync } from 'node:fs';
import { createPrivateKey, type KeyObject } from 'node:crypto';
import { isAbsolute } from 'node:path';

import { MAX_RETIRED_KEYS, loadAttestationPrivateKey, parseRetiredKeys, publicKeySha256 } from '@tm8/vault/relay';

import {
  AGENT_RUN_AS_KNOB, checkRelayBoundary, checkRelayTlsMaterial, parseAgentRunAs, systemHostView,
  type BoundaryFailure, type VaultHostView,
} from './boundary.js';

export const VAULT_RELAY_MODES = ['off', 'dev', 'pre_review', 'production'] as const;
export type VaultRelayMode = (typeof VAULT_RELAY_MODES)[number];

/**
 * The broker's own request budget is its fill timeout (at most 120 s) plus
 * 60 s (broker/main.ts), so the relay waits 10 s longer than the broker can
 * take to answer. A shorter relay timeout would cut a fill that is still running.
 */
export const VAULT_RELAY_DEFAULT_TIMEOUT_MS = 190_000;
const TIMEOUT_RANGE_MS = [10_000, 600_000] as const;

export type VaultBrokerTarget =
  | { readonly kind: 'socket'; readonly socketPath: string }
  | {
    readonly kind: 'mtls';
    readonly url: URL;
    readonly key: Buffer;
    readonly cert: Buffer;
    readonly ca: Buffer;
  };

export interface VaultRelayConfig {
  readonly mode: Exclude<VaultRelayMode, 'off'>;
  readonly broker: VaultBrokerTarget;
  readonly privateKey: KeyObject;
  readonly timeoutMs: number;
}

/** Names the knob and the rule. It never contains a file's contents or a key. */
export class VaultRelayConfigError extends Error {
  constructor(readonly knob: string, rule: string, message = `vault relay: ${knob} ${rule}`) {
    super(message);
    this.name = 'VaultRelayConfigError';
  }
}

/**
 * The agent boundary refused (boundary.ts). `knob` and the base rule are the first failure's; the
 * message lists every failure, so one boot shows all a host must fix. Paths and ids only.
 */
export class VaultBoundaryError extends VaultRelayConfigError {
  readonly failures: readonly BoundaryFailure[];

  constructor(failures: readonly BoundaryFailure[]) {
    const first = failures[0];
    if (first === undefined) throw new TypeError('VaultBoundaryError needs a failure');
    super(first.knob, first.rule, `vault relay: refused (review F03 agent boundary): ${failures
      .map((failure) => `${failure.check} ${failure.knob} ${failure.rule}`).join('; ')}`);
    this.name = 'VaultBoundaryError';
    this.failures = Object.freeze([...failures]);
  }
}

interface CheckedFile { readonly knob: string; readonly path: string }

export function vaultRelayConfigFromEnv(env: NodeJS.ProcessEnv = process.env, host: VaultHostView = systemHostView): VaultRelayConfig | null {
  const mode = (env.TM8_VAULT_MODE ?? 'off').trim();
  if (!(VAULT_RELAY_MODES as readonly string[]).includes(mode)) {
    throw new VaultRelayConfigError('TM8_VAULT_MODE', 'must be off, dev, pre_review or production');
  }
  if (mode === 'off') return null;

  const socketPath = env.TM8_VAULT_BROKER_SOCKET?.trim() ?? '';
  const brokerUrl = env.TM8_VAULT_BROKER_URL?.trim() ?? '';
  if (socketPath !== '' && brokerUrl !== '') {
    throw new VaultRelayConfigError('TM8_VAULT_BROKER_SOCKET', 'and TM8_VAULT_BROKER_URL are both set: set exactly one');
  }
  if (socketPath === '' && brokerUrl === '') {
    throw new VaultRelayConfigError('TM8_VAULT_BROKER_SOCKET', 'or TM8_VAULT_BROKER_URL is required when TM8_VAULT_MODE is not off');
  }
  if (socketPath !== '' && mode === 'production') {
    throw new VaultRelayConfigError('TM8_VAULT_BROKER_SOCKET', 'is not allowed in production: use TM8_VAULT_BROKER_URL over mutual TLS');
  }
  const retiredKeys = parseRetiredKeys(env.TM8_VAULT_RETIRED_KEY_SHA256);
  if (retiredKeys === null) {
    throw new VaultRelayConfigError('TM8_VAULT_RETIRED_KEY_SHA256',
      `must list at most ${MAX_RETIRED_KEYS} comma-separated SHA-256s, each 64 hex digits or 32 colon-separated pairs`);
  }
  // Review F03, D5: where agent sessions run (boundary.ts). A malformed value refuses in every mode.
  const runAs = parseAgentRunAs(env.TM8_VAULT_AGENT_RUN_AS);
  if (runAs === null) {
    throw new VaultRelayConfigError(AGENT_RUN_AS_KNOB,
      'must be uid:<uid>, uids:<first>-<last> or gvisor:<first>-<last>, in decimal uids from 1 to 4294967294 (review F03)');
  }
  if (runAs === undefined && mode === 'production') {
    throw new VaultRelayConfigError(AGENT_RUN_AS_KNOB,
      'is required in production (review F03): name the uid, uid range or gVisor sandbox agent sessions run as, apart from this server');
  }

  // Each file's metadata first: stat, which opens nothing. The reads wait until the boundary and
  // the production refusal below have passed.
  let target: { readonly kind: 'socket' } | { readonly kind: 'mtls'; readonly url: URL; readonly key: CheckedFile; readonly cert: CheckedFile; readonly ca: CheckedFile };
  if (socketPath !== '') {
    if (!isAbsolute(socketPath)) throw new VaultRelayConfigError('TM8_VAULT_BROKER_SOCKET', 'must be an absolute path');
    target = { kind: 'socket' };
  } else {
    target = {
      kind: 'mtls',
      url: brokerOrigin(brokerUrl),
      key: secretFile(env.TM8_VAULT_RELAY_TLS_KEY_FILE, 'TM8_VAULT_RELAY_TLS_KEY_FILE'),
      cert: existingFile(env.TM8_VAULT_RELAY_TLS_CERT_FILE, 'TM8_VAULT_RELAY_TLS_CERT_FILE'),
      ca: existingFile(env.TM8_VAULT_RELAY_TLS_CA_FILE, 'TM8_VAULT_RELAY_TLS_CA_FILE'),
    };
  }
  const signingKey = secretFile(env.TM8_VAULT_RELAY_PRIVATE_KEY_FILE, 'TM8_VAULT_RELAY_PRIVATE_KEY_FILE');

  // Review F03, R1 to R6: point-in-time checks of this host, at boot only (see boundary.ts).
  if (runAs !== undefined) {
    const files = target.kind === 'mtls' ? [target.key, target.cert, target.ca, signingKey] : [signingKey];
    const failures = checkRelayBoundary(host, runAs, files);
    if (failures.length > 0) throw new VaultBoundaryError(failures);
  }

  // Review F03: before any key file is opened (the checks above stat, never open). See THE SIGNING KEY above.
  if (mode === 'production') {
    throw new VaultRelayConfigError('TM8_VAULT_MODE', 'production is refused (review F03): this server runs agent sessions, '
      + 'terminals and tools as its own user, so they could read the relay keys (deploy/vault/README.md)');
  }

  let broker: VaultBrokerTarget;
  if (target.kind === 'socket') {
    broker = Object.freeze({ kind: 'socket', socketPath });
  } else {
    const key = readChecked(target.key);
    try {
      broker = Object.freeze({ kind: 'mtls', url: target.url, key, cert: readChecked(target.cert), ca: readChecked(target.ca) });
    } catch (error) {
      key.fill(0);
      throw error;
    }
  }

  // From here on a refusal wipes the TLS client key it read.
  try {
    const pem = readChecked(signingKey);
    let privateKey: KeyObject;
    try {
      privateKey = loadAttestationPrivateKey(pem);
    } catch {
      throw new VaultRelayConfigError('TM8_VAULT_RELAY_PRIVATE_KEY_FILE', 'is not a PKCS#8 Ed25519 private key');
    } finally {
      pem.fill(0);
    }
    // Review F03, R7. Production does not get here while the refusal above stands; dev and
    // pre_review do. No fingerprint is printed: the message names the file's knob only.
    if (retiredKeys.size > 0) {
      if (retiredKeys.has(publicKeySha256(privateKey))) {
        throw new VaultRelayConfigError('TM8_VAULT_RELAY_PRIVATE_KEY_FILE', 'is a retired key (TM8_VAULT_RETIRED_KEY_SHA256, review F03 R7)');
      }
      if (broker.kind === 'mtls') retiredTlsKey(broker.key, retiredKeys);
    }
    // Review F03, R8: the TLS material is what it claims to be, now. With the boundary knob only.
    if (runAs !== undefined && broker.kind === 'mtls') {
      const failures = checkRelayTlsMaterial(broker, host.now());
      if (failures.length > 0) throw new VaultBoundaryError(failures);
    }

    const rawTimeout = env.TM8_VAULT_RELAY_TIMEOUT_MS?.trim() ?? '';
    // Digits only: Number() would also take 1e4, 0x2710 and 10_000-shaped surprises.
    const timeoutMs = rawTimeout === '' ? VAULT_RELAY_DEFAULT_TIMEOUT_MS : /^\d{1,7}$/.test(rawTimeout) ? Number(rawTimeout) : Number.NaN;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < TIMEOUT_RANGE_MS[0] || timeoutMs > TIMEOUT_RANGE_MS[1]) {
      throw new VaultRelayConfigError('TM8_VAULT_RELAY_TIMEOUT_MS', `must be an integer from ${TIMEOUT_RANGE_MS[0]} to ${TIMEOUT_RANGE_MS[1]}`);
    }

    return Object.freeze({ mode: mode as VaultRelayConfig['mode'], broker, privateKey, timeoutMs });
  } catch (error) {
    if (broker.kind === 'mtls') broker.key.fill(0);
    throw error;
  }
}

/**
 * The TLS client key against the denylist. Parsing it makes one more in-memory copy, which is
 * collected with the KeyObject; the agent's TLS context parses its own. A key this cannot parse
 * cannot be shown not to be retired, so it refuses, and the bytes read are wiped before it throws.
 */
function retiredTlsKey(key: Buffer, retiredKeys: ReadonlySet<string>): void {
  let fingerprint: string;
  try { fingerprint = publicKeySha256(createPrivateKey(key)); } catch {
    key.fill(0);
    throw new VaultRelayConfigError('TM8_VAULT_RELAY_TLS_KEY_FILE', 'is not an unencrypted PEM private key, so it cannot be checked against TM8_VAULT_RETIRED_KEY_SHA256');
  }
  if (retiredKeys.has(fingerprint)) {
    key.fill(0);
    throw new VaultRelayConfigError('TM8_VAULT_RELAY_TLS_KEY_FILE', 'is a retired key (TM8_VAULT_RETIRED_KEY_SHA256, review F03 R7)');
  }
}

/** https only, no credentials, no path, query or fragment: the relay appends /v2/vault/... itself. */
function brokerOrigin(raw: string): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new VaultRelayConfigError('TM8_VAULT_BROKER_URL', 'is not a URL'); }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== ''
    || (url.pathname !== '/' && url.pathname !== '') || url.search !== '' || url.hash !== '') {
    throw new VaultRelayConfigError('TM8_VAULT_BROKER_URL', 'must be an https origin with no credentials, path, query or fragment');
  }
  return url;
}

/** A regular file, by stat alone: nothing is opened. */
function existingFile(path: string | undefined, knob: string): CheckedFile & { readonly mode: number; readonly uid: number } {
  const value = path?.trim() ?? '';
  if (value === '') throw new VaultRelayConfigError(knob, 'is required when TM8_VAULT_MODE is not off');
  if (!isAbsolute(value)) throw new VaultRelayConfigError(knob, 'must be an absolute path');
  let stat;
  try { stat = statSync(value); } catch { throw new VaultRelayConfigError(knob, 'names a file that cannot be read'); }
  if (!stat.isFile()) throw new VaultRelayConfigError(knob, 'must name a regular file');
  return { knob, path: value, mode: stat.mode, uid: stat.uid };
}

/** A key file: owner-only and owned by this process's user, by stat alone. */
function secretFile(path: string | undefined, knob: string): CheckedFile {
  const file = existingFile(path, knob);
  if ((file.mode & 0o077) !== 0) throw new VaultRelayConfigError(knob, 'must not be readable or writable by group or others (chmod 600)');
  if (typeof process.getuid === 'function' && file.uid !== process.getuid()) {
    throw new VaultRelayConfigError(knob, 'must be owned by the user the server runs as');
  }
  return file;
}

function readChecked(file: CheckedFile): Buffer {
  try { return readFileSync(file.path); } catch { throw new VaultRelayConfigError(file.knob, 'names a file that cannot be read'); }
}

/**
 * The chat paste guard (vault/paste-guard.ts; MSG 6 Journey A step 3). TM8_VAULT_PASTE_GUARD is off,
 * the default, or on: anything else refuses to start. Off returns null and nothing reads a message.
 * On, the guard also needs to know whether this node runs the vault (TM8_VAULT_MODE is not off), so
 * its advice names the capture link only where there is one. It is independent of the vault mode:
 * a node with the vault off can still keep secrets out of its chat history.
 */
export interface VaultPasteGuardConfig {
  readonly vaultAvailable: boolean;
}

export function vaultPasteGuardFromEnv(env: NodeJS.ProcessEnv = process.env): VaultPasteGuardConfig | null {
  const value = (env.TM8_VAULT_PASTE_GUARD ?? 'off').trim();
  if (value !== 'off' && value !== 'on') {
    throw new VaultRelayConfigError('TM8_VAULT_PASTE_GUARD', 'must be off or on');
  }
  if (value === 'off') return null;
  return { vaultAvailable: (env.TM8_VAULT_MODE ?? 'off').trim() !== 'off' };
}
