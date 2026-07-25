/**
 * Postgres binary resolution + verification — SIDECAR-PACKAGING.md §2, §3.
 *
 * Resolution order (first hit wins):
 *   1. `TM8_PG_BIN_DIR`            explicit operator override (a system/Homebrew PG)
 *   2. `<dataDir>/binaries/<ver>/bin`   already unpacked from a vendored archive
 *   3. vendored archive under `<repoRoot>/vendor/pg/` (SHA-256 verified, unpacked here)
 *   4. platform-conventional install locations for the pinned major
 *
 * Step 3 is the shipping path Vela's packaging plan specifies; steps 1 and 4 are
 * what make development on a machine with Homebrew Postgres work today, before
 * any release tarball exists. Step 4 is *never* used silently for a wrong major:
 * `assertBinaryMajor()` reads the actual `postgres --version` and refuses a
 * mismatch, so "it happened to find PG 16 on the PATH" cannot become a corrupt
 * cluster later.
 */

import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { SidecarError } from './errors.js';
import { describeFailure, run } from './exec.js';

/** Tools the lifecycle actually invokes. All must be present in a bin dir. */
export const REQUIRED_PG_TOOLS = [
  'postgres',
  'initdb',
  'pg_ctl',
  'pg_isready',
  'pg_dump',
  'pg_restore',
  'psql',
  'createdb',
] as const;

export type PgTool = (typeof REQUIRED_PG_TOOLS)[number];

/** Absolute path to a tool inside a resolved bin dir. */
export function toolPath(binariesDir: string, tool: PgTool): string {
  return join(binariesDir, tool);
}

function hasAllTools(dir: string): boolean {
  return REQUIRED_PG_TOOLS.every((t) => existsSync(join(dir, t)));
}

/**
 * theseus-rs target triple for this host (§2 mapping table).
 * @throws SidecarError BinaryMissing on an unsupported platform (Windows is deferred).
 */
export function targetTriple(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  const key = `${platform}/${arch}`;
  switch (key) {
    case 'darwin/arm64':
      return 'aarch64-apple-darwin';
    case 'darwin/x64':
      return 'x86_64-apple-darwin';
    case 'linux/x64':
      return 'x86_64-unknown-linux-gnu';
    case 'linux/arm64':
      return 'aarch64-unknown-linux-gnu';
    default:
      throw new SidecarError(
        'BinaryMissing',
        `tm8: no bundled Postgres for ${key}. Supported: darwin-arm64, darwin-x64, linux-x64, linux-arm64 (Windows is deferred).`,
      );
  }
}

/** Conventional install locations for a system Postgres of the pinned major. */
function systemCandidates(major: number): string[] {
  return [
    `/opt/homebrew/opt/postgresql@${major}/bin`,
    `/usr/local/opt/postgresql@${major}/bin`,
    `/usr/lib/postgresql/${major}/bin`,
    `/usr/pgsql-${major}/bin`,
    `/opt/postgresql/${major}/bin`,
  ];
}

export interface VendorManifestEntry {
  /** Archive filename under `vendor/pg/`. */
  readonly file: string;
  /** Lowercase hex SHA-256 of the archive. */
  readonly sha256: string;
  /** Full version, e.g. "18.4.0". */
  readonly version: string;
}

/** `vendor/pg/manifest.json` — `{ "<triple>": { file, sha256, version } }`. */
export type VendorManifest = Record<string, VendorManifestEntry>;

function readVendorManifest(repoRoot: string): VendorManifest | null {
  const path = join(repoRoot, 'vendor', 'pg', 'manifest.json');
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as VendorManifest;
  } catch (cause) {
    throw new SidecarError('BinaryMissing', `tm8: vendor/pg/manifest.json is unreadable or not JSON`, {
      detail: cause instanceof Error ? cause.message : String(cause),
      cause,
    });
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((res, rej) => {
    createReadStream(path)
      .on('data', (c) => hash.update(c))
      .on('error', rej)
      .on('end', () => res());
  });
  return hash.digest('hex');
}

export interface ResolveBinariesOptions {
  readonly major: number;
  readonly dataDir: string;
  readonly repoRoot: string;
  readonly override?: string | undefined;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
}

/**
 * Synchronous part of resolution: the override, an already-unpacked vendor dir,
 * or a system install. Returns `null` when only the (async) vendored-archive
 * unpack could satisfy the request.
 */
