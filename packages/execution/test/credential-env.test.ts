/**
 * PR2 acceptance criteria 1, 2 and 3 — the scrubbed login environment and the
 * fixed command table.
 *
 * WHY EVERY ENVIRONMENT ASSERTION HERE IS ON THE EXACT KEY SET.
 *
 * The obvious test is `expect(env.GH_TOKEN).toBeUndefined()`. It is worth very
 * little. It passes unchanged on the day someone adds `ANTHROPIC_AUTH_TOKEN`,
 * or `TM8_AGENT_TOKEN`, or restores the `SAFE_BASE_ENV_KEYS` loop "for
 * consistency with composeEnv" — an ALLOWLIST REGRESSION is invisible to a
 * per-name assertion, and an allowlist regression is the exact failure this
 * whole file exists to prevent. So the assertions are `Object.keys(env).sort()`
 * against a literal, and the per-name checks below are kept only as NAMED
 * DOCUMENTATION of which specific leaks were measured, never as the primary
 * control.
 *
 * THE PARENT ENVIRONMENT IN THESE TESTS IS DELIBERATELY HOSTILE. It carries
 * every credential channel sub-doc 2 and sub-doc 14 enumerated, all set to
 * values that would be obvious in a diff if they leaked. A test whose parent
 * env is clean cannot distinguish "the function scrubs" from "there was nothing
 * to scrub" — the same single-principal mistake that makes an RLS test
 * worthless.
 */
import { describe, expect, it } from 'vitest';

import {
  composeCredentialEnv,
  credentialEnvKeys,
  CREDENTIAL_CONFIG_DIR_VAR,
  CREDENTIAL_PROVIDERS,
  type CredentialProvider,
} from '../src/credentials/credential-env.js';
import {
  CredentialSessionLauncher,
  CREDENTIAL_LOGIN_COMMANDS,
  type CredentialLaunchRequest,
} from '../src/credentials/CredentialSessionLauncher.js';
import type { PtySpawnParams } from '../src/pty/types.js';

const HOME_DIR = '/data/credentials/identity-alice';
const CONFIG_DIR = (provider: CredentialProvider): string => `${HOME_DIR}/${provider}`;

/**
 * A server environment polluted with every channel that has ever been measured
 * to reach a spawned process. If any of these names or values appears in the
 * result, the leak is named by the assertion that catches it.
 */
function pollutedParentEnv(): NodeJS.ProcessEnv {
  return {
    PATH: '/usr/bin:/bin',
    HOME: '/home/tm8',
    LANG: 'en_US.UTF-8',

    // C5 — outranks HOME for `gh`. The value is the NODE's config directory,
    // which is exactly what must not survive.
    XDG_CONFIG_HOME: '/home/tm8/.config',
    XDG_CACHE_HOME: '/home/tm8/.cache',

    // D6 / the `gh` login refusal. Both spellings.
    GH_TOKEN: 'ghp_LEAKED_MACHINE_TOKEN',
    GITHUB_TOKEN: 'ghp_LEAKED_MACHINE_TOKEN_2',

    // The agent auth channels `composeEnv` forwards on purpose.
    ANTHROPIC_API_KEY: 'sk-ant-LEAKED',
    OPENAI_API_KEY: 'sk-LEAKED',
    GEMINI_API_KEY: 'LEAKED',
    GOOGLE_API_KEY: 'LEAKED',

    // C7 — the spawning human's FULL identity, not a reduced principal.
    TM8_AGENT_TOKEN: 'tm8-agent-token-LEAKED',
    TM8_SESSION_ID: 'some-other-session',
    TM8_SPACE_ID: 'some-space',
    TM8_BASE_URL: 'http://127.0.0.1:4610',
    TM8_MANIFEST_PATH: '/data/manifests/other.json',
    TM8_TEAM_MEMBER_ID: 'some-member',
    TM8_ACTOR_ID: 'some-member',
    TM8_JOURNAL_PATH: '/data/journals/other.jsonl',

    // The per-vendor config redirects for the OTHER providers. A login terminal
    // for anthropic must not inherit the node's CODEX_HOME either.
    CLAUDE_CONFIG_DIR: '/home/tm8/.claude',
    CODEX_HOME: '/home/tm8/.codex',
    GH_CONFIG_DIR: '/home/tm8/.config/gh',

    // Vendor self-identification, which makes `claude` refuse to start when a
    // server was itself launched from inside Claude Code.
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    CLAUDECODE: '1',
  };
}

