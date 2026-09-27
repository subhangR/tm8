// R2 (migration 269): every resolver branch records the rung it actually ran
// on, so the manifest's `launch.effectiveCredentialSources` is never empty.
//
// 269's `settle_credential_binding` refuses a non-echo-agent manifest with an
// empty map (22023). That refusal is safe only if it is unreachable, and this
// file is the structural half of that proof: it walks every branch of
// `resolveSessionCredentials` and `resolveLinkBoundCredentials`, for every
// agent tool, and asserts the map names the tool's provider (when it has one)
// and github, each with the rung that branch used. GitHub always resolves or
// throws, so no launch that reaches the recorder has an empty map. (The prod
// half: the operator's dry run, 2026-09-27, found every post-D9 manifest mapped.)
//
// The wrapper cases: `TM8_AGENT_CMD` (an operator wrapper, `echo-agent`
// included) replaces only the COMMAND; credentials resolve from the persona's
// `agentTool` exactly as below, so the wrapper runs one of these branches.

import { describe, expect, it } from 'vitest';

import {
  resolveSessionCredentials,
  type CredentialResolutionDeps,
} from '../src/spawn/credential-resolution.js';
import { agentCredentialProviderFor, type AgentCredentialHome } from '../src/spawn/agent-credentials.js';
import { credentialBindingLaunch, resolveLaunchConfig, type ResolvedLaunchConfig } from '../src/spawn/manifest.js';
import type {
  CredentialSource,
  GitHubCredential,
  SessionLaunchPosture,
  SpaceCredentialGrant,
  SpaceCredentialPort,
  SpaceCredentialProvider,
  SpawnContext,
  SpawnRequest,
} from '../src/spawn/types.js';

const SPACE = '11111111-1111-4111-8111-111111111111';
const ANT = 'aaaaaaaa-0000-4000-8000-000000000001';
const OAI = 'bbbbbbbb-0000-4000-8000-000000000001';
const GH = 'cccccccc-0000-4000-8000-000000000001';
const AUTH = { accountId: 'account-A', kind: 'human' };

const MEMBER_HOME: AgentCredentialHome = {
  provider: 'anthropic',
  homeDir: '/data/credentials/account-A',
  configDir: '/data/credentials/account-A/anthropic',
};
const MEMBER_GH: GitHubCredential = { provider: 'github', login: 'member-a', token: 'gho_member' };

function context(agentTool: string, model: string): SpawnContext {
  return {
    spaceId: SPACE,
    project: { id: 'proj-1', name: 'tm8', workingDir: '/tmp/tm8-fixture', trust: 'trusted' },
    teamMember: {
      id: 'tm-1', name: 'T', role: 'fixture', identity: 'fixture', memories: [], model, agentTool,
      mode: 'worker', permissionMode: null, avatar: null, capabilities: {}, commandPermissions: {},
    },
    tasks: [],
  };
}

function grant(provider: SpaceCredentialProvider, credentialId: string): SpaceCredentialGrant {
  return {
    kind: 'secret', credentialId, provider,
    shape: provider === 'github' ? 'token' : 'api_key',
    label: provider, displayLogin: provider === 'github' ? 'space-bot' : null,
    secret: `secret-${credentialId}`,
  };
}

function port(defaults: Partial<Record<SpaceCredentialProvider, string>>): SpaceCredentialPort {
  const byId = Object.fromEntries(
    (Object.entries(defaults) as Array<[SpaceCredentialProvider, string]>).map(([p, id]) => [id, grant(p, id)]),
  );
  return {
    async readPolicies() { return { space: {}, node: {} }; },
    async read(_auth, _space, provider, credentialId) {
      if (credentialId === null) {
        const id = defaults[provider];
        return id ? { ok: true, grant: grant(provider, id) } : { ok: false, reason: 'no_default' };
      }
      const g = byId[credentialId];
      return g ? { ok: true, grant: g } : { ok: false, reason: 'not_found' };
    },
    async activeIds(_auth, ids) { return new Set(ids); },
    async repointSession() { return { ok: true, credentials: [] }; },
  };
}

function deps(
  defaults: Partial<Record<SpaceCredentialProvider, string>>,
  member: { home?: boolean; github?: boolean },
): CredentialResolutionDeps {
  return {
    spaceCredentials: port(defaults),
    async resolveMemberHome() { return member.home ? MEMBER_HOME : null; },
    async resolveMemberGitHub() { return member.github ? MEMBER_GH : null; },
    async materializeApiKeyHome({ provider, credentialId, apiKey }) {
      return {
        provider, homeDir: '/data/credentials/sessions/s1',
        configDir: `/data/credentials/sessions/s1/${provider}`, space: { credentialId, apiKey },
      };
    },
  };
}

function launch(agentTool: string, model: string, request: Partial<SpawnRequest> = {}): ResolvedLaunchConfig {
  return resolveLaunchConfig(
    { spaceId: SPACE, teamMemberId: 'tm-1', ...request }, context(agentTool, model), {}, null as SessionLaunchPosture | null,
  );
}

interface Case {
  name: string;
  tool: string;
  model: string;
  request?: Partial<SpawnRequest>;
  defaults?: Partial<Record<SpaceCredentialProvider, string>>;
  member?: { home?: boolean; github?: boolean };
  linkBound?: boolean;
  /** The exact map every branch must produce. */
  expected: Record<string, CredentialSource>;
}

