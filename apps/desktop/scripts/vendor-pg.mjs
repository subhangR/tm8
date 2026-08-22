#!/usr/bin/env node
/**
 * Vendor the theseus-rs Postgres build into `apps/desktop/resources/pg/<ver>/`
 * at BUILD time.
 *
 * Why build time and not first run (SIDECAR-PACKAGING.md §2 says first run, and
 * that is wrong for a `.app`): arm64 macOS refuses to execute an unsigned Mach-O
 * at all. Every one of these 125 binaries has to be inside the bundle when
 * `codesign` runs over it, so unpacking after the user double-clicks is not a
 * slower option — it is a broken one.
 *
 * theseus-rs and not Homebrew because theseus-rs's dylib references are
 * `@loader_path/../lib/libssl.3.dylib`, i.e. relocatable; Homebrew hardcodes
 * `/opt/homebrew` and cannot be moved into a bundle.
 *
 * `include/` (8.2 MB of C headers) is dropped: nothing in tm8 compiles against
 * libpq — `pg` is pure JS.
 */

import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, rm, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const DESKTOP_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * The pin. Version, target triple and SHA-256 are one unit — bumping the
 * version without re-measuring the digest is the failure this constant exists
 * to make impossible.
 */
export const PG_PIN = {
  version: '18.6.0',
  major: 18,
  triple: 'aarch64-apple-darwin',
  bytes: 13_081_312,
  sha256: 'a257bcdb8aa3301a13d6a5bcec48f8c9517045b7cbae71e50788b2615539e95b',
};

const ARCHIVE = `postgresql-${PG_PIN.version}-${PG_PIN.triple}.tar.gz`;
const ARCHIVE_URL = `https://github.com/theseus-rs/postgresql-binaries/releases/download/${PG_PIN.version}/${ARCHIVE}`;

/** Outside the repo so a clean checkout does not re-download 13 MB. */
const CACHE_DIR = join(homedir(), 'Library', 'Caches', 'tm8-desktop', 'pg');

export function vendoredPgDir(desktopRoot = DESKTOP_ROOT) {
  return join(desktopRoot, 'resources', 'pg', PG_PIN.version);
}

async function sha256(path) {
  const hash = createHash('sha256');
  await new Promise((res, rej) => {
    createReadStream(path).on('data', (c) => hash.update(c)).on('error', rej).on('end', res);
  });
  return hash.digest('hex');
}

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} exited ${r.status ?? r.signal}`);
}

async function main() {
  const dest = vendoredPgDir();
  if (existsSync(join(dest, 'bin', 'postgres'))) {
    console.log(`pg: already vendored at ${dest}`);
    return;
  }

  await mkdir(CACHE_DIR, { recursive: true });
  const archive = join(CACHE_DIR, ARCHIVE);

  if (!existsSync(archive)) {
    console.log(`pg: downloading ${ARCHIVE_URL}`);
    sh('curl', ['-sSLf', '-o', archive, ARCHIVE_URL]);
  }

  // Verify BEFORE unpacking, never after: an unpack is what would put an
  // unverified Mach-O inside the bundle.
  const size = (await stat(archive)).size;
  const digest = await sha256(archive);
  if (size !== PG_PIN.bytes || digest !== PG_PIN.sha256) {
    await rm(archive, { force: true });
    throw new Error(
      `pg: ${ARCHIVE} failed its pin. Refusing to unpack.\n` +
        `  expected ${PG_PIN.bytes} bytes / ${PG_PIN.sha256}\n` +
        `  actual   ${size} bytes / ${digest}`,
    );
  }
  console.log(`pg: ${ARCHIVE} verified (${size} bytes, sha256 ok)`);

  await mkdir(dest, { recursive: true });
  sh('tar', ['-xzf', archive, '-C', dest, '--strip-components', '1']);

  // −8.2 MB. Headers are for compiling against libpq; `pg` is pure JS.
  await rm(join(dest, 'include'), { recursive: true, force: true });

  const bin = join(dest, 'bin');
  const required = ['postgres', 'initdb', 'pg_ctl', 'pg_isready', 'pg_dump', 'pg_restore', 'psql', 'createdb'];
  const missing = required.filter((t) => !existsSync(join(bin, t)));
  if (missing.length > 0) throw new Error(`pg: unpacked ${dest} but bin/ is missing ${missing.join(', ')}`);

  const entries = await readdir(dest);
  console.log(`pg: vendored ${PG_PIN.version} -> ${dest} (${entries.join(', ')})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(String(err instanceof Error ? err.message : err));
    process.exit(1);
  });
}
