import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CollabError } from '@tm8/contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  MAX_ENTRIES,
  MAX_INLINE_BYTES,
  browseDirectory,
  isSecretPath,
  normalizeRelPath,
  readFileContent,
  resolveRoot,
  resolveWithinRoot,
} from '../../src/files/project-files.js';

/**
 * FILES-DESIGN §8. Containment, masking, caps and refusals get their own cases
 * because they are exactly what a careless implementation collapses — a happy
 * path that lists a directory certifies nothing about any of them.
 *
 * These run against a REAL temp directory, including real symlinks. A mocked
 * filesystem would prove nothing about `realpath`, which is the whole defense.
 */

let root: string;      // the jail
let outside: string;   // a sibling the jail must never reach
let rootReal: string;

beforeAll(async () => {
  const base = await mkdtemp(join(tmpdir(), 'tm8-files-'));
  root = join(base, 'project');
  outside = join(base, 'outside');
  await mkdir(root, { recursive: true });
  await mkdir(outside, { recursive: true });

  await writeFile(join(outside, 'stolen.txt'), 'SECRET PAYLOAD', 'utf8');

  await mkdir(join(root, 'src'), { recursive: true });
  await mkdir(join(root, '.git'), { recursive: true });
  await writeFile(join(root, 'README.md'), '# hello\n', 'utf8');
  await writeFile(join(root, 'src', 'index.ts'), 'export const x = 1;\n', 'utf8');
  await writeFile(join(root, '.env'), 'API_KEY=live_do_not_leak\n', 'utf8');
  await writeFile(join(root, '.git', 'config'), '[remote]\n url = https://tok@x/y\n', 'utf8');
  await writeFile(join(root, 'binary.bin'), Buffer.from([0x00, 0x01, 0x02, 0x00]));
  await writeFile(join(root, 'empty.txt'), '', 'utf8');

  // The two symlinks that matter: one escapes, one does not.
  await symlink(join(outside, 'stolen.txt'), join(root, 'escape-link'));
  await symlink(join(root, 'README.md'), join(root, 'inside-link'));

  rootReal = await resolveRoot(root);
});

afterAll(async () => {
  await rm(join(root, '..'), { recursive: true, force: true });
});

describe('normalizeRelPath — hostile shapes are refused before the disk is touched', () => {
  it('accepts an empty path as the project root', () => {
    expect(normalizeRelPath(undefined)).toBe('');
    expect(normalizeRelPath('')).toBe('');
    expect(normalizeRelPath('.')).toBe('');
  });

  it('normalises separators and redundant segments', () => {
    expect(normalizeRelPath('src//index.ts')).toBe('src/index.ts');
    expect(normalizeRelPath('./src/./index.ts')).toBe('src/index.ts');
  });

  it('refuses a .. segment rather than sanitising it away', () => {
    expect(() => normalizeRelPath('../etc/passwd')).toThrow(CollabError);
    expect(() => normalizeRelPath('src/../../etc')).toThrow(CollabError);
  });

  it('refuses a backslash-encoded traversal (not just the POSIX spelling)', () => {
    expect(() => normalizeRelPath('..\\..\\etc')).toThrow(CollabError);
  });

  it('refuses an absolute path', () => {
    expect(() => normalizeRelPath('/etc/passwd')).toThrow(CollabError);
  });

  it('refuses a NUL byte', () => {
    expect(() => normalizeRelPath('src/index\u0000.ts')).toThrow(CollabError);
  });
});

