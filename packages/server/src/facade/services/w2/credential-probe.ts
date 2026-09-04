/**
 * The verification probes — the ONLY thing allowed to decide that a login
 * succeeded.
 *
 * THE RULE THIS FILE ENFORCES: SUCCESS IS NEVER INFERRED FROM A CLEAN PTY EXIT.
 * A member who opens the terminal, reads the device code, changes their mind
 * and closes the tab produces exit code 0 with nothing captured. So does a
 * member who completes the flow. `claude auth status` in particular EXITS 0
 * WHETHER OR NOT ANYONE IS LOGGED IN — its `loggedIn` field is the only
 * reliable indicator, and reading the exit code instead would mark every
 * abandoned login as connected.
 *
 * THE SECOND TRAP, measured: both Claude verbs write `.claude.json` and a
 * `backups/` entry into the config directory BEFORE any authentication happens.
 * A non-empty config directory is therefore NOT a success signal either — which
 * rules out the other obvious shortcut.
 *
 * WHAT EACH PROBE ACTUALLY ANSWERS
 *
 *   anthropic  `claude auth status`  → JSON `{loggedIn, authMethod, email, orgId}`
 *   github     `gh auth status`      → text, `Logged in to github.com account <login>`
 *   openai     `codex login status`  → NOT YET CAPTURED on any node
 *   gemini     `.gemini/oauth_creds.json` under the isolated HOME
 *   hermes     no verified status verb OR credential-file location
 *   cursor     `cursor-agent status --format json` → JSON `{isAuthenticated}`
 *
 * The openai row is the honest one. Nobody has run that command and recorded
 * its output, so this file does not pretend to parse it: an answer it cannot
 * read is recorded as `stale`, never as success. `stale` is the correct verdict
 * — a credential may well exist on disk, we simply cannot confirm it — and it
 * is a status `account_agent_credentials` already models.
 *
 * Gemini and Hermes cannot be given plausible-looking status commands. Gemini
 * 0.58.0 was measured on this node: bare `gemini` owns the interactive OAuth
 * flow and a completed Google login writes `.gemini/oauth_creds.json` beneath
 * HOME. That file plus a resolvable binary is the positive signal; its absence
 * is UNKNOWN, not disconnected, because there is no status verb with which to
 * distinguish an abandoned flow from another supported credential shape.
 * Hermes is stricter still: neither a status verb nor its credential-file
 * location has been measured, so a present binary can only answer `stale`.
 * Inventing either would turn declaration into evidence.
 *
 * Cursor Agent 2026.09.02-c22c1a3 is the first of these new providers with a
 * real status verb. Its measured signed-out answer carries
 * `isAuthenticated:false`; that boolean is the whole decision. No signed-in
 * shape has been observed, so this probe neither names nor guesses any other
 * field. Missing, non-boolean or unparseable data is `stale`, never a confident
 * connection or disconnection. Its HOME-scoped credential file was separately
 * located at `.cursor/cli-config.json` and is recorded in the spec below.
 */
import { execFile } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { delimiter, isAbsolute, join, resolve } from 'node:path';

import {
  composeCredentialEnv,
  CREDENTIAL_LOGIN_COMMANDS,
  type CredentialProvider,
} from '@tm8/execution';

/** Probes are non-interactive status reads; a slow one is a hung one. */
const PROBE_TIMEOUT_MS = 20_000;
/** A status read that needs more than this is not a status read. */
const PROBE_MAX_BUFFER = 1024 * 1024;

/**
 * The probe command table. Fixed and server-side, exactly like the login
 * table, and for the same reason — see `CREDENTIAL_LOGIN_COMMANDS`.
 *
 * These are ARGV ARRAYS, not command strings, and they are run through
 * `execFile` with NO SHELL. There is nothing to quote, so there is nothing to
 * quote wrongly.
 */
