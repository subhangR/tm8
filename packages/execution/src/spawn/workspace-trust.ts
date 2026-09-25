// Seed each agent CLI's per-workspace TRUST record before an unattended launch.
//
// BEHAVIORAL ORACLE: maestro's `claude-workspace-trust.ts` for the Claude half.
// The Codex half has no maestro counterpart — maestro never needed one because
// it launches Codex with `--dangerously-bypass-approvals-and-sandbox`, which
// suppresses the dialog as a side effect. tm8 honours the persona's access mode,
// so its DEFAULT Codex launch (`--ask-for-approval never --sandbox
// workspace-write`) reaches the dialog. Measured 2026-07-30 by attaching to the
// session's PTY WebSocket, which is the only place the refusal was visible:
//
//   > You are in /Users/subhang/.local/share/tm8/workspace
//   > Do you trust the contents of this directory?
//   > › 1. Yes, continue   2. No, quit
//
// WHY THIS EXISTS AT ALL. Both CLIs ask "do you trust this directory?" on first
// access. tm8's launch is unattended by definition: the child is a PTY whose
// only reader is a browser xterm, and the dialog blocks before the agent
// produces a single token. The session row says `running`, the concurrency slot
// is held, and nothing ever happens — the same silent-hang signature as the
// prompt bug this seam was fixed for, and just as invisible from the outside.
//
// For Claude it was previously MASKED, not absent: `buildAgentCommand` emitted
// `--dangerously-skip-permissions` unconditionally, and that flag also implies
// trust. Now that the permission posture is honoured, a directory Claude has
// never seen reaches the dialog again. The old code comment even noted the
// asymmetry — "pre-trusting the folder alone does NOT cover the tool prompts" —
// which is true, and is why this is a COMPLEMENT to the permission flags rather
// than a replacement for them.
//
// tm8's own authorization is unchanged and is what makes this legitimate:
// `execution_spawn` refuses to launch into an untrusted project, so by the time
// this runs, an operator has explicitly vouched for this working directory. This
// records a decision a human already made; it does not make one. Both functions
// therefore REFUSE TO OVERWRITE an existing entry — if the CLI's own config
// already has an opinion about this directory, that opinion wins.

import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';

const execFileAsync = promisify(execFile);

type ClaudeConfig = Record<string, unknown> & {
  projects?: Record<string, Record<string, unknown>>;
};

// Atomic rename prevents torn files, but it does not prevent a lost update:
// two launches can both read version N, add different workspaces, and then
// rename N+A / N+B over each other. Serialize the tiny read-modify-write
// section so all eight permitted concurrent launches retain their trust row.
let trustUpdateTail: Promise<void> = Promise.resolve();

async function acquireTrustUpdate(): Promise<() => void> {
  const previous = trustUpdateTail;
  let release!: () => void;
  trustUpdateTail = new Promise<void>((resolveTail) => {
    release = resolveTail;
  });
  await previous;
  return release;
}

/**
 * What {@link trustClaudeWorkspace} concluded. Callers on the launch path
 * ignore it (seeding is best-effort); tests and the launch log read it.
 *
 * - `trusted` — every requested entry was on disk when last re-read.
 * - `unverified` — tm8 wrote, and a concurrent rewrite dropped an entry again
 *   on every attempt. The launch proceeds; the PTY trust watchdog is the
 *   backstop for exactly this case.
 * - `skipped` — opt-out, malformed config, or an I/O error: nothing written.
 */
export type ClaudeTrustOutcome = 'trusted' | 'unverified' | 'skipped';

export interface ClaudeTrustOptions {
  /**
   * A long-lived directory whose trust Claude also consults for `cwd` — the
   * scratch root, or a worktree's main repository root. See
   * {@link resolveClaudeTrustRoot} for which, and why.
   */
  trustRoot?: string | null;
}

/** Write-then-verify rounds before giving up to the watchdog. */
const TRUST_ASSERT_ATTEMPTS = 3;

