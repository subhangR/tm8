import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { LOCAL_ENV_FILE, loadLocalEnv } from '../src/local-env.js';

const touched: string[] = [];
function dirWith(body: string, mode = 0o600): string {
  const dir = mkdtempSync(join(tmpdir(), 'tm8-localenv-'));
  const file = join(dir, LOCAL_ENV_FILE);
  writeFileSync(file, body);
  chmodSync(file, mode);
  return dir;
}
function track(...names: string[]) {
  touched.push(...names);
}
afterEach(() => {
  for (const n of touched.splice(0)) delete process.env[n];
});

describe('loadLocalEnv', () => {
  it('fills a variable the unit file never set', () => {
    track('TM8_LOCALENV_FRESH');
    const added = loadLocalEnv({ cwd: dirWith('TM8_LOCALENV_FRESH=yes\n') });
    expect(added).toContain('TM8_LOCALENV_FRESH');
    expect(process.env.TM8_LOCALENV_FRESH).toBe('yes');
  });

  it('never overrides what the unit file already said', () => {
    // This is the whole safety property. `process.loadEnvFile` overwrites, so
    // without the restore an operator's deliberate setting — a database url, a
    // policy switch — could be silently retuned by a file the service account
    // can write. The unit file is the operator speaking; this file is not.
    track('TM8_LOCALENV_OWNED');
    process.env.TM8_LOCALENV_OWNED = 'from-systemd';
    const added = loadLocalEnv({ cwd: dirWith('TM8_LOCALENV_OWNED=from-the-file\n') });
    expect(process.env.TM8_LOCALENV_OWNED).toBe('from-systemd');
    expect(added).not.toContain('TM8_LOCALENV_OWNED');
  });

  it('returns names, never values, so the caller can log what it did', () => {
    track('TM8_LOCALENV_SECRET');
    const added = loadLocalEnv({ cwd: dirWith('TM8_LOCALENV_SECRET=hunter2\n') });
    expect(added).toEqual(['TM8_LOCALENV_SECRET']);
    expect(JSON.stringify(added)).not.toContain('hunter2');
  });

  it('is a no-op when the file is absent — the file is allowed not to exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tm8-localenv-none-'));
    expect(loadLocalEnv({ cwd: dir })).toEqual([]);
  });

  it('warns rather than refuses when the file is readable beyond its owner', () => {
    track('TM8_LOCALENV_LOOSE');
    const warnings: string[] = [];
    const added = loadLocalEnv({
      cwd: dirWith('TM8_LOCALENV_LOOSE=1\n', 0o644),
      logger: { warn: (m) => warnings.push(m) },
    });
    // Boot anyway. A node that refuses to start over a permission bit is a
    // node that is down for a reason nobody can see from the outside.
    expect(added).toContain('TM8_LOCALENV_LOOSE');
    expect(warnings.join(' ')).toContain('readable beyond its owner');
  });
});
