// PR5 — the spawn side of per-member credential delivery.
//
// WHY THESE ASSERTIONS ARE ON EXACT KEY SETS AND NOT ON SINGLE NAMES.
//
// The defect this lane closes is an ALLOWLIST defect: `SAFE_BASE_ENV_KEYS`
// copied `XDG_CONFIG_HOME` out of the server process into every agent, and `gh`
// resolves `GH_CONFIG_DIR` > `$XDG_CONFIG_HOME/gh` > `$HOME/.config/gh`, so the
// copied value OUTRANKS a per-identity `HOME`. A test written as
// `expect(env.XDG_CONFIG_HOME).toBeUndefined()` would pass forever and would
// say nothing at all the day someone adds the next credential-shaped name to
// that list — which is precisely how this one arrived. Asserting the whole key
// set means any future addition has to be looked at by a human, once, on
// purpose.
//
// The live proofs — a real PTY, a real `bash`, and the real `claude` CLI —
// are in `credential-injection-live.test.ts`. Those are what make the claims
// here measured rather than merely internally consistent.

import { describe, expect, it } from 'vitest';

import {
  AGENT_CREDENTIAL_CONFIG_DIR_VAR,
  AGENT_TOOL_CREDENTIAL_PROVIDER,
  agentCredentialEnv,
  agentCredentialProviderFor,
  agentCredentialXdgConfigHome,
  type AgentCredentialHome,
} from '../src/spawn/agent-credentials.js';
import { CREDENTIAL_CONFIG_DIR_VAR, composeCredentialEnv } from '../src/credentials/credential-env.js';
import { composeEnv, composeManifest } from '../src/spawn/manifest.js';
import type { SpawnContext, SpawnRequest } from '../src/spawn/types.js';

const SPACE_ID = '11111111-1111-4111-8111-111111111111';
const MEMBER_ID = '22222222-2222-4222-8222-222222222222';

const request: SpawnRequest = { spaceId: SPACE_ID, teamMemberId: MEMBER_ID };

const context = (): SpawnContext => ({
  spaceId: SPACE_ID,
  project: { id: 'proj-1', name: 'tm8', workingDir: '/tmp/tm8-fixture', trust: 'trusted' },
  teamMember: {
    id: MEMBER_ID,
    name: 'Fixture Member',
    role: 'fixture',
    identity: 'fixture',
    memories: [],
    model: 'opus',
    agentTool: null,
    mode: 'worker',
    permissionMode: null,
    avatar: null,
    capabilities: {},
    commandPermissions: {},
  },
  tasks: [],
});

function manifestFor(agentTool: string) {
  return composeManifest({
    sessionId: 'sess-1',
    request,
    context: context(),
    launch: {
      mode: 'worker',
      model: 'opus',
      agentTool,
      permissionMode: 'acceptEdits',
      accessMode: 'acceptEdits',
      reasoningEffort: null,
    },
    workdir: { mode: 'scratch', path: '/tmp/tm8-fixture' },
    command: 'claude',
    baseUrl: 'http://127.0.0.1:4610',
  });
}

/**
 * A server environment carrying a POLLUTED `XDG_CONFIG_HOME`.
 *
 * This is not a hypothetical value. It is what one `Environment=` line in the
 * systemd unit produces, and the whole of finding C5 is that such a line
 * silently reverts credential isolation with nothing going red.
 */
const POLLUTED_PARENT: NodeJS.ProcessEnv = {
  HOME: '/home/tm8',
  USER: 'tm8',
  PATH: '/usr/bin:/bin',
  TERM: 'xterm-256color',
  XDG_CONFIG_HOME: '/home/tm8/.config',
  XDG_CACHE_HOME: '/home/tm8/.cache',
};

const HOME_DIR = '/var/lib/tm8/credentials/identity-alice';

const aliceHome: AgentCredentialHome = {
  provider: 'anthropic',
  homeDir: HOME_DIR,
  configDir: `${HOME_DIR}/anthropic`,
};