describe('composeCredentialEnv — acceptance criterion 1: the exact key set', () => {
  it.each(CREDENTIAL_PROVIDERS)(
    'returns exactly seven keys for %s, and the provider variable is the only vendor key',
    (provider) => {
      const env = composeCredentialEnv({
        provider,
        homeDir: HOME_DIR,
        configDir: CONFIG_DIR(provider),
        parentEnv: pollutedParentEnv(),
      });

      // THE PRIMARY CONTROL. Not "does not contain X" — "is exactly this".
      expect(Object.keys(env).sort()).toEqual([
        CREDENTIAL_CONFIG_DIR_VAR[provider],
        'HOME',
        'LANG',
        'PATH',
        'SHELL',
        'TERM',
        'XDG_CONFIG_HOME',
      ].sort());

      // The exported helper must agree with the function it describes; the
      // server-side probe asserts against it, so a drift between the two would
      // silently weaken a different test in a different package.
      expect(Object.keys(env).sort()).toEqual(credentialEnvKeys(provider));

      // Exactly ONE vendor config variable, never two.
      const vendorKeys = Object.values(CREDENTIAL_CONFIG_DIR_VAR).filter((key) => key in env);
      expect(vendorKeys).toEqual([CREDENTIAL_CONFIG_DIR_VAR[provider]]);
      expect(env[CREDENTIAL_CONFIG_DIR_VAR[provider]]).toBe(CONFIG_DIR(provider));
    },
  );

  /**
   * Secondary, and named rather than generic. Each of these is a measured
   * channel; the key-set assertion above already covers them, so this test
   * exists to make a future failure READ as the thing that broke.
   */
  it.each(CREDENTIAL_PROVIDERS)(
    'carries no agent token, no session identity and no vendor API key for %s',
    (provider) => {
      const env = composeCredentialEnv({
        provider,
        homeDir: HOME_DIR,
        configDir: CONFIG_DIR(provider),
        parentEnv: pollutedParentEnv(),
      });

      for (const forbidden of [
        'TM8_AGENT_TOKEN',
        'TM8_SESSION_ID',
        'TM8_SPACE_ID',
        'TM8_BASE_URL',
        'TM8_MANIFEST_PATH',
        'TM8_TEAM_MEMBER_ID',
        'TM8_ACTOR_ID',
        'TM8_JOURNAL_PATH',
        'GH_TOKEN',
        'GITHUB_TOKEN',
        'ANTHROPIC_API_KEY',
        'OPENAI_API_KEY',
        'GEMINI_API_KEY',
        'GOOGLE_API_KEY',
        'XDG_CACHE_HOME',
        'CLAUDE_CODE_ENTRYPOINT',
        'CLAUDECODE',
      ]) {
        expect(env, `${forbidden} leaked into a ${provider} login terminal`).not.toHaveProperty(
          forbidden,
        );
      }

      // No TM8_ prefix at all, so a variable added later is caught by shape
      // rather than by being remembered and added to the list above.
      expect(Object.keys(env).filter((key) => key.startsWith('TM8_'))).toEqual([]);

      // And no VALUE from the polluted parent survives under a different name —
      // the leak a key-set assertion alone cannot see.
      const values = Object.values(env).join('\n');
      for (const secret of [
        'ghp_LEAKED_MACHINE_TOKEN',
        'sk-ant-LEAKED',
        'sk-LEAKED',
        'tm8-agent-token-LEAKED',
      ]) {
        expect(values).not.toContain(secret);
      }
    },
  );
});

