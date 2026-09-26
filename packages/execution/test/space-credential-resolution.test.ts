// SC-2 — which credential a launch runs on (design 01a0cfa8 §4, D4 × D5).
//
// Everything here drives the REAL `resolveLaunchConfig` → `resolveSessionCredentials`
// path — the one place D5 is enforced (206 checks membership and status but
// never a policy) — against a fake port that answers exactly as
// `DbSpaceCredentialPort` maps 206's refusals. The DB half of the same story,
// against the real migration, is `packages/server/test/db/space-credential-spawn.pg.test.ts`.

import { describe, expect, it } from 'vitest';

import {
  resolveSessionCredentials,
  type CredentialResolutionDeps,
} from '../src/spawn/credential-resolution.js';
import type { AgentCredentialHome } from '../src/spawn/agent-credentials.js';
import { resolveLaunchConfig, type ResolvedLaunchConfig } from '../src/spawn/manifest.js';
import {
  SpawnError,
  type GitHubCredential,
  type SessionLaunchPosture,
  type SpaceCredentialGrant,
  type SpaceCredentialPolicies,
  type SpaceCredentialPort,
  type SpaceCredentialProvider,
  type SpaceCredentialRead,
  type SpawnContext,
  type SpawnRequest,
} from '../src/spawn/types.js';

const SPACE = '11111111-1111-4111-8111-111111111111';
const OTHER_SPACE_CRED = '99999999-9999-4999-8999-999999999999';
const ANT_DEFAULT = 'aaaaaaaa-0000-4000-8000-000000000001';
const ANT_PINNED = 'aaaaaaaa-0000-4000-8000-000000000002';
const OAI_DEFAULT = 'bbbbbbbb-0000-4000-8000-000000000001';
const GH_DEFAULT = 'cccccccc-0000-4000-8000-000000000001';

/** Member A's claims. An agent's claims are its root human launcher's, so this is also "A's agent". */
const AUTH_A = { accountId: 'account-A', kind: 'human' };

function context(agentTool: string | null = null, model = 'opus'): SpawnContext {
  return {
    spaceId: SPACE,
    project: { id: 'proj-1', name: 'tm8', workingDir: '/tmp/tm8-fixture', trust: 'trusted' },
    // B's teammate: the persona's owner is never consulted for credentials.
    teamMember: {
      id: 'teammate-owned-by-B',
      name: 'TB',
      role: 'fixture',
      identity: 'fixture',
      memories: [],
      model,
      agentTool,
      mode: 'worker',
      permissionMode: null,
      avatar: null,
      capabilities: {},
      commandPermissions: {},
    },
    tasks: [],
  };
}

function apiKeyGrant(provider: SpaceCredentialProvider, credentialId: string): SpaceCredentialGrant {
  return {
    kind: 'secret',
    credentialId,
    provider,
    shape: provider === 'github' ? 'token' : 'api_key',
    label: `${provider} ${credentialId.slice(0, 4)}`,
    displayLogin: provider === 'github' ? 'space-bot' : null,
    secret: `secret-${credentialId}`,
  };
}

interface FakePort extends SpaceCredentialPort {
  reads: Array<{ auth: unknown; provider: SpaceCredentialProvider; credentialId: string | null }>;
}

/**
 * The space's credentials as 206 would answer them. `defaults` is the active
 * default per provider; `byId` every other credential with its refusal state.
 */
function fakePort(options: {
  policies?: SpaceCredentialPolicies;
  policyError?: Error;
  defaults?: Partial<Record<SpaceCredentialProvider, string>>;
  byId?: Record<string, SpaceCredentialRead>;
  readError?: Error;
}): FakePort {
  const reads: FakePort['reads'] = [];
  return {
    reads,
    async readPolicies() {
      if (options.policyError) throw options.policyError;
      return options.policies ?? { space: {}, node: {} };
    },
    async read(auth, _spaceId, provider, credentialId) {
      reads.push({ auth, provider, credentialId });
      if (options.readError) throw options.readError;
      if (credentialId === null) {
        const id = options.defaults?.[provider];
        return id ? { ok: true, grant: apiKeyGrant(provider, id) } : { ok: false, reason: 'no_default' };
      }
      return options.byId?.[credentialId] ?? { ok: false, reason: 'not_found' };
    },
    async activeIds(_auth, ids) {
      return new Set(ids);
    },
    async repointSession() {
      return { ok: true, credentials: [] };
    },
  };
}