/**
 * Record "trusted" for `cwd` (and its stable trust root) in Claude's user
 * config, then RE-READ and re-assert until the entries are really on disk.
 *
 * WHY WRITE-THEN-VERIFY, and why the ancestor. `~/.claude.json` is shared by
 * every claude process on the account, and a claude that is BOOTING writes back
 * a config snapshot it read seconds earlier. Measured 2026-09-25 on the live
 * fleet: of 40 fresh trust entries planted exactly as below, 0 were lost to the
 * 24 steady-state claude processes, and 8 were lost within 0.4–7.7s once other
 * claude processes were STARTING — the fleet's normal state whenever lanes
 * spawn together. A lost leaf entry is a lane parked forever at the trust
 * dialog (task 01a0d79e-1b86). Atomic rename cannot help: it prevents torn
 * files, not lost updates, and the lost update is the other process's.
 *
 * The trust root is the prevention. A lost update only drops entries added
 * AFTER the stale writer's read, so an entry that has sat in the file for
 * longer than any claude's boot window is in every snapshot and survives every
 * rewrite. The root is written once and then covers every later lane under it,
 * whatever happens to that lane's own leaf entry. The leaf is still written,
 * so a future claude that stopped honouring the root degrades to today's
 * behaviour rather than to a hang on every launch.
 *
 * The re-read narrows the remaining window (the first lane of a project, or a
 * project-mode checkout) to the moment between tm8's verify and claude's own
 * read of the file; the PTY watchdog in SpawnService covers that remainder.
 *
 * DELIBERATELY BEST-EFFORT, and every early return below is a case where doing
 * nothing is better than guessing:
 *
 * - `TM8_AUTO_TRUST_WORKSPACE=false` — the operator opt-out. Honoured first, so
 *   it cannot be bypassed by any later condition.
 * - config file MALFORMED — returns without writing. A file tm8 cannot parse is
 *   a file tm8 must not overwrite; the user's `.claude.json` holds far more than
 *   this one bit, and clobbering it to fix a dialog is a bad trade. Distinguished
 *   from ABSENT (which is safe to create) by re-reading: a successful read that
 *   failed to parse is malformed, a failed read is missing.
 * - already trusted — returns without writing, so a launch storm does not
 *   rewrite the config once per session.
 *
 * The write is ATOMIC (temp file + rename) because concurrent spawns race here
 * by construction: the session cap allows several launches at once, they all
 * target the same `~/.claude.json`, and a torn write would corrupt the file this
 * function is careful not to overwrite. `0o600` because the same file carries
 * the user's Claude credentials and history.
 *
 * Never throws. Trust seeding is a UX safeguard, not a launch prerequisite — if
 * it fails, Claude falls back to its normal interactive trust flow, which the
 * watchdog then answers.
 */
export async function trustClaudeWorkspace(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  options: ClaudeTrustOptions = {},
): Promise<ClaudeTrustOutcome> {
  if (env['TM8_AUTO_TRUST_WORKSPACE'] === 'false') return 'skipped';

  const release = await acquireTrustUpdate();
  try {
    const configDir = env['CLAUDE_CONFIG_DIR'] || env['HOME'] || homedir();
    const configPath = join(configDir, '.claude.json');
    // `realpath` because Claude keys projects by the resolved path, and tm8
    // working directories are routinely reached through symlinks (the scratch
    // root, /tmp on macOS). Keying by the unresolved path writes a trust entry
    // Claude will never look up.
    const canonical = (path: string): Promise<string> =>
      realpath(resolve(path)).catch(() => resolve(path));
    const workspaces = [await canonical(cwd)];
    if (options.trustRoot) workspaces.push(await canonical(options.trustRoot));

    for (let attempt = 1; attempt <= TRUST_ASSERT_ATTEMPTS; attempt += 1) {
      const config = await readClaudeConfig(configPath);
      if (config === 'malformed') return 'skipped';

      const projects =
        config.projects && typeof config.projects === 'object' ? config.projects : {};
      const missing = workspaces.filter(
        (workspace) => projects[workspace]?.['hasTrustDialogAccepted'] !== true,
      );
      // The verify half: on attempt 2+ this is the re-read of our own write.
      if (missing.length === 0) return 'trusted';

      const nextProjects = { ...projects };
      for (const workspace of missing) {
        const current =
          projects[workspace] && typeof projects[workspace] === 'object' ? projects[workspace] : {};
        nextProjects[workspace] = { ...current, hasTrustDialogAccepted: true };
      }
      await mkdir(dirname(configPath), { recursive: true });
      await writeFileAtomic(
        configPath,
        `${JSON.stringify({ ...config, projects: nextProjects }, null, 2)}\n`,
      );
    }
    // The last write has not been re-read yet; one final look decides.
    const final = await readClaudeConfig(configPath);
    if (final === 'malformed') return 'unverified';
    return workspaces.every((w) => final.projects?.[w]?.['hasTrustDialogAccepted'] === true)
      ? 'trusted'
      : 'unverified';
  } catch {
    // See the doc comment: a UX safeguard must not become a launch prerequisite.
    return 'skipped';
  } finally {
    release();
  }
}

/**
 * What {@link completeClaudeOnboarding} concluded.
 *
 * - `completed` — tm8 set `hasCompletedOnboarding` on a logged-in config.
 * - `unchanged` — already complete, or no login to vouch for: nothing written.
 * - `skipped` — malformed config or an I/O error: nothing written.
 */
