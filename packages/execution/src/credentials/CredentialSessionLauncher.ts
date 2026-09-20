// @tm8/execution — start the PTY that a member completes a vendor login in.
//
// The whole class is `composeCredentialEnv` + `pty.spawnIfAbsent`, and its value
// is in what it REFUSES to accept rather than in what it does. Read
// CREDENTIAL_LOGIN_COMMANDS below before changing anything here.

import { fileURLToPath } from 'node:url';

import type { PtyHostService } from '../pty/PtyHostService.js';
import type { Logger } from '../pty/types.js';
import { shellQuote } from '../spawn/manifest.js';
import {
  API_KEY_CREDENTIAL_PROVIDERS,
  API_KEY_FILENAME,
  API_KEY_PROVIDER_CONSOLE_URL,
  API_KEY_PROVIDER_DISPLAY_NAME,
  API_KEY_PROVIDER_KEY_PREFIX,
  API_KEY_PROVIDER_VERIFY_URL,
  type ApiKeyCredentialProvider,
} from './api-key-credentials.js';
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
 * The first three entries are measured decisions, not plausible guesses:
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
 *
 *  gemini — bare `gemini`, MEASURED on this node (2026-09-04,
 *    @google/gemini-cli 0.58.0). There is no `gemini auth` or `gemini login`
 *    subcommand to reach for: `gemini --help` lists only `mcp`, `extensions`,
 *    `skills`, `hooks`, `gemma` and the default query command, and the auth
 *    chooser (Login with Google / API key) runs on interactive start. So the
 *    bare binary IS the login verb here rather than a stand-in for one.
 *
 *    Its isolation was measured too, and it is weaker than the three above:
 *    `GEMINI_DIR` appears throughout the shipped bundle but it is the CONSTANT
 *    `".gemini"`, not a variable read from the environment — resolution is
 *    `homedir() + '/.gemini'`. `HOME=$(mktemp -d) gemini -p hi` wrote `.gemini`
 *    into that temporary HOME and nowhere else, so the per-identity HOME every
 *    login terminal already gets IS the whole isolation mechanism for this
 *    vendor. That is a real guarantee, but it is one rung lower than a
 *    vendor-documented config-dir override, and `CREDENTIAL_CONFIG_DIR_VAR`
 *    records it as `null` rather than inventing a variable the CLI never reads.
 *
 *  hermes — `hermes login` is DECLARED, NOT MEASURED. No `hermes` binary exists
 *    on this node, so no login flow was observed and this entry is the argv to
 *    use once an operator installs one. Migration 083's admission rule is
 *    satisfied not by this string but by the server: the probe reports
 *    `unavailable`, and login-session start refuses — naming the binary —
 *    before it mints a work session or starts a PTY. Nothing here retroactively
 *    claims a measurement, and the entry must not be reworded as though it did
 *    until someone has actually watched the flow.
 *
 *  cursor — `cursor-agent login` is MEASURED on this node (2026-09-04,
 *    cursor-agent 2026.09.02-c22c1a3): the binary is present, the login verb
 *    was observed, and its HOME-scoped storage was located at
 *    `.cursor/cli-config.json`. This is evidence, unlike Hermes's declaration
 *    above. `cursor-agent logout` also exists, but tm8 Disconnect revokes the
 *    stored credential plus its sessions; invoking a vendor logout is a
 *    separate decision and is deliberately not wired here.
 *
 *  kimi, groq, grok — TM8'S OWN HARNESS, not a vendor binary, and the only
 *    entries in this table that are not somebody else's program. No vendor here
 *    ships a login CLI; each issues an API key from a web console. The
 *    measurement behind that claim — including the two npm packages whose names
 *    suggest otherwise and are unrelated software — is recorded in
 *    `api-key-credentials.ts` rather than repeated here.
 *
 *    `credentialBinaryFor` derives `node` from these entries, and that is a
 *    TRUE answer rather than a convenient one: node is what runs, it is present
 *    wherever the server is, and the install check consequently passes for the
 *    right reason. These are the only entries whose binary is not the thing
 *    being authenticated against, so an installability check for kimi or groq
 *    says nothing about the vendor — which is correct, because there is nothing
 *    vendor-supplied to install.
 *
 *    GROK IS xAI AND GROQ IS GROQ, INC. — different companies whose names
 *    differ by a transposed letter and whose APIs are both OpenAI-compatible.
 *    They are two rows here, two cards in the product, and two separate keys;
 *    nothing in tm8 treats one as an alias or a misspelling of the other.
 */
/**
 * Absolute path to tm8's own credential paste harness.
 *
 * Mirrors {@link echoAgentPath} exactly, including WHY the relative specifier
 * has the shape it does: `../../harness/credential-paste.mjs` lands on the same
 * file from `src/credentials/` (vitest, running TypeScript directly) and from
 * `dist/credentials/` (the built server), because both are two levels below the
 * package root.
 */
