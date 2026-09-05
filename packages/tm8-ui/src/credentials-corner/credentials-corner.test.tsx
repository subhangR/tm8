// @vitest-environment jsdom
/**
 * The corner credential control.
 *
 * What these pin, each against a failure this feature has already shipped once
 * or could plausibly ship next:
 *
 *   - CLOSED IS CLOSED. The point of the control is that sign-ins cost the page
 *     nothing until asked for, so a panel that merely renders offscreen — or a
 *     block mounted behind `display: none` — is a regression wearing the fix's
 *     clothes.
 *   - THE ANSWER SURVIVES THE COLLAPSE. `summaryOf` is asserted directly. It is
 *     the only judgement in the module, and driving it through a rendered
 *     popover would be testing the popover instead.
 *   - AN EXCEPTION OUTRANKS A TALLY. "3 of 6 connected" is TRUE while Hermes is
 *     missing, and useless: what stops an agent you launch is the exception.
 *   - A REFUSAL IS NOT A ZERO. The shipped rail had no way to say "I could not
 *     read this"; a control that renders an unanswered question as "0 of 6"
 *     invents a confident negative.
 *   - A CLICK REVEALS, IT DOES NOT LAUNCH. `ProviderRail` chips called
 *     `startLogin` on click (ProviderRail.tsx:199), so pressing a provider
 *     committed you to a terminal. That is the behaviour Tarkesh described as
 *     not opening anything, and it must not come back.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, waitFor, within } from '@testing-library/react';
import type {
  CredentialConnectionView,
  CredentialProviderName,
  CredentialsStatusView,
} from '@tm8/contract';
import { CREDENTIAL_PROVIDER_PRESENTATIONS } from '../settings-credentials/provider-presentation';
import type { CredentialsPort } from '../settings-credentials/port';
import { CredentialsCorner, summaryOf } from './CredentialsCorner';

function connection(
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
    ...over,
  };
}

/** The shipped screen: github connected, hermes missing, gemini unmeasured. */
const status: CredentialsStatusView = {
  providers: [
    connection('anthropic', { connected: true, status: 'active' }),
    connection('openai'),
    connection('github', { connected: true, login: 'ada', status: 'active' }),
    connection('gemini', { status: 'stale' }),
    connection('hermes', { status: 'unavailable' }),
    connection('cursor', { connected: true, status: 'active' }),
  ],
  gitCredentialStore: 'present',
};

/** Everything answered, nothing wrong — the case that must stay quiet. */
const allHealthy: CredentialsStatusView = {
  providers: (Object.keys(CREDENTIAL_PROVIDER_PRESENTATIONS) as CredentialProviderName[])
    .map((p) => connection(p, { connected: true, status: 'active' })),
  gitCredentialStore: 'present',
};

function portWith(over: Partial<CredentialsPort> = {}): CredentialsPort {
  return {
    load: async () => status,
    disconnect: async (provider) => ({
      provider,
      revoked: true,
      terminatedCredentialSessionIds: [],
      terminatedAgentSessionIds: [],
      failures: [],
    }),
    startLogin: async (provider) => ({
      workSessionId: 'ws-corner-login',
      spaceId: 'space-1',
      provider,
      expiresAt: '2026-09-05T12:10:00.000Z',
      command: `${provider} login`,
    }),
    finishLogin: async (workSessionId) => ({
      workSessionId,
      provider: 'openai',
      connected: true,
      login: null,
      authMethod: 'oauth',
      status: 'active',
      stored: true,
      terminated: true,
    }),
    ...over,
  };
}

describe('what the closed control says', () => {
  it('leads with the exception rather than the tally', () => {
    // Three ARE connected here. Saying so would be true and useless.
    expect(summaryOf(status, null)).toEqual({
      tone: 'attention',
      text: 'Agent sign-ins — 1 unavailable',
    });
  });

  it('reports an unmeasured provider as unmeasured, not as disconnected', () => {
    const onlyUnknown: CredentialsStatusView = {
      providers: [
        connection('anthropic', { connected: true, status: 'active' }),
        connection('gemini', { status: 'stale' }),
      ],
      gitCredentialStore: 'present',
    };
    expect(summaryOf(onlyUnknown, null)).toEqual({
      tone: 'attention',
      text: 'Agent sign-ins — 1 not measured',
    });
  });

  it('falls back to the count only when nothing needs attention', () => {
    expect(summaryOf(allHealthy, null)).toEqual({
      tone: 'quiet',
      text: 'Agent sign-ins — 6 of 6 connected',
    });
  });

  it('says the read was refused instead of inventing a zero', () => {
    const s = summaryOf(null, 'node refused');
    expect(s.tone).toBe('unread');
    expect(s.text).toBe('Agent sign-ins — status unread');
    // The specific failure this guards: a confident negative built from an
    // unanswered question.
    expect(s.text).not.toMatch(/0 of/);
    expect(s.text).not.toMatch(/connected/);
  });

  it('does not claim a count before the node has answered', () => {
    expect(summaryOf(null, null).text).toBe('Agent sign-ins — reading…');
  });
});

