/**
 * Which credential each provider of a launch runs on: member → space → node
 * (D4) under the space and node policies (D5), design 01a0cfa8 §4.
 *
 * THIS IS THE ONLY PLACE D5 IS ENFORCED. 206's spawn reader and its manifest
 * writer check membership and credential status but never read a policy
 * (advisory A5), so every path that can put a session on a credential — a
 * fresh spawn, an inherited child, a resume, a pinned id — passes through
 * `resolveSessionCredentials`, and a policy that excludes a source excludes it
 * here whether the source was asked for, inherited or recorded.
 *
 * FAIL CLOSED (I3). An explicit source that cannot be honoured refuses with a
 * sentence naming the fix or the policy. Only AUTO degrades, only along D4, and
 * only through sources the policy allows. A pinned credential that is revoked,
 * stale or missing never falls back to the space default (M8d); an unreadable
 * key never falls back to anything (M8e); a policy that cannot be read refuses
 * rather than being treated as permissive (M8c).
 *
 * The caller's claims are the only identity used: for an agent they are its
 * root human launcher's (`agent-claims-are-the-launcher`), so membership and
 * the member rung both follow the launcher, never the persona's owner.
 */
import { join } from 'node:path';

import {
  agentCredentialProviderFor,
  type AgentCredentialHome,
} from './agent-credentials.js';
import { commonCredentialSource, type ResolvedLaunchConfig } from './manifest.js';
import type {
  CredentialSource,
  GitHubCredential,
  GraphAuth,
  SpaceCredentialGrant,
  SpaceCredentialPolicies,
  SpaceCredentialPort,
  SpaceCredentialProvider,
  SpaceCredentialRefusalReason,
} from './types.js';
import { SpawnError, SPACE_CREDENTIAL_PROVIDERS } from './types.js';

export interface CredentialResolutionDeps {
  /** Absent on a node with no data root: `space` is then refused by name. */
  spaceCredentials?: SpaceCredentialPort;
  /**
   * The member rung for the tool's provider. `source` is `'member'` (refuses
   * when nothing usable is connected) or `null` (auto: null when nothing is).
   */
  resolveMemberHome(source: 'member' | null): Promise<AgentCredentialHome | null>;
  /** The member rung for GitHub; null when the caller connected none. */
  resolveMemberGitHub(): Promise<GitHubCredential | null>;
  /** Create or re-seed the per-session home for a space API key. */
  materializeApiKeyHome(input: {
    provider: 'anthropic' | 'openai';
    credentialId: string;
    apiKey: string;
  }): Promise<AgentCredentialHome>;
}

export interface CredentialResolutionInput {
  auth: GraphAuth;
  spaceId: string;
  launch: ResolvedLaunchConfig;
  /**
   * A resume keeps the credential the session ran on. Auto is NOT re-offered
   * the space there: the manifest row is not re-recorded on resume, so a space
   * credential picked now would be one containment cannot see (D7).
   */
  resume?: boolean;
}

export interface ResolvedSessionCredentials {
  /** `launch` with auto resolved to `space` recorded, the ids, and D9's effective sources. */
  launch: ResolvedLaunchConfig;
  credentialHome: AgentCredentialHome | null;
  gitHubCredential: GitHubCredential | null;
  /** The space credential ids this session runs on; the post-spawn recheck reads these. */
  spaceCredentialIds: string[];
}

type Effective = CredentialSource;

function allowedBy(
  policies: SpaceCredentialPolicies,
  provider: SpaceCredentialProvider,
): { member: boolean; space: boolean; nodeBySpace: boolean; nodeByNode: boolean } {
  const list = policies.space[provider];
  const allows = (source: CredentialSource) => (list === undefined ? true : list.includes(source));
  return {
    member: allows('member'),
    space: allows('space'),
    nodeBySpace: allows('node'),
    nodeByNode: policies.node[provider] !== false,
  };
}