const MEMBER_HOME: AgentCredentialHome = {
  provider: 'anthropic',
  homeDir: '/data/credentials/account-A',
  configDir: '/data/credentials/account-A/anthropic',
};
const MEMBER_GH: GitHubCredential = { provider: 'github', login: 'member-a', token: 'gho_member' };

function deps(
  port: SpaceCredentialPort | undefined,
  member: { home?: AgentCredentialHome | null; github?: GitHubCredential | null } = {},
): CredentialResolutionDeps & { memberAsks: Array<'member' | null>; materialized: string[] } {
  const memberAsks: Array<'member' | null> = [];
  const materialized: string[] = [];
  return {
    memberAsks,
    materialized,
    ...(port ? { spaceCredentials: port } : {}),
    async resolveMemberHome(source) {
      memberAsks.push(source);
      const home = member.home ?? null;
      if (source === 'member' && !home) {
        throw new SpawnError("credentialSource 'member' was requested but nothing is connected", 'conflict');
      }
      return home;
    },
    async resolveMemberGitHub() {
      return member.github ?? null;
    },
    async materializeApiKeyHome({ provider, credentialId, apiKey }) {
      materialized.push(credentialId);
      return {
        provider,
        homeDir: `/data/credentials/sessions/s1`,
        configDir: `/data/credentials/sessions/s1/${provider}`,
        space: { credentialId, apiKey },
      };
    },
  };
}

function launch(
  request: Partial<SpawnRequest> = {},
  inherited?: SessionLaunchPosture | null,
  agentTool: string | null = null,
  model = 'opus',
): ResolvedLaunchConfig {
  return resolveLaunchConfig(
    { spaceId: SPACE, teamMemberId: 'teammate-owned-by-B', ...request },
    context(agentTool, model),
    {},
    inherited,
  );
}

async function resolve(
  l: ResolvedLaunchConfig,
  d: CredentialResolutionDeps,
  resume = false,
) {
  return resolveSessionCredentials({ auth: AUTH_A, spaceId: SPACE, launch: l, resume }, d);
}

async function refusal(promise: Promise<unknown>): Promise<SpawnError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(SpawnError);
  return error as SpawnError;
}

describe('D4 × D5 — auto resolution along member → space → node, through the policy', () => {
  it('auto: the member credential wins when connected', async () => {
    const d = deps(fakePort({ defaults: { anthropic: ANT_DEFAULT } }), { home: MEMBER_HOME });
    const r = await resolve(launch(), d);
    expect(r.credentialHome).toBe(MEMBER_HOME);
    expect(r.launch.effectiveCredentialSources?.anthropic).toBe('member');
    expect(r.spaceCredentialIds).toEqual([]);
  });

  it('auto: with no member credential, the space default is used and recorded as space', async () => {
    const d = deps(fakePort({ defaults: { anthropic: ANT_DEFAULT } }));
    const r = await resolve(launch(), d);
    expect(r.credentialHome?.space).toEqual({ credentialId: ANT_DEFAULT, apiKey: `secret-${ANT_DEFAULT}` });
    expect(r.launch.credentialSources.anthropic).toBe('space');
    expect(r.launch.spaceCredentialIds).toEqual({ anthropic: ANT_DEFAULT });
    expect(r.launch.effectiveCredentialSources).toMatchObject({ anthropic: 'space', github: 'node' });
    expect(r.spaceCredentialIds).toEqual([ANT_DEFAULT]);
  });

  it('auto: with neither, the node key is used (D9 records node as the effective source)', async () => {
    const r = await resolve(launch(), deps(fakePort({})));
    expect(r.credentialHome).toBeNull();
    expect(r.launch.credentialSources.anthropic).toBeNull();
    expect(r.launch.effectiveCredentialSources).toEqual({ anthropic: 'node', github: 'node' });
    expect(r.spaceCredentialIds).toEqual([]);
  });

  it('space policy "require space" skips a connected member credential and uses the space', async () => {
    const d = deps(
      fakePort({ policies: { space: { anthropic: ['space'] }, node: {} }, defaults: { anthropic: ANT_DEFAULT } }),
      { home: MEMBER_HOME },
    );
    const r = await resolve(launch(), d);
    expect(d.memberAsks).toEqual([]);
    expect(r.launch.effectiveCredentialSources?.anthropic).toBe('space');
  });

  it('space policy "require space" with no space default refuses; it never lands on the node key', async () => {
    const d = deps(fakePort({ policies: { space: { anthropic: ['space'] }, node: {} } }), { home: MEMBER_HOME });
    const e = await refusal(resolve(launch(), d));
    expect(e.code).toBe('forbidden');
    expect(e.message).toContain("a space admin allows only 'space' for anthropic in this space");
    expect(e.message).toContain('add a anthropic credential to this space');
  });

  it('node policy "forbid node" makes auto refuse rather than use the node key', async () => {
    const d = deps(fakePort({ policies: { space: {}, node: { anthropic: false } } }));
    const e = await refusal(resolve(launch(), d));
    expect(e.code).toBe('forbidden');
    expect(e.message).toContain('the node admin has forbidden node anthropic credentials on this node');
    expect(e.message).toContain('connect your own anthropic credential');
  });

  it('node policy "forbid node" with a space default resolves to the space', async () => {
    const d = deps(fakePort({ policies: { space: {}, node: { anthropic: false } }, defaults: { anthropic: ANT_DEFAULT } }));
    const r = await resolve(launch(), d);
    expect(r.launch.effectiveCredentialSources?.anthropic).toBe('space');
  });

  it('codex resolves its openai provider along the same ladder', async () => {
    const d = deps(fakePort({ defaults: { openai: OAI_DEFAULT } }));
    const r = await resolve(launch({}, null, 'codex', 'gpt-5.5'), d);
    expect(r.credentialHome?.provider).toBe('openai');
    expect(r.launch.spaceCredentialIds).toEqual({ openai: OAI_DEFAULT });
    expect(d.materialized).toEqual([OAI_DEFAULT]);
  });

  it('github auto uses the space token when the member connected none', async () => {
    const d = deps(fakePort({ defaults: { github: GH_DEFAULT } }), { home: MEMBER_HOME });
    const r = await resolve(launch(), d);
    expect(r.gitHubCredential).toEqual({ provider: 'github', login: 'space-bot', token: `secret-${GH_DEFAULT}` });
    expect(r.launch.spaceCredentialIds).toEqual({ github: GH_DEFAULT });
  });
});