export function credentialPastePath(): string {
  return fileURLToPath(new URL('../../harness/credential-paste.mjs', import.meta.url));
}

/**
 * The login command for an API-key provider: tm8's own harness, not a vendor's.
 *
 * Every argument is read from `api-key-credentials.ts` at composition time, so
 * the vendor facts have ONE authority and the `.mjs` — which cannot import
 * TypeScript — never restates them. Each is shell-quoted because this is a
 * command STRING handed to a PTY, and the display names contain spaces.
 *
 * Nothing here is reachable from a client: the provider is validated against
 * `CREDENTIAL_PROVIDERS` before a session is minted, and every other argument is
 * a table lookup. That preserves the property the vendor entries have — the
 * table is closed over the command, and no caller can influence what runs.
 */
function apiKeyLoginCommand(provider: ApiKeyCredentialProvider): string {
  return [
    'node',
    shellQuote(credentialPastePath()),
    '--provider',
    shellQuote(provider),
    '--display',
    shellQuote(API_KEY_PROVIDER_DISPLAY_NAME[provider]),
    '--console-url',
    shellQuote(API_KEY_PROVIDER_CONSOLE_URL[provider]),
    '--verify-url',
    shellQuote(API_KEY_PROVIDER_VERIFY_URL[provider]),
    '--key-prefix',
    shellQuote(API_KEY_PROVIDER_KEY_PREFIX[provider]),
    '--filename',
    shellQuote(API_KEY_FILENAME),
  ].join(' ');
}

/**
 * NOTE ON THE TYPE. This was `as const satisfies Record<CredentialProvider,
 * string>`, which gave each entry a string-literal type. The two API-key
 * entries cannot be literals — they embed an absolute path resolved from
 * `import.meta.url`, which differs between `src/` under vitest and `dist/` on
 * the deployed server — so the table is now a frozen `Record` built once at
 * module load. Nothing consumed the literal types: every reader indexes it at
 * runtime (`credentialBinaryFor`, the launcher, the tests), and the exhaustive
 * `Record<CredentialProvider, string>` annotation still fails the build if a
 * provider is added to the union without an entry here, which was the only
 * guarantee that mattered.
 */
export const CREDENTIAL_LOGIN_COMMANDS: Readonly<Record<CredentialProvider, string>> =
  Object.freeze({
    anthropic: 'claude auth login',
    openai: 'codex login --device-auth',
    github: 'gh auth login --web --hostname github.com --git-protocol https --skip-ssh-key',
    hermes: 'hermes login',
    cursor: 'cursor-agent login',
    // GEMINI IS NOT IN THE LIST ABOVE ANY MORE. It used to read `gemini: 'gemini'`
    // — bare `gemini`, which owns the CLI's interactive OAuth flow — and it now
    // comes from the API-key spread below instead. That is a deliberate change
    // of which auth mode tm8's Connect button drives, and it needs its reason
    // recorded because it is a product decision, not a refactor.
    //
    // THE OAUTH FLOW CANNOT COMPLETE WHERE TM8 RUNS. It wants a browser. tm8's
    // credential terminal is a headless PTY on a server — the same constraint
    // that makes `NO_OPEN_BROWSER` a behaviour override for Cursor two files
    // away. Measured on this node: `~/.gemini` contains an empty
    // `projects.json` (`{"projects":{}}`, 20 bytes) and two orphaned `.tmp`
    // siblings, and no `oauth_creds.json` at all — a flow entered and never
    // finished. Every probe since has answered `stale`, and `stale` persists no
    // row, so the member is told "unknown" forever with nothing to act on.
    //
    // The API-key mode needs no browser, and it is equally official: the
    // installed `@google/gemini-cli` 0.58.0 bundle carries `USE_GEMINI`
    // alongside `LOGIN_WITH_GOOGLE` in its auth enum and reads `GEMINI_API_KEY`
    // in 21 of its chunks. So Connect now pastes a key.
    //
    // WHAT THIS DOES NOT DO IS DISCONNECT ANYONE. A member who already holds a
    // completed `oauth_creds.json` keeps it: `readGeminiProbe` still reads that
    // file and still reports them connected. What they lose is the ability to
    // re-run the OAuth flow from tm8's dialog — a flow that, on a headless
    // host, was not reaching a browser to begin with. Re-running `gemini` in a
    // normal terminal on a machine with a browser still works and tm8 still
    // honours the result.
    ...(Object.fromEntries(
      API_KEY_CREDENTIAL_PROVIDERS.map((provider) => [provider, apiKeyLoginCommand(provider)]),
    ) as Record<ApiKeyCredentialProvider, string>),
  });

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
