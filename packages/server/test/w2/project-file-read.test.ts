import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  MAX_INLINE_BYTES,
  isSecretProjectPath,
  readProjectFile,
} from '../../src/facade/services/w2/project-files.js';

/**
 * `projects.files.read` — the VIEWER half of `projects.files.list`
 * (FILES-DESIGN §5.1, §8).
 *
 * Containment, masking, the inline ceiling and each refusal get their own case
 * because they are what a careless implementation collapses into one another. A
 * happy-path read certifies none of them.
 *
 * These run against a REAL temp directory including REAL symlinks: a mocked
 * filesystem proves nothing about `realpath`, which is the whole containment.
 */

let base: string;
let root: string;     // the project working directory
let outside: string;  // a sibling it must never reach
let roots: string[];  // TM8_PROJECT_ROOTS stand-in

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'tm8-pfread-'));
  root = join(base, 'project');
  outside = join(base, 'outside');
  await mkdir(root, { recursive: true });
  await mkdir(outside, { recursive: true });
  roots = [base];

  await writeFile(join(outside, 'stolen.txt'), 'SECRET PAYLOAD', 'utf8');

  await mkdir(join(root, 'src'), { recursive: true });
  await mkdir(join(root, '.git'), { recursive: true });
  await mkdir(join(root, '.github', 'workflows'), { recursive: true });
  await writeFile(join(root, 'README.md'), '# hello\n', 'utf8');
  await writeFile(join(root, 'src', 'index.ts'), 'export const x = 1;\n', 'utf8');
  await writeFile(join(root, 'empty.txt'), '', 'utf8');
  await writeFile(join(root, '.env'), 'API_KEY=live_do_not_leak\n', 'utf8');
  await writeFile(join(root, '.git', 'config'), '[remote]\n url = https://tok@x/y\n', 'utf8');
  await writeFile(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
  await writeFile(join(root, '.github', 'workflows', 'ci.yml'), 'name: ci\n', 'utf8');
  await writeFile(join(root, 'binary.bin'), Buffer.from([0x00, 0x01, 0x02, 0x00]));

  await symlink(join(outside, 'stolen.txt'), join(root, 'escape-link'));
  await symlink(join(root, 'README.md'), join(root, 'inside-link'));
  // An innocently-named symlink pointing at a secret INSIDE the project: the
  // name policy must be re-applied to the resolved path or this reads .env.
  await symlink(join(root, '.env'), join(root, 'notes.txt'));
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('isSecretProjectPath', () => {
  it('matches .env and its variants, anywhere in the path', () => {
    expect(isSecretProjectPath('/p/.env')).toBe(true);
    expect(isSecretProjectPath('/p/.env.production')).toBe(true);
    expect(isSecretProjectPath('/p/config/.env.local')).toBe(true);
  });

  it('matches a secret-named DIRECTORY, not just a file', () => {
    expect(isSecretProjectPath('/p/.ssh/id_rsa')).toBe(true);
    expect(isSecretProjectPath('/p/.aws/credentials')).toBe(true);
  });

  it('matches private key material by extension', () => {
    expect(isSecretProjectPath('/p/certs/server.pem')).toBe(true);
    expect(isSecretProjectPath('/p/a/private.key')).toBe(true);
  });

  it('matches .git/config but leaves the rest of .git readable', () => {
    expect(isSecretProjectPath('/p/.git/config')).toBe(true);
    expect(isSecretProjectPath('/p/.git/HEAD')).toBe(false);
    expect(isSecretProjectPath('/p/.git/refs/heads/main')).toBe(false);
  });

  it('does not catch .github, which people need to read', () => {
    expect(isSecretProjectPath('/p/.github/workflows/ci.yml')).toBe(false);
    expect(isSecretProjectPath('/p/src/index.ts')).toBe(false);
  });
});

describe('readProjectFile — content', () => {
  it('reads a text file as utf8', async () => {
    const view = await readProjectFile(root, join(root, 'src', 'index.ts'), roots);
    expect(view.encoding).toBe('utf8');
    expect(view.text).toContain('export const x = 1;');
    expect(view.refusal).toBeNull();
  });

  it('distinguishes an EMPTY file from a withheld one', async () => {
    // Both show nothing; only one is a refusal. Collapsing them is the defect
    // this case exists to catch.
    const view = await readProjectFile(root, join(root, 'empty.txt'), roots);
    expect(view.encoding).toBe('utf8');
    expect(view.text).toBe('');
    expect(view.refusal).toBeNull();
  });

  it('follows a symlink that stays inside the project', async () => {
    const view = await readProjectFile(root, join(root, 'inside-link'), roots);
    expect(view.encoding).toBe('utf8');
    expect(view.text).toContain('# hello');
  });

  it('reads .git/HEAD — masking is narrow, not a blanket .git ban', async () => {
    const view = await readProjectFile(root, join(root, '.git', 'HEAD'), roots);
    expect(view.refusal).toBeNull();
    expect(view.text).toContain('refs/heads/main');
  });
});

describe('readProjectFile — every withholding is NAMED', () => {
  it('withholds a secret-named file without reading it', async () => {
    const view = await readProjectFile(root, join(root, '.env'), roots);
    expect(view.encoding).toBe('none');
    expect(view.refusal?.reason).toBe('secret-pattern');
    expect(JSON.stringify(view)).not.toContain('live_do_not_leak');
  });

  it('withholds .git/config, which routinely carries a token', async () => {
    const view = await readProjectFile(root, join(root, '.git', 'config'), roots);
    expect(view.refusal?.reason).toBe('secret-pattern');
    expect(JSON.stringify(view)).not.toContain('tok@');
  });

  it('re-applies the name policy to the RESOLVED path', async () => {
    // `notes.txt` -> `.env`. Checking only the requested name would leak it.
    const view = await readProjectFile(root, join(root, 'notes.txt'), roots);
    expect(view.refusal?.reason).toBe('secret-pattern');
    expect(JSON.stringify(view)).not.toContain('live_do_not_leak');
  });

  it('refuses a symlink whose target escapes the working directory', async () => {
    const view = await readProjectFile(root, join(root, 'escape-link'), roots);
    expect(view.refusal?.reason).toBe('outside-root');
    expect(JSON.stringify(view)).not.toContain('SECRET PAYLOAD');
  });

  it('does not leak where an escaping symlink landed', async () => {
    const view = await readProjectFile(root, join(root, 'escape-link'), roots);
    expect(view.refusal?.detail).not.toContain(outside);
    expect(view.refusal?.detail).not.toContain('stolen');
  });

  it('refuses a path outside the project outright', async () => {
    const view = await readProjectFile(root, join(outside, 'stolen.txt'), roots);
    expect(view.refusal?.reason).toBe('outside-root');
    expect(JSON.stringify(view)).not.toContain('SECRET PAYLOAD');
  });

  it('refuses a binary file with binary-not-previewable', async () => {
    const view = await readProjectFile(root, join(root, 'binary.bin'), roots);
    expect(view.encoding).toBe('none');
    expect(view.refusal?.reason).toBe('binary-not-previewable');
  });

  it('returns renderable media as base64 rather than refusing it', async () => {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    await writeFile(join(root, 'dot.png'), png);
    try {
      const view = await readProjectFile(root, join(root, 'dot.png'), roots);
      expect(view.encoding).toBe('base64');
      expect(view.base64).toBeTruthy();
      expect(view.refusal).toBeNull();
    } finally {
      await rm(join(root, 'dot.png'), { force: true });
    }
  });

  it('refuses an SVG as binary-or-text but NEVER inline media', async () => {
    // An SVG is a document. It must not come back as base64 media the UI would
    // put in an <img> on the app origin.
    await writeFile(join(root, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>', 'utf8');
    try {
      const view = await readProjectFile(root, join(root, 'logo.svg'), roots);
      expect(view.encoding).not.toBe('base64');
    } finally {
      await rm(join(root, 'logo.svg'), { force: true });
    }
  });

  it('refuses a file above the INLINE ceiling, which is not the attach ceiling', async () => {
    const fat = join(root, 'fat.txt');
    await writeFile(fat, Buffer.alloc(MAX_INLINE_BYTES + 1, 0x61));
    try {
      const view = await readProjectFile(root, fat, roots);
      expect(view.refusal?.reason).toBe('too-large');
      expect(view.sizeBytes).toBe(MAX_INLINE_BYTES + 1);
      expect(view.maxInlineBytes).toBe(MAX_INLINE_BYTES);
      expect(view.text).toBeNull();
    } finally {
      await rm(fat, { force: true });
    }
  });

  it('reports a missing file as not-a-file, not as an escape', async () => {
    const view = await readProjectFile(root, join(root, 'nope.txt'), roots);
    expect(view.refusal?.reason).toBe('not-a-file');
  });

  it('refuses a directory as not-a-file', async () => {
    const view = await readProjectFile(root, join(root, 'src'), roots);
    expect(view.refusal?.reason).toBe('not-a-file');
  });

  it('rejects a relative path rather than guessing a base', async () => {
    await expect(readProjectFile(root, 'src/index.ts', roots)).rejects.toThrow(/absolute/);
  });
});