export function findBinariesDirSync(opts: ResolveBinariesOptions): string | null {
  if (opts.override) {
    const dir = resolve(opts.override);
    if (!hasAllTools(dir)) {
      throw new SidecarError(
        'BinaryMissing',
        `tm8: TM8_PG_BIN_DIR=${dir} does not contain a complete Postgres bin/ (need ${REQUIRED_PG_TOOLS.join(', ')}).`,
      );
    }
    return dir;
  }

  const unpackRoot = join(opts.dataDir, 'binaries');
  if (existsSync(unpackRoot)) {
    // Prefer the newest unpacked build for the pinned major.
    const dirs = (() => {
      try {
        return readdirSync(unpackRoot);
      } catch {
        return [] as string[];
      }
    })();
    const matches = dirs
      .filter((d) => d.startsWith(`${opts.major}.`))
      .sort()
      .reverse()
      .map((d) => join(unpackRoot, d, 'bin'))
      .filter(hasAllTools);
    const first = matches[0];
    if (first !== undefined) return first;
  }

  for (const dir of systemCandidates(opts.major)) {
    if (hasAllTools(dir)) return dir;
  }
  return null;
}

/**
 * Full resolution including the vendored-archive path.
 *
 * @throws SidecarError `BinaryMissing` when nothing can be resolved,
 *         `BinaryChecksumFail` when a vendored archive fails its pin.
 */
export async function resolveBinariesDir(opts: ResolveBinariesOptions): Promise<string> {
  const direct = findBinariesDirSync(opts);
  if (direct !== null) return direct;

  const manifest = readVendorManifest(opts.repoRoot);
  const triple = targetTriple(opts.platform, opts.arch);
  const entry = manifest?.[triple];
  if (manifest === null || entry === undefined) {
    throw new SidecarError(
      'BinaryMissing',
      `tm8: no Postgres ${opts.major} binaries found for ${triple}.\n` +
        `Looked in: TM8_PG_BIN_DIR, ${join(opts.dataDir, 'binaries')}, ${join(opts.repoRoot, 'vendor/pg')}, ` +
        systemCandidates(opts.major).join(', ') +
        `\nInstall Postgres ${opts.major} or set TM8_PG_BIN_DIR to its bin/ directory.`,
    );
  }

  const archive = join(opts.repoRoot, 'vendor', 'pg', entry.file);
  if (!existsSync(archive)) {
    throw new SidecarError(
      'BinaryMissing',
      `tm8: vendor/pg/manifest.json lists ${entry.file} for ${triple} but the archive is absent.`,
    );
  }

  const actual = await sha256File(archive);
  if (actual !== entry.sha256.toLowerCase()) {
    throw new SidecarError(
      'BinaryChecksumFail',
      `tm8: vendored Postgres archive ${entry.file} failed its SHA-256 pin. Refusing to unpack.`,
      { detail: `expected ${entry.sha256}\nactual   ${actual}` },
    );
  }

  const dest = join(opts.dataDir, 'binaries', entry.version);
  await mkdir(dest, { recursive: true, mode: 0o700 });
  const untar = await run('tar', ['-xzf', archive, '-C', dest, '--strip-components', '1'], {
    timeoutMs: 120_000,
  });
  if (!untar.ok) {
    throw new SidecarError('BinaryMissing', `tm8: failed to unpack vendored Postgres archive ${entry.file}`, {
      detail: describeFailure(untar),
    });
  }

  const binDir = join(dest, 'bin');
  if (!hasAllTools(binDir)) {
    throw new SidecarError(
      'BinaryMissing',
      `tm8: unpacked ${entry.file} but ${binDir} is missing required tools (${REQUIRED_PG_TOOLS.join(', ')}).`,
    );
  }
  return binDir;
}

/** Parse `postgres (PostgreSQL) 18.4 (Homebrew)` → 18. */
export function parseMajor(versionOutput: string): number | null {
  const m = /(\d+)\.\d+/.exec(versionOutput) ?? /\b(\d{2,})\b/.exec(versionOutput);
  if (m?.[1] === undefined) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) ? n : null;
}

/** Read the actual major of the binaries in `binariesDir`. */
export async function readBinaryMajor(binariesDir: string): Promise<number> {
  const r = await run(toolPath(binariesDir, 'postgres'), ['--version'], { timeoutMs: 15_000 });
  const major = r.ok ? parseMajor(r.stdout) : null;
  if (major === null) {
    throw new SidecarError('BinaryMissing', `tm8: could not read the Postgres version from ${binariesDir}`, {
      detail: describeFailure(r),
    });
  }
  return major;
}

/**
 * Guard the pin (§3): a binary whose major differs from `PINNED_PG_MAJOR` must
 * never be used, because it would create or open a cluster the rest of the
 * lifecycle reasons about incorrectly.
 */
export async function assertBinaryMajor(binariesDir: string, pinned: number): Promise<number> {
  const actual = await readBinaryMajor(binariesDir);
  if (actual !== pinned) {
    throw new SidecarError(
      'BinaryMissing',
      `tm8: Postgres binaries at ${binariesDir} are major ${actual}, but this tm8 build pins major ${pinned}. ` +
        `Point TM8_PG_BIN_DIR at a Postgres ${pinned} bin/ directory.`,
    );
  }
  return actual;
}
