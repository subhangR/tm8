// @tm8/execution — start the PTY that a member completes a vendor login in.
//
// The whole class is `composeCredentialEnv` + `pty.spawnIfAbsent`, and its value
// is in what it REFUSES to accept rather than in what it does. Read
// CREDENTIAL_LOGIN_COMMANDS below before changing anything here.

import type { PtyHostService } from '../pty/PtyHostService.js';
import type { Logger } from '../pty/types.js';
import { composeCredentialEnv, type CredentialProvider } from './credential-env.js';

/**
 * THE COMMAND TABLE. Fixed, server-side, keyed by provider, and the ONLY source
 * of the string the PTY runs.
 *
 * NO CLIENT INPUT REACHES ARGV, AND THAT IS NOT A STYLE RULE. This is a PTY
 * running as the tm8 OS user, started from a settings form in a browser. A
 * client-supplied command there is remote code execution with a pleasant user
 * interface. {@link CredentialLaunchRequest} therefore has no command field, no
 * args field and no flags field — the absence is the control, because a field
 * that does not exist cannot be forwarded by a later refactor.
 *
 * Each entry is a measured decision, not a plausible guess:
 *
 *  anthropic — `claude auth login`, AMENDING R4 (which ruled `claude
 *    setup-token` for its narrower scope: `user:inference` only, vs the six
 *    scopes `auth login` requests including `org:create_api_key`). The scope
 *    argument was sound; the premise was not, and it was MEASURED wrong on Utho
 *    prod (2026-08-09, claude 2.1.220): `setup-token`'s product is a PRINTED
 *    `sk-ant-oat01-…` token the member is meant to carry as
 *    `CLAUDE_CODE_OAUTH_TOKEN` — the binary's own strings say "Mint a fresh
 *    token with `claude setup-token` and restart the session with it". It
 *    NEVER persists a login into the config directory, so the finish probe
 *    (`claude auth status`) reads `loggedIn: false` after a perfectly
 *    completed flow. Consequences, both observed: the flow can NEVER end
 *    "signed in" (four completed attempts, zero `.credentials.json`), and the
 *    member is left holding a raw token on screen — which is exactly how one
 *    ended up pasted into a task description and tripped the S15 guard on
 *    every launch of that task. A login verb whose success the probe is
 *    structurally blind to is not a narrower credential, it is NO credential
 *    plus a leaked secret. `auth login` persists a login the probe can see;
 *    its wider grant is the accepted price, and `user:profile` in that grant
 *    means the probe now learns an email, so
 *    `account_agent_credentials.login` is populated for anthropic and the
 *    card reads "Connected as <address>".
 *
 *    Also measured, and both are finish-step bugs waiting to happen: Claude's
 *    OAuth callback is REMOTE (`https://platform.claude.com/oauth/code/callback`,
 *    never localhost), so this needs no device flow and no vendor registration
 *    on this topology — the loop is "stream a URL out, take one line back". And
 *    BOTH Claude verbs write `.claude.json` plus a `backups/` entry into the
 *    config directory BEFORE any authentication happens, so a non-empty config
 *    directory is NOT a success signal.
 *
 *  openai — `codex login --device-auth`, NEVER bare `codex login`. The bare verb
 *    opens a LOOPBACK LISTENER and waits for a browser on the same machine to
 *    hit it; there is no browser on this machine, so it hangs until the TTL
 *    kills it and the member sees a terminal that did nothing.
 *
 *  github — `--web` for the same reason (device flow, no local callback),
 *    `--skip-ssh-key` because tm8 has no business generating a key pair on the
 *    member's behalf, and `--git-protocol https` because that is the protocol
 *    the credential this login produces can actually serve.
 */
export const CREDENTIAL_LOGIN_COMMANDS = {
  anthropic: 'claude auth login',
  openai: 'codex login --device-auth',
  github: 'gh auth login --web --hostname github.com --git-protocol https --skip-ssh-key',
} as const satisfies Record<CredentialProvider, string>;

/**
 * Everything the launcher accepts.
 *
 * Deliberately CLOSED over the command. Every field here is either a
 * server-derived path or a terminal geometry; none of them can influence which
 * program runs.
 */
export interface CredentialLaunchRequest {
  /** The `work_sessions.entity_id` minted by `start_credential_session`. */
  sessionId: string;
  provider: CredentialProvider;
  /** `<dataDir>/credentials/<identityId>`, already created at 0700. */
  homeDir: string;
  /** `<homeDir>/<provider>`, already created at 0700. */
  configDir: string;
  cols?: number;
  rows?: number;
}

export interface CredentialLaunchResult {
  sessionId: string;
  provider: CredentialProvider;
  /** The exact table entry that was run. Recorded so a caller can assert it. */
  command: string;
  cwd: string;
  /** The composed environment, returned for the finish-step probes to reuse. */
  env: Record<string, string>;
  /** True when a live PTY already existed for this session id. */
  reused: boolean;
}

export interface CredentialSessionLauncherOptions {
  pty: PtyHostService;
  /** The SERVER's environment. Injected for tests; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
}

export class CredentialSessionLauncher {
  private readonly pty: PtyHostService;
  private readonly env: NodeJS.ProcessEnv;
  private readonly logger: Logger | undefined;

  constructor(options: CredentialSessionLauncherOptions) {
    this.pty = options.pty;
    this.env = options.env ?? process.env;
    this.logger = options.logger;
  }

  /**
   * Start the login terminal.
   *
   * `spawnIfAbsent` rather than `spawn`, matching SpawnService: a double-click
   * on Connect must reattach to the terminal that is already streaming a device
   * code, not kill it and issue a second one the member is not looking at.
   *
   * The cwd is the identity's own home. It is NOT a project directory and NOT
   * the server's cwd — a vendor CLI that writes a stray file should write it
   * somewhere that is already 0700 and already this member's.
   */
  launch(request: CredentialLaunchRequest): CredentialLaunchResult {
    const command = CREDENTIAL_LOGIN_COMMANDS[request.provider];
    const env = composeCredentialEnv({
      provider: request.provider,
      homeDir: request.homeDir,
      configDir: request.configDir,
      parentEnv: this.env,
    });

    const { reused } = this.pty.spawnIfAbsent({
      sessionId: request.sessionId,
      command,
      cwd: request.homeDir,
      env,
      ...(request.cols ? { cols: request.cols } : {}),
      ...(request.rows ? { rows: request.rows } : {}),
    });

    // The provider is logged; the environment is not. It carries no secret
    // today, and logging it is how it would come to carry one unnoticed.
    this.logger?.info('CredentialSessionLauncher: login terminal started', {
      sessionId: request.sessionId,
      provider: request.provider,
      reused,
    });

    return { sessionId: request.sessionId, provider: request.provider, command, cwd: request.homeDir, env, reused };
  }

  /** True when this node still holds a live PTY for that credential session. */
  hasLiveTerminal(sessionId: string): boolean {
    return this.pty.hasSession(sessionId);
  }

  /**
   * Kill the login terminal.
   *
   * Returns the PTY's own outcome verbatim rather than a boolean. A caller that
   * is about to stamp `finished_at` needs to know the difference between
   * `killed`, `not_found` and `error` — collapsing them is how a session gets
   * recorded as closed while its process is still holding a half-finished OAuth
   * flow open.
   */
  terminate(sessionId: string): ReturnType<PtyHostService['kill']> {
    return this.pty.kill(sessionId);
  }
}