describe('composeCredentialEnv — acceptance criterion 2: XDG_CONFIG_HOME (finding C5)', () => {
  /**
   * The finding, restated so a future reader does not "simplify" this away:
   * `gh` resolves GH_CONFIG_DIR > $XDG_CONFIG_HOME/gh > $HOME/.config/gh. A
   * per-identity HOME is therefore NOT sufficient — the middle rung wins over
   * it. `SAFE_BASE_ENV_KEYS` copies XDG_CONFIG_HOME out of the server process,
   * so on a node where an operator sets it, `gh` isolation reverts silently.
   */
  it.each(CREDENTIAL_PROVIDERS)(
    'never lets a polluted parent XDG_CONFIG_HOME through, for %s',
    (provider) => {
      const env = composeCredentialEnv({
        provider,
        homeDir: HOME_DIR,
        configDir: CONFIG_DIR(provider),
        parentEnv: pollutedParentEnv(),
      });
      expect(env['XDG_CONFIG_HOME']).not.toBe('/home/tm8/.config');
    },
  );

  it('sets XDG_CONFIG_HOME EXPLICITLY, inside the identity home, rather than omitting it', () => {
    const env = composeCredentialEnv({
      provider: 'github',
      homeDir: HOME_DIR,
      configDir: CONFIG_DIR('github'),
      parentEnv: pollutedParentEnv(),
    });
    // Present, not merely absent: an omitted variable is one `Environment=`
    // line away from being the node's again, and an empty string would make
    // `gh` resolve `/gh` at the filesystem root.
    expect(env).toHaveProperty('XDG_CONFIG_HOME');
    expect(env['XDG_CONFIG_HOME']).toBe(`${HOME_DIR}/.config`);
    expect(env['XDG_CONFIG_HOME']?.startsWith(HOME_DIR)).toBe(true);
  });

  it('is set even when the parent environment has no XDG_CONFIG_HOME at all', () => {
    // The deployed unit's state today. The variable being unset is why C5 is
    // latent rather than live, and is exactly the condition under which an
    // "inherit if present" implementation would look correct forever.
    const env = composeCredentialEnv({
      provider: 'github',
      homeDir: HOME_DIR,
      configDir: CONFIG_DIR('github'),
      parentEnv: { PATH: '/usr/bin:/bin', HOME: '/home/tm8' },
    });
    expect(env['XDG_CONFIG_HOME']).toBe(`${HOME_DIR}/.config`);
  });
});

describe('composeCredentialEnv — HOME, PATH and the two values it is allowed to read', () => {
  it('gives the terminal the identity HOME, never the server HOME', () => {
    const env = composeCredentialEnv({
      provider: 'anthropic',
      homeDir: HOME_DIR,
      configDir: CONFIG_DIR('anthropic'),
      parentEnv: pollutedParentEnv(),
    });
    expect(env['HOME']).toBe(HOME_DIR);
    expect(env['HOME']).not.toBe('/home/tm8');
  });

  it('starts PATH from the server PATH, because that is where the vendor CLIs live', () => {
    const env = composeCredentialEnv({
      provider: 'github',
      homeDir: HOME_DIR,
      configDir: CONFIG_DIR('github'),
      parentEnv: { PATH: '/opt/custom/bin', HOME: '/home/tm8' },
    });
    expect(env['PATH']?.split(':')[0]).toBe('/opt/custom/bin');
  });

  it('falls back to the bare launchd PATH rather than emitting an empty one', () => {
    // A server started by launchd inherits `/usr/bin:/bin:/usr/sbin:/sbin`; a
    // server started with no PATH at all must not produce a terminal that can
    // run nothing, because the resulting 127 reads as "the login failed".
    const env = composeCredentialEnv({
      provider: 'openai',
      homeDir: HOME_DIR,
      configDir: CONFIG_DIR('openai'),
      parentEnv: { HOME: '/home/tm8' },
    });
    expect(env['PATH']).toContain('/usr/bin');
    expect(env['PATH']).not.toBe('');
  });

  it('sets a real TERM and a real LANG so the device code is legible', () => {
    const env = composeCredentialEnv({
      provider: 'openai',
      homeDir: HOME_DIR,
      configDir: CONFIG_DIR('openai'),
      parentEnv: { PATH: '/usr/bin', HOME: '/home/tm8', TERM: 'dumb' },
    });
    expect(env['TERM']).toBe('xterm-256color');
    expect(env['LANG']).toBe('C.UTF-8');
  });
});

// ---------------------------------------------------------------------------
// Acceptance criterion 3 — argv comes from the table, and nothing else does.
// ---------------------------------------------------------------------------

