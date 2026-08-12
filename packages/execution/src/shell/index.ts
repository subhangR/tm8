// The VANILLA TERMINAL block (101) — a PTY on the login shell, no agent.
//
// Its own barrel rather than part of `spawn/`, for the reason `credentials/`
// has one: importing a terminal primitive should be a deliberate act, and a
// reader should be able to see at the import site which of the three
// environments — agent, vendor login, or plain shell — is in play.
export {
  FALLBACK_LOGIN_SHELL,
  ShellSessionLauncher,
  loginShellCommand,
  resolveLoginShell,
  type ShellLaunchRequest,
  type ShellLaunchResult,
  type ShellSessionLauncherOptions,
} from './ShellSessionLauncher.js';
export {
  SHELL_ENV_KEYS,
  composeShellEnv,
  type ComposeShellEnvInput,
} from './shell-env.js';