const CREDENTIAL_PROBE_SPECS = {
  anthropic: {
    command: ['claude', 'auth', 'status'],
    credentialFile: null,
    install:
      'Install Claude Code with `npm install -g @anthropic-ai/claude-code`, then make its bin directory available to tm8.',
  },
  openai: {
    command: ['codex', 'login', 'status'],
    credentialFile: null,
    install:
      'Install Codex with `npm install -g @openai/codex`, then make its bin directory available to tm8.',
  },
  github: {
    command: ['gh', 'auth', 'status'],
    credentialFile: null,
    install:
      'Install GitHub CLI with your operating system package manager, then make `gh` available to tm8.',
  },
  gemini: {
    command: null,
    credentialFile: ['.gemini', 'oauth_creds.json'],
    install:
      'Install Gemini CLI with `npm install -g @google/gemini-cli`, then make its bin directory available to tm8.',
  },
  hermes: {
    command: null,
    credentialFile: null,
    // Point at the vendor's guide instead of inventing a package name. Unlike
    // a guessed status verb this is independently verifiable without running
    // the absent CLI, and gives the operator an actionable installation path.
    install:
      'Install Hermes Agent from https://hermes-agent.nousresearch.com/docs/getting-started/quickstart/ and make its `hermes` binary available to tm8.',
  },
  cursor: {
    command: ['cursor-agent', 'status', '--format', 'json'],
    credentialFile: ['.cursor', 'cli-config.json'],
    install:
      'Install Cursor Agent with `curl https://cursor.com/install -fsS | bash`, then make its `cursor-agent` binary available to tm8.',
  },
} as const satisfies Record<
  CredentialProvider,
  {
    command: readonly string[] | null;
    credentialFile: readonly string[] | null;
    install: string;
  }
>;

/**
 * Only providers with measured, non-interactive status verbs appear here.
 * A partial record is the control: Gemini and Hermes would each require a real
 * command, so neither can acquire a guessed `--status` by exhaustiveness.
 * Cursor appears because its status verb was observed on this node.
 */
export const CREDENTIAL_PROBE_COMMANDS: Readonly<
  Partial<Record<CredentialProvider, readonly string[]>>
> = Object.fromEntries(
  Object.entries(CREDENTIAL_PROBE_SPECS).flatMap(([provider, spec]) =>
    spec.command === null ? [] : [[provider, spec.command]],
  ),
) as Readonly<Partial<Record<CredentialProvider, readonly string[]>>>;

/**
 * The GitHub cross-check (sub-doc 14, finding D6).
 *
 * `gh api user` answers as whoever the CURRENT TOKEN is, and `gh auth token`
 * PREFERS `$GH_TOKEN` over `hosts.yml`. So if the probe environment carried a
 * machine token, `gh api user` would confidently report the MACHINE account
 * while `hosts.yml` holds the member's — and the extraction seam would persist
 * the wrong secret under the right name, with every signal reading success.
 * Comparing the two is what makes that impossible to miss.
 */
const GH_API_USER_COMMAND = ['gh', 'api', 'user', '--jq', '.login'] as const;
const GH_AUTH_TOKEN_COMMAND = ['gh', 'auth', 'token', '--hostname', 'github.com'] as const;

/** Names that must not exist in a probe environment. See D6 above. */
export const GH_TOKEN_ENV_NAMES = ['GH_TOKEN', 'GITHUB_TOKEN'] as const;

export interface ProbeResult {
  provider: CredentialProvider;
  /** True ONLY when the probe positively confirmed an authenticated identity. */
  connected: boolean;
  /**
   * `active` when the probe gave a confident answer (connected OR
   * disconnected), `stale` when it could not tell, and `unavailable` when PATH
   * resolution positively established no binary.
   *
   * There is deliberately no `failed`: a probe that cannot be parsed has told
   * us nothing about the credential, and recording "no credential" on the
   * strength of an unreadable answer is a claim the evidence does not support.
   * `unavailable` is not that failure: the measurement completed and answered
   * a different question with a definite no.
   */
  status: 'active' | 'stale' | 'unavailable';
  /** Display only. NULL forever for anthropic — see `reasons.ts` and R4. */
  login: string | null;
  authMethod: string | null;
  /** Human-readable explanation, recorded whenever `connected` is false. */
  detail: string | null;
}

