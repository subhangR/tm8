// @vitest-environment jsdom
/**
 * A NODE THAT KNOWS A PROVIDER THIS BUILD DOES NOT — the production crash.
 *
 * On 2026-09-22 the Connections panel died with
 *
 *   The view crashed: Cannot read properties of undefined
 *   (reading 'needsGitCredentialStore')
 *
 * for every tab that had been open across a node upgrade. The upgrade added a
 * provider; `credentials.status` began listing it minutes later; and the page
 * still held the presentation table it was compiled with. `presentationOf`
 * missed, `verdictOf` read a property off the miss, and React unmounted the
 * whole panel.
 *
 * WHAT MAKES THAT CLASS OF BUG INVISIBLE TO EVERY OTHER TEST IN THIS FOLDER:
 * they all build their fixtures from the same union the components compile
 * against, so the table is total by construction and the miss is unreachable.
 * The skew is between TWO DEPLOYMENTS, and only a fixture that names a
 * provider the table deliberately does not contain can stand in for it.
 *
 * So `'a-provider-added-after-this-build'` below is not a malformed value to be
 * tidied into a real one. It is the test's entire subject: the shape of an
 * ordinary, valid, correctly-measured entry for a provider that shipped after
 * this bundle did. Nothing here may crash on it, and nothing here may print it.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type {
  CredentialConnectionView,
  CredentialProviderName,
  CredentialsStatusView,
} from '@tm8/contract';
import { CredentialProviderNameSchema } from '@tm8/contract';
import { CredentialsProviderBlock } from './CredentialsProviderBlock';
import { CredentialsSection } from './CredentialsSection';
import {
  CREDENTIAL_PROVIDER_PRESENTATIONS,
  isKnownCredentialProvider,
  presentationOf,
  providerBinaryLabel,
} from './provider-presentation';
import { recognisedProviders, verdictOf, type CredentialsPort } from './port';
import { STALE_PAGE_HEAD, stalePageWhy } from './stale-page';

/**
 * A provider id this build has no entry for.
 *
 * Cast because that is precisely the situation: on the wire it is a perfectly
 * ordinary `CredentialProviderName`, minted by a node built from a NEWER union
 * than the one this file compiles against. The cast is the version skew,
 * written down.
 */
const NEWER = 'a-provider-added-after-this-build' as CredentialProviderName;

function entry(
  provider: CredentialProviderName,
  over: Partial<CredentialConnectionView> = {},
): CredentialConnectionView {
  return {
    provider,
    connected: false,
    login: null,
    authMethod: null,
    status: null,
    connectedAt: null,
    lastVerifiedAt: null,
    routing: null,
    ...over,
  };
}

/** What the upgraded node sends: the old list, plus one this build lacks. */
const SKEWED: CredentialsStatusView = {
  providers: [
    entry('anthropic', { connected: true, login: 'someone@example.com', status: 'active' }),
    entry('github'),
    entry(NEWER, { connected: true, login: 'someone@example.com', status: 'active' }),
  ],
  gitCredentialStore: 'absent',
};

const skewedPort: CredentialsPort = {
  load: async () => SKEWED,
  disconnect: async () => ({ revoked: true, failures: [] }),
  startLogin: async () => { throw new Error('not reached'); },
  finishLogin: async () => { throw new Error('not reached'); },
};

describe('the lookup that crashed', () => {
  it('reads a verdict for a provider it has never heard of, instead of throwing', () => {
    // The exact production stack: verdictOf -> presentationOf -> undefined
    // -> .needsGitCredentialStore. `gitCredentialStore: 'absent'` is the arm
    // that reaches the property at all, so it is the one worth pinning.
    expect(() => verdictOf(entry(NEWER), 'absent')).not.toThrow();
    expect(verdictOf(entry(NEWER), 'absent')).toBe('disconnected');
  });

  it('keeps the measured answer for a newer provider the node reports connected', () => {
    // Degrading is about what can be NAMED, never about what was MEASURED. A
    // connection reported by the node stays a connection here, so the setup
    // gate does not tell a member to redo a login they already hold.
    expect(verdictOf(entry(NEWER, { connected: true, login: 'a@b.c' }), 'absent'))
      .toBe('connected-named');
  });

  it('answers a presentation for any id, and says which ones it actually knows', () => {
    expect(presentationOf(NEWER)).toBeDefined();
    expect(presentationOf(NEWER).icon).toBeTypeOf('function');
    expect(providerBinaryLabel(NEWER)).toBe('API key');

    expect(isKnownCredentialProvider(NEWER)).toBe(false);
    expect(isKnownCredentialProvider('github')).toBe(true);
    // Not inherited members: `toString` is on every object and is not a provider.
    expect(isKnownCredentialProvider('toString')).toBe(false);
  });

  it('splits a skewed response into what it can draw and a count of what it cannot', () => {
    const split = recognisedProviders(SKEWED);
    expect(split.renderable.map((p) => p.provider)).toEqual(['anthropic', 'github']);
    expect(split.unrecognised).toBe(1);
  });
});