describe('resolveWithinRoot — containment is checked on the RESOLVED path', () => {
  it('admits a path inside the jail', async () => {
    const result = await resolveWithinRoot(rootReal, 'src/index.ts');
    expect(result.ok).toBe(true);
  });

  it('admits a symlink that stays inside the jail', async () => {
    const result = await resolveWithinRoot(rootReal, 'inside-link');
    expect(result.ok).toBe(true);
  });

  it('REFUSES a symlink whose target escapes the jail', async () => {
    const result = await resolveWithinRoot(rootReal, 'escape-link');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.refusal.reason).toBe('outside-root');
  });

  it('does not leak where an escaping symlink actually landed', async () => {
    const result = await resolveWithinRoot(rootReal, 'escape-link');
    if (result.ok) throw new Error('unreachable');
    // A filesystem oracle for paths outside the jail would be a real leak: the
    // refusal must name the RULE, never the resolved target.
    expect(result.refusal.detail).not.toContain(outside);
    expect(result.refusal.detail).not.toContain('stolen');
    expect(result.refusal.detail).toBe('path resolves outside the project root');
  });

  it('refuses a sibling directory that merely shares the jail prefix', async () => {
    // The separator boundary: a jail of `.../project` must not admit
    // `.../project-secrets`. Without the `+ sep` this passes and is a breach.
    const sibling = `${rootReal}-secrets`;
    await mkdir(sibling, { recursive: true });
    await writeFile(join(sibling, 'x.txt'), 'nope', 'utf8');
    try {
      const result = await resolveWithinRoot(rootReal, '../project-secrets/x.txt');
      expect(result.ok).toBe(false);
    } catch (error) {
      // normalizeRelPath would have refused this first in the real path; here we
      // assert the resolver itself is not the only thing standing in the way.
      expect(error).toBeInstanceOf(CollabError);
    } finally {
      await rm(sibling, { recursive: true, force: true });
    }
  });

  it('reports a missing path as not-a-file, not as an escape', async () => {
    const result = await resolveWithinRoot(rootReal, 'does-not-exist');
    if (result.ok) throw new Error('unreachable');
    expect(result.refusal.reason).toBe('not-a-file');
  });
});

describe('isSecretPath — masking by name (§4.2)', () => {
  it('matches .env and its variants', () => {
    expect(isSecretPath('.env')).toBe(true);
    expect(isSecretPath('.env.local')).toBe(true);
    expect(isSecretPath('config/.env.production')).toBe(true);
  });

  it('matches a secret-named DIRECTORY anywhere in the path', () => {
    expect(isSecretPath('.ssh/id_rsa')).toBe(true);
    expect(isSecretPath('home/.aws/credentials')).toBe(true);
  });

  it('matches private key material by extension', () => {
    expect(isSecretPath('certs/server.pem')).toBe(true);
    expect(isSecretPath('a/b/private.key')).toBe(true);
  });

  it('matches .git/config but NOT the rest of .git', () => {
    expect(isSecretPath('.git/config')).toBe(true);
    expect(isSecretPath('.git/HEAD')).toBe(false);
    expect(isSecretPath('.git/refs/heads/main')).toBe(false);
  });

  it('does not mask ordinary source files', () => {
    expect(isSecretPath('src/index.ts')).toBe(false);
    expect(isSecretPath('README.md')).toBe(false);
    // `.github` must not be caught by the `.git` rules — it is a real directory
    // people need to browse.
    expect(isSecretPath('.github/workflows/ci.yml')).toBe(false);
  });
});

describe('browseDirectory', () => {
  it('lists the root with directories first', async () => {
    const view = await browseDirectory(rootReal, '');
    const names = view.entries.map((entry) => entry.name);
    expect(names).toContain('src');
    expect(names).toContain('README.md');
    expect(view.path).toBe('');
    expect(view.parentPath).toBeNull();
    const firstFileIndex = view.entries.findIndex((entry) => entry.kind !== 'dir');
    const lastDirIndex = view.entries.map((e) => e.kind).lastIndexOf('dir');
    expect(lastDirIndex).toBeLessThan(firstFileIndex);
  });

  it('LISTS a masked file rather than hiding it, and names why', async () => {
    const view = await browseDirectory(rootReal, '');
    const env = view.entries.find((entry) => entry.name === '.env');
    // Hiding it would teach the reader that no .env exists — a lie they would
    // act on. §4.2 lists it and withholds only the bytes.
    expect(env).toBeDefined();
    expect(env?.masked).toBe(true);
    expect(env?.maskReason).toBe('secret-pattern');
  });

  it('flags a symlink as a symlink', async () => {
    const view = await browseDirectory(rootReal, '');
    expect(view.entries.find((entry) => entry.name === 'escape-link')?.symlink).toBe(true);
    expect(view.entries.find((entry) => entry.name === 'README.md')?.symlink).toBe(false);
  });

  it('reports parentPath one level up, and "" from a first-level directory', async () => {
    const view = await browseDirectory(rootReal, 'src');
    expect(view.path).toBe('src');
    expect(view.parentPath).toBe('');
  });

  it('refuses to list a path outside the root', async () => {
    await expect(browseDirectory(rootReal, 'escape-link')).rejects.toBeInstanceOf(CollabError);
  });

  it('refuses to list a regular file as a directory', async () => {
    await expect(browseDirectory(rootReal, 'README.md')).rejects.toBeInstanceOf(CollabError);
  });

  it('caps entries and reports the TRUE total when truncating', async () => {
    const big = join(root, 'big');
    await mkdir(big, { recursive: true });
    const count = MAX_ENTRIES + 25;
    await Promise.all(
      Array.from({ length: count }, (_unused, index) =>
        writeFile(join(big, `f${String(index).padStart(5, '0')}.txt`), 'x', 'utf8'),
      ),
    );
    try {
      const view = await browseDirectory(rootReal, 'big');
      expect(view.entries).toHaveLength(MAX_ENTRIES);
      expect(view.truncated).toBe(true);
      // The honest part: the caller learns how much it is NOT seeing.
      expect(view.totalEntries).toBe(count);
    } finally {
      await rm(big, { recursive: true, force: true });
    }
  });
});

