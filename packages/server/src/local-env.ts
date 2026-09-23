// Secrets for a node whose unit file someone else owns.
//
// tm8-prod takes its environment from `EnvironmentFile=/etc/tm8/prod.env`,
// which is root-owned and mode 0600. The account the service RUNS as cannot
// write it, so on a box where the service owner is not the box owner there is
// no way to hand the process a new variable — a new provider key, a policy
// switch — without finding a human with root. That is the correct default for
// a machine nobody is standing at, and the wrong one for the ordinary case of
// turning a feature on.
//
// So: an optional file next to the checkout, owned by the service account.
// Systemd always wins. A variable already present in `process.env` is never
// replaced, because the unit file is the operator's statement of intent and
// this file is only allowed to say things the operator did not.
//
// This is not a weaker place to keep a secret than the unit file, which is the
// first thing it looks like. Anything running as the service account can
// already read that root-owned file's contents out of `/proc/<pid>/environ` —
// the process owner may read its own environment. The reachable set is the
// same; only the write path differs, and that is the whole point.

import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const LOCAL_ENV_FILE = '.env.local';

export interface LoadLocalEnvOptions {
  /** Directory holding the file. Defaults to the process working directory. */
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  logger?: { info?: (m: string, x?: unknown) => void; warn?: (m: string, x?: unknown) => void };
}

/**
 * Fill in variables the unit file did not set, from `<cwd>/.env.local`.
 *
 * Returns the names it added — never the values, which is why the caller can
 * log the result. Absent file, unreadable file, malformed file: all no-ops. A
 * node that cannot read its optional config should start anyway, because the
 * alternative is a boot loop over a file that is allowed not to exist.
 */
export function loadLocalEnv(options: LoadLocalEnvOptions = {}): string[] {
  const env = options.env ?? process.env;
  const path = join(options.cwd ?? process.cwd(), LOCAL_ENV_FILE);
  if (!existsSync(path)) return [];

  // World-readable secrets are a different mistake from missing ones, and this
  // one is worth saying out loud rather than silently honouring.
  try {
    const mode = statSync(path).mode & 0o077;
    if (mode !== 0) {
      options.logger?.warn?.(`${LOCAL_ENV_FILE} is readable beyond its owner — tighten it to 0600`, {
        path,
        mode: (statSync(path).mode & 0o777).toString(8),
      });
    }
  } catch {
    // stat can fail between the existsSync and here. Not worth refusing to boot.
  }

  // Snapshot VALUES, not just names: `loadEnvFile` overwrites, and the unit
  // file has to survive that. Names alone would let this file quietly retune a
  // variable the operator had deliberately set.
  const before = new Map(Object.entries(env).map(([k, v]) => [k, v]));
  try {
    process.loadEnvFile(path);
  } catch (error) {
    options.logger?.warn?.(`${LOCAL_ENV_FILE} could not be read — continuing without it`, {
      path,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }

  const added: string[] = [];
  for (const key of Object.keys(process.env)) {
    const prior = before.get(key);
    if (prior === undefined && !before.has(key)) {
      added.push(key);
      continue;
    }
    // The operator already said this one. Undo the overwrite.
    if (process.env[key] !== prior) process.env[key] = prior;
  }
  return added.sort();
}
