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
  AGENT_CREDENTIAL_SUPPRESSED_ENV_KEYS,
  AGENT_TOOL_CREDENTIAL_PROVIDER,
  agentCredentialEnv,
  agentCredentialProviderFor,
  agentCredentialXdgConfigHome,
  type AgentCredentialHome,
  type AgentCredentialProvider,
} from '../src/spawn/agent-credentials.js';
import {
  apiKeyBackendDisplaces,
  apiKeyBackendOutrankedBy,
  apiKeyBackendsForAgentTool,
  API_KEY_CREDENTIAL_PROVIDERS,
  apiKeyBackendEnv,
  apiKeyVerifyHeaders,
  API_KEY_PROVIDER_VERIFY_AUTH,
  apiKeyBackendAgentTool,
  isApiKeyBackend,
  isApiKeyCredentialProvider,
} from '../src/credentials/api-key-credentials.js';
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
  /**
   * A claude-code launch carries NOTHING extra. It used to grow by the
   * auto-compaction window; that knob was removed, so every tool's base
   * environment is now the same list.
   */
  const CLAUDE_KEYS = BASE_KEYS;

  it('is exactly this, and XDG_CONFIG_HOME is not in it', () => {
    const env = composeEnv(manifestFor('claude-code'), '/tmp/m.json', 'http://x', POLLUTED_PARENT);
    expect(Object.keys(env).sort()).toEqual(CLAUDE_KEYS);
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

    expect(Object.keys(env).sort()).toEqual([...CLAUDE_KEYS, 'CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME'].sort());
  });

  it.each(['gemini', 'hermes', 'cursor'] as const)(
    'replaces only HOME and adds XDG_CONFIG_HOME for a spawned %s environment',
    (provider) => {
      const env = composeEnv(
        manifestFor(provider),
        '/tmp/m.json',
        'http://x',
        POLLUTED_PARENT,
        undefined,
        undefined,
        { provider, homeDir: HOME_DIR, configDir: `${HOME_DIR}/${provider}` },
      );

      expect(Object.keys(env).sort()).toEqual([...BASE_KEYS, 'XDG_CONFIG_HOME'].sort());
      expect(env.HOME).toBe(HOME_DIR);
      expect(env.XDG_CONFIG_HOME).toBe(`${HOME_DIR}/.config`);
    },
  );
});

