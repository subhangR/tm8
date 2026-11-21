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
 * a process running as the same user: agent sessions on a shared host run as
 * that user, so the security review gate lists it as open until the relay
 * runs under its own user (deploy/vault/README.md).
 */
import { readFileSync, statSync } from 'node:fs';
import type { KeyObject } from 'node:crypto';
import { isAbsolute } from 'node:path';

import { loadAttestationPrivateKey } from '@tm8/vault/relay';

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
  constructor(readonly knob: string, rule: string) {
    super(`vault relay: ${knob} ${rule}`);
    this.name = 'VaultRelayConfigError';
  }
}

export function vaultRelayConfigFromEnv(env: NodeJS.ProcessEnv = process.env): VaultRelayConfig | null {
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
  let broker: VaultBrokerTarget;
  if (socketPath !== '') {
    if (mode === 'production') {
      throw new VaultRelayConfigError('TM8_VAULT_BROKER_SOCKET', 'is not allowed in production: use TM8_VAULT_BROKER_URL over mutual TLS');
    }
    if (!isAbsolute(socketPath)) throw new VaultRelayConfigError('TM8_VAULT_BROKER_SOCKET', 'must be an absolute path');
    broker = Object.freeze({ kind: 'socket', socketPath });
  } else if (brokerUrl !== '') {
    broker = Object.freeze({
      kind: 'mtls',
      url: brokerOrigin(brokerUrl),
      key: secretFile(env.TM8_VAULT_RELAY_TLS_KEY_FILE, 'TM8_VAULT_RELAY_TLS_KEY_FILE'),
      cert: plainFile(env.TM8_VAULT_RELAY_TLS_CERT_FILE, 'TM8_VAULT_RELAY_TLS_CERT_FILE'),
      ca: plainFile(env.TM8_VAULT_RELAY_TLS_CA_FILE, 'TM8_VAULT_RELAY_TLS_CA_FILE'),
    });
  } else {
    throw new VaultRelayConfigError('TM8_VAULT_BROKER_SOCKET', 'or TM8_VAULT_BROKER_URL is required when TM8_VAULT_MODE is not off');
  }

  const pem = secretFile(env.TM8_VAULT_RELAY_PRIVATE_KEY_FILE, 'TM8_VAULT_RELAY_PRIVATE_KEY_FILE');
  let privateKey: KeyObject;
  try {
    privateKey = loadAttestationPrivateKey(pem);
  } catch {
    throw new VaultRelayConfigError('TM8_VAULT_RELAY_PRIVATE_KEY_FILE', 'is not a PKCS#8 Ed25519 private key');
  } finally {
    pem.fill(0);
  }

  const rawTimeout = env.TM8_VAULT_RELAY_TIMEOUT_MS?.trim() ?? '';
  // Digits only: Number() would also take 1e4, 0x2710 and 10_000-shaped surprises.
  const timeoutMs = rawTimeout === '' ? VAULT_RELAY_DEFAULT_TIMEOUT_MS : /^\d{1,7}$/.test(rawTimeout) ? Number(rawTimeout) : Number.NaN;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < TIMEOUT_RANGE_MS[0] || timeoutMs > TIMEOUT_RANGE_MS[1]) {
    throw new VaultRelayConfigError('TM8_VAULT_RELAY_TIMEOUT_MS', `must be an integer from ${TIMEOUT_RANGE_MS[0]} to ${TIMEOUT_RANGE_MS[1]}`);
  }

  return Object.freeze({ mode: mode as VaultRelayConfig['mode'], broker, privateKey, timeoutMs });
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

function existingFile(path: string | undefined, knob: string): { path: string; mode: number; uid: number } {
  const value = path?.trim() ?? '';
  if (value === '') throw new VaultRelayConfigError(knob, 'is required when TM8_VAULT_MODE is not off');
  if (!isAbsolute(value)) throw new VaultRelayConfigError(knob, 'must be an absolute path');
  let stat;
  try { stat = statSync(value); } catch { throw new VaultRelayConfigError(knob, 'names a file that cannot be read'); }
  if (!stat.isFile()) throw new VaultRelayConfigError(knob, 'must name a regular file');
  return { path: value, mode: stat.mode, uid: stat.uid };
}

function plainFile(path: string | undefined, knob: string): Buffer {
  const file = existingFile(path, knob);
  try { return readFileSync(file.path); } catch { throw new VaultRelayConfigError(knob, 'names a file that cannot be read'); }
}

function secretFile(path: string | undefined, knob: string): Buffer {
  const file = existingFile(path, knob);
  if ((file.mode & 0o077) !== 0) throw new VaultRelayConfigError(knob, 'must not be readable or writable by group or others (chmod 600)');
  if (typeof process.getuid === 'function' && file.uid !== process.getuid()) {
    throw new VaultRelayConfigError(knob, 'must be owned by the user the server runs as');
  }
  try { return readFileSync(file.path); } catch { throw new VaultRelayConfigError(knob, 'names a file that cannot be read'); }
}