describe('I3 — an explicit source fails closed, with a sentence naming the fix or the policy', () => {
  it("explicit 'member' excluded by the space policy refuses and names the policy", async () => {
    const d = deps(fakePort({ policies: { space: { anthropic: ['space', 'node'] }, node: {} } }), { home: MEMBER_HOME });
    const e = await refusal(resolve(launch({ credentialSources: { anthropic: 'member' } }), d));
    expect(e.code).toBe('forbidden');
    expect(e.message).toBe(
      "credentialSources.anthropic 'member' is not allowed: a space admin allows only 'space' or 'node' for anthropic in this space",
    );
  });

  it("explicit 'member' with nothing connected refuses; it never falls to the space or the node", async () => {
    const d = deps(fakePort({ defaults: { anthropic: ANT_DEFAULT } }));
    const e = await refusal(resolve(launch({ credentialSources: { anthropic: 'member' } }), d));
    expect(d.memberAsks).toEqual(['member']);
    expect(e.message).toContain("'member' was requested");
  });

  it("explicit 'space' excluded by the space policy refuses", async () => {
    const d = deps(fakePort({ policies: { space: { anthropic: ['member'] }, node: {} }, defaults: { anthropic: ANT_DEFAULT } }));
    const e = await refusal(resolve(launch({ credentialSources: { anthropic: 'space' } }), d));
    expect(e.message).toBe(
      "credentialSources.anthropic 'space' is not allowed: a space admin allows only 'member' for anthropic in this space",
    );
  });

  it("explicit 'space' with no space default refuses and names where to add one", async () => {
    const d = deps(fakePort({}), { home: MEMBER_HOME });
    const e = await refusal(resolve(launch({ credentialSources: { anthropic: 'space' } }), d));
    expect(e.code).toBe('conflict');
    expect(e.message).toContain('add one under Space settings → Credentials');
    expect(d.memberAsks).toEqual([]);
  });

  it("explicit 'space' on a node with no space store refuses by name", async () => {
    const e = await refusal(resolve(launch({ credentialSources: { anthropic: 'space' } }), deps(undefined)));
    expect(e.message).toContain('this node has no space credential store');
  });

  it("explicit 'node' refuses when the node admin forbids node keys", async () => {
    const d = deps(fakePort({ policies: { space: {}, node: { anthropic: false } } }));
    const e = await refusal(resolve(launch({ credentialSources: { anthropic: 'node' } }), d));
    expect(e.message).toBe(
      "credentialSources.anthropic 'node' is not allowed: the node admin has forbidden node anthropic credentials on this node — launch with 'member' or 'space'",
    );
  });

  it("explicit 'node' refuses when the space policy excludes node", async () => {
    const d = deps(fakePort({ policies: { space: { anthropic: ['space'] }, node: {} } }));
    const e = await refusal(resolve(launch({ credentialSources: { anthropic: 'node' } }), d));
    expect(e.message).toContain("a space admin allows only 'space' for anthropic in this space");
  });

  it('a pinned id from ANOTHER space is refused (206 answers not_found under the caller); no fallback', async () => {
    const port = fakePort({ defaults: { anthropic: ANT_DEFAULT } });
    const e = await refusal(
      resolve(
        launch({ credentialSources: { anthropic: 'space' }, spaceCredentialIds: { anthropic: OTHER_SPACE_CRED } }),
        deps(port, { home: MEMBER_HOME }),
      ),
    );
    expect(e.message).toBe(
      `space credential ${OTHER_SPACE_CRED} is not a anthropic credential of this space, or you are not a member of its space — pick a credential this space holds, or omit the id to use the space default`,
    );
    expect(port.reads.map((r) => r.credentialId)).toEqual([OTHER_SPACE_CRED]);
  });

  it('a Kimi model on claude-code refuses an explicit space source (#679 routing has one route)', async () => {
    const d = deps(fakePort({ defaults: { anthropic: ANT_DEFAULT } }));
    const e = await refusal(
      resolve(launch({ credentialSources: { anthropic: 'space' } }, null, 'claude-code', 'kimi-k2-thinking'), d),
    );
    expect(e.message).toContain("credentialSources.anthropic 'space' cannot serve it");
  });

  // A Kimi or Groq key is a MEMBER credential of the tool's provider (design
  // §4, last bullet), so D5's space policy for that provider governs it.
  describe('D5 × API-key-backend models (Kimi on claude-code, Groq on codex)', () => {
    const REQUIRE_SPACE = { space: { anthropic: ['space'], openai: ['space'] }, node: {} } as SpaceCredentialPolicies;
    const cases = [
      { agentTool: 'claude-code', model: 'kimi-k2-thinking', provider: 'anthropic' },
      { agentTool: 'codex', model: 'openai/gpt-oss-120b', provider: 'openai' },
    ] as const;

    for (const { agentTool, model, provider } of cases) {
      it(`${model} on ${agentTool}: "require space" refuses before any member home is resolved`, async () => {
        const d = deps(fakePort({ policies: REQUIRE_SPACE, defaults: { anthropic: ANT_DEFAULT, openai: OAI_DEFAULT } }), { home: MEMBER_HOME });
        const e = await refusal(resolve(launch({}, null, agentTool, model), d));
        expect(e.code).toBe('forbidden');
        expect(e.message).toContain(`a space admin allows only 'space' for ${provider} in this space`);
        expect(e.message).toContain(`pick a model ${agentTool} runs natively, which can use this space's credential`);
        expect(d.memberAsks).toEqual([]);
        expect(d.materialized).toEqual([]);
      });

      it(`${model} on ${agentTool}: control — with no policy it lands on the member's own key`, async () => {
        const d = deps(fakePort({ defaults: { anthropic: ANT_DEFAULT, openai: OAI_DEFAULT } }), { home: MEMBER_HOME });
        const r = await resolve(launch({}, null, agentTool, model), d);
        expect(r.credentialHome).toBe(MEMBER_HOME);
        expect(r.launch.effectiveCredentialSources?.[provider]).toBe('member');
        expect(d.memberAsks).toEqual([null]);
      });
    }

    it('a policy set AFTER launch refuses the resumed Kimi session (policy is read now)', async () => {
      const recorded = { credentialSources: { anthropic: 'member' } } as SessionLaunchPosture;
      const d = deps(fakePort({ policies: REQUIRE_SPACE }), { home: MEMBER_HOME });
      const e = await refusal(resolve(launch({}, recorded, 'claude-code', 'kimi-k2-thinking'), d, true));
      expect(e.code).toBe('forbidden');
      expect(d.memberAsks).toEqual([]);
    });

    it('the node policy is irrelevant: a backend model has no node route, so "forbid node" still lands on member', async () => {
      const d = deps(fakePort({ policies: { space: {}, node: { anthropic: false } } }), { home: MEMBER_HOME });
      const r = await resolve(launch({}, null, 'claude-code', 'kimi-k2-thinking'), d);
      expect(r.launch.effectiveCredentialSources?.anthropic).toBe('member');
    });
  });
});

