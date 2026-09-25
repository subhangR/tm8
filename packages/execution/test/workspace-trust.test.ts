// These two functions WRITE INTO THE USER'S REAL CLI CONFIGS (`~/.claude.json`,
// `~/.codex/config.toml`) — files holding credentials, model choices, notify
// hooks and MCP server definitions. The blast radius of a bug here is not a
// failed launch, it is a destroyed personal config, so the not-touching cases
// are tested at least as hard as the writing ones. Every test redirects the
// config location via env, so nothing here can reach the developer's own files.

import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, writeFile, stat, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  resolveClaudeTrustRoot,
  trustClaudeWorkspace,
  trustCodexWorkspace,
} from '../src/spawn/workspace-trust.js';

async function sandbox(): Promise<{ home: string; workspace: string }> {
  const home = await mkdtemp(join(tmpdir(), 'tm8-trust-'));
  const workspace = join(home, 'workspace');
  await mkdir(workspace, { recursive: true });
  return { home, workspace };
}

describe('trustClaudeWorkspace', () => {
  it('creates the config and records the trust bit when none exists', async () => {
    const { home, workspace } = await sandbox();
    await trustClaudeWorkspace(workspace, { HOME: home });
    const config = JSON.parse(await readFile(join(home, '.claude.json'), 'utf8'));
    // Keyed by the REALPATH: on macOS $TMPDIR is a symlink, so a config keyed by
    // the unresolved path would be one Claude never looks up.
    const keys = Object.keys(config.projects);
    expect(keys).toHaveLength(1);
    expect(config.projects[keys[0]!].hasTrustDialogAccepted).toBe(true);
  });

  it('preserves every unrelated key and project already in the config', async () => {
    const { home, workspace } = await sandbox();
    const configPath = join(home, '.claude.json');
    await writeFile(
      configPath,
      JSON.stringify({
        oauthAccount: { emailAddress: 'someone@example.com' },
        projects: { '/other/repo': { hasTrustDialogAccepted: true, history: ['a'] } },
      }),
    );
    await trustClaudeWorkspace(workspace, { HOME: home });
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    expect(config.oauthAccount.emailAddress).toBe('someone@example.com');
    expect(config.projects['/other/repo'].history).toEqual(['a']);
  });

  it('leaves a MALFORMED config completely alone', async () => {
    // The important case. A file tm8 cannot parse is a file tm8 must not
    // overwrite — the user's credentials live in it, and losing them to fix a
    // dialog is far worse than the dialog.
    const { home, workspace } = await sandbox();
    const configPath = join(home, '.claude.json');
    await writeFile(configPath, '{ this is not json');
    await trustClaudeWorkspace(workspace, { HOME: home });
    expect(await readFile(configPath, 'utf8')).toBe('{ this is not json');
  });

  it('honours the operator opt-out and writes nothing at all', async () => {
    const { home, workspace } = await sandbox();
    await trustClaudeWorkspace(workspace, { HOME: home, TM8_AUTO_TRUST_WORKSPACE: 'false' });
    await expect(stat(join(home, '.claude.json'))).rejects.toThrow();
  });

  it('writes the config 0600 — it sits next to credentials', async () => {
    const { home, workspace } = await sandbox();
    await trustClaudeWorkspace(workspace, { HOME: home });
    const mode = (await stat(join(home, '.claude.json'))).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('retains both trust rows when two launches update the config concurrently', async () => {
    const { home, workspace } = await sandbox();
    const second = join(home, 'workspace-two');
    await mkdir(second, { recursive: true });

    await Promise.all([
      trustClaudeWorkspace(workspace, { HOME: home }),
      trustClaudeWorkspace(second, { HOME: home }),
    ]);

    const config = JSON.parse(await readFile(join(home, '.claude.json'), 'utf8'));
    expect(Object.keys(config.projects)).toHaveLength(2);
  });
});

describe('resolveClaudeTrustRoot', () => {
  // Trusting a directory trusts what Claude resolves through it, so only
  // directories tm8 owns, or the checkout an operator registered AND trusted,
  // may qualify. Each null below is a directory tm8 must not vouch for.
  function repoWithWorktree(home: string): { repo: string; lane: string } {
    const repo = join(home, 'code', 'repo');
    const lane = join(home, 'data', 'worktrees', 'project-1', 'lane-1');
    execFileSync('mkdir', ['-p', repo]);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
    git('init', '--initial-branch', 'main');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'root');
    git('worktree', 'add', '-b', 'lane-1', lane);
    return { repo, lane };
  }

  it("answers a worktree lane's MAIN REPOSITORY ROOT when it is the registered, trusted checkout", async () => {
    // Not the worktree's parent directory: Claude does not walk up from a git
    // worktree (measured), it consults the main repository root.
    const { home } = await sandbox();
    const { repo, lane } = repoWithWorktree(home);
    const root = await resolveClaudeTrustRoot(lane, 'worktree', join(home, 'data'), {
      workingDir: repo,
      trust: 'trusted',
    });
    expect(root).toBe(await realpath(repo));
  });

  it('refuses the repository root of a project that is not tm8-trusted', async () => {
    // A --confirm-untrusted launch consents to ONE lane, not to the checkout.
    const { home } = await sandbox();
    const { repo, lane } = repoWithWorktree(home);
    expect(
      await resolveClaudeTrustRoot(lane, 'worktree', join(home, 'data'), { workingDir: repo, trust: 'untrusted' }),
    ).toBeNull();
    expect(await resolveClaudeTrustRoot(lane, 'worktree', join(home, 'data'), null)).toBeNull();
  });

  it('refuses when the registered directory is not the repository root Claude looks up', async () => {
    const { home } = await sandbox();
    const { repo, lane } = repoWithWorktree(home);
    await mkdir(join(repo, 'sub'), { recursive: true });
    expect(
      await resolveClaudeTrustRoot(lane, 'worktree', join(home, 'data'), {
        workingDir: join(repo, 'sub'),
        trust: 'trusted',
      }),
    ).toBeNull();
  });

  it('answers null for a worktree-mode path that is not a git worktree at all', async () => {
    const { home } = await sandbox();
    const lane = join(home, 'data', 'worktrees', 'p', 'lane');
    await mkdir(lane, { recursive: true });
    expect(
      await resolveClaudeTrustRoot(lane, 'worktree', join(home, 'data'), { workingDir: lane, trust: 'trusted' }),
    ).toBeNull();
  });

  it('answers the scratch root for a scratch lane', async () => {
    const { home } = await sandbox();
    const lane = join(home, 'data', 'scratch', 'session-1');
    await mkdir(lane, { recursive: true });
    const root = await resolveClaudeTrustRoot(lane, 'scratch', join(home, 'data'), null);
    expect(root).toBe(await realpath(join(home, 'data', 'scratch')));
  });

  it('refuses a scratch parent outside the data dir, the data dir itself, and a look-alike sibling', async () => {
    const { home } = await sandbox();
    const stray = join(home, 'elsewhere', 'lane');
    const direct = join(home, 'data', 'lane');
    const sibling = join(home, 'data-other', 'scratch', 'lane');
    for (const dir of [stray, direct, sibling]) await mkdir(dir, { recursive: true });
    for (const dir of [stray, direct, sibling]) {
      expect(await resolveClaudeTrustRoot(dir, 'scratch', join(home, 'data'), null)).toBeNull();
    }
  });

  it('compares canonically when the data dir is spelled through a symlink', async () => {
    const { home } = await sandbox();
    await mkdir(join(home, 'real-data', 'scratch', 'lane'), { recursive: true });
    await symlink(join(home, 'real-data'), join(home, 'link-data'));
    const root = await resolveClaudeTrustRoot(
      join(home, 'real-data', 'scratch', 'lane'),
      'scratch',
      join(home, 'link-data'),
      null,
    );
    expect(root).toBe(await realpath(join(home, 'real-data', 'scratch')));
  });

  it("never answers anything for a project-mode lane — it runs in the operator's checkout", async () => {
    const { home } = await sandbox();
    const { repo } = repoWithWorktree(home);
    expect(
      await resolveClaudeTrustRoot(repo, 'project', join(home, 'data'), { workingDir: repo, trust: 'trusted' }),
    ).toBeNull();
  });
});

describe('trustCodexWorkspace', () => {
  it('appends a projects table, preserving the existing TOML byte for byte', async () => {
    const { home, workspace } = await sandbox();
    const configPath = join(home, '.codex', 'config.toml');
    await mkdir(join(home, '.codex'), { recursive: true });
    const original = 'model = "gpt-5.4-mini"\nnotify = ["/some/hook"]\n';
    await writeFile(configPath, original);

    await trustCodexWorkspace(workspace, { HOME: home });
    const after = await readFile(configPath, 'utf8');
    expect(after.startsWith(original)).toBe(true);
    expect(after).toMatch(/\[projects\."[^"]*workspace"\]\ntrust_level = "trusted"\n$/);
  });

  it('is IDEMPOTENT — a second call must not append a duplicate table', async () => {
    // A duplicate TOML table is a PARSE ERROR, which would stop Codex launching
    // at all: strictly worse than the dialog this function exists to avoid.
    const { home, workspace } = await sandbox();
    await trustCodexWorkspace(workspace, { HOME: home });
    await trustCodexWorkspace(workspace, { HOME: home });
    const after = await readFile(join(home, '.codex', 'config.toml'), 'utf8');
    expect(after.match(/\[projects\./g)).toHaveLength(1);
  });

  it('does not override a directory the user already ruled on', async () => {
    const { home, workspace } = await sandbox();
    const configPath = join(home, '.codex', 'config.toml');
    await mkdir(join(home, '.codex'), { recursive: true });
    // Deliberately marked UNtrusted. tm8 records decisions; it does not make
    // them, so this must survive untouched.
    const real = await (await import('node:fs/promises')).realpath(workspace);
    await writeFile(configPath, `[projects."${real}"]\ntrust_level = "untrusted"\n`);
    await trustCodexWorkspace(workspace, { HOME: home });
    expect(await readFile(configPath, 'utf8')).toContain('trust_level = "untrusted"');
    expect(await readFile(configPath, 'utf8')).not.toContain('"trusted"');
  });

  it('recognises the single-quoted table form TOML also permits', async () => {
    const { home, workspace } = await sandbox();
    const configPath = join(home, '.codex', 'config.toml');
    await mkdir(join(home, '.codex'), { recursive: true });
    const real = await (await import('node:fs/promises')).realpath(workspace);
    await writeFile(configPath, `[projects.'${real}']\ntrust_level = "trusted"\n`);
    await trustCodexWorkspace(workspace, { HOME: home });
    expect((await readFile(configPath, 'utf8')).match(/\[projects\./g)).toHaveLength(1);
  });

  it('separates an appended table from a file that does not end in a newline', async () => {
    // Without the separator the table header would be glued onto the last line
    // and the file would no longer parse.
    const { home, workspace } = await sandbox();
    const configPath = join(home, '.codex', 'config.toml');
    await mkdir(join(home, '.codex'), { recursive: true });
    await writeFile(configPath, 'model = "gpt-5.4-mini"');
    await trustCodexWorkspace(workspace, { HOME: home });
    const after = await readFile(configPath, 'utf8');
    expect(after).toContain('model = "gpt-5.4-mini"\n\n[projects.');
  });

  it('honours the operator opt-out', async () => {
    const { home, workspace } = await sandbox();
    await trustCodexWorkspace(workspace, { HOME: home, TM8_AUTO_TRUST_WORKSPACE: 'false' });
    await expect(stat(join(home, '.codex', 'config.toml'))).rejects.toThrow();
  });

  it('respects CODEX_HOME over HOME', async () => {
    const { home, workspace } = await sandbox();
    const codexHome = join(home, 'custom-codex');
    await trustCodexWorkspace(workspace, { HOME: home, CODEX_HOME: codexHome });
    expect(await readFile(join(codexHome, 'config.toml'), 'utf8')).toContain('trust_level');
  });

  it('retains both tables when two launches update the config concurrently', async () => {
    const { home, workspace } = await sandbox();
    const second = join(home, 'workspace-two');
    await mkdir(second, { recursive: true });

    await Promise.all([
      trustCodexWorkspace(workspace, { HOME: home }),
      trustCodexWorkspace(second, { HOME: home }),
    ]);

    const config = await readFile(join(home, '.codex', 'config.toml'), 'utf8');
    expect(config.match(/\[projects\./g)).toHaveLength(2);
  });
});