const CASES: Case[] = [
  // ---- claude-code / codex: the space-aware ladder ------------------------
  { name: 'claude-code auto → member', tool: 'claude-code', model: 'opus', member: { home: true, github: true },
    expected: { anthropic: 'member', github: 'member' } },
  { name: 'claude-code auto → space default', tool: 'claude-code', model: 'opus', defaults: { anthropic: ANT, github: GH },
    expected: { anthropic: 'space', github: 'space' } },
  { name: 'claude-code auto → node', tool: 'claude-code', model: 'opus', expected: { anthropic: 'node', github: 'node' } },
  { name: 'claude-code explicit member', tool: 'claude-code', model: 'opus', member: { home: true },
    request: { credentialSources: { anthropic: 'member' } }, expected: { anthropic: 'member', github: 'node' } },
  { name: 'claude-code explicit node', tool: 'claude-code', model: 'opus', member: { home: true },
    request: { credentialSources: { anthropic: 'node', github: 'node' } }, expected: { anthropic: 'node', github: 'node' } },
  { name: 'claude-code explicit space (every provider space)', tool: 'claude-code', model: 'opus',
    defaults: { anthropic: ANT, github: GH }, request: { credentialSource: 'space' },
    expected: { anthropic: 'space', github: 'space' } },
  { name: 'claude-code space + github node (the mixed case)', tool: 'claude-code', model: 'opus',
    defaults: { anthropic: ANT }, expected: { anthropic: 'space', github: 'node' } },
  { name: 'codex auto → space default', tool: 'codex', model: 'gpt-5.5', defaults: { openai: OAI, github: GH },
    expected: { openai: 'space', github: 'space' } },
  { name: 'codex auto → node', tool: 'codex', model: 'gpt-5.5', expected: { openai: 'node', github: 'node' } },
  // ---- API-key backends: the member's own key, one route ------------------
  { name: 'Kimi on claude-code (member route)', tool: 'claude-code', model: 'kimi-k2-thinking',
    member: { home: true }, expected: { anthropic: 'member', github: 'node' } },
  { name: 'Groq on codex (member route)', tool: 'codex', model: 'openai/gpt-oss-120b',
    member: { home: true }, expected: { openai: 'member', github: 'node' } },
  // ---- the pre-space branch: a provider the space cannot hold -------------
  ...(['gemini', 'hermes', 'cursor'] as const).flatMap((tool): Case[] => [
    { name: `${tool} with a member home → member`, tool, model: 'some-model', member: { home: true },
      expected: { [tool]: 'member', github: 'node' } },
    { name: `${tool} with none → node`, tool, model: 'some-model', expected: { [tool]: 'node', github: 'node' } },
    { name: `${tool} explicit node → node`, tool, model: 'some-model', member: { home: true },
      request: { credentialSources: { [tool]: 'node' } as never }, expected: { [tool]: 'node', github: 'node' } },
    { name: `${tool} link-bound → node`, tool, model: 'some-model', linkBound: true, defaults: { github: GH },
      member: { home: true, github: true }, expected: { [tool]: 'node', github: 'space' } },
  ]),
  // ---- link-bound: no member rung ------------------------------------------
  { name: 'link-bound claude-code → space', tool: 'claude-code', model: 'opus', linkBound: true,
    defaults: { anthropic: ANT, github: GH }, member: { home: true, github: true },
    expected: { anthropic: 'space', github: 'space' } },
  { name: 'link-bound claude-code → node', tool: 'claude-code', model: 'opus', linkBound: true,
    defaults: { github: GH }, expected: { anthropic: 'node', github: 'space' } },
  { name: 'link-bound codex → space', tool: 'codex', model: 'gpt-5.5', linkBound: true,
    defaults: { openai: OAI, github: GH }, expected: { openai: 'space', github: 'space' } },
];

describe('R2 — every resolver branch records the rung it ran on (269 refuses an empty map)', () => {
  for (const c of CASES) {
    it(c.name, async () => {
      const l = launch(c.tool, c.model, c.request);
      const r = await resolveSessionCredentials(
        { auth: AUTH, spaceId: SPACE, launch: l, ...(c.linkBound ? { linkBound: true } : {}) },
        deps(c.defaults ?? {}, c.member ?? {}),
      );
      const effective = r.launch.effectiveCredentialSources ?? {};
      expect(effective).toEqual(c.expected);
      // Never empty, always github, and the tool's own provider when it has one.
      expect(Object.keys(effective).length).toBeGreaterThan(0);
      expect(effective.github).toBeDefined();
      const toolProvider = agentCredentialProviderFor(c.tool);
      if (toolProvider) expect(effective[toolProvider]).toBeDefined();
      // Every `space` rung names the credential it ran on — 269's `bound`
      // requires a session_space_credentials row per space provider.
      for (const [provider, source] of Object.entries(effective)) {
        if (source === 'space') {
          expect((r.launch.spaceCredentialIds as Record<string, string> | undefined)?.[provider]).toBeTruthy();
        }
      }
      // The recorder's input carries the same map (spawn's manifest and
      // resume's `recordCredentialBinding` share `credentialBindingLaunch`).
      expect(credentialBindingLaunch(r.launch).effectiveCredentialSources).toEqual(c.expected);
      expect(credentialBindingLaunch(r.launch).tool).toBe(c.tool);
    });
  }

  it('the case list covers every agent tool with a credential provider', () => {
    const tools = new Set(CASES.map((c) => c.tool));
    for (const tool of ['claude-code', 'codex', 'gemini', 'hermes', 'cursor']) {
      expect(tools.has(tool)).toBe(true);
    }
  });
});