describe('M8 — every broken space credential refuses; none degrades', () => {
  it('M8a: an inherited posture naming a source this build does not understand refuses', () => {
    const inherited = { credentialSources: { anthropic: 'vault' } } as unknown as SessionLaunchPosture;
    expect(() => launch({}, inherited)).toThrowError(
      /records a anthropic credential source this build does not understand — refusing rather than launching on a different credential; name the source explicitly with credentialSources.anthropic/,
    );
  });

  it("M8a: an inherited 'space' with no credential id refuses rather than taking the space default", () => {
    const inherited = { credentialSources: { anthropic: 'space' } } as SessionLaunchPosture;
    expect(() => launch({}, inherited)).toThrowError(/records 'space' for anthropic with no space credential id/);
  });

  it('M8b: an explicit space github source with no usable token refuses; the machine gh is never reached', async () => {
    const d = deps(fakePort({}), { github: MEMBER_GH });
    const e = await refusal(resolve(launch({ credentialSources: { github: 'space' } }), d));
    expect(e.message).toContain("credentialSources.github 'space' was requested but this space has no default github credential");
    // A space credential that is not a token is refused too.
    const wrongShape = fakePort({
      byId: { [GH_DEFAULT]: { ok: true, grant: { ...apiKeyGrant('github', GH_DEFAULT), shape: 'api_key' } } },
    });
    const e2 = await refusal(
      resolve(
        launch({ credentialSources: { github: 'space' }, spaceCredentialIds: { github: GH_DEFAULT } }),
        deps(wrongShape),
      ),
    );
    expect(e2.message).toBe(`space credential ${GH_DEFAULT} is not a GitHub token — pick a GitHub token credential`);
  });

  it('D10: a space GitHub token with no recorded account login refuses — it never authors as the label', async () => {
    const noLogin = fakePort({
      byId: { [GH_DEFAULT]: { ok: true, grant: { ...apiKeyGrant('github', GH_DEFAULT), displayLogin: null } } },
    });
    const e = await refusal(
      resolve(
        launch({ credentialSources: { github: 'space' }, spaceCredentialIds: { github: GH_DEFAULT } }),
        deps(noLogin),
      ),
    );
    expect(e.message).toContain(`space credential ${GH_DEFAULT} has no GitHub account login recorded`);
    expect(e.message).not.toContain(`secret-${GH_DEFAULT}`);
  });

  it('M8c: a policy that cannot be read refuses rather than being treated as permissive', async () => {
    const d = deps(fakePort({ policyError: new Error('connection refused'), defaults: { anthropic: ANT_DEFAULT } }), {
      home: MEMBER_HOME,
    });
    const e = await refusal(resolve(launch(), d));
    expect(e.code).toBe('internal');
    expect(e.message).toContain("could not read this space's credential policy");
    expect(e.message).toContain('retry');
  });

  it.each(['revoked', 'stale', 'pending'] as const)(
    'M8d: a pinned credential that is %s refuses and never falls back to the space default',
    async (reason) => {
      const port = fakePort({ defaults: { anthropic: ANT_DEFAULT }, byId: { [ANT_PINNED]: { ok: false, reason } } });
      const e = await refusal(
        resolve(
          launch({ credentialSources: { anthropic: 'space' }, spaceCredentialIds: { anthropic: ANT_PINNED } }),
          deps(port, { home: MEMBER_HOME }),
        ),
      );
      expect(e.code).toBe('conflict');
      expect(e.message).toContain(`space credential ${ANT_PINNED}`);
      expect(e.message).toMatch(/pick another|re-enter|finish it/);
      expect(port.reads.map((r) => r.credentialId)).toEqual([ANT_PINNED]);
    },
  );

  it('M8d: an auto launch whose space default is stale refuses instead of dropping to the node key', async () => {
    const port: SpaceCredentialPort = {
      ...fakePort({}),
      async read() {
        return { ok: false, reason: 'stale' };
      },
    };
    const e = await refusal(resolve(launch(), deps(port)));
    expect(e.message).toContain("this space's default anthropic credential is stale");
  });

  it('M8e: an undecryptable stored key refuses and names who can re-enter it', async () => {
    const port = fakePort({ byId: { [ANT_PINNED]: { ok: false, reason: 'unreadable' } } });
    const e = await refusal(
      resolve(
        launch({ credentialSources: { anthropic: 'space' }, spaceCredentialIds: { anthropic: ANT_PINNED } }),
        deps(port, { home: MEMBER_HOME }),
      ),
    );
    expect(e.message).toBe(
      `the stored secret of space credential ${ANT_PINNED} could not be decrypted on this node — its creator or a space admin must re-enter it under Space settings → Credentials`,
    );
  });

  it("a membership refusal the port phrased passes through as-is, not as M8c's 'retry'", async () => {
    const port: SpaceCredentialPort = {
      ...fakePort({}),
      async readPolicies() {
        throw new SpawnError('you are not a member of this space', 'forbidden');
      },
    };
    const e = await refusal(resolve(launch(), deps(port)));
    expect(e.code).toBe('forbidden');
    expect(e.message).toBe('you are not a member of this space');
  });

  it('a read that errors refuses; it is not a miss', async () => {
    const d = deps(fakePort({ readError: new Error('db down') }));
    const e = await refusal(resolve(launch(), d));
    expect(e.code).toBe('internal');
    expect(e.message).toContain('the launch is refused rather than run on another source');
  });

  it('I5: no refusal carries a secret', async () => {
    const port = fakePort({ byId: { [ANT_PINNED]: { ok: false, reason: 'revoked' } } });
    const e = await refusal(
      resolve(
        launch({ credentialSources: { anthropic: 'space' }, spaceCredentialIds: { anthropic: ANT_PINNED } }),
        deps(port),
      ),
    );
    expect(JSON.stringify({ m: e.message, d: e.detail })).not.toContain('secret-');
  });
});