describe('readFileContent — every withholding is NAMED', () => {
  it('reads a text file as utf8', async () => {
    const view = await readFileContent(rootReal, 'src/index.ts');
    expect(view.encoding).toBe('utf8');
    expect(view.text).toContain('export const x = 1;');
    expect(view.refusal).toBeNull();
    expect(view.mimeType).toBe('text/x-typescript');
  });

  it('distinguishes an EMPTY file from a withheld one', async () => {
    const view = await readFileContent(rootReal, 'empty.txt');
    // Both have no content to show; only one of them is a refusal. Collapsing
    // these is the defect this case exists to catch.
    expect(view.encoding).toBe('utf8');
    expect(view.text).toBe('');
    expect(view.refusal).toBeNull();
  });

  it('refuses a secret-named file by name, without reading it', async () => {
    const view = await readFileContent(rootReal, '.env');
    expect(view.encoding).toBe('none');
    expect(view.text).toBeNull();
    expect(view.refusal?.reason).toBe('secret-pattern');
    // The payload must not appear anywhere in the answer.
    expect(JSON.stringify(view)).not.toContain('live_do_not_leak');
  });

  it('refuses .git/config, which routinely carries a token', async () => {
    const view = await readFileContent(rootReal, '.git/config');
    expect(view.refusal?.reason).toBe('secret-pattern');
    expect(JSON.stringify(view)).not.toContain('tok@');
  });

  it('refuses to follow a symlink out of the root', async () => {
    const view = await readFileContent(rootReal, 'escape-link');
    expect(view.refusal?.reason).toBe('outside-root');
    expect(JSON.stringify(view)).not.toContain('SECRET PAYLOAD');
  });

  it('follows a symlink that stays inside the root', async () => {
    const view = await readFileContent(rootReal, 'inside-link');
    expect(view.encoding).toBe('utf8');
    expect(view.text).toContain('# hello');
  });

  it('refuses a binary file with binary-not-previewable', async () => {
    const view = await readFileContent(rootReal, 'binary.bin');
    expect(view.encoding).toBe('none');
    expect(view.refusal?.reason).toBe('binary-not-previewable');
  });

  it('returns an image as base64 rather than refusing it', async () => {
    // A 1x1 PNG: binary, but renderable without ever getting a document context.
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    await writeFile(join(root, 'dot.png'), png);
    try {
      const view = await readFileContent(rootReal, 'dot.png');
      expect(view.encoding).toBe('base64');
      expect(view.base64).toBeTruthy();
      expect(view.refusal).toBeNull();
    } finally {
      await rm(join(root, 'dot.png'), { force: true });
    }
  });

  it('refuses a file above the inline ceiling and says how big it is', async () => {
    const fat = join(root, 'fat.txt');
    await writeFile(fat, Buffer.alloc(MAX_INLINE_BYTES + 1, 0x61));
    try {
      const view = await readFileContent(rootReal, 'fat.txt');
      expect(view.refusal?.reason).toBe('too-large');
      expect(view.sizeBytes).toBe(MAX_INLINE_BYTES + 1);
      expect(view.text).toBeNull();
    } finally {
      await rm(fat, { force: true });
    }
  });

  it('reports a missing file as not-a-file, not as an escape', async () => {
    const view = await readFileContent(rootReal, 'nope.txt');
    expect(view.refusal?.reason).toBe('not-a-file');
  });

  it('refuses a directory as not-a-file', async () => {
    const view = await readFileContent(rootReal, 'src');
    expect(view.refusal?.reason).toBe('not-a-file');
  });
});
