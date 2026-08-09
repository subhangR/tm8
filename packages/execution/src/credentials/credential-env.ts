// @tm8/execution — the environment a VENDOR LOGIN TERMINAL runs in.
//
// This file exists so that no boolean parameter ever decides whether a process
// gets an agent's credentials. It lives beside `composeEnv` and shares exactly
// one thing with it — `withAgentBinDirs`, the PATH discovery list — and builds
// everything else FROM SCRATCH.
//
// WHY A SEPARATE FUNCTION AND NOT A FLAG ON `composeEnv` (sub-doc 11 §A3).
// `composeEnv` returns the session id, the manifest path, the base URL, the
// team member id, and — when SpawnService supplies it — `TM8_AGENT_TOKEN`,
// which is the SPAWNING HUMAN'S FULL IDENTITY and not a reduced principal
// (sub-doc 14, channel C7). A login terminal is a PTY the member types their
// vendor password into. One wrong branch on a flag hands it an agent token, and
// that branch is invisible in review because both arms typecheck, both arms
// return `Record<string, string>`, and no test that does not assert the EXACT
// KEY SET can tell them apart. Two functions cannot make that mistake.
//
// THE THREE ABSENCES THAT ARE MEASURED FACTS, NOT DEFENSIVE HABITS.
//
//  1. `GH_TOKEN` — `gh` REFUSES TO LOG IN while it is set, and says so:
//     "The value of the GH_TOKEN environment variable is being used for
//     authentication. To have GitHub CLI store credentials instead, first clear
//     the value from the environment." The shipped `applyGitCredential` always
//     sets it, so a GitHub login run through the ordinary spawn environment is
//     not merely insecure — it SILENTLY NO-OPS and reports success.
//
//  2. `GITHUB_TOKEN` — the same variable under its other name, and the reason
//     the finish step cannot trust `gh auth token`: that command PREFERS the
//     environment over `hosts.yml` (sub-doc 14, D6), so an extraction seam
//     running with either name set persists the WRONG secret and looks like a
//     success. Absence here is what makes the cross-check in the probe honest.
//
//  3. `XDG_CONFIG_HOME` — sub-doc 14's channel C5, and the one that a
//     per-identity `HOME` does NOT cover. `gh` resolves its config directory as
//     `GH_CONFIG_DIR` > `$XDG_CONFIG_HOME/gh` > `$HOME/.config/gh`, and
//     `SAFE_BASE_ENV_KEYS` copies `XDG_CONFIG_HOME` straight out of the server
//     process. It is latent today only because the variable happens to be unset
//     on the deployed unit: ONE operator `Environment=` line reverts `gh`
//     isolation with no error and no failing test. So it is not merely omitted
//     here — it is SET, explicitly, to a path inside the identity's own home, so
//     that even the fallback rung of `gh`'s resolution order lands somewhere
//     that belongs to this member.
//
// One more absence that costs nothing and is worth naming: `composeEnv` has to
// blank `CLAUDE_CODE_ENTRYPOINT` and `CLAUDECODE` because a tm8-server started
// from inside a Claude Code session inherits them and the spawned agent then
// refuses to start, believing it is running inside itself. Building from
// scratch makes them ABSENT rather than empty, which is strictly stronger, so
// there is nothing to blank here.
//
// THE ONE PROVIDER-SPECIFIC BEHAVIOUR FLAG. Utho's installed gh 2.62.0 asks
// `Authenticate Git with your GitHub credentials? (Y/n)` even when `--web`,
// `--git-protocol https` and `--skip-ssh-key` already make the answer
// unambiguous. In the browser PTY that leaves `gh` blocked in read(0) before it
// emits the device code, while Claude and Codex proceed immediately. The gh
// CLI's own `GH_PROMPT_DISABLED=1` skips that redundant question; measured on
// the deployed binary, it emits the one-time code and device URL immediately
// and waits for browser completion. It is set ONLY for GitHub below so the
// other vendors retain their interactive OAuth input paths.

import { withAgentBinDirs } from '../spawn/manifest.js';

/** The three vendors a Tier B login terminal can authenticate against. */
export type CredentialProvider = 'anthropic' | 'openai' | 'github';

export const CREDENTIAL_PROVIDERS: readonly CredentialProvider[] = [
  'anthropic',
  'openai',
  'github',
];

/**
 * The ONE environment variable that redirects each vendor CLI's credential
 * storage at a per-identity directory.
 *
 * Exactly one of these is set per terminal. Setting two would be meaningless at
 * best and, for a provider whose CLI reads another's variable, actively
 * confusing; a table keyed by provider makes "exactly one" structural rather
 * than a rule someone has to remember.
 */