describe('A4 — merge rules for a pin, a scalar and an inherited source', () => {
  it("a pin without 'space' for its provider refuses, never ignored", () => {
    expect(() =>
      launch({ credentialSources: { anthropic: 'member' }, spaceCredentialIds: { anthropic: ANT_PINNED } }),
    ).toThrowError(/does not set credentialSources.anthropic to 'space'/);
    expect(() => launch({ spaceCredentialIds: { anthropic: ANT_PINNED } })).toThrowError(SpawnError);
  });

  it('a pin that is not a uuid refuses', () => {
    expect(() =>
      launch({ credentialSources: { anthropic: 'space' }, spaceCredentialIds: { anthropic: 'nope' } }),
    ).toThrowError(/is not a space credential id/);
  });

  it('a pin for a provider a space cannot hold refuses', () => {
    expect(() =>
      launch({ credentialSource: 'space', spaceCredentialIds: { gemini: ANT_PINNED } as never }),
    ).toThrowError(/names a provider a space cannot hold/);
  });

  it('scalar space covers the tool provider and github, not the other tool provider', () => {
    const l = launch({ credentialSource: 'space' });
    expect(l.credentialSources.anthropic).toBe('space');
    expect(l.credentialSources.github).toBe('space');
    expect(l.credentialSources.openai).toBeNull();
  });

  it('scalar space plus a pin for the other provider covers that provider too', () => {
    const l = launch({ credentialSource: 'space', spaceCredentialIds: { openai: OAI_DEFAULT } });
    expect(l.credentialSources.openai).toBe('space');
    expect(l.spaceCredentialIds).toEqual({ openai: OAI_DEFAULT });
  });

  it('a per-provider key outranks the scalar', () => {
    const l = launch({ credentialSource: 'space', credentialSources: { github: 'member' } });
    expect(l.credentialSources.github).toBe('member');
    expect(l.credentialSources.anthropic).toBe('space');
  });

  it("scalar 'space' on a tool whose provider a space cannot hold refuses", () => {
    expect(() => launch({ credentialSource: 'space' }, null, 'gemini', 'gemini-2.5-pro')).toThrowError(
      /a space cannot hold a gemini credential/,
    );
  });

  it("the request's own source outranks an inherited space id", () => {
    const inherited: SessionLaunchPosture = {
      credentialSources: { anthropic: 'space' },
      spaceCredentialIds: { anthropic: ANT_PINNED },
    } as SessionLaunchPosture;
    const l = launch({ credentialSources: { anthropic: 'member' } }, inherited);
    expect(l.credentialSources.anthropic).toBe('member');
    expect(l.spaceCredentialIds).toEqual({});
  });

  it('an explicit space source for a provider the tool does not use is still resolved and recorded, not injected', async () => {
    const port = fakePort({ byId: { [OAI_DEFAULT]: { ok: true, grant: apiKeyGrant('openai', OAI_DEFAULT) } } });
    const d = deps(port);
    const r = await resolve(
      launch({ credentialSources: { openai: 'space' }, spaceCredentialIds: { openai: OAI_DEFAULT } }),
      d,
    );
    expect(r.launch.spaceCredentialIds).toEqual({ openai: OAI_DEFAULT });
    expect(r.credentialHome).toBeNull();
    expect(d.materialized).toEqual([]);
  });
});