export type ClaudeOnboardingOutcome = 'completed' | 'unchanged' | 'skipped';

/**
 * Mark Claude's first-run onboarding complete for a config home that ALREADY
 * holds a login, so the lane boots to the composer instead of the login screen.
 *
 * WHY. A member connects their Anthropic account through tm8's
 * `claude auth login` terminal. That persists the token (keychain /
 * `.credentials.json`) and `oauthAccount`, but never `hasCompletedOnboarding`
 * — only the interactive TUI writes that. So the first interactive `claude`
 * on the fresh credential home runs the whole first-run flow, INCLUDING
 * "Select login method", and the member is asked to sign in a second time
 * right after tm8 told them they were connected. Measured 2026-09-25 on the
 * desktop node: login verified 20:04:01Z; lane launched 20:09:33Z with
 * `oauthAccount` present and no onboarding flag; the keychain item for that
 * home was re-CREATED at 20:10:21Z by the in-lane login. Space credential
 * homes already seed the flag (`space-credential-session-home.ts`); this
 * covers member homes and the node's own home, at every launch, so homes
 * connected before this fix are repaired too.
 *
 * GATED ON `oauthAccount`: the flag is only a claim that login is done. A home
 * with no login keeps Claude's own onboarding, whose login step is then the
 * only way in — skipping it would leave the lane at "please run /login".
 *
 * Same file, same lock and same atomic write as {@link trustClaudeWorkspace};
 * never throws, never overwrites a config it cannot parse.
 */
export async function completeClaudeOnboarding(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ClaudeOnboardingOutcome> {
  const release = await acquireTrustUpdate();
  try {
    const configDir = env['CLAUDE_CONFIG_DIR'] || env['HOME'] || homedir();
    const configPath = join(configDir, '.claude.json');
    const config = await readClaudeConfig(configPath);
    if (config === 'malformed') return 'skipped';
    if (config['hasCompletedOnboarding'] === true) return 'unchanged';
    const account = config['oauthAccount'];
    if (!account || typeof account !== 'object') return 'unchanged';
    await writeFileAtomic(
      configPath,
      `${JSON.stringify({ ...config, hasCompletedOnboarding: true }, null, 2)}\n`,
    );
    return 'completed';
  } catch {
    return 'skipped';
  } finally {
    release();
  }
}

/** Parsed config, `{}` when ABSENT (safe to create), `'malformed'` when present
 *  but unparseable (must never be overwritten). */
async function readClaudeConfig(configPath: string): Promise<ClaudeConfig | 'malformed'> {
  let text: string;
  try {
    text = await readFile(configPath, 'utf8');
  } catch {
    return {}; // genuinely absent — safe to create
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as ClaudeConfig)
      : 'malformed';
  } catch {
    return 'malformed'; // present but unparseable — leave it alone
  }
}

/**
 * The stable directory to trust alongside a lane's own, or null.
 *
 * Claude Code decides trust differently for the two kinds of lane directory
 * tm8 creates, and each answer here is the one Claude actually consults —
 * all MEASURED on 2.1.280 over a real PTY (2026-09-25), each against a
 * fresh-directory control that did show the dialog:
 *
 * - A plain directory is trusted when it or ANY PARENT carries the bit. So a
 *   SCRATCH lane (`<dataDir>/scratch/<session>`, never a repository) is
 *   covered by the 0700 scratch root, which holds nothing but tm8 scratch.
 * - A GIT WORKTREE does NOT inherit from its parent directory: trusting
 *   `<dataDir>/worktrees/<project>` still showed the dialog. It inherits from
 *   its MAIN REPOSITORY ROOT instead — trusting that root booted a worktree at
 *   an unrelated path straight to the composer, and it is also where Claude
 *   itself records the bit when a person answers "Yes" in a worktree. So a
 *   WORKTREE lane is covered by the project's registered checkout — but only
 *   when that checkout IS the repository root (a registered subdirectory is
 *   not what Claude looks up) and only for a project an operator marked
 *   `trusted`. A per-spawn `--confirm-untrusted` consent covers that one
 *   launch; it is not a licence to trust the checkout for good.
 * - A PROJECT-mode lane runs in the registered checkout itself, which is its
 *   own long-lived entry after the first launch. No second directory.
 *
 * Paths are compared CANONICALLY: the worktree manager realpaths its root
 * while `dataDir` and a project's `workingDir` may be spelled through a
 * symlink (`/tmp` on macOS), and containment must not fail open or closed on
 * spelling.
 */
