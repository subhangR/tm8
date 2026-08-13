// @tm8/execution — the environment a VANILLA TERMINAL runs in.
//
// Third sibling of `composeEnv` (agents) and `composeCredentialEnv` (vendor
// logins), and a separate function for the reason stated at the top of
// credential-env.ts: no boolean parameter should ever decide whether a process
// gets an agent's credentials. That argument applies here with one extra turn
// of the screw.
//
// WHY A VANILLA TERMINAL MUST NOT RECEIVE `TM8_AGENT_TOKEN`. `composeEnv` emits
// it, and it is the SPAWNING HUMAN'S FULL IDENTITY rather than a reduced
// principal (sub-doc 14, channel C7) — `acting_as_team_member_id` constrains
// `internal.resolve_actor` and nothing else. An agent session is a program tm8
// composed the prompt for; a vanilla terminal is a shell prompt a person types
// arbitrary commands into. Handing that shell an identity token would make
// `curl` against the local API, run by anyone who can reach the terminal, act
// as the member who opened it. Two functions cannot make that mistake; a flag
// on one function can, and both arms would typecheck.
//
// WHAT IS INHERITED AND WHY EACH ONE. `PtyHostService` documents that the
// caller supplies the COMPLETE child environment and that merging `process.env`
// would leak database URLs and operator secrets. So this is built key by key,
// and the list is short on purpose: a terminal needs to find its binaries, know
// its terminal type, and render text in the right locale. It does not need to
// know how to reach the database.
//
// THE ABSENCES, none of them accidental:
//
//   * `TM8_AGENT_TOKEN`, `TM8_SESSION_ID`, `TM8_MANIFEST_PATH`, `TM8_BASE_URL`
//     — see above. A vanilla terminal has no manifest and no agent identity.
//   * `GH_TOKEN` / `GITHUB_TOKEN` — the node's machine credential, which an
//     agent gets a member-scoped replacement for through
//     `isolateGitHubCredential`.
//   * `ANTHROPIC_API_KEY` and every other `AUTH_ENV_KEYS` name.
//
// ---------------------------------------------------------------------------
// WHAT THOSE ABSENCES DO **NOT** BUY, MEASURED — READ THIS BEFORE TRUSTING THEM
// ---------------------------------------------------------------------------
//
// THEY ARE NOT ISOLATION. `HOME` is the server's own (see below), and every
// credential lookup that matters is FILESYSTEM-based, so withholding the
// environment names withholds almost nothing. Measured on a deployed node
// 2026-08-12, by review rather than by argument:
//
//   * `~/.gitconfig` carries `credential.helper = store` and
//     `~/.git-credentials` exists — so `git push` from a vanilla terminal
//     SUCCEEDS as the node's GitHub account. An earlier version of this comment
//     claimed the opposite. It was wrong.
//   * `~/.config/gh/hosts.yml` carries an `oauth_token`, and `gh` is on the
//     PATH this function composes.
//   * `~/.claude/.credentials.json` exists, and `withAgentBinDirs` below puts
//     the agent bin dirs on PATH deliberately, so `claude` is runnable too.
//   * `~/.ssh` exists.
//
// So the honest posture is: A VANILLA TERMINAL IS A SHELL AS THE tm8 OS USER,
// WITH THAT USER'S HOME AND EVERYTHING REACHABLE FROM IT. The env allow-list
// keeps the process from carrying tm8's OWN secrets (the agent token, the
// database URL) into a shell whose scrollback a member can read — which is
// worth doing and is all it does. It is not a sandbox and must not be cited as
// one.
//
// `start_shell_session` authorizes on space membership alone, so that reach is
// available to any member of any space on the node. On a single-operator node
// that is very likely the intended product — a member opening a terminal is the
// operator opening a terminal — but it is a DECISION, recorded here as one. If
// this node ever hosts mutually-untrusting members, this function is not what
// separates them and gating the operation is the change to make.
//
// `HOME` IS THE SERVER'S OWN, and that is the deliberate difference from
// `composeCredentialEnv`, which redirects it at a per-identity directory. A
// login terminal exists to WRITE a credential, so it needs somewhere private to
// write it. A vanilla terminal exists to be a shell: a member expects their
// dotfiles, their shell history and their `~/.gitconfig`. Redirecting HOME
// would produce a terminal with no prompt customisation and no history, which
// reads as broken. That is a TRADE — usability bought with the reach described
// above — not an oversight, and not isolation. It is the same posture the node
// already takes for an agent session, whose `HOME` is likewise the server's.