describe('children and resumes carry the EXACT id (D6a)', () => {
  const parent: SessionLaunchPosture = {
    credentialSources: { anthropic: 'space' },
    spaceCredentialIds: { anthropic: ANT_PINNED },
  } as SessionLaunchPosture;

  it('a child inherits the pinned id, not the current space default', async () => {
    const port = fakePort({
      defaults: { anthropic: ANT_DEFAULT },
      byId: { [ANT_PINNED]: { ok: true, grant: apiKeyGrant('anthropic', ANT_PINNED) } },
    });
    const r = await resolve(launch({}, parent), deps(port, { home: MEMBER_HOME }));
    // github is auto here and reads the github default; anthropic reads only the pin.
    expect(port.reads.filter((x) => x.provider === 'anthropic').map((x) => x.credentialId)).toEqual([ANT_PINNED]);
    expect(r.launch.spaceCredentialIds).toEqual({ anthropic: ANT_PINNED });
    expect(r.spaceCredentialIds).toEqual([ANT_PINNED]);
  });

  it('a child whose inherited credential was deleted refuses (no fallback to the default)', async () => {
    const port = fakePort({ defaults: { anthropic: ANT_DEFAULT }, byId: { [ANT_PINNED]: { ok: false, reason: 'revoked' } } });
    const e = await refusal(resolve(launch({}, parent), deps(port)));
    expect(e.message).toContain('has been deleted');
  });

  it('a resume re-reads the recorded id under the RESUMER; a non-member gets not_found and is refused', async () => {
    const port = fakePort({}); // the resumer is not a member: every id reads not_found.
    const e = await refusal(resolve(launch({}, parent), deps(port), true));
    expect(e.message).toContain('you are not a member of its space');
    expect(port.reads[0]?.auth).toBe(AUTH_A);
  });

  it('a resume on auto never newly picks a space credential (the row is not re-recorded)', async () => {
    const port = fakePort({ defaults: { anthropic: ANT_DEFAULT } });
    const r = await resolve(launch(), deps(port), true);
    expect(port.reads).toEqual([]);
    expect(r.launch.effectiveCredentialSources?.anthropic).toBe('node');
  });
});