export const CREDENTIAL_CONFIG_DIR_VAR = {
  anthropic: 'CLAUDE_CONFIG_DIR',
  openai: 'CODEX_HOME',
  github: 'GH_CONFIG_DIR',
} as const satisfies Record<CredentialProvider, string>;

/**
 * The keys every credential environment carries, whatever the provider.
 *
 * Exported so the test can assert the EXACT KEY SET rather than the absence of
 * particular names. That distinction is the whole point: a per-name assertion
 * (`expect(env.GH_TOKEN).toBeUndefined()`) passes unchanged the day someone
 * adds `ANTHROPIC_AUTH_TOKEN`, and an allowlist regression is precisely the
 * failure that would go unnoticed.
 */
export const CREDENTIAL_ENV_BASE_KEYS = [
  'HOME',
  'PATH',
  'TERM',
  'LANG',
  'SHELL',
  'XDG_CONFIG_HOME',
] as const;

/** The complete, exact key set for a given provider's login terminal. */
export function credentialEnvKeys(provider: CredentialProvider): string[] {
  return [
    ...CREDENTIAL_ENV_BASE_KEYS,
    CREDENTIAL_CONFIG_DIR_VAR[provider],
    ...(provider === 'github' ? ['GH_PROMPT_DISABLED'] : []),
  ].sort();
}

/**
 * PATH fallback for a server whose own PATH is empty or absent.
 *
 * The bare launchd path, which is what tm8-server actually inherits when it
 * runs as a macOS service. `withAgentBinDirs` then appends the package-manager
 * bin dirs where `claude`, `codex` and `gh` really live.
 */
const FALLBACK_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

export interface ComposeCredentialEnvInput {
  provider: CredentialProvider;
  /** `<dataDir>/credentials/<identityId>` — this terminal's entire HOME. */
  homeDir: string;
  /** `<homeDir>/<provider>` — the vendor CLI's config directory. */
  configDir: string;
  /**
   * The SERVER's environment. Read for exactly two things — the PATH to start
   * from and the HOME to search for bin directories under — and never copied
   * from wholesale. There is no allowlist here because there is no list: the
   * result is built key by key below.
   */
  parentEnv: NodeJS.ProcessEnv;
}

/**
 * Compose the environment for an interactive vendor-login PTY.
 *
 * Everything in the returned record is written here, by name. Nothing is
 * inherited, copied or forwarded from `parentEnv` except the two values named
 * in {@link ComposeCredentialEnvInput.parentEnv}, both of which are about
 * FINDING A BINARY and neither of which is a credential.
 */
export function composeCredentialEnv(input: ComposeCredentialEnvInput): Record<string, string> {
  const { provider, homeDir, configDir, parentEnv } = input;

  const env: Record<string, string> = {
    // The per-identity home. This is what makes `~/.claude`, `~/.codex` and
    // `~/.config/gh` resolve to this member's directory and not the node's.
    HOME: homeDir,

    // Discovery only. `withAgentBinDirs` reads `parentEnv.HOME` — the SERVER's
    // home — because that is where the CLIs are installed; the terminal's own
    // HOME above is where its CREDENTIALS go. Conflating the two would either
    // hide the binaries or put the credentials in the wrong place.
    PATH: withAgentBinDirs(parentEnv['PATH'] || FALLBACK_PATH, parentEnv),

    // A real terminal type, not inherited: these CLIs render an OAuth URL and a
    // code prompt, and the server's own TERM may be `dumb` under launchd.
    TERM: 'xterm-256color',

    // Inherited only as a fallback default, because a wrong locale garbles the
    // device code a human has to read off the screen and retype.
    LANG: parentEnv['LANG'] || 'C.UTF-8',

    SHELL: '/bin/bash',

    // C5, set rather than merely omitted. See the header. `gh` falls back to
    // `$XDG_CONFIG_HOME/gh`, so pointing it inside this identity's own home
    // means even the fallback rung cannot reach the node's `gh` credentials.
    XDG_CONFIG_HOME: `${homeDir}/.config`,

    // Exactly one, chosen by table. See CREDENTIAL_CONFIG_DIR_VAR.
    [CREDENTIAL_CONFIG_DIR_VAR[provider]]: configDir,
  };

  // GitHub's fixed command already chooses HTTPS credentials, so its extra
  // confirmation prompt has no remaining decision to collect. Disabling gh's
  // prompting starts the headless device flow directly; it does not disable
  // the browser authorization or the subsequent credential write.
  if (provider === 'github') env['GH_PROMPT_DISABLED'] = '1';

  return env;
}