export interface CommandOutcome {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/** Runs one argv in one environment. Injected so tests need no vendor CLI. */
export type CommandRunner = (
  argv: readonly string[],
  options: { env: Record<string, string>; cwd: string },
) => Promise<CommandOutcome>;

/** Resolve one executable exactly against the PATH and cwd a child will use. */
export type CredentialBinaryResolver = (input: {
  binary: string;
  path: string;
  cwd: string;
}) => string | null;

export interface CredentialBinaryMeasurement {
  provider: CredentialProvider;
  binary: string;
  /** `unknown` is a failed measurement; `unavailable` is a measured absence. */
  status: 'available' | 'unavailable' | 'unknown';
  resolvedPath: string | null;
  detail: string | null;
}

/** The binary is derived from the fixed login command, never repeated in a table. */
export function credentialBinaryFor(provider: CredentialProvider): string {
  const binary = CREDENTIAL_LOGIN_COMMANDS[provider].trim().split(/\s+/, 1)[0];
  if (!binary) throw new Error(`credential login command for ${provider} has no binary`);
  return binary;
}

/**
 * Resolve an executable the way the login terminal's shell will.
 *
 * Empty and relative PATH entries are relative to the child's cwd, not the
 * server's cwd. Remembering that distinction matters here because credential
 * terminals deliberately run from the identity's private HOME.
 */
export const resolveCredentialBinary: CredentialBinaryResolver = ({ binary, path, cwd }) => {
  const candidates = binary.includes('/')
    ? [isAbsolute(binary) ? binary : resolve(cwd, binary)]
    : path.split(delimiter).map((dir) => join(dir === '' ? cwd : isAbsolute(dir) ? dir : resolve(cwd, dir), binary));

  let unreadable: unknown = null;
  for (const candidate of candidates) {
    try {
      if (!statSync(candidate).isFile()) continue;
      try {
        accessSync(candidate, constants.X_OK);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        // EACCES/EPERM positively establish that the shell cannot execute this
        // file. An I/O failure establishes nothing and must remain `unknown`.
        if (code !== 'EACCES' && code !== 'EPERM') unreadable ??= error;
        continue;
      }
      return candidate;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') unreadable ??= error;
    }
  }
  // Missing paths are a successful negative measurement. Permission or I/O
  // failures are not: laundering either into "not installed" would tell an
  // operator to reinstall a CLI whose directory we simply could not inspect.
  if (unreadable) throw unreadable;
  return null;
};

/** Measure binary presence in an environment that has already been composed. */
export function measureCredentialBinaryInEnv(input: {
  provider: CredentialProvider;
  env: Record<string, string>;
  cwd: string;
  resolveBinary?: CredentialBinaryResolver;
}): CredentialBinaryMeasurement {
  const binary = credentialBinaryFor(input.provider);
  try {
    const resolvedPath = (input.resolveBinary ?? resolveCredentialBinary)({
      binary,
      path: input.env['PATH'] ?? '',
      cwd: input.cwd,
    });
    if (resolvedPath !== null) {
      return {
        provider: input.provider,
        binary,
        status: 'available',
        resolvedPath,
        detail: null,
      };
    }
    return {
      provider: input.provider,
      binary,
      status: 'unavailable',
      resolvedPath: null,
      detail: `credential CLI '${binary}' is not on the login terminal's PATH`,
    };
  } catch (error) {
    return {
      provider: input.provider,
      binary,
      status: 'unknown',
      resolvedPath: null,
      detail:
        `could not inspect the login terminal's PATH for credential CLI '${binary}': ` +
        (error instanceof Error ? error.message : String(error)),
    };
  }
}

/**
 * Compose the login terminal's environment first, then inspect THAT PATH.
 *
 * This is the status/start seam. Checking `parentEnv.PATH` directly would miss
 * the package-manager directories `withAgentBinDirs` appends inside
 * `composeCredentialEnv`, falsely reporting a CLI unavailable even though the
 * terminal would have launched it.
 */
export function measureCredentialBinary(input: {
  provider: CredentialProvider;
  homeDir: string;
  configDir: string;
  parentEnv: NodeJS.ProcessEnv;
  resolveBinary?: CredentialBinaryResolver;
}): CredentialBinaryMeasurement {
  const env = composeCredentialEnv({
    provider: input.provider,
    homeDir: input.homeDir,
    configDir: input.configDir,
    parentEnv: input.parentEnv,
  });
  return measureCredentialBinaryInEnv({
    provider: input.provider,
    env,
    cwd: input.homeDir,
    ...(input.resolveBinary ? { resolveBinary: input.resolveBinary } : {}),
  });
}

/** The caller-fixable refusal used before a login work_session can be minted. */
export function credentialCliInstallMessage(provider: CredentialProvider): string {
  const binary = credentialBinaryFor(provider);
  return (
    `credential CLI '${binary}' is not installed on this node's login-terminal PATH. ` +
    CREDENTIAL_PROBE_SPECS[provider].install
  );
}

/**
 * The real runner: `execFile`, NO SHELL, and an environment that REPLACES
 * rather than extends the server's.
 *
 * `execFile` and not `exec` is the load-bearing choice — `exec` would hand the
 * argv to `/bin/sh`, which is the one thing a fixed command table exists to
 * avoid.
 */
export const execFileRunner: CommandRunner = (argv, options) =>
  new Promise((resolve) => {
    const [file, ...args] = argv;
    execFile(
      file as string,
      args,
      {
        env: options.env,
        cwd: options.cwd,
        timeout: PROBE_TIMEOUT_MS,
        maxBuffer: PROBE_MAX_BUFFER,
        // Belt and braces against the `exec` mistake above: even if this call
        // is edited to a shell-capable API later, `shell: false` is explicit.
        shell: false,
      },
      (error, stdout, stderr) => {
        // Resolves rather than rejects on a non-zero exit BY DESIGN. `gh auth
        // status` exits non-zero when logged out, which is a perfectly good
        // ANSWER — turning it into a thrown error would make "not logged in"
        // indistinguishable from "the CLI is missing".
        const exitCode =
          error && typeof (error as { code?: unknown }).code === 'number'
            ? ((error as { code: number }).code)
            : error
              ? null
              : 0;
        resolve({ exitCode, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });

/**
 * Refuse to probe in an environment that could produce a D6 false positive.
 *
 * Checked at the SEAM rather than trusted from `composeCredentialEnv`, because
 * the whole point of D6 is that the wrong answer looks exactly like the right
 * one. A second, independent assertion at the point of use is what makes the
 * first one's failure visible.
 */
export function assertNoGitHubTokenEnv(env: Record<string, string>): void {
  const present = GH_TOKEN_ENV_NAMES.filter((name) => name in env);
  if (present.length > 0) {
    throw new Error(
      `refusing to probe GitHub with ${present.join(' and ')} in the environment: ` +
        '`gh auth token` prefers the environment over hosts.yml, so the probe would ' +
        'report the wrong account as a success (finding D6)',
    );
  }
}

/**
 * `claude auth status` — JSON, and `loggedIn` is the whole answer.
 *
 * `login` is passed through from `email` rather than hard-coded to null.
 * Post-R4-amendment the table runs `claude auth login`, whose grant includes
 * `user:profile`, so a completed login answers with `email` present and it
 * lands in `login` ("Connected as <address>"). A NULL still occurs — an answer
 * without `email` (e.g. a store minted under the original `setup-token` verb)
 * reads as "Connected — inference access". Passing it through rather than
 * nulling it means this code states a FACT about what the probe returned
 * instead of encoding an assumption about which verb ran — which is exactly
 * why the amendment needed no parser change.
 */
function readAnthropicProbe(outcome: CommandOutcome): ProbeResult {
  const base = { provider: 'anthropic' as const, authMethod: null, login: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(firstJsonObject(outcome.stdout));
  } catch {
    return {
      ...base,
      connected: false,
      status: 'stale',
      detail: 'claude auth status did not answer JSON',
    };
  }
  const record = parsed as { loggedIn?: unknown; authMethod?: unknown; email?: unknown };

  // STRICT `=== true`. Not truthiness: the string "false" is truthy, and an
  // absent field must read as "not logged in", not as "probably fine".
  if (record.loggedIn !== true) {
    return {
      ...base,
      connected: false,
      status: 'stale',
      detail: 'claude auth status reports loggedIn=false — the login was not completed',
    };
  }
  return {
    provider: 'anthropic',
    connected: true,
    status: 'active',
    login: asText(record.email),
    authMethod: asText(record.authMethod),
    detail: null,
  };
}

/** `Logged in to github.com account <login>` — the hosts.yml identity. */
const GH_STATUS_LOGIN_RE = /Logged in to \S+ account (\S+)/;

/**
 * `gh auth status` plus the D6 cross-check.
 *
 * Two independent readings of "who is this": `gh auth status` reports what
 * `hosts.yml` says, and `gh api user` reports whoever the token in force
 * actually is. They agree only when the token in force IS the stored one. A
 * mismatch is refused rather than recorded, because the failure it detects —
 * persisting the machine's credential under the member's name — is exactly the
 * misattribution this whole feature exists to end.
 */
async function readGithubProbe(
  outcome: CommandOutcome,
  env: Record<string, string>,
  cwd: string,
  run: CommandRunner,
): Promise<ProbeResult> {
  const base = { provider: 'github' as const, authMethod: null, login: null };
  const text = `${outcome.stdout}\n${outcome.stderr}`;
  const match = GH_STATUS_LOGIN_RE.exec(text);
  if (!match?.[1]) {
    return {
      ...base,
      connected: false,
      status: 'stale',
      detail: 'gh auth status did not report a logged-in account',
    };
  }
  const hostsLogin = match[1];

  const api = await run(GH_API_USER_COMMAND, { env, cwd });
  const apiLogin = api.stdout.trim();
  if (apiLogin === '') {
    return {
      ...base,
      connected: false,
      status: 'stale',
      detail: 'gh api user returned no login, so the stored credential could not be cross-checked',
    };
  }
  if (apiLogin !== hostsLogin) {
    // The D6 case, caught. Both logins are named because the difference IS the
    // diagnosis: one of them is the machine account.
    return {
      ...base,
      connected: false,
      status: 'stale',
      detail:
        `gh api user answered as '${apiLogin}' but hosts.yml holds '${hostsLogin}' — ` +
        'refusing to store a credential that does not belong to the account that logged in (finding D6)',
    };
  }

  return {
    provider: 'github',
    connected: true,
    status: 'active',
    login: hostsLogin,
    authMethod: /Token scopes/.test(text) ? 'oauth' : null,
    detail: null,
  };
}

/**
 * `codex login status` — output NOT YET CAPTURED on any node.
 *
 * So this reads OPTIMISTICALLY for a positive signal and PESSIMISTICALLY for
 * everything else: anything it cannot positively read is `stale`. It never
 * returns `connected: true` on the strength of an exit code, which is the
 * shortcut a not-yet-measured format invites.
 *
 * When someone finally captures the real output, replace the heuristic below
 * with a parse and DELETE this paragraph. Until then the honest answer to
 * "is openai connected?" is "there may be a credential; we could not confirm
 * it", and `stale` is exactly that.
 */
function readOpenAiProbe(outcome: CommandOutcome): ProbeResult {
  const base = { provider: 'openai' as const, authMethod: null, login: null };
  const text = `${outcome.stdout}\n${outcome.stderr}`;

  // A JSON answer, if the CLI ever grows one, is read properly.
  try {
    const parsed = JSON.parse(firstJsonObject(text)) as {
      loggedIn?: unknown;
      email?: unknown;
      authMethod?: unknown;
    };
    if (parsed.loggedIn === true) {
      return {
        provider: 'openai',
        connected: true,
        status: 'active',
        login: asText(parsed.email),
        authMethod: asText(parsed.authMethod),
        detail: null,
      };
    }
    return {
      ...base,
      connected: false,
      status: 'stale',
      detail: 'codex login status reports no active login',
    };
  } catch {
    // Fall through to the text reading below. Not an error: the format is
    // unknown, and failing to parse an unknown format is expected.
  }

  if (outcome.exitCode === 0 && /Logged in|logged in/.test(text)) {
    const email = /([\w.+-]+@[\w-]+\.[\w.-]+)/.exec(text)?.[1] ?? null;
    return {
      provider: 'openai',
      connected: true,
      status: 'active',
      login: email,
      authMethod: null,
      detail: null,
    };
  }

  return {
    ...base,
    connected: false,
    status: 'stale',
    detail:
      "codex login status returned an answer this build cannot parse — recording 'stale' " +
      'rather than claiming a login that was never confirmed',
  };
}

/** The first `{...}` in a stream that may also carry log noise. */
function firstJsonObject(text: string): string {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return text.trim();
  return text.slice(start, end + 1);
}

function asText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

export interface RunCredentialProbeInput {
  provider: CredentialProvider;
  /** The SAME environment the login terminal ran in. */
  env: Record<string, string>;
  cwd: string;
  run?: CommandRunner;
  /** Injected independently from the command runner: presence is its own fact. */
  resolveBinary?: CredentialBinaryResolver;
}

function negativeProbe(
  provider: CredentialProvider,
  status: 'stale' | 'unavailable',
  detail: string,
): ProbeResult {
  return {
    provider,
    connected: false,
    status,
    login: null,
    authMethod: null,
    detail,
  };
}

/**
 * Gemini has no verified status command. Its measured OAuth file is therefore
 * the whole positive signal, and every non-positive result remains `stale`.
 * In particular, ENOENT is not "logged out": it may be an abandoned flow, a
 * different credential mode, or a later CLI storage shape we have not measured.
 */
async function readGeminiProbe(env: Record<string, string>): Promise<ProbeResult> {
  const home = env['HOME'];
  if (!home) {
    return negativeProbe(
      'gemini',
      'stale',
      'Gemini credential state is unknown because the isolated HOME was not present',
    );
  }
  const parts = CREDENTIAL_PROBE_SPECS.gemini.credentialFile;
  const credentialFile = join(home, ...parts);
  try {
    const info = await stat(credentialFile);
    if (!info.isFile()) {
      return negativeProbe(
        'gemini',
        'stale',
        'Gemini credential state is unknown because the measured credential path is not a file',
      );
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return negativeProbe(
      'gemini',
      'stale',
      code === 'ENOENT'
        ? 'Gemini credential state is unknown: its measured OAuth credential file is not present and there is no verified status verb'
        : `Gemini credential state is unknown because its measured credential file could not be inspected: ${
            error instanceof Error ? error.message : String(error)
          }`,
    );
  }
  return {
    provider: 'gemini',
    connected: true,
    status: 'active',
    // File presence establishes a usable OAuth credential, not the Google
    // account name or the CLI's own name for that auth method.
    login: null,
    authMethod: null,
    detail: null,
  };
}

/**
 * `cursor-agent status --format json` — a measured boolean answer.
 *
 * The signed-out payload observed on this node includes several other fields,
 * but a signed-in payload has not been observed. Reading only
 * `isAuthenticated` makes both boolean answers usable without inventing a
 * login, auth method, token field or status vocabulary that the evidence does
 * not establish. Exit status is deliberately irrelevant.
 */
function readCursorProbe(outcome: CommandOutcome): ProbeResult {
  const base = { provider: 'cursor' as const, authMethod: null, login: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(firstJsonObject(outcome.stdout));
  } catch {
    return {
      ...base,
      connected: false,
      status: 'stale',
      detail: 'cursor-agent status --format json did not answer JSON',
    };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {
      ...base,
      connected: false,
      status: 'stale',
      detail: 'cursor-agent status --format json returned an unexpected payload',
    };
  }

  const isAuthenticated = (parsed as Record<string, unknown>)['isAuthenticated'];
  if (typeof isAuthenticated !== 'boolean') {
    return {
      ...base,
      connected: false,
      status: 'stale',
      detail: 'cursor-agent status --format json did not answer a boolean isAuthenticated',
    };
  }

  if (!isAuthenticated) {
    return {
      ...base,
      connected: false,
      // `active` describes a successfully understood probe. Because negative
      // probes are never persisted, it cannot become an active credential row.
      status: 'active',
      detail: 'cursor-agent status reports isAuthenticated=false',
    };
  }

  return {
    ...base,
    connected: true,
    status: 'active',
    detail: null,
  };
}

/**
 * Run the provider's probe and return what it actually established.
 *
 * Note the order for github: the environment is asserted BEFORE the probe runs.
 * Probing first and checking after would mean the D6 cross-check ran against a
 * poisoned environment, where both readings agree — on the wrong account.
 */
export async function runCredentialProbe(input: RunCredentialProbeInput): Promise<ProbeResult> {
  const run = input.run ?? execFileRunner;
  const { provider, env, cwd } = input;

  if (provider === 'github') assertNoGitHubTokenEnv(env);

  const binary = measureCredentialBinaryInEnv({
    provider,
    env,
    cwd,
    ...(input.resolveBinary ? { resolveBinary: input.resolveBinary } : {}),
  });
  if (binary.status === 'unavailable') {
    return negativeProbe(
      provider,
      'unavailable',
      `${binary.detail}. ${CREDENTIAL_PROBE_SPECS[provider].install}`,
    );
  }
  if (binary.status === 'unknown') {
    return negativeProbe(provider, 'stale', binary.detail ?? 'credential CLI presence is unknown');
  }

  if (provider === 'gemini') return readGeminiProbe(env);
  if (provider === 'hermes') {
    return negativeProbe(
      provider,
      'stale',
      'Hermes credential state is unknown: neither a status verb nor a credential-file location has been verified on this node',
    );
  }

  const command = CREDENTIAL_PROBE_COMMANDS[provider];
  if (!command) {
    // Exhaustiveness above should make this unreachable. Keep it a refusal,
    // not a guessed command, if a provider is added without a measured probe.
    return negativeProbe(
      provider,
      'stale',
      `credential state for ${provider} is unknown because no verified probe exists`,
    );
  }
  const outcome = await run(command, { env, cwd });

  if (provider === 'anthropic') return readAnthropicProbe(outcome);
  if (provider === 'github') return readGithubProbe(outcome, env, cwd, run);
  if (provider === 'cursor') return readCursorProbe(outcome);
  return readOpenAiProbe(outcome);
}

/**
 * Extract the token only after the two-sided GitHub identity probe succeeded.
 *
 * The same D6 assertion is repeated at this exact seam because `gh auth token`
 * prefers environment variables over hosts.yml. Returning a parent token here
 * would persist the node's credential under the member's verified login while
 * every surrounding operation still looked successful.
 */
export async function captureGitHubToken(input: {
  env: Record<string, string>;
  cwd: string;
  run?: CommandRunner;
}): Promise<string> {
  assertNoGitHubTokenEnv(input.env);
  const run = input.run ?? execFileRunner;
  const outcome = await run(GH_AUTH_TOKEN_COMMAND, { env: input.env, cwd: input.cwd });
  const token = outcome.stdout.trim();
  if (outcome.exitCode !== 0 || token === '' || /\s/.test(token) || Buffer.byteLength(token) > 4_000) {
    // Never include stdout/stderr, a prefix, or a length: this is a secret
    // extraction failure, and diagnostic convenience is not worth token data.
    throw new Error('GitHub credential token could not be extracted safely');
  }
  return token;
}