describe('finding C5 — XDG_CONFIG_HOME is DECIDED by composeEnv, never inherited', () => {
  it('does not let a polluted parent XDG_CONFIG_HOME reach a session with no credential', () => {
    const env = composeEnv(manifestFor('claude-code'), '/tmp/m.json', 'http://x', POLLUTED_PARENT);

    // Cleared, not overwritten: `PtyHostService.spawn` hands node-pty this
    // record as the COMPLETE child environment and never merges `process.env`,
    // so an absent key is an absent variable in the child. That is proved
    // against a real PTY in credential-injection-live.test.ts — it is the load
    // -bearing fact behind this assertion and it is not taken on trust.
    expect(env).not.toHaveProperty('XDG_CONFIG_HOME');

    // The sibling that SHOULD still be inherited, so this is a targeted
    // removal and not a blanket one. A cache directory is not an auth input.
    expect(env.XDG_CACHE_HOME).toBe('/home/tm8/.cache');
  });

  it('points XDG_CONFIG_HOME inside the identity home when one is injected', () => {
    const env = composeEnv(
      manifestFor('claude-code'),
      '/tmp/m.json',
      'http://x',
      POLLUTED_PARENT,
      undefined,
      undefined,
      aliceHome,
    );

    expect(env.XDG_CONFIG_HOME).toBe(`${HOME_DIR}/.config`);
    // The point of the whole finding: the node's value did NOT win.
    expect(env.XDG_CONFIG_HOME).not.toBe('/home/tm8/.config');
  });

  it('agrees with composeCredentialEnv on where an identity XDG_CONFIG_HOME lives', () => {
    // The login terminal WRITES this directory and the agent READS it. If these
    // two ever disagree the feature fails silently — the capture succeeds, the
    // card says Connected, and the agent authenticates as the node.
    const terminal = composeCredentialEnv({
      provider: 'anthropic',
      homeDir: HOME_DIR,
      configDir: `${HOME_DIR}/anthropic`,
      parentEnv: POLLUTED_PARENT,
    });

    expect(agentCredentialXdgConfigHome(HOME_DIR)).toBe(terminal.XDG_CONFIG_HOME);
  });
});

describe('the exact key set a composed agent environment carries', () => {
  /** Every key `composeEnv` emits for this fixture with no credential home. */
  const BASE_KEYS = [
    'CLAUDECODE',
    'CLAUDE_CODE_ENTRYPOINT',
    'DISABLE_AUTOUPDATER',
    'HOME',
    'PATH',
    'TERM',
    'TM8_ACTOR_ID',
    'TM8_AGENT_TOOL',
    'TM8_BASE_URL',
    'TM8_MANIFEST_PATH',
    'TM8_MODE',
    'TM8_MODEL',
    'TM8_PROJECT_ID',
    'TM8_SESSION_ID',
    'TM8_SPACE_ID',
    'TM8_TASK_IDS',
    'TM8_TEAM_MEMBER_ID',
    'USER',
    'XDG_CACHE_HOME',
  ].sort();

  it('is exactly this, and XDG_CONFIG_HOME is not in it', () => {
    const env = composeEnv(manifestFor('claude-code'), '/tmp/m.json', 'http://x', POLLUTED_PARENT);
    expect(Object.keys(env).sort()).toEqual(BASE_KEYS);
  });

  it('grows by EXACTLY the config-dir variable and XDG_CONFIG_HOME when a credential is injected', () => {
    const env = composeEnv(
      manifestFor('claude-code'),
      '/tmp/m.json',
      'http://x',
      POLLUTED_PARENT,
      undefined,
      undefined,
      aliceHome,
    );

    expect(Object.keys(env).sort()).toEqual([...BASE_KEYS, 'CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME'].sort());
  });
});

describe('the config-dir variable is chosen by agent tool', () => {
  it('gives the anthropic tool CLAUDE_CONFIG_DIR and nothing else', () => {
    expect(agentCredentialEnv(aliceHome)).toEqual({
      CLAUDE_CONFIG_DIR: `${HOME_DIR}/anthropic`,
      XDG_CONFIG_HOME: `${HOME_DIR}/.config`,
    });
  });

  it('gives the openai tool CODEX_HOME and nothing else', () => {
    expect(
      agentCredentialEnv({
        provider: 'openai',
        homeDir: HOME_DIR,
        configDir: `${HOME_DIR}/openai`,
      }),
    ).toEqual({
      CODEX_HOME: `${HOME_DIR}/openai`,
      XDG_CONFIG_HOME: `${HOME_DIR}/.config`,
    });
  });

  it('resolves each shipped agent tool to its provider, and everything else to none', () => {
    expect(agentCredentialProviderFor('claude-code')).toBe('anthropic');
    expect(agentCredentialProviderFor('codex')).toBe('openai');
    // `echo-agent` is the built-in smoke agent and authenticates against
    // nothing; an unknown tool must not be guessed at.
    expect(agentCredentialProviderFor('echo-agent')).toBeNull();
    expect(agentCredentialProviderFor('some-operator-wrapper')).toBeNull();
    expect(agentCredentialProviderFor(null)).toBeNull();
  });

  it('never routes github through the agent path', () => {
    // github is string-shaped and already ships as env-var injection with a
    // load-bearing empty-value helper reset. A second delivery mechanism here
    // would race the first. See sub-doc 11 §A5.
    expect(Object.values(AGENT_TOOL_CREDENTIAL_PROVIDER)).not.toContain('github');
    expect(AGENT_CREDENTIAL_CONFIG_DIR_VAR).not.toHaveProperty('github');
  });
});