describe('A3 / C1 — an agent may choose a space credential; its claims are the launcher\'s', () => {
  it("an agent's explicit pin is read under the launcher's claims, never the persona owner's", async () => {
    // Member A's agent spawns B's teammate. The only identity resolution ever
    // sees is the auth it is handed — A's, by `agent-claims-are-the-launcher`.
    const port = fakePort({ byId: { [ANT_PINNED]: { ok: true, grant: apiKeyGrant('anthropic', ANT_PINNED) } } });
    const d = deps(port);
    const r = await resolve(
      launch({ credentialSources: { anthropic: 'space' }, spaceCredentialIds: { anthropic: ANT_PINNED } }),
      d,
    );
    expect(port.reads).toEqual([
      { auth: AUTH_A, provider: 'anthropic', credentialId: ANT_PINNED },
      { auth: AUTH_A, provider: 'github', credentialId: null },
    ]);
    expect(r.launch.credentialSources.anthropic).toBe('space');
    expect(r.spaceCredentialIds).toEqual([ANT_PINNED]);
  });
});

// 992 (W7p): a link-bound launch — a `link` session, or an agent minted under
// one — has no member rung (ruling (i)) and runs git only on this space's
// default GitHub credential (ruling 4). The SQL half (093/206/083 refusing the
// same caller) is `packages/server/test/db/space-link-provenance.pg.test.ts`.
describe('W7p — a link-bound launch never reaches the linking human\'s own credentials', () => {
  const linked = (l: ResolvedLaunchConfig, d: CredentialResolutionDeps, resume = false) =>
    resolveSessionCredentials({ auth: AUTH_A, spaceId: SPACE, launch: l, resume, linkBound: true }, d);
  const both = { anthropic: ANT_DEFAULT, github: GH_DEFAULT };

  it('auto: runs on the space defaults even with the member connected, and never asks the member', async () => {
    const port = fakePort({ defaults: both });
    const d = deps(port, { home: MEMBER_HOME, github: MEMBER_GH });
    const r = await linked(launch(), d);
    expect(d.memberAsks).toEqual([]);
    expect(r.credentialHome?.space?.credentialId).toBe(ANT_DEFAULT);
    expect(r.gitHubCredential?.token).toBe(`secret-${GH_DEFAULT}`);
    expect(r.launch.effectiveCredentialSources).toEqual({ anthropic: 'space', github: 'space' });
    // Only ever the DEFAULT: 206 refuses a pinned id for this caller.
    expect(port.reads.map((x) => x.credentialId)).toEqual([null, null]);
  });

  it("explicit 'member' is refused by name", async () => {
    const d = deps(fakePort({ defaults: both }), { home: MEMBER_HOME });
    const e = await refusal(linked(launch({ credentialSources: { anthropic: 'member' } }), d));
    expect(e.code).toBe('forbidden');
    expect(e.detail).toMatchObject({ provider: 'anthropic', reason: 'member_refused', spaceLink: true });
    expect(d.memberAsks).toEqual([]);
  });

  it('no space model default: falls to the node when the node is allowed', async () => {
    const r = await linked(launch(), deps(fakePort({ defaults: { github: GH_DEFAULT } }), { home: MEMBER_HOME }));
    expect(r.credentialHome).toBeNull();
    expect(r.launch.effectiveCredentialSources).toEqual({ anthropic: 'node', github: 'space' });
  });

  it('no space model default and no node: a named "no model credential" refusal, never the member key', async () => {
    const d = deps(
      fakePort({ defaults: { github: GH_DEFAULT }, policies: { space: {}, node: { anthropic: false } } }),
      { home: MEMBER_HOME },
    );
    const e = await refusal(linked(launch(), d));
    expect(e.code).toBe('forbidden');
    expect(e.detail).toMatchObject({ provider: 'anthropic', reason: 'no_model_credential' });
    expect(e.message).toContain('this space has no default anthropic credential');
    expect(e.message).toContain('node anthropic credentials are not allowed here');
    expect(d.memberAsks).toEqual([]);
  });

  it('a model only a member API key serves is refused by name', async () => {
    const d = deps(fakePort({ defaults: both }), { home: MEMBER_HOME });
    const e = await refusal(linked(launch({}, null, 'claude-code', 'kimi-k2-thinking'), d));
    expect(e.detail).toMatchObject({ reason: 'member_key_model', model: 'kimi-k2-thinking' });
    expect(d.memberAsks).toEqual([]);
  });

  it('no space GitHub default: a named "no git" refusal, never the member login and never without git', async () => {
    const d = deps(fakePort({ defaults: { anthropic: ANT_DEFAULT } }), { github: MEMBER_GH });
    const e = await refusal(linked(launch(), d));
    expect(e.code).toBe('forbidden');
    expect(e.detail).toMatchObject({ provider: 'github', reason: 'no_git_credential' });
  });

  it("GitHub 'node' is refused: git runs only on the space default", async () => {
    const d = deps(fakePort({ defaults: both }));
    const e = await refusal(linked(launch({ credentialSources: { github: 'node' } }), d));
    expect(e.detail).toMatchObject({ provider: 'github', reason: 'node_git_refused' });
  });

  it('a recorded id that is no longer the default refuses rather than switch credentials', async () => {
    const port = fakePort({ defaults: both });
    const recorded = {
      credentialSources: { anthropic: 'space' },
      spaceCredentialIds: { anthropic: ANT_PINNED },
    } as unknown as SessionLaunchPosture;
    const e = await refusal(linked(launch({}, recorded), deps(port), true));
    expect(e.detail).toMatchObject({ provider: 'anthropic', reason: 'not_default', spaceCredentialId: ANT_PINNED });
    expect(port.reads.map((x) => x.credentialId)).toEqual([null]);
  });

  it("206's 42501 (link signed out, or spawning switched off) surfaces as a named refusal", async () => {
    const d = deps(fakePort({ readError: Object.assign(new Error('link not signed in'), { code: '42501' }) }));
    const e = await refusal(linked(launch(), d));
    expect(e.code).toBe('forbidden');
    expect(e.detail).toMatchObject({ provider: 'anthropic', reason: 'space_read_refused' });
  });

  it('control: the same launch without linkBound still takes the member rung', async () => {
    const d = deps(fakePort({ defaults: both }), { home: MEMBER_HOME, github: MEMBER_GH });
    const r = await resolve(launch(), d);
    expect(r.credentialHome).toBe(MEMBER_HOME);
  });
});
