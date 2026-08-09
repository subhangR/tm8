/**
 * The per-identity credential home — `<dataDir>/credentials/<identityId>/<provider>/`.
 *
 * WHY THE REPAIR EXISTS, AND WHY IT IS NOT OPTIONAL.
 *
 * `mkdir(path, { recursive: true, mode: 0o700 })` applies its mode ONLY to
 * directories it actually creates. On an upgraded node — or on any node where
 * an earlier build, a backup restore, or an operator's `mkdir -p` got there
 * first — the directory already exists at 0755 and `mkdir` returns success
 * having changed nothing. The result is a world-readable directory holding
 * `.credentials.json`, and every observable signal says it worked. So each
 * level is explicitly `chmod`ed after the fact, which is the pattern
 * `SpawnService.ensurePrivateDirectory` already uses for the manifest, journal
 * and scratch roots, and it is copied deliberately rather than reinvented.
 *
 * EVERY LEVEL IS REPAIRED, NOT JUST THE LEAF. `<dataDir>/credentials` holds one
 * subdirectory per identity; if IT is 0755 then every member can enumerate
 * which other members have connected which vendors, even with the leaves at
 * 0700. And `<dataDir>/credentials/<identityId>` is the terminal's whole `HOME`,
 * so a vendor CLI that writes a stray dotfile writes it there. Three levels,
 * three repairs.
 *
 * WHY `identityId` IS VALIDATED EVEN THOUGH IT COMES FROM THE AUTH PRINCIPAL.
 * It is a server-resolved value today and this check will never fire. It costs
 * one regex and it is the difference between "safe because of where the caller
 * happens to get it" and "safe because it cannot be otherwise" — and this
 * particular value is being concatenated into a filesystem path under which
 * secrets are stored. The former is an argument; only the latter is a control.
 */
import { chmod, lstat, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { CollabError } from '@tm8/contract';
import type { CredentialProvider } from '@tm8/execution';
import { CREDENTIAL_PROVIDERS } from '@tm8/execution';

/** 0700 — owner only. The same constant SpawnService uses for its data roots. */
export const CREDENTIAL_DIRECTORY_MODE = 0o700;

/**
 * The shapes an identity id may take on this node.
 *
 * Deliberately an ALLOWLIST rather than a `..` denylist: a denylist has to
 * anticipate every encoding of every traversal, an allowlist only has to
 * describe what is legitimate. Identity ids here are uuids on a real node and
 * short slugs in tests; neither needs a slash, a dot-dot or a NUL.
 */
const IDENTITY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function assertSafeIdentityId(identityId: string): void {
  if (!IDENTITY_ID_RE.test(identityId) || identityId.includes('..')) {
    // `invariant_violation`, not `invalid_input`: the identity id is
    // server-resolved, so a value that fails this is a SERVER bug and must not
    // read to a client as "you sent something wrong". (`internal` is not in the
    // contract's error taxonomy — see CommandErrorCode.)
    throw new CollabError(
      'invariant_violation',
      'identity id is not usable as a credential home path',
    );
  }
}

function assertKnownProvider(provider: string): asserts provider is CredentialProvider {
  if (!(CREDENTIAL_PROVIDERS as readonly string[]).includes(provider)) {
    throw new CollabError('invalid_input', `unsupported credential provider: ${provider}`);
  }
}

/** `<dataDir>/credentials` — the root that must not be enumerable. */
export function credentialsRoot(dataDir: string): string {
  return join(dataDir, 'credentials');
}

/** `<dataDir>/credentials/<identityId>` — the login terminal's entire HOME. */
export function credentialHomeDir(dataDir: string, identityId: string): string {
  assertSafeIdentityId(identityId);
  return join(credentialsRoot(dataDir), identityId);
}

/** `<dataDir>/credentials/<identityId>/<provider>` — the vendor config dir. */
export function credentialConfigDir(
  dataDir: string,
  identityId: string,
  provider: CredentialProvider,
): string {
  assertKnownProvider(provider);
  return join(credentialHomeDir(dataDir, identityId), provider);
}

/**
 * Create-or-repair one directory at 0700.
 *
 * Byte-for-byte the shape of `SpawnService.ensurePrivateDirectory`: mkdir with
 * the mode (which covers creation), `lstat` to refuse a non-directory, then an
 * unconditional `chmod` (which covers the pre-existing 0755 case that mkdir
 * silently ignores).
 *
 * `lstat` and not `stat`, so a SYMLINK at this path is refused rather than
 * followed. Following one would chmod, and then write credentials into,
 * whatever it points at — outside the data directory entirely.
 */
async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: CREDENTIAL_DIRECTORY_MODE });
  const info = await lstat(path);
  if (!info.isDirectory()) {
    throw new CollabError(
      'invariant_violation',
      `credential home path is not a directory: ${path}`,
    );
  }
  await chmod(path, CREDENTIAL_DIRECTORY_MODE);
}

export interface CredentialHome {
  /** The terminal's `HOME`. */
  homeDir: string;
  /** The vendor CLI's config directory, under `homeDir`. */
  configDir: string;
}

/**
 * Resolve and create this identity's credential home for `provider`, repairing
 * the permissions of every level on the way down.
 *
 * Sequential rather than `Promise.all`, because the levels are nested: repairing
 * a child concurrently with creating its parent is a race whose loser is a
 * directory left at the umask default.
 */
export async function ensureCredentialHome(
  dataDir: string,
  identityId: string,
  provider: CredentialProvider,
): Promise<CredentialHome> {
  const configDir = credentialConfigDir(dataDir, identityId, provider);
  const homeDir = credentialHomeDir(dataDir, identityId);

  await ensurePrivateDirectory(credentialsRoot(dataDir));
  await ensurePrivateDirectory(homeDir);
  await ensurePrivateDirectory(configDir);

  return { homeDir, configDir };
}
