import type { Harness } from '../harness/types.js';
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
import { dirname, join, resolve } from 'node:path';
import { mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';

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
 * Record "trusted" for `cwd` in Claude's user config, if it is not already.
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
 * it fails, Claude falls back to its normal interactive trust flow, which is
 * exactly the behaviour tm8 had before this existed.
 */
export async function trustClaudeWorkspace(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (env['TM8_AUTO_TRUST_WORKSPACE'] === 'false') return;

  const release = await acquireTrustUpdate();
  try {
    const configDir = env['CLAUDE_CONFIG_DIR'] || env['HOME'] || homedir();
    const configPath = join(configDir, '.claude.json');
    // `realpath` because Claude keys projects by the resolved path, and tm8
    // working directories are routinely reached through symlinks (the scratch
    // root, /tmp on macOS). Keying by the unresolved path writes a trust entry
    // Claude will never look up.
    const workspace = await realpath(resolve(cwd)).catch(() => resolve(cwd));

    let config: ClaudeConfig = {};
    try {
      config = JSON.parse(await readFile(configPath, 'utf8')) as ClaudeConfig;
    } catch {
      try {
        await readFile(configPath, 'utf8');
        return; // present but unparseable — leave it alone
      } catch {
        config = {}; // genuinely absent — safe to create
      }
    }

    const projects =
      config.projects && typeof config.projects === 'object' ? config.projects : {};
    const current =
      projects[workspace] && typeof projects[workspace] === 'object' ? projects[workspace] : {};
    if (current['hasTrustDialogAccepted'] === true) return;

    const next: ClaudeConfig = {
      ...config,
      projects: {
        ...projects,
        [workspace]: { ...current, hasTrustDialogAccepted: true },
      },
    };

    await mkdir(dirname(configPath), { recursive: true });
    await writeFileAtomic(configPath, `${JSON.stringify(next, null, 2)}\n`);
  } catch {
    // See the doc comment: a UX safeguard must not become a launch prerequisite.
  } finally {
    release();
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

/**
 * Pre-answer the harness's first-run workspace-trust dialog, if it has one.
 *
 * A REGISTRY, not a pair of `if`s. The two call sites (spawn and resume) used to
 * each carry `if (agentTool === 'claude-code') … if (agentTool === 'codex') …`,
 * which is four places a third harness could be forgotten — and forgetting it
 * here is silent: the child comes up untrusted and blocks on a dialog nobody is
 * watching, having already been recorded as `running`.
 */
const WORKSPACE_TRUST_WRITERS: Readonly<
  Record<string, ((cwd: string, env: NodeJS.ProcessEnv) => Promise<unknown>) | null>
> = Object.freeze({
  claude: trustClaudeWorkspace,
  codex: trustCodexWorkspace,
  none: null,
});

export async function trustWorkspaceForHarness(
  harness: Harness,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const writer = WORKSPACE_TRUST_WRITERS[harness.capabilities.workspaceTrust];
  if (writer) await writer(cwd, env);
}