function spacePolicySentence(policies: SpaceCredentialPolicies, provider: SpaceCredentialProvider): string {
  const list = policies.space[provider] ?? [];
  return list.length === 0
    ? `a space admin has disabled every ${provider} source in this space`
    : `a space admin allows only ${list.map((s) => `'${s}'`).join(' or ')} for ${provider} in this space`;
}

function refusalSentence(
  provider: SpaceCredentialProvider,
  pinned: string | null,
  reason: SpaceCredentialRefusalReason,
): string {
  const which = pinned ? `space credential ${pinned}` : `this space's default ${provider} credential`;
  switch (reason) {
    case 'no_default':
      return `credentialSources.${provider} 'space' was requested but this space has no default ` +
        `${provider} credential — add one under Space settings → Credentials, pin one with ` +
        `spaceCredentialIds.${provider}, or choose 'member' or 'node'`;
    case 'not_found':
      return `${which} is not a ${provider} credential of this space, or you are not a member of ` +
        'its space — pick a credential this space holds, or omit the id to use the space default';
    case 'revoked':
      return `${which} has been deleted — pick another space credential, or omit the id to use ` +
        'the space default';
    case 'stale':
      return `${which} is stale (its last probe failed) — its creator or a space admin must ` +
        're-enter or re-login it under Space settings → Credentials, or pick another';
    case 'pending':
      return `${which} has not finished its login — finish it under Space settings → ` +
        'Credentials, or pick another';
    case 'unreadable':
      return `the stored secret of ${which} could not be decrypted on this node — its creator ` +
        'or a space admin must re-enter it under Space settings → Credentials';
  }
}

async function readPolicies(
  deps: CredentialResolutionDeps,
  auth: GraphAuth,
  spaceId: string,
): Promise<SpaceCredentialPolicies> {
  if (!deps.spaceCredentials) return { space: {}, node: {} };
  try {
    return await deps.spaceCredentials.readPolicies(auth, spaceId);
  } catch (error) {
    // M8c. A policy that cannot be read is not a permissive policy.
    throw new SpawnError(
      "could not read this space's credential policy, so the launch is refused rather than " +
        'run past a policy it cannot see — retry, and if it persists check the node database',
      'internal',
      { spaceId, cause: error instanceof Error ? error.message : String(error) },
    );
  }
}

