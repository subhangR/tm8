// @tm8/execution — start the PTY behind a VANILLA TERMINAL.
//
// The whole class is `resolveLoginShell` + `composeShellEnv` +
// `pty.spawnIfAbsent`, and — exactly as with `CredentialSessionLauncher` — its
// value is in what it refuses to accept rather than in what it does.
//
// NO CLIENT INPUT REACHES ARGV, AND THAT IS NOT A STYLE RULE. This is a PTY
// running as the tm8 OS user, started from a button in a browser. A
// client-supplied command there is remote code execution with a pleasant user
// interface. {@link ShellLaunchRequest} therefore has no command field, no args
// field and no flags field — the absence is the control, because a field that
// does not exist cannot be forwarded by a later refactor. `cwd` is the one
// path-shaped input, and it is SERVER-DERIVED: the caller passes the project's
// recorded `working_dir` or a server-owned scratch directory, never a string
// from a request body.
//
// Note the difference from a credential terminal, which runs ONE fixed command
// out of a table and exits. A vanilla terminal runs the member's shell and
// stays; the member then types whatever they like into it. That is the whole
// feature, and it is why the argv is closed while the SESSION is open-ended.

import { existsSync, readFileSync } from 'node:fs';
import { userInfo } from 'node:os';

import type { PtyHostService } from '../pty/PtyHostService.js';
import type { Logger } from '../pty/types.js';
import { shellQuote } from '../spawn/manifest.js';
import { composeShellEnv } from './shell-env.js';

/** Last resort when nothing else resolves. Present on every supported node. */
export const FALLBACK_LOGIN_SHELL = '/bin/bash';

/**
 * Which shell a vanilla terminal runs.
 *
 * DELIBERATELY THE SAME CHAIN `PtyHostService` ALREADY USES (`env.SHELL ||
 * process.env.SHELL || defaultShell || '/bin/bash'`), with one rung added
 * BENEATH the inherited variable rather than above it, so this resolves what
 * that would resolve and the two can never disagree about which binary is
 * running. `composeShellEnv` then writes the answer into the child's `SHELL`,
 * which is the first rung of the PTY's own chain — so the host picks this exact
 * value rather than re-deriving one.
 *
 * The added rung is the passwd entry. A tm8-server under systemd usually
 * inherits no `SHELL` at all, and without it every terminal on the node would
 * be `/bin/bash` regardless of what the operator's account actually uses —
 * technically a working shell, and the wrong one for anybody on zsh or fish.
 *
 * EXISTENCE IS NOT ENOUGH, and that is what the `/etc/shells` check is for. An
 * inherited `SHELL` naming a binary this machine does not have would spawn,
 * fail ENOENT, and surface as a terminal that opened and instantly died with no
 * stated cause — so existence is checked. But the passwd rung introduces a
 * worse case that existence cannot catch: a SERVICE ACCOUNT'S passwd shell is
 * very often `/usr/sbin/nologin` or `/bin/false`, both of which exist on a
 * normal Linux node and both of which pass every check a file test can make.
 * Measured: `nologin -c 'exec nologin -l -i'` prints "This account is currently
 * not available." and exits 0, so EVERY terminal on such a node would open and
 * instantly die — the precise symptom the existence check was added to prevent,
 * reintroduced one rung higher.
 *
 * That is not hypothetical for this rung specifically: it exists BECAUSE a
 * tm8-server under systemd usually inherits no `SHELL`, and a systemd service
 * account is exactly the kind of account whose passwd shell is `nologin`.
 *
 * `/etc/shells` is the system's own answer to "is this a login shell" — it is
 * what `chsh` validates against — so a candidate is accepted only if it is
 * listed there. A node with no `/etc/shells` at all falls back to accepting any
 * existing absolute path, because refusing everything would be worse than the
 * pre-check behaviour.
 */
export function resolveLoginShell(parentEnv: NodeJS.ProcessEnv): string {
  const permitted = loginShells();
  const usable = (candidate: string | undefined): candidate is string => {
    const trimmed = candidate?.trim();
    if (!trimmed || !trimmed.startsWith('/') || !existsSync(trimmed)) return false;
    // An empty list means the node has no /etc/shells to consult; do not let
    // that refuse every candidate down to a fallback that is equally unchecked.
    return permitted.size === 0 || permitted.has(trimmed);
  };
  for (const candidate of [parentEnv['SHELL'], safePasswdShell(), FALLBACK_LOGIN_SHELL]) {
    if (usable(candidate)) return candidate.trim();
  }
  return FALLBACK_LOGIN_SHELL;
}

/** The system's own list of login shells — what `chsh` validates against. */
function loginShells(): Set<string> {
  try {
    return new Set(
      readFileSync('/etc/shells', 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.startsWith('/')),
    );
  } catch {
    return new Set();
  }
}

