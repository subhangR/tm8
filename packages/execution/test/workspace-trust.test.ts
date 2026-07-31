// These two functions WRITE INTO THE USER'S REAL CLI CONFIGS (`~/.claude.json`,
// `~/.codex/config.toml`) — files holding credentials, model choices, notify
// hooks and MCP server definitions. The blast radius of a bug here is not a
// failed launch, it is a destroyed personal config, so the not-touching cases
// are tested at least as hard as the writing ones. Every test redirects the
// config location via env, so nothing here can reach the developer's own files.

import { mkdtemp, readFile, writeFile, stat, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { trustClaudeWorkspace, trustCodexWorkspace } from '../src/spawn/workspace-trust.js';

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