export async function resolveSessionCredentials(
  input: CredentialResolutionInput,
  deps: CredentialResolutionDeps,
): Promise<ResolvedSessionCredentials> {
  const { auth, spaceId, launch } = input;
  const policies = await readPolicies(deps, auth, spaceId);
  const toolProvider = agentCredentialProviderFor(launch.agentTool);

  const sources = { ...launch.credentialSources };
  const ids: Partial<Record<SpaceCredentialProvider, string>> = {};
  const effective: Partial<Record<SpaceCredentialProvider, Effective>> = {};

  const readSpace = async (
    provider: SpaceCredentialProvider,
    pinned: string | null,
  ): Promise<SpaceCredentialGrant | null> => {
    if (!deps.spaceCredentials) {
      if (pinned === null && launch.credentialSources[provider] !== 'space') return null;
      throw new SpawnError(
        `credentialSources.${provider} 'space' was requested but this node has no space ` +
          "credential store (it runs without a data root) — choose 'member' or 'node'",
        'conflict',
        { provider },
      );
    }
    let read;
    try {
      read = await deps.spaceCredentials.read(auth, spaceId, provider, pinned);
    } catch (error) {
      throw new SpawnError(
        `could not read ${pinned ? `space credential ${pinned}` : `this space's default ${provider} credential`} ` +
          '— the launch is refused rather than run on another source; retry',
        'internal',
        { provider, cause: error instanceof Error ? error.message : String(error) },
      );
    }
    if (read.ok) return read.grant;
    // Auto asking for a default that does not exist is the one miss that
    // degrades; every other refusal is a broken credential and stops here.
    if (read.reason === 'no_default' && launch.credentialSources[provider] !== 'space') return null;
    throw new SpawnError(refusalSentence(provider, pinned, read.reason), 'conflict', {
      provider,
      reason: read.reason,
      ...(pinned ? { spaceCredentialId: pinned } : {}),
    });
  };

  const useSpace = (provider: SpaceCredentialProvider, grant: SpaceCredentialGrant): void => {
    sources[provider] = 'space';
    ids[provider] = grant.credentialId;
    effective[provider] = 'space';
  };

  /** The policy gate for an explicit (requested, inherited or recorded) source. */
  const gateExplicit = (provider: SpaceCredentialProvider, source: CredentialSource): void => {
    const allowed = allowedBy(policies, provider);
    if (source === 'member' && !allowed.member) {
      throw new SpawnError(
        `credentialSources.${provider} 'member' is not allowed: ${spacePolicySentence(policies, provider)}`,
        'forbidden',
        { provider, source },
      );
    }
    if (source === 'space' && !allowed.space) {
      throw new SpawnError(
        `credentialSources.${provider} 'space' is not allowed: ${spacePolicySentence(policies, provider)}`,
        'forbidden',
        { provider, source },
      );
    }
    if (source === 'node' && !allowed.nodeBySpace) {
      throw new SpawnError(
        `credentialSources.${provider} 'node' is not allowed: ${spacePolicySentence(policies, provider)}`,
        'forbidden',
        { provider, source },
      );
    }
    if (source === 'node' && !allowed.nodeByNode) {
      throw new SpawnError(
        `credentialSources.${provider} 'node' is not allowed: the node admin has forbidden node ` +
          `${provider} credentials on this node — launch with 'member' or 'space'`,
        'forbidden',
        { provider, source },
      );
    }
  };

  const autoExhausted = (provider: SpaceCredentialProvider): SpawnError => {
    const allowed = allowedBy(policies, provider);
    const why = !allowed.nodeByNode
      ? `the node admin has forbidden node ${provider} credentials on this node`
      : spacePolicySentence(policies, provider);
    const fixes = [
      allowed.member ? `connect your own ${provider} credential under Settings → Connections` : null,
      allowed.space && !input.resume ? `add a ${provider} credential to this space` : null,
    ].filter((s): s is string => s !== null);
    return new SpawnError(
      `no ${provider} credential is usable for this launch: ${why}` +
        (fixes.length > 0 ? ` — ${fixes.join(', or ')}` : ''),
      'forbidden',
      { provider },
    );
  };

  // ---- the tool's own provider ------------------------------------------
  let credentialHome: AgentCredentialHome | null = null;
  if (toolProvider === 'anthropic' || toolProvider === 'openai') {
    const provider = toolProvider;
    const source = launch.credentialSources[provider] ?? null;
    const allowed = allowedBy(policies, provider);
    if (source !== null) gateExplicit(provider, source);
    if (source === 'member') {
      credentialHome = await deps.resolveMemberHome('member');
      effective[provider] = 'member';
    } else if (source === 'node') {
      effective[provider] = 'node';
    } else if (source === 'space') {
      const grant = await readSpace(provider, launch.spaceCredentialIds?.[provider] ?? null);
      if (!grant) throw new Error('unreachable: an explicit space read returns or throws');
      credentialHome = await spaceHome(deps, provider, grant);
      useSpace(provider, grant);
    } else {
      // Auto, along D4 and only through what the policy allows.
      const member = allowed.member ? await deps.resolveMemberHome(null) : null;
      if (member) {
        credentialHome = member;
        effective[provider] = 'member';
      } else {
        const grant = allowed.space && !input.resume ? await readSpace(provider, null) : null;
        if (grant) {
          credentialHome = await spaceHome(deps, provider, grant);
          useSpace(provider, grant);
        } else if (allowed.nodeBySpace && allowed.nodeByNode) {
          effective[provider] = 'node';
        } else {
          throw autoExhausted(provider);
        }
      }
    }
  } else {
    // A provider the space cannot hold (gemini), or a tool with none
    // (echo-agent, an operator wrapper), keeps its pre-space behaviour exactly.
    const source = toolProvider
      ? (launch.credentialSources as Partial<Record<string, CredentialSource>>)[toolProvider] ?? null
      : null;
    credentialHome = source === 'node' ? null : await deps.resolveMemberHome(source === 'member' ? 'member' : null);
  }

  // ---- GitHub -----------------------------------------------------------
  let gitHubCredential: GitHubCredential | null = null;
  {
    const provider = 'github' as const;
    const source = launch.credentialSources.github ?? null;
    const allowed = allowedBy(policies, provider);
    if (source !== null) gateExplicit(provider, source);
    if (source === 'member') {
      gitHubCredential = await deps.resolveMemberGitHub();
      effective.github = 'member';
    } else if (source === 'node') {
      effective.github = 'node';
    } else if (source === 'space') {
      // M8b: an explicit space token that cannot be used refuses here, and
      // `composeEnv` isolates `space` as strictly as `member`, so the node's
      // machine gh is unreachable either way.
      const grant = await readSpace(provider, launch.spaceCredentialIds?.github ?? null);
      if (!grant) throw new Error('unreachable: an explicit space read returns or throws');
      gitHubCredential = spaceGitHub(grant);
      useSpace(provider, grant);
    } else {
      const member = allowed.member ? await deps.resolveMemberGitHub() : null;
      if (member) {
        gitHubCredential = member;
        effective.github = 'member';
      } else {
        const grant = allowed.space && !input.resume ? await readSpace(provider, null) : null;
        if (grant) {
          gitHubCredential = spaceGitHub(grant);
          useSpace(provider, grant);
        } else if (allowed.nodeBySpace && allowed.nodeByNode) {
          effective.github = 'node';
        } else {
          throw autoExhausted(provider);
        }
      }
    }
  }

  // ---- an explicit space source for a provider this tool does not use ------
  // Still resolved and recorded — fail closed, and a child on the other tool
  // inherits the exact id — but never injected.
  for (const provider of SPACE_CREDENTIAL_PROVIDERS) {
    if (provider === 'github' || provider === (toolProvider as string | null)) continue;
    if (launch.credentialSources[provider] !== 'space') continue;
    gateExplicit(provider, 'space');
    const grant = await readSpace(provider, launch.spaceCredentialIds?.[provider] ?? null);
    if (grant) {
      sources[provider] = 'space';
      ids[provider] = grant.credentialId;
    }
  }

  const resolvedLaunch: ResolvedLaunchConfig = {
    ...launch,
    credentialSources: sources,
    credentialSource: commonCredentialSource(sources),
    spaceCredentialIds: ids,
    effectiveCredentialSources: effective,
  };
  return {
    launch: resolvedLaunch,
    credentialHome,
    gitHubCredential,
    spaceCredentialIds: [...new Set(Object.values(ids))],
  };
}