/** `userInfo()` throws when the uid has no passwd entry (some containers). */
function safePasswdShell(): string | undefined {
  try {
    return userInfo().shell ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * The command string handed to `PtyHostService.spawn`, which runs it as
 * `<shell> -c <command>`.
 *
 * `exec` IS THE LOAD-BEARING WORD. Without it there would be two processes on
 * this PTY — the `-c` shell waiting on the interactive shell it started — and
 * every consequence of that is a bug a member would report: `exit` returns to a
 * second prompt instead of ending the session, the PTY's exit code is the
 * wrapper's rather than the shell's, and a Ctrl-C races between them. `exec`
 * replaces the wrapper, so the member's shell IS the PTY's process and the
 * session ends exactly when they end it.
 *
 * `-l -i` rather than either alone: `-l` sources the login profile (which is
 * where PATH and prompt customisation live on most setups) and `-i` states
 * interactivity outright rather than relying on each shell's own heuristic for
 * inferring it from an attached tty. Both flags are accepted by bash, zsh,
 * fish, ksh and dash.
 *
 * The claim is about THOSE shells, not about everything `resolveLoginShell` can
 * return — it returns whatever `/etc/shells` admits, which is the system's list
 * and not this file's. csh and tcsh are the known exception: they take `-l`
 * only as the sole flag, so `-l -i` would silently lose login-ness rather than
 * fail. Neither is in a default `/etc/shells`; if one ever is, this is the
 * function to revisit.
 *
 * This function exists as its own exported unit so a test can assert the exact
 * string. It is the only place a vanilla terminal's argv is decided.
 */
export function loginShellCommand(shell: string): string {
  return `exec ${shellQuote(shell)} -l -i`;
}

/**
 * Everything the launcher accepts. Every field is either a server-derived path
 * or a terminal geometry; none can influence which program runs.
 */
export interface ShellLaunchRequest {
  /** The `work_sessions.entity_id` minted by `start_shell_session`. */
  sessionId: string;
  /**
   * The project's recorded `working_dir`, or a server-owned scratch directory.
   * SERVER-DERIVED — see the file header.
   */
  cwd: string;
  cols?: number;
  rows?: number;
}

export interface ShellLaunchResult {
  sessionId: string;
  /** The exact line that was run. Recorded so a caller can assert it. */
  command: string;
  /** The resolved login shell, for the caller's log line. */
  shell: string;
  cwd: string;
  /** The composed environment. */
  env: Record<string, string>;
  /** True when a live PTY already existed for this session id. */
  reused: boolean;
}

export interface ShellSessionLauncherOptions {
  pty: PtyHostService;
  /** The SERVER's environment. Injected for tests; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
}

export class ShellSessionLauncher {
  private readonly pty: PtyHostService;
  private readonly env: NodeJS.ProcessEnv;
  private readonly logger: Logger | undefined;

  constructor(options: ShellSessionLauncherOptions) {
    this.pty = options.pty;
    this.env = options.env ?? process.env;
    this.logger = options.logger;
  }

  /**
   * Start (or reattach to) the terminal.
   *
   * `spawnIfAbsent` RATHER THAN `spawn`, and here it matters more than anywhere
   * else in the tree. `PtyHostService.spawn` kills any existing PTY for the
   * session id first — its own docstring at the re-spawn branch warns that a
   * re-spawn request must not tear down a still-running shell. For an agent
   * that would cost a boot; for a vanilla terminal it would destroy work in
   * progress, because the thing running in there is a person's editor, or a
   * build, or an ssh session. A browser reconnecting, a second tab, or a
   * double-click on the start button must all land on the SAME live shell.
   *
   * This is also the whole of "reattach on reconnect": the PTY outlives the
   * WebSocket by construction — nothing in the disconnect path calls `kill` —
   * so re-attaching is a new socket onto a process that never stopped, and
   * replay comes from the output ring.
   */
  launch(request: ShellLaunchRequest): ShellLaunchResult {
    const shell = resolveLoginShell(this.env);
    const command = loginShellCommand(shell);
    const env = composeShellEnv({ shell, parentEnv: this.env });

    const { reused } = this.pty.spawnIfAbsent({
      sessionId: request.sessionId,
      command,
      cwd: request.cwd,
      env,
      ...(request.cols ? { cols: request.cols } : {}),
      ...(request.rows ? { rows: request.rows } : {}),
    });

    // The shell and the cwd are logged; the environment is not. It carries no
    // secret today, and logging it is how it would come to carry one unnoticed.
    this.logger?.info('ShellSessionLauncher: vanilla terminal started', {
      sessionId: request.sessionId,
      shell,
      cwd: request.cwd,
      reused,
    });

    return { sessionId: request.sessionId, command, shell, cwd: request.cwd, env, reused };
  }

  /** True when this node still holds a live PTY for that shell session. */
  hasLiveTerminal(sessionId: string): boolean {
    return this.pty.hasSession(sessionId);
  }
}