/** A PtyHostService stand-in that records exactly what it was asked to run. */
function recordingPty(): { calls: PtySpawnParams[]; pty: PtyHostService } {
  const calls: PtySpawnParams[] = [];
  const pty = {
    spawnIfAbsent(params: PtySpawnParams): { reused: boolean } {
      calls.push(params);
      return { reused: false };
    },
    hasSession(): boolean {
      return false;
    },
    kill(): 'killed' {
      return 'killed';
    },
  } as unknown as PtyHostService;
  return { calls, pty };
}

describe('CredentialSessionLauncher — acceptance criterion 3: the fixed command table', () => {
  it.each(CREDENTIAL_PROVIDERS)('runs exactly the table entry for %s', (provider) => {
    const { calls, pty } = recordingPty();
    const launcher = new CredentialSessionLauncher({ pty, env: pollutedParentEnv() });

    const result = launcher.launch({
      sessionId: 'session-1',
      provider,
      homeDir: HOME_DIR,
      configDir: CONFIG_DIR(provider),
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe(CREDENTIAL_LOGIN_COMMANDS[provider]);
    expect(result.command).toBe(CREDENTIAL_LOGIN_COMMANDS[provider]);
    expect(calls[0]?.cwd).toBe(HOME_DIR);
    // The spawned environment is the credential environment, not some other
    // one composed on the way through.
    expect(Object.keys(calls[0]?.env ?? {}).sort()).toEqual(credentialEnvKeys(provider));
  });

  it('pins the exact table entries, so a change to one is a change to this test', () => {
    // The values are asserted literally rather than compared to themselves.
    // `codex login --device-auth` in particular must never decay to bare
    // `codex login`, which opens a loopback listener nobody can reach.
    expect(CREDENTIAL_LOGIN_COMMANDS).toEqual({
      // `claude auth login`, not `claude setup-token` — setup-token PRINTS a
      // token and never persists a login, so the `claude auth status` finish
      // probe could never see a completed flow (R4 amendment, measured on
      // Utho prod 2026-08-09).
      anthropic: 'claude auth login',
      openai: 'codex login --device-auth',
      github: 'gh auth login --web --hostname github.com --git-protocol https --skip-ssh-key',
    });
  });

  it('lets no request field reach argv, even when every field is hostile', () => {
    const { calls, pty } = recordingPty();
    const launcher = new CredentialSessionLauncher({ pty, env: pollutedParentEnv() });

    // Every string the request type accepts, carrying a shell injection. If any
    // of them reached the command line, the marker below would appear in it.
    const hostile: CredentialLaunchRequest = {
      sessionId: 'sess; touch /tmp/PWNED #INJECTED',
      provider: 'github',
      homeDir: `${HOME_DIR}$(touch /tmp/PWNED)#INJECTED`,
      configDir: `${CONFIG_DIR('github')}\`touch /tmp/PWNED\`#INJECTED`,
    };
    launcher.launch(hostile);

    expect(calls[0]?.command).toBe(CREDENTIAL_LOGIN_COMMANDS.github);
    expect(calls[0]?.command).not.toContain('INJECTED');
    expect(calls[0]?.command).not.toContain('PWNED');

    // And the structural half of the same claim: the request TYPE has no field
    // that could carry a command. A field that does not exist cannot be
    // forwarded by a later refactor, which is a stronger guarantee than any
    // assertion about a value.
    expect(Object.keys(hostile).sort()).toEqual([
      'configDir',
      'homeDir',
      'provider',
      'sessionId',
    ]);
  });

  it('passes terminal geometry through and nothing else', () => {
    const { calls, pty } = recordingPty();
    const launcher = new CredentialSessionLauncher({ pty, env: pollutedParentEnv() });
    launcher.launch({
      sessionId: 'session-2',
      provider: 'anthropic',
      homeDir: HOME_DIR,
      configDir: CONFIG_DIR('anthropic'),
      cols: 120,
      rows: 40,
    });
    expect(calls[0]?.cols).toBe(120);
    expect(calls[0]?.rows).toBe(40);
    expect(calls[0]?.command).toBe(CREDENTIAL_LOGIN_COMMANDS.anthropic);
  });
});