async function spaceHome(
  deps: CredentialResolutionDeps,
  provider: 'anthropic' | 'openai',
  grant: SpaceCredentialGrant,
): Promise<AgentCredentialHome> {
  if (grant.kind === 'login') {
    return {
      provider,
      homeDir: grant.homeDir,
      configDir: join(grant.homeDir, provider),
      space: { credentialId: grant.credentialId },
    };
  }
  if (grant.shape !== 'api_key') {
    throw new SpawnError(
      `space credential ${grant.credentialId} is a ${grant.shape}, which ${provider} cannot use — ` +
        'pick an API key or a login credential',
      'conflict',
      { provider, spaceCredentialId: grant.credentialId },
    );
  }
  return deps.materializeApiKeyHome({ provider, credentialId: grant.credentialId, apiKey: grant.secret });
}

function spaceGitHub(grant: SpaceCredentialGrant): GitHubCredential {
  if (grant.kind !== 'secret' || grant.shape !== 'token') {
    throw new SpawnError(
      `space credential ${grant.credentialId} is not a GitHub token — pick a GitHub token credential`,
      'conflict',
      { provider: 'github', spaceCredentialId: grant.credentialId },
    );
  }
  // D10: commits are authored by the token's account, shown in the picker.
  return { provider: 'github', login: grant.displayLogin ?? grant.label, token: grant.secret };
}
