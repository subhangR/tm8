/**
 * Binary resolution and the major pin — SIDECAR-PACKAGING.md §2, §3.
 *
 * The pin check is the guard that stops "it found *a* Postgres on the PATH" from
 * becoming a cluster the rest of the lifecycle reasons about incorrectly.
 */

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  REQUIRED_PG_TOOLS,
  findBinariesDirSync,
  parseMajor,
  targetTriple,
} from '../../src/sidecar/binaries.js';
import { isSidecarError } from '../../src/sidecar/errors.js';

const scratch: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'tm8-bin-'));
  scratch.push(d);
  return d;
}
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

function fakeBinDir(opts: { omit?: string } = {}): string {
  const dir = join(tempDir(), 'bin');
  mkdirSync(dir, { recursive: true });
  for (const tool of REQUIRED_PG_TOOLS) {
    if (tool === opts.omit) continue;
    const p = join(dir, tool);
    writeFileSync(p, '#!/bin/sh\nexit 0\n');
    chmodSync(p, 0o755);
  }
  return dir;
}

describe('targetTriple', () => {
  it('maps the four supported platforms', () => {
    expect(targetTriple('darwin', 'arm64')).toBe('aarch64-apple-darwin');
    expect(targetTriple('darwin', 'x64')).toBe('x86_64-apple-darwin');
    expect(targetTriple('linux', 'x64')).toBe('x86_64-unknown-linux-gnu');
    expect(targetTriple('linux', 'arm64')).toBe('aarch64-unknown-linux-gnu');
  });

  it('refuses deferred platforms with a typed error, not a crash', () => {
    try {
      targetTriple('win32', 'x64');
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(isSidecarError(e)).toBe(true);
      if (isSidecarError(e)) expect(e.code).toBe('BinaryMissing');
    }
  });
});

describe('parseMajor', () => {
  it('reads the major from real `postgres --version` output', () => {
    expect(parseMajor('postgres (PostgreSQL) 18.4 (Homebrew)')).toBe(18);
    expect(parseMajor('postgres (PostgreSQL) 17.2')).toBe(17);
    expect(parseMajor('postgres (PostgreSQL) 18.4.0')).toBe(18);
  });

  it('returns null on unparseable output rather than guessing', () => {
    expect(parseMajor('')).toBeNull();
    expect(parseMajor('command not found')).toBeNull();
  });
});

describe('findBinariesDirSync', () => {
  const base = { major: 18, dataDir: '/nonexistent-tm8-data', repoRoot: '/nonexistent-tm8-repo' };

  it('accepts a complete TM8_PG_BIN_DIR override', () => {
    const dir = fakeBinDir();
    expect(findBinariesDirSync({ ...base, override: dir })).toBe(dir);
  });

  it('rejects an override missing a required tool, naming what it needs', () => {
    const dir = fakeBinDir({ omit: 'pg_restore' });
    try {
      findBinariesDirSync({ ...base, override: dir });
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(isSidecarError(e)).toBe(true);
      if (isSidecarError(e)) {
        expect(e.code).toBe('BinaryMissing');
        expect(e.message).toContain('pg_restore');
      }
    }
  });

  it('prefers an already-unpacked vendor build over system candidates', () => {
    const dataDir = tempDir();
    const unpacked = join(dataDir, 'binaries', '18.4.0', 'bin');
    mkdirSync(unpacked, { recursive: true });
    for (const tool of REQUIRED_PG_TOOLS) writeFileSync(join(unpacked, tool), '');
    expect(findBinariesDirSync({ ...base, dataDir })).toBe(unpacked);
  });

  it('returns null when nothing is resolvable synchronously', () => {
    expect(
      findBinariesDirSync({ major: 999, dataDir: '/nonexistent-tm8-data', repoRoot: '/nonexistent' }),
    ).toBeNull();
  });
});