describe('the corner control', () => {
  it('mounts nothing of the detailed block until it is opened', async () => {
    const { findByLabelText, queryByTestId } = render(<CredentialsCorner port={portWith()} />);
    await findByLabelText('Agent sign-ins — 1 unavailable');

    // Absent, not hidden. A closed control that still mounts the block keeps
    // paying for the thing this component exists to stop paying for.
    expect(queryByTestId('credentials-corner-panel')).toBeNull();
    expect(queryByTestId('credentials-provider-block')).toBeNull();
    expect(queryByTestId('credential-provider-grid')).toBeNull();
  });

  it('carries its tone as a shape, not only as a colour', async () => {
    const { findByTestId } = render(<CredentialsCorner port={portWith()} />);
    const trigger = await findByTestId('credentials-corner-trigger');
    await waitFor(() => expect(trigger.getAttribute('data-tone')).toBe('attention'));
    expect(
      trigger.querySelector('.cred-corner__flag')?.getAttribute('data-tone'),
    ).toBe('attention');
  });

  it('opens the shared block on click and closes on Escape', async () => {
    const { findByLabelText, findByTestId, getByTestId, queryByTestId } = render(
      <CredentialsCorner port={portWith()} />,
    );
    await findByLabelText('Agent sign-ins — 1 unavailable');

    fireEvent.click(getByTestId('credentials-corner-trigger'));
    const panel = await findByTestId('credentials-corner-panel');

    expect(panel.getAttribute('role')).toBe('dialog');
    expect(getByTestId('credentials-corner-trigger').getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(panel);

    await within(panel).findByTestId('credential-card-cursor');
    expect(within(panel).getAllByTestId(/^credential-card-/)).toHaveLength(6);
    expect(within(panel).getByTestId('credential-connect-anthropic').textContent).toBe('Reconnect');
    expect(within(panel).getByTestId('credential-connect-openai').textContent).toBe('Connect');
    // A measured-unavailable provider offers no action that would fail.
    expect(within(panel).queryByTestId('credential-connect-hermes')).toBeNull();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(queryByTestId('credentials-corner-panel')).toBeNull();
    expect(document.activeElement).toBe(getByTestId('credentials-corner-trigger'));
  });

  it('does NOT start a login when the control is clicked', async () => {
    const startLogin = vi.fn(portWith().startLogin);
    const { findByLabelText, findByTestId, getByTestId } = render(
      <CredentialsCorner port={portWith({ startLogin })} />,
    );
    await findByLabelText('Agent sign-ins — 1 unavailable');

    fireEvent.click(getByTestId('credentials-corner-trigger'));
    const panel = await findByTestId('credentials-corner-panel');
    await within(panel).findByTestId('credential-card-cursor');

    // The regression this pins: ProviderRail.tsx:199 called startLogin from the
    // chip itself, so a click committed you to a terminal instead of showing
    // you anything.
    expect(startLogin).not.toHaveBeenCalled();
    expect(within(panel).queryByTestId('credential-login-terminal')).toBeNull();

    // Login still reachable — from the explicit action inside.
    fireEvent.click(within(panel).getByTestId('credential-connect-openai'));
    await waitFor(() => expect(startLogin).toHaveBeenCalledWith('openai'));
    expect(await within(panel).findByTestId('credential-login-terminal')).toBeTruthy();
  });

  it('closes on a click outside and ignores clicks inside', async () => {
    const { findByLabelText, findByTestId, getByTestId, queryByTestId } = render(
      <div>
        <CredentialsCorner port={portWith()} />
        <button type="button" data-testid="elsewhere">elsewhere</button>
      </div>,
    );
    await findByLabelText('Agent sign-ins — 1 unavailable');

    fireEvent.click(getByTestId('credentials-corner-trigger'));
    const panel = await findByTestId('credentials-corner-panel');

    fireEvent.mouseDown(panel);
    expect(getByTestId('credentials-corner-panel')).toBeTruthy();

    fireEvent.mouseDown(getByTestId('elsewhere'));
    expect(queryByTestId('credentials-corner-panel')).toBeNull();
  });

  it('states a refusal on the control and explains it in the panel', async () => {
    const load = async () => { throw new Error('node refused'); };
    const { findByLabelText, findByTestId, getByTestId } = render(
      <CredentialsCorner port={portWith({ load })} />,
    );

    await findByLabelText('Agent sign-ins — status unread');
    fireEvent.click(getByTestId('credentials-corner-trigger'));
    const panel = await findByTestId('credentials-corner-panel');
    expect(await within(panel).findByTestId('credentials-load-error')).toBeTruthy();
  });
});
