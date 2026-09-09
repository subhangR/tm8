import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copySource, fingerprint } from '../migrate.mjs';
const exec = promisify(execFile);
const git = async (cwd, ...args) => (await exec('git', ['-C', cwd, ...args])).stdout.trim();

test('migration copy preserves history, staged and unstaged edits, untracked files and symlinks', async () => {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'tm8-migration-'));
  try {
    const source = path.join(dir, 'source'); await fs.mkdir(source);
    await git(source, 'init', '-b', 'main'); await git(source, 'config', 'user.name', 'Fixture'); await git(source, 'config', 'user.email', 'fixture@example.test');
    await fs.writeFile(path.join(source, 'file.txt'), 'committed\n'); await git(source, 'add', '.'); await git(source, 'commit', '-m', 'initial');
    await fs.writeFile(path.join(source, 'file.txt'), 'staged\n'); await git(source, 'add', '.'); await fs.writeFile(path.join(source, 'file.txt'), 'unstaged\n');
    await fs.writeFile(path.join(source, 'private.txt'), 'private untracked content'); await fs.symlink('file.txt', path.join(source, 'link'));
    const before = await fingerprint(source), status = await git(source, 'status', '--porcelain');
    const target = path.join(dir, 'target'); await copySource(source, target);
    assert.equal(await fingerprint(target), before); assert.equal(await fingerprint(source), before);
    assert.equal(await git(target, 'status', '--porcelain'), status);
    assert.equal(await git(target, 'show', ':file.txt'), 'staged');
    assert.equal(await git(target, 'rev-parse', 'HEAD'), await git(source, 'rev-parse', 'HEAD'));
    assert.notEqual((await fs.stat(path.join(source, '.git/index'))).ino, (await fs.stat(path.join(target, '.git/index'))).ino);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
test('a linked worktree becomes a self-contained Git repository and nested project roots are refused', async () => {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'tm8-worktree-migration-'));
  try {
    const source = path.join(dir, 'source'); await fs.mkdir(source);
    await git(source, 'init', '-b', 'main'); await git(source, 'config', 'user.name', 'Fixture'); await git(source, 'config', 'user.email', 'fixture@example.test');
    await fs.writeFile(path.join(source, 'file'), 'initial'); await git(source, 'add', '.'); await git(source, 'commit', '-m', 'initial');
    const worktree = path.join(dir, 'worktree'); await git(source, 'worktree', 'add', '-b', 'feature', worktree);
    await fs.writeFile(path.join(worktree, 'file'), 'staged in worktree'); await git(worktree, 'add', '.');
    const target = path.join(dir, 'target'); await copySource(worktree, target);
    assert.ok((await fs.stat(path.join(target, '.git'))).isDirectory());
    assert.equal(await git(target, 'show', ':file'), 'staged in worktree');
    assert.equal(await git(target, 'branch', '--show-current'), 'feature');
    const nested = path.join(source, 'nested'); await fs.mkdir(nested);
    await assert.rejects(copySource(nested, path.join(dir, 'refused')), /nested in another/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