describe('the exact credential fragment is chosen by agent tool', () => {
  it('pins the complete config-directory override table', () => {
    expect(AGENT_CREDENTIAL_CONFIG_DIR_VAR).toEqual({
      anthropic: 'CLAUDE_CONFIG_DIR',
      openai: 'CODEX_HOME',
      gemini: null,
      hermes: null,
      cursor: null,
      // The API-key backends take their DISPLACED tool's variable, because the
      // program this table configures is that tool. A `claude-code` session
      // running on a Kimi key is still `claude`, and pointing CLAUDE_CONFIG_DIR
      // at the kimi directory does two things at once: it gives `claude` a
      // config home beside the credential that selected it, and — the half that
      // matters — it makes the member's REAL Anthropic login, which lives in
      // the sibling `anthropic/` directory, unreachable from this session. A
      // stored OAuth login beats an `ANTHROPIC_AUTH_TOKEN`, so without this the
      // routing would silently not happen for exactly the members who have both
      // connected.
      kimi: 'CLAUDE_CONFIG_DIR',
      groq: 'CODEX_HOME',
      // Grok redirects `codex` exactly as Groq does — same tool, same isolation
      // variable. The vendors differ only in base URL, which this table does
      // not hold.
      grok: 'CODEX_HOME',
    });
  });

  it('keeps the anthropic key set and values byte-for-byte unchanged', () => {
    const env = agentCredentialEnv(aliceHome);
    expect(Object.keys(env).sort()).toEqual(['CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME']);
    expect(env).toEqual({
      CLAUDE_CONFIG_DIR: `${HOME_DIR}/anthropic`,
      XDG_CONFIG_HOME: `${HOME_DIR}/.config`,
    });
  });

  it('keeps the openai key set and values byte-for-byte unchanged', () => {
    const env = agentCredentialEnv({
      provider: 'openai',
      homeDir: HOME_DIR,
      configDir: `${HOME_DIR}/openai`,
    });
    expect(Object.keys(env).sort()).toEqual(['CODEX_HOME', 'XDG_CONFIG_HOME']);
    expect(env).toEqual({
      CODEX_HOME: `${HOME_DIR}/openai`,
      XDG_CONFIG_HOME: `${HOME_DIR}/.config`,
    });
  });

  it.each(['gemini', 'hermes', 'cursor'] as const)(
    'redirects HOME for HOME-scoped %s and emits no invented config variable',
    (provider) => {
      expect(agentCredentialEnv({
        provider,
        homeDir: HOME_DIR,
        configDir: `${HOME_DIR}/${provider}`,
      })).toEqual({
        HOME: HOME_DIR,
        XDG_CONFIG_HOME: `${HOME_DIR}/.config`,
      });
    },
  );

  it('resolves every mapped agent tool to its provider, and everything else to none', () => {
    expect(AGENT_TOOL_CREDENTIAL_PROVIDER).toEqual({
      'claude-code': 'anthropic',
      codex: 'openai',
      gemini: 'gemini',
      hermes: 'hermes',
      cursor: 'cursor',
    });
    for (const [agentTool, provider] of Object.entries(AGENT_TOOL_CREDENTIAL_PROVIDER)) {
      expect(agentCredentialProviderFor(agentTool)).toBe(provider);
    }
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
    GOOGLE_API_KEY: 'google-node-key',
    CURSOR_API_KEY: 'cursor-node-key',
  };

  it('pins the complete provider-scoped suppression table', () => {
    expect(AGENT_CREDENTIAL_SUPPRESSED_ENV_KEYS).toEqual({
      anthropic: ['ANTHROPIC_API_KEY'],
      openai: ['OPENAI_API_KEY'],
      gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
      hermes: [],
      cursor: ['CURSOR_API_KEY'],
      // Kimi suppresses BOTH Anthropic key variables, including the one it then
      // injects. `ANTHROPIC_AUTH_TOKEN` is listed here so that a node-level
      // value cannot survive into a Kimi session on the path where the member's
      // own key turns out to be unreadable; `manifest.ts` re-sets it afterwards
      // from the member's file, and the ORDER is what makes both true.
      kimi: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'],
      // Same shape, one variable: `OPENAI_API_KEY` is simultaneously the node
      // key being suppressed and the member key being injected.
      groq: ['OPENAI_API_KEY'],
      grok: ['OPENAI_API_KEY'],
    });
  });

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
    // Gemini is admitted, but suppression remains scoped to the provider whose
    // member credential this particular session received.
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

  it('drops both node key spellings when the member credential is Gemini', () => {
    const env = composeEnv(
      manifestFor('gemini'),
      '/tmp/m.json',
      'http://x',
      NODE_KEYS,
      undefined,
      undefined,
      { provider: 'gemini', homeDir: HOME_DIR, configDir: `${HOME_DIR}/gemini` },
    );

    expect(env.HOME).toBe(HOME_DIR);
    expect(env).not.toHaveProperty('GEMINI_API_KEY');
    expect(env).not.toHaveProperty('GOOGLE_API_KEY');
    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-node-key');
  });

  it('leaves an UNCONNECTED member on exactly today behaviour', () => {
    // The regression half of the ruling. A node that deliberately runs on an
    // API key must be unaffected for every member who has not connected.
    const env = composeEnv(manifestFor('claude-code'), '/tmp/m.json', 'http://x', NODE_KEYS);

    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-node-key');
    expect(env.OPENAI_API_KEY).toBe('sk-openai-node-key');
    expect(env.GEMINI_API_KEY).toBe('gemini-node-key');
    expect(env.GOOGLE_API_KEY).toBe('google-node-key');
  });
});

/**
 * API-KEY BACKEND ROUTING — the ordering claim, proved rather than commented.
 *
 * Kimi and Groq are not extra tools; they are alternative BACKENDS reached by
 * pointing an existing tool's SDK at a different base URL. Everything about the
 * launch is unchanged, which is what makes the one hazard here easy to miss:
 * for Groq the variable being SUPPRESSED and the variable being INJECTED are
 * the same name, so the whole feature rests on the suppression loop running
 * first. Nothing in the type system says so, and both orderings compile.
 */
describe('API-key backend routing — the env a member with Kimi or Groq actually gets', () => {
  const NODE_KEYS: NodeJS.ProcessEnv = {
    ...POLLUTED_PARENT,
    ANTHROPIC_API_KEY: 'sk-ant-node-key',
    ANTHROPIC_AUTH_TOKEN: 'node-auth-token',
    OPENAI_API_KEY: 'sk-openai-node-key',
  };

  const kimiHome: AgentCredentialHome = {
    provider: 'kimi',
    homeDir: HOME_DIR,
    configDir: `${HOME_DIR}/kimi`,
    apiKey: 'sk-member-moonshot-key',
  };

  const groqHome: AgentCredentialHome = {
    provider: 'groq',
    homeDir: HOME_DIR,
    configDir: `${HOME_DIR}/groq`,
    apiKey: 'gsk_member_groq_key',
  };

  it('points claude-code at Moonshot with the member key, not the node key', () => {
    const env = composeEnv(
      manifestFor('claude-code'),
      '/tmp/m.json',
      'http://x',
      NODE_KEYS,
      undefined,
      undefined,
      kimiHome,
    );

    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.moonshot.ai/anthropic');
    // AUTH_TOKEN, not API_KEY. The former goes out as a bearer `Authorization`
    // header, which is what a third-party endpoint authenticates; the latter
    // goes out as Anthropic's vendor-specific `x-api-key`, which Moonshot does
    // not read. Getting this wrong produces a 401 from a URL that looks right.
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('sk-member-moonshot-key');
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');

    // The config dir is the KIMI directory. This is what keeps the member's own
    // `claude auth login` — which lives in the sibling anthropic/ directory and
    // would outrank the token above — out of this session.
    expect(env.CLAUDE_CONFIG_DIR).toBe(`${HOME_DIR}/kimi`);
  });

  it('points codex at Groq, and the suppress-then-inject order survives', () => {
    const env = composeEnv(
      manifestFor('codex'),
      '/tmp/m.json',
      'http://x',
      NODE_KEYS,
      undefined,
      undefined,
      groqHome,
    );

    expect(env.OPENAI_BASE_URL).toBe('https://api.groq.com/openai/v1');
    // THE ASSERTION THIS WHOLE BLOCK EXISTS FOR. `OPENAI_API_KEY` is both the
    // node key deleted by the suppression loop and the member key written by
    // the routing step. If the two ever swap order this reads
    // `sk-openai-node-key` (inject-then-delete leaves nothing at all, and the
    // key is simply absent) — either way a session that silently talks to the
    // wrong vendor or to nobody.
    expect(env.OPENAI_API_KEY).toBe('gsk_member_groq_key');
    expect(env.CODEX_HOME).toBe(`${HOME_DIR}/groq`);
  });

  it('routes nothing when the key could not be read', () => {
    // `DbAgentCredentialHome` returns null rather than a keyless home on this
    // path, so this is belt-and-braces — but the branch is reachable by
    // construction from any other caller, and a base URL without a key is the
    // worst of the three possible outcomes: a live session pointed at a vendor
    // it cannot authenticate to.
    const env = composeEnv(
      manifestFor('claude-code'),
      '/tmp/m.json',
      'http://x',
      NODE_KEYS,
      undefined,
      undefined,
      { provider: 'kimi', homeDir: HOME_DIR, configDir: `${HOME_DIR}/kimi` },
    );

    expect(env).not.toHaveProperty('ANTHROPIC_BASE_URL');
    // Suppression still ran, so the node's keys are gone either way: no
    // credential is strictly better than someone else's.
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(env).not.toHaveProperty('ANTHROPIC_AUTH_TOKEN');
  });

  it('leaves a member who connected neither backend exactly as they were', () => {
    const env = composeEnv(
      manifestFor('claude-code'),
      '/tmp/m.json',
      'http://x',
      NODE_KEYS,
      undefined,
      undefined,
      aliceHome,
    );

    expect(env).not.toHaveProperty('ANTHROPIC_BASE_URL');
    expect(env).not.toHaveProperty('OPENAI_BASE_URL');
  });

  it('keeps each backend pointed at exactly one tool', () => {
    // A backend that claimed two tools, or two backends that claimed one, would
    // make `DbAgentCredentialHome.resolve` pick by list order — a silent, stable
    // wrong answer. The relationship is one-to-one and this says so.
    expect(apiKeyBackendsForAgentTool('claude-code')).toEqual(['kimi']);
    // TWO BACKENDS, ORDERED. This is the assertion that pins the precedence
    // rule: `groq` first because it existed first, and adding a backend must
    // never silently re-route a member who connected the earlier one. A change
    // that reorders this array is a change that moves live sessions between
    // vendors, and it should have to edit this line to do it.
    expect(apiKeyBackendsForAgentTool('codex')).toEqual(['groq', 'grok']);
    expect(apiKeyBackendsForAgentTool('gemini')).toEqual([]);
  });

  /* PRECEDENCE IS A PRODUCT PROMISE, NOT AN IMPLEMENTATION DETAIL. The promise
     is narrow and worth stating once: adding a backend must never move an
     existing member's sessions. A member who connected Groq before Grok existed
     has `codex` pointed at api.groq.com, and the deploy that introduces Grok
     must leave that alone — they took no action, and nothing in the product
     changed for them. Appending to `API_KEY_CREDENTIAL_PROVIDERS` is what keeps
     that true, and these cases are where the promise is enforced rather than
     merely documented. */
  describe('apiKeyBackendOutrankedBy', () => {
    it('names the earlier backend when both are connected', () => {
      expect(apiKeyBackendOutrankedBy('grok', new Set(['groq', 'grok']))).toBe('groq');
    });

    it('says nothing to the winner', () => {
      expect(apiKeyBackendOutrankedBy('groq', new Set(['groq', 'grok']))).toBeNull();
    });

    it('does not outrank a backend whose rival is not connected', () => {
      // The member pasted only a Grok key. Groq exists in the table and is
      // ahead of it, and that is irrelevant: precedence sorts ACTIVE
      // credentials, and a card that said "Groq takes priority" to someone who
      // has never connected Groq would send them looking for a key they do not
      // have.
      expect(apiKeyBackendOutrankedBy('grok', new Set(['grok']))).toBeNull();
    });

    it('does not outrank a backend that is not connected at all', () => {
      // An unconnected backend has not entered the contest. This is the state
      // every card is in before a member presses Connect, so it is the most
      // common one on the screen.
      expect(apiKeyBackendOutrankedBy('grok', new Set(['groq']))).toBeNull();
      expect(apiKeyBackendOutrankedBy('grok', new Set())).toBeNull();
    });

    it('never outranks the sole backend of a tool', () => {
      // `claude-code` has one. Kimi cannot lose a contest with itself, and a
      // future second claude-code backend should have to make this line fail
      // rather than inheriting an answer.
      expect(apiKeyBackendOutrankedBy('kimi', new Set(['kimi', 'groq', 'grok']))).toBeNull();
    });

    it('ignores providers that are not backends of the same tool', () => {
      // `anthropic` is connected and ahead of nothing: it is a native provider,
      // not a competitor in this list. Reading the active set as if membership
      // alone implied precedence would have grok reporting a winner that does
      // not serve codex.
      expect(apiKeyBackendOutrankedBy('grok', new Set(['anthropic', 'kimi', 'grok']))).toBeNull();
    });
  });
});

describe('a NATIVE api-key provider — the shape/role split `gemini` forced', () => {
  /* Gemini is the first provider that is api-key SHAPED without being a
     BACKEND, and separating those two facts is the whole of this change.

     Before it, `isApiKeyCredentialProvider` answered both questions at once
     because no provider had ever disagreed with itself: kimi, groq and grok are
     each a pasted key AND a redirection of somebody else's tool. Gemini has the
     first property and not the second — it is the native provider of the
     `gemini` tool (`agentTools: ['gemini']`, agent-credentials.ts:79-82), so
     connecting it displaces nobody and outranks nothing.

     Every case below is one half of that split, asserted where a future
     provider would trip over it. */

  const NODE_GOOGLE_KEYS: NodeJS.ProcessEnv = {
    ...POLLUTED_PARENT,
    GEMINI_API_KEY: 'AIzaNODEKEYnotthemembers',
    GOOGLE_API_KEY: 'AIzaNODEKEYotherspelling',
  };

  const geminiKeyHome: AgentCredentialHome = {
    provider: 'gemini',
    homeDir: HOME_DIR,
    configDir: `${HOME_DIR}/gemini`,
    apiKey: 'AIzaMEMBERkey',
  };

  it('is api-key shaped but backs no tool', () => {
    expect(isApiKeyCredentialProvider('gemini')).toBe(true);
    expect(isApiKeyBackend('gemini')).toBe(false);
    expect(apiKeyBackendAgentTool('gemini')).toBeNull();
    expect(apiKeyBackendDisplaces('gemini')).toBeNull();
    // And the tool it natively serves is reached through nobody's routing.
    expect(apiKeyBackendsForAgentTool('gemini')).toEqual([]);
  });

  it('states the law rather than the three cases, so the next provider is covered too', () => {
    // A backend is exactly a provider that routes a tool. Asserting the
    // EQUIVALENCE means a future row that sets one field and not the other
    // fails here, instead of failing as a mis-routed session months later.
    for (const provider of API_KEY_CREDENTIAL_PROVIDERS) {
      expect(isApiKeyBackend(provider)).toBe(apiKeyBackendAgentTool(provider) !== null);
      expect(isApiKeyBackend(provider)).toBe(apiKeyBackendDisplaces(provider) !== null);
    }
    expect(API_KEY_CREDENTIAL_PROVIDERS.filter((p) => !isApiKeyBackend(p))).toEqual(['gemini']);
  });

  it('never outranks anything, however many keys the member has connected', () => {
    // `outrankedBy` is a claim about two backends competing for ONE tool.
    // Gemini competes with nobody, so the answer is null even when every other
    // api-key provider is connected alongside it.
    expect(apiKeyBackendOutrankedBy('gemini', new Set(['gemini']))).toBeNull();
    expect(
      apiKeyBackendOutrankedBy('gemini', new Set(['kimi', 'groq', 'grok', 'gemini'])),
    ).toBeNull();
    // Nor is it ever the thing doing the outranking.
    expect(apiKeyBackendOutrankedBy('grok', new Set(['gemini', 'grok']))).toBeNull();
  });

  it('gives the member key its own variable and rewrites no base URL', () => {
    // The backend shape is `{BASE_URL, KEY}` — point a vendor SDK somewhere
    // else. The native shape is one variable and no redirection, because the
    // Gemini CLI is already talking to Google. A base URL here would be the
    // bug: it would aim the tool at an endpoint nobody configured.
    expect(apiKeyBackendEnv('gemini', 'AIzaMEMBERkey')).toEqual({
      GEMINI_API_KEY: 'AIzaMEMBERkey',
    });
    // Contrast, pinned LITERALLY so the two shapes cannot quietly converge.
    // The routing table itself stays module-private — the accessors are the
    // API, and exporting the table to spell this assertion would widen the
    // surface for a test's convenience.
    expect(apiKeyBackendEnv('kimi', 'sk-member')).toEqual({
      ANTHROPIC_BASE_URL: 'https://api.moonshot.ai/anthropic',
      ANTHROPIC_AUTH_TOKEN: 'sk-member',
    });
  });

  it('suppresses the node keys BEFORE injecting the member key, which for Gemini is the same variable', () => {
    // The exact hazard `groq` has with `OPENAI_API_KEY`, and Gemini has it
    // twice: `GEMINI_API_KEY` is simultaneously a node value being deleted and
    // the member value being written. Inject-then-suppress would leave the
    // session with NO key and a node key it was not entitled to use anyway.
    const env = composeEnv(
      manifestFor('gemini'),
      '/tmp/m.json',
      'http://x',
      NODE_GOOGLE_KEYS,
      undefined,
      undefined,
      geminiKeyHome,
    );

    expect(env.GEMINI_API_KEY).toBe('AIzaMEMBERkey');
    // The other spelling is suppressed and never re-set: two keys for one
    // vendor is a session whose billing depends on SDK precedence.
    expect(env).not.toHaveProperty('GOOGLE_API_KEY');
    expect(env).not.toHaveProperty('GEMINI_BASE_URL');
    expect(env.HOME).toBe(HOME_DIR);
  });

  it('leaves an OAuth-connected member keyless rather than inventing a variable', () => {
    // The pre-existing member: a credential row, a config dir holding
    // `oauth_creds.json`, and no pasted key. They must come out exactly as they
    // did before Gemini joined the api-key list — the home injected, the node
    // keys suppressed, and nothing fabricated.
    const env = composeEnv(
      manifestFor('gemini'),
      '/tmp/m.json',
      'http://x',
      NODE_GOOGLE_KEYS,
      undefined,
      undefined,
      { provider: 'gemini', homeDir: HOME_DIR, configDir: `${HOME_DIR}/gemini` },
    );

    expect(env).not.toHaveProperty('GEMINI_API_KEY');
    expect(env).not.toHaveProperty('GOOGLE_API_KEY');
    expect(env.HOME).toBe(HOME_DIR);
  });

  it('sends Google its key in the header Google actually reads', () => {
    // `x-goog-api-key`, not `Authorization: Bearer`. The generic api-key probe
    // hardcoded bearer, which Google rejects — every valid Gemini key would
    // have verified as invalid, and the member would have been told their key
    // was wrong when it was tm8 asking wrongly.
    expect(apiKeyVerifyHeaders('gemini', 'AIzaMEMBERkey')).toEqual({
      Accept: 'application/json',
      'x-goog-api-key': 'AIzaMEMBERkey',
    });
    const headers = apiKeyVerifyHeaders('gemini', 'AIzaMEMBERkey');
    expect(headers).not.toHaveProperty('Authorization');

    // The three OpenAI-wire backends keep bearer, so this is a per-provider
    // fact rather than a global switch.
    for (const provider of ['kimi', 'groq', 'grok'] as const) {
      expect(apiKeyVerifyHeaders(provider, 'sk-x')).toEqual({
        Accept: 'application/json',
        Authorization: 'Bearer sk-x',
      });
    }
  });

  it('keeps the verify auth table total, so a new provider must choose', () => {
    for (const provider of API_KEY_CREDENTIAL_PROVIDERS) {
      expect(['bearer', 'x-goog-api-key']).toContain(API_KEY_PROVIDER_VERIFY_AUTH[provider]);
    }
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
    for (const provider of Object.keys(
      AGENT_CREDENTIAL_CONFIG_DIR_VAR,
    ) as AgentCredentialProvider[]) {
      // API-key backends are exempt, and the exemption is the finding rather
      // than a hole in the guard.
      //
      // For the six vendor providers the two tables describe THE SAME PROGRAM:
      // `claude` writes the credential during login and reads it during a
      // session, so one variable name is correct in both and a disagreement is
      // always a bug. Kimi and Groq are the first providers for which the
      // writing program and the reading program are different — tm8's paste
      // harness writes the file, and `claude`/`codex` read it — so the two
      // tables are answering two questions that no longer have one answer:
      //
      //   login  (`CREDENTIAL_CONFIG_DIR_VAR`): which vendor CLI's storage must
      //          be redirected? None — there is no vendor CLI. Hence `null`.
      //   spawn  (this table): which variable points the CONSUMING tool at this
      //          credential home? `CLAUDE_CONFIG_DIR` / `CODEX_HOME`.
      //
      // Forcing them to agree would break one of the two: `null` at spawn would
      // let the member's real Anthropic login outrank the Kimi token, and a
      // non-null value at login would hand tm8's own harness a vendor variable
      // it does not read. The guard therefore narrows rather than widening, and
      // says why.
      // The exemption is keyed on BACKEND-HOOD, not on credential shape, and
      // `gemini` is why the distinction had to be made explicit. Being an
      // api-key provider means only "the credential is a key tm8 stores"; it
      // says nothing about whose tool reads it. Gemini stores a pasted key AND
      // is the native provider of the `gemini` tool (`agentTools: ['gemini']`,
      // agent-credentials.ts:79-82), so no redirection happens and the two
      // tables are back to describing one program. It therefore belongs on the
      // agreement branch below — where it passes, both tables reading `null`,
      // because the Gemini CLI keys its storage off HOME rather than off a
      // config-dir variable.
      //
      // Guarding this on `isApiKeyCredentialProvider` alone would have silently
      // exempted Gemini from the very guard it satisfies, and compared it to
      // `AGENT_CREDENTIAL_CONFIG_DIR_VAR[null]` — `undefined` — which is not a
      // claim about anything.
      if (isApiKeyCredentialProvider(provider) && isApiKeyBackend(provider)) {
        expect(CREDENTIAL_CONFIG_DIR_VAR[provider]).toBeNull();
        expect(AGENT_CREDENTIAL_CONFIG_DIR_VAR[provider]).toBe(
          AGENT_CREDENTIAL_CONFIG_DIR_VAR[apiKeyBackendDisplaces(provider)],
        );
        continue;
      }
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
