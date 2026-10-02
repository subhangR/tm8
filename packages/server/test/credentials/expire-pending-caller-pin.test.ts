/**
 * 01a0fb58-2260 — the caller set of `expire_pending_space_credentials`, pinned.
 *
 * The RPC deletes node-wide (every expired pending login, in every space), so
 * who may reach it is part of its guard: 991 requires an identity and refuses
 * a link-bound caller (990), and admits agent kinds as 206 always did. This
 * pins the TS side — exactly one RPC call site (the store), and the store's
 * `expirePending` reached only from CredentialSessions' two login paths — so
 * a new caller is a deliberate, reviewed edit here. The SQL side (no function
 * body calls it) is pinned in test/db/credential-ops.pg.test.ts.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PACKAGES = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === 'node_modules' || name === 'dist' || name === 'test') return [];
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

function sitesOf(pattern: RegExp): string[] {
  const out: string[] = [];
  for (const pkg of readdirSync(PACKAGES)) {
    const src = join(PACKAGES, pkg, 'src');
    try { statSync(src); } catch { continue; }
    for (const file of sources(src)) {
      readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        if (pattern.test(line) && !/^\s*(\/\/|\*)/.test(line)) out.push(`${relative(PACKAGES, file)}:${String(i + 1)}`.replace(/:\d+$/, ''));
      });
    }
  }
  return out.sort();
}

describe('expire_pending_space_credentials — the TS caller set', () => {
  it('one RPC call site: the space credential store', () => {
    expect(sitesOf(/['"`]expire_pending_space_credentials['"`]/)).toEqual([
      'server/src/credentials/space-credential-store.ts',
    ]);
  });

  it('the store method is reached only from CredentialSessions (the login sweep and the target cleanup, both under a space login\'s claims)', () => {
    expect(sitesOf(/\.expirePending\(/)).toEqual(['server/src/facade/services/w2/credential-sessions.ts']);
    expect(sitesOf(/\.expirePendingQuietly\(/)).toEqual([
      'server/src/facade/services/w2/credential-sessions.ts',
      'server/src/facade/services/w2/credential-sessions.ts',
    ]);
  });
});