export async function resolveClaudeTrustRoot(
  cwd: string,
  workdirMode: 'worktree' | 'scratch' | 'project' | string,
  dataDir: string,
  project: { workingDir: string; trust: string } | null,
): Promise<string | null> {
  const canonical = (path: string): Promise<string> =>
    realpath(resolve(path)).catch(() => resolve(path));
  if (workdirMode === 'scratch') {
    const [parent, root] = await Promise.all([canonical(dirname(cwd)), canonical(dataDir)]);
    if (parent === root || !parent.startsWith(`${root}${sep}`)) return null;
    return parent;
  }
  if (workdirMode === 'worktree') {
    if (!project || project.trust !== 'trusted') return null;
    const repoRoot = await mainRepositoryRoot(cwd);
    if (repoRoot === null) return null;
    const [root, registered] = await Promise.all([canonical(repoRoot), canonical(project.workingDir)]);
    return root === registered ? root : null;
  }
  return null;
}

/** The main worktree's root for a (linked) worktree, from git's common dir. */
async function mainRepositoryRoot(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, 'rev-parse', '--git-common-dir'], {
      timeout: 5_000,
    });
    const commonDir = resolve(cwd, stdout.trim());
    // A bare or unusual layout has no main checkout for Claude to key on.
    return basename(commonDir) === '.git' ? dirname(commonDir) : null;
  } catch {
    return null;
  }
}

/**
 * Record `trust_level = "trusted"` for `cwd` in Codex's `config.toml`.
 *
 * APPEND-ONLY, and that is the whole design. `config.toml` is TOML, tm8 has no
 * TOML parser, and this file carries the user's model choice, notify hooks and
 * MCP server definitions. Round-tripping it through a hand-rolled parser to set
 * one key would risk destroying all of that to fix a dialog — a bad trade. So:
 * detect whether a `[projects."<path>"]` table already exists textually, and if
 * it does not, append a new one. TOML tables are order-independent, so appending
 * is semantically identical to inserting, and every byte the user wrote is
 * preserved untouched.
 *
 * The existence check is what makes append-only safe: it means this never writes
 * a DUPLICATE table (which is a TOML parse error and would break Codex outright)
 * and never overrides a directory the user has already ruled on — including one
 * they deliberately marked untrusted.
 */
export async function trustCodexWorkspace(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (env['TM8_AUTO_TRUST_WORKSPACE'] === 'false') return;

  const release = await acquireTrustUpdate();
  try {
    const configDir = env['CODEX_HOME'] || join(env['HOME'] || homedir(), '.codex');
    const configPath = join(configDir, 'config.toml');
    const workspace = await realpath(resolve(cwd)).catch(() => resolve(cwd));

    let existing = '';
    try {
      existing = await readFile(configPath, 'utf8');
    } catch {
      existing = ''; // absent — safe to create
    }

    // Match the table header for exactly this path. TOML permits both
    // `[projects."/p"]` and `[projects.'/p']`, and arbitrary inner whitespace,
    // so the probe is a regex over an escaped path rather than an `includes`.
    const escaped = workspace.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const header = new RegExp(`^\\s*\\[\\s*projects\\s*\\.\\s*["']${escaped}["']\\s*\\]`, 'm');
    if (header.test(existing)) return;

    // TOML strings take backslash escapes, so a path containing `"` or `\` must
    // be escaped or the appended table is unparseable — and an unparseable
    // config.toml stops Codex from launching at all, which is strictly worse
    // than the dialog this function exists to avoid.
    const literal = workspace.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const separator = existing === '' || existing.endsWith('\n') ? '' : '\n';
    const addition = `${separator}\n[projects."${literal}"]\ntrust_level = "trusted"\n`;

    await mkdir(configDir, { recursive: true });
    await writeFileAtomic(configPath, existing + addition);
  } catch {
    // Same contract as the Claude half: best-effort, never fatal.
  } finally {
    release();
  }
}

/**
 * Replace a config file's contents without ever leaving a torn one behind.
 *
 * Concurrent spawns race here BY CONSTRUCTION — the session cap allows several
 * launches at once and they all target the same per-user config — so a plain
 * `writeFile` can interleave and corrupt the very file these functions take
 * pains not to damage. `rename` within a directory is atomic, so a reader sees
 * either the old file or the new one. `0o600` because both files carry
 * credentials (Claude's `.claude.json`) or private hook paths (Codex's TOML).
 */
async function writeFileAtomic(configPath: string, contents: string): Promise<void> {
  const tempPath = `${configPath}.tm8-${String(process.pid)}-${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tempPath, contents, { mode: 0o600 });
  await rename(tempPath, configPath);
}