describe('what the notice says', () => {
  it('counts in words the reader can act on, singular and plural', () => {
    expect(stalePageWhy(1)).toBe(
      'Your workspace has a connection this page is too old to show. ' +
        'Reload to see it \u2014 nothing you have already connected is affected.',
    );
    expect(stalePageWhy(3)).toBe(
      'Your workspace has 3 connections this page is too old to show. ' +
        'Reload to see them \u2014 nothing you have already connected is affected.',
    );
  });

  it('blames the page, not the reader, and asks for nothing they cannot do', () => {
    const copy = `${STALE_PAGE_HEAD} ${stalePageWhy(2)}`;
    // Nothing here may read as a credential problem: their logins are intact,
    // and sending them to reconnect something would be a wasted trip.
    expect(copy).not.toMatch(/reconnect|sign in again|expired|error|failed/i);
    // Nor as plumbing. A build id, a provider id or a version string here
    // would answer "what do I do?" with something only we can read.
    expect(copy).not.toMatch(/provider|bundle|cache|version|deploy|server|node/i);
  });
});

describe('the panel against an upgraded node', () => {
  it('renders the providers it knows instead of crashing', async () => {
    render(<CredentialsProviderBlock port={skewedPort} />);

    expect(await screen.findByTestId('credential-card-anthropic')).toBeTruthy();
    expect(screen.getByTestId('credential-card-github')).toBeTruthy();
    // No nameless, markless card for the one it cannot present.
    expect(screen.queryByTestId(`credential-card-${NEWER}`)).toBeNull();
  });

  it('says the page is behind — in plain words, and never by printing the id', async () => {
    render(<CredentialsProviderBlock port={skewedPort} />);

    const notice = await screen.findByTestId('credentials-stale-page');
    expect(notice.textContent).toContain('This page is out of date.');
    expect(notice.textContent).toContain('Reload');
    // The id is what this build holds INSTEAD of a name. Printing it would
    // answer "which one?" with plumbing, and it is the one thing the notice
    // must never do.
    expect(document.body.textContent).not.toContain(NEWER);
  });

  it('stays quiet when the node and the page agree', async () => {
    const matched: CredentialsPort = {
      ...skewedPort,
      load: async () => ({ providers: [entry('anthropic')], gitCredentialStore: 'present' }),
    };
    render(<CredentialsProviderBlock port={matched} />);

    expect(await screen.findByTestId('credential-card-anthropic')).toBeTruthy();
    expect(screen.queryByTestId('credentials-stale-page')).toBeNull();
  });

  it('keeps the Settings health summary to the providers it can name', async () => {
    render(<CredentialsSection port={skewedPort} />);

    expect(await screen.findByTestId('credential-pill-anthropic')).toBeTruthy();
    expect(screen.queryByTestId(`credential-pill-${NEWER}`)).toBeNull();
  });
});

describe('the routing sentence when the counterpart is newer than this build', () => {
  it('keeps the fact and drops the name', async () => {
    // openai is displaced by a backend that shipped after this bundle. The
    // member must still learn their codex sessions go elsewhere; before this
    // guard the vendor name rendered as a blank in the middle of the sentence.
    const displaced: CredentialsPort = {
      ...skewedPort,
      load: async () => ({
        providers: [
          entry('openai', {
            routing: { agentTool: 'codex', role: 'displaced', counterpart: NEWER, active: false },
          }),
        ],
        gitCredentialStore: 'present',
      }),
    };
    render(<CredentialsProviderBlock port={displaced} />);

    const line = await screen.findByTestId('credential-routing-displaced');
    expect(line.textContent).toContain('Not currently used for codex sessions');
    expect(line.textContent).toContain('another connected account takes over');
    expect(line.textContent).not.toContain(NEWER);
  });

  it('still names a counterpart it knows', async () => {
    const backed: CredentialsPort = {
      ...skewedPort,
      load: async () => ({
        providers: [
          entry('kimi', {
            connected: true,
            status: 'active',
            routing: { agentTool: 'claude-code', role: 'backend', counterpart: 'anthropic', active: true },
          }),
        ],
        gitCredentialStore: 'present',
      }),
    };
    render(<CredentialsProviderBlock port={backed} />);

    const line = await screen.findByTestId('credential-routing-backend');
    expect(line.textContent).toContain('Anthropic');
  });
});

describe('the other half of the same skew — a build ahead of its own contract', () => {
  it('has a presentation for every provider this build was compiled against', () => {
    /* The runtime option list. `CredentialProviderNameSchema` is declared as
       `z.ZodType<CredentialProviderName>`, and that annotation erases the enum's
       own `options` from the type — the values are still there at run time,
       which is the only place this pin can be measured. */
    const declared = (
      CredentialProviderNameSchema as unknown as { options: readonly CredentialProviderName[] }
    ).options;

    // The guard the production incident wanted: adding a provider to the
    // contract without a card for it fails HERE, in this repository, rather
    // than on the first node that deploys the pair out of step.
    expect(declared.length).toBeGreaterThan(0);
    for (const provider of declared) {
      expect(
        Object.prototype.hasOwnProperty.call(CREDENTIAL_PROVIDER_PRESENTATIONS, provider),
        `no presentation entry for "${provider}" — add one beside the others`,
      ).toBe(true);
    }
  });
});