describe('finding C8 — a session never carries two credentials for one provider', () => {
  /**
   * Architect ruling 13. MEASURED against the real CLI before it was ruled:
   * with `CLAUDE_CONFIG_DIR` pointed at an identity home AND the node's
   * `ANTHROPIC_API_KEY` forwarded, `claude auth status` reports
   * `apiKeySource: "ANTHROPIC_API_KEY"`; with an EMPTY identity home it reports
   * `authMethod: "api_key"` outright. So the node's key competes with, and can
   * beat, the member's own login — silently, under the member's name.
   *
   * Both directions are asserted, because the suppression is only correct if it
   * is SCOPED: an unconnected member must keep today's behaviour byte for byte.
   */
  const NODE_KEYS: NodeJS.ProcessEnv = {
    ...POLLUTED_PARENT,
    ANTHROPIC_API_KEY: 'sk-ant-node-key',
    OPENAI_API_KEY: 'sk-openai-node-key',
    GEMINI_API_KEY: 'gemini-node-key',
  };

  it('drops the node ANTHROPIC_API_KEY when the member has connected anthropic', () => {
    const env = composeEnv(
      manifestFor('claude-code'),
      '/tmp/m.json',
      'http://x',
      NODE_KEYS,
      undefined,
      undefined,
      aliceHome,
    );

    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
    // Scoped to the CONNECTED provider only. The member connected anthropic,
    // not openai, so the node's openai key is untouched.
    expect(env.OPENAI_API_KEY).toBe('sk-openai-node-key');
    // No admitted gemini provider (ruling 6) — suppression must not generalise.
    expect(env.GEMINI_API_KEY).toBe('gemini-node-key');
  });

  it('drops the node OPENAI_API_KEY when the member has connected openai', () => {
    const env = composeEnv(
      manifestFor('codex'),
      '/tmp/m.json',
      'http://x',
      NODE_KEYS,
      undefined,
      undefined,
      { provider: 'openai', homeDir: HOME_DIR, configDir: `${HOME_DIR}/openai` },
    );

    expect(env).not.toHaveProperty('OPENAI_API_KEY');
    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-node-key');
  });

  it('leaves an UNCONNECTED member on exactly today behaviour', () => {
    // The regression half of the ruling. A node that deliberately runs on an
    // API key must be unaffected for every member who has not connected.
    const env = composeEnv(manifestFor('claude-code'), '/tmp/m.json', 'http://x', NODE_KEYS);

    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-node-key');
    expect(env.OPENAI_API_KEY).toBe('sk-openai-node-key');
    expect(env.GEMINI_API_KEY).toBe('gemini-node-key');
  });
});

describe('drift guard — the agent table and the login-terminal table are one convention', () => {
  /**
   * These two tables are duplicated ON PURPOSE: `credential-env.ts` imports
   * `withAgentBinDirs` from `manifest.ts`, so importing its table back into the
   * spawn path would close an import cycle. This test is the price of that
   * decision, and it is what stops "two tables" becoming "two conventions" —
   * the exact failure this codebase has already had with duplicated function
   * bodies drifting apart (`can_act_as`, 002 -> 075).
   */
  it('maps every shared provider to the same variable name', () => {
    for (const provider of ['anthropic', 'openai'] as const) {
      expect(AGENT_CREDENTIAL_CONFIG_DIR_VAR[provider]).toBe(CREDENTIAL_CONFIG_DIR_VAR[provider]);
    }
  });
});

describe('the two composers stay separate functions', () => {
  /**
   * Criterion 5, asserted structurally rather than by reading the source.
   *
   * A boolean flag collapsing these two would be invisible in review: both arms
   * typecheck, both return `Record<string, string>`, and every per-name
   * assertion still passes. The observable difference is the KEY SETS, so that
   * is what this asserts — an agent environment carries the spawning human's
   * full-identity agent token and the tm8 boot contract; a login terminal, into
   * which a member types their vendor password, carries neither.
   */
  it('an agent env carries the boot contract and the agent token; a login terminal carries neither', () => {
    const agent = composeEnv(
      manifestFor('claude-code'),
      '/tmp/m.json',
      'http://x',
      POLLUTED_PARENT,
      undefined,
      'tm8s_auth-session.secret',
      aliceHome,
    );
    const terminal = composeCredentialEnv({
      provider: 'anthropic',
      homeDir: HOME_DIR,
      configDir: `${HOME_DIR}/anthropic`,
      parentEnv: { ...POLLUTED_PARENT, ANTHROPIC_API_KEY: 'sk-node-key' },
    });

    expect(agent.TM8_AGENT_TOKEN).toBe('tm8s_auth-session.secret');
    expect(agent.TM8_SESSION_ID).toBe('sess-1');

    expect(Object.keys(terminal).sort()).toEqual(
      ['HOME', 'PATH', 'TERM', 'LANG', 'SHELL', 'XDG_CONFIG_HOME', 'CLAUDE_CONFIG_DIR'].sort(),
    );

    // Stated as a set relation, so a new tm8_* or provider key added to the
    // agent env can never silently appear in a login terminal.
    const agentOnly = Object.keys(agent).filter((k) => !(k in terminal));
    expect(agentOnly).toContain('TM8_AGENT_TOKEN');
    for (const key of Object.keys(terminal)) {
      if (key === 'CLAUDE_CONFIG_DIR' || key === 'XDG_CONFIG_HOME') continue;
      expect(['HOME', 'PATH', 'TERM', 'LANG', 'SHELL']).toContain(key);
    }
  });
});
