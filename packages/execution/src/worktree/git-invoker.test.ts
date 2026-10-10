// A server-run git executes code out of an agent-writable directory — hooks,
// `core.fsmonitor`, aliases — so what that code can see is the server's to
// decide. Trust investigation 01a0db82 (fix #4, task 01a0e777): `runGit` spread
// `process.env` into the child, and on a deployed node that environment carries
// `TM8_DATABASE_URL`, a superuser connection string. These cells hold the two
// halves of the fix: an allow-listed env, and no hook or fsmonitor at all.
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { GIT_ENV_KEYS, gitChildEnv, runGit } from './git-invoker.js';

/** Every secret-shaped name the deployed server process has or could grow. */
const SERVER_SECRETS: Record<string, string> = {
  TM8_DATABASE_URL: 'postgres://tm8@127.0.0.1:5442/prod',
  TM8_DELIVERY_DATABASE_URL: 'postgres://tm8_delivery_worker@127.0.0.1:5442/prod',
  DATABASE_URL: 'postgres://x@127.0.0.1/y',
  PGPASSWORD: 'fake',
  PGHOST: '127.0.0.1',
  PGUSER: 'tm8',
  PGPASSFILE: '/tmp/pgpass',
  GH_TOKEN: 'ghp_fake',
  ANTHROPIC_API_KEY: 'sk-ant-fake',
  XDG_CONFIG_HOME: '/tmp/server-config',
};

function isForbidden(name: string): boolean {
  return (
    name in SERVER_SECRETS ||
    /DATABASE_URL$/.test(name) ||
    /^TM8_.*_URL$/.test(name) ||
    /^PG[A-Z]/.test(name)
  );
}

describe('gitChildEnv', () => {
  it('copies only allow-listed names from the parent, plus the two it sets itself', () => {
    const env = gitChildEnv({
      HOME: '/home/tm8',
      PATH: '/usr/bin:/bin',
      LANG: 'C.UTF-8',
      ...SERVER_SECRETS,
    });
    expect(Object.keys(env).sort()).toEqual(['GIT_EDITOR', 'GIT_TERMINAL_PROMPT', 'HOME', 'LANG', 'PATH']);
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
  });

  it('allow-lists nothing secret-shaped', () => {
    expect(GIT_ENV_KEYS.filter(isForbidden)).toEqual([]);
  });
});

describe('runGit in an agent-writable repository', () => {
  let root: string;
  let repo: string;
  let base: string;

  /** Fixture git, deliberately NOT runGit: the control must run hooks. */
  const raw = (cwd: string, ...args: string[]): string =>
    execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...gitChildEnv(), GIT_CONFIG_NOSYSTEM: '1' } });

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'tm8-git-invoker-'));
    repo = join(root, 'repo');
    raw(root, 'init', '-q', '-b', 'main', repo);
    raw(repo, 'config', 'user.email', 'invoker@test');
    raw(repo, 'config', 'user.name', 'Invoker');
    writeFileSync(join(repo, 'a.txt'), 'a\n');
    raw(repo, 'add', '.');
    raw(repo, 'commit', '-q', '-m', 'base');
    base = raw(repo, 'rev-parse', 'HEAD').trim();
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));
  afterEach(() => vi.unstubAllEnvs());

  it('hands the git child none of the server environment’s secrets', async () => {
    for (const [name, value] of Object.entries(SERVER_SECRETS)) vi.stubEnv(name, value);

    // A shell alias runs with exactly the env git itself was given, so it
    // reports what a planted hook or filter driver would have seen.
    const result = await runGit(['-C', repo, '-c', 'alias.envnames=!env', 'envnames']);
    expect(result.code).toBe(0);
    const names = result.stdout
      .split('\n')
      .map((line) => line.split('=')[0] ?? '')
      .filter((name) => name !== '');

    expect(names).toContain('PATH');
    expect(names.filter(isForbidden)).toEqual([]);
  });

  it('does not run a planted post-checkout hook on worktree add, nor a planted fsmonitor on status', async () => {
    const hookMarker = join(root, 'post-checkout-ran');
    const monitorMarker = join(root, 'fsmonitor-ran');
    const hook = join(repo, '.git', 'hooks', 'post-checkout');
    const monitor = join(root, 'fsmonitor.sh');
    writeFileSync(hook, `#!/bin/sh\ntouch '${hookMarker}'\n`);
    writeFileSync(monitor, `#!/bin/sh\ntouch '${monitorMarker}'\nexit 1\n`);
    chmodSync(hook, 0o755);
    chmodSync(monitor, 0o755);
    raw(repo, 'config', 'core.fsmonitor', monitor);

    // CONTROL: the same plants DO fire for a git that is not runGit, so a
    // green result below is the prefix working, not a hook that never could.
    raw(repo, 'worktree', 'add', '-q', '--detach', join(root, 'control'), base);
    raw(join(root, 'control'), 'status', '--porcelain');
    expect(existsSync(hookMarker)).toBe(true);
    expect(existsSync(monitorMarker)).toBe(true);
    rmSync(hookMarker);
    rmSync(monitorMarker);

    const added = await runGit(['-C', repo, 'worktree', 'add', '--detach', join(root, 'lane'), base]);
    expect(added.code).toBe(0);
    const status = await runGit(['-C', join(root, 'lane'), 'status', '--porcelain']);
    expect(status.code).toBe(0);

    expect(existsSync(hookMarker)).toBe(false);
    expect(existsSync(monitorMarker)).toBe(false);
  });
});
