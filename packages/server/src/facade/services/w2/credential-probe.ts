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
 *
 * The openai row is the honest one. Nobody has run that command and recorded
 * its output, so this file does not pretend to parse it: an answer it cannot
 * read is recorded as `stale`, never as success. `stale` is the correct verdict
 * — a credential may well exist on disk, we simply cannot confirm it — and it
 * is a status `account_agent_credentials` already models.
 */
import { execFile } from 'node:child_process';

import type { CredentialProvider } from '@tm8/execution';

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
export const CREDENTIAL_PROBE_COMMANDS = {
  anthropic: ['claude', 'auth', 'status'],
  openai: ['codex', 'login', 'status'],
  github: ['gh', 'auth', 'status'],
} as const satisfies Record<CredentialProvider, readonly string[]>;

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

/** Names that must not exist in a probe environment. See D6 above. */
export const GH_TOKEN_ENV_NAMES = ['GH_TOKEN', 'GITHUB_TOKEN'] as const;

export interface ProbeResult {
  provider: CredentialProvider;
  /** True ONLY when the probe positively confirmed an authenticated identity. */
  connected: boolean;
  /**
   * `active` when confirmed, `stale` when the probe could not be read.
   *
   * There is deliberately no `failed`: a probe that cannot be parsed has told
   * us nothing about the credential, and recording "no credential" on the
   * strength of an unreadable answer is a claim the evidence does not support.
   */
  status: 'active' | 'stale';
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

  const outcome = await run(CREDENTIAL_PROBE_COMMANDS[provider], { env, cwd });

  if (provider === 'anthropic') return readAnthropicProbe(outcome);
  if (provider === 'github') return readGithubProbe(outcome, env, cwd, run);
  return readOpenAiProbe(outcome);
}