import { withAgentBinDirs } from '../spawn/manifest.js';

/**
 * The MAXIMAL key set of a vanilla terminal's environment — everything it can
 * contain, on a server that has all five inherited values set.
 *
 * Exported so a test can assert the WHOLE SET rather than the absence of
 * particular names. That distinction is the point: `expect(env.GH_TOKEN)
 * .toBeUndefined()` keeps passing on the day someone adds `TM8_AGENT_TOKEN`,
 * and an allowlist regression is precisely the failure that would ship
 * unnoticed.
 */
export const SHELL_ENV_KEYS = [
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'PATH',
  'TERM',
  'COLORTERM',
  'LANG',
  'TMPDIR',
  'TM8_TERMINAL',
] as const;

/**
 * Inherited verbatim from the server when set, skipped when not.
 *
 * Every one is either an identity the shell renders in its prompt (`USER`,
 * `LOGNAME`, `HOME`) or a rendering hint (`COLORTERM`, `TMPDIR`). None is a
 * credential, and the list is closed — `SAFE_BASE_ENV_KEYS` in manifest.ts is
 * deliberately NOT reused, because that list serves a different process with a
 * different threat model and growing it there must not silently grow this.
 */
const INHERITED_KEYS = ['HOME', 'USER', 'LOGNAME', 'COLORTERM', 'TMPDIR'] as const;

/** The bare service PATH, when the server itself was started without one. */
const FALLBACK_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

export interface ComposeShellEnvInput {
  /**
   * The resolved login shell. Written into `SHELL` so the shell itself agrees
   * with what `PtyHostService` spawned — see `resolveLoginShell`, which reads
   * this same variable back out.
   */
  shell: string;
  /** The SERVER's environment. Read key by key; never copied wholesale. */
  parentEnv: NodeJS.ProcessEnv;
}

/**
 * Compose the environment for a vanilla terminal PTY.
 *
 * Everything in the returned record is written here, by name.
 */
export function composeShellEnv(input: ComposeShellEnvInput): Record<string, string> {
  const { shell, parentEnv } = input;

  const env: Record<string, string> = {
    // Discovery only. The agent bin dirs are appended for the same reason the
    // login terminal appends them: `claude`, `codex` and `gh` are installed
    // under a package manager's prefix that a service PATH usually omits, and a
    // member who opens a terminal to run `claude` by hand should find it.
    PATH: withAgentBinDirs(parentEnv['PATH'] || FALLBACK_PATH, parentEnv),

    // A real terminal type, not inherited: the server's own TERM may be `dumb`
    // under a service manager, and this PTY is being rendered by xterm.js.
    TERM: 'xterm-256color',

    // Inherited only as a fallback default. A wrong locale mangles every
    // non-ASCII character the member types or reads.
    LANG: parentEnv['LANG'] || 'C.UTF-8',

    SHELL: shell,

    // So a shell rc file can tell where it is running. Informational only —
    // nothing in tm8 reads it back, and nothing should start to: a value the
    // server both writes and trusts is a value a member can edit and forge.
    TM8_TERMINAL: '1',
  };

  for (const key of INHERITED_KEYS) {
    const value = parentEnv[key];
    if (value) env[key] = value;
  }

  return env;
}
